import {
  columnOf,
  elementOf,
  operationById,
  parameterNames,
  pathPlaceholders,
  responseFor,
  screenByName,
  tableByName,
  type ApiOperation,
  type DbTable,
  type EvidenceCatalogue,
  type UiScreen,
} from "../evidence/catalogue.js";
import type { NormalisedCase } from "../model/testCase.js";
import { fingerprintsOf, type IrAssertion, type IrValue, type SubjectAssertion, type TestIr } from "./testIr.js";

/**
 * The deterministic gate between the model and the renderer.
 *
 * Nothing here asks whether the plan is *good*. It asks whether the plan says anything the evidence
 * does not support, and whether every promise the manual case made is accounted for. A plan that
 * passes can be rendered without the renderer having to think.
 *
 * Two kinds of finding, and the difference matters:
 *
 * - **errors** contradict the evidence — an operation that does not exist, a field the response
 *   schema does not declare, a literal nobody supplied. The model is asked again.
 * - **gaps** go beyond evidence that is merely silent — asserting a 409 on an operation whose
 *   document declares only 201 and 422. The manual case is the authority on what the application
 *   should do; a document that fails to mention a status is not evidence that it cannot happen.
 *   The assertion stands, and the gap is recorded so the manifest can say the test is not backed
 *   by the document.
 */

export interface Findings {
  errors: string[];
  gaps: string[];
}

/** Text the case itself supplies. A string literal must come from in here. */
function suppliedText(testCase: NormalisedCase): string {
  return [
    testCase.name,
    testCase.objective,
    ...testCase.preconditions,
    ...testCase.testData.flatMap((datum) => [datum.name, datum.value]),
    ...testCase.steps.flatMap((step) => [step.action, step.expectedResult]),
    testCase.scenario.name,
    testCase.scenario.description,
    testCase.scenario.expectedOutcome ?? "",
    testCase.automationNotes ?? "",
  ].join("\n");
}

const describeValue = (value: IrValue): string =>
  "literal" in value
    ? JSON.stringify(value.literal)
    : "testData" in value
      ? `testData "${value.testData}"`
      : "uniqueTestData" in value
        ? `unique test data "${value.uniqueTestData}"`
        : `${value.from}.${value.path}`;

function valuesIn(ir: TestIr): IrValue[] {
  const operationValues = ir.ops.flatMap((op) => {
    if (op.kind === "auth.api") return Object.values(op.body ?? {});
    if (op.kind === "auth.header") return [op.token];
    if (op.kind === "auth.unavailable") return [];
    if (op.kind === "db.read") return op.where.flatMap((predicate) => (predicate.value ? [predicate.value] : []));
    if (op.kind === "ui.act") return op.value ? [op.value] : [];
    if (op.kind === "ui.goto") return [];
    return Object.values({ ...op.pathParams, ...op.query, ...op.headers, ...op.body });
  });
  return [...operationValues, ...ir.assertions.flatMap((assertion) => ("value" in assertion && assertion.value ? [assertion.value] : []))];
}

const requiresInequality = (text: string): boolean =>
  /\b(different|distinct|unequal)\b|\bnot (?:be )?equal\b|\bids?\b.{0,30}\bunique\b|\bunique\b.{0,15}\bids?\b|\bnot reused\b|\bno [^.]{0,20}collision\b/i.test(text);

const requiresReturnedId = (text: string): boolean => /\breturns?\b.{0,40}\b(?:generated )?id\b/i.test(text);

