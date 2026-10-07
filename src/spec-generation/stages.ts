import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { hash, runPath, saveRun, type Artifact, type Run } from "../core/runtime.js";
import type { GraphStore, ModelClient } from "../contracts.js";
import { loadTargetConfig, type TargetConfig } from "./config/targetConfig.js";
import { emptyCatalogue, type ApiOperation, type EvidenceCatalogue } from "./evidence/catalogue.js";
import { collectOpenApiEvidence } from "./evidence/openapiProvider.js";
import { createDbPort } from "./evidence/dbPort.js";
import { loadUiContract } from "./evidence/uiContract.js";
import { exploreScreen } from "./evidence/uiExplorer.js";
import { obligationsFor } from "./ingest/obligations.js";
import { TestIrSchema, type PlannedCase } from "./ir/testIr.js";
import { validateIr } from "./ir/irPolicy.js";
import type { LlmClient } from "./llm/llmClient.js";
import { ConsoleLogger } from "./logging/logger.js";
import type { NormalisedCase } from "./model/testCase.js";
import { IrProposer } from "./plan/irProposer.js";
import { atomicWriteJson } from "./output/atomicWrite.js";
import { writeGenerated } from "./output/specWriter.js";
import { renderApiObjects, renderApiSpec, renderRoutes } from "./render/renderer.js";
import { renderDbSupport } from "./render/dbSupport.js";
import { renderScreens } from "./render/uiSupport.js";
import { fixtureSource, observationSource, uniqueDataSource, configSource } from "./support.js";

export type CaseSnapshot = { artifact: Artifact; contentHash: string; testCase: NormalisedCase; graphContext: string };
export type SpecPlan = { snapshot: CaseSnapshot; planned: PlannedCase; failure?: string };
export type SpecBatch = {
  version: 1; id: string; runId: string; createdAt: string; directory: string; config: string;
  target: TargetConfig; evidence: EvidenceCatalogue; plans: SpecPlan[];
  files: Array<{ file: string; hash: string }>; collection?: { code: number; stdout: string; stderr: string };
  parentBatch?: number; repairAttempt?: number;
};

export function modelBridge(model: ModelClient, name = "configured-model"): LlmClient {
  return { model: name, complete: async (messages, label) => {
    if (model.complete) return model.complete(messages, label);
    return { content: JSON.stringify(await model.json(messages.map(item => `${item.role}: ${item.content}`).join("\n\n"))) };
  } };
}

export function normalizeCase(artifact: Artifact, artifacts: Artifact[]): NormalisedCase {
  const content = artifact.content as Record<string, any>;
  const scenario = artifacts.find(item => item.id === artifact.parentId);
  const steps = (content.steps ?? []).map((step: string | Record<string, any>, index: number) => ({
    stepNumber: index + 1, action: typeof step === "string" ? step : String(step.action ?? ""),
    expectedResult: typeof step === "string" ? (index === content.steps.length - 1 ? String(content.expected ?? "") : "") : String(step.expectedResult ?? ""),
  }));
  if (!steps.length) steps.push({ stepNumber: 1, action: String(content.objective ?? artifact.name), expectedResult: String(content.expected ?? "") });
  const refs = (values: string[] = []) => values.map(nodeId => ({ nodeId, nodeType: nodeId.split(":")[0], name: nodeId.split(":").slice(1).join(":") || nodeId }));
  const key = artifact.id.replace(/^TestCase:/, "");
  return { caseId: artifact.id, key, name: artifact.name, objective: String(content.objective ?? content.description ?? artifact.name),
    caseKind: String(content.caseKind ?? "positive"), priority: String(content.priority ?? "medium"),
    testTypes: [String(content.testType ?? content.suiteType ?? "functional")], suites: [], stories: [artifact.storyId],
    scenario: { nodeId: scenario?.id ?? artifact.parentId ?? "", name: scenario?.name ?? "", description: String((scenario?.content as any)?.description ?? ""), exercises: [], covers: [] },
    preconditions: content.preconditions ?? [], testData: content.testData ?? [], steps,
    exercises: refs(content.exercisesNodeIds ?? content.exercises), validates: refs(content.validatesNodeIds ?? content.validates), automationCandidate: content.automationCandidate !== false,
    automationNotes: content.automationNotes, obligations: obligationsFor(artifact.id, key, steps) };
}

