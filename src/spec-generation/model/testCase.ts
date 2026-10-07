/**
 * The agent's own model of a manual test case.
 *
 * The input document belongs to test-design-agent and is shaped for a knowledge graph. This model
 * is shaped for generating a spec: one flat case per node id, its steps, and — the part everything
 * downstream is measured against — its assertion obligations.
 */

/** The three kinds of check a generated spec can make. */
export type Layer = "api" | "ui" | "db";

export const LAYERS: readonly Layer[] = ["api", "ui", "db"];

/** A pointer at a node in the knowledge graph the input came from. */
export interface NodeRef {
  nodeId: string;
  nodeType: string;
  name: string;
}

export interface ManualStep {
  stepNumber: number;
  action: string;
  expectedResult: string;
}

export interface TestDatum {
  name: string;
  value: string;
}

/**
 * One thing the manual case says must be true, which the generated spec owes an assertion for.
 *
 * Obligations are the unit of the proof chain: manual expectedResult → obligation → IR assertion →
 * rendered line → run result. Every obligation must end up either covered by an assertion or
 * declared unautomatable with a reason. Nothing downstream may quietly drop one.
 */
export interface AssertionObligation {
  /** Stable and readable: `<case key>.step-<n>`. Appears in the IR, the spec and the manifest. */
  id: string;
  caseId: string;
  stepNumber: number;
  /** The manual expected result, verbatim. Never paraphrased: this is the thing being proved. */
  text: string;
  /**
   * The text names no observable outcome ("the system responds as the scenario expects"), so no
   * assertion can be derived from it alone. Still an obligation — it is reported, not discarded.
   */
  vague: boolean;
}

/** One manual test case, deduplicated across the suites that include it. */
export interface NormalisedCase {
  /** The input's node id, e.g. `TestCase:verify-duplicate-warehouse-code-is-rejected`. */
  caseId: string;
  /** The node id without its type prefix. Used in obligation ids and the spec's test annotation. */
  key: string;
  name: string;
  objective: string;
  caseKind: string;
  priority: string;
  /** Test types declared on the case (functional, smoke, …). */
  testTypes: string[];
  /** Suite node ids that include this case, from every suite it was found in. */
  suites: string[];
  /** Backlog item ids reached through the scenario. Decides which spec file the case lands in. */
  stories: string[];
  /**
   * The scenario the case sits under.
   *
   * Its `exercises` and `covers` are context for a reader — and for the planner's prompt — but they
   * are deliberately *not* treated as signal about the case's own layer. A case that says nothing
   * about a screen is not a UI case merely because a sibling case under the same scenario is.
   */
  scenario: {
    nodeId: string;
    name: string;
    description: string;
    expectedOutcome?: string;
    exercises: NodeRef[];
    covers: NodeRef[];
  };
  preconditions: string[];
  testData: TestDatum[];
  steps: ManualStep[];
  /** System parts the case itself names: `Endpoint:post-warehouses`, `Screen:…`, `DataTable:…`. */
  exercises: NodeRef[];
  /** Business rules and criteria the case itself proves. */
  validates: NodeRef[];
  automationCandidate: boolean;
  automationNotes?: string;
  obligations: AssertionObligation[];
}

/** The whole input, normalised. */
export interface NormalisedDesign {
  source: string;
  sprint: { nodeId: string; name: string };
  generatedBy?: Record<string, unknown>;
  cases: NormalisedCase[];
  /** Case node ids the document referenced but never defined. */
  danglingCaseRefs: string[];
}
