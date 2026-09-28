import neo4j, { type Driver } from "neo4j-driver";
import { hash, required, type Artifact, type NodeKind, type Relation, type Spec, type StoryPipelineRecord } from "../core/runtime.js";

export class Graph {
  private driver: Driver;

  constructor() {
    this.driver = neo4j.driver(process.env.NEO4J_URI ?? "bolt://localhost:7687", neo4j.auth.basic(process.env.NEO4J_USERNAME ?? "neo4j", required("NEO4J_PASSWORD")));
  }

  async query(cypher: string, params: Record<string, unknown> = {}) {
    const session = this.driver.session({ database: process.env.NEO4J_DATABASE ?? "neo4j" });
    try { return await session.run(cypher, params); } finally { await session.close(); }
  }

  async setup(): Promise<void> {
    await this.query("CREATE CONSTRAINT qa_node_id IF NOT EXISTS FOR (n:Node) REQUIRE n.id IS UNIQUE");
    await this.query("CREATE CONSTRAINT qa_story_pipeline_ado_id IF NOT EXISTS FOR (p:StoryPipeline) REQUIRE p.adoId IS UNIQUE");
  }

  async node(id: string, kind: NodeKind, name: string, content: unknown): Promise<void> {
    await this.query("MERGE (n:Node {id: $id}) SET n.nodeType = $kind, n.canonicalName = $name, n.propertiesJson = $content", { id, kind, name, content: JSON.stringify(content) });
  }

  async propose(relation: Relation): Promise<void> {
    const result = await this.query(
      "MATCH (a:Node {id: $sourceId}), (b:Node {id: $targetId}) MERGE (a)-[r:RELATES_TO {id: $id}]->(b) SET r.reviewState = 'needs_review', r.proposedType = $type, r.evidence = $evidence, r.confidence = $confidence, r.reason = $reason, r.source = $source RETURN r.id AS id",
      { sourceId: relation.sourceId, targetId: relation.targetId, id: relation.id, type: relation.type, evidence: relation.evidence, confidence: relation.confidence, reason: relation.reason, source: relation.source },
    );
    if (!result.records.length) throw new Error(`Relationship ${relation.id} has a missing graph endpoint`);
  }

  async decide(relation: Relation): Promise<void> {
    const decision = relation.decisions[0];
    if (!decision) throw new Error(`Relationship ${relation.id} has no decision`);
    const replacesFallback = relation.state === "approved" && (relation.type !== "RELATES_TO" || decision.reverse);
    const updated = await this.query("MATCH ()-[r:RELATES_TO {id: $id}]->() SET r.reviewState = $state, r.reviewHistory = $history RETURN r.id AS id", { id: relation.id, state: replacesFallback ? "rejected" : relation.state, history: JSON.stringify(relation.decisions) });
    if (!updated.records.length) throw new Error(`Relationship ${relation.id} is absent from the graph`);
    if (!replacesFallback) return;
    const type = relation.type;
    if (!/^[A-Z_]+$/.test(type)) throw new Error("Invalid ontology relationship type");
    const sourceId = decision.reverse ? relation.targetId : relation.sourceId;
    const targetId = decision.reverse ? relation.sourceId : relation.targetId;
    await this.query(`MATCH (a:Node {id: $sourceId}), (b:Node {id: $targetId}) MERGE (a)-[r:${type} {id: $id}]->(b) SET r.reviewState = 'approved', r.evidence = $evidence, r.reviewHistory = $history`, { sourceId, targetId, id: hash(`${sourceId}|${type}|${targetId}`), evidence: relation.evidence, history: JSON.stringify(relation.decisions) });
  }

  async storyContext(storyId: string): Promise<string> {
    const result = await this.query(
      "MATCH (s:Node {id: $storyId, nodeType: 'Story'}) OPTIONAL MATCH (s)-[r]-(other:Node) WHERE r.reviewState = 'approved' RETURN s.propertiesJson AS story, collect({type: type(r), name: other.canonicalName, evidence: r.evidence}) AS links",
      { storyId },
    );
    const row = result.records[0];
    if (!row) throw new Error(`Story ${storyId} is absent from the graph`);
    return JSON.stringify({ story: JSON.parse(String(row.get("story"))), links: row.get("links") });
  }