export async function collectEvidence(target: TargetConfig): Promise<EvidenceCatalogue> {
  const catalogue = emptyCatalogue(target.name);
  const sources = [...(target.openapi ? [target.openapi] : []), ...(target.openapiSources ?? [])];
  for (const source of sources) {
    const evidence = await collectOpenApiEvidence({ ...target, openapi: source });
    for (const operation of evidence.operations) {
      if (catalogue.api.some(item => item.operationId === operation.operationId)) throw new Error(`Duplicate operation ID ${operation.operationId}`);
      catalogue.api.push(operation);
    }
    catalogue.auth.push(...evidence.auth);
  }
  if (!sources.length) {
    for (const route of target.routes) {
      catalogue.api.push({ id: `api:legacy-${catalogue.api.length + 1}`, operationId: `legacy-${catalogue.api.length + 1}`, layer: "api",
        method: route.method.toLowerCase() as ApiOperation["method"], pathTemplate: route.path, parameters: [],
        responses: route.responses.map(status => ({ status, fields: [] })), secured: route.requiresAuth ?? false,
        provenance: { source: target.file, collectedAt: catalogue.collectedAt, contentHash: hash(route), pointer: `#/routes/${catalogue.api.length}` } });
    }
    catalogue.absent.push({ layer: "api", reason: "Legacy routes establish paths and statuses only; parameters, request bodies, response fields and auth mechanisms require OpenAPI evidence." });
  }
  if (target.db) {
    const database = createDbPort(target.db, target.file);
    try { catalogue.db = await database.introspect(); } finally { await database.close(); }
  } else catalogue.absent.push({ layer: "db", reason: "No SQLite target database configured" });
  if (target.uiContract) catalogue.ui = loadUiContract(target.uiContract, target.file);
  else catalogue.absent.push({ layer: "ui", reason: "No approved UI contract configured" });
  for (const screen of catalogue.ui) {
    const base = target.uiBaseUrl ?? target.baseUrl;
    if (new URL(screen.url, base).origin !== new URL(base).origin) throw new Error(`UI contract ${screen.name} leaves the approved origin`);
  }
  return catalogue;
}

export function batchFile(runId: string, number: number): string { return path.join(runPath(runId), "spec-batches", String(number), "manifest.json"); }
export async function readBatch(run: Run, number = run.specBatches?.length ?? 0): Promise<SpecBatch> {
  if (!Number.isInteger(number) || number < 1) throw new Error("A valid batch number is required");
  try { return JSON.parse(await fs.readFile(batchFile(run.id, number), "utf8")); }
  catch (error) {
    const snapshot = run.specBatches?.[number - 1]?.snapshot;
    if (!snapshot) throw error;
    atomicWriteJson(batchFile(run.id, number), snapshot);
    return snapshot as SpecBatch;
  }
}

export async function planSpecs(run: Run, target: TargetConfig, model: ModelClient, graph?: GraphStore, caseIds?: string[]): Promise<SpecBatch> {
  if (run.status !== "ready_specs") throw new Error("Approved design must be ingested before spec planning");
  const number = (run.specBatches?.length ?? 0) + 1;
  const directory = `tests/generated/${run.id}/batch-${number}`;
  const evidence = await collectEvidence(target);
  const batch: SpecBatch = { version: 1, id: `${run.id}/batch-${number}`, runId: run.id, createdAt: new Date().toISOString(),
    directory, config: `${directory}/playwright.config.ts`, target, evidence, plans: [], files: [] };
  const proposer = new IrProposer(modelBridge(model), new ConsoleLogger(), 3);
  for (const artifact of run.artifacts.filter(item => item.kind === "TestCase" && (!caseIds || caseIds.includes(item.id)))) {
    if (!artifact.reviewer || !artifact.approvedAt || artifact.hash !== hash(artifact.content)) throw new Error(`Case ${artifact.id} has no current approval`);
    const managed = graph?.managedTestCases ? (await graph.managedTestCases()).find(item => item.id === artifact.id) : undefined;
    if (graph?.managedTestCases && (!managed || managed.contentHash !== artifact.hash)) throw new Error(`Graph case revision differs for ${artifact.id}`);
    const testCase = normalizeCase(artifact, run.artifacts);
    const graphContext = graph ? await graph.storyContext(artifact.storyId) : "No graph context available";
    const snapshot: CaseSnapshot = { artifact: structuredClone(artifact), contentHash: artifact.hash, testCase, graphContext };
    const outcome = testCase.automationCandidate ? await proposer.propose(testCase, evidence, graphContext) : { planned: undefined, failure: "Approved case is manual only" };
    const planned: PlannedCase = outcome.planned ?? { attempts: 0, gaps: [outcome.failure ?? "No accepted plan"],
      ir: { caseId: artifact.id, layer: "api", ops: [{ id: "unavailable", kind: "auth.unavailable", evidenceRefs: [], reason: outcome.failure ?? "No supported bindings" }], assertions: [],
        unautomatable: testCase.obligations.map(item => ({ obligation: item.id, reason: outcome.failure ?? "No supported binding" })) } };
    // Evidence gaps must never turn unsupported promises into executable passing tests.
    if (planned.gaps.length) for (const obligation of testCase.obligations) {
      if (!planned.ir.unautomatable.some(item => item.obligation === obligation.id)) planned.ir.unautomatable.push({ obligation: obligation.id, reason: planned.gaps.join("; ") });
    }
    batch.plans.push({ snapshot, planned, failure: outcome.failure });
    atomicWriteJson(batchFile(run.id, number), batch);
  }
  if (!batch.plans.length) throw new Error("No approved cases selected");
  atomicWriteJson(batchFile(run.id, number), batch);
  return batch;
}

