import { GraphRepository } from "../graph/graph-repository.js";
import { Neo4jClient } from "../graph/neo4j-client.js";
import { EdgeSchema, NodeSchema, ProvenanceSchema, edgeKey, type Edge, type Provenance } from "../models/graph.js";
import { isSemanticEdgeAllowed, resolveSemanticRelationship } from "../ontology/rules.js";
import { EXTRACTABLE_NODE_TYPES, NodeTypeSchema, RelationshipTypeSchema, type NodeType, type RelationshipType } from "../ontology/types.js";
import { normalizeName } from "../ontology/identifiers.js";
import { hash, type Artifact, type NodeKind, type Relation, type Spec, type Story, type StoryPipelineRecord, type WorkItemParent } from "../core/runtime.js";
import type { DesignGraphContext } from "../contracts.js";

function properties(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : { value };
}

function sourceProvenance(id: string, content: Record<string, unknown>): Provenance {
  const adoId = typeof content.adoId === "number" ? content.adoId : undefined;
  return ProvenanceSchema.parse({
    sourceSystem: "azure-devops",
    sourceDocument: typeof content.title === "string" ? content.title : id,
    sourceDocumentId: adoId ? `ado:${adoId}` : `ado:${id}`,
    extractionMethod: "deterministic",
    confidence: 1,
    inferred: false,
    reviewState: "approved",
  });
}

function agentProvenance(id: string, evidence?: string): Provenance {
  return ProvenanceSchema.parse({
    sourceSystem: "agentic-qa-platform",
    sourceDocument: id,
    sourceDocumentId: id,
    extractionMethod: "agent",
    evidenceText: evidence,
    confidence: 1,
    inferred: true,
    reviewState: "approved",
  });
}

function unreviewedNodeProvenance(id: string, content: Record<string, unknown>): Provenance {
  return ProvenanceSchema.parse({
    sourceSystem: "openrouter",
    sourceDocument: typeof content.sourceWorkItem === "string" ? content.sourceWorkItem : typeof content.sourceStory === "string" ? content.sourceStory : id,
    sourceDocumentId: typeof content.sourceWorkItem === "string" ? `ado:${content.sourceWorkItem}` : typeof content.sourceStory === "string" ? `ado:${content.sourceStory}` : id,
    extractionMethod: "llm",
    evidenceText: typeof content.text === "string" ? content.text : undefined,
    confidence: 0.5,
    inferred: false,
    reviewState: "needs_review",
  });
}

function executionProvenance(id: string): Provenance {
  return ProvenanceSchema.parse({
    sourceSystem: "playwright",
    sourceDocument: id,
    sourceDocumentId: id,
    extractionMethod: "deterministic",
    confidence: 1,
    inferred: false,
    reviewState: "approved",
  });
}

function llmProvenance(relation: Relation): Provenance {
  return ProvenanceSchema.parse({
    sourceSystem: "openrouter",
    sourceDocument: relation.source,
    sourceDocumentId: `ado:${relation.source}`,
    extractionMethod: "llm",
    evidenceText: relation.evidence,
    confidence: relation.confidence,
    inferred: false,
    reviewState: relation.state === "approved" ? "approved" : "needs_review",
  });
}

export class Graph {
  private readonly repository: GraphRepository;

  constructor(private readonly client = new Neo4jClient()) {
    this.repository = new GraphRepository(client);
  }

  async setup(): Promise<void> {
    await this.client.connect();
    await this.client.run("CREATE CONSTRAINT qa_story_pipeline_ado_id IF NOT EXISTS FOR (p:StoryPipeline) REQUIRE p.adoId IS UNIQUE");
  }

  async deleteAll(): Promise<number> {
    return await this.repository.deleteAll();
  }

  async node(id: string, kind: NodeKind, name: string, content: unknown): Promise<void> {
    const parsedType = NodeTypeSchema.safeParse(kind);
    if (!parsedType.success) throw new Error(`Unsupported knowledge-graph node type: ${kind}`);
    const data = properties(content);
    const structural = kind === "Epic" || kind === "Feature" || kind === "Story" || kind === "Task" || kind === "Sprint";
    const node = NodeSchema.parse({
      id,
      nodeType: parsedType.data,
      canonicalName: name,
      aliases: [],
      description: typeof data.text === "string" ? data.text : undefined,
      properties: data,
      provenance: [structural ? sourceProvenance(id, data) : unreviewedNodeProvenance(id, data)],
    });
    await this.repository.upsertNodes([node]);
  }

