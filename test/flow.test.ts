import { setupTarget, statusModel } from "./spec-generation/platform-helper.js";
import { loadTarget } from "../src/stages/workflow.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Ado } from "../src/adapters/ado.js";
import { applyArtifactReviews } from "../src/stages/artifact-review.js";
import { hash, runPath, type Run, type StoryPipelineRecord } from "../src/core/runtime.js";
import type { GraphStore, ModelClient, SprintWorkItemClient, WorkItemClient } from "../src/contracts.js";
import { applyReviews, consensus, parseDecision, validRelation } from "../src/stages/review.js";
import { recommendPending, reviewRecommendation } from "../src/stages/reviewer.js";
import { approveArtifact, design, generateSpecs, ingest, ingestDesign, ingestStory, relationFromModel, renderSpec, type Target } from "../src/stages/workflow.js";
import { verifySpecs } from "../src/stages/execution.js";
import { QaPipeline } from "../src/pipeline.js";
import { StoryPipeline } from "../src/story-pipeline.js";

function authorReply(prompt: string, storyId: string, evidence: string, route?: { method: "GET"; path: string; expectedStatus: number }, sourceId = storyId): unknown {
  if (prompt.startsWith("Author plan")) {
    const types = prompt.match(/Candidate types: ([^.]+)\. Choose/)?.[1]?.split(", ") ?? [];
    return { objective: `Test ${storyId}`, scopeSummary: evidence, inScope: [{ nodeId: storyId, reason: evidence }],
      approaches: types.map((testType) => ({ testType, purpose: `Check ${testType}`, focus: evidence,
        entryCriteria: ["Source available"], exitCriteria: ["Expected result observed"] })) };
  }
  if (prompt.startsWith("Author scenarios")) {
    const type = prompt.match(/Author scenarios for (\w+)/)?.[1] ?? "functional";
    const targets = JSON.parse(prompt.match(/Targets: (\[.*?\])\. Existing graph scenarios:/s)?.[1] ?? "[]") as Array<{ id: string; criterion?: string }>;
    return { newScenarios: [{ name: `Validate ${type} ${storyId} outcome`, description: evidence,
      expectedOutcome: route ? `HTTP ${route.expectedStatus}` : evidence, priority: "medium", evidence, sourceId: `${sourceId}#1`,
      category: "normal", riskRationale: "The required behavior could fail",
      targetIds: targets.map((target) => target.id), acceptanceCriteria: targets.flatMap((target) => target.criterion ? [target.criterion] : []),
      coversNodeIds: [], exercisesNodeIds: [] }] };
  }
  if (prompt.startsWith("Author test cases")) {
    const type = prompt.match(/Author test cases for (\w+)/)?.[1] ?? "functional";
    const scenario = JSON.parse(prompt.match(/scenario (\{.*?\})\. Return JSON/s)?.[1] ?? "{}") as { acceptanceCriteria?: string[] };
    return { newCases: [{ name: `Validate ${type} ${storyId} result`, objective: evidence, caseKind: "positive", priority: "medium",
      preconditions: [], testData: [], steps: [{ action: route ? `${route.method} ${route.path}` : "Perform action",
        expectedResult: route ? `HTTP ${route.expectedStatus}` : evidence, expectedResultEvidence: evidence }],
      acceptanceCriteria: scenario.acceptanceCriteria ?? [], validatesNodeIds: [], exercisesNodeIds: [],
      automationCandidate: Boolean(route), automationNotes: "", evidence, sourceId: `${sourceId}#1`, ...(route ? { route } : {}) }] };
  }
  throw new Error(`Unexpected author prompt: ${prompt.slice(0, 80)}`);
}

test("Story ingestion stores Epic, Feature, and Story source text in PostgreSQL", async () => {
  const story = { id: "ST-1", adoId: 1, title: "Story", text: "Story evidence", areaPath: "QA", iterationPath: "QA\\Sprint 1",
    parents: [{ id: "FE-1", adoId: 2, revision: 1, kind: "Feature" as const, title: "Feature", text: "Feature evidence" },
      { id: "EP-1", adoId: 3, revision: 1, kind: "Epic" as const, title: "Epic", text: "Epic evidence" }] };
  const saved: Array<{ id: string; kind: string; text: string; sourcePath: string }> = [];
  let setup = 0;
  const documents = { setup: async () => { setup += 1; }, upsert: async (item: typeof saved[number]) => { saved.push(item); return 1; }, close: async () => {} };
  const graph = { setup: async () => {}, node: async () => {}, hierarchy: async () => {},
    mentionedEntities: async () => [], propose: async () => {} } as unknown as GraphStore;
  let run: Run | undefined;
  try {
    run = await ingestStory(story, graph, { json: async () => ({ relationships: [] }) },
      { task: async () => { throw new Error("Unexpected review Task"); } } as unknown as WorkItemClient, documents);
    assert.equal(setup, 1);
    assert.deepEqual(saved.map((item) => [item.id, item.kind, item.text, item.sourcePath]), [
      ["EP-1", "Epic", "Epic evidence", "ado:3"],
      ["FE-1", "Feature", "Feature evidence", "ado:2"],
      ["ST-1", "Story", "Story evidence", "ado:1"],
    ]);
  } finally {
    if (run) await fs.rm(runPath(run.id), { recursive: true, force: true });
  }
});

test("structured ADO decisions require the current hash and a valid correction", () => {
  const approved = parseDecision("<p>Review-Hash: abc</p><p>Decision: approve</p>", "abc", "Ada", 17);
  assert.equal(approved?.action, "approve");
  assert.equal(parseDecision("Review-Hash: old\nDecision: approve", "abc", "Ada", 17), null);
  assert.equal(parseDecision("Review-Hash: abc\nDecision: reject", "abc", "Ada", 17), null);
  assert.equal(parseDecision("Review-Hash: abc\nDecision: correct\nType: USES\nDirection: reverse\nReason: direction", "abc", "Ada", 17)?.reverse, true);
  const richTextDecision = parseDecision('<span>Review-Hash: <span>abc</span>\nDecision: correct\nType: <span>USES</span>&nbsp;Direction: forward Reason: The feature uses the module.</span>', "abc", "Ada", 17);
  assert.equal(richTextDecision?.action, "correct");
  assert.equal(richTextDecision?.type, "USES");
  assert.equal(richTextDecision?.reverse, false);
  assert.equal(richTextDecision?.reason, "The feature uses the module.");
  assert.equal(validRelation("IMPLEMENTS", "Endpoint", "BusinessRule"), true);
  assert.equal(validRelation("IMPLEMENTS", "BusinessRule", "Endpoint"), false);
  assert.equal(consensus([{ ...approved!, reviewer: "Ada" }, { ...approved!, reviewer: "Ben" }])?.action, "approve");
  assert.equal(consensus([approved!, { ...approved!, action: "reject", reason: "wrong" }]), null);
});

test("AI reviewer checks evidence and ontology before suggesting a verdict", () => {
  const relation: Run["relations"][number] = {
    id: "one", sourceId: "FDN-501", sourceType: "Story", targetId: "DataTable:warehouse", targetType: "DataTable",
    type: "MENTIONS", evidence: "warehouse table", confidence: 0.88, reason: "below threshold", source: "FDN-501",
    storyIds: ["FDN-501"], state: "needs_review", tasks: {}, decisions: [],
  };
  const source = "The warehouse table is defined here.";
  assert.match(reviewRecommendation(relation, source, { action: "approve", reason: "Explicitly named", quote: "warehouse table" }), /Suggested action: approve/);
  assert.match(reviewRecommendation(relation, source, { action: "approve", reason: "Explicitly named", quote: "warehouse table", type: null, direction: null }), /Suggested action: approve/);
  assert.match(reviewRecommendation({ ...relation, type: "EXPOSES" }, source, { action: "approve", reason: "Looks right", quote: "warehouse table" }), /Suggested action: unsure/);
  assert.match(reviewRecommendation(relation, source, { action: "approve", reason: "Looks right", quote: "missing quote" }), /Suggested action: unsure/);
  assert.match(reviewRecommendation({ ...relation, type: "PART_OF" }, source, { action: "correct", type: "MENTIONS", direction: "forward", reason: "Only mentioned", quote: "warehouse table" }), /Suggested relationship: MENTIONS \(forward\)/);
  assert.match(reviewRecommendation(relation, source, { action: "correct", type: "EXPOSES", direction: "forward", reason: "Wrong", quote: "warehouse table" }), /Suggested action: unsure/);
  assert.match(reviewRecommendation(relation, source, { action: "reject", reason: "Contradicted", quote: "warehouse table" }), /Suggested action: reject/);
  assert.match(reviewRecommendation(relation, source, { action: "unsure", reason: "Ambiguous" }), /Suggested action: unsure/);
});

