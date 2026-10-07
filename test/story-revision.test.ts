import { setupTarget, statusModel } from "./spec-generation/platform-helper.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { newRun, runPath, hash, type Artifact, type Story, type StoryPipelineRecord } from "../src/core/runtime.js";
import type { GraphStore, ModelClient, SprintWorkItemClient } from "../src/contracts.js";
import { assessTestImpact } from "../src/stages/test-impact.js";
import { applyStoryTestReview, createTestReview, parseTestReviewComment, stageStoryTestReview } from "../src/stages/story-test-review.js";
import { StoryPipeline } from "../src/story-pipeline.js";
import { Ado } from "../src/adapters/ado.js";

const story: Story = { id: "ST-1", adoId: 1, title: "Warehouse", text: "Warehouse creation now returns 202 Accepted.",
  areaPath: "QA", iterationPath: "QA\\Sprint" };

test("impact scans every managed suite and lets the model dismiss a text match", async () => {
  const cases = [
    { id: "TestCase:own", name: "Create warehouse", storyIds: ["ST-1"], content: { steps: [{ action: "Create warehouse", expectedResult: "HTTP 201" }] } },
    { id: "TestCase:other", name: "Warehouse report", storyIds: ["ST-2"], content: { steps: [{ action: "Read report", expectedResult: "Report exists" }] } },
  ];
  const graph = { managedTestCases: async () => cases.map((item) => ({ ...item, contentHash: hash(item.content) })) } as unknown as GraphStore;
  const seen: string[] = [];
  const model = { json: async (prompt: string) => {
    seen.push(prompt);
    if (prompt.includes("TestCase:other")) return { affected: false, confidence: 0.9, reason: "Report is unrelated", evidence: "", changes: [] };
    return { affected: true, confidence: 0.95, reason: "Status changed", evidence: "returns 202 Accepted",
      changes: [{ index: 0, expectedResult: "HTTP 202", expectedResultEvidence: "returns 202 Accepted" }] };
  } } as ModelClient;
  const result = await assessTestImpact(story, { ...story, text: "Warehouse creation returns 201." }, graph, model);
  assert.equal(result.checked, 2);
  assert.equal(seen.length, 2);
  assert.equal(result.revisions.length, 1);
  assert.equal(result.revisions[0]?.artifact.id, "TestCase:own");
  assert.equal(result.revisions[0]?.artifact.baseHash, hash(cases[0]?.content));
  assert.equal(result.revisions[0]?.artifact.content.steps?.[0]?.expectedResult, "HTTP 202");
  assert.equal(result.gaps.length, 0);
});

test("unsupported impact becomes an owned gap without changing its approved case", async () => {
  const content = { steps: [{ action: "Create warehouse", expectedResult: "HTTP 201" }] };
  const graph = { managedTestCases: async () => [{ id: "TestCase:other", name: "Dependent workflow", storyIds: ["ST-2"],
    content, contentHash: hash(content) }] } as unknown as GraphStore;
  const model = { json: async () => ({ affected: true, confidence: 0.7, reason: "Possibly changed", evidence: "returns 202 Accepted",
    changes: [{ index: 0, expectedResult: "HTTP 202", expectedResultEvidence: "unsupported statement" }] }) } as ModelClient;
  const result = await assessTestImpact(story, { ...story, text: "Warehouse creation returns 201." }, graph, model);
  assert.equal(result.revisions.length, 0);
  assert.equal(result.gaps[0]?.storyId, "ST-2");
  assert.equal(result.gaps[0]?.caseId, "TestCase:other");
  assert.equal(content.steps[0]?.expectedResult, "HTTP 201");
});