  async mentionedEntities(text: string): Promise<Array<{ id: string; type: NodeType; name: string }>> {
    const normalizedText = ` ${normalizeName(text)} `;
    const found = new Map<string, { id: string; type: NodeType; name: string }>();
    for (let offset = 0; offset < text.length; offset += 2000) {
      const matches = await this.repository.searchFullText(text.slice(offset, offset + 2000), { nodeTypes: EXTRACTABLE_NODE_TYPES, limit: 100 });
      for (const { node } of matches) {
        const mentionedName = [node.canonicalName, ...node.aliases].find((name) => {
          const normalized = normalizeName(name);
          return normalized.length >= 4 && normalizedText.includes(` ${normalized} `);
        });
        if (mentionedName) found.set(node.id, { id: node.id, type: node.nodeType, name: mentionedName });
      }
    }
    return [...found.values()];
  }

  async hasApprovedRelationship(sourceId: string, type: string, targetId: string): Promise<boolean> {
    const relationshipType = RelationshipTypeSchema.parse(type);
    return this.repository.hasApprovedRelationship(sourceId, relationshipType, targetId);
  }

  async hierarchy(parentId: string, childId: string, source?: { adoId: number; title: string }): Promise<void> {
    await this.writeEdge(parentId, "PARENT_OF", childId, {
      provenance: [sourceProvenance(childId, source ?? {})],
      reviewState: "approved",
      inferred: false,
      confidence: 1,
    });
  }

  async plannedFor(storyId: string, iterationPath: string, source?: { adoId: number; title: string }): Promise<void> {
    const sprintId = `Sprint:${iterationPath}`;
    const name = iterationPath.split("\\").at(-1) ?? iterationPath;
    await this.repository.upsertNodes([NodeSchema.parse({
      id: sprintId,
      nodeType: "Sprint",
      canonicalName: name,
      aliases: [iterationPath],
      properties: { iterationPath },
      provenance: [sourceProvenance(storyId, source ?? {})],
    })]);
    await this.writeEdge(storyId, "PLANNED_FOR", sprintId, {
      provenance: [sourceProvenance(storyId, source ?? {})],
      reviewState: "approved",
      inferred: false,
      confidence: 1,
    });
  }

  async propose(relation: Relation): Promise<void> {
    const sourceType = NodeTypeSchema.parse(relation.sourceType);
    const targetType = NodeTypeSchema.parse(relation.targetType);
    const resolved = resolveSemanticRelationship(relation.type, sourceType, targetType);
    const sourceId = resolved.reversed ? relation.targetId : relation.sourceId;
    const targetId = resolved.reversed ? relation.sourceId : relation.targetId;
    const reviewState = resolved.reviewState === "needs_review" ? "needs_review" : relation.state;
    const edge = EdgeSchema.parse({
      id: edgeKey({ sourceId, relationshipType: resolved.relationshipType, targetId }),
      sourceId,
      relationshipType: resolved.relationshipType,
      targetId,
      properties: { ...resolved.properties, proposalId: relation.id, reviewReason: relation.reason },
      provenance: [llmProvenance(relation)],
      confidence: relation.confidence,
      inferred: false,
      reviewState,
      evidence: [relation.evidence],
    });
    const target = await this.repository.getNode(relation.targetId);
    if (target && target.nodeType !== "Story") {
      await this.repository.upsertNodes([{ ...target, provenance: [llmProvenance(relation)], updatedAt: new Date() }]);
    }
    const result = await this.repository.upsertEdges([edge]);
    if (result.written !== 1) throw new Error(`Relationship ${relation.id} has a missing graph endpoint`);
    relation.graphEdgeId = edge.id;
  }