test("AI recommendations are hash-bound, idempotent, and cannot act as human decisions", async () => {
  const previous = { org: process.env.ADO_ORG_URL, project: process.env.ADO_PROJECT, pat: process.env.ADO_PAT };
  process.env.ADO_ORG_URL = "https://dev.azure.com/example";
  process.env.ADO_PROJECT = "QA";
  process.env.ADO_PAT = "test-token";
  const comments: string[] = [];
  let posts = 0;
  let currentHash = "hash-one";
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes("workitems/42?") && init?.method === "GET") return new Response(JSON.stringify({ fields: { "System.State": "New", "System.Description": `Review hash: ${currentHash}` } }));
    if (url.includes("workItems/42/comments?") && init?.method === "GET") return new Response(JSON.stringify({ comments: comments.map((text) => ({ text })) }));
    if (url.includes("workItems/42/comments?") && init?.method === "POST") {
      posts += 1;
      comments.push(String(JSON.parse(String(init.body)).text));
      return new Response(JSON.stringify({ id: posts }));
    }
    throw new Error(`Unexpected ADO request: ${url}`);
  };
  try {
    const ado = new Ado(fetcher as typeof fetch);
    const modelName = "qwen/qwen3.8-flash";
    const comment = `AI relationship recommendation | hash-one | ${modelName}\nSuggested action: approve\nWhy: Named in source.`;
    assert.equal(await ado.recommendationStatus(42, "hash-one", modelName), "needed");
    await ado.postRecommendation(42, "hash-one", modelName, comment);
    await ado.postRecommendation(42, "hash-one", modelName, comment);
    assert.equal(posts, 1);
    assert.equal(await ado.recommendationStatus(42, "hash-one", modelName), "present");
    assert.equal(await ado.recommendationStatus(42, "changed-hash", modelName), "unavailable");
    assert.equal(parseDecision(comments[0]!, "hash-one", "AI", 42), null);
    currentHash = "changed-hash";
    assert.equal(await ado.recommendationStatus(42, currentHash, modelName), "needed");
    await ado.postRecommendation(42, currentHash, modelName, `AI relationship recommendation | ${currentHash} | ${modelName}\nSuggested action: unsure`);
    assert.equal(posts, 2);
  } finally {
    if (previous.org === undefined) delete process.env.ADO_ORG_URL; else process.env.ADO_ORG_URL = previous.org;
    if (previous.project === undefined) delete process.env.ADO_PROJECT; else process.env.ADO_PROJECT = previous.project;
    if (previous.pat === undefined) delete process.env.ADO_PAT; else process.env.ADO_PAT = previous.pat;
  }
});

test("pending reviewer retries failures and skips recommendations already posted", async () => {
  const story = { id: "FDN-501", adoId: 2580, title: "Warehouse", text: "The warehouse table is defined here.", areaPath: "QA", iterationPath: "QA\\Sprint 1" };
  const run: Run = {
    id: randomUUID(), status: "review_relations", stories: [story], artifacts: [], specs: [], errors: [], createdAt: "2026-01-01",
    relations: [{ id: "one", sourceId: story.id, sourceType: "Story", targetId: "DataTable:warehouse", targetType: "DataTable", type: "MENTIONS", evidence: "warehouse table", confidence: 0.88, reason: "review", source: story.id, storyIds: [story.id], state: "needs_review", tasks: { [story.id]: { id: 42, hash: "hash-one" } }, decisions: [] }],
  };
  let calls = 0;
  let posted = false;
  const model = { json: async () => {
    calls += 1;
    if (calls === 1) throw new Error("temporary model failure");
    return { action: "approve", reason: "Explicit mention", quote: "warehouse table" };
  } } as ModelClient;
  const workItems = {
    recommendationStatus: async () => posted ? "present" as const : "needed" as const,
    postRecommendation: async (_id: number, _hash: string, _model: string, comment: string) => {
      assert.match(comment, /Suggested action: approve/);
      posted = true;
    },
  } as SprintWorkItemClient;
  try {
    await recommendPending(run, model, workItems, "qwen/qwen3.8-flash");
    assert.equal(posted, false);
    assert.match(run.warnings?.[0] ?? "", /temporary model failure/);
    await recommendPending(run, model, workItems, "qwen/qwen3.8-flash");
    await recommendPending(run, model, workItems, "qwen/qwen3.8-flash");
    assert.equal(calls, 2);
    assert.equal(posted, true);
    assert.equal(run.relations[0]?.state, "needs_review");
  } finally {
    await fs.rm(runPath(run.id), { recursive: true, force: true });
  }
});

