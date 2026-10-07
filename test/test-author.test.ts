import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import ExcelJS from "exceljs";
import type { GraphStore, ModelClient, SprintWorkItemClient } from "../src/contracts.js";
import { randomUUID } from "node:crypto";
import { runPath, saveRun, type Run, type StoryPipelineRecord } from "../src/core/runtime.js";
import { StoryPipeline } from "../src/story-pipeline.js";
import { authorStory, parseAcceptanceCriteria, planTargets, type AuthorContext } from "../src/stages/test-author.js";
import { exportAuthorReport } from "../src/stages/test-author-export.js";

const story = { id: "ST-1", adoId: 1, title: "Create warehouse", text: "AC-1: Create a warehouse. AC-2: Reject a duplicate warehouse.",
  areaPath: "QA", iterationPath: "QA\\Sprint 2" };

function context(): AuthorContext {
  return { story, sources: [{ id: story.id, kind: "Story", title: story.title, text: story.text }],
    criteria: parseAcceptanceCriteria(story.text), nodes: [
      { id: "Endpoint:post-warehouses", nodeType: "Endpoint", canonicalName: "POST /warehouses", properties: {}, description: "Create a warehouse." },
      { id: "OLD-1", nodeType: "Story", canonicalName: "Earlier warehouse", properties: { iterationPath: "QA\\Sprint 1" } },
      { id: "TestScenario:existing", nodeType: "TestScenario", canonicalName: "Validate warehouse API", properties: {} },
      { id: "TestCase:existing", nodeType: "TestCase", canonicalName: "Validate API contract", properties: {} },
    ], edges: [
      { sourceId: story.id, targetId: "Endpoint:post-warehouses", relationshipType: "MENTIONS" },
      { sourceId: "OLD-1", targetId: "Endpoint:post-warehouses", relationshipType: "MENTIONS" },
      { sourceId: "TestScenario:existing", targetId: "Endpoint:post-warehouses", relationshipType: "EXERCISES" },
      { sourceId: "TestCase:existing", targetId: "TestScenario:existing", relationshipType: "COVERS" },
    ] };
}

function model(options: { omitCriterion?: boolean; badReferenceOnce?: boolean } = {}): { client: ModelClient; calls: string[] } {
  const calls: string[] = [];
  let bad = options.badReferenceOnce ?? false;
  const client: ModelClient = { json: async (prompt) => {
    calls.push(prompt);
    if (prompt.startsWith("Author plan")) {
      const types = prompt.match(/Candidate types: ([^.]+)\. Choose/)?.[1]?.split(", ") ?? [];
      return { objective: "Verify warehouse creation", scopeSummary: story.text,
        inScope: [{ nodeId: story.id, reason: story.text }], approaches: types.map((testType) => ({ testType,
          purpose: "Verify behavior", focus: story.text, entryCriteria: ["Ready"], exitCriteria: ["Pass"] })) };
    }
    if (prompt.startsWith("Author scenarios")) {
      const type = prompt.match(/Author scenarios for (\w+)/)?.[1];
      const targets = JSON.parse(prompt.match(/Targets: (\[.*?\])\. Existing graph scenarios:/s)?.[1] ?? "[]") as Array<{ id: string; criterion?: string }>;
      if (type === "integration" || type === "regression") return { reusedScenarios: [{ id: "TestScenario:existing", targetIds: targets.map((item) => item.id) }] };
      const targetIds = bad ? ["Unknown:node"] : targets.map((item) => item.id);
      bad = false;
      return { newScenarios: [{ name: `Validate ${type} warehouse result`, description: story.text,
        expectedOutcome: "Warehouse outcome is observable", priority: "medium", evidence: "Create a warehouse.", sourceId: `${story.id}#1`,
        category: "normal", riskRationale: "Warehouse creation could fail",
        targetIds, acceptanceCriteria: targets.flatMap((item) => item.criterion ? [item.criterion] : []),
        coversNodeIds: [], exercisesNodeIds: [] }] };
    }
    if (prompt.startsWith("Author test cases")) {
      if (prompt.includes("TestScenario:existing")) return { reusedCaseIds: ["TestCase:existing"] };
      const type = prompt.match(/Author test cases for (\w+)/)?.[1];
      const scenario = JSON.parse(prompt.match(/scenario (\{.*?\})\. Return JSON/s)?.[1] ?? "{}") as { acceptanceCriteria?: string[] };
      return { newCases: [{ name: `Validate ${type} warehouse outcome`, objective: story.text, caseKind: "positive", priority: "medium",
        preconditions: [], testData: [], steps: [{ action: "Create warehouse", expectedResult: "Warehouse outcome is observable", expectedResultEvidence: "Create a warehouse." }],
        acceptanceCriteria: options.omitCriterion ? [] : scenario.acceptanceCriteria ?? [], validatesNodeIds: [], exercisesNodeIds: [],
        automationCandidate: false, automationNotes: "Manual", evidence: "Create a warehouse.", sourceId: `${story.id}#1` }] };
    }
    throw new Error(`Unexpected prompt: ${prompt.slice(0, 70)}`);
  } };
  return { client, calls };
}

