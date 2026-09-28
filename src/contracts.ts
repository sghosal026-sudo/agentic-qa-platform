import type { Artifact, NodeKind, Relation, RelationDecision, Run, Spec, Story, StoryPipelineRecord } from "./core/runtime.js";

export interface GraphStore {
  setup(): Promise<void>;
  node(id: string, kind: NodeKind, name: string, content: unknown): Promise<void>;
  hierarchy(parentId: string, childId: string, source?: { adoId: number; title: string }): Promise<void>;
  plannedFor(storyId: string, iterationPath: string, source?: { adoId: number; title: string }): Promise<void>;
  propose(relation: Relation): Promise<void>;
  decide(relation: Relation): Promise<void>;
  storyContext(storyId: string): Promise<string>;
  artifact(artifact: Artifact): Promise<void>;
  spec(spec: Spec, sha: string): Promise<void>;
  testRun(caseId: string, storyId: string, runId: string, sha: string, result: unknown): Promise<void>;
  storyPipeline(adoId: number): Promise<StoryPipelineRecord | null>;
  saveStoryPipeline(record: StoryPipelineRecord): Promise<void>;
  close?(): Promise<void>;
}

export interface ModelClient {
  json(prompt: string): Promise<unknown>;
}

export interface WorkItemClient {
  task(runId: string, relation: Relation, story: Story): Promise<{ id: number; hash: string }>;
  decision(taskId: number, expectedHash: string): Promise<RelationDecision | null>;
}

export interface SprintWorkItemClient extends WorkItemClient {
  sprintStories(iterationPath: string): Promise<Story[]>;
  artifactTask(runId: string, artifact: Artifact, story: Story): Promise<{ id: number; hash: string }>;
  artifactDecision(taskId: number, expectedHash: string): Promise<RelationDecision | null>;
  publishResult(story: Story, result: ExecutionResult, workflowUrl?: string): Promise<void>;
}

export type ReviewResult = { pending: number; conflicts: number; applied: number };
export type ExecutionResult = { executionId: string; tests: number; failures: number };
export type RunSummary = {
  runId: string;
  status: Run["status"];
  stories: number;
  relationships: number;
  artifacts: number;
  specs: number;
  warnings: string[];
  errors: string[];
};