test("an explicit downstream case is reconsidered after its dependency is confirmed", async () => {
  const base = { steps: [{ action: "Create warehouse", expectedResult: "HTTP 201" }] };
  const dependent = { steps: [{ action: "Use Create warehouse result", expectedResult: "Workflow completes" }] };
  const graph = { managedTestCases: async () => [
    { id: "TestCase:downstream", name: "Workflow", storyIds: ["ST-2"], dependsOnCaseIds: ["TestCase:own"], content: dependent, contentHash: hash(dependent) },
    { id: "TestCase:own", name: "Create warehouse", storyIds: ["ST-1"], content: base, contentHash: hash(base) },
  ] } as unknown as GraphStore;
  const model = { json: async (prompt: string) => {
    if (prompt.includes('"id":"TestCase:downstream"')) return { affected: true, confidence: 0.8, reason: "Reuses creation",
      evidence: "returns 202 Accepted", dependsOnCaseIds: ["TestCase:own"],
      changes: [{ index: 0, expectedResult: "Workflow accepts 202", expectedResultEvidence: "returns 202 Accepted" }] };
    return { affected: true, confidence: 0.9, reason: "Status changed", evidence: "returns 202 Accepted",
      changes: [{ index: 0, expectedResult: "HTTP 202", expectedResultEvidence: "returns 202 Accepted" }] };
  } } as ModelClient;
  const result = await assessTestImpact(story, { ...story, text: "Warehouse creation returns 201." }, graph, model);
  assert.deepEqual(result.revisions.map((item) => item.artifact.id), ["TestCase:own", "TestCase:downstream"]);
  assert.deepEqual(result.revisions[1]?.artifact.content.dependsOnCaseIds, ["TestCase:own"]);
  assert.equal(result.revisions[1]?.artifact.storyId, "ST-2");
});

test("a step-text dependency is confirmed transitively even when first inspected too early", async () => {
  const graph = { managedTestCases: async () => [
    { id: "TestCase:last", name: "Shipment", storyIds: ["ST-3"], content: { steps: [{ action: "Use Workflow result", expectedResult: "Shipped" }] }, contentHash: "last" },
    { id: "TestCase:middle", name: "Workflow", storyIds: ["ST-2"], content: { steps: [{ action: "Use Create warehouse result", expectedResult: "Ready" }] }, contentHash: "middle" },
    { id: "TestCase:first", name: "Create warehouse", storyIds: ["ST-1"], content: { steps: [{ action: "Create warehouse", expectedResult: "201" }] }, contentHash: "first" },
  ] } as unknown as GraphStore;
  let lastChecked = 0;
  const model = { json: async (prompt: string) => {
    if (prompt.includes('"id":"TestCase:last"')) {
      lastChecked += 1;
      if (!prompt.includes('Already affected cases: ["TestCase:first","TestCase:middle"]')) return {
        affected: false, confidence: 0.8, reason: "Dependency not confirmed yet", evidence: "", changes: [] };
    }
    return { affected: true, confidence: 0.8, reason: "Confirmed dependent step", evidence: "returns 202 Accepted",
      dependsOnCaseIds: prompt.includes('"id":"TestCase:last"') ? ["TestCase:middle"]
        : prompt.includes('"id":"TestCase:middle"') ? ["TestCase:first"] : [],
      changes: [{ index: 0, expectedResult: "Uses 202", expectedResultEvidence: "returns 202 Accepted" }] };
  } } as ModelClient;
  const result = await assessTestImpact(story, { ...story, text: "Returns 201" }, graph, model);
  assert.equal(lastChecked, 2);
  assert.deepEqual(result.revisions.map((item) => item.artifact.id), ["TestCase:first", "TestCase:middle", "TestCase:last"]);
  assert.equal(result.revisions[2]?.artifact.storyId, "ST-3");
});

