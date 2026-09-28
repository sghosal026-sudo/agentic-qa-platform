import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type NodeKind = "Story" | "Feature" | "Epic" | "Task" | "Endpoint" | "DataTable" | "BusinessRule" | "Requirement" | "TestPlan" | "TestSuite" | "TestScenario" | "TestCase" | "TestSpec" | "TestRun";
export type RelationDecision = { action: "approve" | "reject" | "correct"; reviewer: string; reason?: string; type?: string; reverse?: boolean; taskId: number; at: string };
export type Relation = {
  id: string; sourceId: string; sourceType: NodeKind; targetId: string; targetType: NodeKind;
  type: string; evidence: string; confidence: number; reason: string; storyIds: string[];
  source: string;
  state: "needs_review" | "approved" | "rejected";
  tasks: Record<string, { id: number; hash: string }>; decisions: RelationDecision[];
};
export type WorkItemParent = { id: string; adoId: number; revision: number; kind: "Feature" | "Epic"; title: string; text: string };
export type Story = { id: string; adoId: number; revision?: number; title: string; text: string; areaPath: string; iterationPath: string; parents?: WorkItemParent[] };
export type Artifact = { id: string; kind: "TestPlan" | "TestSuite" | "TestScenario" | "TestCase"; name: string; storyId: string; parentId?: string; content: Record<string, unknown>; hash: string; reviewTask?: { id: number; hash: string }; reviewer?: string; approvedAt?: string };
export type Spec = { caseId: string; storyId: string; file: string; status: "generated" | "fixme"; reason?: string };
export type Run = { id: string; status: "ingesting" | "review_relations" | "mapping_error" | "ready_design" | "review_artifacts" | "ready_specs" | "review_specs" | "executed"; stories: Story[]; relations: Relation[]; artifacts: Artifact[]; specs: Spec[]; errors: string[]; createdAt: string };
export type StoryPipelineRecord = {
  adoId: number;
  revision: number;
  iterationPath: string;
  story: Story;
  stage: "discovered" | Run["status"];
  status: "active" | "blocked" | "passed" | "failed";
  run?: Run;
  pullRequest?: { owner: string; repo: string; number: number; sha: string };
  result?: { executionId: string; tests: number; failures: number; workflowUrl?: string };
  updatedAt: string;
};

export function hash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function runPath(id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid run ID");
  return path.resolve("runs", id);
}

export async function newRun(): Promise<Run> {
  const run: Run = { id: randomUUID(), status: "ingesting", stories: [], relations: [], artifacts: [], specs: [], errors: [], createdAt: new Date().toISOString() };
  await saveRun(run);
  return run;
}

export async function loadRun(id: string): Promise<Run> {
  return JSON.parse(await fs.readFile(path.join(runPath(id), "run.json"), "utf8")) as Run;
}

export async function saveRun(run: Run): Promise<void> {
  const directory = runPath(run.id);
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, "run.json");
  await fs.writeFile(`${file}.tmp`, `${JSON.stringify(run, null, 2)}\n`);
  await fs.rename(`${file}.tmp`, file);
}
