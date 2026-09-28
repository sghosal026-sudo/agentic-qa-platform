import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { hash, newRun, runPath, saveRun, type Artifact, type NodeKind, type Relation, type Run, type Spec, type Story } from "../core/runtime.js";
import type { GraphStore, ModelClient, WorkItemClient } from "../contracts.js";
import { stageReviews } from "./review.js";

const RelationOutput = z.object({ relationships: z.array(z.object({
  targetName: z.string().min(1), targetType: z.enum(["Endpoint", "DataTable", "BusinessRule", "Requirement", "Story"]),
  type: z.string().min(1), evidence: z.string().min(1), confidence: z.number().min(0).max(1),
  reason: z.string().min(1), storyIds: z.array(z.string()).optional(),
})) });
const Route = z.object({ method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]), path: z.string().startsWith("/"), expectedStatus: z.number().int(), body: z.record(z.string(), z.unknown()).optional() });
const DesignOutput = z.object({ scenarios: z.array(z.object({
  name: z.string().min(1), evidence: z.string().min(1),
  cases: z.array(z.object({ name: z.string().min(1), steps: z.array(z.string()).min(1), expected: z.string().min(1), route: Route.optional() })).min(1),
})).min(1) });
export type Target = { projectDir: string; baseUrl: string; safeEnvironments: string[]; routes: Array<{ method: string; path: string; responses: number[]; requiresAuth?: boolean; requestBody?: Record<string, unknown> }> };
const TargetSchema = z.object({
  projectDir: z.string().min(1), baseUrl: z.url(), safeEnvironments: z.array(z.url()).min(1),
  routes: z.array(z.object({ method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]), path: z.string().startsWith("/"), responses: z.array(z.number().int()), requiresAuth: z.boolean().optional(), requestBody: z.record(z.string(), z.unknown()).optional() })),
});

async function files(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await files(file));
    else if (/\.(json|md|txt)$/i.test(entry.name)) output.push(file);
  }
  return output;
}