export async function runPlaywright(project: string, args: string[], env = process.env): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["--no-install", "playwright", "test", ...args], { cwd: project, env, shell: process.platform === "win32" });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
    child.on("error", reject); child.on("close", code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function renderBatch(run: Run, batch: SpecBatch, number: number): Promise<void> {
  if (run.status !== "ready_specs") throw new Error("Spec generation requires ready_specs");
  if (run.specBatches?.some(item => item.config === batch.config)) throw new Error("Batch already published; create a new immutable batch");
  const specs: Run["specs"] = [];
  const used = new Set<string>();
  for (const entry of batch.plans) {
    const artifact = run.artifacts.find(item => item.id === entry.snapshot.artifact.id);
    if (!artifact || hash(artifact.content) !== entry.snapshot.contentHash || artifact.hash !== entry.snapshot.contentHash) throw new Error(`Stale case snapshot ${entry.snapshot.artifact.id}`);
    const ir = TestIrSchema.parse(entry.planned.ir);
    if (!entry.failure) {
      const findings = validateIr(ir, entry.snapshot.testCase, batch.evidence);
      if (findings.errors.length) throw new Error(findings.errors.join("; "));
    }
    for (const op of ir.ops) if (op.kind === "api.request" || op.kind === "auth.api") used.add(op.operationId);
  }
  const write = async (file: string, contents: string) => {
    await writeGenerated(batch.target.projectDir, file, contents, { check: file.endsWith(".spec.ts") });
    batch.files.push({ file, hash: hash(await fs.readFile(path.join(batch.target.projectDir, file), "utf8")) });
  };
  const support = `${batch.directory}/_support`;
  await write(`${support}/routes.ts`, renderRoutes(batch.evidence, used));
  await write(`${support}/apiObjects.ts`, renderApiObjects(batch.evidence, used));
  await write(`${support}/screens.ts`, renderScreens(batch.evidence));
  await write(`${support}/observations.ts`, observationSource());
  await write(`${support}/fixtures.ts`, fixtureSource(batch.target, batch.plans.some(entry => entry.planned.ir.ops.some(op => op.kind.startsWith("ui.")))));
  await write(`${support}/testData.ts`, uniqueDataSource());
  if (batch.target.db) await write(`${support}/db.ts`, renderDbSupport(batch.evidence, batch.target.db.file, batch.target.projectDir, `${support}/db.ts`));
  await write(batch.config, configSource(batch.target));
  for (const entry of batch.plans) {
    const rendered = renderApiSpec(entry.snapshot.artifact.storyId, [{ testCase: entry.snapshot.testCase, ir: entry.planned.ir, gaps: entry.planned.gaps }], batch.evidence, batch.id);
    const file = `${batch.directory}/${hash(entry.snapshot.artifact.id).slice(0, 16)}.spec.ts`;
    const contents = rendered.contents.replaceAll("../../fixtures/test.js", "./_support/fixtures.js").replaceAll("../../support/testData.js", "./_support/testData.js").replaceAll("../_support/", "./_support/");
    await write(file, contents);
    const reason = rendered.fixmes.flatMap(item => item.reasons).join("; ");
    specs.push({ caseId: entry.snapshot.artifact.id, storyId: entry.snapshot.artifact.storyId, file, status: reason ? "fixme" : "generated", ...(reason ? { reason } : {}) });
  }
  batch.collection = await runPlaywright(batch.target.projectDir, ["--config", batch.config, "--list", "--reporter=json"]);
  atomicWriteJson(batchFile(run.id, number), batch);
  if (batch.collection.code) throw new Error(`Spec collection failed: ${batch.collection.stderr || batch.collection.stdout}`);
  run.specs = specs;
  (run.specBatches ??= []).push({ caseIds: specs.map(item => item.caseId), specs: [...specs], manifest: batchFile(run.id, number), config: batch.config, parentBatch: batch.parentBatch, snapshot: batch });
  run.status = "review_specs";
  await saveRun(run);
}

export async function exploreUi(targetFile: string, screen: string, url: string): Promise<string> {
  const target = loadTargetConfig(targetFile);
  const base = target.uiBaseUrl ?? target.baseUrl;
  if (new URL(url, base).origin !== new URL(base).origin) throw new Error("Exploration URL leaves the approved target origin");
  const proposal = await exploreScreen(target, screen, url, new ConsoleLogger());
  const existing = JSON.parse(await fs.readFile(target.uiProposals, "utf8").catch(() => "[]"));
  existing.push({ ...proposal, approved: false });
  atomicWriteJson(target.uiProposals, existing);
  return target.uiProposals;
}
