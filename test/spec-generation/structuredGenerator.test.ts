import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import type {
  ChatMessage,
  LlmClient,
  LlmCompletion,
} from "../../src/spec-generation/llm/llmClient.js";
import { SilentLogger } from "../../src/spec-generation/logging/logger.js";
import { PromptLibrary } from "../../src/spec-generation/plan/promptLibrary.js";
import { StructuredGenerator } from "../../src/spec-generation/plan/structuredGenerator.js";

describe("StructuredGenerator", () => {
  it("preserves OpenRouter reasoning details when correcting an answer", async () => {
    const reasoningDetails = [
      { type: "reasoning.text", text: "original reasoning" },
    ];
    const prompts: ChatMessage[][] = [];
    let call = 0;
    const llm: LlmClient = {
      model: "scripted",
      complete(messages: readonly ChatMessage[]): Promise<LlmCompletion> {
        prompts.push([...messages]);
        call += 1;
        return Promise.resolve(
          call === 1
            ? {
                content: '{"items":["made up"]}',
                finishReason: "stop",
                reasoningDetails,
              }
            : { content: '{"items":["real"]}', finishReason: "stop" },
        );
      },
    };
    const generator = new StructuredGenerator(
      llm,
      new PromptLibrary(),
      2,
      new SilentLogger(),
    );

    await generator.generate({
      label: "test",
      systemPrompt: "system",
      userPrompt: "user",
      schema: z.object({ items: z.array(z.string()) }),
      validate: (value) => ({
        errors: value.items.includes("made up") ? ["unsupported item"] : [],
        gaps: [],
      }),
    });

    assert.equal(prompts[1]?.[2]?.role, "assistant");
    assert.equal(prompts[1]?.[2]?.content, '{"items":["made up"]}');
    assert.strictEqual(prompts[1]?.[2]?.reasoningDetails, reasoningDetails);
  });
});