export function validateIr(ir: TestIr, testCase: NormalisedCase, catalogue: EvidenceCatalogue): Findings {
  const errors: string[] = [];
  const gaps: string[] = [];

  if (ir.caseId !== testCase.caseId) errors.push(`caseId is "${ir.caseId}" but this plan is for "${testCase.caseId}".`);

  const text = suppliedText(testCase).toLowerCase();
  const dataNames = new Set(testCase.testData.map((datum) => datum.name));
  const obligationIds = new Set(testCase.obligations.map((obligation) => obligation.id));
  const requiresRunUnique = /\brun[- ]unique\b/i.test(suppliedText(testCase));
  const values = valuesIn(ir);
  const plainData = new Set(values.filter((value) => "testData" in value).map((value) => (value as { testData: string }).testData));
  const uniqueData = new Set(values.filter((value) => "uniqueTestData" in value).map((value) => (value as { uniqueTestData: string }).uniqueTestData));
  const uniqueBindings = new Map<string, number | undefined>();

  for (const name of uniqueData) {
    if (plainData.has(name)) errors.push(`Test data "${name}" is used both as a fixed value and as run-unique data. Choose one representation.`);
  }

  /** Operations by their IR handle, in order, so a value may only read from an earlier one. */
  const operations = new Map<string, { operation: Grounded; index: number }>();

  ir.ops.forEach((op, index) => {
    if (operations.has(op.id)) {
      errors.push(`Two operations share the id "${op.id}"; assertions could not tell them apart.`);
      return;
    }

    if (op.kind === "auth.header") {
      const evidence = catalogue.auth.find(
        (item) => item.kind === "http-bearer" && item.headerName === op.headerName && item.scheme === op.scheme
      );
      if (!evidence) errors.push(`Authentication binding "${op.headerName}: ${op.scheme} <token>" is not documented by the target evidence.`);
      if (evidence && !op.evidenceRefs.includes(evidence.id)) errors.push(`Authentication "${op.id}" must cite ${evidence.id}.`);
      if ("testData" in op.token && !/token|credential|bearer|jwt|api[ _-]?key/i.test(op.token.testData)) {
        errors.push(`Authentication token test data "${op.token.testData}" is ambiguous; its name must identify it as authentication data.`);
      }
      if ("uniqueTestData" in op.token) errors.push(`Authentication tokens cannot be generated with uniqueTestData.`);
      errors.push(...valueProblems(op.token, `${op.id}.token`, { dataNames, text, operations, index }));
      return;
    }

    if (op.kind === "auth.unavailable") {
      const tokenEndpointAvailable = catalogue.api.some((operation) =>
        !operation.secured && operation.responses.some((response) =>
          response.status >= 200 && response.status < 300 && response.fields.some((field) => /(^|\.)(access_?token|token|jwt)$/i.test(field.path))
        )
      );
      const tokenTestDataAvailable = testCase.testData.some((datum) => /token|credential|bearer|jwt|api[ _-]?key/i.test(datum.name));
      if ((catalogue.auth.length > 0 && tokenTestDataAvailable) || tokenEndpointAvailable) {
        errors.push(`Authentication cannot be marked unavailable because the evidence provides a usable authentication mechanism.`);
      }
      return;
    }

    if (op.kind === "auth.api") {
      const operation = operationById(catalogue, op.operationId);
      if (!operation) {
        errors.push(`Authentication operation "${op.operationId}" is not in the API evidence.`);
        return;
      }
      if (operation.secured) errors.push(`Authentication operation "${op.operationId}" is itself secured and cannot establish authentication.`);
      const tokenDeclared = operation.responses.some((response) => response.status >= 200 && response.status < 300 && response.fields.some((field) => field.path === op.tokenPath));
      if (!tokenDeclared) errors.push(`Authentication operation "${op.operationId}" declares no response field "${op.tokenPath}".`);
      const bodyFields = operation.requestBody?.fields ?? [];
      for (const [name, value] of Object.entries(op.body ?? {})) {
        if (!bodyFields.some((field) => field.path === name)) errors.push(`Authentication operation "${op.operationId}" declares no body field "${name}".`);
        errors.push(...valueProblems(value, `${op.id}.body.${name}`, { dataNames, text, operations, index }));
      }
      for (const field of bodyFields) {
        if (field.required && !field.path.includes(".") && !op.body?.[field.path]) errors.push(`Authentication operation "${op.operationId}" requires body field "${field.path}".`);
      }
      errors.push(...evidenceRefProblems(op.evidenceRefs, operation, `authentication operation "${op.id}"`));
      operations.set(op.id, { operation, index });
      return;
    }

    if (op.kind === "db.read") {
      const table = tableByName(catalogue, op.table);
      if (!table) {
        errors.push(
          `Table "${op.table}" is not in the schema. The schema has: ${catalogue.db.map((entry) => entry.name).join(", ") || "no tables — no database is configured for this target"}.`
        );
        return;
      }
      operations.set(op.id, { operation: table, index });

      for (const predicate of op.where) {
        if (!columnOf(table, predicate.column)) {
          errors.push(`Table "${table.name}" has no column "${predicate.column}". It has: ${table.columns.map((column) => column.name).join(", ")}.`);
          continue;
        }
        const needsValue = predicate.op !== "isNull" && predicate.op !== "notNull";
        if (needsValue && !predicate.value) errors.push(`The "${predicate.op}" comparison on ${table.name}.${predicate.column} gives no value.`);
        if (!needsValue && predicate.value) errors.push(`The "${predicate.op}" comparison on ${table.name}.${predicate.column} takes no value.`);
        if (predicate.value) errors.push(...valueProblems(predicate.value, `${op.id}.where.${predicate.column}`, { dataNames, text, operations, index }));
      }

      for (const ref of op.evidenceRefs) {
        if (ref.split("#")[0] !== table.id && ref.split("#")[0] !== table.name) {
          errors.push(`The evidence reference "${ref}" on read "${op.id}" does not point at the ${table.name} table.`);
        }
      }
      return;
    }

    if (op.kind === "ui.goto" || op.kind === "ui.act") {
      const screen = screenByName(catalogue, op.screen);
      if (!screen) {
        errors.push(
          catalogue.ui.length === 0
            ? `Screen "${op.screen}" cannot be used: this target has no approved UI contract, so no screen can be driven.`
            : `Screen "${op.screen}" is not in the approved UI contract. It has: ${catalogue.ui.map((entry) => entry.name).join(", ")}.`
        );
        return;
      }
      operations.set(op.id, { operation: screen, index });

      if (op.kind === "ui.act") {
        if (!elementOf(screen, op.element)) {
          errors.push(
            `Screen "${screen.name}" has no approved element "${op.element}". It has: ${screen.elements.map((element) => element.id).join(", ")}. ` +
              `An element nobody has approved cannot be used, even if it is on the page.`
          );
        }
        const needsValue = op.action === "fill" || op.action === "selectOption" || op.action === "press";
        if (needsValue && !op.value) errors.push(`The "${op.action}" action on ${screen.name}.${op.element} gives no value.`);
        if (!needsValue && op.value) errors.push(`The "${op.action}" action on ${screen.name}.${op.element} takes no value.`);
        if (op.value) errors.push(...valueProblems(op.value, `${op.id}.value`, { dataNames, text, operations, index }));
      }

      for (const ref of op.evidenceRefs) {
        if (ref.split("#")[0] !== screen.id && ref.split("#")[0] !== screen.name) {
          errors.push(`The evidence reference "${ref}" on "${op.id}" does not point at the ${screen.name} screen.`);
        }
      }
      return;
    }

    const operation = operationById(catalogue, op.operationId);
    if (!operation) {
      errors.push(
        `Operation "${op.operationId}" is not in the evidence. Choose one of the operationIds you were given, or say the obligation is unautomatable.`
      );
      return;
    }
    operations.set(op.id, { operation, index });

    const checkValues = (where: string, values: Record<string, IrValue> | undefined, allowed: string[], closed: boolean): void => {
      for (const [name, value] of Object.entries(values ?? {})) {
        if (closed && !allowed.includes(name)) {
          errors.push(
            `${op.operationId} declares no ${where} "${name}"${allowed.length > 0 ? `; it declares ${allowed.map((a) => `"${a}"`).join(", ")}` : ""}.`
          );
        }
        errors.push(...valueProblems(value, `${op.id}.${where}.${name}`, { dataNames, text, operations, index }));
      }
    };

    const placeholders = pathPlaceholders(operation.pathTemplate);
    checkValues("path parameter", op.pathParams, placeholders, true);
    for (const placeholder of placeholders) {
      if (!op.pathParams?.[placeholder]) errors.push(`${op.operationId} needs a path parameter "${placeholder}"; the plan gives none.`);
    }
    checkValues("query parameter", op.query, parameterNames(operation, "query"), true);
    // Headers are open: a target may require one the document never declares.
    checkValues("header", op.headers, parameterNames(operation, "header"), false);

    const bodyFields = operation.requestBody?.fields ?? [];
    for (const [name, value] of Object.entries(op.body ?? {})) {
      if (requiresRunUnique && /(^|\.)(code|key)$/i.test(name) && "testData" in value) {
        errors.push(`${op.id}.body field "${name}" must use uniqueTestData because this case requires run-unique values.`);
      }
      if (!("uniqueTestData" in value)) continue;
      const field = bodyFields.find((candidate) => candidate.path === name);
      if (!field || field.type !== "string") {
        errors.push(`${op.id}.body field "${name}" uses run-unique test data, but it is not a documented string field.`);
        continue;
      }
      const previous = uniqueBindings.get(value.uniqueTestData);
      if (uniqueBindings.has(value.uniqueTestData) && previous !== field.maxLength) {
        errors.push(`Run-unique test data "${value.uniqueTestData}" is bound to fields with different maximum lengths.`);
        continue;
      }
      uniqueBindings.set(value.uniqueTestData, field.maxLength);
    }
    checkValues("body field", op.body, bodyFields.map((field) => field.path), bodyFields.length > 0);
    if (bodyFields.length === 0 && op.body && Object.keys(op.body).length > 0) {
      gaps.push(`${op.operationId} declares no request body schema, so the body this plan sends is not backed by the document.`);
    }
    for (const field of bodyFields) {
      if (field.required && !op.body?.[field.path] && !field.path.includes(".")) {
        errors.push(`${op.operationId} requires the body field "${field.path}"; the plan omits it, so the call would be rejected before it reached the behaviour under test.`);
      }
    }

    errors.push(...evidenceRefProblems(op.evidenceRefs, operation, `operation "${op.id}"`));
  });

  const securedIndexes = ir.ops.flatMap((op, index) =>
    op.kind === "api.request" && operationById(catalogue, op.operationId)?.secured ? [index] : []
  );
  if (securedIndexes.length > 0) {
    const authIndex = ir.ops.findIndex((op) => op.kind === "auth.api" || op.kind === "auth.header" || op.kind === "auth.unavailable");
    if (authIndex < 0) errors.push("This plan calls a secured API operation but has no authentication operation or explicit unavailable disposition.");
    if (authIndex >= 0 && securedIndexes.some((index) => authIndex > index)) errors.push("Authentication must occur before every secured API request.");
    if (ir.ops.filter((op) => op.kind.startsWith("auth.")).length > 1) errors.push("A plan may contain only one authentication disposition.");
  }

  for (const name of uniqueData) {
    if (!uniqueBindings.has(name)) {
      errors.push(`Run-unique test data "${name}" is not bound to a documented string request-body field.`);
    }
  }

  const asserted = new Set<string>();
  for (const assertion of ir.assertions) {
    if (!obligationIds.has(assertion.obligation)) {
      errors.push(`Assertion names obligation "${assertion.obligation}", which this case does not have. Its obligations are: ${[...obligationIds].join(", ")}.`);
      continue;
    }
    if (assertion.kind === "assert.ui.element") {
      asserted.add(assertion.obligation);
      errors.push(...uiAssertionProblems(assertion, catalogue, { dataNames, text, operations, index: ir.ops.length }));
      continue;
    }

    const target = operations.get(assertion.of);
    if (!target) {
      errors.push(`Assertion for "${assertion.obligation}" checks "${assertion.of}", which is not one of this plan's operations.`);
      continue;
    }
    asserted.add(assertion.obligation);
    const problems = assertionProblems(assertion, target.operation, { dataNames, text, operations, index: target.index });
    errors.push(...problems.errors);
    gaps.push(...problems.gaps);
  }

  for (const entry of ir.unautomatable) {
    if (!obligationIds.has(entry.obligation)) {
      errors.push(`"${entry.obligation}" is listed as unautomatable but is not an obligation of this case.`);
    } else if (asserted.has(entry.obligation)) {
      errors.push(`"${entry.obligation}" is both asserted and listed as unautomatable. Decide which it is.`);
    }
  }

  const unautomatable = new Set(ir.unautomatable.map((entry) => entry.obligation));
  for (const obligation of testCase.obligations) {
    if (!asserted.has(obligation.id) && !unautomatable.has(obligation.id)) {
      errors.push(
        `Obligation ${obligation.id} ("${obligation.text}") is neither asserted nor listed as unautomatable. Every expected result must be accounted for.`
      );
    }
    const assertions = ir.assertions.filter((assertion) => assertion.obligation === obligation.id);
    if (
      assertions.length > 0 &&
      requiresInequality(obligation.text) &&
      !assertions.some((assertion) => "matcher" in assertion && assertion.matcher === "notEquals")
    ) {
      errors.push(`Obligation ${obligation.id} requires an inequality assertion; existence or status checks do not prove that the values differ.`);
    }
    if (
      assertions.length > 0 &&
      requiresReturnedId(obligation.text) &&
      !assertions.some(
        (assertion) => assertion.kind === "assert.body.field" && assertion.path === "id" && (assertion.matcher === "exists" || assertion.matcher === "equals")
      )
    ) {
      errors.push(`Obligation ${obligation.id} says the response returns an id, but no assertion proves that the id exists.`);
    }
  }

  return { errors: [...new Set(errors)], gaps: [...new Set(gaps)] };
}