  async decide(relation: Relation): Promise<void> {
    const decision = relation.decisions[0];
    if (!decision) throw new Error(`Relationship ${relation.id} has no decision`);
    if (!relation.graphEdgeId) throw new Error(`Relationship ${relation.id} has no graph edge ID`);

    if (decision.action === "approve") {
      await this.repository.reviewEdge(relation.graphEdgeId, { action: "approve", reviewer: decision.reviewer, reason: decision.reason });
      return;
    }
    if (decision.action === "reject") {
      await this.repository.reviewEdge(relation.graphEdgeId, { action: "reject", reviewer: decision.reviewer, reason: decision.reason });
      return;
    }
    await this.repository.reviewEdge(relation.graphEdgeId, {
      action: "correct",
      reviewer: decision.reviewer,
      reason: decision.reason,
      relationshipType: relation.type as RelationshipType,
      reverse: decision.reverse,
    });
  }

  async storyContext(storyId: string, parentIds: string[] = []): Promise<string> {
    const sources = new Set([storyId, ...parentIds]);
    const neighborhood = await this.repository.getNeighborhood([...sources], { depth: 2, maxNodes: 100, maxEdges: 200 });
    const otherStories = new Set(neighborhood.nodes.filter((node) => node.nodeType === "Story" && !sources.has(node.id)).map((node) => node.id));
    const edges = neighborhood.edges.filter((edge) => edge.reviewState === "approved"
      && !otherStories.has(edge.sourceId) && !otherStories.has(edge.targetId)
      && (edge.relationshipType !== "PARENT_OF" || (sources.has(edge.sourceId) && sources.has(edge.targetId))));
    const included = new Set([storyId, ...edges.flatMap((edge) => [edge.sourceId, edge.targetId])]);
    const nodes = neighborhood.nodes.filter((node) => included.has(node.id));
    if (!nodes.some((node) => node.id === storyId && node.nodeType === "Story")) throw new Error(`Story ${storyId} is absent from the graph`);
    return JSON.stringify({ nodes, edges });
  }

  async designContext(storyId: string, parentIds: string[] = []): Promise<DesignGraphContext> {
    const seeds = [storyId, ...parentIds];
    const neighborhood = await this.repository.getNeighborhood(seeds, { depth: 3, maxNodes: 300, maxEdges: 600 });
    const edges = neighborhood.edges.filter((edge) => edge.reviewState === "approved");
    const ids = new Set([...seeds, ...edges.flatMap((edge) => [edge.sourceId, edge.targetId])]);
    return {
      nodes: neighborhood.nodes.filter((node) => ids.has(node.id)).map((node) => ({
        id: node.id, nodeType: node.nodeType, canonicalName: node.canonicalName,
        description: node.description, properties: node.properties,
      })),
      edges: edges.map((edge) => ({ sourceId: edge.sourceId, targetId: edge.targetId, relationshipType: edge.relationshipType })),
    };
  }

  async managedTestCases(): Promise<Array<{ id: string; name: string; storyIds: string[]; dependsOnCaseIds?: string[]; content: Record<string, unknown>; contentHash: string }>> {
    const cases = await this.repository.managedTestCases();
    for (const { node } of cases) {
      if (!Array.isArray(node.properties.steps)) continue;
      const stepText = (node.properties.steps as Array<{ action?: string; expectedResult?: string }>)
        .map((step) => `${step.action ?? ""} ${step.expectedResult ?? ""}`).join("\n");
      if (stepText.trim() && !node.description?.includes(stepText)) await this.client.run(
        "MATCH (n:Node {id: $id, nodeType: 'TestCase'}) SET n.description = $description",
        { id: node.id, description: `${node.description ?? ""}\n${stepText}`.trim() });
    }
    return cases.map(({ node, storyIds, dependsOnCaseIds }) => ({
      id: node.id, name: node.canonicalName, storyIds, dependsOnCaseIds, content: node.properties, contentHash: hash(node.properties),
    }));
  }

  async pruneChangedSources(sourceIds: string[]): Promise<void> {
    await this.repository.pruneDocumentProvenance(sourceIds.map((id) => `ado:${id}`));
  }

  async archiveSourceRevision(source: Story | WorkItemParent): Promise<void> {
    const id = `SourceRevision:${source.adoId}:${hash(source.text).slice(0, 32)}`;
    const node = NodeSchema.parse({ id, nodeType: "Document", canonicalName: `${source.title} revision ${source.revision ?? 0}`,
      properties: { documentKind: "ado-source-revision", sourceId: source.id, adoId: source.adoId,
        revision: source.revision ?? 0, text: source.text, textHash: hash(source.text) },
      provenance: [agentProvenance(id)] });
    await this.repository.upsertNodes([node]);
    if (await this.repository.getNode(source.id)) await this.writeEdge(id, "DESCRIBES", source.id,
      { provenance: [agentProvenance(id)], reviewState: "approved", inferred: true, confidence: 1 });
  }

