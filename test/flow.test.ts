import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Ado } from "../src/adapters/ado.js";
import { hash, runPath, type Run, type StoryPipelineRecord } from "../src/core/runtime.js";
import type { GraphStore, ModelClient, SprintWorkItemClient } from "../src/contracts.js";
import { applyReviews, consensus, parseDecision, validRelation } from "../src/stages/review.js";
import { approveArtifact, design, generateSpecs, ingest, ingestDesign, renderSpec, type Target } from "../src/stages/workflow.js";
import { verifySpecs } from "../src/stages/execution.js";
import { QaPipeline } from "../src/pipeline.js";
import { StoryPipeline } from "../src/story-pipeline.js";

test("structured ADO decisions require the current hash and a valid correction", () => {
  const approved = parseDecision("<p>Review-Hash: abc</p><p>Decision: approve</p>", "abc", "Ada", 17);
  assert.equal(approved?.action, "approve");
  assert.equal(parseDecision("Review-Hash: old\nDecision: approve", "abc", "Ada", 17), null);
  assert.equal(parseDecision("Review-Hash: abc\nDecision: reject", "abc", "Ada", 17), null);
  assert.equal(parseDecision("Review-Hash: abc\nDecision: correct\nType: USES\nDirection: reverse\nReason: direction", "abc", "Ada", 17)?.reverse, true);
  assert.equal(validRelation("IMPLEMENTS", "Endpoint", "BusinessRule"), true);
  assert.equal(validRelation("IMPLEMENTS", "BusinessRule", "Endpoint"), false);
  assert.equal(consensus([{ ...approved!, reviewer: "Ada" }, { ...approved!, reviewer: "Ben" }])?.action, "approve");
  assert.equal(consensus([approved!, { ...approved!, action: "reject", reason: "wrong" }]), null);
});

test("ungrounded or authenticated cases become fixme specs", () => {
  const item = { id: "TestCase:one", kind: "TestCase" as const, name: "Get warehouses", storyId: "ST-1", content: { route: { method: "GET", path: "/warehouses", expectedStatus: 200 }, expected: "HTTP 200", steps: ["GET"] }, hash: "hash" };
  const target: Target = { projectDir: ".", baseUrl: "http://localhost:3000", safeEnvironments: ["http://localhost:3000"], routes: [{ method: "GET", path: "/warehouses", responses: [200] }] };
  assert.equal(renderSpec(item, target).status, "generated");
  assert.match(renderSpec(item, target).code, /expect\(response.status\(\)\).toBe\(200\)/);
  assert.equal(renderSpec(item, { ...target, routes: [] }).status, "fixme");
  assert.match(renderSpec(item, { ...target, routes: [{ ...target.routes[0]!, requiresAuth: true }] }).reason!, /auth.unavailable/);
  assert.equal(renderSpec({ ...item, content: { ...item.content, expected: "HTTP 200 and a list" } }, target).status, "fixme");
});

