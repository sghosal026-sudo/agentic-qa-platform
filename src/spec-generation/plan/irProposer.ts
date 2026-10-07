import { z } from "zod";
import type { EvidenceCatalogue } from "../evidence/catalogue.js";
import { GenerationFailedError } from "../errors.js";
import { validateIr } from "../ir/irPolicy.js";
import { TestIrSchema, type PlannedCase, type TestIr } from "../ir/testIr.js";
import type { LlmClient, TokenUsage } from "../llm/llmClient.js";
import type { Logger } from "../logging/logger.js";
import type { NormalisedCase } from "../model/testCase.js";
import { describeAuthentication, describeCase, describeObligations, describeOperations, describeScreens, describeTables, relevantOperations, relevantTables } from "./evidenceView.js";
import { PromptLibrary } from "./promptLibrary.js";
import { StructuredGenerator } from "./structuredGenerator.js";

/**
 * Asks the model for a plan, and accepts one only if the policy agrees with it.
 *
 * The model is never asked to be careful — it is put in a position where carelessness does not get
 * through. Its answer is parsed against the IR schema, then checked against the evidence, and every
 * problem goes back to it in the model's own terms ("this operation is not in the evidence") rather
 * than as a bare rejection.
 *
 * A case that still cannot be planned after the allowed attempts is not a failure of the run. It
 * becomes a fixme carrying the reasons, which is the honest outcome and the one a human can act on.
 */

export interface PlanOutcome {
  testCase: NormalisedCase;
  planned?: PlannedCase;
  /** Why no plan could be accepted, when there is none. */
  failure?: string;
  usage: TokenUsage;
}

export class IrProposer {
  private readonly prompts: PromptLibrary;
  private readonly generator: StructuredGenerator;

  constructor(
    llm: LlmClient,
    private readonly logger: Logger,
    maxAttempts: number,
    prompts: PromptLibrary = new PromptLibrary()
  ) {
    this.prompts = prompts;
    // Gaps are accepted rather than retried: an evidence gap is a fact about the target's document,
    // and asking again spends an attempt to be told the same thing.
    this.generator = new StructuredGenerator(llm, prompts, maxAttempts, logger, false);
  }

  async propose(
    testCase: NormalisedCase,
    catalogue: EvidenceCatalogue,
    graphContext = "No graph retrieval context is available for this offline input.",
  ): Promise<PlanOutcome> {
    const operations = relevantOperations(testCase, catalogue);
    if (operations.length === 0 && catalogue.ui.length === 0 && catalogue.db.length === 0) {
      return {
        testCase,
        failure: `Nothing in the target's evidence resembles anything this case describes, so there is nothing to ground it in.`,
        usage: { promptTokens: 0, completionTokens: 0 },
      };
    }

    const tables = relevantTables(testCase, catalogue);
    const userPrompt = this.prompts.render("ir-proposal", {
      testCase: describeCase(testCase),
      obligations: describeObligations(testCase),
      operations: describeOperations(operations),
      authentication: describeAuthentication(catalogue),
      tables: tables.length > 0 ? describeTables(tables) : "No database is configured for this target, so no database assertion is possible.",
      screens: catalogue.ui.length > 0 ? describeScreens(catalogue.ui) : "This target has no approved UI contract, so no screen can be driven.",
      graphContext,
      schema: JSON.stringify(z.toJSONSchema(TestIrSchema, { io: "input" }), null, 2),
    });

    try {
      const result = await this.generator.generate<TestIr>({
        label: `plan ${testCase.key}`,
        systemPrompt: this.prompts.render("system", {}),
        userPrompt,
        schema: TestIrSchema,
        // The model is shown a subset of the catalogue, but is checked against all of it: choosing
        // a real operation that was not offered is right, not wrong.
        validate: (value) => validateIr(value, testCase, catalogue),
      });

      return {
        testCase,
        planned: { ir: result.value, gaps: result.gaps, attempts: result.attempts },
        usage: result.usage,
      };
    } catch (error) {
      if (error instanceof GenerationFailedError) {
        this.logger.warn(`${testCase.key}: no usable plan after ${error.attempts} attempt(s)`);
        return { testCase, failure: error.problems.slice(0, 3).join(" | "), usage: { promptTokens: 0, completionTokens: 0 } };
      }
      throw error;
    }
  }
}