test("AI reviewer reads the Story evidence for an entity-to-entity proposal", async () => {
  const story = { id: "ST-2", adoId: 2, title: "Warehouse service", text: "The warehouse service exposes POST /warehouses.", areaPath: "QA", iterationPath: "QA\\Sprint 1" };
  const run: Run = {
    id: randomUUID(), status: "review_relations", stories: [story], artifacts: [], specs: [], errors: [], createdAt: "2026-01-01",
    relations: [{ id: "link", sourceId: "Service:warehouse-service", sourceType: "Service", targetId: "Endpoint:post-warehouses", targetType: "Endpoint", type: "EXPOSES", evidence: "warehouse service exposes POST /warehouses", confidence: 0.8, reason: "Review", source: story.id, storyIds: [story.id], state: "needs_review", tasks: { [story.id]: { id: 42, hash: "hash" } }, decisions: [] }],
  };
  let posted = "";
  const model = { json: async (prompt: string) => {
    assert.match(prompt, /warehouse service exposes POST \/warehouses/);
    return { action: "approve", reason: "Explicit", quote: "warehouse service exposes POST /warehouses" };
  } } as ModelClient;
  const workItems = {
    recommendationStatus: async () => "needed" as const,
    postRecommendation: async (_id: number, _hash: string, _model: string, comment: string) => { posted = comment; },
  } as SprintWorkItemClient;
  await recommendPending(run, model, workItems, "qwen/qwen3.8-flash");
  assert.match(posted, /Suggested action: approve/);
  assert.equal(run.relations[0]?.state, "needs_review");
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

test("relationship evidence keeps the model quote when Markdown formatting differs", () => {
  const story = { id: "ST-1", adoId: 1, title: "Story", text: "Creates [five locations](https://example.test/locations).", areaPath: "QA", iterationPath: "QA\\Sprint 1" };
  const relation = relationFromModel(story, {
    targetName: "five locations",
    targetType: "Requirement",
    type: "TRACES_TO",
    evidence: "Creates five locations.",
    confidence: 0.8,
    reason: "Formatting differs but provenance retains the returned quote",
  }, new Set([story.id]));
  assert.equal(relation.evidence, "Creates five locations.");
});

test("a Story's endpoint stays linked to that Story without an EXPOSES review", () => {
  const story = { id: "FDN-501", adoId: 2580, title: "Create warehouse", text: "### POST /warehouses", areaPath: "QA", iterationPath: "QA\\Sprint 1" };
  const relation = relationFromModel(story, {
    targetName: "post-warehouses", targetType: "Endpoint", type: "EXPOSES",
    evidence: "### POST /warehouses", confidence: 1,
    reason: "The story names the endpoint.",
  }, new Set([story.id]));
  assert.equal(relation.sourceId, story.id);
  assert.deepEqual(relation.storyIds, [story.id]);
  assert.equal(relation.type, "MENTIONS");
  assert.equal(relation.state, "approved");
});

test("a Story's business entity stays linked without a DESCRIBES review", () => {
  const story = { id: "FDN-501", adoId: 2580, title: "Create warehouse", text: "to create a warehouse record", areaPath: "QA", iterationPath: "QA\\Sprint 1" };
  const relation = relationFromModel(story, {
    targetName: "warehouse", targetType: "BusinessEntity", type: "DESCRIBES",
    evidence: "to create a warehouse record", confidence: 1,
    reason: "The Story names the warehouse entity.",
  }, new Set([story.id]));
  assert.equal(relation.type, "MENTIONS");
  assert.equal(relation.state, "approved");
  assert.equal(relation.sourceId, story.id);
  assert.equal(relation.targetId, "BusinessEntity:warehouse");
});

test("scope lists and module labels are mentions, not implementation or ownership", () => {
  const epic = { id: "FDN", adoId: 2493, revision: 1, kind: "Epic" as const, title: "Foundation", text: "Scope In. Service skeleton, audit trail, the event outbox. Primary module(s) platform, masterdata" };
  const feature = { id: "FDN-5", adoId: 2511, revision: 1, kind: "Feature" as const, title: "Locations", text: "Module masterdata" };
  const story = { id: "FDN-501", adoId: 2580, title: "Create warehouse", text: "Modules: masterdata", areaPath: "QA", iterationPath: "QA\\Sprint 1" };
  for (const name of ["Service skeleton", "audit trail", "event outbox"]) {
    const relation = relationFromModel(story, {
      targetName: name, targetType: "Component", type: "IMPLEMENTS",
      evidence: `Scope In. ${name}`, confidence: 1, reason: "Named in Epic scope",
    }, new Set([story.id]), epic.id, epic);
    assert.equal(relation.type, "MENTIONS");
    assert.equal(relation.state, "approved");
    assert.equal(relation.sourceId, epic.id);
  }
  for (const [source, sourceItem, confidence] of [[feature.id, feature, 0.85], [story.id, undefined, 0.96]] as const) {
    const relation = relationFromModel(story, {
      targetName: "masterdata", targetType: "Module", type: "PART_OF",
      evidence: "Module masterdata", confidence, reason: "Module label",
    }, new Set([story.id]), source, sourceItem);
    assert.equal(relation.type, "MENTIONS");
    assert.equal(relation.state, confidence >= 0.9 ? "approved" : "needs_review");
  }
  const module = relationFromModel(story, {
    targetName: "masterdata", targetType: "Module", type: "USES",
    evidence: "Primary module(s) platform, masterdata", confidence: 1, reason: "Primary module label",
  }, new Set([story.id]), epic.id, epic);
  assert.equal(module.type, "MENTIONS");
  assert.equal(module.state, "approved");
});

test("a test explicitly named by a Story uses traceability instead of VALIDATES", () => {
  const story = { id: "FDN-501", adoId: 2580, title: "Create warehouse", text: "Tests: test_create_warehouse in tests/test_locations.py", areaPath: "QA", iterationPath: "QA\\Sprint 1" };
  const proposal = {
    targetName: "test_create_warehouse", targetType: "TestCase" as const, type: "VALIDATES",
    evidence: "test_create_warehouse", confidence: 0.9,
    reason: "The Story names the existing test.",
  };
  const relation = relationFromModel(story, proposal, new Set([story.id]));
  assert.equal(relation.type, "TRACES_TO");
  assert.equal(relation.state, "approved");
  assert.equal(relation.evidence, "test_create_warehouse");
  assert.equal(relation.sourceId, story.id);
  assert.equal(relation.targetType, "TestCase");

  const unsupported = relationFromModel({ ...story, text: "Tests: unit and integration" }, proposal, new Set([story.id]));
  assert.equal(unsupported.type, "VALIDATES");
  assert.equal(unsupported.state, "needs_review");
});

test("invalid model pairs are retried while low-confidence valid pairs need review", async () => {
  const story = { id: "ST-1", adoId: 1, title: "Story", text: "GET /warehouses returns 200.", areaPath: "QA", iterationPath: "QA\\Sprint 1" };
  const graph = {
    setup: async () => {}, node: async () => {}, hierarchy: async () => {}, propose: async () => {},
  } as unknown as GraphStore;
  let calls = 0;
  const model = { json: async () => {
    calls += 1;
    return { relationships: [
      ...(calls === 1 ? [
        { targetName: "Feature", targetType: "Feature", type: "IMPLEMENTS", evidence: "GET /warehouses", confidence: 0.8, reason: "unsupported structural type" },
        { targetName: "GET /warehouses", targetType: "Endpoint", type: "IMPLEMENTATION", evidence: "GET /warehouses returns 200.", confidence: 1, reason: "unsupported relationship type" },
      ] : []),
      { targetName: "GET /warehouses", targetType: "Endpoint", type: "AFFECTS", evidence: "GET /warehouses returns 200.", confidence: 0.95, reason: "explicit evidence" },
      { targetName: "GET /warehouses", targetType: "Endpoint", type: "MENTIONS", evidence: "GET /warehouses", confidence: 0.8, reason: "some uncertainty" },
    ] };
  } } as ModelClient;
  let tasks = 0;
  const ado = { task: async () => ({ id: ++tasks, hash: "hash" }), decision: async () => null };
  let run: Run | undefined;
  try {
    run = await ingestStory(story, graph, model, ado);
    assert.equal(run.status, "review_relations");
    assert.equal(run.relations.length, 2);
    assert.equal(run.relations.find((relation) => relation.type === "AFFECTS")?.state, "approved");
    assert.equal(run.relations.find((relation) => relation.type === "MENTIONS")?.state, "needs_review");
    assert.equal(tasks, 1);
    assert.equal(calls, 2);
    assert.match(run.warnings?.[0] ?? "", /relationship #0 ignored/);
    assert.deepEqual(run.errors, []);
  } finally {
    if (run) await fs.rm(runPath(run.id), { recursive: true, force: true });
  }
});

test("new entities can connect to older graph entities with source evidence", async () => {
  const story = { id: "ST-2", adoId: 2, title: "Warehouse service", text: "The warehouse service exposes POST /warehouses.", areaPath: "QA", iterationPath: "QA\\Sprint 1" };
  const proposals: Run["relations"] = [];
  const graph = {
    setup: async () => {}, node: async () => {}, hierarchy: async () => {},
    mentionedEntities: async () => [{ id: "Endpoint:post-warehouses", type: "Endpoint" as const, name: "POST /warehouses" }],
    propose: async (relation: Run["relations"][number]) => { proposals.push(relation); },
  } as unknown as GraphStore;
  const model = { json: async (prompt: string) => prompt.startsWith("Find relationships")
    ? { connections: [
      { sourceId: "Service:warehouse-service", targetId: "Endpoint:post-warehouses", type: "EXPOSES", evidence: "warehouse service exposes POST /warehouses", confidence: 0.8, reason: "Explicit service endpoint" },
      { sourceId: "Service:warehouse-service", targetId: "Endpoint:post-warehouses", type: "EXPOSES", evidence: "service exposes POST /warehouses", confidence: 0.8, reason: "Same link" },
      { sourceId: "Service:warehouse-service", targetId: "Endpoint:post-warehouses", type: "DESCRIBES", evidence: "warehouse service exposes POST /warehouses", confidence: 1, reason: "Invalid ontology pair" },
      { sourceId: "Service:warehouse-service", targetId: "Endpoint:post-warehouses", type: "USES", evidence: "invented quote", confidence: 1, reason: "No evidence" },
    ] }
    : { relationships: [{ targetName: "warehouse service", targetType: "Service", type: "MENTIONS", evidence: "warehouse service", confidence: 1, reason: "Named service" }] },
  } as ModelClient;
  let tasks = 0;
  const ado = { task: async () => ({ id: ++tasks, hash: "hash" }), decision: async () => null };
  let run: Run | undefined;
  try {
    run = await ingestStory(story, graph, model, ado);
    assert.equal(run.status, "review_relations");
    assert.equal(run.relations.length, 2);
    assert.equal(proposals.length, 2);
    assert.equal(run.relations[1]?.sourceId, "Service:warehouse-service");
    assert.equal(run.relations[1]?.targetId, "Endpoint:post-warehouses");
    assert.equal(run.relations[1]?.type, "EXPOSES");
    assert.equal(run.relations[1]?.state, "needs_review");
    assert.equal(tasks, 1);
    assert.equal(run.warnings?.length, 2);
  } finally {
    if (run) await fs.rm(runPath(run.id), { recursive: true, force: true });
  }
});

test("invalid entity-connection shape is corrected with schema feedback", async () => {
  const story = { id: "ST-8", adoId: 8, title: "Order events", text: "NetSuite publishes OrderUpdated.", areaPath: "QA", iterationPath: "QA\\Sprint 1" };
  const graph = { setup: async () => {}, node: async () => {}, hierarchy: async () => {}, propose: async () => {},
    mentionedEntities: async () => [
      { id: "Application:netsuite", type: "Application" as const, name: "NetSuite" },
      { id: "DomainEvent:orderupdated", type: "DomainEvent" as const, name: "OrderUpdated" },
    ] } as unknown as GraphStore;
  const prompts: string[] = [];
  const model = { json: async (prompt: string) => {
    if (!prompt.startsWith("Find relationships")) return { relationships: [] };
    prompts.push(prompt);
    if (prompts.length === 1) return { connections: [{ sourceId: "Application:netsuite", confidence: "high" }] };
    return { connections: [] };
  } } as ModelClient;
  const ado = { task: async () => { throw new Error("No Task expected"); }, decision: async () => null };
  let run: Run | undefined;
  try {
    run = await ingestStory(story, graph, model, ado);
    assert.equal(run.status, "ready_design");
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /connections\.0\.confidence: Invalid input: expected number, received string/);
    assert.match(run.warnings?.[0] ?? "", /ST-8: entity connections attempt 1\/3 failed schema validation/);
  } finally {
    if (run) await fs.rm(runPath(run.id), { recursive: true, force: true });
  }
});

test("exhausted entity-connection retries save the schema diagnostics", async () => {
  const story = { id: "ST-9", adoId: 9, title: "Order events", text: "NetSuite publishes OrderUpdated.", areaPath: "QA", iterationPath: "QA\\Sprint 1" };
  const graph = { setup: async () => {}, node: async () => {}, hierarchy: async () => {}, propose: async () => {},
    mentionedEntities: async () => [
      { id: "Application:netsuite", type: "Application" as const, name: "NetSuite" },
      { id: "DomainEvent:orderupdated", type: "DomainEvent" as const, name: "OrderUpdated" },
    ] } as unknown as GraphStore;
  let calls = 0;
  const model = { json: async (prompt: string) => {
    if (!prompt.startsWith("Find relationships")) return { relationships: [] };
    calls += 1;
    return { relationships: [] };
  } } as ModelClient;
  const ado = { task: async () => { throw new Error("No Task expected"); }, decision: async () => null };
  let run: Run | undefined;
  try {
    run = await ingestStory(story, graph, model, ado);
    assert.equal(run.status, "mapping_error");
    assert.equal(calls, 3);
    assert.equal(run.warnings?.length, 3);
    assert.match(run.errors[0] ?? "", /ST-9: entity connections attempt 3\/3 failed schema validation: connections: Invalid input/);
    const saved = JSON.parse(await fs.readFile(`${runPath(run.id)}/run.json`, "utf8")) as Run;
    assert.deepEqual(saved.errors, run.errors);
    assert.deepEqual(saved.warnings, run.warnings);
  } finally {
    if (run) await fs.rm(runPath(run.id), { recursive: true, force: true });
  }
});

test("an older entity can be the source of a new relationship", async () => {
  const story = { id: "ST-3", adoId: 3, title: "New endpoint", text: "The warehouse service exposes POST /inventory.", areaPath: "QA", iterationPath: "QA\\Sprint 1" };
  const graph = {
    setup: async () => {}, node: async () => {}, hierarchy: async () => {},
    mentionedEntities: async () => [{ id: "Service:warehouse-service", type: "Service" as const, name: "warehouse service" }],
    propose: async () => {},
  } as unknown as GraphStore;
  const model = { json: async (prompt: string) => prompt.startsWith("Find relationships")
    ? { connections: [{ sourceId: "Service:warehouse-service", targetId: "Endpoint:post-inventory", type: "EXPOSES", evidence: "warehouse service exposes POST /inventory", confidence: 1, reason: "Explicit" }] }
    : { relationships: [{ targetName: "POST /inventory", targetType: "Endpoint", type: "MENTIONS", evidence: "POST /inventory", confidence: 1, reason: "Named endpoint" }] },
  } as ModelClient;
  const ado = { task: async () => { throw new Error("No Task expected"); }, decision: async () => null };
  let run: Run | undefined;
  try {
    run = await ingestStory(story, graph, model, ado);
    assert.equal(run.status, "ready_design");
    assert.equal(run.relations[1]?.sourceId, "Service:warehouse-service");
    assert.equal(run.relations[1]?.targetId, "Endpoint:post-inventory");
    assert.equal(run.relations[1]?.state, "approved");
  } finally {
    if (run) await fs.rm(runPath(run.id), { recursive: true, force: true });
  }
});

test("a reversed call quote cannot auto-approve a new-to-older link", async () => {
  const story = { id: "ST-10", adoId: 10, title: "Service call", text: "Service A calls Service B.", areaPath: "QA", iterationPath: "QA\\Sprint 1" };
  const graph = { setup: async () => {}, node: async () => {}, hierarchy: async () => {}, propose: async () => {},
    mentionedEntities: async () => [{ id: "Service:service-b", type: "Service" as const, name: "Service B" }],
  } as unknown as GraphStore;
  const model = { json: async (prompt: string) => prompt.startsWith("Find relationships")
    ? { connections: [{ sourceId: "Service:service-b", targetId: "Service:service-a", type: "CALLS",
      evidence: "Service A calls Service B", confidence: 1, reason: "Reversed direction" }] }
    : { relationships: [{ targetName: "Service A", targetType: "Service", type: "MENTIONS",
      evidence: "Service A", confidence: 1, reason: "Named service" }] },
  } as ModelClient;
  const ado = { task: async () => ({ id: 1, hash: "hash" }), decision: async () => null };
  let run: Run | undefined;
  try {
    run = await ingestStory(story, graph, model, ado);
    const call = run.relations.find((relation) => relation.type === "CALLS");
    assert.equal(call?.state, "needs_review");
    assert.equal(run.status, "review_relations");
  } finally {
    if (run) await fs.rm(runPath(run.id), { recursive: true, force: true });
  }
});

test("an older entity mentioned by its alias keeps its graph identity", async () => {
  const story = { id: "ST-7", adoId: 7, title: "D365 event", text: "D365 publishes OrderUpdated.", areaPath: "QA", iterationPath: "QA\\Sprint 1" };
  const proposals: Run["relations"] = [];
  const created: string[] = [];
  const graph = {
    setup: async () => {}, node: async (id: string) => { created.push(id); }, hierarchy: async () => {},
    mentionedEntities: async () => [{ id: "Application:microsoft-dynamics-365", type: "Application" as const, name: "D365" }],
    propose: async (relation: Run["relations"][number]) => { proposals.push(relation); },
  } as unknown as GraphStore;
  const model = { json: async (prompt: string) => prompt.startsWith("Find relationships")
    ? { connections: [{ sourceId: "Application:microsoft-dynamics-365", targetId: "DomainEvent:orderupdated", type: "PUBLISHES", evidence: "D365 publishes OrderUpdated", confidence: 0.8, reason: "Explicit" }] }
    : { relationships: [
      { targetName: "D365", targetType: "Application", type: "MENTIONS", evidence: "D365", confidence: 1, reason: "Named application" },
      { targetName: "OrderUpdated", targetType: "DomainEvent", type: "MENTIONS", evidence: "OrderUpdated", confidence: 1, reason: "Named event" },
    ] },
  } as ModelClient;
  const ado = { task: async () => ({ id: 1, hash: "hash" }), decision: async () => null };
  let run: Run | undefined;
  try {
    run = await ingestStory(story, graph, model, ado);
    assert.equal(run.status, "review_relations");
    assert.ok(proposals.some((relation) => relation.sourceId === story.id && relation.targetId === "Application:microsoft-dynamics-365"));
    assert.ok(proposals.some((relation) => relation.sourceId === "Application:microsoft-dynamics-365" && relation.targetId === "DomainEvent:orderupdated"));
    assert.ok(!created.includes("Application:d365"));
  } finally {
    if (run) await fs.rm(runPath(run.id), { recursive: true, force: true });
  }
});

test("new source evidence can link two older entities without creating a new entity", async () => {
  const story = { id: "ST-5", adoId: 5, title: "Order events", text: "NetSuite publishes the OrderUpdated event.", areaPath: "QA", iterationPath: "QA\\Sprint 1" };
  const proposals: Run["relations"] = [];
  const graph = {
    setup: async () => {}, node: async () => {}, hierarchy: async () => {},
    mentionedEntities: async () => [
      { id: "Application:netsuite", type: "Application" as const, name: "NetSuite" },
      { id: "DomainEvent:orderupdated", type: "DomainEvent" as const, name: "OrderUpdated" },
    ],
    propose: async (relation: Run["relations"][number]) => { proposals.push(relation); },
  } as unknown as GraphStore;
  const model = { json: async (prompt: string) => {
    if (!prompt.startsWith("Find relationships")) return { relationships: [] };
    assert.match(prompt, /NetSuite/);
    assert.match(prompt, /OrderUpdated/);
    return { connections: [
      { sourceId: "Application:netsuite", targetId: "DomainEvent:orderupdated", type: "PUBLISHES", evidence: "NetSuite publishes the OrderUpdated event", confidence: 1, reason: "Explicit" },
      { sourceId: "Application:netsuite", targetId: "DomainEvent:orderupdated", type: "PUBLISHES", evidence: "invented quote", confidence: 1, reason: "Unsupported" },
    ] };
  } } as ModelClient;
  const ado = { task: async () => ({ id: 1, hash: "hash" }), decision: async () => null };
  let run: Run | undefined;
  try {
    run = await ingestStory(story, graph, model, ado);
    assert.equal(run.status, "review_relations");
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]?.sourceId, "Application:netsuite");
    assert.equal(proposals[0]?.targetId, "DomainEvent:orderupdated");
    assert.equal(proposals[0]?.type, "PUBLISHES");
    assert.equal(proposals[0]?.state, "needs_review");
    assert.equal(run.warnings?.length, 1);
  } finally {
    if (run) await fs.rm(runPath(run.id), { recursive: true, force: true });
  }
});