test("author planner assesses six types and reuses approved graph coverage", async () => {
  const source = context();
  assert.deepEqual(source.criteria.map((item) => item.label), ["AC-1", "AC-2"]);
  const targets = planTargets(source);
  assert.equal(targets.functional.length, 2);
  assert.equal(targets.integration.length, 1);
  assert.equal(targets.regression.length, 1);
  assert.equal(targets.e2e.length, 0);
  assert.equal(targets.smoke.length, 0);
  const { report, artifacts } = await authorStory(source, model().client);
  assert.deepEqual(report.inapplicable, ["e2e", "smoke"]);
  assert.deepEqual(report.gaps, []);
  assert.deepEqual(report.failedBatches, []);
  assert.equal(report.coverage.acceptanceCriteria.covered, 2);
  assert.equal(report.cases.filter((item) => item.origin === "existingInGraph").length, 1);
  assert.ok(artifacts.some((item) => item.kind === "TestSuite" && item.content.reusedScenarioIds instanceof Array));
  assert.ok(!artifacts.some((item) => item.id === "TestScenario:existing" || item.id === "TestCase:existing"));
});

test("integration targets require a direct Story link", () => {
  const source = context();
  source.story.parents = [{ id: "FEAT-1", kind: "Feature", title: "Warehouse feature", text: "Read warehouses" }];
  source.nodes.push({ id: "Endpoint:get-warehouses", nodeType: "Endpoint", canonicalName: "GET /warehouses", properties: {} });
  source.edges.push({ sourceId: "FEAT-1", targetId: "Endpoint:get-warehouses", relationshipType: "MENTIONS" });
  assert.deepEqual(planTargets(source).integration.map((target) => target.id), ["Endpoint:post-warehouses"]);
});

test("case prompt states the valid graph references and scenario target IDs", async () => {
  const prompts = model();
  await authorStory(context(), prompts.client);
  const scenarioPrompt = prompts.calls.find((prompt) => prompt.startsWith("Author scenarios for functional"));
  const casePrompt = prompts.calls.find((prompt) => prompt.startsWith("Author test cases for functional"));
  assert.match(scenarioPrompt ?? "", /targetIds must copy only these exact IDs/);
  assert.match(casePrompt ?? "", /validatesNodeIds may contain only/);
  assert.match(casePrompt ?? "", /A Story is linked by its acceptance criteria/);
  assert.match(casePrompt ?? "", /Endpoint, Operation, and Module IDs belong in exercisesNodeIds/);
});

test("the plan can exclude a candidate suite with a recorded reason", async () => {
  const base = model().client;
  const client: ModelClient = { json: async (prompt, output) => {
    const response = await base.json(prompt, output) as Record<string, unknown>;
    if (!prompt.startsWith("Author plan")) return response;
    return { ...response, approaches: (response.approaches as Array<{ testType: string }>).filter((item) => item.testType !== "integration"),
      inapplicable: [{ testType: "integration", reason: "Only an endpoint name is mentioned; no interaction is specified" }] };
  } };
  const { report, artifacts } = await authorStory(context(), client);
  assert.deepEqual(report.failedBatches, []);
  assert.ok(report.inapplicable.includes("integration"));
  assert.match(report.inapplicableReasons.integration ?? "", /Only an endpoint name/);
  assert.ok(!report.suites.some((suite) => suite.testType === "integration"));
  assert.ok(artifacts.some((item) => item.kind === "TestPlan" &&
    (item.content.inapplicableReasons as Record<string, string>).integration.includes("Only an endpoint name")));
});

