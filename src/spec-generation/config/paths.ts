import { existsSync } from "node:fs";
import path from "node:path";
import { ConfigError } from "../errors.js";

/** Nearest folder at or above `start` that holds a package.json. */
export function findProjectRoot(start: string = import.meta.dirname): string {
  let current = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new ConfigError(`No package.json found at or above ${start}`);
    current = parent;
  }
}

export const PROJECT_ROOT = findProjectRoot();

export function resolveFromRoot(...segments: string[]): string {
  return path.resolve(PROJECT_ROOT, ...segments);
}