/** Whatever an IR operation is grounded in: an endpoint, a table, or a screen. */
type Grounded = ApiOperation | DbTable | UiScreen;

interface ValueContext {
  dataNames: Set<string>;
  text: string;
  operations: Map<string, { operation: Grounded; index: number }>;
  index: number;
}

const isApiOperation = (operation: Grounded): operation is ApiOperation => operation.layer === "api";
const isDbTable = (operation: Grounded): operation is DbTable => operation.layer === "db";

/**
 * Where a value is allowed to have come from.
 *
 * The rule that does the work is the one about strings: a string literal must appear somewhere in
 * the case's own words. A model that needs a warehouse code and was given none will otherwise
 * invent `"WH-001"`, and the test will pass or fail for reasons belonging to neither the
 * application nor the manual case.
 */
function valueProblems(value: IrValue, where: string, context: ValueContext): string[] {
  if ("testData" in value) {
    return context.dataNames.has(value.testData)
      ? []
      : [`${where} uses test data "${value.testData}", which this case does not define. It defines: ${[...context.dataNames].join(", ") || "none"}.`];
  }

  if ("uniqueTestData" in value) {
    return context.dataNames.has(value.uniqueTestData)
      ? []
      : [`${where} uses run-unique test data "${value.uniqueTestData}", which this case does not define. It defines: ${[...context.dataNames].join(", ") || "none"}.`];
  }

  if ("from" in value) {
    const source = context.operations.get(value.from);
    if (!source) return [`${where} reads from "${value.from}", which is not an operation in this plan.`];
    if (source.index >= context.index) return [`${where} reads from "${value.from}", which does not run before it.`];

    if (source.operation.layer === "ui") {
      return [`${where} reads from "${value.from}", which is a screen; read values from an API response or a database row.`];
    }
    if (!isApiOperation(source.operation)) {
      const table = source.operation;
      return columnOf(table, value.path)
        ? []
        : [`${where} reads "${value.path}" from the ${table.name} table, which has: ${table.columns.map((column) => column.name).join(", ")}.`];
    }
    const response = source.operation.responses.find((entry) => entry.status < 400);
    if (response && response.fields.length > 0 && !response.fields.some((field) => field.path === value.path)) {
      return [
        `${where} reads "${value.path}" from ${source.operation.operationId}, whose response declares: ${response.fields.map((field) => field.path).join(", ")}.`,
      ];
    }
    return [];
  }

  if (typeof value.literal !== "string") return [];
  const literal = value.literal.trim();
  if (literal.length === 0) return [];
  return context.text.includes(literal.toLowerCase())
    ? []
    : [`${where} uses the literal ${JSON.stringify(value.literal)}, which appears nowhere in the case. Use its test data, or a value read from an earlier response.`];
}