test("one Task reviews several items independently and ignores stale or AI comments", async () => {
  const run = await newRun();
  try {
    run.stories = [story];
    const first: Artifact = { id: "TestCase:first", kind: "TestCase", name: "First", storyId: story.id,
      content: { evidence: "returns 202 Accepted", steps: [{ action: "Create warehouse", expectedResult: "HTTP 202", expectedResultEvidence: "returns 202 Accepted" }] }, hash: "" };
    const second: Artifact = { ...first, id: "TestCase:second", name: "Second", content: { ...first.content } };
    run.artifacts = [first, second];
    createTestReview(run, hash(story.text), [], [{ id: "Gap:one", name: "Missing oracle", confidence: 0.4,
      reason: "No source oracle", evidence: "", caseId: "TestCase:missing" }]);
    const ids: number[] = [];
    const comments: Array<{ text: string; reviewer: string; at: string }> = [];
    const work = { testReviewTask: async () => { ids.push(55); return 55; }, testReviewComments: async () => comments,
      closeTestReviewTask: async () => { ids.push(99); } } as unknown as SprintWorkItemClient;
    const activated: string[] = [];
    const graph = { artifact: async (artifact: Artifact) => { activated.push(artifact.id); },
      markCaseOutdated: async (id: string) => { activated.push(`outdated:${id}`); } } as unknown as GraphStore;
    await stageStoryTestReview(run, work);
    assert.equal(ids.length, 1);
    assert.equal(run.testReview?.items.length, 3);
    await fs.access(`${runPath(run.id)}/test-review.json`);
    await fs.access(`${runPath(run.id)}/test-review.xlsx`);
    const [one, two, gap] = run.testReview!.items;
    comments.push({ text: `Item-ID: ${one!.id}\nReview-Hash: old\nDecision: approve`, reviewer: "Ada", at: "2026-10-01T00:00:00Z" });
    comments.push({ text: `AI review\nItem-ID: ${two!.id}\nReview-Hash: ${two!.hash}\nDecision: approve`, reviewer: "AI", at: "2026-10-01T00:01:00Z" });
    comments.push({ text: `Item-ID: ${one!.id}\nReview-Hash: ${one!.hash}\nDecision: approve`, reviewer: "Ada", at: "2026-10-01T00:02:00Z" });
    comments.push({ text: `Item-ID: ${two!.id}\nReview-Hash: ${two!.hash}\nDecision: reject\nReason: Unsupported`, reviewer: "Ben", at: "2026-10-01T00:03:00Z" });
    comments.push({ text: `Item-ID: ${gap!.id}\nReview-Hash: ${gap!.hash}\nDecision: approve`, reviewer: "Ada", at: "2026-10-01T00:04:00Z" });
    const result = await applyStoryTestReview(run, work, graph, { json: async () => ({}) } as ModelClient);
    assert.deepEqual(result, { pending: 0, approved: 1, rejected: 1, manualFix: 1 });
    assert.deepEqual(activated, ["TestCase:first", "outdated:TestCase:missing"]);
    assert.deepEqual(ids, [55, 99]);
    assert.equal((await applyStoryTestReview(run, work, graph, { json: async () => ({}) } as ModelClient)).approved, 1);
    assert.deepEqual(activated, ["TestCase:first", "outdated:TestCase:missing"]);
  } finally {
    await fs.rm(runPath(run.id), { recursive: true, force: true });
  }
});

test("comment parser requires item, current hash, identified human, and correction detail", () => {
  assert.equal(parseTestReviewComment("Decision: approve", "Ada", "now"), null);
  assert.equal(parseTestReviewComment("Item-ID: x\nReview-Hash: h\nDecision: approve", "", "now"), null);
  assert.equal(parseTestReviewComment("AI review\nItem-ID: x\nReview-Hash: h\nDecision: approve", "AI", "now"), null);
  assert.equal(parseTestReviewComment("Item-ID: x\nReview-Hash: h\nDecision: correct\nReason: Wrong", "Ada", "now"), null);
  assert.equal(parseTestReviewComment("Item-ID: x\nReview-Hash: h\nDecision: correct\nReason: Wrong\nCorrection: Use 202", "Ada", "now")?.action, "correct");
});

