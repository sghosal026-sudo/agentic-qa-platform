import ts from "typescript";
import { GENERATED_MARKER } from "./renderer.js";

/**
 * What a generated spec is not allowed to contain, checked on the syntax tree rather than by
 * pattern-matching the text.
 *
 * The renderer is deterministic, so in principle this can never fire. That is exactly why it is
 * here: it is the check that a renderer change, a new IR shape or a hand edit cannot quietly get
 * past. A regex over the source would be fooled by a path inside a comment or a string built from
 * two halves; the parser is not.
 */

export interface PolicyViolation {
  line: number;
  rule: string;
  detail: string;
}

/** A string that is a URL or an absolute path: the thing a spec must never state for itself. */
const looksLikeRoute = (value: string): boolean => /^https?:\/\//i.test(value) || (/^\/[a-z0-9]/i.test(value) && !value.includes(" "));

/** A CSS or XPath selector. Locators come from an approved contract, never from a spec. */
const looksLikeSelector = (value: string): boolean =>
  /^[.#][a-z][\w-]*$/i.test(value) || /^\/\/[a-z*]/i.test(value) || /\[(data-testid|id|class)=/i.test(value);

export function checkGeneratedSpec(file: string, contents: string): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const source = ts.createSourceFile(file, contents, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  if (!contents.startsWith(`/* ${GENERATED_MARKER}`)) {
    violations.push({ line: 1, rule: "generated-marker", detail: "A generated file must say so on its first line, or the writer will refuse to overwrite it." });
  }

  const tests: { node: ts.CallExpression; name: string; fixme: boolean; hasCaseAnnotation: boolean; expectations: number }[] = [];
  let importsFrameworkFixture = false;

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      if (node.moduleSpecifier.text === "@playwright/test") {
        violations.push({
          line: lineOf(node),
          rule: "framework-import",
          detail: "Generated specs import test and expect from ../../fixtures/test.js, not directly from @playwright/test.",
        });
      }
      if (["../../fixtures/test.js", "./_support/fixtures.js"].includes(node.moduleSpecifier.text)) importsFrameworkFixture = true;
    }

    if (ts.isStringLiteralLike(node)) {
      const value = node.text;
      if (looksLikeRoute(value)) {
        violations.push({
          line: lineOf(node),
          rule: "no-literal-route",
          detail: `The path ${JSON.stringify(value)} is written into the spec. Paths come from the generated routes module, so they trace to an operation id.`,
        });
      }
      if (looksLikeSelector(value)) {
        violations.push({
          line: lineOf(node),
          rule: "no-literal-selector",
          detail: `The selector ${JSON.stringify(value)} is written into the spec. Locators come from the approved UI contract.`,
        });
      }
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source);
      if (/\.(?:get|post|put|patch|delete|head|fetch)$/.test(callee)) {
        violations.push({
          line: lineOf(node),
          rule: "api-object-model",
          detail: "Generated specs call evidence-derived API object methods, not raw HTTP verbs.",
        });
      }
      if (callee === "page.goto") {
        violations.push({
          line: lineOf(node),
          rule: "page-object-model",
          detail: "Generated specs navigate through an approved page object, not page.goto directly.",
        });
      }
      if (/\.(?:select|all|run|exec)$/.test(callee)) {
        violations.push({
          line: lineOf(node),
          rule: "data-integrity-object-model",
          detail: "Generated specs read persisted state through the data-integrity object model.",
        });
      }
      if (callee === "test" || callee === "test.fixme" || callee === "test.skip" || callee === "test.only") {
        tests.push({
          node,
          name: ts.isStringLiteralLike(node.arguments[0]!) ? (node.arguments[0] as ts.StringLiteralLike).text : "(unnamed)",
          fixme: callee !== "test",
          hasCaseAnnotation: hasAnnotationOfType(node, "case"),
          expectations: countExpectations(node, source),
        });
      }
      if (callee === "test.only") {
        violations.push({ line: lineOf(node), rule: "no-test-only", detail: "test.only would silence the rest of the suite." });
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(source);

  if (!importsFrameworkFixture) {
    violations.push({
      line: 1,
      rule: "framework-import",
      detail: "The spec does not use the framework fixture at ../../fixtures/test.js.",
    });
  }

  for (const entry of tests) {
    const line = lineOf(entry.node);
    if (!entry.hasCaseAnnotation) {
      violations.push({
        line,
        rule: "traceability",
        detail: `"${entry.name}" carries no { type: "case" } annotation, so a run result could not be traced back to the manual case.`,
      });
    }
    if (!entry.fixme && entry.expectations === 0) {
      violations.push({
        line,
        rule: "no-empty-test",
        detail: `"${entry.name}" asserts nothing. A test that cannot fail is worse than no test: it reports coverage it does not have.`,
      });
    }
    if (usesBuiltInRequestFixture(entry.node)) {
      violations.push({
        line,
        rule: "framework-api-fixture",
        detail: `"${entry.name}" uses Playwright's request fixture directly. Generated API calls use the framework context through an API object model.`,
      });
    }
  }

  if (tests.length === 0) {
    violations.push({ line: 1, rule: "no-tests", detail: "The file declares no tests." });
  }

  return violations;
}

function usesBuiltInRequestFixture(call: ts.CallExpression): boolean {
  const body = call.arguments.find((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
  const parameter = body?.parameters[0];
  if (!parameter || !ts.isObjectBindingPattern(parameter.name)) return false;
  return parameter.name.elements.some((element) => element.name.getText() === "request");
}

function hasAnnotationOfType(call: ts.CallExpression, type: string): boolean {
  const options = call.arguments[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return false;
  const annotation = options.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText() === "annotation");
  if (!annotation || !ts.isPropertyAssignment(annotation) || !ts.isArrayLiteralExpression(annotation.initializer)) return false;

  return annotation.initializer.elements.some((element) => {
    if (!ts.isObjectLiteralExpression(element)) return false;
    return element.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        property.name.getText() === "type" &&
        ts.isStringLiteralLike(property.initializer) &&
        property.initializer.text === type
    );
  });
}

function countExpectations(call: ts.CallExpression, source: ts.SourceFile): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "expect") count += 1;
    ts.forEachChild(node, visit);
  };
  // Only the test's own body, so a nested test cannot lend its assertions to its parent.
  const body = call.arguments.find((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
  if (body) visit(body);
  return count;
}

export function describeViolations(file: string, violations: readonly PolicyViolation[]): string {
  return violations.map((violation) => `  ${file}:${violation.line} [${violation.rule}] ${violation.detail}`).join("\n");
}
