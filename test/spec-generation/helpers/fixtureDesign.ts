import { readFileSync } from "node:fs";
import { resolveFromRoot } from "../../../src/spec-generation/config/paths.js";
import { hintsFor } from "../../../src/spec-generation/ingest/layerHints.js";
import { normalise } from "../../../src/spec-generation/ingest/normalise.js";
import type { NormalisedCase, NormalisedDesign } from "../../../src/spec-generation/model/testCase.js";

/**
 * A small design document written for these tests, valid against the same schema as the real input.
 *
 * It holds one of each thing the ingest layer has to get right: an API case included by two suites,
 * a case that drives the UI and checks a row, a case whose steps name no layer at all, a case the
 * design marks as a poor automation candidate, and a reference to a case that is not in the
 * document. Unlike the sibling's example it is checked in here, so these tests do not depend on
 * another project being present.
 */
export const FIXTURE_FILE = resolveFromRoot("test", "spec-generation", "fixtures", "design.fixture.json");

export function fixtureDocument(): Record<string, unknown> {
  return JSON.parse(readFileSync(FIXTURE_FILE, "utf8")) as Record<string, unknown>;
}

export function fixtureDesign(): NormalisedDesign {
  return normalise(fixtureDocument(), FIXTURE_FILE);
}

export function fixtureHints(design: NormalisedDesign = fixtureDesign()) {
  return hintsFor(design.cases);
}

export function caseByKey(design: NormalisedDesign, key: string): NormalisedCase {
  const found = design.cases.find((testCase) => testCase.key === key);
  if (!found) throw new Error(`No case "${key}" in the fixture; it has: ${design.cases.map((c) => c.key).join(", ")}`);
  return found;
}

export const API_CASE = "api-duplicate-code-is-rejected";
export const UI_DB_CASE = "ui-warehouse-is-created";
export const PROSE_CASE = "prose-only-case";
export const NON_CANDIDATE_CASE = "manual-sign-off";