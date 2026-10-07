import OpenAI from "openai";
import { startActiveObservation } from "@langfuse/tracing";
import { required } from "../core/runtime.js";
import { DEFAULT_SYSTEM_PROMPT } from "../prompts/system.js";
import { maskSensitiveText } from "../observability/masking.js";

export class Model {
  private client: OpenAI;

  constructor(private modelName = process.env.OPENROUTER_MODEL ?? "openai/gpt-oss-120b", private systemPrompt = DEFAULT_SYSTEM_PROMPT) {
    this.client = new OpenAI({ apiKey: required("OPENROUTER_API_KEY"), baseURL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1" });
  }

  get model(): string { return this.modelName; }

  async complete(messages: readonly import("../spec-generation/llm/llmClient.js").ChatMessage[], label: string): Promise<import("../spec-generation/llm/llmClient.js").LlmCompletion> {
    return startActiveObservation("spec-generation-model", async (observation) => {
      observation.update({ model: this.modelName, input: messages, metadata: { label } });
      try {
        const response = await this.client.chat.completions.create({ model: this.modelName,
          messages: messages.map(message => ({ role: message.role, content: message.content,
            ...(message.reasoningDetails ? { reasoning_details: message.reasoningDetails } : {}) })),
          response_format: { type: "json_object" } });
        const choice = response.choices[0];
        const result = { content: choice?.message.content ?? "", finishReason: choice?.finish_reason,
          reasoningDetails: (choice?.message as unknown as { reasoning_details?: unknown[] })?.reasoning_details,
          usage: response.usage ? { promptTokens: response.usage.prompt_tokens, completionTokens: response.usage.completion_tokens } : undefined };
        observation.update({ output: result, usageDetails: response.usage ? { input: response.usage.prompt_tokens, output: response.usage.completion_tokens } : undefined });
        return result;
      } catch (error) {
        observation.update({ level: "ERROR", statusMessage: maskSensitiveText(String(error)) });
        throw error;
      }
    }, { asType: "generation" });
  }

  async json(prompt: string, output?: { name: string; schema: Record<string, unknown> }): Promise<unknown> {
    const stage = output?.name ?? "json";
    const started = Date.now();
    console.error(`[openrouter] ${stage} started (${this.modelName})`);
    return startActiveObservation("openrouter-json", async (observation) => {
      observation.update({ model: this.modelName, input: { system: this.systemPrompt, prompt, outputSchema: stage } });
      try {
        const response = await this.client.chat.completions.create({
          model: this.modelName,
          messages: [{ role: "system", content: this.systemPrompt }, { role: "user", content: prompt }],
          response_format: output
            ? { type: "json_schema", json_schema: { name: output.name, schema: output.schema, strict: false } }
            : { type: "json_object" },
        });
        const content = response.choices[0]?.message.content;
        if (!content) throw new Error("OpenRouter returned no JSON");
        const result = JSON.parse(content) as unknown;
        observation.update({
          model: response.model ?? this.modelName,
          output: result,
          usageDetails: response.usage ? { input: response.usage.prompt_tokens, output: response.usage.completion_tokens } : undefined,
          metadata: { stage, finishReason: response.choices[0]?.finish_reason },
        });
        console.error(`[openrouter] ${stage} finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        return result;
      } catch (error) {
        const message = maskSensitiveText(error instanceof Error ? error.message : String(error));
        observation.update({ level: "ERROR", statusMessage: message });
        console.error(`[openrouter] ${stage} failed after ${((Date.now() - started) / 1000).toFixed(1)}s: ${message}`);
        throw error;
      }
    }, { asType: "generation" });
  }
}

