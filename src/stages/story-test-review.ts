import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { z } from "zod";
import { hash, runPath, saveRun, type Artifact, type Run, type TestReviewItem } from "../core/runtime.js";
import type { GraphStore, ModelClient, SprintWorkItemClient } from "../contracts.js";

type Decision = { itemId: string; reviewHash: string; action: "approve" | "reject" | "correct"; reason?: string; correction?: string;
  reviewer: string; at: string };

function changedSteps(artifact: Artifact): Array<{ index: number; before: unknown; after: unknown }> | undefined {
  const before = artifact.beforeContent?.steps;
  const after = artifact.content.steps;
  if (!Array.isArray(before) || !Array.isArray(after)) return undefined;
  const changes = [];
  for (let index = 0; index < Math.max(before.length, after.length); index++) {
    if (JSON.stringify(before[index]) !== JSON.stringify(after[index])) changes.push({ index, before: before[index], after: after[index] });
  }
  return changes;
}

export function parseTestReviewComment(text: string, reviewer: string, at: string): Decision | null {
  const clean = text.replace(/<br\s*\/?\s*>|<\/p>|<\/div>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&quot;/gi, '"').replace(/&amp;/gi, "&")
    .replace(/\s+(?=(?:Item-ID|Review-Hash|Decision|Reason|Correction):)/gi, "\n");
  if (/^\s*AI\s+(?:recommendation|review)/i.test(clean) || /(?:\[bot\]|^ai$|automation|service account)/i.test(reviewer)) return null;
  const fields = new Map<string, string>();
  for (const line of clean.split(/\r?\n/)) {
    const match = /^(Item-ID|Review-Hash|Decision|Reason|Correction):\s*(.*)$/i.exec(line.trim());
    if (match) fields.set(match[1]!.toLowerCase(), match[2]!.trim());
  }
  const itemId = fields.get("item-id");
  const reviewHash = fields.get("review-hash");
  const action = fields.get("decision")?.toLowerCase();
  const reason = fields.get("reason");
  const correction = fields.get("correction");
  if (!reviewer || !itemId || !reviewHash || !["approve", "reject", "correct"].includes(action ?? "")) return null;
  if (action !== "approve" && !reason) return null;
  if (action === "correct" && !correction) return null;
  return { itemId, reviewHash, action: action as Decision["action"], reason, correction, reviewer, at };
}

export function createTestReview(run: Run, sourceHash: string,
  revisions: Array<{ artifact: Artifact; confidence: number; reason: string; evidence: string; sourceText?: string }> = [],
  impactGaps: Array<{ id: string; name: string; suite?: string; confidence: number; reason: string; evidence: string; sourceText?: string; caseId?: string }> = []): void {
  const revised = new Map(revisions.map((revision) => [revision.artifact.id, revision]));
  const items: TestReviewItem[] = run.artifacts.map((artifact) => ({
    id: artifact.id, kind: artifact.kind, name: artifact.name,
    suite: Array.isArray(artifact.content.testTypes) ? artifact.content.testTypes.join(", ") : String(artifact.content.testType ?? "unspecified"),
    hash: hash({ id: artifact.id, kind: artifact.kind, name: artifact.name, content: artifact.content }),
    baseHash: artifact.baseHash, proposedHash: hash(artifact.content),
    confidence: revised.get(artifact.id)?.confidence,
    reviewReason: revised.get(artifact.id)?.reason ?? String(artifact.content.riskRationale ?? artifact.content.reason
      ?? "Review this new item against its source evidence and coverage report"),
    evidence: revised.get(artifact.id)?.evidence ?? String(artifact.content.evidence ?? ""), sourceRevision: sourceHash,
    sourceText: revised.get(artifact.id)?.sourceText,
    before: artifact.beforeContent, after: artifact.content, changedSteps: changedSteps(artifact), status: "pending",
  }));
  for (const message of [...(run.testDesign?.gaps ?? []), ...(run.testDesign?.failedBatches ?? [])]) {
    const id = `Gap:${hash(message).slice(0, 16)}`;
    items.push({ id, kind: "Gap", name: message.slice(0, 120), suite: "unspecified", hash: hash({ id, sourceHash, message }), confidence: 0,
      reviewReason: message, evidence: "", sourceRevision: sourceHash, status: "pending" });
  }
  for (const gap of impactGaps) items.push({ id: gap.id, kind: "Gap", name: gap.name, suite: gap.suite ?? "unspecified", hash: hash({ id: gap.id, sourceHash, reason: gap.reason }),
    confidence: gap.confidence, reviewReason: gap.reason, evidence: gap.evidence, sourceRevision: sourceHash,
    sourceText: gap.sourceText, affectedCaseId: gap.caseId, status: "pending" });
  run.testReview = { items, sourceHash, reportPath: run.testDesign?.json };
}