test("the CI pipeline coordinates injected integrations and closes the graph", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "qa-pipeline-"));
  await fs.writeFile(path.join(temporary, "story.json"), JSON.stringify({
    id: 41,
    code: "ST-1",
    fields: {
      "System.WorkItemType": "User Story",
      "System.Title": "Story",
      "System.Description": "Known behavior.",
    },
  }));
  let closed = 0;
  const pipeline = new QaPipeline({
    graph: () => ({
      setup: async () => {},
      node: async () => {},
      hierarchy: async () => {},
      propose: async () => {},
      decide: async () => {},
      storyContext: async () => "{}",
      artifact: async () => {},
      spec: async () => {},
      testRun: async () => {},
      storyPipeline: async () => null,
      saveStoryPipeline: async () => {},
      close: async () => { closed += 1; },
    }),
    model: () => ({ json: async () => ({ relationships: [] }) }),
    workItems: () => ({ task: async () => ({ id: 1, hash: "hash" }), decision: async () => null }),
  });
  let run: Run | undefined;
  try {
    run = await pipeline.ingest(temporary);
    assert.equal(run.status, "ready_design");
    assert.equal((await pipeline.status(run.id)).stories, 1);
    assert.equal(closed, 1);
  } finally {
    if (run) await fs.rm(runPath(run.id), { recursive: true, force: true });
    if (temporary.startsWith(path.resolve(os.tmpdir()) + path.sep)) await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("sprint polling advances one Story without blocking another", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "qa-story-pipeline-"));
  const targetProject = path.join(temporary, "automation");
  const targetFile = path.join(temporary, "target.json");
  await fs.mkdir(targetProject);
  await fs.writeFile(targetFile, JSON.stringify({ projectDir: targetProject, baseUrl: "http://localhost:3000", safeEnvironments: ["http://localhost:3000"], routes: [{ method: "GET", path: "/warehouses", responses: [200] }] }));
  const records = new Map<number, StoryPipelineRecord>();
  const hierarchy: string[] = [];
  const graph = {
    setup: async () => {}, node: async () => {}, hierarchy: async (parentId: string, childId: string) => { hierarchy.push(`${parentId}->${childId}`); }, propose: async () => {}, decide: async () => {}, storyContext: async () => "{}",
    artifact: async () => {}, spec: async () => {}, testRun: async () => {},
    storyPipeline: async (adoId: number) => records.get(adoId) ?? null,
    saveStoryPipeline: async (record: StoryPipelineRecord) => { records.set(record.adoId, structuredClone(record)); },
  } as GraphStore;
  const stories = [
    { id: "ST-1", adoId: 1, revision: 3, title: "One", text: "GET /warehouses returns 200.", areaPath: "QA", iterationPath: "QA\\Sprint 1", parents: [
      { id: "FT-1", adoId: 10, revision: 2, kind: "Feature" as const, title: "Feature", text: "Feature details" },
      { id: "EP", adoId: 20, revision: 1, kind: "Epic" as const, title: "Epic", text: "Epic details" },
    ] },
    { id: "ST-2", adoId: 2, revision: 4, title: "Two", text: "Other behavior.", areaPath: "QA", iterationPath: "QA\\Sprint 1" },
  ];
  const workItems = {
    sprintStories: async () => stories,
    task: async () => ({ id: 1, hash: "relation" }),
    decision: async () => null,
    artifactTask: async (_runId: string, artifact: { id: string }) => ({ id: artifact.id.length, hash: `hash-${artifact.id}` }),
    artifactDecision: async (taskId: number, expectedHash: string) => ({ action: "approve" as const, reviewer: "Ada", taskId, at: "2026-01-01", reason: expectedHash }),
    publishResult: async () => {},
  } as SprintWorkItemClient;
  const model = { json: async (prompt: string) => prompt.startsWith("Extract")
    ? { relationships: [] }
    : { scenarios: [{ name: "List", evidence: "GET /warehouses returns 200.", cases: [{ name: "Returns 200", steps: ["GET"], expected: "HTTP 200", route: { method: "GET", path: "/warehouses", expectedStatus: 200 } }] }] },
  } as ModelClient;
  const pipeline = new StoryPipeline(graph, () => model, workItems);
  let runId: string | undefined;
  try {
    assert.deepEqual((await pipeline.pollSprint("QA\\Sprint 1")).map((item) => item.adoId), [1, 2]);
    const first = await pipeline.advanceStory(1, targetFile);
    runId = first.runId;
    assert.equal(first.action, "test_review");
    assert.deepEqual(hierarchy, ["FT-1->ST-1", "EP->FT-1"]);
    assert.equal(records.get(1)?.stage, "review_artifacts");
    assert.equal(records.get(2)?.stage, "discovered");
    const generated = await pipeline.advanceStory(1, targetFile);
    assert.equal(generated.action, "specs_generated");
    assert.equal(records.get(1)?.stage, "review_specs");
    assert.equal(records.get(2)?.stage, "discovered");
  } finally {
    if (runId) await fs.rm(runPath(runId), { recursive: true, force: true });
    if (temporary.startsWith(path.resolve(os.tmpdir()) + path.sep)) await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("ADO sprint discovery loads each Story's Feature and Epic parents", async () => {
  const previous = { org: process.env.ADO_ORG_URL, project: process.env.ADO_PROJECT, pat: process.env.ADO_PAT };
  process.env.ADO_ORG_URL = "https://dev.azure.com/example";
  process.env.ADO_PROJECT = "QA";
  process.env.ADO_PAT = "test-token";
  const calls: string[] = [];
  const parentUrl = (id: number) => `https://dev.azure.com/example/_apis/wit/workItems/${id}`;
  const fetcher = async (url: string): Promise<Response> => {
    calls.push(url);
    let value: unknown;
    if (url.includes("wiql?")) value = { workItems: [{ id: 41 }, { id: 42 }] };
    else if (url.includes("workitems/41?")) value = { id: 41, rev: 3, fields: { "System.WorkItemType": "User Story", "System.Title": "ST-1 First", "System.Description": "First", "System.AreaPath": "QA", "System.IterationPath": "QA\\Sprint 1" }, relations: [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: parentUrl(10) }] };
    else if (url.includes("workitems/42?")) value = { id: 42, rev: 4, fields: { "System.WorkItemType": "User Story", "System.Title": "ST-2 Second", "System.Description": "Second", "System.AreaPath": "QA", "System.IterationPath": "QA\\Sprint 1" }, relations: [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: parentUrl(10) }] };
    else if (url.includes("workitems/10?")) value = { id: 10, rev: 2, fields: { "System.WorkItemType": "Feature", "System.Title": "FT-1 Feature", "System.Description": "Feature details" }, relations: [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: parentUrl(2) }] };
    else if (url.includes("workitems/2?")) value = { id: 2, rev: 1, fields: { "System.WorkItemType": "Epic", "System.Title": "EPIC QA Quality", "System.Description": "Epic details" }, relations: [] };
    else throw new Error(`Unexpected ADO URL: ${url}`);
    return new Response(JSON.stringify(value), { status: 200 });
  };
  try {
    const stories = await new Ado(fetcher as typeof fetch).sprintStories("QA\\Sprint 1");
    assert.deepEqual(stories[0]?.parents?.map((item) => [item.kind, item.id]), [["Feature", "FT-1"], ["Epic", "QA"]]);
    assert.deepEqual(stories[1]?.parents?.map((item) => [item.kind, item.id]), [["Feature", "FT-1"], ["Epic", "QA"]]);
    assert.equal(calls.filter((url) => url.includes("workitems/10?")).length, 1);
    assert.equal(calls.filter((url) => url.includes("workitems/2?")).length, 1);
  } finally {
    if (previous.org === undefined) delete process.env.ADO_ORG_URL; else process.env.ADO_ORG_URL = previous.org;
    if (previous.project === undefined) delete process.env.ADO_PROJECT; else process.env.ADO_PROJECT = previous.project;
    if (previous.pat === undefined) delete process.env.ADO_PAT; else process.env.ADO_PAT = previous.pat;
  }
});

