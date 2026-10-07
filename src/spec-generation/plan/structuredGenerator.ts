import { z } from "zod";
import { GenerationFailedError } from "../errors.js";
import { JsonExtractor } from "../llm/jsonExtractor.js";
import {
  addUsage,
  emptyUsage,
  type ChatMessage,
  type LlmClient,
  type TokenUsage,
} from "../llm/llmClient.js";
import type { Logger } from "../logging/logger.js";
import type { Findings } from "../ir/irPolicy.js";
import type { PromptLibrary } from "./promptLibrary.js";

export interface GenerationRequest<T> {
  label: string;
  systemPrompt: string;
  userPrompt: string;
  schema: z.ZodType<T>;
  validate: (value: T) => Findings;
  /** Last-resort cleanup on the final attempt, e.g. dropping references the model invented. */
  repair?: (value: T) => { value: T; warnings: string[] };
}

export interface GenerationResult<T> {
  value: T;
  attempts: number;
  gaps: string[];
  warnings: string[];
  usage: TokenUsage;
}

const MAX_PROBLEMS_PER_RETRY = 12;

/**
 * One model call, checked twice: the reply must parse against the stage's schema, and then satisfy
 * the domain rules. Anything wrong goes back to the model with the exact problems. A result whose
 * only remaining issues are coverage gaps is accepted and the gaps are reported.
 */
export class StructuredGenerator {
  constructor(
    private readonly llm: LlmClient,
    private readonly prompts: PromptLibrary,
    private readonly maxAttempts: number,
    private readonly logger: Logger,
    /**
     * Whether a reply whose only remaining problem is a coverage gap is worth another attempt.
     * Off by default: a gap is usually something the context cannot answer, so asking again spends
     * the remaining attempts to arrive at the same reply.
     */
    private readonly retryOnGaps: boolean = false,
  ) {}

  async generate<T>(
    request: GenerationRequest<T>,
  ): Promise<GenerationResult<T>> {
    let messages: ChatMessage[] = [
      { role: "system", content: request.systemPrompt },
      { role: "user", content: request.userPrompt },
    ];
    let usage = emptyUsage();
    let problems: string[] = [];
    let fallback: GenerationResult<T> | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const completion = await this.llm.complete(
        messages,
        `${request.label} (attempt ${attempt}/${this.maxAttempts})`,
      );
      usage = addUsage(usage, completion.usage);
      const lastAttempt = attempt === this.maxAttempts;

      problems = [];
      let value: T | undefined;

      if (completion.finishReason === "length") {
        problems.push(
          "Your reply was cut off at the output token limit. Answer again, shorter: fewer items, briefer wording, same JSON shape.",
        );
      } else {
        try {
          const parsed = request.schema.safeParse(
            JsonExtractor.extract(completion.content),
          );
          if (parsed.success) value = parsed.data;
          else
            problems.push(
              ...z.prettifyError(parsed.error).split("\n").filter(Boolean),
            );
        } catch (error) {
          problems.push(error instanceof Error ? error.message : String(error));
        }
      }

      if (value !== undefined) {
        const findings = request.validate(value);
        if (findings.errors.length === 0 && findings.gaps.length === 0) {
          return { value, attempts: attempt, gaps: [], warnings: [], usage };
        }
        if (findings.errors.length === 0) {
          fallback = {
            value,
            attempts: attempt,
            gaps: findings.gaps,
            warnings: [],
            usage,
          };
          // Nothing is wrong with this answer, only incomplete. Asking again costs a whole call for
          // a gap the context usually cannot close anyway.
          if (!this.retryOnGaps) break;
        } else if (lastAttempt && request.repair) {
          const repaired = request.repair(value);
          const afterRepair = request.validate(repaired.value);
          if (afterRepair.errors.length === 0) {
            fallback = {
              value: repaired.value,
              attempts: attempt,
              gaps: afterRepair.gaps,
              warnings: repaired.warnings,
              usage,
            };
          }
        }
        problems.push(...findings.errors, ...findings.gaps);
      }

      if (lastAttempt) break;
      this.logger.warn(
        `${request.label}: attempt ${attempt} rejected (${problems.length} problem(s)); asking again`,
      );
      const correction: ChatMessage = {
        role: "user",
        content: this.prompts.render("correction", {
          problems: problems
            .slice(0, MAX_PROBLEMS_PER_RETRY)
            .map((problem) => `- ${problem}`)
            .join("\n"),
        }),
      };
      // A cut-off reply is rejected for being too long, so sending it back would enlarge the very
      // prompt we are asking the model to answer more briefly. Everything else is corrected against
      // the draft, which is what makes the problem list mean anything.
      messages =
        completion.finishReason === "length"
          ? [messages[0]!, messages[1]!, correction]
          : [
              messages[0]!,
              messages[1]!,
              {
                role: "assistant",
                content: completion.content,
                reasoningDetails: completion.reasoningDetails,
              },
              correction,
            ];
    }

    if (fallback) {
      const summary = [...fallback.gaps, ...fallback.warnings];
      this.logger.warn(
        `${request.label}: accepted with ${summary.length} open point(s) after ${fallback.attempts} attempt(s)`,
      );
      return { ...fallback, usage };
    }
    throw new GenerationFailedError(request.label, this.maxAttempts, problems);
  }
}
