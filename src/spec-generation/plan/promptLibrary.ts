import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveFromRoot } from "../config/paths.js";
import { PromptError } from "../errors.js";

const PLACEHOLDER = /\{\{([a-zA-Z0-9_]+)\}\}/g;

export type PromptName = "system" | "ir-proposal" | "ir-repair" | "correction";

/** Loads the prompt templates from `prompts/` and fills their `{{placeholders}}` in one pass. */
export class PromptLibrary {
  private readonly cache = new Map<string, string>();

  constructor(private readonly directory: string = resolveFromRoot("prompts/spec-generation")) {}

  render(name: PromptName, values: Record<string, string>): string {
    const template = this.load(name);
    const used = new Set<string>();
    const rendered = template.replace(PLACEHOLDER, (_match, key: string) => {
      const value = values[key];
      if (value === undefined) throw new PromptError(`Prompt "${name}" needs a value for {{${key}}}`);
      used.add(key);
      return value;
    });
    const unused = Object.keys(values).filter((key) => !used.has(key));
    if (unused.length > 0) throw new PromptError(`Prompt "${name}" has no placeholder for: ${unused.join(", ")}`);
    return rendered;
  }

  private load(name: PromptName): string {
    const cached = this.cache.get(name);
    if (cached) return cached;
    const file = path.join(this.directory, `${name}.md`);
    if (!existsSync(file)) throw new PromptError(`Prompt template not found: ${file}`);
    const template = readFileSync(file, "utf8");
    this.cache.set(name, template);
    return template;
  }
}
