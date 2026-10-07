import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { DbTableConfig } from "../config/targetConfig.js";
import { EvidenceError } from "../errors.js";
import type { DbColumn, DbTable } from "./catalogue.js";

/**
 * Reading the target's schema — and only ever reading it.
 *
 * Two separate guarantees hold this down, because one would not be enough:
 *
 * 1. **The model never writes SQL.** It names a table, a column and a comparison; the query is
 *    built from those by the renderer. There is no path from a model's output to a SQL string.
 * 2. **The connection cannot write.** SQLite is opened read-only, so the engine itself refuses a
 *    write — this is not a convention the agent maintains, it is a property of the handle.
 *
 * Setup and cleanup go through the application's own API. A test suite that writes to a database
 * behind the application's back is testing a state the application never agreed to.
 */

export interface DbPort {
  readonly kind: string;
  readonly describe: string;
  introspect(): Promise<DbTable[]>;
  close(): Promise<void>;
}

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

interface SqliteColumnRow {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

interface SqliteIndexRow {
  name: string;
  unique: number;
  origin: string;
}

/** The subset of node-sqlite3-wasm this agent uses, so the dependency stays visible and small. */
interface SqliteDatabase {
  all(sql: string, parameters?: unknown[]): Record<string, unknown>[];
  close(): void;
}

/**
 * SQLite, through a WebAssembly build.
 *
 * A native driver would be faster and is not worth it: this reads a schema once per run, and a
 * native module is a compiler toolchain every person and every CI image has to have. The WASM
 * build honours `readOnly` at the engine level, which is the part that actually matters.
 */
export class SqliteDbPort implements DbPort {
  readonly kind = "sqlite";
  readonly describe: string;
  private database?: SqliteDatabase;

  constructor(private readonly file: string) {
    this.describe = file;
  }

  private async open(): Promise<SqliteDatabase> {
    if (this.database) return this.database;
    if (!existsSync(this.file)) throw new EvidenceError(`No SQLite database at ${this.file}.`);

    const module = (await import("node-sqlite3-wasm")) as unknown as { default?: Record<string, unknown> } & Record<string, unknown>;
    const exports = (module.default ?? module) as { Database: new (file: string, options: { readOnly: boolean }) => SqliteDatabase };
    try {
      this.database = new exports.Database(this.file, { readOnly: true });
    } catch (error) {
      throw new EvidenceError(`Could not open ${this.file} read-only: ${error instanceof Error ? error.message : String(error)}`);
    }
    return this.database;
  }

  async introspect(): Promise<DbTable[]> {
    const database = await this.open();
    const collectedAt = new Date().toISOString();
    const tables: DbTable[] = [];

    const names = database
      .all(`select name, sql from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name`)
      .map((row) => ({ name: String(row.name), sql: String(row.sql ?? "") }));

    for (const { name, sql } of names) {
      const columnRows = database.all(`pragma table_info(${quoteIdentifier(name)})`) as unknown as SqliteColumnRow[];
      if (columnRows.length === 0) continue;

      // A single-column unique index is the only unique constraint worth reporting: it is the one
      // a test can rely on when it says "the same code is rejected".
      const unique = new Set<string>();
      for (const index of database.all(`pragma index_list(${quoteIdentifier(name)})`) as unknown as SqliteIndexRow[]) {
        if (!index.unique) continue;
        const columns = database.all(`pragma index_info(${quoteIdentifier(index.name)})`);
        if (columns.length === 1) unique.add(String(columns[0]!.name));
      }

      const columns: DbColumn[] = columnRows.map((row) => ({
        name: row.name,
        type: (row.type || "unknown").toLowerCase(),
        nullable: row.notnull === 0 && row.pk === 0,
        primaryKey: row.pk > 0,
        unique: unique.has(row.name) || row.pk > 0,
      }));

      tables.push({
        id: `db:${name}`,
        layer: "db",
        name,
        columns,
        primaryKey: columnRows.filter((row) => row.pk > 0).map((row) => row.name),
        provenance: { source: this.file, collectedAt, contentHash: hash(sql), pointer: `sqlite_master#${name}` },
      });
    }

    return tables;
  }

  async close(): Promise<void> {
    this.database?.close();
    this.database = undefined;
  }
}

/** A double-quoted identifier, with embedded quotes doubled. Never used on model output. */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function createDbPort(config: DbTableConfig, relativeTo: string): DbPort {
  switch (config.kind) {
    case "sqlite":
      return new SqliteDbPort(path.resolve(path.dirname(relativeTo), config.file));
    default:
      // The port exists so another engine is a new class and nothing else. PostgreSQL is next.
      throw new EvidenceError(`Database kind "${String(config.kind)}" is not supported yet; only sqlite is.`);
  }
}