test("author retries unsupported source references and vague expected results", async () => {
  const base = model().client;
  const prompts: string[] = [];
  const client: ModelClient = { json: async (prompt, output) => {
    prompts.push(prompt);
    const response = await base.json(prompt, output) as Record<string, unknown>;
    if (!prompt.includes("Previous JSON") && prompt.startsWith("Author scenarios for functional")) {
      const items = response.newScenarios as Array<Record<string, unknown>>;
      return { ...response, newScenarios: items.map((item) => ({ ...item, sourceId: "missing-source" })) };
    }
    if (!prompt.includes("Previous JSON") && prompt.startsWith("Author test cases for functional")) {
      const items = response.newCases as Array<Record<string, unknown>>;
      return { ...response, newCases: items.map((item) => ({ ...item, steps: [
        { action: "Create warehouse", expectedResult: "Works correctly", expectedResultEvidence: "unsupported outcome" },
      ] })) };
    }
    return response;
  } };
  const { report } = await authorStory(context(), client);
  assert.deepEqual(report.failedBatches, []);
  assert.ok(prompts.some((prompt) => prompt.includes("Unsupported scenario evidence missing-source")));
  assert.ok(prompts.some((prompt) => prompt.includes("Unsupported expected result evidence") && prompt.includes("Unobservable expected result")));
});

test("the design report carries source and outcome evidence into the workbook", async () => {
  const source = context();
  const { report, artifacts } = await authorStory(source, model().client);
  const run: Run = { id: randomUUID(), status: "ready_design", stories: [story], relations: [], artifacts, specs: [],
    errors: [], createdAt: "2026-01-01" };
  try {
    const files = await exportAuthorReport(run, source, report, 1);
    const design = JSON.parse(await fs.readFile(files.json, "utf8")) as { scenarios: Array<{ sourceId: string }>; cases: Array<{ sourceId: string }> };
    assert.ok(design.scenarios.some((item) => item.sourceId === `${story.id}#1`));
    assert.ok(design.cases.some((item) => item.sourceId === `${story.id}#1`));
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(files.workbook);
    const scenarioHeaders = book.getWorksheet("Scenarios")!.getRow(1).values as string[];
    const caseHeaders = book.getWorksheet("functional cases")!.getRow(1).values as string[];
    assert.ok(scenarioHeaders.includes("Source ID"));
    assert.ok(caseHeaders.includes("Expected result evidence"));
  } finally {
    await fs.rm(runPath(run.id), { recursive: true, force: true });
  }
});

test("author retries malformed plan and scenario JSON using the previous response", async () => {
  const base = model().client;
  const prompts: string[] = [];
  const schemas: string[] = [];
  const client: ModelClient = { json: async (prompt, output) => {
    prompts.push(prompt);
    if (output?.schema.type === "object") schemas.push(output.name);
    const valid = await base.json(prompt) as Record<string, unknown>;
    if (!prompt.includes("Previous JSON") && prompt.startsWith("Author plan")) {
      return { ...valid, outOfScope: ["Editing warehouses"],
        approaches: (valid.approaches as Array<Record<string, unknown>>).map((item) => ({ ...item, focus: [story.text] })) };
    }
    if (!prompt.includes("Previous JSON") && prompt.startsWith("Author scenarios for functional")) {
      return { newScenarios: [{ name: "Validate warehouse creation", description: story.text,
        expectedOutcome: "Warehouse created", priority: "urgent", evidence: ["Create a warehouse."],
        targetIds: ["ST-1 AC-1", "ST-1 AC-2"], acceptanceCriteria: "AC-1, AC-2", coversNodeIds: [], exercisesNodeIds: [] }] };
    }
    return valid;
  } };
  const { report } = await authorStory(context(), client);
  assert.deepEqual(report.failedBatches, []);
  assert.deepEqual(report.gaps, []);
  assert.equal(report.coverage.acceptanceCriteria.covered, 2);
  assert.ok(prompts.some((prompt) => prompt.includes('Previous JSON: {"objective"') && prompt.includes("outOfScope.0")));
  assert.ok(prompts.some((prompt) => prompt.includes('Previous JSON: {"newScenarios"') && prompt.includes("newScenarios.0.priority")));
  assert.ok(schemas.includes("test_plan") && schemas.includes("test_scenarios") && schemas.includes("test_cases"));
});