export async function stageStoryTestReview(run: Run, workItems: SprintWorkItemClient): Promise<void> {
  if (!run.testReview || run.stories.length !== 1) throw new Error("Story test review requires one Story and a review manifest");
  if (!workItems.testReviewTask) throw new Error("ADO Story test review is unavailable");
  const folder = runPath(run.id);
  const report = path.join(folder, "test-review.json");
  const workbookFile = path.join(folder, "test-review.xlsx");
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(report, JSON.stringify(run.testReview, null, 2));
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Review items");
  sheet.columns = ["Item ID", "Name", "Type", "Suite", "Status", "Confidence", "Reason", "Evidence", "Source revision", "Item hash", "Base hash", "Proposed hash", "Changed steps", "Before", "After"]
    .map((header) => ({ header, key: header, width: header === "Before" || header === "After" ? 60 : 28 }));
  for (const item of run.testReview.items) {
    sheet.addRow([item.id, item.name, item.kind, item.suite ?? "unspecified",
      item.status, item.confidence ?? "not supplied", item.reviewReason, item.evidence ?? "", item.sourceRevision ?? run.testReview.sourceHash,
      item.hash, item.baseHash ?? "", item.proposedHash ?? "", JSON.stringify(item.changedSteps ?? ""),
      JSON.stringify(item.before ?? ""), JSON.stringify(item.after ?? "")]);
  }
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  await workbook.xlsx.writeFile(workbookFile);
  run.testReview.reportPath = report;
  run.testReview.taskId = await workItems.testReviewTask(run.id, run.testReview, run.stories[0]!);
  await saveRun(run);
}

function hasApprovedParent(artifact: Artifact, run: Run): boolean {
  if (!artifact.parentId) return true;
  const parent = run.artifacts.find((item) => item.id === artifact.parentId);
  return !parent || Boolean(parent.approvedAt);
}

async function applyCorrection(artifact: Artifact, instruction: string, model: ModelClient, source: string): Promise<Record<string, unknown>> {
  const response = await model.json(`Apply the human's correction to this test artifact. Keep all unrelated fields and assertions unchanged.\n`
    + `Human correction: ${instruction}\nCurrent artifact: ${JSON.stringify(artifact.content)}\nApproved source: ${source}\n`
    + `Return JSON {"content":<complete corrected artifact>,"reason":"how it follows the correction"}. Do not invent behavior.`) as { content?: unknown; reason?: unknown };
  if (!response || typeof response.content !== "object" || !response.content || Array.isArray(response.content)) throw new Error("Correction did not return an artifact object");
  const content = response.content as Record<string, unknown>;
  const old = artifact.content;
  for (const key of ["id", "storyId", "scenarioId", "sourceId", "acceptanceCriteria", "route", "coversNodeIds",
    "validatesNodeIds", "exercisesNodeIds", "targetIds", "reusedCaseIds", "reusedScenarioIds", "testTypes"]) {
    if (JSON.stringify(content[key]) !== JSON.stringify(old[key])) throw new Error(`Correction changed protected field ${key}`);
  }
  if (Object.keys(content).sort().join("|") !== Object.keys(old).sort().join("|")) throw new Error("Correction changed the artifact schema");
  if (artifact.kind === "TestCase") {
    for (const key of Object.keys(old)) if (key !== "steps" && key !== "evidence"
      && JSON.stringify(content[key]) !== JSON.stringify(old[key])) throw new Error(`Correction changed unrelated case field ${key}`);
    const oldSteps = old.steps;
    const newSteps = content.steps;
    if (!Array.isArray(oldSteps) || !Array.isArray(newSteps) || oldSteps.length !== newSteps.length) throw new Error("Correction changed the case step structure");
    for (let index = 0; index < newSteps.length; index++) {
      const step = newSteps[index];
      if (!step || typeof step !== "object" || typeof step.action !== "string" || typeof step.expectedResult !== "string"
        || typeof step.expectedResultEvidence !== "string" || !sourceQuote(step.expectedResultEvidence, source)) {
        throw new Error(`Correction has unsupported step ${index}`);
      }
    }
  }
  const normalized = source.toLowerCase().replace(/\s+/g, " ");
  const quotes = [content.evidence, ...((content.steps as Array<{ expectedResultEvidence?: unknown }> | undefined) ?? []).map((step) => step.expectedResultEvidence)];
  for (const quote of quotes) if (typeof quote === "string" && quote.length > 3 && !normalized.includes(quote.toLowerCase().replace(/\s+/g, " "))) {
    throw new Error(`Correction has unsupported evidence: ${quote.slice(0, 80)}`);
  }
  if (JSON.stringify(content) === JSON.stringify(old)) throw new Error("Correction did not change the artifact");
  const verification = await model.json(`Check whether the corrected test follows the human instruction exactly and preserves unrelated assertions. Return JSON {"valid":boolean,"reason":string}.\n`
    + `Instruction: ${instruction}\nBefore: ${JSON.stringify(old)}\nAfter: ${JSON.stringify(content)}\nApproved source: ${source}`) as { valid?: unknown; reason?: unknown };
  if (verification?.valid !== true) throw new Error(`Correction does not follow the instruction: ${String(verification?.reason ?? "unverified")}`);
  return content;
}