test("an approved older relationship is not proposed again", async () => {
  const story = { id: "ST-6", adoId: 6, title: "Order events", text: "NetSuite publishes the OrderUpdated event.", areaPath: "QA", iterationPath: "QA\\Sprint 1" };
  const graph = {
    setup: async () => {}, node: async () => {}, hierarchy: async () => {},
    mentionedEntities: async () => [
      { id: "Application:netsuite", type: "Application" as const, name: "NetSuite" },
      { id: "DomainEvent:orderupdated", type: "DomainEvent" as const, name: "OrderUpdated" },
    ],
    hasApprovedRelationship: async () => true,
    propose: async () => { throw new Error("Approved relationship must not be proposed again"); },
  } as unknown as GraphStore;
  const model = { json: async (prompt: string) => prompt.startsWith("Find relationships")
    ? { connections: [{ sourceId: "Application:netsuite", targetId: "DomainEvent:orderupdated", type: "PUBLISHES", evidence: "NetSuite publishes the OrderUpdated event", confidence: 1, reason: "Explicit" }] }
    : { relationships: [] },
  } as ModelClient;
  const ado = { task: async () => { throw new Error("No review expected"); }, decision: async () => null };
  let run: Run | undefined;
  try {
    run = await ingestStory(story, graph, model, ado);
    assert.equal(run.status, "ready_design");
    assert.equal(run.relations.length, 0);
  } finally {
    if (run) await fs.rm(runPath(run.id), { recursive: true, force: true });
  }
});

