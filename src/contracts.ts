import type { Artifact, NodeKind, Relation, RelationDecision, Run, Spec, Story, StoryPipelineRecord, TestReview, WorkItemParent } from "./core/runtime.js";
import type { NodeType } from "./ontology/types.js";

export interface GraphStore {
  setup(): Promise<void>;
  deleteAll(): Promise<number>;
  node(id: string, kind: NodeKind, name: string, content: unknown): Promise<void>;
  mentionedEntities(text: string): Promise<Array<{ id: string; type: NodeType; name: string }>>;
  hasApprovedRelationship?(sourceId: string, type: string, targetId: string): Promise<boolean>;
  hierarchy(parentId: string, childId: string, source?: { adoId: number; title: string }): Promise<void>;
  plannedFor(storyId: string, iterationPath: string, source?: { adoId: number; title: string }): Promise<void>;
  propose(relation: Relation): Promise<void>;
  decide(relation: Relation): Promise<void>;
  storyContext(storyId: string, parentIds?: string[]): Promise<string>;
  designContext?(storyId: string, parentIds?: string[]): Promise<DesignGraphContext>;
  managedTestCases?(): Promise<Array<{ id: string; name: string; storyIds: string[]; dependsOnCaseIds?: string[]; content: Record<string, unknown>; contentHash: string }>>;
  pruneChangedSources?(sourceIds: string[]): Promise<void>;
  archiveSourceRevision?(source: Story | WorkItemParent): Promise<void>;
  graphStory?(storyId: string): Promise<Story | null>;
  pendingImpactStories?(): Promise<Array<{ storyId: string; adoId: number; revision: number }>>;
  artifact(artifact: Artifact): Promise<void>;
  activateCaseRevision?(artifact: Artifact, expectedHash: string): Promise<void>;
  markCaseOutdated?(caseId: string, reason: string): Promise<void>;
  spec(spec: Spec, sha: string): Promise<void>;
  testRun(caseId: string, storyId: string, runId: string, sha: string, result: unknown): Promise<void>;
  storyPipeline(adoId: number): Promise<StoryPipelineRecord | null>;
  saveStoryPipeline(record: StoryPipelineRecord): Promise<void>;
  close?(): Promise<void>;
}

export type DesignGraphContext = {
  nodes: Array<{ id: string; nodeType: string; canonicalName: string; description?: string; properties: Record<string, unknown> }>;
  edges: Array<{ sourceId: string; targetId: string; relationshipType: string }>;
};

export interface ModelClient {
  complete?: import("./spec-generation/llm/llmClient.js").LlmClient["complete"];
  json(prompt: string, output?: { name: string; schema: Record<string, unknown> }): Promise<unknown>;
}

export interface WorkItemClient {
  task(runId: string, relation: Relation, story: Story): Promise<{ id: number; hash: string }>;
  decision(taskId: number, expectedHash: string): Promise<RelationDecision | "missing" | null>;
  recommendationStatus(taskId: number, proposalHash: string, model: string): Promise<"needed" | "present" | "unavailable">;
  postRecommendation(taskId: number, proposalHash: string, model: string, text: string): Promise<void>;
}

export interface SprintWorkItemClient extends WorkItemClient {
  resetReviewTasks(): Promise<number>;
  sprintStories(iterationPath: string): Promise<Story[]>;
  storyById?(adoId: number): Promise<Story>;
  artifactTask(runId: string, artifact: Artifact, story: Story): Promise<{ id: number; hash: string }>;
  artifactDecision(taskId: number, expectedHash: string): Promise<RelationDecision | "missing" | null>;
  testReviewTask?(runId: string, review: TestReview, story: Story): Promise<number>;
  testReviewComments?(taskId: number): Promise<Array<{ text: string; reviewer: string; at: string }>>;
  closeTestReviewTask?(taskId: number): Promise<void>;
  publishResult(story: Story, result: ExecutionResult, workflowUrl?: string): Promise<void>;
}

export type ReviewResult = { pending: number; conflicts: number; applied: number };
export type ExecutionResult = { executionId: string; tests: number; failures: number; passed?: number; failed?: number; skipped?: number; fixme?: number; collectionFailures?: number; infrastructureFailures?: number };
export type RunSummary = {
  runId: string;
  status: Run["status"];
  stories: number;
  relationships: number;
  artifacts: number;
  specs: number;
  warnings: string[];
  errors: string[];
  testDesign?: Run["testDesign"];
};
