import neo4j, { type QueryResult } from "neo4j-driver";
import {
  edgeKey,
  isAuthoritative,
  maxConfidence,
  mergeProvenance,
  type Edge,
  type Node,
  type Provenance,
  type UnresolvedRelationship,
} from "../models/graph.js";
import { isSemanticEdgeAllowed } from "../ontology/rules.js";
import { NodeTypeSchema, RelationshipTypeSchema, type NodeType, type RelationshipType, type ReviewState } from "../ontology/types.js";
import { mergeEdges, mergeNodes } from "../resolution/merge.js";
import { STOPWORDS } from "../utils/stopwords.js";
import { chunkArray, groupBy, unique } from "../utils/text.js";
import { edgeFromRecord, edgeToRow, nodeFromRecord, nodeToRow } from "./mappers.js";
import { FULLTEXT_INDEX, type Neo4jClient } from "./neo4j-client.js";

export type GraphClient = Pick<Neo4jClient, "run">;

export interface NodeKeyMatch {
  node: Node;
  matchedOn: "id" | "name" | "alias";
  key: string;
}

export interface ScoredNode {
  node: Node;
  score: number;
}

export interface Neighborhood {
  nodes: Node[];
  edges: Edge[];
}

export interface NeighborhoodOptions {
  depth?: number;
  maxNodes?: number;
  maxEdges?: number;
  relationshipTypes?: RelationshipType[];
}

export interface ProvenancePruneResult {
  nodesUpdated: number;
  nodesDeleted: number;
  edgesUpdated: number;
  edgesDeleted: number;
}

export interface ReviewableEdge {
  edge: Edge;
  source: Node;
  target: Node;
}

export interface EdgeReviewDecision {
  action: "approve" | "reject" | "correct";
  reviewer: string;
  reason?: string;
  relationshipType?: RelationshipType;
  reverse?: boolean;
}

export interface EdgeReviewResult {
  original: Edge;
  corrected?: Edge;
}

const MAX_DEPTH = 10;
const WRITE_BATCH_SIZE = 500;
const ACTIVE_RELATIONSHIP = "coalesce(r.reviewState, 'pending') <> 'rejected'";

/** LIMIT/SKIP need integer parameters; JS numbers are sent as floats. */
const int = (value: number) => neo4j.int(Math.max(0, Math.floor(value)));

/** Variable-length bounds cannot be parameters in Cypher, so they are validated and inlined. */
const depthLiteral = (depth: number): number => (Number.isFinite(depth) ? Math.min(MAX_DEPTH, Math.max(1, Math.floor(depth))) : 1);

/** Labels and relationship types cannot be parameters either; only ontology values are ever inlined. */
const safeLabel = (type: NodeType): string => NodeTypeSchema.parse(type);
const safeRelationshipType = (type: RelationshipType): string => RelationshipTypeSchema.parse(type);

const toNumber = (value: unknown): number =>
  typeof value === "number" ? value : typeof (value as { toNumber?: () => number })?.toNumber === "function" ? (value as { toNumber: () => number }).toNumber() : 0;