test("newly extracted systems and topics connect through supported source relationships", async () => {
  const story = { id: "ST-8", adoId: 8, title: "Order events", text: "NetSuite publishes OrderUpdated. orders-topic carries OrderUpdated. D365 subscribes to orders-topic.", areaPath: "QA", iterationPath: "QA\\Sprint 1" };
  const proposals: Run["relations"] = [];
  const graph = {
    setup: async () => {}, node: async () => {}, hierarchy: async () => {},
    mentionedEntities: async () => [],
    propose: async (relation: Run["relations"][number]) => { proposals.push(relation); },
  } as unknown as GraphStore;
  const model = { json: async (prompt: string) => prompt.startsWith("Find relationships")
    ? { connections: [
      { sourceId: "Application:netsuite", targetId: "DomainEvent:orderupdated", type: "PUBLISHES", evidence: "NetSuite publishes OrderUpdated", confidence: 1, reason: "Explicit" },
      { sourceId: "MessageTopic:orders-topic", targetId: "DomainEvent:orderupdated", type: "CARRIES", evidence: "orders-topic carries OrderUpdated", confidence: 1, reason: "Explicit" },
      { sourceId: "Application:d365", targetId: "MessageTopic:orders-topic", type: "SUBSCRIBES_TO", evidence: "D365 subscribes to orders-topic", confidence: 1, reason: "Explicit" },
    ] }
    : { relationships: [
      { targetName: "NetSuite", targetType: "Application", type: "MENTIONS", evidence: "NetSuite", confidence: 1, reason: "Named system" },
      { targetName: "OrderUpdated", targetType: "DomainEvent", type: "MENTIONS", evidence: "OrderUpdated", confidence: 1, reason: "Named event" },
      { targetName: "orders-topic", targetType: "MessageTopic", type: "MENTIONS", evidence: "orders-topic", confidence: 1, reason: "Named topic" },
      { targetName: "D365", targetType: "Application", type: "MENTIONS", evidence: "D365", confidence: 1, reason: "Named system" },
    ] },
  } as ModelClient;
  const ado = { task: async () => ({ id: 1, hash: "hash" }), decision: async () => null };
  let run: Run | undefined;
  try {
    run = await ingestStory(story, graph, model, ado);
    assert.equal(run.status, "review_relations");
    const links = proposals.filter((relation) => relation.sourceType !== "Story");
    assert.deepEqual(links.map((relation) => relation.type), ["PUBLISHES", "CARRIES", "SUBSCRIBES_TO"]);
    assert.ok(links.every((relation) => relation.state === "needs_review"));
  } finally {
    if (run) await fs.rm(runPath(run.id), { recursive: true, force: true });
  }
});

test("a named integration flow links its source, destination, and contract", async () => {
  const sentence = "Sales Sync sends NetSuite orders to proxy database using OrderPayload schema.";
  const story = { id: "ST-9", adoId: 9, title: "Sales sync", text: sentence, areaPath: "QA", iterationPath: "QA\\Sprint 1" };
  const proposals: Run["relations"] = [];
  const graph = {
    setup: async () => {}, node: async () => {}, hierarchy: async () => {},
    mentionedEntities: async () => [],
    propose: async (relation: Run["relations"][number]) => { proposals.push(relation); },
  } as unknown as GraphStore;
  const model = { json: async (prompt: string) => prompt.startsWith("Find relationships")
    ? { connections: [
      { sourceId: "IntegrationFlow:sales-sync", targetId: "Application:netsuite", type: "FLOW_SOURCE", evidence: sentence, confidence: 1, reason: "Explicit source" },
      { sourceId: "IntegrationFlow:sales-sync", targetId: "Database:proxy-database", type: "FLOW_TARGET", evidence: sentence, confidence: 1, reason: "Explicit destination" },
      { sourceId: "IntegrationFlow:sales-sync", targetId: "DataContract:orderpayload", type: "USES_CONTRACT", evidence: sentence, confidence: 1, reason: "Explicit schema" },
    ] }
    : { relationships: [
      { targetName: "Sales Sync", targetType: "IntegrationFlow", type: "MENTIONS", evidence: "Sales Sync", confidence: 1, reason: "Named flow" },
      { targetName: "NetSuite", targetType: "Application", type: "MENTIONS", evidence: "NetSuite", confidence: 1, reason: "Named source" },
      { targetName: "proxy database", targetType: "Database", type: "MENTIONS", evidence: "proxy database", confidence: 1, reason: "Named destination" },
      { targetName: "OrderPayload", targetType: "DataContract", type: "MENTIONS", evidence: "OrderPayload", confidence: 1, reason: "Named contract" },
    ] },
  } as ModelClient;
  const ado = { task: async () => ({ id: 1, hash: "hash" }), decision: async () => null };
  let run: Run | undefined;
  try {
    run = await ingestStory(story, graph, model, ado);
    assert.equal(run.status, "review_relations");
    const links = proposals.filter((relation) => relation.sourceType === "IntegrationFlow");
    assert.deepEqual(links.map((relation) => relation.type), ["FLOW_SOURCE", "FLOW_TARGET", "USES_CONTRACT"]);
    assert.ok(links.every((relation) => relation.state === "needs_review"));
  } finally {
    if (run) await fs.rm(runPath(run.id), { recursive: true, force: true });
  }
});

test("test design accepts a null route as a manual case", async () => {
  const story = { id: "ST-1", adoId: 1, title: "Warehouse", text: "Create a warehouse.", areaPath: "QA", iterationPath: "QA\\Sprint 1" };
  const run: Run = { id: randomUUID(), status: "ready_design", stories: [story], relations: [], artifacts: [], specs: [], errors: [], createdAt: "2026-01-01" };
  const graph = { storyContext: async () => "{\"nodes\":[],\"edges\":[]}" } as unknown as GraphStore;
  let calls = 0;
  const model = { json: async (prompt: string) => {
    calls += 1;
    return authorReply(prompt, story.id, "Create a warehouse.");
  } } as ModelClient;
  try {
    await design(run, graph, model);
    assert.equal(run.status, "review_artifacts");
    assert.ok(calls >= 5);
    assert.ok(run.artifacts.filter((item) => item.kind === "TestCase").every((item) => item.content.route === undefined));
  } finally {
    await fs.rm(runPath(run.id), { recursive: true, force: true });
  }
});

test("document ingestion keeps its evidence for cross-run relationship review", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qa-cross-run-"));
  await fs.writeFile(path.join(directory, "story.json"), JSON.stringify({ id: 4, code: "ST-4", fields: {
    "System.WorkItemType": "User Story", "System.Title": "ST-4 Warehouse", "System.Description": "Create the warehouse.",
    "System.AreaPath": "QA", "System.IterationPath": "QA\\Sprint 1",
  } }));
  await fs.writeFile(path.join(directory, "details.md"), "ST-4 The warehouse service exposes POST /warehouses.");
  const graph = {
    setup: async () => {}, node: async () => {}, propose: async () => {},
    mentionedEntities: async () => [{ id: "Endpoint:post-warehouses", type: "Endpoint" as const, name: "POST /warehouses" }],
  } as unknown as GraphStore;
  const model = { json: async (prompt: string) => prompt.startsWith("Find relationships")
    ? { connections: [{ sourceId: "Service:warehouse-service", targetId: "Endpoint:post-warehouses", type: "EXPOSES", evidence: "warehouse service exposes POST /warehouses", confidence: 0.8, reason: "Explicit in document" }] }
    : { relationships: prompt.includes("warehouse service exposes")
      ? [{ targetName: "warehouse service", targetType: "Service", type: "MENTIONS", evidence: "warehouse service", confidence: 1, reason: "Named in document" }] : [] },
  } as ModelClient;
  const ado = { task: async () => ({ id: 1, hash: "hash" }), decision: async () => null };
  let run: Run | undefined;
  try {
    run = await ingest(directory, graph, model, ado);
    const relation = run.relations.find((item) => item.type === "EXPOSES");
    assert.equal(relation?.source, "details.md");
    assert.match(relation?.sourceText ?? "", /warehouse service exposes POST \/warehouses/);
    assert.equal(relation?.state, "needs_review");
    let comment = "";
    await recommendPending(run, { json: async (prompt: string) => {
      assert.match(prompt, /ST-4 The warehouse service exposes POST \/warehouses/);
      return { action: "approve", reason: "Explicit", quote: "warehouse service exposes POST /warehouses" };
    } }, {
      recommendationStatus: async () => "needed" as const,
      postRecommendation: async (_id: number, _hash: string, _model: string, text: string) => { comment = text; },
    } as SprintWorkItemClient, "qwen/qwen3.8-flash");
    assert.match(comment, /Suggested action: approve/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    if (run) await fs.rm(runPath(run.id), { recursive: true, force: true });
  }
});

