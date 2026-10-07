import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { format } from "prettier";
import { RenderError } from "../errors.js";
import { checkGeneratedSpec, describeViolations } from "../render/generatedPolicy.js";
import { GENERATED_MARKER } from "../render/renderer.js";
import { atomicWrite } from "./atomicWrite.js";

/**
 * What the agent is allowed to write, and what it must never touch.
 *
 * Everything generated lives under `tests/generated/` and `.specgen/`. The rest of the target
 * project — fixtures, helpers, a Playwright config someone tuned — is a human's, and the most
 * damaging thing a generator can do is quietly take it over. Two rules keep that from happening:
 * the path must be inside an owned directory, and an existing file must already carry the
 * generated marker. A file that has lost its marker is assumed adopted, and is left alone.
 */
const OWNED_DIRECTORIES = ["tests/generated", ".specgen"];

const relative = (targetDirectory: string, file: string): string => path.relative(path.resolve(targetDirectory), path.resolve(file)).split(path.sep).join("/");

export function isAgentOwned(targetDirectory: string, file: string): boolean {
  const within = relative(targetDirectory, file);
  return !within.startsWith("..") && OWNED_DIRECTORIES.some((owned) => within === owned || within.startsWith(`${owned}/`));
}

/** Refuses rather than overwrites: a file the agent does not own, or one that lost its marker. */
export function assertWritable(targetDirectory: string, file: string): void {
  if (!isAgentOwned(targetDirectory, file)) {
    throw new RenderError(
      `${file} is outside the directories this agent owns (${OWNED_DIRECTORIES.join(", ")}). Nothing else in the target project is regenerated.`
    );
  }
  if (existsSync(file)) {
    const existing = readFileSync(file, "utf8");
    if (!existing.startsWith(`/* ${GENERATED_MARKER}`)) {
      throw new RenderError(
        `${file} does not carry the generated marker, so it is treated as adopted by a human and left alone. Move or delete it to regenerate.`
      );
    }
  }
}

export interface WrittenFile {
  file: string;
  violations: ReturnType<typeof checkGeneratedSpec>;
}

/**
 * Formats, checks and writes one generated file.
 *
 * The policy check runs on what will actually land on disk, after formatting, and a violation stops
 * the write. A spec that breaks the rules is a bug in the renderer; letting it through would make
 * the rules advisory.
 */
export async function writeGenerated(targetDirectory: string, relativePath: string, contents: string, options: { check?: boolean } = {}): Promise<WrittenFile> {
  const file = path.resolve(targetDirectory, relativePath);
  assertWritable(targetDirectory, file);

  let formatted: string;
  try {
    formatted = await format(contents, { parser: "typescript", printWidth: 120 });
  } catch (error) {
    throw new RenderError(`The renderer produced TypeScript that will not parse (${relativePath}): ${error instanceof Error ? error.message : String(error)}`);
  }

  const violations = options.check === false ? [] : checkGeneratedSpec(relativePath, formatted);
  if (violations.length > 0) {
    throw new RenderError(`The generated spec breaks the rules generated specs are held to:\n${describeViolations(relativePath, violations)}`);
  }

  atomicWrite(file, formatted);
  return { file, violations };
}

/**
 * Makes a complete graph-backed generation authoritative without touching team-owned files.
 * Filtered and fixture runs do not call this: they are partial views and cannot know what is stale.
 */
export function pruneGeneratedSpecs(targetDirectory: string, expectedRelativePaths: ReadonlySet<string>): string[] {
  const root = path.resolve(targetDirectory, "tests", "generated");
  if (!existsSync(root)) return [];

  const expected = new Set([...expectedRelativePaths].map((file) => file.split(path.sep).join("/")));
  const removed: string[] = [];
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".spec.ts")) continue;
    const file = path.resolve(entry.parentPath, entry.name);
    const relativePath = relative(targetDirectory, file);
    if (expected.has(relativePath)) continue;
    if (!readFileSync(file, "utf8").startsWith(`/* ${GENERATED_MARKER}`)) continue;
    unlinkSync(file);
    removed.push(relativePath);
  }
  return removed.sort();
}