test("human gap correction activates a grounded patch against the exact base case", async () => {
  const run = await newRun();
  try {
    run.stories = [story];
    createTestReview(run, hash(story.text), [], [{ id: "Gap:case", name: "Create warehouse", confidence: 0.6,
      reason: "New status needs a safe update", evidence: "returns 202 Accepted", caseId: "TestCase:own" }]);
    run.testReview!.taskId = 7;
    const item = run.testReview!.items[0]!;
    const comment = { text: `Item-ID: ${item.id}\nReview-Hash: ${item.hash}\nDecision: correct\nReason: Status changed\nCorrection: Expect HTTP 202`,
      reviewer: "Ada", at: "2026-10-01T01:00:00Z" };
    const work = { testReviewComments: async () => [comment], closeTestReviewTask: async () => {} } as unknown as SprintWorkItemClient;
    const old = { steps: [{ action: "Create warehouse", expectedResult: "HTTP 201", expectedResultEvidence: "returns 201" }] };
    const calls: Array<{ artifact: Artifact; base: string }> = [];
    const graph = { managedTestCases: async () => [{ id: "TestCase:own", name: "Create warehouse", storyIds: [story.id],
      content: old, contentHash: hash(old) }], activateCaseRevision: async (artifact: Artifact, base: string) => { calls.push({ artifact, base }); } } as unknown as GraphStore;
    const model = { json: async (prompt: string) => prompt.startsWith("Check whether") ? { valid: true, reason: "Follows the correction" }
      : { evidence: "returns 202 Accepted", reason: "Status changed",
        changes: [{ index: 0, expectedResult: "HTTP 202", expectedResultEvidence: "returns 202 Accepted" }] } } as ModelClient;
    const result = await applyStoryTestReview(run, work, graph, model);
    assert.equal(result.approved, 1);
    assert.equal(calls[0]?.base, hash(old));
    assert.equal((calls[0]?.artifact.content.steps as Array<{ expectedResult: string }>)[0]?.expectedResult, "HTTP 202");
    assert.equal(old.steps[0]?.expectedResult, "HTTP 201");
  } finally {
    await fs.rm(runPath(run.id), { recursive: true, force: true });
  }
});

test("an unsupported human correction remains pending with a specific error", async () => {
  const run = await newRun();
  try {
    run.stories = [story];
    const old = { steps: [{ action: "Create warehouse", expectedResult: "HTTP 201" }] };
    const artifact: Artifact = { id: "TestCase:own", kind: "TestCase", name: "Create warehouse", storyId: story.id,
      content: old, hash: hash(old), baseHash: hash(old) };
    run.artifacts = [artifact];
    createTestReview(run, hash(story.text), [{ artifact, confidence: 0.8, reason: "Status changed", evidence: "returns 202 Accepted" }]);
    run.testReview!.taskId = 8;
    const item = run.testReview!.items[0]!;
    const work = { testReviewComments: async () => [{ text: `Item-ID: ${item.id}\nReview-Hash: ${item.hash}\nDecision: correct\nReason: Update status\nCorrection: Expect HTTP 202`,
      reviewer: "Ada", at: "2026-10-01T01:00:00Z" }] } as unknown as SprintWorkItemClient;
    let writes = 0;
    const graph = { activateCaseRevision: async () => { writes += 1; } } as unknown as GraphStore;
    const model = { json: async () => ({ content: { ...old, route: { method: "DELETE", path: "/warehouses", expectedStatus: 202 } }, reason: "changed" }) } as ModelClient;
    const result = await applyStoryTestReview(run, work, graph, model);
    assert.equal(result.pending, 1);
    assert.match(item.note ?? "", /schema|protected field/);
    assert.equal(writes, 0);
  } finally {
    await fs.rm(runPath(run.id), { recursive: true, force: true });
  }
});

