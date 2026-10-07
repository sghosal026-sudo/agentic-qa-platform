import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { hash, runPath, saveRun, type Run } from "../core/runtime.js";
import type { GraphStore, ModelClient } from "../contracts.js";
import { maskSensitiveText } from "../observability/masking.js";
import { atomicWriteJson } from "./output/atomicWrite.js";
import { filterEvidence } from "./agent/evidence/evidence-filter.js";
import { buildStateObservations, findMismatches } from "./agent/investigation/consistency-analyzer.js";
import { classifyFromEvidence } from "./agent/investigation/failure-classifier.js";
import type { QAObservation } from "./agent/models/observation.js";
import { StructuredGenerator } from "./plan/structuredGenerator.js";
import { PromptLibrary } from "./plan/promptLibrary.js";
import { SilentLogger } from "./logging/logger.js";
import { IrRepairer } from "./plan/irRepairer.js";
import { batchFile, collectEvidence, modelBridge, readBatch, renderBatch, type SpecBatch } from "./stages.js";

export type ExecutionCase = { caseId: string; status: string; duration: number; errors: string[]; observations: QAObservation[]; attachments: Array<{ name: string; path?: string }> };
export type ExecutionEvidence = { executionId: string; sha: string; batch: number; cases: ExecutionCase[]; infrastructureErrors: string[] };
const Hypotheses = z.object({ hypotheses: z.array(z.object({ explanation: z.string(), evidenceIds: z.array(z.string()), confidence: z.number().min(0).max(1) })).max(5) });
const DiagnosisSchema = z.object({ category: z.enum(["product", "environment", "test-data", "generation", "unknown"]),
  confidence: z.number().min(0).max(1), explanation: z.string(), evidenceIds: z.array(z.string()), uncertainty: z.array(z.string()),
  bindingDefect: z.string().optional() });
export type Diagnosis = z.infer<typeof DiagnosisSchema> & { caseId: string; executionId: string; hypotheses: z.infer<typeof Hypotheses>["hypotheses"]; modelError?: string };

export async function observationsFromAttachments(attachments: any[], root: string, testId: string): Promise<QAObservation[]> {
  const observations: QAObservation[] = [];
  for (const attachment of attachments) {
    if (attachment.name !== "qa-observation") continue;
    let text: string;
    if (attachment.body) text = Buffer.from(attachment.body, "base64").toString("utf8");
    else if (attachment.path) {
      const file = path.resolve(attachment.path);
      const relative = path.relative(path.resolve(root), file);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Observation attachment leaves execution directory");
      text = await fs.readFile(file, "utf8");
    } else continue;
    const entry = JSON.parse(text);
    const surface = entry.kind === "api" ? "API" : entry.kind === "sqlite" ? "DATA" : entry.kind === "page" ? "UI" : "UNKNOWN";
    const evidence = filterEvidence([{ id: `${testId}:${observations.length}`, type: surface === "API" ? "api" : surface === "DATA" ? "data" : "ui", summary: entry.kind, data: entry.data } as any]);
    observations.push({ id: `${testId}:${observations.length}`, testId, surface, operation: String(entry.data?.operationId ?? entry.data?.id ?? entry.kind),
      observed: evidence[0].data, evidence, timestamp: Date.parse(entry.at) || Date.now() });
  }
  return observations;
}

async function loadExecution(run: Run, executionId: string): Promise<ExecutionEvidence> {
  const file = path.join(runPath(run.id), `execution-${executionId}.json`);
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) {
    const evidence = run.specBatches?.find(item => item.executionId === executionId)?.executionEvidence;
    if (!evidence) throw error;
    atomicWriteJson(file, evidence);
    return evidence as ExecutionEvidence;
  }
}