function evidenceRefProblems(refs: readonly string[], operation: ApiOperation, what: string): string[] {
  const problems: string[] = [];
  for (const ref of refs) {
    const [base] = ref.split("#");
    if (base !== operation.id && base !== operation.operationId && base !== `api:${operation.operationId}`) {
      problems.push(`The evidence reference "${ref}" on ${what} does not point at ${operation.operationId}.`);
    }
  }
  return problems;
}

function assertionProblems(assertion: SubjectAssertion, operation: Grounded, context: ValueContext): Findings {
  const errors: string[] = [];
  const gaps: string[] = [];

  // A database assertion about an API call, or the reverse, would render to nonsense.
  const wantsDb = assertion.kind === "assert.db.rows" || assertion.kind === "assert.db.field";
  const describeSubject = isApiOperation(operation) ? "an API call" : isDbTable(operation) ? "a database read" : "a screen";
  if (wantsDb !== isDbTable(operation)) {
    return {
      errors: [`The assertion for ${assertion.obligation} is a ${wantsDb ? "database" : "response"} assertion, but "${assertion.of}" is ${describeSubject}.`],
      gaps: [],
    };
  }

  if (isDbTable(operation)) return dbAssertionProblems(assertion, operation, context);
  if (!isApiOperation(operation)) return { errors: [`The assertion for ${assertion.obligation} checks a screen, which only a UI assertion can do.`], gaps: [] };

  const needsValue = assertion.kind !== "assert.status" && "matcher" in assertion && assertion.matcher !== "exists" && assertion.matcher !== "absent";

  if (assertion.kind !== "assert.status" && "matcher" in assertion) {
    if (needsValue && !assertion.value) errors.push(`The "${assertion.matcher}" assertion for ${assertion.obligation} gives no value to compare against.`);
    if (!needsValue && assertion.value) errors.push(`The "${assertion.matcher}" assertion for ${assertion.obligation} takes no value.`);
    if (assertion.value) errors.push(...valueProblems(assertion.value, `assertion for ${assertion.obligation}`, context));
  }

  switch (assertion.kind) {
    case "assert.status": {
      if (!responseFor(operation, assertion.status)) {
        gaps.push(
          `${operation.operationId} declares no ${assertion.status} response (it declares ${operation.responses.map((r) => r.status).join(", ") || "none"}), ` +
            `so this assertion rests on the manual case alone.`
        );
      }
      break;
    }
    case "assert.body.field": {
      // Check against every declared response: the assertion may be about the error body.
      const declared = operation.responses.flatMap((response) => response.fields.map((field) => field.path));
      if (declared.length === 0) {
        gaps.push(`${operation.operationId} declares no response body schema, so the field "${assertion.path}" is not backed by the document.`);
      } else if (!declared.includes(assertion.path)) {
        errors.push(
          `${operation.operationId} declares no response field "${assertion.path}". It declares: ${[...new Set(declared)].join(", ")}.`
        );
      }
      break;
    }
    case "assert.header":
      break;
    default:
      break;
  }

  return { errors, gaps };
}