test("malformed relationship output retries and blocks before test design", async () => {
  const story = { id: "ST-1", adoId: 1, title: "Story", text: "Known behavior.", areaPath: "QA", iterationPath: "QA\\Sprint 1" };
  const graph = { setup: async () => {}, node: async () => {}, hierarchy: async () => {} } as unknown as GraphStore;
  let calls = 0;
  const model = { json: async () => { calls += 1; return { scenarios: [] }; } } as ModelClient;
  const ado = { task: async () => ({ id: 1, hash: "hash" }), decision: async () => null };
  let run: Run | undefined;
  try {
    run = await ingestStory(story, graph, model, ado);
    assert.equal(calls, 2);
    assert.equal(run.status, "mapping_error");
    assert.match(run.errors[0] ?? "", /wrong JSON shape|object with relationships/);
    assert.equal(run.artifacts.length, 0);
  } finally {
    if (run) await fs.rm(runPath(run.id), { recursive: true, force: true });
  }
});

test("Epic SUPPORTS Story is corrected by the model before review Tasks are created", async () => {
  const story = {
    id: "FDN-501", adoId: 2580, title: "Create warehouse", text: "Warehouse table is in masterdata.", areaPath: "QA", iterationPath: "QA\\Sprint 1",
    parents: [{ id: "FDN", adoId: 2493, revision: 1, kind: "Epic" as const, title: "Foundation", text: "Nothing else can be built without this. Masterdata contains the warehouse table." }],
  };
  const prompts: string[] = [];
  const model = { json: async (prompt: string) => {
    prompts.push(prompt);
    if (prompt.includes("from Epic") && !prompt.includes("previous response used invalid")) return { relationships: [{ targetName: story.id, targetType: "Story", type: "SUPPORTS", evidence: "Nothing else can be built without this.", confidence: 0.97, reason: "Epic supports Story" }] };
    return { relationships: [] };
  } } as ModelClient;
  let tasks = 0;
  const ado = { task: async () => { tasks += 1; return { id: tasks, hash: "hash" }; }, decision: async () => null };
  const graph = { setup: async () => {}, node: async () => {}, hierarchy: async () => {}, propose: async () => {} } as unknown as GraphStore;
  let run: Run | undefined;
  try {
    run = await ingestStory(story, graph, model, ado);
    assert.equal(run.status, "ready_design");
    assert.equal(run.relations.length, 0);
    assert.equal(tasks, 0);
    assert.equal(prompts.length, 3);
    assert.match(prompts[0] ?? "", /Valid target types and relationship types for this Epic:/);
    assert.match(prompts[1] ?? "", /Epic -\[SUPPORTS\]-> Story/);
  } finally {
    if (run) await fs.rm(runPath(run.id), { recursive: true, force: true });
  }
});

test("an unresolved invalid pair remains available for human correction", async () => {
  const story = { id: "ST-1", adoId: 1, title: "Warehouse", text: "GET /warehouses returns 200.", areaPath: "QA", iterationPath: "QA\\Sprint 1" };
  let calls = 0;
  let tasks = 0;
  const model = { json: async () => {
    calls += 1;
    return { relationships: [{ targetName: "GET /warehouses", targetType: "Endpoint", type: "DESCRIBES", evidence: "returns 200", confidence: 0.95, reason: "Potential relationship needs correction" }] };
  } } as ModelClient;
  const graph = { setup: async () => {}, node: async () => {}, hierarchy: async () => {}, propose: async () => {} } as unknown as GraphStore;
  const ado = { task: async () => ({ id: ++tasks, hash: "hash" }), decision: async () => null };
  let run: Run | undefined;
  try {
    run = await ingestStory(story, graph, model, ado);
    assert.equal(calls, 2);
    assert.equal(tasks, 1);
    assert.equal(run.status, "review_relations");
    assert.equal(run.relations[0]?.type, "DESCRIBES");
    assert.equal(run.relations[0]?.state, "needs_review");
    assert.match(run.warnings?.[0] ?? "", /model kept invalid relationship/);
  } finally {
    if (run) await fs.rm(runPath(run.id), { recursive: true, force: true });
  }
});

test("an Epic proposal that explicitly names the Story can reach human review", async () => {
  const story = {
    id: "FDN-501", adoId: 2580, title: "FDN-501 Create warehouse", text: "Create a warehouse.", areaPath: "QA", iterationPath: "QA\\Sprint 1",
    parents: [{ id: "FDN", adoId: 2493, revision: 1, kind: "Epic" as const, title: "Foundation", text: "FDN-501 depends on the foundation." }],
  };
  const model = { json: async (prompt: string) => ({ relationships: prompt.includes("from Epic")
    ? [{ targetName: story.id, targetType: "Story", type: "SUPPORTS", evidence: "FDN-501 depends on the foundation.", confidence: 0.97, reason: "Specific Story reference" }]
    : [] }) } as ModelClient;
  const graph = { setup: async () => {}, node: async () => {}, hierarchy: async () => {}, propose: async () => {} } as unknown as GraphStore;
  let tasks = 0;
  const ado = { task: async () => ({ id: ++tasks, hash: "hash" }), decision: async () => null };
  let run: Run | undefined;
  try {
    run = await ingestStory(story, graph, model, ado);
    assert.equal(run.status, "review_relations");
    assert.equal(run.relations[0]?.type, "SUPPORTS");
    assert.equal(run.relations[0]?.state, "needs_review");
    assert.equal(tasks, 1);
  } finally {
    if (run) await fs.rm(runPath(run.id), { recursive: true, force: true });
  }
});

