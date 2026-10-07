export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** OpenRouter reasoning state returned by the prior assistant message. */
  reasoningDetails?: unknown;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface LlmCompletion {
  content: string;
  reasoningDetails?: unknown;
  /** "stop", or "length" when the model ran out of output tokens. */
  finishReason?: string;
  usage?: TokenUsage;
}

export interface LlmClient {
  readonly model: string;
  complete(
    messages: readonly ChatMessage[],
    label: string,
  ): Promise<LlmCompletion>;
}

export const emptyUsage = (): TokenUsage => ({
  promptTokens: 0,
  completionTokens: 0,
});

export function addUsage(
  total: TokenUsage,
  usage: TokenUsage | undefined,
): TokenUsage {
  if (!usage) return total;
  return {
    promptTokens: total.promptTokens + usage.promptTokens,
    completionTokens: total.completionTokens + usage.completionTokens,
  };
}