  async graphStory(storyId: string): Promise<Story | null> {
    const node = await this.repository.getNode(storyId);
    return node?.nodeType === "Story" && typeof node.properties.adoId === "number" ? node.properties as Story : null;
  }

  async pendingImpactStories(): Promise<Array<{ storyId: string; adoId: number; revision: number }>> {
    const result = await this.client.run("MATCH (p:StoryPipeline) WHERE p.hasPendingImpact = true RETURN p.recordJson AS record");
    return result.records.map((item) => JSON.parse(String(item.get("record"))) as StoryPipelineRecord)
      .map((record) => ({ storyId: record.story.id, adoId: record.adoId, revision: record.revision }));
  }

  async artifact(artifact: Artifact): Promise<void> {
    const node = NodeSchema.parse({
      id: artifact.id,
      nodeType: artifact.kind,
      canonicalName: artifact.name,
      description: artifact.kind === "TestCase" && Array.isArray(artifact.content.steps)
        ? (artifact.content.steps as Array<{ action?: string; expectedResult?: string }>).map((step) => `${step.action ?? ""} ${step.expectedResult ?? ""}`).join("\n")
        : undefined,
      properties: { ...artifact.content, ownerStoryId: artifact.storyId, reviewer: artifact.reviewer, approvedAt: artifact.approvedAt, sourceHash: artifact.hash },
      provenance: [agentProvenance(artifact.id)],
    });
    await this.repository.upsertNodes([node]);
    if (artifact.kind === "TestSuite") {
      const reused = artifact.content.reusedScenarioIds;
      if (Array.isArray(reused)) for (const id of reused) {
        if (typeof id !== "string" || !await this.repository.getNode(id)) throw new Error(`Unknown reused scenario ${String(id)}`);
        await this.writeEdge(artifact.id, "CONTAINS", id, { provenance: [agentProvenance(artifact.id)], reviewState: "approved", inferred: true, confidence: 1 });
      }
      const reusedCases = artifact.content.reusedCaseIds;
      if (Array.isArray(reusedCases)) for (const id of reusedCases) {
        if (typeof id !== "string" || !await this.repository.getNode(id)) throw new Error(`Unknown reused case ${String(id)}`);
        await this.writeEdge(artifact.id, "CONTAINS", id, { provenance: [agentProvenance(artifact.id)], reviewState: "approved", inferred: true, confidence: 1 });
      }
    }
    await this.writeEdge(artifact.id, "TRACES_TO", artifact.storyId, {
      provenance: [agentProvenance(artifact.id)],
      reviewState: "approved",
      inferred: true,
      confidence: 1,
    });
    for (const [field, relationshipType] of [["coversNodeIds", "COVERS"], ["validatesNodeIds", "VALIDATES"], ["exercisesNodeIds", "EXERCISES"]] as const) {
      const targets = artifact.content[field];
      if (!Array.isArray(targets)) continue;
      for (const targetId of targets) {
        if (typeof targetId !== "string" || !await this.repository.getNode(targetId)) throw new Error(`Unknown ${field} target ${String(targetId)}`);
        await this.writeEdge(artifact.id, relationshipType, targetId, {
          provenance: [agentProvenance(artifact.id)], reviewState: "approved", inferred: true, confidence: 1,
        });
      }
    }
    if (!artifact.parentId) return;
    const parent = await this.repository.getNode(artifact.parentId);
    if (!parent) throw new Error(`Artifact ${artifact.id} has no parent in the graph`);
    if (artifact.kind === "TestCase" && parent.nodeType === "TestScenario") {
      await this.writeEdge(artifact.id, "COVERS", parent.id, {
        provenance: [agentProvenance(artifact.id)],
        reviewState: "approved",
        inferred: true,
        confidence: 1,
      });
      return;
    }
    await this.writeEdge(parent.id, "CONTAINS", artifact.id, {
      provenance: [agentProvenance(artifact.id)],
      reviewState: "approved",
      inferred: true,
      confidence: 1,
    });
  }

