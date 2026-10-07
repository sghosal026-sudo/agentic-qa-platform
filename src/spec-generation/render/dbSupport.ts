import path from "node:path";
import type { EvidenceCatalogue } from "../evidence/catalogue.js";
import { GENERATED_MARKER } from "./renderer.js";

/**
 * The database helper a generated spec imports.
 *
 * It exists so that a spec never contains SQL. The spec names a table, some columns and some
 * comparisons — the same vocabulary the IR uses — and this module turns that into one parameterised
 * SELECT against a handle SQLite opened read-only.
 *
 * Three things are true of it by construction, and all three matter:
 *
 * - **It can only read.** There is no code path here that emits anything but SELECT, and the
 *   connection would refuse a write even if there were.
 * - **Values are never interpolated.** They are bound parameters, so a test's data cannot become
 *   part of the query.
 * - **Identifiers are checked against the schema, not quoted and hoped for.** The table and column
 *   names allowed are written into this file when it is generated, from the introspected schema.
 *   A name that was not in the schema at generation time cannot be used at run time.
 */
/** Where the generated helper lives, and so what its relative path to the database is resolved from. */
export const DB_SUPPORT_FILE = "tests/generated/_support/db.ts";

export function renderDbSupport(catalogue: EvidenceCatalogue, databaseFile: string, targetDirectory: string, supportFile = DB_SUPPORT_FILE): string {
  // Relative to the helper's own directory, because that is what `import.meta.url` resolves
  // against at run time — not the project root, which is what a first attempt at this used.
  const supportDirectory = path.dirname(path.resolve(targetDirectory, supportFile));
  const relative = path.relative(supportDirectory, path.resolve(databaseFile)).split(path.sep).join("/");
  const schema = Object.fromEntries(catalogue.db.map((table) => [table.name, table.columns.map((column) => column.name)]));

  return `/* ${GENERATED_MARKER}. Edits are lost on the next run. */

import { fileURLToPath } from "node:url";
import { observe } from "./observations.js";

/**
 * Read-only access to the target's database, for assertions about what was persisted.
 *
 * A spec never writes SQL. It names a table, columns and comparisons; this builds the query, binds
 * the values as parameters, and runs it against a handle the engine opened read-only. Setup and
 * cleanup belong to the application's own API — a suite that writes here would be testing a state
 * the application never agreed to.
 */

/** The schema as it was when these tests were generated. Nothing outside it can be queried. */
const SCHEMA: Record<string, readonly string[]> = ${JSON.stringify(schema, null, 2)};

const DATABASE_FILE = ${JSON.stringify(relative)};

export type Comparison = "eq" | "neq" | "gt" | "lt" | "gte" | "lte" | "contains" | "isNull" | "notNull";

export interface Predicate {
  column: string;
  op: Comparison;
  value?: unknown;
}

const OPERATORS: Record<Exclude<Comparison, "isNull" | "notNull" | "contains">, string> = {
  eq: "=",
  neq: "<>",
  gt: ">",
  lt: "<",
  gte: ">=",
  lte: "<=",
};

interface ReadOnlyDatabase {
  all(sql: string, parameters?: unknown[]): Record<string, unknown>[];
  close(): void;
}

let handle: ReadOnlyDatabase | undefined;

async function open(): Promise<ReadOnlyDatabase> {
  if (handle) return handle;
  const module = await import("node-sqlite3-wasm");
  const exports = ((module as Record<string, unknown>).default ?? module) as {
    Database: new (file: string, options: { readOnly: boolean }) => ReadOnlyDatabase;
  };
  // fileURLToPath, not URL.pathname: a path with a space in it arrives percent-encoded otherwise,
  // and on Windows the drive letter needs the leading slash stripped.
  const file = process.env.QA_SQLITE_FILE ?? fileURLToPath(new URL(DATABASE_FILE, import.meta.url));
  try {
    handle = new exports.Database(file, { readOnly: true });
  } catch (error) {
    throw new Error(\`Could not open the database at \${file} (read-only): \${error instanceof Error ? error.message : String(error)}\`);
  }
  return handle;
}

/** Data-integrity object model. It exposes grounded reads and no mutation surface. */
export const dataIntegrity = {
  /** One parameterised SELECT. The only thing this module can do. */
  async findRows(table: string, where: readonly Predicate[]): Promise<Record<string, unknown>[]> {
    const columns = SCHEMA[table];
    if (!columns) throw new Error(\`No table "\${table}" in the schema these tests were generated from.\`);

    const clauses: string[] = [];
    const parameters: unknown[] = [];
    for (const predicate of where) {
      if (!columns.includes(predicate.column)) {
        throw new Error(\`No column "\${predicate.column}" on "\${table}" in the schema these tests were generated from.\`);
      }
      const column = \`"\${predicate.column}"\`;
      if (predicate.op === "isNull") {
        clauses.push(\`\${column} IS NULL\`);
      } else if (predicate.op === "notNull") {
        clauses.push(\`\${column} IS NOT NULL\`);
      } else if (predicate.op === "contains") {
        clauses.push(\`\${column} LIKE ?\`);
        parameters.push(\`%\${String(predicate.value)}%\`);
      } else {
        clauses.push(\`\${column} \${OPERATORS[predicate.op]} ?\`);
        parameters.push(predicate.value ?? null);
      }
    }

    const database = await open();
    const rows = database.all(\`SELECT * FROM "\${table}" WHERE \${clauses.join(" AND ")}\`, parameters);
    await observe("sqlite", { table, where, rows });
    return rows;
  },

  close(): void {
    handle?.close();
    handle = undefined;
  },
};
`;
}