test("the latest valid human comment wins and a stale case base stays pending", async () => {
  const run = await newRun();
  try {
    run.stories = [story];
    const original = { steps: [{ action: "Create warehouse", expectedResult: "201" }] };
    const artifact: Artifact = { id: "TestCase:own", kind: "TestCase", name: "Create warehouse", storyId: story.id,
      content: { steps: [{ action: "Create warehouse", expectedResult: "202" }] }, hash: "", baseHash: hash(original), beforeContent: original };
    run.artifacts = [artifact];
    createTestReview(run, hash(story.text), [{ artifact, confidence: 0.9, reason: "Changed", evidence: "returns 202 Accepted" }]);
    run.testReview!.taskId = 5;
    const item = run.testReview!.items[0]!;
    const comments = [
      { text: `Item-ID: ${item.id}\nReview-Hash: ${item.hash}\nDecision: reject\nReason: Old decision`, reviewer: "Ada", at: "2026-10-01T00:00:00Z" },
      { text: `Item-ID: ${item.id}\nReview-Hash: ${item.hash}\nDecision: approve`, reviewer: "Ada", at: "2026-10-01T00:01:00Z" },
    ];
    const work = { testReviewComments: async () => comments } as unknown as SprintWorkItemClient;
    let attempts = 0;
    const graph = { activateCaseRevision: async () => { attempts += 1; throw new Error("Test case changed since proposal"); } } as unknown as GraphStore;
    const result = await applyStoryTestReview(run, work, graph, { json: async () => ({}) } as ModelClient);
    assert.equal(attempts, 1);
    assert.equal(result.pending, 1);
    assert.equal(item.reviewer, undefined);
    assert.match(item.note ?? "", /changed since proposal/);
    assert.equal(artifact.approvedAt, undefined);
  } finally {
    await fs.rm(runPath(run.id), { recursive: true, force: true });
  }
});

test("an approved case gets its own spec batch while another item remains pending", async () => {
  const run = await newRun();
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "qa-review-batch-"));
  try {
    run.stories = [story];
    run.status = "review_artifacts";
    run.artifacts = ["first", "second"].map((name) => ({ id: `TestCase:${name}`, kind: "TestCase" as const,
      name, storyId: story.id, content: { evidence: "returns 202 Accepted", expected: "HTTP 202",
        route: { method: "GET", path: "/warehouses", expectedStatus: 202 }, steps: [{ action: "Get warehouses", expectedResult: "HTTP 202",
          expectedResultEvidence: "returns 202 Accepted" }] }, hash: "" }));
    createTestReview(run, hash(story.text));
    const first = run.testReview!.items[0]!;
    const record: StoryPipelineRecord = { version: 4, adoId: story.adoId, revision: 1, iterationPath: story.iterationPath,
      story, stage: "review_artifacts", status: "active", run, reviewMode: "story", updatedAt: new Date().toISOString() };
    const graph = { storyContext: async () => "{}", storyPipeline: async () => record, saveStoryPipeline: async () => {},
      artifact: async () => {} } as unknown as GraphStore;
    const work = { testReviewTask: async () => 12, testReviewComments: async () => [{ text: `Item-ID: ${first.id}\nReview-Hash: ${first.hash}\nDecision: approve`,
      reviewer: "Ada", at: "2026-10-01T02:00:00Z" }] } as unknown as SprintWorkItemClient;
    await setupTarget(temporary);
    const targetFile = path.join(temporary, "target.json");
    await fs.writeFile(targetFile, JSON.stringify({ projectDir: temporary, baseUrl: "https://example.test",
      safeEnvironments: ["https://example.test"], routes: [{ method: "GET", path: "/warehouses", responses: [202] }] }));
    const pipeline = new StoryPipeline(graph, () => ({ json: async () => ({}) } as ModelClient), work, undefined, undefined, undefined, () => statusModel);
    const result = await pipeline.advanceStory(1, targetFile);
    assert.equal(result.action, "specs_generated");
    assert.equal(result.batch, 1);
    assert.deepEqual(run.specBatches?.[0]?.caseIds, ["TestCase:first"]);
    assert.equal(run.testReview?.items[1]?.status, "pending");
    await fs.access(path.join(temporary, run.specs[0].file));
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
    await fs.rm(runPath(run.id), { recursive: true, force: true });
  }
});

