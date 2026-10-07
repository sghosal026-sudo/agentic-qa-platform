import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ConfigError } from "../errors.js";

/**
 * The target adapter: everything about the application under test.
 *
 * The agent itself is app-agnostic, and the target does not pretend to be. Nothing here leaks into
 * the agent's own settings, and nothing here is guessed — a target that does not say where its
 * OpenAPI document is simply cannot have API specs generated for it.
 *
 * Runtime values are never read from environment variables for generated test steps. Authentication
 * must be supplied by case test data or obtained from a grounded operation in TestIR.
 */

const OpenApiSource = z
  .object({
    url: z.string().url().optional(),
    file: z.string().min(1).optional(),
  })
  .refine((value) => Boolean(value.url) !== Boolean(value.file), {
    message: "give exactly one of openapi.url or openapi.file",
  });

const TargetSchema = z.object({
  /** Used in run ids and spec headers. */
  name: z.string().min(1).default("target"),
  projectDir: z.string().min(1).default("."),
  routes: z.array(z.object({ method: z.string(), path: z.string().startsWith("/"), responses: z.array(z.number().int()), requiresAuth: z.boolean().optional(), requestBody: z.record(z.string(), z.unknown()).optional() })).default([]),
  baseUrl: z.string().url(),
  /** Where the screens live, when that is not the API's base URL. */
  uiBaseUrl: z.string().url().optional(),
  /**
   * Base URLs a generated suite is allowed to be executed against.
   *
   * Generation never calls the target; `run --execute` does, and it refuses any base URL that is
   * not listed here. It is the one setting standing between a generated POST and production.
   */
  safeEnvironments: z.array(z.string().url()).min(1),
  openapi: OpenApiSource.optional(),
  openapiSources: z.array(OpenApiSource).default([]),
  auth: z
    .object({
      /** A Playwright storage state file, for UI runs. */
      storageState: z.string().min(1).optional(),
    })
    .strict()
    .default({}),
  /**
   * The database, for assertions about what was persisted.
   *
   * Read-only, always: the handle is opened read-only and the model never writes SQL. Setup and
   * cleanup go through the application's own API, never behind its back.
   */
  db: z
    .object({
      kind: z.enum(["sqlite"]),
      /** Path to the database file, resolved against this config file. */
      file: z.string().min(1),
    })
    .optional(),
  /**
   * How to put the target back to a known state before an executed run.
   *
   * A manual case names its data literally, so the same suite run twice writes the same rows twice
   * and the second run fails on the first run's leftovers — a failure about state, not behaviour.
   * This command is the target's own answer to that. It runs only with `--execute`, only against a
   * safe environment, and the agent does not invent it: no command, no reset.
   */
  testData: z
    .object({
      reset: z.string().min(1).optional(),
      cwd: z.string().min(1).optional(),
    })
    .default({}),
  /**
   * The approved UI contract: which screens exist and how their elements are found.
   *
   * The one piece of evidence the agent will not collect for itself. `explore` proposes entries
   * from a live page; a person approves them into this file. Nothing else can appear in a test.
   */
  uiContract: z.string().min(1).optional(),
  /** Where `explore` writes its proposals, for a person to review. */
  uiProposals: z.string().min(1).default("./.specgen/ui-proposals.json"),
  /** Extra headers every request carries, e.g. a tenant id. Secrets belong in `auth`, not here. */
  headers: z.record(z.string(), z.string()).default({}),
});

export type DbTableConfig = NonNullable<z.infer<typeof TargetSchema>["db"]>;

export type TargetConfig = z.infer<typeof TargetSchema> & { file: string };

export function loadTargetConfig(file: string): TargetConfig {
  const absolute = path.resolve(file);
  if (!existsSync(absolute)) {
    throw new ConfigError(`No target config at ${absolute}. Copy target.config.example.yaml and describe the application under test.`);
  }

  let parsed: unknown;
  try {
    parsed = absolute.endsWith(".json") ? JSON.parse(readFileSync(absolute, "utf8")) : parseYaml(readFileSync(absolute, "utf8"));
  } catch (error) {
    throw new ConfigError(`${absolute} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }

  const result = TargetSchema.safeParse(parsed);
  if (!result.success) throw new ConfigError(`${absolute} is not a usable target config:\n${z.prettifyError(result.error)}`);

  const config = { ...result.data, file: absolute };
  const resolve = (value: string) => path.resolve(path.dirname(absolute), value);
  config.projectDir = resolve(config.projectDir);
  if (config.openapi?.file) config.openapi.file = resolve(config.openapi.file);
  for (const source of config.openapiSources) if (source.file) source.file = resolve(source.file);
  if (config.db) config.db.file = resolve(config.db.file);
  if (config.uiContract) config.uiContract = resolve(config.uiContract);
  config.uiProposals = resolve(config.uiProposals);
  if (config.auth.storageState) config.auth.storageState = resolve(config.auth.storageState);
  if (config.testData.cwd) config.testData.cwd = resolve(config.testData.cwd);
  if (config.uiBaseUrl && !isSafeEnvironment(config, config.uiBaseUrl)) throw new ConfigError("uiBaseUrl must be listed in safeEnvironments");
  for (const name of Object.keys(config.headers)) if (/authorization|cookie|api[-_]?key|token/i.test(name)) throw new ConfigError("Authentication headers must be bound through approved case data, not target headers");
  if (!isSafeEnvironment(config, config.baseUrl)) {
    throw new ConfigError(
      `${absolute}: baseUrl ${config.baseUrl} is not in safeEnvironments, so nothing could ever be executed against it. ` +
        `Add it, or point baseUrl at an environment you are willing to write to.`
    );
  }
  return config;
}

/** Trailing slashes and default ports aside, is this a URL the run is allowed to execute against? */
export function isSafeEnvironment(config: TargetConfig, url: string): boolean {
  const normalise = (value: string): string => value.replace(/\/+$/, "").toLowerCase();
  return config.safeEnvironments.some((safe) => normalise(safe) === normalise(url));
}