  async activateCaseRevision(artifact: Artifact, expectedHash: string): Promise<void> {
    if (artifact.kind !== "TestCase") throw new Error("Only TestCase revisions can replace an active case");
    for (const [field, relation] of [["validatesNodeIds", "VALIDATES"], ["exercisesNodeIds", "EXERCISES"]] as const) {
      const ids = artifact.content[field];
      if (!Array.isArray(ids)) continue;
      for (const id of ids) {
        const node = typeof id === "string" ? await this.repository.getNode(id) : null;
        if (!node || !isSemanticEdgeAllowed(relation, "TestCase", node.nodeType)) throw new Error(`Invalid current ${relation} target ${String(id)}`);
      }
    }
    const dependencies = artifact.content.dependsOnCaseIds;
    if (Array.isArray(dependencies)) for (const id of dependencies) {
      const node = typeof id === "string" ? await this.repository.getNode(id) : null;
      if (!node || node.nodeType !== "TestCase" || id === artifact.id) throw new Error(`Invalid dependent case ${String(id)}`);
    }
    const current = await this.client.run("MATCH (n:Node {id: $id, nodeType: 'TestCase'}) RETURN n.propertiesJson AS content", { id: artifact.id });
    const oldJson = current.records[0]?.get("content");
    if (typeof oldJson !== "string") throw new Error(`Active test case ${artifact.id} is missing`);
    const oldHash = hash(JSON.parse(oldJson));
    const newContent = { ...artifact.content, ownerStoryId: artifact.storyId, reviewer: artifact.reviewer, approvedAt: artifact.approvedAt, sourceHash: artifact.hash,
      outdated: false, outdatedReason: null };
    if (oldHash !== expectedHash && hash(JSON.parse(oldJson)) !== hash(newContent)) throw new Error(`Test case ${artifact.id} changed since the revision was proposed`);
    if (oldHash === expectedHash) {
      const versionId = `TestCaseRevision:${hash(`${artifact.id}|${oldHash}`).slice(0, 32)}`;
      const result = await this.client.run(
        `MATCH (n:Node {id: $id, nodeType: 'TestCase'}) WHERE n.propertiesJson = $oldJson
         MERGE (v:Node {id: $versionId})
         SET v.nodeType = 'Document', v.canonicalName = $versionName,
             v.propertiesJson = $versionProperties, v.provenanceJson = n.provenanceJson,
             v.createdAt = coalesce(v.createdAt, $now), v.updatedAt = $now
         MERGE (v)-[h:DESCRIBES]->(n)
         SET h.reviewState = 'approved', h.inferred = true, h.updatedAt = $now
         SET n.propertiesJson = $newJson, n.description = $description, n.updatedAt = $now
         RETURN count(n) AS changed`,
        { id: artifact.id, oldJson, versionId, versionName: `${artifact.name} before ${oldHash.slice(0, 12)}`,
          versionProperties: JSON.stringify({ documentKind: "test-case-revision", caseId: artifact.id, contentHash: oldHash, content: JSON.parse(oldJson) }),
          newJson: JSON.stringify(newContent), description: Array.isArray(artifact.content.steps)
            ? (artifact.content.steps as Array<{ action?: string; expectedResult?: string }>).map((step) => `${step.action ?? ""} ${step.expectedResult ?? ""}`).join("\n") : "",
          now: new Date().toISOString() },
      );
      if (Number(result.records[0]?.get("changed")?.toNumber?.() ?? result.records[0]?.get("changed") ?? 0) !== 1) throw new Error(`Test case ${artifact.id} changed during activation`);
    }
    if (Array.isArray(dependencies)) for (const id of dependencies) {
      await this.writeEdge(artifact.id, "DEPENDS_ON", String(id), { provenance: [agentProvenance(artifact.id)], reviewState: "approved", inferred: true, confidence: 1 });
    }
  }

