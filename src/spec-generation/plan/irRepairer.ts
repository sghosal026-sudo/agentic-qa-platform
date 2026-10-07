import { z } from "zod";
import type { EvidenceCatalogue } from "../evidence/catalogue.js";
import { GenerationFailedError } from "../errors.js";
import { validateRepair } from "../ir/irPolicy.js";
import { TestIrSchema, type PlannedCase, type TestIr } from "../ir/testIr.js";
import type { LlmClient, TokenUsage } from "../llm/llmClient.js";
import type { Logger } from "../logging/logger.js";
import type { NormalisedCase } from "../model/testCase.js";
import {
  describeCase,
  describeAuthentication,
  describeOperations,
  describeScreens,
  describeTables,
  relevantOperations,
  relevantTables,
} from "./evidenceView.js";
import { PromptLibrary } from "./promptLibrary.js";
import { StructuredGenerator } from "./structuredGenerator.js";

export interface RepairOutcome {
  planned?: PlannedCase;
  failure?: string;
  usage: TokenUsage;
}

/** Revises a failed plan while the accepted assertions remain frozen. */
export class IrRepairer {
  private readonly prompts: PromptLibrary;
  private readonly generator: StructuredGenerator;

  constructor(llm: LlmClient, private readonly logger: Logger, maxAttempts: number, prompts: PromptLibrary = new PromptLibrary()) {
    this.prompts = prompts;
    this.generator = new StructuredGenerator(llm, prompts, maxAttempts, logger, false);
  }

  async repair(
    testCase: NormalisedCase,
    accepted: PlannedCase,
    catalogue: EvidenceCatalogue,
    failure: string,
    graphContext = "No graph retrieval context is available for this offline input.",
  ): Promise<RepairOutcome> {
    const operations = relevantOperations(testCase, catalogue);
    const tables = relevantTables(testCase, catalogue);
    const userPrompt = this.prompts.render("ir-repair", {
      testCase: describeCase(testCase),
      failure,
      acceptedIr: JSON.stringify(accepted.ir, null, 2),
      operations: operations.length > 0 ? describeOperations(operations) : "No API operations are relevant to this case.",
      authentication: describeAuthentication(catalogue),
      tables: tables.length > 0 ? describeTables(tables) : "No database is configured for this target.",
      screens: catalogue.ui.length > 0 ? describeScreens(catalogue.ui) : "This target has no approved UI contract.",
      graphContext,
      schema: JSON.stringify(z.toJSONSchema(TestIrSchema, { io: "input" }), null, 2),
    });

    try {
      const result = await this.generator.generate<TestIr>({
        label: `repair ${testCase.key}`,
        systemPrompt: this.prompts.render("system", {}),
        userPrompt,
        schema: TestIrSchema,
        validate: (value) => validateRepair(accepted.ir, value, testCase, catalogue),
      });
      return {
        planned: { ir: result.value, gaps: result.gaps, attempts: accepted.attempts + result.attempts },
        usage: result.usage,
      };
    } catch (error) {
      if (error instanceof GenerationFailedError) {
        this.logger.warn(`${testCase.key}: no safe repair after ${error.attempts} attempt(s)`);
        return { failure: error.problems.slice(0, 3).join(" | "), usage: { promptTokens: 0, completionTokens: 0 } };
      }
      throw error;
    }
  }
}