/** The UI half: a screen and an element a human approved, and a value the case supplied. */
function uiAssertionProblems(
  assertion: Extract<IrAssertion, { kind: "assert.ui.element" }>,
  catalogue: EvidenceCatalogue,
  context: ValueContext
): string[] {
  const screen = screenByName(catalogue, assertion.screen);
  if (!screen) {
    return [
      catalogue.ui.length === 0
        ? `The assertion for ${assertion.obligation} names screen "${assertion.screen}", but this target has no approved UI contract.`
        : `The assertion for ${assertion.obligation} names screen "${assertion.screen}", which is not in the approved UI contract.`,
    ];
  }

  const errors: string[] = [];
  if (!elementOf(screen, assertion.element)) {
    errors.push(`Screen "${screen.name}" has no approved element "${assertion.element}". It has: ${screen.elements.map((element) => element.id).join(", ")}.`);
  }
  const needsValue = assertion.state === "hasText" || assertion.state === "hasValue";
  if (needsValue && !assertion.value) errors.push(`The "${assertion.state}" assertion for ${assertion.obligation} gives no value to compare against.`);
  if (!needsValue && assertion.value) errors.push(`The "${assertion.state}" assertion for ${assertion.obligation} takes no value.`);
  if (assertion.value) errors.push(...valueProblems(assertion.value, `assertion for ${assertion.obligation}`, context));
  return errors;
}