test("Story ingestion extracts Epic, Feature, and Story evidence and passes parents to design", async () => {
  const story = {
    id: "ST-1", adoId: 1, title: "Story", text: "EP-1 endpoint and FT-1 endpoint support this Story. Story route returns 200.", areaPath: "QA", iterationPath: "QA\\Sprint 1",
    parents: [
      { id: "FT-1", adoId: 10, revision: 1, kind: "Feature" as const, title: "Feature", text: "Feature requires a site code." },
      { id: "EP-1", adoId: 20, revision: 1, kind: "Epic" as const, title: "Epic", text: "Epic requires audit entries." },
    ],
  };
  const proposals: Array<{ sourceId: string; sourceType: string }> = [];
  let contextParents: string[] = [];
  const prompts: string[] = [];
  const graph = {
    setup: async () => {}, node: async () => {}, hierarchy: async () => {},
    propose: async (relation: { sourceId: string; sourceType: string }) => { proposals.push(relation); },
    storyContext: async (_id: string, parentIds: string[]) => { contextParents = parentIds; return "{}"; },
  } as unknown as GraphStore;
  const model = { json: async (prompt: string) => {
    prompts.push(prompt);
    if (prompt.startsWith("Extract")) {
      const source = prompt.match(/from (Epic|Feature|Story) ([A-Z]+-\d+)/)?.[2];
      return { relationships: [
        { targetName: `${source} endpoint`, targetType: "Endpoint", type: "AFFECTS", evidence: "source evidence", confidence: 1, reason: "explicit" },
        ...(source === "EP-1" ? [{ targetName: "unrelated audit trail", targetType: "Component", type: "MENTIONS", evidence: "unrelated audit trail", confidence: 1, reason: "Epic scope only" }] : []),
      ] };
    }
    return authorReply(prompt, story.id, "Epic requires audit entries.", undefined, "EP-1");
  } } as ModelClient;
  const ado = { task: async () => { throw new Error("No review Task expected"); }, decision: async () => null };
  let run: Run | undefined;
  try {
    run = await ingestStory(story, graph, model, ado);
    assert.equal(run.status, "ready_design");
    assert.deepEqual(proposals.map((item) => [item.sourceId, item.sourceType]), [["EP-1", "Epic"], ["FT-1", "Feature"], ["ST-1", "Story"]]);
    assert.ok(prompts[0]?.includes("Epic requires audit entries."));
    assert.ok(prompts[1]?.includes("Feature requires a site code."));
    assert.ok(prompts[2]?.includes("Story route returns 200."));
    await design(run, graph, model);
    assert.deepEqual(contextParents, ["FT-1", "EP-1"]);
    assert.ok(prompts.some((prompt) => prompt.startsWith("Author plan") && prompt.includes("Epic requires audit entries.")));
    assert.ok(prompts.some((prompt) => prompt.startsWith("Author plan") && prompt.includes("Feature requires a site code.")));
    assert.equal(run.status, "review_artifacts");
  } finally {
    if (run) await fs.rm(runPath(run.id), { recursive: true, force: true });
  }
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
      plannedFor: async () => {},
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
  await setupTarget(targetProject);
  await fs.writeFile(targetFile, JSON.stringify({ projectDir: targetProject, baseUrl: "http://localhost:3000", safeEnvironments: ["http://localhost:3000"], routes: [{ method: "GET", path: "/warehouses", responses: [200] }] }));
  const records = new Map<number, StoryPipelineRecord>();
  const hierarchy: string[] = [];
  const graph = {
    setup: async () => {}, node: async () => {}, hierarchy: async (parentId: string, childId: string) => { hierarchy.push(`${parentId}->${childId}`); }, plannedFor: async () => {}, propose: async () => {}, decide: async () => {}, storyContext: async () => "{}",
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
    testReviewTask: async () => 900,
    testReviewComments: async () => (records.get(1)?.run?.testReview?.items ?? []).map((item) => ({
      text: `Item-ID: ${item.id}\nReview-Hash: ${item.hash}\nDecision: approve`, reviewer: "Ada", at: "2026-01-01",
    })),
    closeTestReviewTask: async () => {},
    publishResult: async () => {},
  } as SprintWorkItemClient;
  const model = { json: async (prompt: string) => prompt.startsWith("Extract")
    ? { relationships: [] }
    : authorReply(prompt, "ST-1", "GET /warehouses returns 200.", { method: "GET", path: "/warehouses", expectedStatus: 200 }),
  } as ModelClient;
  const pipeline = new StoryPipeline(graph, () => model, workItems, undefined, undefined, undefined, () => statusModel);
  let runId: string | undefined;
  try {
    assert.deepEqual((await pipeline.pollSprint("QA\\Sprint 1")).map((item) => item.adoId), [1, 2]);
    assert.equal(records.get(1)?.version, 4);
    const first = await pipeline.advanceStory(1, targetFile);
    runId = first.runId;
    assert.equal(first.action, "test_review");
    assert.deepEqual(hierarchy, ["FT-1->ST-1", "EP->FT-1", "FT-1->ST-1", "EP->FT-1"]);
    assert.equal(records.get(1)?.stage, "review_artifacts");
    assert.equal(records.get(2)?.stage, "discovered");
    stories[0]!.revision = 4;
    await pipeline.pollSprint("QA\\Sprint 1");
    assert.equal(records.get(1)?.run?.id, runId);
    assert.equal(records.get(1)?.stage, "review_artifacts");
    assert.equal(records.get(1)?.revision, 4);
    const generated = await pipeline.advanceStory(1, targetFile);
    assert.equal(generated.action, "specs_generated");
    assert.equal(records.get(1)?.stage, "review_specs");
    assert.equal(records.get(2)?.stage, "discovered");
  } finally {
    if (runId) await fs.rm(runPath(runId), { recursive: true, force: true });
    if (temporary.startsWith(path.resolve(os.tmpdir()) + path.sep)) await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("Story pipeline posts an AI recommendation but waits for human approval", async () => {
  const story = { id: "ST-1", adoId: 1, revision: 1, title: "Warehouse", text: "The warehouse table is defined here.", areaPath: "QA", iterationPath: "QA\\Sprint 1" };
  const records = new Map<number, StoryPipelineRecord>();
  records.set(story.adoId, { version: 4, adoId: story.adoId, revision: 1, iterationPath: story.iterationPath, story, stage: "discovered", status: "active", updatedAt: "2026-01-01" });
  const graph = {
    setup: async () => {}, node: async () => {}, hierarchy: async () => {}, propose: async () => {},
    storyPipeline: async (id: number) => records.get(id) ?? null,
    saveStoryPipeline: async (record: StoryPipelineRecord) => { records.set(record.adoId, structuredClone(record)); },
  } as GraphStore;
  const extraction = { json: async () => ({ relationships: [{ targetName: "warehouse", targetType: "DataTable", type: "MENTIONS", evidence: "warehouse table", confidence: 0.88, reason: "below threshold" }] }) } as ModelClient;
  let reviewerCalls = 0;
  const reviewer = { json: async () => { reviewerCalls += 1; return { action: "approve", reason: "Explicit mention", quote: "warehouse table" }; } } as ModelClient;
  let posted = false;
  const workItems = {
    task: async () => ({ id: 42, hash: "hash-one" }),
    decision: async () => null,
    recommendationStatus: async () => posted ? "present" as const : "needed" as const,
    postRecommendation: async () => { posted = true; },
  } as SprintWorkItemClient;
  const pipeline = new StoryPipeline(graph, () => extraction, workItems, () => reviewer);
  let runId: string | undefined;
  try {
    const first = await pipeline.advanceStory(story.adoId);
    runId = first.runId;
    assert.equal(first.action, "ingestion_review");
    assert.equal(posted, true);
    assert.equal(reviewerCalls, 1);
    assert.equal(records.get(story.adoId)?.stage, "review_relations");
    const second = await pipeline.advanceStory(story.adoId);
    assert.equal(second.action, "waiting");
    assert.equal(reviewerCalls, 1);
    assert.equal(records.get(story.adoId)?.run?.relations[0]?.state, "needs_review");
  } finally {
    if (runId) await fs.rm(runPath(runId), { recursive: true, force: true });
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
    else if (url.includes("workitems/41?")) value = { id: 41, rev: 3, fields: { "System.WorkItemType": "User Story", "System.Title": "ST-1 First", "System.Description": "Returns {&quot;items&quot;: []} &amp; succeeds.", "System.AreaPath": "QA", "System.IterationPath": "QA\\Sprint 1" }, relations: [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: parentUrl(10) }] };
    else if (url.includes("workitems/42?")) value = { id: 42, rev: 4, fields: { "System.WorkItemType": "User Story", "System.Title": "ST-2 Second", "System.Description": "Second", "System.AreaPath": "QA", "System.IterationPath": "QA\\Sprint 1" }, relations: [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: parentUrl(10) }] };
    else if (url.includes("workitems/10?")) value = { id: 10, rev: 2, fields: { "System.WorkItemType": "Feature", "System.Title": "FT-1 Feature", "System.Description": "Feature details" }, relations: [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: parentUrl(2) }] };
    else if (url.includes("workitems/2?")) value = { id: 2, rev: 1, fields: { "System.WorkItemType": "Epic", "System.Title": "EPIC QA Quality", "System.Description": "Epic details" }, relations: [] };
    else throw new Error(`Unexpected ADO URL: ${url}`);
    return new Response(JSON.stringify(value), { status: 200 });
  };
  try {
    const stories = await new Ado(fetcher as typeof fetch).sprintStories("QA\\Sprint 1");
    assert.equal(stories[0]?.text, 'Returns {"items": []} & succeeds.');
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

test("reset deletes only pipeline review Tasks before clearing the graph", async () => {
  const previous = { org: process.env.ADO_ORG_URL, project: process.env.ADO_PROJECT, pat: process.env.ADO_PAT };
  process.env.ADO_ORG_URL = "https://dev.azure.com/example";
  process.env.ADO_PROJECT = "QA";
  process.env.ADO_PAT = "test-token";
  const events: string[] = [];
  const runId = randomUUID();
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes("wiql?")) return new Response(JSON.stringify({ workItems: [{ id: 10 }, { id: 11 }, { id: 12 }] }));
    if (init?.method === "DELETE") {
      events.push(`delete ${url.match(/workitems\/(\d+)/)?.[1]}`);
      return new Response(null, { status: 204 });
    }
    const id = Number(url.match(/workitems\/(\d+)/)?.[1]);
    const fields = id === 10
      ? { "System.WorkItemType": "Task", "System.Title": `[QA relation ${runId}] ${"a".repeat(16)}`, "System.Tags": "qa-relation-review" }
      : id === 11
        ? { "System.WorkItemType": "Task", "System.Title": `[QA test ${runId}] ${"b".repeat(16)}`, "System.Tags": "qa-test-review" }
        : { "System.WorkItemType": "Task", "System.Title": "Unrelated Task", "System.Tags": "qa-test-review" };
    return new Response(JSON.stringify({ id, fields }));
  };
  try {
    const ado = new Ado(fetcher as typeof fetch);
    const pipeline = new QaPipeline({
      graph: () => ({ setup: async () => { events.push("setup"); }, deleteAll: async () => { events.push("graph"); return 7; } }) as GraphStore,
      model: () => ({ json: async () => ({}) }),
      workItems: () => ado,
      sprintWorkItems: () => ado,
    });
    assert.deepEqual(await pipeline.resetAll(), { deletedTasks: 2, deletedGraphNodes: 7 });
    assert.deepEqual(events, ["setup", "delete 10", "delete 11", "graph"]);
  } finally {
    if (previous.org === undefined) delete process.env.ADO_ORG_URL; else process.env.ADO_ORG_URL = previous.org;
    if (previous.project === undefined) delete process.env.ADO_PROJECT; else process.env.ADO_PROJECT = previous.project;
    if (previous.pat === undefined) delete process.env.ADO_PAT; else process.env.ADO_PAT = previous.pat;
  }
});

test("reset keeps the graph when an ADO Task cannot be deleted", async () => {
  const previous = { org: process.env.ADO_ORG_URL, project: process.env.ADO_PROJECT, pat: process.env.ADO_PAT };
  process.env.ADO_ORG_URL = "https://dev.azure.com/example";
  process.env.ADO_PROJECT = "QA";
  process.env.ADO_PAT = "test-token";
  let graphDeleted = false;
  const runId = randomUUID();
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes("wiql?")) return new Response(JSON.stringify({ workItems: [{ id: 10 }] }));
    if (init?.method === "DELETE") return new Response("forbidden", { status: 403 });
    return new Response(JSON.stringify({ fields: {
      "System.WorkItemType": "Task",
      "System.Title": `[QA relation ${runId}] ${"a".repeat(16)}`,
      "System.Tags": "qa-relation-review",
    } }));
  };
  try {
    const ado = new Ado(fetcher as typeof fetch);
    const pipeline = new QaPipeline({
      graph: () => ({ setup: async () => {}, deleteAll: async () => { graphDeleted = true; return 1; } }) as GraphStore,
      model: () => ({ json: async () => ({}) }),
      workItems: () => ado,
      sprintWorkItems: () => ado,
    });
    await assert.rejects(pipeline.resetAll(), /ADO Task 10 deletion failed: 403/);
    assert.equal(graphDeleted, false);
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

test("a correction with the same type and direction approves only after the graph write", async () => {
  const story = { id: "ST-1", adoId: 1, title: "Story", text: "Warehouse", areaPath: "QA", iterationPath: "QA\\Sprint 1" };
  const relation: Run["relations"][number] = {
    id: "edge", sourceId: story.id, sourceType: "Story", targetId: "BusinessEntity:warehouse", targetType: "BusinessEntity",
    type: "MENTIONS", evidence: "Warehouse", confidence: 0.8, reason: "review", source: story.id,
    storyIds: [story.id], state: "needs_review", tasks: { [story.id]: { id: 1, hash: "hash" } }, decisions: [],
  };
  const run: Run = { id: randomUUID(), status: "review_relations", stories: [story], relations: [relation], artifacts: [], specs: [], errors: [], createdAt: "2026-01-01" };
  const ado = { decision: async () => ({ action: "correct" as const, reviewer: "Ada", reason: "Same relationship", type: "MENTIONS", reverse: false, taskId: 1, at: "now" }) } as WorkItemClient;
  let fail = true;
  const graph = { decide: async (item: Run["relations"][number]) => {
    assert.equal(item.decisions[0]?.action, "approve");
    if (fail) throw new Error("graph write failed");
  } } as unknown as GraphStore;
  try {
    await assert.rejects(applyReviews(run, ado, graph), /graph write failed/);
    assert.equal(relation.state, "needs_review");
    assert.equal(relation.decisions.length, 0);
    fail = false;
    assert.deepEqual(await applyReviews(run, ado, graph), { pending: 0, conflicts: 0, applied: 1 });
    assert.equal(relation.state, "approved");
    assert.equal(relation.decisions[0]?.action, "approve");
    assert.equal(run.status, "ready_design");
  } finally {
    await fs.rm(runPath(run.id), { recursive: true, force: true });
  }
});

test("a deleted relationship review Task is recreated without restarting ingestion", async () => {
  const previous = { org: process.env.ADO_ORG_URL, project: process.env.ADO_PROJECT, pat: process.env.ADO_PAT };
  process.env.ADO_ORG_URL = "https://dev.azure.com/example";
  process.env.ADO_PROJECT = "QA";
  process.env.ADO_PAT = "test-token";
  const story = { id: "ST-1", adoId: 41, title: "Story", text: "GET /warehouses", areaPath: "QA", iterationPath: "QA\\Sprint 1" };
  const run: Run = {
    id: randomUUID(), status: "review_relations", stories: [story], artifacts: [], specs: [], errors: [], createdAt: "2026-01-01",
    relations: [{ id: "edge", sourceId: story.id, sourceType: "Story", targetId: "Endpoint:one", targetType: "Endpoint", type: "AFFECTS", evidence: story.text, confidence: 0.8, reason: "review", source: story.id, storyIds: [story.id], state: "needs_review", tasks: { [story.id]: { id: 2833, hash: "old" } }, decisions: [] }],
  };
  let created = 0;
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes("workitems/2833?")) return new Response("deleted", { status: 404 });
    if (url.includes("workitems/41?")) return new Response(JSON.stringify({ fields: { "System.AreaPath": "QA", "System.IterationPath": "QA\\Sprint 1" } }));
    if (url.includes("wiql?")) return new Response(JSON.stringify({ workItems: [] }));
    if (url.includes("workitems/$Task?") && init?.method === "POST") { created += 1; return new Response(JSON.stringify({ id: 2900 })); }
    throw new Error(`Unexpected ADO request: ${url}`);
  };
  try {
    const graph = { decide: async () => { throw new Error("No decision expected"); } } as unknown as GraphStore;
    const result = await applyReviews(run, new Ado(fetcher as typeof fetch), graph);
    assert.deepEqual(result, { pending: 1, conflicts: 0, applied: 0 });
    assert.equal(created, 1);
    assert.equal(run.relations[0]?.tasks[story.id]?.id, 2900);
    assert.equal(run.status, "review_relations");
  } finally {
    await fs.rm(runPath(run.id), { recursive: true, force: true });
    if (previous.org === undefined) delete process.env.ADO_ORG_URL; else process.env.ADO_ORG_URL = previous.org;
    if (previous.project === undefined) delete process.env.ADO_PROJECT; else process.env.ADO_PROJECT = previous.project;
    if (previous.pat === undefined) delete process.env.ADO_PAT; else process.env.ADO_PAT = previous.pat;
  }
});

