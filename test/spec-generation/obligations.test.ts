import assert from "node:assert/strict";
import test from "node:test";
import { isVagueExpectedResult, obligationsFor } from "../../src/spec-generation/ingest/obligations.js";
import { API_CASE, caseByKey, fixtureDesign, PROSE_CASE } from "./helpers/fixtureDesign.js";

test("an expected result naming something observable is not vague", () => {
  for (const text of [
    "The response status code is 409.",
    "A success message is displayed.",
    "A row with the code exists in the warehouse table.",
    "The warehouse form is shown.",
  ]) {
    assert.equal(isVagueExpectedResult(text), false, text);
  }
});

test("an expected result that asserts nothing is flagged", () => {
  for (const text of [
    "The system responds as the scenario expects.",
    "It works as expected.",
    "The application behaves correctly.",
    "No errors occur.",
    "Successful",
    "   ",
  ]) {
    assert.equal(isVagueExpectedResult(text), true, text);
  }
});

test("one obligation per step, numbered from the step", () => {
  const obligations = obligationsFor("TestCase:x", "x", [
    { stepNumber: 1, action: "a", expectedResult: "The response status code is 201." },
    { stepNumber: 2, action: "b", expectedResult: "As expected." },
  ]);

  assert.deepEqual(obligations.map((obligation) => obligation.id), ["x.step-1", "x.step-2"]);
  assert.deepEqual(obligations.map((obligation) => obligation.vague), [false, true]);
  assert.equal(obligations[0]!.text, "The response status code is 201.", "the manual text is carried verbatim");
});

test("the fixture's vague steps are flagged and its concrete ones are not", () => {
  const design = fixtureDesign();

  const apiCase = caseByKey(design, API_CASE);
  assert.deepEqual(apiCase.obligations.map((obligation) => obligation.vague), [false, true]);

  const proseCase = caseByKey(design, PROSE_CASE);
  assert.ok(
    proseCase.obligations.every((obligation) => obligation.vague === false || obligation.vague === true),
    "every obligation carries a verdict"
  );
  assert.equal(proseCase.obligations.length, 2, "a case no assertion can be derived from still owes its obligations");
});