test("author planner includes integration flows, contracts, and state transitions", () => {
  const source = context();
  source.nodes.push(
    { id: "IntegrationFlow:sales-sync", nodeType: "IntegrationFlow", canonicalName: "Sales Sync", properties: {} },
    { id: "DataContract:order-payload", nodeType: "DataContract", canonicalName: "Order Payload", properties: {} },
    { id: "WorkflowStep:confirm-order", nodeType: "WorkflowStep", canonicalName: "Confirm order", properties: {} },
    { id: "StateTransition:confirm", nodeType: "StateTransition", canonicalName: "Confirm", properties: {} },
  );
  for (const id of ["IntegrationFlow:sales-sync", "DataContract:order-payload", "WorkflowStep:confirm-order", "StateTransition:confirm"]) {
    source.edges.push({ sourceId: story.id, targetId: id, relationshipType: "MENTIONS" });
  }
  source.edges.push({ sourceId: "OLD-1", targetId: "IntegrationFlow:sales-sync", relationshipType: "MENTIONS" });

  const targets = planTargets(source);
  assert.ok(targets.integration.some((target) => target.id === "IntegrationFlow:sales-sync"));
  assert.ok(targets.integration.some((target) => target.id === "DataContract:order-payload"));
  assert.ok(targets.e2e.some((target) => target.id === "WorkflowStep:confirm-order"));
  assert.ok(targets.e2e.some((target) => target.id === "StateTransition:confirm"));
  assert.ok(targets.functional.some((target) => target.id === "StateTransition:confirm"));
  assert.ok(targets.regression.some((target) => target.id === "IntegrationFlow:sales-sync"));
  assert.ok(!targets.smoke.some((target) => target.id === "StateTransition:confirm"));
});

test("invalid references are corrected, and uncovered criteria block all review artifacts", async () => {
  const corrected = model({ badReferenceOnce: true });
  const result = await authorStory(context(), corrected.client);
  assert.ok(corrected.calls.some((prompt) => prompt.includes("Unknown target Unknown:node")));
  assert.equal(result.report.failedBatches.length, 0);
  const incomplete = await authorStory(context(), model({ omitCriterion: true }).client);
  assert.deepEqual(incomplete.report.coverage.acceptanceCriteria.uncovered, ["AC-1", "AC-2"]);
  assert.equal(incomplete.artifacts.length, 0);
});

test("blocked design requires explicit retry and preserves its run", async () => {
  const run: Run = { id: randomUUID(), status: "design_gap", stories: [story], relations: [], artifacts: [], specs: [],
    designAttempt: 1, errors: [], createdAt: "2026-01-01" };
  const record: StoryPipelineRecord = { version: 4, adoId: 1, revision: 1, story, iterationPath: story.iterationPath,
    stage: "design_gap", status: "blocked", run, updatedAt: "2026-01-01" };
  const graph = { storyPipeline: async () => record, saveStoryPipeline: async () => {} } as unknown as GraphStore;
  const pipeline = new StoryPipeline(graph, () => model().client, {} as SprintWorkItemClient);
  try {
    assert.equal((await pipeline.advanceStory(1)).action, "blocked");
    assert.equal(run.designAttempt, 1);
    await pipeline.retryDesign(1);
    assert.equal(record.stage, "ready_design");
    assert.equal(record.run?.id, run.id);
    assert.equal(record.run?.status, "ready_design");
  } finally {
    await fs.rm(runPath(run.id), { recursive: true, force: true });
  }
});

test("blocked mapping can start a new attempt without deleting its failed run", async () => {
  const run: Run = { id: randomUUID(), status: "mapping_error", stories: [story], relations: [], artifacts: [], specs: [],
    errors: ["ST-1: invalid connections schema"], createdAt: "2026-01-01" };
  const record: StoryPipelineRecord = { version: 4, adoId: 1, revision: 1, story, iterationPath: story.iterationPath,
    stage: "mapping_error", status: "blocked", run, updatedAt: "2026-01-01" };
  const graph = { storyPipeline: async () => record, saveStoryPipeline: async () => {} } as unknown as GraphStore;
  const pipeline = new StoryPipeline(graph, () => model().client, {} as SprintWorkItemClient);
  try {
    await saveRun(run);
    assert.equal((await pipeline.advanceStory(1)).action, "blocked");
    assert.equal(await pipeline.retryMapping(1), run.id);
    assert.equal(record.stage, "discovered");
    assert.equal(record.status, "active");
    assert.equal(record.run, undefined);
    assert.equal(JSON.parse(await fs.readFile(`${runPath(run.id)}/run.json`, "utf8")).status, "mapping_error");
    await assert.rejects(pipeline.retryMapping(1), /no blocked graph mapping/);
  } finally {
    await fs.rm(runPath(run.id), { recursive: true, force: true });
  }
});
