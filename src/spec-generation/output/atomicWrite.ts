import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Writes a file in one step, or not at all.
 *
 * Generated specs are rewritten whole on every run. A half-written spec is worse than an absent
 * one: it compiles sometimes, it loses assertions silently, and the next run diffs against it. The
 * content goes to a temporary file beside the target and is renamed over it, which is atomic on
 * every filesystem this agent runs on.
 */
export function atomicWrite(file: string, contents: string): void {
  const absolute = path.resolve(file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    writeFileSync(temporary, contents, "utf8");
    renameSync(temporary, absolute);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** The same, for a value that should land on disk as formatted JSON. */
export function atomicWriteJson(file: string, value: unknown): void {
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}
