import type { NodeRef, NormalisedCase, NormalisedDesign } from "../model/testCase.js";
import { obligationsFor } from "./obligations.js";

/**
 * The document's shape, as the schema guarantees it.
 *
 * These are read-only views of an object that has already passed `schemaBoundary`. They exist so
 * the walk below can be written plainly; they are not a second validation and must not become one.
 */
interface RawRef {
  nodeId: string;
  nodeType: string;
  name: string;
}

interface RawStep {
  stepNumber: number;
  action: string;
  expectedResult: string;
}

interface RawCase extends RawRef {
  objective: string;
  caseKind: string;
  priority: string;
  testTypes: string[];
  preconditions: string[];
  testData: { name: string; value: string; notes?: string }[];
  steps: RawStep[];
  coversAcceptanceCriteria: RawRef[];
  validates: RawRef[];
  exercises: RawRef[];
  alsoInSuites: RawRef[];
  automation: { candidate: boolean; notes?: string };
}

interface RawScenario extends RawRef {
  description?: string;
  expectedOutcome?: string;
  tracesTo: { backlogItems?: RawRef[]; acceptanceCriteria?: RawRef[] };
  covers: RawRef[];
  exercises: RawRef[];
  testCases: RawCase[];
  reusedTestCases: RawRef[];
}

interface RawSuite extends RawRef {
  testType: string;
  testScenarios: RawScenario[];
  includedTestCasesFromOtherSuites: RawRef[];
}

interface RawDocument {
  sprint: RawRef;
  generatedBy?: Record<string, unknown>;
  testPlan: { testSuites: RawSuite[] };
}

/** `TestCase:verify-x` → `verify-x`. The prefix is the graph's; the rest is the case's own name. */
export function caseKeyOf(nodeId: string): string {
  const separator = nodeId.indexOf(":");
  const tail = separator >= 0 ? nodeId.slice(separator + 1) : nodeId;
  return tail.trim().length > 0 ? tail.trim() : nodeId;
}

const toRef = (ref: RawRef): NodeRef => ({ nodeId: ref.nodeId, nodeType: ref.nodeType, name: ref.name });

const uniqueSorted = (values: readonly string[]): string[] => [...new Set(values)].sort();

/**
 * Flattens the document into one entry per test case.
 *
 * A case is defined once, inside one scenario, but several suites can include it (`alsoInSuites`,
 * `includedTestCasesFromOtherSuites`). Membership is merged onto the single definition, so a case
 * is automated once and appears in the manifest once, whatever number of suites claim it.
 *
 * `reusedTestCases` point at cases that live in the graph but are not written out here. There is
 * nothing to read and so nothing to generate; they are reported as dangling references.
 */
export function normalise(document: unknown, source: string): NormalisedDesign {
  const raw = document as RawDocument;
  const byId = new Map<string, NormalisedCase>();
  const referenced = new Set<string>();

  for (const suite of raw.testPlan.testSuites) {
    for (const included of suite.includedTestCasesFromOtherSuites ?? []) referenced.add(included.nodeId);

    for (const scenario of suite.testScenarios) {
      for (const reused of scenario.reusedTestCases ?? []) referenced.add(reused.nodeId);
      const stories = (scenario.tracesTo.backlogItems ?? []).map((item) => item.nodeId);

      for (const testCase of scenario.testCases) {
        const existing = byId.get(testCase.nodeId);
        if (existing) {
          // Defined twice. Keep the first definition and only widen where it belongs.
          existing.suites = uniqueSorted([...existing.suites, suite.nodeId]);
          existing.stories = uniqueSorted([...existing.stories, ...stories]);
          continue;
        }

        const key = caseKeyOf(testCase.nodeId);
        const steps = [...testCase.steps].sort((a, b) => a.stepNumber - b.stepNumber);
        byId.set(testCase.nodeId, {
          caseId: testCase.nodeId,
          key,
          name: testCase.name,
          objective: testCase.objective,
          caseKind: testCase.caseKind,
          priority: testCase.priority,
          testTypes: uniqueSorted(testCase.testTypes),
          suites: uniqueSorted([suite.nodeId, ...(testCase.alsoInSuites ?? []).map((s) => s.nodeId)]),
          stories: uniqueSorted(stories),
          scenario: {
            nodeId: scenario.nodeId,
            name: scenario.name,
            description: scenario.description ?? "",
            ...(scenario.expectedOutcome ? { expectedOutcome: scenario.expectedOutcome } : {}),
            exercises: dedupeRefs(scenario.exercises.map(toRef)),
            covers: dedupeRefs(scenario.covers.map(toRef)),
          },
          preconditions: [...testCase.preconditions],
          testData: testCase.testData.map((datum) => ({ name: datum.name, value: datum.value })),
          steps: steps.map((step) => ({ stepNumber: step.stepNumber, action: step.action, expectedResult: step.expectedResult })),
          // Only what the case itself names. The scenario's own references are kept beside it, as
          // context, because letting them stand in for the case's would make every case under a
          // screen scenario look like a UI case whether or not it says anything about a screen.
          exercises: dedupeRefs(testCase.exercises.map(toRef)),
          validates: dedupeRefs(testCase.validates.map(toRef)),
          automationCandidate: testCase.automation.candidate,
          ...(testCase.automation.notes ? { automationNotes: testCase.automation.notes } : {}),
          obligations: obligationsFor(testCase.nodeId, key, steps),
        });
      }
    }
  }

  return {
    source,
    sprint: { nodeId: raw.sprint.nodeId, name: raw.sprint.name },
    ...(raw.generatedBy ? { generatedBy: raw.generatedBy } : {}),
    cases: [...byId.values()],
    danglingCaseRefs: [...referenced].filter((nodeId) => !byId.has(nodeId)).sort(),
  };
}

function dedupeRefs(refs: readonly NodeRef[]): NodeRef[] {
  const byId = new Map<string, NodeRef>();
  for (const ref of refs) if (!byId.has(ref.nodeId)) byId.set(ref.nodeId, ref);
  return [...byId.values()];
}