export async function diagnoseExecution(run: Run, executionId: string, model: ModelClient): Promise<Diagnosis[]> {
  if (!/^[a-f0-9-]{36}$/.test(executionId)) throw new Error("Invalid execution ID");
  const execution: ExecutionEvidence = await loadExecution(run, executionId);
  const batch = await readBatch(run, execution.batch);
  const diagnoses: Diagnosis[] = [];
  const generator = new StructuredGenerator(modelBridge(model), new PromptLibrary(), 3, new SilentLogger(), false);
  for (const result of execution.cases.filter(item => ["failed", "timedOut", "interrupted"].includes(item.status))) {
    const plan = batch.plans.find(item => item.snapshot.artifact.id === result.caseId);
    const ids = new Set(result.observations.map(item => item.id));
    const input = { errors: result.errors.map(maskSensitiveText), observations: result.observations,
      states: buildStateObservations(result.observations), mismatches: findMismatches(buildStateObservations(result.observations)),
      surfaceHint: classifyFromEvidence(result.observations), snapshot: plan?.snapshot, ir: plan?.planned.ir,
      evidence: batch.evidence, infrastructureErrors: execution.infrastructureErrors };
    const validateIds = (value: { evidenceIds: string[] }) => value.evidenceIds.filter(id => !ids.has(id)).map(id => `Unknown observed evidence ID ${id}`);
    let diagnosis: Diagnosis = { caseId: result.caseId, executionId, category: "unknown", confidence: 0, explanation: "No evidence-backed diagnosis accepted",
      evidenceIds: [], uncertainty: result.observations.length ? ["Cause has not been established"] : ["Worker observations missing"], hypotheses: [] };
    try {
      const hypotheses = await generator.generate({ label: "failure hypotheses", systemPrompt: "Return JSON hypotheses grounded in the supplied observations. Never infer a product defect from the presence of multiple surfaces. No probes or business actions are permitted.",
        userPrompt: JSON.stringify({ input, schema: z.toJSONSchema(Hypotheses) }), schema: Hypotheses,
        validate: value => ({ errors: value.hypotheses.flatMap(validateIds), gaps: [] }) });
      const analysis = await generator.generate({ label: "failure diagnosis", systemPrompt: "Return JSON diagnosis based on observed evidence. Distinguish product, environment, test-data, generation and unknown. Generation requires a specific binding defect, never a changed expectation. Missing evidence must be listed as uncertainty. Do not execute or suggest business probes.",
        userPrompt: JSON.stringify({ input, hypotheses: hypotheses.value.hypotheses, schema: z.toJSONSchema(DiagnosisSchema) }), schema: DiagnosisSchema,
        validate: value => ({ errors: [...validateIds(value), ...(!value.evidenceIds.length && value.category !== "unknown" ? ["A classification requires observed evidence"] : []),
          ...(value.category === "generation" && !value.bindingDefect ? ["Generation diagnosis requires a binding defect"] : [])], gaps: [] }) });
      diagnosis = { ...analysis.value, caseId: result.caseId, executionId, hypotheses: hypotheses.value.hypotheses };
    } catch (error) { diagnosis.modelError = maskSensitiveText(String(error)); }
    diagnoses.push(diagnosis);
  }
  atomicWriteJson(path.join(runPath(run.id), `diagnosis-${executionId}.json`), diagnoses);
  const saved = run.specBatches?.find(item => item.executionId === executionId);
  if (saved) saved.diagnoses = diagnoses;
  await saveRun(run);
  return diagnoses;
}

export async function repairSpecs(run: Run, executionId: string, model: ModelClient, graph: GraphStore, automatic = false): Promise<boolean> {
  if (!/^[a-f0-9-]{36}$/.test(executionId)) throw new Error("Invalid execution ID");
  const execution: ExecutionEvidence = await loadExecution(run, executionId);
  const old = await readBatch(run, execution.batch);
  const previous = run.specBatches?.[execution.batch - 1];
  if (!previous || previous.executionId !== executionId || previous.sha !== execution.sha) throw new Error("Repair does not match an executed approved batch SHA");
  if (automatic && (previous.automaticRepairAttempted || previous.parentBatch)) return false;
  const diagnoses: Diagnosis[] = previous.diagnoses as Diagnosis[] ?? JSON.parse(await fs.readFile(path.join(runPath(run.id), `diagnosis-${executionId}.json`), "utf8"));
  const selected = diagnoses.filter(item => item.category === "generation" && item.confidence >= 0.85 && item.evidenceIds.length && !item.uncertainty.length && item.bindingDefect);
  if (!selected.length) return false;
  if (automatic) { previous.automaticRepairAttempted = true; await saveRun(run); }
  const number = (run.specBatches?.length ?? 0) + 1;
  const directory = `tests/generated/${run.id}/batch-${number}`;
  const batch: SpecBatch = { ...old, id: `${run.id}/batch-${number}`, createdAt: new Date().toISOString(), directory, config: `${directory}/playwright.config.ts`,
    evidence: await collectEvidence(old.target), plans: [], files: [], collection: undefined, parentBatch: execution.batch, repairAttempt: automatic ? 1 : number };
  const repairer = new IrRepairer(modelBridge(model), new SilentLogger(), 3);
  const cases = await graph.managedTestCases?.();
  if (!cases) throw new Error("Repair requires current graph case revision verification");
  const failures: string[] = [];
  for (const diagnosis of selected) {
    const entry = old.plans.find(item => item.snapshot.artifact.id === diagnosis.caseId);
    if (!entry || hash(entry.snapshot.artifact.content) !== entry.snapshot.contentHash || cases.find(item => item.id === diagnosis.caseId)?.contentHash !== entry.snapshot.contentHash) {
      failures.push(`${diagnosis.caseId}: stale approved case revision`); continue;
    }
    const context = await graph.storyContext(entry.snapshot.artifact.storyId);
    const outcome = await repairer.repair(entry.snapshot.testCase, entry.planned, batch.evidence, JSON.stringify(diagnosis), context);
    if (outcome.planned && !outcome.planned.gaps.length) batch.plans.push({ ...structuredClone(entry), planned: outcome.planned });
    else failures.push(`${diagnosis.caseId}: ${outcome.failure ?? outcome.planned?.gaps.join("; ")}`);
  }
  atomicWriteJson(path.join(runPath(run.id), `repair-${executionId}-${number}.json`), { parentBatch: execution.batch, executionId, failures, repaired: batch.plans.map(item => item.snapshot.artifact.id) });
  if (!batch.plans.length) return false;
  const originalStatus = run.status;
  run.status = "ready_specs";
  try { await renderBatch(run, batch, number); }
  catch (error) { run.status = originalStatus; await saveRun(run); throw error; }
  return true;
}
