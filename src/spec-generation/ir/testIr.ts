import { z } from "zod";

/**
 * The TestIR: what the model is allowed to say.
 *
 * The model never writes TypeScript. It fills in this structure, and a renderer turns an accepted
 * structure into a spec. Everything that makes a generated test trustworthy is a property of this
 * schema and the policy beside it: an operation is chosen from the evidence catalogue by id, a
 * value is either test data the case supplied or something read from an earlier response, and an
 * assertion states the matcher and the expected value explicitly so that neither can drift.
 *
 * Assertions are typed rather than free-form so that "did this stay faithful to the manual expected
 * result?" is a question about data, answerable by `==`, instead of a question about code.
 */

/** Where a value comes from. Never "whatever the model felt like". */
export const ValueSchema = z.union([
  /** A literal. Policy restricts strings to text the case itself supplies. */
  z.object({ literal: z.union([z.string(), z.number(), z.boolean(), z.null()]) }).strict(),
  /** One of the case's own test data entries, by name. */
  z.object({ testData: z.string().min(1) }).strict(),
  /** A run-unique string derived from one of the case's own test data entries. */
  z.object({ uniqueTestData: z.string().min(1) }).strict(),
  /** A field of an earlier response: `{ from: "created", path: "id" }`. */
  z.object({ from: z.string().min(1), path: z.string().min(1) }).strict(),
]);

export type IrValue = z.infer<typeof ValueSchema>;

const ValueMap = z.record(z.string().min(1), ValueSchema);

export const AuthHeaderSchema = z.object({
  kind: z.literal("auth.header"),
  id: z.string().min(1),
  token: ValueSchema,
  headerName: z.literal("Authorization"),
  scheme: z.literal("Bearer"),
  evidenceRefs: z.array(z.string().min(1)).min(1),
}).strict();

export const AuthApiSchema = z.object({
  kind: z.literal("auth.api"),
  id: z.string().min(1),
  operationId: z.string().min(1),
  body: ValueMap.optional(),
  tokenPath: z.string().min(1),
  headerName: z.literal("Authorization"),
  scheme: z.literal("Bearer"),
  evidenceRefs: z.array(z.string().min(1)).min(1),
}).strict();

export const AuthUnavailableSchema = z.object({
  kind: z.literal("auth.unavailable"),
  id: z.string().min(1),
  reason: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)).default([]),
}).strict();

export const ApiRequestSchema = z
  .object({
    kind: z.literal("api.request"),
    /** The handle assertions and later operations refer to this call by. */
    id: z.string().min(1),
    /** Which manual step this carries out. Keeps the spec readable and the manifest honest. */
    step: z.number().int().positive().optional(),
    /** An `operationId` from the evidence catalogue. */
    operationId: z.string().min(1),
    pathParams: ValueMap.optional(),
    query: ValueMap.optional(),
    headers: ValueMap.optional(),
    body: ValueMap.optional(),
    evidenceRefs: z.array(z.string().min(1)).min(1),
  })
  .strict();

/** Comparisons a database predicate may use. There is no "raw" option, and there never will be. */
export const PredicateSchema = z
  .object({
    column: z.string().min(1),
    op: z.enum(["eq", "neq", "gt", "lt", "gte", "lte", "contains", "isNull", "notNull"]),
    /** Required by every comparison except `isNull` and `notNull`. */
    value: ValueSchema.optional(),
  })
  .strict();

export type IrPredicate = z.infer<typeof PredicateSchema>;

/**
 * A read of the target's database.
 *
 * The plan names a table, some columns and some comparisons. It does not write SQL — the query is
 * built from this by the renderer, parameterised, against a handle the engine opened read-only.
 * There is deliberately no way to express anything but a SELECT.
 */
export const DbReadSchema = z
  .object({
    kind: z.literal("db.read"),
    id: z.string().min(1),
    step: z.number().int().positive().optional(),
    table: z.string().min(1),
    where: z.array(PredicateSchema).min(1),
    evidenceRefs: z.array(z.string().min(1)).min(1),
  })
  .strict();

/** Opening a screen from the approved contract. The only way a spec reaches a URL. */
export const UiGotoSchema = z
  .object({
    kind: z.literal("ui.goto"),
    id: z.string().min(1),
    step: z.number().int().positive().optional(),
    screen: z.string().min(1),
    evidenceRefs: z.array(z.string().min(1)).min(1),
  })
  .strict();

/**
 * Doing something to an approved element.
 *
 * The plan names a screen and an element from the contract — never a selector. A control that is
 * not in the contract cannot be acted on, which is the whole point of the contract.
 */
export const UiActSchema = z
  .object({
    kind: z.literal("ui.act"),
    id: z.string().min(1),
    step: z.number().int().positive().optional(),
    screen: z.string().min(1),
    element: z.string().min(1),
    action: z.enum(["click", "fill", "check", "uncheck", "selectOption", "press"]),
    /** Required by fill, selectOption and press. */
    value: ValueSchema.optional(),
    evidenceRefs: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const OperationSchema = z.discriminatedUnion("kind", [
  AuthHeaderSchema,
  AuthApiSchema,
  AuthUnavailableSchema,
  ApiRequestSchema,
  DbReadSchema,
  UiGotoSchema,
  UiActSchema,
]);
export type IrOperation = z.infer<typeof OperationSchema>;

/** Matchers an assertion may use. Each renders to exactly one Playwright expectation. */
export const MatcherSchema = z.enum(["equals", "notEquals", "contains", "matches", "exists", "absent"]);
export type IrMatcher = z.infer<typeof MatcherSchema>;

const assertionBase = {
  /** The manual expected result this assertion discharges. */
  obligation: z.string().min(1),
  /** The operation whose result is being checked. */
  of: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)).default([]),
};

