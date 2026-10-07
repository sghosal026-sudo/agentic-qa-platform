import { JsonExtractionError } from "../errors.js";

const THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi;
const UNCLOSED_THINK = /<think>[\s\S]*$/i;
const FENCE = /```(?:json)?\s*([\s\S]*?)```/i;

/** Finds the first balanced JSON object, ignoring braces inside strings. */
function firstObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;

  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (character === "\\") index += 1;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

/**
 * Models wrap JSON in reasoning blocks, code fences or a sentence of commentary. The object itself is
 * what matters, so it is pulled out before parsing.
 */
export class JsonExtractor {
  static extract(reply: string): unknown {
    const withoutThinking = reply.replace(THINK_BLOCK, " ").replace(UNCLOSED_THINK, " ").trim();
    const fenced = FENCE.exec(withoutThinking)?.[1]?.trim();
    const candidates = [fenced, withoutThinking, firstObject(fenced ?? ""), firstObject(withoutThinking)];

    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        const parsed: unknown = JSON.parse(candidate);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      } catch {
        // try the next candidate
      }
    }
    throw new JsonExtractionError(`The reply held no JSON object (${reply.trim().slice(0, 200)}…)`);
  }
}