const GapPatch = z.object({ evidence: z.string().min(4), reason: z.string().min(1),
  changes: z.array(z.object({ index: z.number().int().min(0), action: z.string().min(1).optional(),
    expectedResult: z.string().min(1).optional(), expectedResultEvidence: z.string().min(4) })).min(1) });

async function correctGap(item: TestReviewItem, instruction: string, source: string, graph: GraphStore,
  model: ModelClient): Promise<Artifact> {
  if (!item.affectedCaseId || !graph.managedTestCases) throw new Error("Gap has no graph-managed case to revise");
  const existing = (await graph.managedTestCases()).find((candidate) => candidate.id === item.affectedCaseId);
  if (!existing) throw new Error(`Affected case ${item.affectedCaseId} is unavailable`);
  const evidenceSource = `${source}\n${item.evidence ?? ""}`;
  const draft = GapPatch.parse(await model.json(`Apply the human correction to the affected case. Return only changed step indices. Keep all other steps and assertions. Cite exact current source text.\n`
    + `Correction: ${instruction}\nSource: ${evidenceSource}\nCase: ${JSON.stringify(existing.content)}\n`
    + `Return JSON {evidence,reason,changes:[{index,action?,expectedResult?,expectedResultEvidence}]}.`,
    { name: "test_gap_correction", schema: z.toJSONSchema(GapPatch) as Record<string, unknown> }));
  if (!sourceQuote(draft.evidence, evidenceSource)) throw new Error("Gap correction has unsupported source evidence");
  const steps = Array.isArray(existing.content.steps) ? structuredClone(existing.content.steps) as Array<Record<string, unknown>> : [];
  if (!steps.length) throw new Error("Affected case has no editable steps");
  for (const change of draft.changes) {
    if (!steps[change.index] || !sourceQuote(change.expectedResultEvidence, evidenceSource)) throw new Error(`Unsupported corrected step ${change.index}`);
    const { index: _index, ...fields } = change;
    steps[change.index] = { ...steps[change.index], ...fields };
  }
  const content = { ...existing.content, steps };
  if (JSON.stringify(content) === JSON.stringify(existing.content)) throw new Error("Correction did not change the case");
  const verification = await model.json(`Check whether this case patch follows the human instruction and leaves unrelated assertions unchanged. Return JSON {"valid":boolean,"reason":string}.\n`
    + `Instruction: ${instruction}\nBefore: ${JSON.stringify(existing.content)}\nAfter: ${JSON.stringify(content)}\nSource: ${evidenceSource}`) as { valid?: unknown; reason?: unknown };
  if (verification?.valid !== true) throw new Error(`Gap correction does not follow the instruction: ${String(verification?.reason ?? "unverified")}`);
  return { id: existing.id, kind: "TestCase", name: existing.name,
    storyId: typeof existing.content.ownerStoryId === "string" ? existing.content.ownerStoryId : existing.storyIds[0] ?? "",
    parentId: typeof existing.content.scenarioId === "string" ? existing.content.scenarioId : undefined,
    content, hash: hash(content), baseHash: existing.contentHash, beforeContent: existing.content };
}

