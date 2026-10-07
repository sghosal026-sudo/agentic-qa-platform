import type { ApiOperation, DbTable, EvidenceCatalogue, UiScreen } from "../evidence/catalogue.js";
import type { NormalisedCase } from "../model/testCase.js";

/**
 * What of the catalogue to put in front of the model, and how it reads.
 *
 * Everything the model is allowed to say is drawn from this text, so it has to be complete about
 * the operations it shows. It does not have to show every operation: a target with three hundred
 * endpoints would bury the handful that matter, and a model that cannot find the right operation
 * reaches for a plausible one. So the list is ranked and trimmed — but a case's own referenced
 * endpoints are always included, whatever the ranking thinks.
 */

const STOP_WORDS = new Set(["the", "a", "an", "is", "are", "with", "for", "and", "that", "this", "of", "to", "in", "on", "it", "its", "be", "as", "by", "from", "test", "case", "step", "system", "user", "tester", "response", "request", "send", "check", "verify", "confirm"]);

const words = (value: string): string[] =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));

/** `POST /warehouses` on an Endpoint node — the design's own pointer at an operation. */
function referencedOperations(testCase: NormalisedCase, catalogue: EvidenceCatalogue): ApiOperation[] {
  const wanted = [...testCase.exercises, ...testCase.scenario.exercises]
    .filter((reference) => reference.nodeType.toLowerCase() === "endpoint")
    .map((reference) => reference.name.trim().toLowerCase());

  return catalogue.api.filter((operation) => {
    const signature = `${operation.method} ${operation.pathTemplate}`.toLowerCase();
    return wanted.some((name) => name === signature || name.replace(/\s+/g, " ") === signature);
  });
}

function score(operation: ApiOperation, terms: readonly string[]): number {
  const haystack = `${operation.operationId} ${operation.pathTemplate} ${operation.summary ?? ""}`.toLowerCase();
  let total = 0;
  for (const term of terms) if (haystack.includes(term)) total += 1;
  return total;
}