function plain(value: string): string {
  return value.replace(/<br\s*\/?\s*>|<\/p>|<\/li>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
}

function storyFromJson(value: unknown): Story | null {
  if (!value || typeof value !== "object") return null;
  const item = value as { id?: unknown; rev?: unknown; code?: unknown; fields?: Record<string, unknown> };
  const fields = item.fields;
  if (!fields || !["User Story", "Product Backlog Item", "Story"].includes(String(fields["System.WorkItemType"]))) return null;
  const id = typeof item.code === "string" ? item.code : String(fields["System.Title"] ?? "").match(/[A-Z]+-\d+/)?.[0];
  if (!id || typeof item.id !== "number") throw new Error("Story JSON needs a code and numeric ADO id");
  return { id, adoId: item.id, revision: typeof item.rev === "number" ? item.rev : undefined, title: String(fields["System.Title"] ?? id), text: plain(String(fields["System.Description"] ?? "")), areaPath: String(fields["System.AreaPath"] ?? ""), iterationPath: String(fields["System.IterationPath"] ?? "") };
}

export function relationFromModel(story: Story, item: z.infer<typeof RelationOutput>["relationships"][number], knownStories: Set<string>, source = story.id): Relation {
  if (!story.text.includes(item.evidence)) throw new Error(`Relationship evidence is not in Story ${story.id}: ${item.evidence}`);
  const storyIds = [...new Set([story.id, ...(item.storyIds ?? [])])];
  for (const id of storyIds) if (!knownStories.has(id)) throw new Error(`Relationship has no resolved Story mapping: ${id}`);
  const targetId = item.targetType === "Story" ? item.targetName : `${item.targetType}:${hash(item.targetName.toLowerCase()).slice(0, 16)}`;
  if (item.targetType === "Story" && !knownStories.has(targetId)) throw new Error(`Target Story ${targetId} is missing`);
  return {
    id: hash(`${story.id}|${item.type}|${targetId}|${item.evidence}`).slice(0, 32),
    sourceId: story.id, sourceType: "Story", targetId, targetType: item.targetType as NodeKind,
    type: item.type.toUpperCase(), evidence: item.evidence, confidence: item.confidence, reason: item.reason,
    storyIds, source, state: "needs_review", tasks: {}, decisions: [],
  };
}

export async function ingestStory(story: Story, graph: GraphStore, model: ModelClient, ado: WorkItemClient): Promise<Run> {
  const run = await newRun();
  run.stories.push(story);
  await graph.setup();
  await graph.node(story.id, "Story", story.title, story);
  let childId = story.id;
  for (const parent of story.parents ?? []) {
    await graph.node(parent.id, parent.kind, parent.title, parent);
    await graph.hierarchy(parent.id, childId);
    childId = parent.id;
  }
  await saveRun(run);
  try {
    const response = RelationOutput.parse(await model.json(`Extract relationships relevant to Story ${story.id}. Return {"relationships": [{"targetName":"...","targetType":"Endpoint|DataTable|BusinessRule|Requirement|Story","type":"...","evidence":"exact quote from the source","confidence":0.0,"reason":"why review is needed","storyIds":["${story.id}"]}]}. All extracted relationships require review. Source text:\n${story.text.slice(0, 16000)}`));
    const known = new Set([story.id]);
    for (const item of response.relationships) {
      const relation = relationFromModel(story, item, known);
      if (relation.targetType !== "Story") await graph.node(relation.targetId, relation.targetType, item.targetName, { sourceStory: story.id });
      await graph.propose(relation);
      run.relations.push(relation);
    }
    await saveRun(run);
  } catch (error) {
    run.status = "mapping_error";
    run.errors.push(`${story.id}: ${error instanceof Error ? error.message : String(error)}`);
    await saveRun(run);
    return run;
  }
  await stageReviews(run, ado);
  return run;
}

export async function ingest(directory: string, graph: GraphStore, model: ModelClient, ado: WorkItemClient): Promise<Run> {
  const run = await newRun();
  await graph.setup();
  const inputs = await files(directory);
  for (const file of inputs) {
    if (!file.endsWith(".json")) continue;
    const value = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    const story = storyFromJson(value);
    if (story) run.stories.push(story);
  }
  if (!run.stories.length) throw new Error("No ADO Stories found in input directory");
  const known = new Set(run.stories.map((story) => story.id));
  for (const story of run.stories) await graph.node(story.id, "Story", story.title, story);
  await saveRun(run);
  const sources: Array<{ story: Story; text: string; name: string }> = run.stories.map((story) => ({ story, text: story.text, name: story.id }));
  for (const file of inputs.filter((name) => /\.(md|txt)$/i.test(name))) {
    const text = plain(await fs.readFile(file, "utf8"));
    const linked = run.stories.filter((story) => new RegExp(`\\b${story.id}\\b`, "i").test(text));
    if (!linked.length) {
      run.status = "mapping_error";
      run.errors.push(`No Story mapping for ${path.basename(file)}`);
      await saveRun(run);
      continue;
    }
    for (const story of linked) sources.push({ story, text, name: path.basename(file) });
  }
  if (run.errors.length) return run;
  const seen = new Set<string>();
  for (const source of sources) {
    const { story } = source;
    try {
      const response = RelationOutput.parse(await model.json(`Extract relationships relevant to Story ${story.id}. Return {"relationships": [{"targetName":"...","targetType":"Endpoint|DataTable|BusinessRule|Requirement|Story","type":"...","evidence":"exact quote from the source","confidence":0.0,"reason":"why review is needed","storyIds":["${story.id}"]}]}. All extracted relationships require review. Source text:\n${source.text.slice(0, 16000)}`));
      for (const item of response.relationships) {
        const relation = relationFromModel({ ...story, text: source.text }, item, known, source.name);
        if (seen.has(relation.id)) continue;
        seen.add(relation.id);
        if (relation.targetType !== "Story") await graph.node(relation.targetId, relation.targetType, item.targetName, { sourceStory: story.id });
        await graph.propose(relation);
        run.relations.push(relation);
      }
      await saveRun(run);
    } catch (error) {
      run.status = "mapping_error";
      run.errors.push(`${story.id}: ${error instanceof Error ? error.message : String(error)}`);
      await saveRun(run);
    }
  }
  if (run.errors.length) return run;
  await stageReviews(run, ado);
  return run;
}

function artifact(kind: Artifact["kind"], name: string, storyId: string, parentId: string | undefined, content: Record<string, unknown>): Artifact {
  return { id: `${kind}:${hash(`${storyId}|${parentId ?? ""}|${name}`).slice(0, 20)}`, kind, name, storyId, parentId, content, hash: hash(content) };
}

export async function design(run: Run, graph: GraphStore, model: ModelClient): Promise<void> {
  if (run.status !== "ready_design") throw new Error("Relationship review must resolve before design");
  run.artifacts = [];
  await saveRun(run);
  for (const story of run.stories) {
    const context = await graph.storyContext(story.id);
    const response = DesignOutput.parse(await model.json(`Design evidence-grounded QA scenarios and cases for this Story. Return JSON {"scenarios":[{"name":"...","evidence":"exact quote from the Story","cases":[{"name":"...","steps":["..."],"expected":"...","route":{"method":"GET","path":"/known/path","expectedStatus":200}}]}]}. Omit route when source and target contract do not establish it. If the entire expected result is only an HTTP status, write it exactly as "HTTP 200" (using the actual status). For richer expected results, leave route omitted so the case remains manual until supported assertions exist. Story: ${story.text}\nApproved graph context: ${context}`));
    const plan = artifact("TestPlan", `${story.id} test plan`, story.id, undefined, { objective: story.title, evidence: story.text });
    const suite = artifact("TestSuite", `${story.id} functional suite`, story.id, plan.id, { testType: "functional" });
    run.artifacts.push(plan, suite);
    for (const entry of response.scenarios) {
      if (!story.text.includes(entry.evidence)) throw new Error(`Scenario evidence is not in Story ${story.id}`);
      const scenario = artifact("TestScenario", entry.name, story.id, suite.id, { evidence: entry.evidence });
      run.artifacts.push(scenario);
      for (const testCase of entry.cases) run.artifacts.push(artifact("TestCase", testCase.name, story.id, scenario.id, testCase));
    }
    await saveRun(run);
  }
  run.status = "review_artifacts";
  await saveRun(run);
}

export async function approveArtifact(run: Run, id: string, reviewer: string): Promise<void> {
  if (run.status !== "review_artifacts" || !reviewer.trim()) throw new Error("Artifact review is unavailable or reviewer is empty");
  const item = run.artifacts.find((value) => value.id === id);
  if (!item) throw new Error(`Unknown artifact: ${id}`);
  item.hash = hash(item.content);
  item.reviewer = reviewer.trim();
  item.approvedAt = new Date().toISOString();
  await saveRun(run);
}

export async function ingestDesign(run: Run, graph: GraphStore): Promise<void> {
  if (run.status !== "review_artifacts") throw new Error("Design is not ready for ingestion");
  const missing = run.artifacts.filter((item) => !item.reviewer || !item.approvedAt || item.hash !== hash(item.content));
  if (missing.length) throw new Error(`Artifacts awaiting review: ${missing.map((item) => item.id).join(", ")}`);
  for (const item of run.artifacts) await graph.artifact(item);
  run.status = "ready_specs";
  await saveRun(run);
}

export async function loadTarget(file: string): Promise<Target> {
  const target = TargetSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
  if (!target.safeEnvironments.includes(target.baseUrl)) throw new Error("Target baseUrl must be listed in safeEnvironments");
  return target;
}

function safeName(id: string): string { return id.toLowerCase().replace(/[^a-z0-9]+/g, "-"); }

export function renderSpec(item: Artifact, target: Target, sourceText = ""): { code: string; status: Spec["status"]; reason?: string; ir: Record<string, unknown> } {
  const content = item.content as { steps?: string[]; expected?: string; route?: z.infer<typeof Route> };
  const route = Route.safeParse(content.route);
  const known = route.success ? target.routes.find((entry) => entry.method === route.data.method && entry.path === route.data.path) : undefined;
  let reason = "";
  if (!route.success) reason = "No grounded API operation and expected status";
  else if (!known?.responses.includes(route.data.expectedStatus)) reason = "Route or expected status is absent from the approved target contract";
  else if (known.requiresAuth) reason = "auth.unavailable: this case has no approved authentication binding";
  else if (route.data.path.includes("{")) reason = "Path variables have no grounded bindings";
  else if (route.data.method !== "GET" && (!known.requestBody || JSON.stringify(route.data.body) !== JSON.stringify(known.requestBody))) reason = "Request body has no approved target binding";
  else if (content.expected?.trim() !== `HTTP ${route.data.expectedStatus}`) reason = "Expected result has obligations beyond the supported status assertion";
  else if (sourceText && !sourceText.includes(String(route.data.expectedStatus))) reason = "Expected status is absent from Story evidence";
  const body = reason
    ? `  test.fixme(true, ${JSON.stringify(reason)});`
    : `  const response = await request.${route.data!.method.toLowerCase()}(baseUrl + ${JSON.stringify(route.data!.path)}${route.data!.body ? `, { data: ${JSON.stringify(route.data!.body)} }` : ""});\n  expect(response.status()).toBe(${route.data!.expectedStatus});`;
  const code = `import { test, expect } from "@playwright/test";\n\nconst baseUrl = process.env.SPECGEN_BASE_URL;\nif (!baseUrl) throw new Error("SPECGEN_BASE_URL is required");\n\ntest(${JSON.stringify(item.name)}, { annotation: [{ type: "case", description: ${JSON.stringify(item.id)} }] }, async ({ request }) => {\n${body}\n});\n`;
  return { code, status: reason ? "fixme" : "generated", ...(reason ? { reason } : {}), ir: { caseId: item.id, steps: content.steps, expected: content.expected, route: route.success ? route.data : undefined, ...(reason ? { unautomatable: reason } : {}) } };
}

export async function generateSpecs(run: Run, target: Target): Promise<void> {
  if (run.status !== "ready_specs") throw new Error("Approved design must be ingested before spec generation");
  run.specs = [];
  await saveRun(run);
  const project = path.resolve(target.projectDir);
  for (const item of run.artifacts.filter((value) => value.kind === "TestCase")) {
    const story = run.stories.find((value) => value.id === item.storyId);
    if (!story) throw new Error(`Test Case ${item.id} has no Story`);
    const rendered = renderSpec(item, target, story.text);
    const relative = `tests/generated/${safeName(item.id)}.spec.ts`;
    const file = path.join(project, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, rendered.code);
    await fs.mkdir(path.join(runPath(run.id), "test-ir"), { recursive: true });
    await fs.writeFile(path.join(runPath(run.id), "test-ir", `${safeName(item.id)}.json`), JSON.stringify(rendered.ir, null, 2));
    run.specs.push({ caseId: item.id, storyId: item.storyId, file: relative, status: rendered.status, reason: rendered.reason });
  }
  run.status = "review_specs";
  await saveRun(run);
}