const LUCENE_SPECIAL = /[+\-&|!(){}[\]^"~*?:\\/]/g;

/** Builds an OR query for the full-text index from free text, escaping Lucene syntax. */
export function toFullTextQuery(text: string): string {
  const terms = unique(
    text
      .toLowerCase()
      .split(/[^a-z0-9_.]+/)
      .map((term) => term.replace(/^\.+|\.+$/g, ""))
      .filter((term) => term.length > 1 && !STOPWORDS.has(term))
  );
  return terms.map((term) => term.replace(LUCENE_SPECIAL, "\\$&")).join(" OR ");
}

/** Keeps stored provenance and aliases when a node is written again by a later run. */
function mergeWithStored(stored: Node | undefined, incoming: Node): Node {
  if (!stored) return incoming;
  if (isAuthoritative(incoming.provenance)) {
    // Source metadata is the truth for structural nodes: replace fields, keep accumulated provenance.
    return { ...incoming, provenance: mergeProvenance(stored.provenance, incoming.provenance), createdAt: stored.createdAt };
  }
  return { ...mergeNodes(incoming, stored), createdAt: stored.createdAt };
}

export class GraphRepository {
  constructor(private readonly client: GraphClient) {}

  // ---------------------------------------------------------------- writes

  async upsertNodes(nodes: readonly Node[]): Promise<number> {
    if (nodes.length === 0) return 0;
    const stored = new Map((await this.getNodesByIds(nodes.map((node) => node.id))).map((node) => [node.id, node]));

    let written = 0;
    for (const [nodeType, group] of groupBy(nodes, (node) => node.nodeType)) {
      const label = safeLabel(nodeType);
      for (const batch of chunkArray(group, WRITE_BATCH_SIZE)) {
        const rows = batch.map((node) => nodeToRow(mergeWithStored(stored.get(node.id), node)));
        await this.client.run(
          `UNWIND $rows AS row
           MERGE (n:Node {id: row.id})
           ON CREATE SET n.createdAt = row.createdAt
           SET n.nodeType = row.nodeType,
               n.canonicalName = row.canonicalName,
               n.title = row.title,
               n.aliases = row.aliases,
               n.aliasText = row.aliasText,
               n.description = row.description,
               n.propertiesJson = row.propertiesJson,
               n.provenanceJson = row.provenanceJson,
               n.authoritative = row.authoritative,
               n.confidence = row.confidence,
               n.updatedAt = row.updatedAt
           SET n:${label}`,
          { rows }
        );
        written += rows.length;
      }
    }
    return written;
  }

  /** Writes typed relationships. Edges whose endpoints do not exist are skipped, never stubbed. */
  async upsertEdges(edges: readonly Edge[]): Promise<{ written: number; skipped: number }> {
    let written = 0;
    for (const [relationshipType, group] of groupBy(edges, (edge) => edge.relationshipType)) {
      const type = safeRelationshipType(relationshipType);
      for (const batch of chunkArray(group, WRITE_BATCH_SIZE)) {
        const stored = await this.getStoredEdges(type, batch);
        const now = new Date().toISOString();
        const rows = batch.map((edge) => {
          const existing = stored.get(edgeKey(edge));
          return edgeToRow(existing ? mergeEdges(edge, existing) : edge, now);
        });
        const result = await this.client.run(
          `UNWIND $rows AS row
           MATCH (s:Node {id: row.sourceId})
           MATCH (t:Node {id: row.targetId})
           MERGE (s)-[r:${type}]->(t)
           ON CREATE SET r.createdAt = row.updatedAt
           SET r.id = row.id,
               r.relationshipType = row.relationshipType,
               r.propertiesJson = row.propertiesJson,
               r.provenanceJson = row.provenanceJson,
               r.confidence = row.confidence,
               r.inferred = row.inferred,
               r.reviewState = row.reviewState,
               r.evidence = row.evidence,
               r.updatedAt = row.updatedAt
           RETURN count(r) AS written`,
          { rows }
        );
        written += toNumber(result.records[0]?.get("written"));
      }
    }
    return { written, skipped: edges.length - written };
  }

  /** Replaces deferred relationship proposals for documents that were successfully re-extracted. */
  async replaceUnresolvedRelationships(documentIds: readonly string[], relationships: readonly UnresolvedRelationship[]): Promise<void> {
    if (documentIds.length === 0) return;
    await this.client.run("MATCH (p:UnresolvedRelationship) WHERE p.sourceDocumentId IN $documentIds DELETE p", { documentIds: unique(documentIds) });
    if (relationships.length === 0) return;
    const rows = relationships.map((relationship) => ({
      ...relationship,
      provenanceJson: JSON.stringify(relationship.provenance),
    }));
    await this.client.run(
      `UNWIND $rows AS row
       MERGE (p:UnresolvedRelationship {id: row.id})
       SET p.sourceDocumentId = row.sourceDocumentId,
           p.sourceName = row.sourceName,
           p.sourceId = row.sourceId,
           p.proposedType = row.proposedType,
           p.targetName = row.targetName,
           p.targetId = row.targetId,
           p.evidence = row.evidence,
           p.confidence = row.confidence,
           p.inferred = row.inferred,
           p.provenanceJson = row.provenanceJson,
           p.reason = row.reason,
           p.updatedAt = $now`,
      { rows, now: new Date().toISOString() }
    );
  }

  async listUnresolvedRelationships(): Promise<UnresolvedRelationship[]> {
    const result = await this.client.run("MATCH (p:UnresolvedRelationship) RETURN properties(p) AS p ORDER BY p.id");
    return result.records.map((record) => {
      const value = record.get("p") as Record<string, unknown>;
      return {
        id: String(value.id),
        sourceDocumentId: String(value.sourceDocumentId),
        sourceName: String(value.sourceName),
        sourceId: value.sourceId ? String(value.sourceId) : undefined,
        proposedType: String(value.proposedType),
        targetName: String(value.targetName),
        targetId: value.targetId ? String(value.targetId) : undefined,
        evidence: String(value.evidence ?? ""),
        confidence: Number(value.confidence) || 0,
        inferred: value.inferred === true,
        provenance: JSON.parse(String(value.provenanceJson ?? "[]")) as Provenance[],
        reason: String(value.reason) as UnresolvedRelationship["reason"],
      };
    });
  }

  async deleteUnresolvedRelationships(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.client.run("MATCH (p:UnresolvedRelationship) WHERE p.id IN $ids DELETE p", { ids: unique(ids) });
  }

  /**
   * Removes provenance contributed by the given documents, before they are re-ingested.
   * Inferred nodes and all edges left without provenance are deleted; structural nodes are kept
   * (their provenance is re-added by the same run) so edges from other documents survive.
   */
  async pruneDocumentProvenance(documentIds: readonly string[]): Promise<ProvenancePruneResult> {
    const outcome: ProvenancePruneResult = { nodesUpdated: 0, nodesDeleted: 0, edgesUpdated: 0, edgesDeleted: 0 };
    if (documentIds.length === 0) return outcome;

    const pruned = new Set(documentIds);
    const needles = documentIds.map((id) => `"sourceDocumentId":${JSON.stringify(id)}`);
    const keep = (p: Provenance): boolean => !p.sourceDocumentId || !pruned.has(p.sourceDocumentId);

    const nodeResult = await this.client.run(
      "MATCH (n:Node) WHERE any(needle IN $needles WHERE n.provenanceJson CONTAINS needle) RETURN n",
      { needles }
    );
    const nodeUpdates: Array<Record<string, unknown>> = [];
    const nodeDeletes: string[] = [];
    for (const record of nodeResult.records) {
      const node = nodeFromRecord(record.get("n"));
      const remaining = node.provenance.filter(keep);
      if (remaining.length === node.provenance.length) continue;
      if (remaining.length === 0 && !isAuthoritative(node.provenance)) {
        nodeDeletes.push(node.id);
      } else {
        nodeUpdates.push({
          id: node.id,
          provenanceJson: JSON.stringify(remaining),
          authoritative: isAuthoritative(remaining),
          confidence: maxConfidence(remaining),
        });
      }
    }
    for (const rows of chunkArray(nodeUpdates, WRITE_BATCH_SIZE)) {
      await this.client.run(
        `UNWIND $rows AS row
         MATCH (n:Node {id: row.id})
         SET n.provenanceJson = row.provenanceJson, n.authoritative = row.authoritative, n.confidence = row.confidence`,
        { rows }
      );
    }
    if (nodeDeletes.length > 0) {
      await this.client.run("MATCH (n:Node) WHERE n.id IN $ids DETACH DELETE n", { ids: nodeDeletes });
    }

    const edgeResult = await this.client.run(
      `MATCH (s:Node)-[r]->(t:Node)
       WHERE any(needle IN $needles WHERE r.provenanceJson CONTAINS needle)
       RETURN elementId(r) AS elementId, s.id AS sourceId, t.id AS targetId, type(r) AS type, r`,
      { needles }
    );
    const edgeUpdates: Array<Record<string, unknown>> = [];
    const edgeDeletes: string[] = [];
    for (const record of edgeResult.records) {
      if (!RelationshipTypeSchema.safeParse(record.get("type")).success) continue;
      const edge = edgeFromRecord(record.get("r"), record.get("sourceId"), record.get("targetId"), record.get("type"));
      const remaining = edge.provenance.filter(keep);
      if (remaining.length === edge.provenance.length) continue;
      if (remaining.length === 0) {
        edgeDeletes.push(record.get("elementId"));
      } else {
        edgeUpdates.push({
          elementId: record.get("elementId"),
          provenanceJson: JSON.stringify(remaining),
          confidence: maxConfidence(remaining, edge.confidence),
          evidence: unique(remaining.map((p) => p.evidenceText).filter((text): text is string => Boolean(text))),
        });
      }
    }
    for (const rows of chunkArray(edgeUpdates, WRITE_BATCH_SIZE)) {
      await this.client.run(
        `UNWIND $rows AS row
         MATCH ()-[r]->() WHERE elementId(r) = row.elementId
         SET r.provenanceJson = row.provenanceJson, r.confidence = row.confidence, r.evidence = row.evidence`,
        { rows }
      );
    }
    for (const ids of chunkArray(edgeDeletes, WRITE_BATCH_SIZE)) {
      await this.client.run("UNWIND $ids AS id MATCH ()-[r]->() WHERE elementId(r) = id DELETE r", { ids });
    }

    outcome.nodesUpdated = nodeUpdates.length;
    outcome.nodesDeleted = nodeDeletes.length;
    outcome.edgesUpdated = edgeUpdates.length;
    outcome.edgesDeleted = edgeDeletes.length;
    return outcome;
  }

  /** Deletes every knowledge-graph node and relationship. */
  async deleteAll(): Promise<number> {
    const count = await this.countNodes();
    await this.client.run("MATCH (n) CALL { WITH n DETACH DELETE n } IN TRANSACTIONS OF 1000 ROWS");
    return count;
  }

  // ---------------------------------------------------------------- human review

  async listReviewableEdges(states: readonly ReviewState[] = ["needs_review"], limit = 100): Promise<ReviewableEdge[]> {
    const result = await this.client.run(
      `MATCH (source:Node)-[r]->(target:Node)
       WHERE coalesce(r.reviewState, 'pending') IN $states
       RETURN source, target, type(r) AS type, r
       ORDER BY coalesce(r.updatedAt, r.createdAt) DESC, r.id
       LIMIT $limit`,
      { states: [...states], limit: int(limit) }
    );
    return result.records.flatMap((record) => {
      if (!RelationshipTypeSchema.safeParse(record.get("type")).success) return [];
      const source = nodeFromRecord(record.get("source"));
      const target = nodeFromRecord(record.get("target"));
      return [{ source, target, edge: edgeFromRecord(record.get("r"), source.id, target.id, record.get("type")) }];
    });
  }

  async getReviewableEdge(edgeId: string): Promise<ReviewableEdge | null> {
    const result = await this.client.run(
      `MATCH (source:Node)-[r]->(target:Node)
       WHERE r.id = $edgeId
       RETURN source, target, type(r) AS type, r
       LIMIT 1`,
      { edgeId }
    );
    const record = result.records[0];
    if (!record || !RelationshipTypeSchema.safeParse(record.get("type")).success) return null;
    const source = nodeFromRecord(record.get("source"));
    const target = nodeFromRecord(record.get("target"));
    return { source, target, edge: edgeFromRecord(record.get("r"), source.id, target.id, record.get("type")) };
  }

  async reviewEdge(edgeId: string, decision: EdgeReviewDecision): Promise<EdgeReviewResult> {
    const item = await this.getReviewableEdge(edgeId);
    if (!item) throw new Error(`Relationship not found: ${edgeId}`);
    if (isAuthoritative(item.edge.provenance)) throw new Error(`Authoritative relationship cannot be reviewed: ${edgeId}`);

    const reviewer = decision.reviewer.trim();
    const reason = decision.reason?.trim();
    if (!reviewer) throw new Error("Reviewer is required");
    if (decision.action !== "approve" && !reason) throw new Error(`A reason is required to ${decision.action} a relationship`);

    const now = new Date().toISOString();
    const history = Array.isArray(item.edge.properties.reviewHistory) ? [...item.edge.properties.reviewHistory] : [];
    const record: Record<string, unknown> = { action: decision.action, reviewer, reviewedAt: now, ...(reason ? { reason } : {}) };

    if (decision.action !== "correct") {
      history.push(record);
      const reviewState: ReviewState = decision.action === "approve" ? "approved" : "rejected";
      const edge: Edge = {
        ...item.edge,
        reviewState,
        properties: { ...item.edge.properties, reviewHistory: history },
        provenance: item.edge.provenance.map((entry) => ({ ...entry, reviewState })),
      };
      await this.client.run(
        `MATCH ()-[r]->() WHERE r.id = $edgeId
         SET r.reviewState = $reviewState,
             r.propertiesJson = $propertiesJson,
             r.provenanceJson = $provenanceJson,
             r.updatedAt = $now`,
        { edgeId, reviewState, propertiesJson: JSON.stringify(edge.properties), provenanceJson: JSON.stringify(edge.provenance), now }
      );
      return { original: edge };
    }

    const relationshipType = RelationshipTypeSchema.parse(decision.relationshipType);
    const source = decision.reverse ? item.target : item.source;
    const target = decision.reverse ? item.source : item.target;
    if (!isSemanticEdgeAllowed(relationshipType, source.nodeType, target.nodeType)) {
      throw new Error(`${source.nodeType} -[${relationshipType}]-> ${target.nodeType} is not allowed by the ontology`);
    }

    const correctedId = edgeKey({ sourceId: source.id, relationshipType, targetId: target.id });
    if (correctedId === item.edge.id) throw new Error("The correction does not change the relationship; use approve instead");
    history.push({ ...record, relationshipType, reverse: decision.reverse === true, correctedEdgeId: correctedId });
    const original: Edge = {
      ...item.edge,
      reviewState: "rejected",
      properties: { ...item.edge.properties, supersededBy: correctedId, reviewHistory: history },
      provenance: item.edge.provenance.map((entry) => ({ ...entry, reviewState: "rejected" as const })),
    };
    const correctedProperties: Record<string, unknown> = { ...item.edge.properties, reviewedFrom: item.edge.id, reviewHistory: history };
    delete correctedProperties.fallbackReason;
    delete correctedProperties.suggestedType;
    delete correctedProperties.supersededBy;
    let corrected: Edge = {
      ...item.edge,
      id: correctedId,
      sourceId: source.id,
      targetId: target.id,
      relationshipType,
      reviewState: "approved",
      properties: correctedProperties,
      provenance: item.edge.provenance.map((entry) => ({ ...entry, reviewState: "approved" as const })),
    };
    const existing = (await this.getStoredEdges(relationshipType, [corrected])).get(correctedId);
    if (existing) corrected = mergeEdges(corrected, existing);
    const row = edgeToRow(corrected, now);
    await this.client.run(
      `MATCH ()-[old]->() WHERE old.id = $edgeId
       MATCH (source:Node {id: $sourceId})
       MATCH (target:Node {id: $targetId})
       SET old.reviewState = 'rejected',
           old.propertiesJson = $oldPropertiesJson,
           old.provenanceJson = $oldProvenanceJson,
           old.updatedAt = $now
       MERGE (source)-[r:${relationshipType}]->(target)
       ON CREATE SET r.createdAt = $now
       SET r.id = $correctedId,
           r.relationshipType = $relationshipType,
           r.propertiesJson = $propertiesJson,
           r.provenanceJson = $provenanceJson,
           r.confidence = $confidence,
           r.inferred = $inferred,
           r.reviewState = 'approved',
           r.evidence = $evidence,
           r.updatedAt = $now`,
      {
        edgeId,
        sourceId: corrected.sourceId,
        targetId: corrected.targetId,
        correctedId,
        relationshipType,
        oldPropertiesJson: JSON.stringify(original.properties),
        oldProvenanceJson: JSON.stringify(original.provenance),
        propertiesJson: row.propertiesJson,
        provenanceJson: row.provenanceJson,
        confidence: row.confidence,
        inferred: row.inferred,
        evidence: row.evidence,
        now,
      }
    );
    return { original, corrected };
  }

  // ---------------------------------------------------------------- lookups

  async getNode(id: string): Promise<Node | null> {
    const result = await this.client.run("MATCH (n:Node {id: $id}) RETURN n", { id });
    return result.records.length > 0 ? nodeFromRecord(result.records[0].get("n")) : null;
  }

  async getNodesByIds(ids: readonly string[]): Promise<Node[]> {
    if (ids.length === 0) return [];
    const result = await this.client.run("MATCH (n:Node) WHERE n.id IN $ids RETURN n", { ids: unique(ids) });
    return this.nodes(result, "n");
  }

  async hasApprovedRelationship(sourceId: string, relationshipType: RelationshipType, targetId: string): Promise<boolean> {
    const result = await this.client.run(
      `MATCH (s:Node {id: $sourceId})-[r]->(t:Node {id: $targetId})
       WHERE type(r) = $relationshipType AND r.reviewState = 'approved'
       RETURN count(r) > 0 AS found`,
      { sourceId, relationshipType: safeRelationshipType(relationshipType), targetId },
    );
    return result.records[0]?.get("found") === true;
  }

  /** Case-insensitive match of keys against node ids, canonical names and aliases. */
  async findNodesByKeys(keys: readonly string[], limit = 25): Promise<NodeKeyMatch[]> {
    const cleaned = unique(keys.map((key) => key.trim()).filter(Boolean));
    if (cleaned.length === 0) return [];
    const upper = cleaned.map((key) => key.toUpperCase());
    const originalByUpper = new Map(cleaned.map((key) => [key.toUpperCase(), key]));

    const result = await this.client.run(
      `MATCH (n:Node)
       WHERE n.id IN $keys
          OR toUpper(n.id) IN $upper
          OR toUpper(n.canonicalName) IN $upper
          OR any(alias IN coalesce(n.aliases, []) WHERE toUpper(alias) IN $upper)
       RETURN n
       LIMIT $limit`,
      { keys: cleaned, upper, limit: int(limit) }
    );

    return this.nodes(result, "n").map((node) => {
      const id = node.id.toUpperCase();
      const name = node.canonicalName.toUpperCase();
      if (originalByUpper.has(id)) return { node, matchedOn: "id" as const, key: originalByUpper.get(id)! };
      if (originalByUpper.has(name)) return { node, matchedOn: "name" as const, key: originalByUpper.get(name)! };
      const alias = node.aliases.find((a) => originalByUpper.has(a.toUpperCase())) ?? "";
      return { node, matchedOn: "alias" as const, key: originalByUpper.get(alias.toUpperCase()) ?? alias };
    });
  }

  async searchFullText(text: string, options: { nodeTypes?: readonly NodeType[]; limit?: number } = {}): Promise<ScoredNode[]> {
    const query = toFullTextQuery(text);
    if (!query) return [];
    const result = await this.client.run(
      `CALL db.index.fulltext.queryNodes('${FULLTEXT_INDEX}', $query) YIELD node, score
       WHERE $nodeTypes IS NULL OR node.nodeType IN $nodeTypes
       RETURN node, score
       ORDER BY score DESC
       LIMIT $limit`,
      { query, nodeTypes: options.nodeTypes?.length ? [...options.nodeTypes] : null, limit: int(options.limit ?? 10) }
    );
    return result.records.map((record) => ({ node: nodeFromRecord(record.get("node")), score: toNumber(record.get("score")) }));
  }

  async getNodesByType(nodeType: NodeType, limit = 50): Promise<Node[]> {
    const result = await this.client.run("MATCH (n:Node {nodeType: $nodeType}) RETURN n ORDER BY n.id LIMIT $limit", {
      nodeType: safeLabel(nodeType),
      limit: int(limit),
    });
    return this.nodes(result, "n");
  }

  async managedTestCases(): Promise<Array<{ node: Node; storyIds: string[]; dependsOnCaseIds: string[] }>> {
    const result = await this.client.run(
      `MATCH (c:Node {nodeType: 'TestCase'})
       OPTIONAL MATCH (c)-[r:TRACES_TO]->(s:Node {nodeType: 'Story'})
       WHERE r.reviewState = 'approved'
       WITH c, collect(DISTINCT s.id) AS storyIds
       OPTIONAL MATCH (c)-[d:DEPENDS_ON]->(other:Node {nodeType: 'TestCase'})
       WHERE d.reviewState = 'approved'
       RETURN c, storyIds, collect(DISTINCT other.id) AS dependsOnCaseIds ORDER BY c.id`,
    );
    return result.records.map((record) => ({ node: nodeFromRecord(record.get("c")),
      storyIds: (record.get("storyIds") as Array<string | null>).filter((id): id is string => typeof id === "string"),
      dependsOnCaseIds: (record.get("dependsOnCaseIds") as Array<string | null>).filter((id): id is string => typeof id === "string") }));
  }

  // ---------------------------------------------------------------- hierarchy

  async getParent(id: string): Promise<Node | null> {
    const result = await this.client.run(`MATCH (parent:Node)-[r:PARENT_OF]->(:Node {id: $id}) WHERE ${ACTIVE_RELATIONSHIP} RETURN parent LIMIT 1`, { id });
    return result.records.length > 0 ? nodeFromRecord(result.records[0].get("parent")) : null;
  }

  async getChildren(id: string): Promise<Node[]> {
    const result = await this.client.run(`MATCH (:Node {id: $id})-[r:PARENT_OF]->(child:Node) WHERE ${ACTIVE_RELATIONSHIP} RETURN child ORDER BY child.id`, { id });
    return this.nodes(result, "child");
  }

  async getAncestors(id: string, maxDepth = MAX_DEPTH): Promise<Node[]> {
    const result = await this.client.run(
      `MATCH path = (ancestor:Node)-[:PARENT_OF*1..${depthLiteral(maxDepth)}]->(:Node {id: $id})
       WHERE all(r IN relationships(path) WHERE ${ACTIVE_RELATIONSHIP})
       RETURN DISTINCT ancestor`,
      { id }
    );
    return this.nodes(result, "ancestor");
  }

  async getDescendants(id: string, maxDepth = MAX_DEPTH): Promise<Node[]> {
    const result = await this.client.run(
      `MATCH path = (:Node {id: $id})-[:PARENT_OF*1..${depthLiteral(maxDepth)}]->(descendant:Node)
       WHERE all(r IN relationships(path) WHERE ${ACTIVE_RELATIONSHIP})
       RETURN DISTINCT descendant`,
      { id }
    );
    return this.nodes(result, "descendant");
  }

  async getFeatureScope(featureId: string): Promise<Node[]> {
    return this.getChildren(featureId);
  }

  async getSprintScope(sprintId: string): Promise<Node[]> {
    const result = await this.client.run(
      `MATCH (sprint:Node {id: $sprintId})
       MATCH (n:Node)-[r]-(sprint)
       WHERE ${ACTIVE_RELATIONSHIP}
         AND ((type(r) = 'PLANNED_FOR' AND endNode(r) = sprint) OR (type(r) = 'CONTAINS' AND startNode(r) = sprint))
       RETURN DISTINCT n`,
      { sprintId }
    );
    return this.nodes(result, "n");
  }

  // ---------------------------------------------------------------- relationships

  async getRelated(id: string, relationshipTypes: readonly RelationshipType[] = []): Promise<Node[]> {
    const result = await this.client.run(
      `MATCH (:Node {id: $id})-[r]-(related:Node)
       WHERE ${ACTIVE_RELATIONSHIP} AND (size($types) = 0 OR type(r) IN $types)
       RETURN DISTINCT related`,
      { id, types: relationshipTypes.map(safeRelationshipType) }
    );
    return this.nodes(result, "related");
  }

  /** Nodes this node depends on (DEPENDS_ON, or BLOCKED_BY from this node). */
  async getDependencies(id: string): Promise<Node[]> {
    const result = await this.client.run(`MATCH (:Node {id: $id})-[r:DEPENDS_ON|BLOCKED_BY]->(dep:Node) WHERE ${ACTIVE_RELATIONSHIP} RETURN DISTINCT dep`, { id });
    return this.nodes(result, "dep");
  }

  /** Nodes that depend on this node. */
  async getDependents(id: string): Promise<Node[]> {
    const result = await this.client.run(`MATCH (dep:Node)-[r:DEPENDS_ON|BLOCKED_BY]->(:Node {id: $id}) WHERE ${ACTIVE_RELATIONSHIP} RETURN DISTINCT dep`, { id });
    return this.nodes(result, "dep");
  }

  async getTestCoverage(nodeId: string): Promise<{ testCases: Node[]; testRuns: Node[]; defects: Node[] }> {
    const result = await this.client.run(
      `MATCH (n:Node {id: $nodeId})
       OPTIONAL MATCH (n)-[verified:VERIFIED_BY]->(tc:Node) WHERE ${ACTIVE_RELATIONSHIP.replaceAll("r.", "verified.")}
       OPTIONAL MATCH (tc)-[executed:EXECUTED_IN]->(tr:Node) WHERE ${ACTIVE_RELATIONSHIP.replaceAll("r.", "executed.")}
       OPTIONAL MATCH (tr)-[found:FOUND]->(d:Node) WHERE ${ACTIVE_RELATIONSHIP.replaceAll("r.", "found.")}
       RETURN collect(DISTINCT tc) AS testCases, collect(DISTINCT tr) AS testRuns, collect(DISTINCT d) AS defects`,
      { nodeId }
    );
    const record = result.records[0];
    const list = (key: string): Node[] => (record ? (record.get(key) as unknown[]).map(nodeFromRecord) : []);
    return { testCases: list("testCases"), testRuns: list("testRuns"), defects: list("defects") };
  }

  async getTestsForStory(storyId: string): Promise<Node[]> {
    const result = await this.client.run(`MATCH (:Node {id: $storyId})-[r:VERIFIED_BY]->(tc:Node) WHERE ${ACTIVE_RELATIONSHIP} RETURN tc`, { storyId });
    return this.nodes(result, "tc");
  }

  async getTestRuns(testCaseId: string): Promise<Node[]> {
    const result = await this.client.run(`MATCH (:Node {id: $testCaseId})-[r:EXECUTED_IN]->(tr:Node) WHERE ${ACTIVE_RELATIONSHIP} RETURN tr`, { testCaseId });
    return this.nodes(result, "tr");
  }

  async getDefects(testRunId: string): Promise<Node[]> {
    const result = await this.client.run(`MATCH (:Node {id: $testRunId})-[r:FOUND]->(d:Node) WHERE ${ACTIVE_RELATIONSHIP} RETURN d`, { testRunId });
    return this.nodes(result, "d");
  }

  async getDefectsForStory(storyId: string): Promise<Node[]> {
    const result = await this.client.run(
      `MATCH (:Node {id: $storyId})-[verified:VERIFIED_BY]->(:Node)-[executed:EXECUTED_IN]->(:Node)-[found:FOUND]->(d:Node)
       WHERE ${ACTIVE_RELATIONSHIP.replaceAll("r.", "verified.")}
         AND ${ACTIVE_RELATIONSHIP.replaceAll("r.", "executed.")}
         AND ${ACTIVE_RELATIONSHIP.replaceAll("r.", "found.")}
       RETURN DISTINCT d`,
      { storyId }
    );
    return this.nodes(result, "d");
  }

  /**
   * Breadth-first expansion around seed nodes, one query per level, respecting node and edge caps.
   * Edge direction is preserved.
   */
  async getNeighborhood(seedIds: readonly string[], options: NeighborhoodOptions = {}): Promise<Neighborhood> {
    const depth = Math.max(0, Math.min(MAX_DEPTH, Math.floor(options.depth ?? 1)));
    const maxNodes = Math.max(1, options.maxNodes ?? 50);
    const maxEdges = Math.max(0, options.maxEdges ?? 100);
    const types = (options.relationshipTypes ?? []).map(safeRelationshipType);

    const seeds = await this.getNodesByIds(seedIds);
    const nodes = new Map(seeds.slice(0, maxNodes).map((node) => [node.id, node]));
    const edges = new Map<string, Edge>();
    let frontier = [...nodes.keys()];

    for (let level = 0; level < depth && frontier.length > 0 && maxEdges > 0; level++) {
      const result = await this.client.run(
        `MATCH (n:Node)-[r]-(m:Node)
         WHERE n.id IN $frontier AND ${ACTIVE_RELATIONSHIP} AND (size($types) = 0 OR type(r) IN $types)
         RETURN startNode(r).id AS sourceId, endNode(r).id AS targetId, type(r) AS type, r, m
         ORDER BY coalesce(r.confidence, 1.0) DESC
         LIMIT $limit`,
        { frontier, types, limit: int(maxEdges * 2) }
      );

      const next: string[] = [];
      for (const record of result.records) {
        if (!RelationshipTypeSchema.safeParse(record.get("type")).success) continue;
        const neighbor = nodeFromRecord(record.get("m"));
        if (!nodes.has(neighbor.id)) {
          if (nodes.size >= maxNodes) continue;
          nodes.set(neighbor.id, neighbor);
          next.push(neighbor.id);
        }
        if (edges.size < maxEdges) {
          const edge = edgeFromRecord(record.get("r"), record.get("sourceId"), record.get("targetId"), record.get("type"));
          edges.set(edgeKey(edge), edge);
        }
      }
      frontier = next;
    }

    return {
      nodes: [...nodes.values()],
      edges: [...edges.values()].filter((edge) => nodes.has(edge.sourceId) && nodes.has(edge.targetId)),
    };
  }

  /**
   * One hop from the given nodes along the given relationship types (all types when empty), in one
   * direction, strongest relationships first. `fromId` is the given node each row starts from.
   */
  async expandHop(
    nodeIds: readonly string[],
    options: { relationshipTypes?: readonly RelationshipType[]; direction?: "outgoing" | "incoming" | "both"; limit?: number } = {}
  ): Promise<Array<{ fromId: string; edge: Edge; neighbor: Node }>> {
    const ids = unique(nodeIds.filter(Boolean));
    if (ids.length === 0) return [];
    const types = (options.relationshipTypes ?? []).map(safeRelationshipType);
    const pattern =
      options.direction === "outgoing" ? "(n:Node)-[r]->(m:Node)" : options.direction === "incoming" ? "(n:Node)<-[r]-(m:Node)" : "(n:Node)-[r]-(m:Node)";

    const result = await this.client.run(
      `MATCH ${pattern}
       WHERE n.id IN $ids AND ${ACTIVE_RELATIONSHIP} AND (size($types) = 0 OR type(r) IN $types)
       RETURN n.id AS fromId, startNode(r).id AS sourceId, endNode(r).id AS targetId, type(r) AS type, r, m
       ORDER BY coalesce(r.confidence, 1.0) DESC
       LIMIT $limit`,
      { ids, types, limit: int(options.limit ?? 100) }
    );

    const hops: Array<{ fromId: string; edge: Edge; neighbor: Node }> = [];
    for (const record of result.records) {
      if (!RelationshipTypeSchema.safeParse(record.get("type")).success) continue;
      hops.push({
        fromId: record.get("fromId") as string,
        edge: edgeFromRecord(record.get("r"), record.get("sourceId"), record.get("targetId"), record.get("type")),
        neighbor: nodeFromRecord(record.get("m")),
      });
    }
    return hops;
  }

  /** The given nodes and the relationships among them. */
  async findSubgraph(nodeIds: readonly string[]): Promise<Neighborhood> {
    const nodes = await this.getNodesByIds(nodeIds);
    if (nodes.length === 0) return { nodes, edges: [] };
    const result = await this.client.run(
      `MATCH (a:Node)-[r]->(b:Node)
       WHERE a.id IN $ids AND b.id IN $ids AND ${ACTIVE_RELATIONSHIP}
       RETURN a.id AS sourceId, b.id AS targetId, type(r) AS type, r`,
      { ids: nodes.map((node) => node.id) }
    );
    const edges = result.records
      .filter((record) => RelationshipTypeSchema.safeParse(record.get("type")).success)
      .map((record) => edgeFromRecord(record.get("r"), record.get("sourceId"), record.get("targetId"), record.get("type")));
    return { nodes, edges };
  }

  async countNodes(): Promise<number> {
    const result = await this.client.run("MATCH (n:Node) RETURN count(n) AS count");
    return toNumber(result.records[0]?.get("count"));
  }

  async countEdges(): Promise<number> {
    const result = await this.client.run("MATCH (:Node)-[r]->(:Node) RETURN count(r) AS count");
    return toNumber(result.records[0]?.get("count"));
  }

  private async getStoredEdges(type: string, batch: readonly Edge[]): Promise<Map<string, Edge>> {
    const result = await this.client.run(
      `UNWIND $rows AS row
       MATCH (s:Node {id: row.sourceId})-[r:${type}]->(t:Node {id: row.targetId})
       RETURN s.id AS sourceId, t.id AS targetId, r`,
      { rows: batch.map((edge) => ({ sourceId: edge.sourceId, targetId: edge.targetId })) }
    );
    const stored = new Map<string, Edge>();
    for (const record of result.records) {
      const edge = edgeFromRecord(record.get("r"), record.get("sourceId"), record.get("targetId"), type);
      stored.set(edgeKey(edge), edge);
    }
    return stored;
  }

  private nodes(result: QueryResult, key: string): Node[] {
    return result.records.map((record) => nodeFromRecord(record.get(key)));
  }
}