/** The database half: a column that exists, and a value the case supplied. */
function dbAssertionProblems(assertion: IrAssertion, table: DbTable, context: ValueContext): Findings {
  const errors: string[] = [];

  if (assertion.kind === "assert.db.rows") {
    if (assertion.expectation === "exactly" && assertion.count === undefined) {
      errors.push(`The "exactly" row-count assertion for ${assertion.obligation} gives no count.`);
    }
    if (assertion.expectation !== "exactly" && assertion.count !== undefined) {
      errors.push(`The "${assertion.expectation}" row-count assertion for ${assertion.obligation} takes no count.`);
    }
    return { errors, gaps: [] };
  }

  if (assertion.kind === "assert.db.field") {
    if (!columnOf(table, assertion.column)) {
      errors.push(`Table "${table.name}" has no column "${assertion.column}". It has: ${table.columns.map((column) => column.name).join(", ")}.`);
    }
    const needsValue = assertion.matcher !== "exists" && assertion.matcher !== "absent";
    if (needsValue && !assertion.value) errors.push(`The "${assertion.matcher}" assertion for ${assertion.obligation} gives no value to compare against.`);
    if (!needsValue && assertion.value) errors.push(`The "${assertion.matcher}" assertion for ${assertion.obligation} takes no value.`);
    if (assertion.value) errors.push(...valueProblems(assertion.value, `assertion for ${assertion.obligation}`, context));
  }

  return { errors, gaps: [] };
}