  async artifact(artifact: Artifact): Promise<void> {
    await this.node(artifact.id, artifact.kind, artifact.name, { ...artifact.content, reviewer: artifact.reviewer, approvedAt: artifact.approvedAt, sourceHash: artifact.hash });
    const linked = await this.query("MATCH (a:Node {id: $id}), (s:Node {id: $storyId, nodeType: 'Story'}) MERGE (a)-[r:TRACES_TO]->(s) SET r.reviewState = 'approved' RETURN a.id AS id", { id: artifact.id, storyId: artifact.storyId });
    if (!linked.records.length) throw new Error(`Artifact ${artifact.id} has no Story mapping`);
    if (artifact.parentId) {
      const parent = await this.query("MATCH (p:Node {id: $parentId}), (a:Node {id: $id}) MERGE (p)-[r:CONTAINS]->(a) SET r.reviewState = 'approved' RETURN a.id AS id", { parentId: artifact.parentId, id: artifact.id });
      if (!parent.records.length) throw new Error(`Artifact ${artifact.id} has no parent in the graph`);
    }
  }

  async spec(spec: Spec, sha: string): Promise<void> {
    const id = `TestSpec:${sha}:${spec.caseId}`;
    await this.node(id, "TestSpec", spec.file, { sha, file: spec.file, status: spec.status });
    const linked = await this.query("MATCH (a:Node {id: $id}), (c:Node {id: $caseId, nodeType: 'TestCase'}), (s:Node {id: $storyId, nodeType: 'Story'}) MERGE (a)-[:TRACES_TO {reviewState: 'approved'}]->(c) MERGE (a)-[:TRACES_TO {reviewState: 'approved'}]->(s) RETURN a.id AS id", { id, caseId: spec.caseId, storyId: spec.storyId });
    if (!linked.records.length) throw new Error(`Spec ${id} has no Test Case or Story mapping`);
  }

  async testRun(caseId: string, storyId: string, runId: string, sha: string, result: unknown): Promise<void> {
    const id = `TestRun:${runId}:${caseId}`;
    await this.node(id, "TestRun", `${caseId} at ${sha.slice(0, 12)}`, { sha, result });
    const linked = await this.query("MATCH (r:Node {id: $id}), (c:Node {id: $caseId, nodeType: 'TestCase'}), (s:Node {id: $storyId, nodeType: 'Story'}) MERGE (c)-[:EXECUTED_IN {reviewState: 'approved'}]->(r) MERGE (r)-[:TRACES_TO {reviewState: 'approved'}]->(s) RETURN r.id AS id", { id, caseId, storyId });
    if (!linked.records.length) throw new Error(`TestRun ${id} has no Test Case or Story mapping`);
  }

  async storyPipeline(adoId: number): Promise<StoryPipelineRecord | null> {
    const result = await this.query("MATCH (p:StoryPipeline {adoId: $adoId}) RETURN p.recordJson AS record", { adoId });
    const value = result.records[0]?.get("record");
    return value ? JSON.parse(String(value)) as StoryPipelineRecord : null;
  }

  async saveStoryPipeline(record: StoryPipelineRecord): Promise<void> {
    await this.query(
      "MERGE (p:StoryPipeline {adoId: $adoId}) SET p.revision = $revision, p.iterationPath = $iterationPath, p.stage = $stage, p.status = $status, p.updatedAt = $updatedAt, p.recordJson = $recordJson",
      { adoId: record.adoId, revision: record.revision, iterationPath: record.iterationPath, stage: record.stage, status: record.status, updatedAt: record.updatedAt, recordJson: JSON.stringify(record) },
    );
  }

  async close(): Promise<void> { await this.driver.close(); }
}