test("ADO retry reuses the Story child Task and copies its paths", async () => {
  const previous = { org: process.env.ADO_ORG_URL, project: process.env.ADO_PROJECT, pat: process.env.ADO_PAT };
  process.env.ADO_ORG_URL = "https://dev.azure.com/example";
  process.env.ADO_PROJECT = "QA";
  process.env.ADO_PAT = "test-token";
  const calls: Array<{ url: string; body?: unknown }> = [];
  let created = false;
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
    calls.push({ url, body });
    let value: unknown;
    if (url.includes("workitems/41?")) value = { fields: { "System.AreaPath": "QA\\Backend", "System.IterationPath": "QA\\Sprint 1" } };
    else if (url.includes("wiql?")) value = { workItems: created ? [{ id: 88 }] : [] };
    else if (url.includes("workitems/88?")) value = { fields: { "System.Description": hash({ id: "edge", type: "AFFECTS", evidence: "evidence", confidence: 0.8, reason: "review" }) }, relations: [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://dev.azure.com/example/_apis/wit/workItems/41" }] };
    else if (url.includes("workitems/$Task?")) { created = true; value = { id: 88 }; }
    else throw new Error(`Unexpected ADO URL: ${url}`);
    return new Response(JSON.stringify(value), { status: 200 });
  };
  try {
    const ado = new Ado(fetcher as typeof fetch);
    const story = { id: "ST-1", adoId: 41, title: "Story", text: "evidence", areaPath: "", iterationPath: "" };
    const relation = { id: "edge", sourceId: "ST-1", sourceType: "Story", targetId: "Endpoint:one", targetType: "Endpoint", type: "AFFECTS", evidence: "evidence", confidence: 0.8, reason: "review", source: "ST-1", storyIds: ["ST-1"], state: "needs_review", tasks: {}, decisions: [] } as const;
    const runId = randomUUID();
    assert.equal((await ado.task(runId, relation as never, story)).id, 88);
    assert.equal((await ado.task(runId, relation as never, story)).id, 88);
    const createdTask = calls.filter((call) => call.url.includes("workitems/$Task?"));
    assert.equal(createdTask.length, 1);
    const operations = createdTask[0]!.body as Array<{ path: string; value: unknown }>;
    assert.equal(operations.find((op) => op.path === "/fields/System.AreaPath")?.value, "QA\\Backend");
    assert.equal(operations.find((op) => op.path === "/fields/System.IterationPath")?.value, "QA\\Sprint 1");
    assert.match(String((operations.find((op) => op.path === "/relations/-")?.value as { url: string }).url), /workItems\/41$/);
  } finally {
    if (previous.org === undefined) delete process.env.ADO_ORG_URL; else process.env.ADO_ORG_URL = previous.org;
    if (previous.project === undefined) delete process.env.ADO_PROJECT; else process.env.ADO_PROJECT = previous.project;
    if (previous.pat === undefined) delete process.env.ADO_PAT; else process.env.ADO_PAT = previous.pat;
  }
});

test("conflicting Story votes and invalid corrections stay pending", async () => {
  const run: Run = {
    id: randomUUID(), status: "review_relations", stories: [], artifacts: [], specs: [], errors: [], createdAt: "2026-01-01",
    relations: [{ id: "edge", sourceId: "ST-1", sourceType: "Story", targetId: "Endpoint:one", targetType: "Endpoint", type: "AFFECTS", evidence: "evidence", confidence: 0.8, reason: "review", source: "ST-1", storyIds: ["ST-1", "ST-2"], state: "needs_review", tasks: { "ST-1": { id: 1, hash: "h" }, "ST-2": { id: 2, hash: "h" } }, decisions: [] }],
  };
  const decisions = new Map<number, { action: "approve" | "reject" | "correct"; reviewer: string; taskId: number; at: string; reason?: string; type?: string; reverse?: boolean }>([
    [1, { action: "approve", reviewer: "Ada", taskId: 1, at: "now" }],
    [2, { action: "reject", reviewer: "Ben", reason: "wrong", taskId: 2, at: "now" }],
  ]);
  let writes = 0;
  const graph = { decide: async () => { writes += 1; } } as unknown as GraphStore;
  const ado = { decision: async (id: number) => decisions.get(id) } as Ado;
  try {
    assert.equal((await applyReviews(run, ado, graph)).conflicts, 1);
    assert.equal(writes, 0);
    decisions.set(1, { action: "correct", reviewer: "Ada", reason: "direction", type: "IMPLEMENTS", reverse: false, taskId: 1, at: "now" });
    decisions.set(2, { action: "correct", reviewer: "Ben", reason: "direction", type: "IMPLEMENTS", reverse: false, taskId: 2, at: "now" });
    assert.equal((await applyReviews(run, ado, graph)).conflicts, 1);
    assert.equal(writes, 0);
    assert.equal(run.relations[0]?.state, "needs_review");
  } finally {
    await fs.rm(runPath(run.id), { recursive: true, force: true });
  }
});

test("a document without a Story mapping pauses before creating review Tasks", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "qa-mapping-"));
  await fs.writeFile(path.join(temporary, "story.json"), JSON.stringify({ id: 41, code: "ST-1", fields: { "System.WorkItemType": "User Story", "System.Title": "Story", "System.Description": "Known behavior." } }));
  await fs.writeFile(path.join(temporary, "notes.md"), "A note with no work item reference.");
  let tasks = 0;
  const graph = { setup: async () => {}, node: async () => {} } as unknown as GraphStore;
  const model = { json: async () => ({ relationships: [] }) } as ModelClient;
  const ado = { task: async () => { tasks += 1; } } as unknown as Ado;
  let run: Run | undefined;
  try {
    run = await ingest(temporary, graph, model, ado);
    assert.equal(run.status, "mapping_error");
    assert.match(run.errors[0]!, /No Story mapping/);
    assert.equal(tasks, 0);
  } finally {
    if (run) await fs.rm(runPath(run.id), { recursive: true, force: true });
    if (temporary.startsWith(path.resolve(os.tmpdir()) + path.sep)) await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("sanitized run gates relationships, artifacts, and each spec approval", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "qa-one-project-"));
  const input = path.join(temporary, "input");
  const project = path.join(temporary, "target");
  await fs.mkdir(input);
  await fs.writeFile(path.join(input, "story.json"), JSON.stringify({ id: 41, code: "ST-1", fields: {
    "System.WorkItemType": "User Story", "System.Title": "Get warehouses", "System.Description": "GET /warehouses returns 200.",
    "System.AreaPath": "QA\\Backend", "System.IterationPath": "QA\\Sprint 1",
  } }));
  const writes: string[] = [];
  const graph = {
    setup: async () => {}, node: async () => {}, propose: async () => { writes.push("proposal"); },
    decide: async () => { writes.push("decision"); }, storyContext: async () => "{\"links\":[]}",
    artifact: async (item: { id: string }) => { writes.push(item.id); },
  } as unknown as GraphStore;
  const model = { json: async (prompt: string) => prompt.startsWith("Extract")
    ? { relationships: [{ targetName: "GET /warehouses", targetType: "Endpoint", type: "AFFECTS", evidence: "GET /warehouses returns 200.", confidence: 0.8, reason: "LLM proposal" }] }
    : { scenarios: [{ name: "List warehouses", evidence: "GET /warehouses returns 200.", cases: [{ name: "Returns 200", steps: ["GET /warehouses"], expected: "HTTP 200", route: { method: "GET", path: "/warehouses", expectedStatus: 200 } }] }] },
  } as ModelClient;
  const ado = { task: async () => ({ id: 99, hash: "proposal-hash" }), decision: async () => ({ action: "approve", reviewer: "Ada", taskId: 99, at: "2026-01-01" }) } as Ado;
  let run: Run | undefined;
  try {
    run = await ingest(input, graph, model, ado);
    assert.equal(run.status, "review_relations");
    assert.equal(run.relations[0]?.tasks["ST-1"]?.id, 99);
    const reviewed = await applyReviews(run, ado, graph);
    assert.deepEqual(reviewed, { pending: 0, conflicts: 0, applied: 1 });
    await design(run, graph, model);
    assert.equal(run.artifacts.length, 4);
    await assert.rejects(ingestDesign(run, graph), /awaiting review/);
    for (const item of run.artifacts) await approveArtifact(run, item.id, "Ada");
    await ingestDesign(run, graph);
    assert.equal(run.status, "ready_specs");
    const target: Target = { projectDir: project, baseUrl: "http://localhost:3000", safeEnvironments: ["http://localhost:3000"], routes: [{ method: "GET", path: "/warehouses", responses: [200] }] };
    await generateSpecs(run, target);
    assert.equal(run.specs[0]?.status, "generated");
    const sha = "a".repeat(40);
    const fetcher = async (url: string): Promise<Response> => {
      let value: unknown = { head: { sha }, user: { login: "author" } };
      if (url.includes("/reviews?")) value = [{ state: "APPROVED", commit_id: sha, user: { login: "Ada" } }];
      if (url.includes("/comments?")) value = run!.specs.map((spec) => ({ path: spec.file, commit_id: sha, body: "Decision: approve", user: { login: "Ada" } }));
      return new Response(JSON.stringify(value), { status: 200 });
    };
    await verifySpecs(run, "team", "repo", 1, sha, "token", fetcher as typeof fetch);
    assert.ok(writes.includes("proposal"));
    assert.ok(writes.includes("decision"));
    assert.equal(writes.filter((value) => value.startsWith("Test")).length, 4);
  } finally {
    if (run) await fs.rm(runPath(run.id), { recursive: true, force: true });
    if (temporary.startsWith(path.resolve(os.tmpdir()) + path.sep)) await fs.rm(temporary, { recursive: true, force: true });
  }
});
