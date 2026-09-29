import { GraphRepository } from "../graph/graph-repository.js";
import { Neo4jClient } from "../graph/neo4j-client.js";
import { EdgeSchema, NodeSchema, ProvenanceSchema, edgeKey, type Edge, type Provenance } from "../models/graph.js";
import { resolveSemanticRelationship } from "../ontology/rules.js";
import { NodeTypeSchema, type RelationshipType } from "../ontology/types.js";
import type { Artifact, NodeKind, Relation, Spec, StoryPipelineRecord } from "../core/runtime.js";

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
    sourceDocumentId: `ado:${relation.sourceId}`,
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
    const neighborhood = await this.repository.getNeighborhood([...sources], { depth: 1, maxNodes: 100, maxEdges: 200 });
    const edges = neighborhood.edges.filter((edge) => edge.reviewState === "approved"
      && (edge.relationshipType !== "PARENT_OF" || (sources.has(edge.sourceId) && sources.has(edge.targetId))));
    const included = new Set([storyId, ...edges.flatMap((edge) => [edge.sourceId, edge.targetId])]);
    const nodes = neighborhood.nodes.filter((node) => included.has(node.id));
    if (!nodes.some((node) => node.id === storyId && node.nodeType === "Story")) throw new Error(`Story ${storyId} is absent from the graph`);
    return JSON.stringify({ nodes, edges });
  }

  async artifact(artifact: Artifact): Promise<void> {
    const node = NodeSchema.parse({
      id: artifact.id,
      nodeType: artifact.kind,
      canonicalName: artifact.name,
      properties: { ...artifact.content, reviewer: artifact.reviewer, approvedAt: artifact.approvedAt, sourceHash: artifact.hash },
      provenance: [agentProvenance(artifact.id)],
    });
    await this.repository.upsertNodes([node]);
    await this.writeEdge(artifact.id, "TRACES_TO", artifact.storyId, {
      provenance: [agentProvenance(artifact.id)],
      reviewState: "approved",
      inferred: true,
      confidence: 1,
    });
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
      "MERGE (p:StoryPipeline {adoId: $adoId}) SET p.revision = $revision, p.iterationPath = $iterationPath, p.stage = $stage, p.status = $status, p.updatedAt = $updatedAt, p.recordJson = $recordJson",
      { adoId: record.adoId, revision: record.revision, iterationPath: record.iterationPath, stage: record.stage, status: record.status, updatedAt: record.updatedAt, recordJson: JSON.stringify(record) },
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