export const AssertStatusSchema = z
  .object({ kind: z.literal("assert.status"), ...assertionBase, status: z.number().int().min(100).max(599) })
  .strict();

export const AssertBodyFieldSchema = z
  .object({
    kind: z.literal("assert.body.field"),
    ...assertionBase,
    /** A field path from the operation's declared response, e.g. `code` or `[].id`. */
    path: z.string().min(1),
    matcher: MatcherSchema,
    /** Required by every matcher except `exists` and `absent`. */
    value: ValueSchema.optional(),
  })
  .strict();

export const AssertHeaderSchema = z
  .object({
    kind: z.literal("assert.header"),
    ...assertionBase,
    name: z.string().min(1),
    matcher: MatcherSchema,
    value: ValueSchema.optional(),
  })
  .strict();

/** How many rows the read found. `exists` and `absent` are the common cases, said plainly. */
export const AssertDbRowsSchema = z
  .object({
    kind: z.literal("assert.db.rows"),
    ...assertionBase,
    expectation: z.enum(["exists", "absent", "exactly"]),
    /** Required by `exactly`. */
    count: z.number().int().nonnegative().optional(),
  })
  .strict();

/** A column of the first row the read found. */
export const AssertDbFieldSchema = z
  .object({
    kind: z.literal("assert.db.field"),
    ...assertionBase,
    column: z.string().min(1),
    matcher: MatcherSchema,
    value: ValueSchema.optional(),
  })
  .strict();

/**
 * What an approved element should look like to a user.
 *
 * Named by screen and element rather than by an operation handle, because "the success message is
 * visible" is about the page, not about the click that caused it.
 */
export const AssertUiElementSchema = z
  .object({
    kind: z.literal("assert.ui.element"),
    obligation: z.string().min(1),
    evidenceRefs: z.array(z.string().min(1)).default([]),
    screen: z.string().min(1),
    element: z.string().min(1),
    state: z.enum(["visible", "hidden", "enabled", "disabled", "checked", "hasText", "hasValue"]),
    /** Required by hasText and hasValue. */
    value: ValueSchema.optional(),
  })
  .strict();

export const AssertionSchema = z.discriminatedUnion("kind", [
  AssertStatusSchema,
  AssertBodyFieldSchema,
  AssertHeaderSchema,
  AssertDbRowsSchema,
  AssertDbFieldSchema,
  AssertUiElementSchema,
]);
export type IrAssertion = z.infer<typeof AssertionSchema>;

/**
 * An assertion about the result of a named operation.
 *
 * Every assertion but the UI one checks something an operation produced — a response, a set of
 * rows — and so carries `of`. A UI assertion is about the page itself, named by screen and
 * element, which is why it has no subject to point at.
 */
export type SubjectAssertion = Exclude<IrAssertion, { kind: "assert.ui.element" }>;

export const hasSubject = (assertion: IrAssertion): assertion is SubjectAssertion => assertion.kind !== "assert.ui.element";

export const TestIrSchema = z
  .object({
    caseId: z.string().min(1),
    /** Which layer the spec is written in. Database reads can appear in either. */
    layer: z.enum(["api", "db", "ui"]),
    ops: z.array(OperationSchema).min(1),
    assertions: z.array(AssertionSchema).default([]),
    /**
     * Obligations no assertion can discharge, each with the reason.
     *
     * This is the honest exit, and the only one: an obligation is either asserted or listed here.
     * A case with anything in this list is rendered as a `fixme` carrying these reasons, so it
     * arrives in front of a human instead of passing quietly.
     */
    unautomatable: z
      .array(z.object({ obligation: z.string().min(1), reason: z.string().min(1) }).strict())
      .default([]),
  })
  .strict();

export type TestIr = z.infer<typeof TestIrSchema>;

/** An accepted IR, with what the policy had to say about it. */
export interface PlannedCase {
  ir: TestIr;
  /** Assertions the evidence neither supports nor contradicts. Recorded, not hidden. */
  gaps: string[];
  attempts: number;
}

/**
 * The identity of an assertion: its kind, what it checks, and what it expects.
 *
 * Two IRs with the same fingerprints make the same promises. This is what "assertions are frozen
 * after a plan is accepted" is enforced with — a repair may rewire an operation, but if a
 * fingerprint changes, the repair has changed what the test proves and is rejected.
 */
export function assertionFingerprint(assertion: IrAssertion): string {
  const value = "value" in assertion && assertion.value ? JSON.stringify(assertion.value) : "";
  switch (assertion.kind) {
    case "assert.status":
      return `${assertion.obligation}|assert.status|${assertion.status}`;
    case "assert.body.field":
      return `${assertion.obligation}|assert.body.field|${assertion.path}|${assertion.matcher}|${value}`;
    case "assert.header":
      return `${assertion.obligation}|assert.header|${assertion.name}|${assertion.matcher}|${value}`;
    case "assert.db.rows":
      return `${assertion.obligation}|assert.db.rows|${assertion.expectation}|${assertion.count ?? ""}`;
    case "assert.db.field":
      return `${assertion.obligation}|assert.db.field|${assertion.column}|${assertion.matcher}|${value}`;
    case "assert.ui.element":
      return `${assertion.obligation}|assert.ui.element|${assertion.screen}.${assertion.element}|${assertion.state}|${value}`;
  }
}

export const fingerprintsOf = (ir: TestIr): string[] => ir.assertions.map(assertionFingerprint).sort();