/**
 * Nothing downstream may change what a test proves.
 *
 * A repair is allowed to rewire operations — a different path parameter, a call ordered earlier —
 * because those are bindings. The assertions are the promise, and if the promise changes the plan
 * is no longer the plan a human accepted.
 */
export function assertionsUnchanged(accepted: readonly string[], revised: readonly string[]): string[] {
  const before = countsOf(accepted);
  const after = countsOf(revised);
  const problems: string[] = [];
  for (const [fingerprint, count] of before) {
    if ((after.get(fingerprint) ?? 0) < count) problems.push(`The assertion "${fingerprint}" was dropped or weakened.`);
  }
  for (const [fingerprint, count] of after) {
    if ((before.get(fingerprint) ?? 0) < count) problems.push(`The assertion "${fingerprint}" was added after the plan was accepted.`);
  }
  return problems;
}

function countsOf(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

/**
 * The extra gate used after a plan has already been accepted.
 *
 * A repair may change operation bindings and the operation handle a subject assertion points at.
 * It may not change the case, layer, unautomatable decisions, or the semantic identity of any
 * assertion. The ordinary IR policy still runs afterwards against current evidence.
 */
export function validateRepair(accepted: TestIr, revised: TestIr, testCase: NormalisedCase, catalogue: EvidenceCatalogue): Findings {
  const errors = assertionsUnchanged(fingerprintsOf(accepted), fingerprintsOf(revised));

  if (revised.caseId !== accepted.caseId) errors.push(`A repair may not change caseId from "${accepted.caseId}" to "${revised.caseId}".`);
  if (revised.layer !== accepted.layer) errors.push(`A repair may not change layer from "${accepted.layer}" to "${revised.layer}".`);
  if (JSON.stringify(revised.unautomatable) !== JSON.stringify(accepted.unautomatable)) {
    errors.push("A repair may not change which obligations are unautomatable.");
  }

  const findings = validateIr(revised, testCase, catalogue);
  return { errors: [...new Set([...errors, ...findings.errors])], gaps: findings.gaps };
}

export const describeIrValue = describeValue;
