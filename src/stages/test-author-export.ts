import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { runPath, type Run } from "../core/runtime.js";
import { sourcePassages, type AuthorContext, type AuthorReport } from "./test-author.js";

function table(sheet: ExcelJS.Worksheet, headers: string[], rows: Array<Array<string | number>>): void {
  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
  for (const row of rows) sheet.addRow(row);
  sheet.views = [{ state: "frozen", ySplit: 1, showGridLines: false }];
  sheet.columns.forEach((column) => { column.width = 34; column.alignment = { vertical: "top", wrapText: true }; });
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, rows.length + 1), column: headers.length } };
}

export async function exportAuthorReport(run: Run, context: AuthorContext, report: AuthorReport, attempt: number): Promise<{ json: string; workbook: string; coverage: string }> {
  const directory = path.join(runPath(run.id), "test-design", `attempt-${attempt}`);
  await fs.mkdir(directory, { recursive: true });
  const json = path.join(directory, "design.json");
  const workbook = path.join(directory, "design.xlsx");
  const coverage = path.join(directory, "coverage.json");
  await fs.writeFile(json, `${JSON.stringify({ storyId: context.story.id, iterationPath: context.story.iterationPath,
    sources: context.sources.map(({ id, kind, title }) => ({ id, kind, title })), passages: sourcePassages(context), ...report }, null, 2)}\n`);
  await fs.writeFile(coverage, `${JSON.stringify({ coverage: report.coverage, gaps: report.gaps,
    failedBatches: report.failedBatches, inapplicable: report.inapplicable, inapplicableReasons: report.inapplicableReasons }, null, 2)}\n`);

  const book = new ExcelJS.Workbook();
  book.creator = "agentic-qa-platform";
  book.subject = `${context.story.id} test design`;
  table(book.addWorksheet("Test Plan"), ["Field", "Value"], [
    ["Story", `${context.story.id} ${context.story.title}`], ["Objective", report.plan.objective],
    ["Scope", report.plan.scopeSummary], ["In scope", report.plan.inScope.map((item) => `${item.nodeId}: ${item.reason}`).join("\n")],
    ["Out of scope", report.plan.outOfScope.map((item) => `${item.item}: ${item.reason}`).join("\n")],
    ["Risks", report.plan.risks.map((item) => `${item.name}: ${item.mitigation}`).join("\n")],
    ["Environments", report.plan.environments.join("\n")], ["Test data", report.plan.testDataNeeds.join("\n")],
    ["Assumptions", report.plan.assumptions.join("\n")], ["Open questions", report.plan.openQuestions.join("\n")],
    ["Inapplicable approaches", report.inapplicable.map((type) => `${type}: ${report.inapplicableReasons[type]}`).join("\n")],
  ]);
  table(book.addWorksheet("Stories"), ["ID", "Type", "Title", "Acceptance criteria", "Passage IDs"], context.sources.map((source) => [
    source.id, source.kind, source.title, source.id === context.story.id ? context.criteria.map((item) => `${item.label}: ${item.text}`).join("\n") : "",
    sourcePassages(context).filter((passage) => passage.sourceId === source.id).map((passage) => passage.id).join("\n"),
  ]));
  table(book.addWorksheet("Scenarios"), ["Suite types", "ID", "Name", "Origin", "Category", "Risk rationale", "Description", "Expected outcome", "Targets", "Criteria", "Source ID", "Evidence"],
    report.scenarios.map((item) => [item.testTypes.join(", "), item.id, item.name, item.origin, item.category ?? "", item.riskRationale ?? "",
      item.description, item.expectedOutcome, item.targetIds.join("\n"), item.acceptanceCriteria.join("\n"), item.sourceId ?? "", item.evidence]));
  for (const suite of report.suites) {
    const items = report.cases.filter((item) => item.testTypes.includes(suite.testType));
    table(book.addWorksheet(`${suite.testType} cases`), ["ID", "Name", "Origin", "Scenario", "Kind", "Priority", "Preconditions", "Test data", "Steps", "Expected results", "Criteria", "Automation", "Source ID", "Evidence", "Expected result evidence"],
      items.map((item) => [item.id, item.name, item.origin, item.scenarioId, item.caseKind ?? "", item.priority ?? "",
        (item.preconditions ?? []).join("\n"), (item.testData ?? []).map((data) => `${data.name}: ${data.value}`).join("\n"),
        (item.steps ?? []).map((step, index) => `${index + 1}. ${step.action}`).join("\n"),
        (item.steps ?? []).map((step, index) => `${index + 1}. ${step.expectedResult}`).join("\n"),
        (item.acceptanceCriteria ?? []).join("\n"), item.automation?.candidate ? "Candidate" : "Manual", item.sourceId ?? "", item.evidence ?? "",
        (item.steps ?? []).map((step, index) => `${index + 1}. ${step.expectedResultEvidence ?? ""}`).join("\n")]));
  }
  table(book.addWorksheet("Coverage"), ["Measure", "Value"], [
    ["Acceptance criteria", report.coverage.acceptanceCriteria.total],
    ["Covered criteria", report.coverage.acceptanceCriteria.covered],
    ["Uncovered criteria", report.coverage.acceptanceCriteria.uncovered.join(", ")],
    ["Inapplicable suites", report.inapplicable.join(", ")],
    ["Gaps", report.gaps.join("\n")], ["Failed batches", report.failedBatches.join("\n")],
  ]);
  await book.xlsx.writeFile(workbook);
  return { json, workbook, coverage };
}
