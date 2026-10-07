import type { AssertionObligation, ManualStep } from "../model/testCase.js";

/**
 * Expected results that assert nothing on their own.
 *
 * test-design-agent writes plain English for a human reader, and a human fills in the rest from the
 * scenario. A generator cannot: "the system responds as the scenario expects" names no observable
 * outcome, so no assertion follows from it. Such an obligation is kept and flagged, never dropped —
 * a case whose only obligations are vague is a case a human still has to finish.
 */
const VAGUE_PATTERNS: readonly RegExp[] = [
  /\bas (the |this )?(scenario|test case|case|story|requirement)s? (expects?|describes?|states?|says?)\b/i,
  /\bas expected\b/i,
  /\bworks? (as expected|correctly|properly)\b/i,
  /\bbehaves? (as expected|correctly)\b/i,
  /\b(the )?(system|application|app|page|screen)( responds| behaves| reacts)?( appropriately| accordingly| correctly| as expected)\b/i,
  /^(it )?(is )?(successful|success|ok|fine|done|passes?)\.?$/i,
  /\bno (unexpected )?(errors?|issues?|problems?)( (occur|are shown|are displayed))?\.?$/i,
];

/** A step's expected result names something observable that an assertion could check. */
export function isVagueExpectedResult(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  return VAGUE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * One obligation per step, in step order.
 *
 * Every step gets one, including vague ones: the count of obligations is the count of promises the
 * manual case makes, and the manifest reports coverage against exactly that number.
 */
export function obligationsFor(caseId: string, caseKey: string, steps: readonly ManualStep[]): AssertionObligation[] {
  return steps.map((step) => ({
    id: `${caseKey}.step-${step.stepNumber}`,
    caseId,
    stepNumber: step.stepNumber,
    text: step.expectedResult.trim(),
    vague: isVagueExpectedResult(step.expectedResult),
  }));
}