  async markCaseOutdated(caseId: string, reason: string): Promise<void> {
    const current = await this.client.run("MATCH (n:Node {id: $id, nodeType: 'TestCase'}) RETURN n.propertiesJson AS content", { id: caseId });
    const oldJson = current.records[0]?.get("content");
    if (typeof oldJson !== "string") throw new Error(`Unknown test case ${caseId}`);
    const oldContent = JSON.parse(oldJson) as Record<string, unknown>;
    const updated = await this.client.run(
      "MATCH (n:Node {id: $id, nodeType: 'TestCase'}) WHERE n.propertiesJson = $oldJson SET n.outdated = true, n.outdatedReason = $reason, n.propertiesJson = $content, n.updatedAt = $now RETURN count(n) AS changed",
      { id: caseId, oldJson, reason, content: JSON.stringify({ ...oldContent, outdated: true, outdatedReason: reason }), now: new Date().toISOString() });
    if (Number(updated.records[0]?.get("changed")?.toNumber?.() ?? updated.records[0]?.get("changed") ?? 0) !== 1) {
      throw new Error(`Test case ${caseId} changed during manual-fix marking`);
    }
  }

  async spec(spec: Spec, sha: string): Promise<void> {
    const id = `TestSpec:${sha}:${spec.caseId}`;
    const node = NodeSchema.parse({
      id,
      nodeType: "Document",
      canonicalName: spec.file,
      properties: { documentKind: "test-spec", sha, file: spec.file, status: spec.status },
      provenance: [agentProvenance(id)],
    });
    await this.repository.upsertNodes([node]);
    await this.writeEdge(id, "DESCRIBES", spec.caseId, {
      provenance: [agentProvenance(id)],
      reviewState: "approved",
      inferred: true,
      confidence: 1,
    });
    await this.writeEdge(id, "DESCRIBES", spec.storyId, {
      provenance: [agentProvenance(id)],
      reviewState: "approved",
      inferred: true,
      confidence: 1,
    });
  }

  async testRun(caseId: string, storyId: string, runId: string, sha: string, result: unknown): Promise<void> {
    const id = `TestRun:${runId}:${caseId}`;
    const node = NodeSchema.parse({
      id,
      nodeType: "TestRun",
      canonicalName: `${caseId} at ${sha.slice(0, 12)}`,
      properties: { sha, result },
      provenance: [executionProvenance(id)],
    });
    await this.repository.upsertNodes([node]);
    await this.writeEdge(caseId, "EXECUTED_IN", id, {
      provenance: [executionProvenance(id)],
      reviewState: "approved",
      inferred: false,
      confidence: 1,
    });
    await this.writeEdge(id, "TRACES_TO", storyId, {
      provenance: [executionProvenance(id)],
      reviewState: "approved",
      inferred: true,
      confidence: 1,
    });
  }

  async storyPipeline(adoId: number): Promise<StoryPipelineRecord | null> {
    const result = await this.client.run("MATCH (p:StoryPipeline {adoId: $adoId}) RETURN p.recordJson AS record", { adoId });
    const value = result.records[0]?.get("record");
    return value ? JSON.parse(String(value)) as StoryPipelineRecord : null;
  }

  async saveStoryPipeline(record: StoryPipelineRecord): Promise<void> {
    await this.client.run(
      "MERGE (p:StoryPipeline {adoId: $adoId}) SET p.revision = $revision, p.iterationPath = $iterationPath, p.stage = $stage, p.status = $status, p.updatedAt = $updatedAt, p.impactSourceHash = $impactSourceHash, p.hasPendingImpact = $hasPendingImpact, p.recordJson = $recordJson",
      { adoId: record.adoId, revision: record.revision, iterationPath: record.iterationPath, stage: record.stage, status: record.status, updatedAt: record.updatedAt, impactSourceHash: record.impactSourceHash ?? null, hasPendingImpact: Boolean(record.pendingImpact || record.pendingImpacts?.length), recordJson: JSON.stringify(record) },
    );
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private async writeEdge(
    sourceId: string,
    relationshipType: RelationshipType,
    targetId: string,
    values: Pick<Edge, "provenance" | "reviewState" | "inferred" | "confidence">,
  ): Promise<void> {
    const edge = EdgeSchema.parse({
      id: edgeKey({ sourceId, relationshipType, targetId }),
      sourceId,
      relationshipType,
      targetId,
      properties: {},
      evidence: values.provenance.flatMap((item) => item.evidenceText ? [item.evidenceText] : []),
      ...values,
    });
    const result = await this.repository.upsertEdges([edge]);
    if (result.written !== 1) throw new Error(`Relationship ${edge.id} has a missing graph endpoint`);
  }
}