/** The operations offered for one case: everything it points at, then the best textual matches. */
export function relevantOperations(testCase: NormalisedCase, catalogue: EvidenceCatalogue, limit = 12): ApiOperation[] {
  const referenced = referencedOperations(testCase, catalogue);
  const chosen = new Map(referenced.map((operation) => [operation.id, operation]));
  for (const operation of catalogue.api) {
    const returnsToken = operation.responses.some((response) => response.fields.some((field) => /(^|\.)(access_?token|token|jwt)$/i.test(field.path)));
    if (!operation.secured && returnsToken) chosen.set(operation.id, operation);
  }

  const terms = [...new Set(words([testCase.name, testCase.objective, testCase.scenario.name, ...testCase.steps.map((step) => step.action)].join(" ")))];
  const ranked = catalogue.api
    .filter((operation) => !chosen.has(operation.id))
    .map((operation) => ({ operation, score: score(operation, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.operation.operationId.localeCompare(b.operation.operationId));

  for (const entry of ranked) {
    if (chosen.size >= limit) break;
    chosen.set(entry.operation.id, entry.operation);
  }
  return [...chosen.values()];
}

const describeField = (field: { path: string; type: string; required: boolean; enum?: string[]; minLength?: number; maxLength?: number }): string =>
  `${field.path}: ${field.type}${field.required ? " (required)" : ""}${field.minLength !== undefined ? ` minLength ${field.minLength}` : ""}${field.maxLength !== undefined ? ` maxLength ${field.maxLength}` : ""}${field.enum ? ` one of ${field.enum.join(" | ")}` : ""}`;

/** The operations, as the prompt shows them. Complete about what it shows; silent about the rest. */
export function describeOperations(operations: readonly ApiOperation[]): string {
  return operations
    .map((operation) => {
      const lines = [`### ${operation.operationId}`, `${operation.method.toUpperCase()} ${operation.pathTemplate}${operation.summary ? ` — ${operation.summary}` : ""}`, `Authentication required: ${operation.secured ? "yes" : "no"}`];

      const parameters = operation.parameters.filter((parameter) => parameter.in !== "header");
      if (parameters.length > 0) {
        lines.push(`Parameters: ${parameters.map((parameter) => `${parameter.name} (${parameter.in}, ${parameter.type}${parameter.required ? ", required" : ""})`).join("; ")}`);
      }
      if (operation.requestBody) {
        lines.push(
          operation.requestBody.fields.length > 0
            ? `Body fields: ${operation.requestBody.fields.map(describeField).join("; ")}`
            : `Body: accepted, but the document declares no fields for it.`
        );
      }
      for (const response of operation.responses) {
        const fields = response.fields.length > 0 ? ` fields: ${response.fields.map((field) => field.path).join(", ")}` : " (no declared body)";
        lines.push(`Response ${response.status}${response.description ? ` ${response.description}` : ""} —${fields}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

export function describeAuthentication(catalogue: EvidenceCatalogue): string {
  const methods = catalogue.auth.map((item) => `- ${item.id}: send ${item.headerName}: ${item.scheme} <grounded token value>`);
  const endpoints = catalogue.api.filter((operation) =>
    !operation.secured && operation.responses.some((response) => response.fields.some((field) => /(^|\.)(access_?token|token|jwt)$/i.test(field.path)))
  );
  for (const operation of endpoints) methods.push(`- api:${operation.operationId}: documented unauthenticated operation returning a token field`);
  return methods.length > 0 ? methods.join("\n") : "No grounded authentication mechanism is available.";
}

/** The case, as the prompt shows it: the manual text, unparaphrased. */
export function describeCase(testCase: NormalisedCase): string {
  const lines = [
    `Case ID: ${testCase.caseId}`,
    `Name: ${testCase.name}`,
    `Objective: ${testCase.objective}`,
    `Scenario: ${testCase.scenario.name}${testCase.scenario.description ? ` — ${testCase.scenario.description}` : ""}`,
    `Kind: ${testCase.caseKind}, priority ${testCase.priority}`,
  ];
  if (testCase.preconditions.length > 0) lines.push(`Preconditions:\n${testCase.preconditions.map((item) => `  - ${item}`).join("\n")}`);
  if (testCase.automationNotes) lines.push(`Automation notes: ${testCase.automationNotes}`);
  lines.push(
    testCase.testData.length > 0
      ? `Test data (refer to these by name):\n${testCase.testData.map((datum) => `  - ${datum.name} = ${JSON.stringify(datum.value)}`).join("\n")}`
      : `Test data: none given.`
  );
  lines.push(`Steps:\n${testCase.steps.map((step) => `  ${step.stepNumber}. ${step.action}\n     Expected: ${step.expectedResult}`).join("\n")}`);
  return lines.join("\n");
}

export function describeObligations(testCase: NormalisedCase): string {
  return testCase.obligations
    .map((obligation) => `- ${obligation.id} — ${obligation.text}${obligation.vague ? "   (states no observable outcome on its own; read the step's action and the operation's declared responses)" : ""}`)
    .join("\n");
}

/**
 * The tables offered for one case.
 *
 * The schema is usually small enough to show whole, and a wrong table is a worse failure than a
 * long prompt: the model would assert about rows that have nothing to do with the case. Where a
 * schema is large, the ones whose names the case mentions come first.
 */
export function relevantTables(testCase: NormalisedCase, catalogue: EvidenceCatalogue, limit = 12): DbTable[] {
  const terms = new Set(words([testCase.name, testCase.objective, ...testCase.steps.map((step) => `${step.action} ${step.expectedResult}`)].join(" ")));
  const named = [...testCase.exercises, ...testCase.validates].map((reference) => reference.name.toLowerCase());

  const scored = catalogue.db
    .map((table) => ({
      table,
      score: (terms.has(table.name.toLowerCase()) ? 2 : 0) + (named.some((name) => name.includes(table.name.toLowerCase())) ? 2 : 0),
    }))
    .sort((a, b) => b.score - a.score || a.table.name.localeCompare(b.table.name));

  return scored.slice(0, limit).map((entry) => entry.table);
}

export function describeTables(tables: readonly DbTable[]): string {
  return tables
    .map((table) => {
      const columns = table.columns
        .map((column) => `${column.name}: ${column.type}${column.primaryKey ? " (primary key)" : column.unique ? " (unique)" : ""}${column.nullable ? "" : " not null"}`)
        .join("; ");
      return `### ${table.name}\n${columns}`;
    })
    .join("\n\n");
}

/**
 * The approved screens, as the prompt shows them.
 *
 * Element names only — never the locators. The plan names an element and the renderer looks up how
 * to find it, so the model has nothing to copy, mistype or improve upon.
 */
export function describeScreens(screens: readonly UiScreen[]): string {
  return screens
    .map((screen) => {
      const elements = screen.elements
        .map((element) => `${element.id}${element.description ? ` (${element.description})` : ""}`)
        .join("; ");
      return `### ${screen.name}\n${screen.description ? `${screen.description}\n` : ""}Path: ${screen.url}\nApproved elements: ${elements}`;
    })
    .join("\n\n");
}