function sourceQuote(quote: string, source: string): boolean {
  return source.toLowerCase().replace(/\s+/g, " ").includes(quote.toLowerCase().replace(/\s+/g, " ").trim());
}

export async function applyStoryTestReview(run: Run, workItems: SprintWorkItemClient, graph: GraphStore,
  model: ModelClient): Promise<{ pending: number; approved: number; rejected: number; manualFix: number }> {
  const review = run.testReview;
  if (!review?.taskId || !workItems.testReviewComments) throw new Error("Story test review Task is unavailable");
  const comments = await workItems.testReviewComments(review.taskId);
  const decisions = new Map<string, Decision>();
  const hashes = new Map(review.items.map((item) => [item.id, item.hash]));
  for (const comment of comments.sort((a, b) => b.at.localeCompare(a.at))) {
    const decision = parseTestReviewComment(comment.text, comment.reviewer, comment.at);
    if (decision && hashes.get(decision.itemId) === decision.reviewHash && !decisions.has(decision.itemId)) decisions.set(decision.itemId, decision);
  }
  const source = run.stories.map((story) => [story.text, ...(story.parents ?? []).map((parent) => parent.text)].join("\n")).join("\n");
  for (const item of review.items) {
    if (item.status !== "pending") continue;
    const decision = decisions.get(item.id);
    if (!decision || decision.reviewHash !== item.hash) continue;
    const artifact = run.artifacts.find((value) => value.id === item.id);
    if (decision.action !== "reject" && artifact && !hasApprovedParent(artifact, run)) continue;
    if (decision.action === "correct" && !artifact) {
      try {
        const corrected = await correctGap(item, decision.correction!, item.sourceText ?? source, graph, model);
        corrected.reviewer = decision.reviewer;
        corrected.approvedAt = decision.at;
        if (!graph.activateCaseRevision) throw new Error("Graph case revision activation is unavailable");
        await graph.activateCaseRevision(corrected, corrected.baseHash!);
        run.artifacts.push(corrected);
        item.after = corrected.content;
        item.status = "approved";
        item.reviewer = decision.reviewer;
        item.reviewedAt = decision.at;
        item.note = decision.reason;
        await saveRun(run);
      } catch (error) {
        item.note = error instanceof Error ? error.message : String(error);
        await saveRun(run);
      }
      continue;
    }
    try {
      if (artifact && decision.action !== "reject") {
        const content = decision.action === "correct" ? await applyCorrection(artifact, decision.correction!, model, item.sourceText ?? source) : artifact.content;
        const approved = { ...artifact, content, hash: hash(content), reviewer: decision.reviewer, approvedAt: decision.at };
        if (approved.baseHash) {
          if (!graph.activateCaseRevision) throw new Error("Graph case revision activation is unavailable");
          await graph.activateCaseRevision(approved, approved.baseHash);
        } else await graph.artifact(approved);
        Object.assign(artifact, approved);
        item.after = content;
      }
      if (!artifact && decision.action === "approve" && item.affectedCaseId) {
        if (!graph.markCaseOutdated) throw new Error("Graph manual-fix marking is unavailable");
        await graph.markCaseOutdated(item.affectedCaseId, item.reviewReason);
      }
    } catch (error) {
      item.note = error instanceof Error ? error.message : String(error);
      await saveRun(run);
      continue;
    }
    item.status = artifact ? decision.action === "reject" ? "rejected" : "approved" : decision.action === "reject" ? "rejected" : "manual_fix";
    item.reviewer = decision.reviewer;
    item.reviewedAt = decision.at;
    item.note = decision.reason;
    await saveRun(run);
  }
  if (review.items.every((item) => item.status !== "pending")) await workItems.closeTestReviewTask?.(review.taskId);
  return { pending: review.items.filter((item) => item.status === "pending").length,
    approved: review.items.filter((item) => item.status === "approved").length,
    rejected: review.items.filter((item) => item.status === "rejected").length,
    manualFix: review.items.filter((item) => item.status === "manual_fix").length };
}