test("a deleted test artifact review Task is recreated and remains pending", async () => {
  const story = { id: "ST-1", adoId: 41, title: "Story", text: "evidence", areaPath: "QA", iterationPath: "QA\\Sprint 1" };
  const artifact = { id: "TestCase:one", kind: "TestCase" as const, name: "Case", storyId: story.id, content: { expected: "result" }, hash: hash({ expected: "result" }), reviewTask: { id: 2833, hash: "old" } };
  const run: Run = { id: randomUUID(), status: "review_artifacts", stories: [story], relations: [], artifacts: [artifact], specs: [], errors: [], createdAt: "2026-01-01" };
  const workItems = {
    artifactDecision: async () => "missing" as const,
    artifactTask: async () => ({ id: 2900, hash: "new" }),
  } as SprintWorkItemClient;
  try {
    assert.deepEqual(await applyArtifactReviews(run, workItems), { pending: 1, rejected: 0, approved: 0 });
    assert.deepEqual(artifact.reviewTask, { id: 2900, hash: "new" });
    assert.equal(run.status, "review_artifacts");
  } finally {
    await fs.rm(runPath(run.id), { recursive: true, force: true });
  }
});

test("a rebuilt Task ID stays in the Story pipeline when a later review fails", async () => {
  const story = { id: "ST-1", adoId: 41, title: "Story", text: "evidence", areaPath: "QA", iterationPath: "QA\\Sprint 1" };
  const makeRelation = (id: string, taskId: number) => ({
    id, sourceId: story.id, sourceType: "Story" as const, targetId: `Endpoint:${id}`, targetType: "Endpoint" as const,
    type: "AFFECTS", evidence: "evidence", confidence: 0.8, reason: "review", source: story.id,
    storyIds: [story.id], state: "needs_review" as const, tasks: { [story.id]: { id: taskId, hash: "hash" } }, decisions: [],
  });
  const run: Run = { id: randomUUID(), status: "review_relations", stories: [story], relations: [makeRelation("first", 1), makeRelation("second", 2)], artifacts: [], specs: [], errors: [], createdAt: "2026-01-01" };
  let saved: StoryPipelineRecord | undefined;
  const record: StoryPipelineRecord = { version: 4, adoId: story.adoId, revision: 1, iterationPath: story.iterationPath, story, stage: "review_relations", status: "active", run, updatedAt: "2026-01-01" };
  const graph = {
    storyPipeline: async () => record,
    saveStoryPipeline: async (value: StoryPipelineRecord) => { saved = structuredClone(value); },
  } as unknown as GraphStore;
  const workItems = {
    decision: async (id: number) => { if (id === 1) return "missing" as const; throw new Error("Later review failed"); },
    task: async () => ({ id: 3, hash: "new" }),
  } as SprintWorkItemClient;
  try {
    await assert.rejects(new StoryPipeline(graph, () => ({ json: async () => ({}) }), workItems).advanceStory(story.adoId), /Later review failed/);
    assert.equal(saved?.run?.relations[0]?.tasks[story.id]?.id, 3);
    assert.equal(saved?.stage, "review_relations");
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
    : authorReply(prompt, "ST-1", "GET /warehouses returns 200.", { method: "GET", path: "/warehouses", expectedStatus: 200 }),
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
    assert.ok(run.artifacts.length >= 4);
    await assert.rejects(ingestDesign(run, graph), /awaiting review/);
    for (const item of run.artifacts) await approveArtifact(run, item.id, "Ada");
    await ingestDesign(run, graph);
    assert.equal(run.status, "ready_specs");
    const target: Target = { projectDir: project, baseUrl: "http://localhost:3000", safeEnvironments: ["http://localhost:3000"], routes: [{ method: "GET", path: "/warehouses", responses: [200] }] };
    await setupTarget(project);
    const targetFile = path.join(temporary, "target.json");
    await fs.writeFile(targetFile, JSON.stringify(target));
    await generateSpecs(run, await loadTarget(targetFile), undefined, statusModel, graph);
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
    assert.equal(writes.filter((value) => value.startsWith("Test")).length, run.artifacts.length);
  } finally {
    if (run) await fs.rm(runPath(run.id), { recursive: true, force: true });
    if (temporary.startsWith(path.resolve(os.tmpdir()) + path.sep)) await fs.rm(temporary, { recursive: true, force: true });
  }
});