test("ADO creates one Story child Task containing all review items and their hashes", async () => {
  const previous = { org: process.env.ADO_ORG_URL, project: process.env.ADO_PROJECT, pat: process.env.ADO_PAT };
  process.env.ADO_ORG_URL = "https://dev.azure.com/example";
  process.env.ADO_PROJECT = "QA";
  process.env.ADO_PAT = "test-token";
  let createCount = 0;
  let description = "";
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes("wiql?") && init?.method === "POST") return new Response(JSON.stringify({ workItems: [] }));
    if (url.includes("workitems/$Task?") && init?.method === "POST") {
      createCount += 1;
      const changes = JSON.parse(String(init.body)) as Array<{ path: string; value: unknown }>;
      description = String(changes.find((change) => change.path === "/fields/System.Description")?.value);
      assert.ok(changes.some((change) => change.path === "/relations/-" && JSON.stringify(change.value).includes("/1")));
      return new Response(JSON.stringify({ id: 77 }));
    }
    throw new Error(`Unexpected ADO request ${url}`);
  };
  try {
    const review = { sourceHash: "source", items: ["first", "second"].map((id) => ({ id: `TestCase:${id}`,
      kind: "TestCase" as const, name: id, hash: `${id}-hash`, confidence: 0.9, reviewReason: "Changed",
      evidence: "returns 202 Accepted", status: "pending" as const })) };
    const taskId = await new Ado(fetcher as typeof fetch).testReviewTask("run-one", review, story);
    assert.equal(taskId, 77);
    assert.equal(createCount, 1);
    assert.match(description, /TestCase:first/);
    assert.match(description, /TestCase:second/);
    assert.match(description, /first-hash/);
    assert.match(description, /Confidence: 0.9/);
  } finally {
    if (previous.org === undefined) delete process.env.ADO_ORG_URL; else process.env.ADO_ORG_URL = previous.org;
    if (previous.project === undefined) delete process.env.ADO_PROJECT; else process.env.ADO_PROJECT = previous.project;
    if (previous.pat === undefined) delete process.env.ADO_PAT; else process.env.ADO_PAT = previous.pat;
  }
});

test("sprint discovery treats a Feature edit as a source revision and preserves unchanged legacy runs", async () => {
  const oldStory = { ...story, text: "Original Story", parents: [{ id: "FE-1", adoId: 2, revision: 1,
    kind: "Feature" as const, title: "Feature", text: "Original Feature" }] };
  const updated = { ...oldStory, parents: [{ ...oldStory.parents[0]!, revision: 2, text: "Revised Feature" }] };
  const saved: StoryPipelineRecord = { version: 3, adoId: 1, revision: 1, iterationPath: story.iterationPath,
    story: oldStory, stage: "review_artifacts", status: "active", updatedAt: "before" };
  const graph = { setup: async () => {}, node: async () => {}, hierarchy: async () => {}, plannedFor: async () => {},
    storyPipeline: async () => saved, saveStoryPipeline: async (record: StoryPipelineRecord) => { Object.assign(saved, record); },
    pendingImpactStories: async () => [] } as unknown as GraphStore;
  const work = { sprintStories: async () => [oldStory] } as unknown as SprintWorkItemClient;
  const pipeline = new StoryPipeline(graph, () => ({ json: async () => ({}) } as ModelClient), work, undefined, undefined, undefined, () => statusModel);
  await pipeline.pollSprint(story.iterationPath);
  assert.equal(saved.stage, "review_artifacts");
  assert.equal(saved.reviewMode, undefined);
  const changed = new StoryPipeline(graph, () => ({ json: async () => ({}) } as ModelClient),
    { sprintStories: async () => [updated] } as unknown as SprintWorkItemClient);
  await changed.pollSprint(story.iterationPath);
  assert.equal(saved.stage, "discovered");
  assert.equal(saved.reviewMode, "story");
  assert.equal(saved.previousStory?.parents?.[0]?.text, "Original Feature");
});
