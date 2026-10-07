import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { format } from "prettier";
import { resolveFromRoot } from "../../src/spec-generation/config/paths.js";
import { columnOf, tableByName } from "../../src/spec-generation/evidence/catalogue.js";
import { createDbPort, SqliteDbPort } from "../../src/spec-generation/evidence/dbPort.js";
import { EvidenceError } from "../../src/spec-generation/errors.js";
import { validateIr } from "../../src/spec-generation/ir/irPolicy.js";
import type { TestIr } from "../../src/spec-generation/ir/testIr.js";
import { checkGeneratedSpec } from "../../src/spec-generation/render/generatedPolicy.js";
import { renderDbSupport } from "../../src/spec-generation/render/dbSupport.js";
import { layerOf, renderApiSpec } from "../../src/spec-generation/render/renderer.js";
import { obligationsFor } from "../../src/spec-generation/ingest/obligations.js";
import type { NormalisedCase } from "../../src/spec-generation/model/testCase.js";
import { createWarehouseCase, wmsCatalogueWithDb, wmsTarget } from "./helpers/apiFixtures.js";

const FIXTURE_DB = resolveFromRoot("test", "spec-generation", "fixtures", "wms.fixture.sqlite3");

test("the real wms-api schema is read into tables and columns", async () => {
  const catalogue = await wmsCatalogueWithDb();
  const warehouse = tableByName(catalogue, "warehouse")!;

  assert.ok(catalogue.db.length > 10, `expected the whole schema, got ${catalogue.db.length} table(s)`);
  assert.deepEqual(warehouse.columns.map((column) => column.name), ["id", "code", "name", "address", "timezone", "active", "created_at"]);
  assert.deepEqual(warehouse.primaryKey, ["id"]);
});

test("constraints the schema declares are carried, because a test may rely on them", async () => {
  const warehouse = tableByName(await wmsCatalogueWithDb(), "warehouse")!;

  assert.equal(columnOf(warehouse, "code")!.unique, true, "the code is unique, which is what makes the duplicate case meaningful");
  assert.equal(columnOf(warehouse, "id")!.primaryKey, true);
  assert.equal(columnOf(warehouse, "name")!.nullable, false);
  assert.equal(columnOf(warehouse, "name")!.unique, false);
});

test("the connection cannot write, whatever anyone asks of it", async () => {
  const copy = path.join(mkdtempSync(path.join(tmpdir(), "specgen-db-")), "copy.sqlite3");
  copyFileSync(FIXTURE_DB, copy);

  const port = new SqliteDbPort(copy);
  await port.introspect();
  // Reach past the port to the handle it holds, and try to write through it. SQLite itself refuses:
  // read-only is a property of the connection, not a rule the agent remembers to follow.
  const handle = (port as unknown as { database: { all(sql: string): unknown } }).database;
  assert.throws(() => handle.all(`delete from warehouse`), /readonly|read-only/i);
  await port.close();
});

test("a database that is not there is reported, not guessed around", async () => {
  await assert.rejects(() => new SqliteDbPort(path.join(tmpdir(), "nowhere.sqlite3")).introspect(), EvidenceError);
});

test("an engine the agent does not support says so plainly", () => {
  assert.throws(() => createDbPort({ kind: "postgres" as "sqlite", file: "x" }, wmsTarget().file), EvidenceError);
});

/** A case that creates through the API and then checks the row was persisted. */
function persistedCase(): NormalisedCase {
  const steps = [
    { stepNumber: 1, action: "Send a create warehouse request with the test data.", expectedResult: "The response status code is 201." },
    { stepNumber: 2, action: "Check the warehouse table.", expectedResult: "A row with that code is stored in the warehouse table." },
  ];
  return createWarehouseCase({
    caseId: "TestCase:the-warehouse-is-persisted",
    key: "the-warehouse-is-persisted",
    name: "The warehouse is persisted",
    steps,
    obligations: obligationsFor("TestCase:the-warehouse-is-persisted", "the-warehouse-is-persisted", steps),
  });
}

function persistedIr(): TestIr {
  return {
    caseId: "TestCase:the-warehouse-is-persisted",
    layer: "api",
    ops: [
      {
        kind: "auth.header",
        id: "authenticated",
        token: { testData: "administrator bearer token" },
        headerName: "Authorization",
        scheme: "Bearer",
        evidenceRefs: ["auth:http-bearer:HTTPBearer"],
      },
      {
        kind: "api.request",
        id: "created",
        step: 1,
        operationId: "create_warehouse_warehouses_post",
        body: { code: { testData: "code" }, name: { testData: "name" }, address: { testData: "address" }, timezone: { testData: "timezone" } },
        evidenceRefs: ["api:create_warehouse_warehouses_post"],
      },
      {
        kind: "db.read",
        id: "stored",
        step: 2,
        table: "warehouse",
        where: [{ column: "code", op: "eq", value: { testData: "code" } }],
        evidenceRefs: ["db:warehouse"],
      },
    ],
    assertions: [
      { kind: "assert.status", obligation: "the-warehouse-is-persisted.step-1", of: "created", status: 201, evidenceRefs: [] },
      { kind: "assert.db.rows", obligation: "the-warehouse-is-persisted.step-2", of: "stored", expectation: "exactly", count: 1, evidenceRefs: ["db:warehouse"] },
    ],
    unautomatable: [],
  };
}

const checkDb = async (mutate: (ir: TestIr) => void = () => {}) => {
  const ir = persistedIr();
  mutate(ir);
  return validateIr(ir, persistedCase(), await wmsCatalogueWithDb());
};

test("a plan that reads a real table with real columns passes", async () => {
  assert.deepEqual(await checkDb(), { errors: [], gaps: [] });
});

test("a table that is not in the schema is rejected", async () => {
  const findings = await checkDb((ir) => {
    (ir.ops.find((op) => op.kind === "db.read") as { table: string }).table = "warehouses";
  });
  assert.match(findings.errors.join("\n"), /Table "warehouses" is not in the schema/);
});

test("a column the table does not have is rejected", async () => {
  const findings = await checkDb((ir) => {
    (ir.ops.find((op) => op.kind === "db.read") as { where: { column: string }[] }).where[0]!.column = "warehouse_code";
  });
  assert.match(findings.errors.join("\n"), /has no column "warehouse_code"/);
});

test("a database assertion about an API call is rejected, and the reverse too", async () => {
  const swapped = await checkDb((ir) => {
    (ir.assertions[1] as { of: string }).of = "created";
  });
  assert.match(swapped.errors.join("\n"), /is a database assertion, but "created" is an API call/);

  const other = await checkDb((ir) => {
    (ir.assertions[0] as { of: string }).of = "stored";
  });
  assert.match(other.errors.join("\n"), /is a response assertion, but "stored" is a database read/);
});

test("a value in a predicate obeys the same rule as everywhere else", async () => {
  const findings = await checkDb((ir) => {
    (ir.ops.find((op) => op.kind === "db.read") as { where: { value?: unknown }[] }).where[0]!.value = { literal: "WH-INVENTED" };
  });
  assert.match(findings.errors.join("\n"), /appears nowhere in the case/);
});

test("a row count of 'exactly' without a count is rejected", async () => {
  const findings = await checkDb((ir) => {
    delete (ir.assertions[1] as { count?: number }).count;
  });
  assert.match(findings.errors.join("\n"), /gives no count/);
});

test("a mixed case is an API spec that also reads the database", async () => {
  const ir = persistedIr();
  assert.equal(layerOf(ir), "api", "only the API call can act; the database read only observes");

  const rendered = renderApiSpec("FDN-501", [{ testCase: persistedCase(), ir, gaps: [] }], await wmsCatalogueWithDb(), "db-run");
  const contents = await format(rendered.contents, { parser: "typescript", printWidth: 120 });

  assert.equal(rendered.file, "tests/generated/api/FDN-501.spec.ts");
  assert.match(contents, /import \{ dataIntegrity \} from "\.\.\/_support\/db\.js"/);
  assert.match(contents, /const stored = await dataIntegrity\.findRows\("warehouse", \[/);
  assert.match(contents, /\{ column: "code", op: "eq", value: code \}/);
  assert.match(contents, /expect\(stored\)\.toHaveLength\(1\)/);
  assert.deepEqual(checkGeneratedSpec("x.spec.ts", contents), []);
});

test("no SQL is ever written into a spec", async () => {
  const rendered = renderApiSpec("FDN-501", [{ testCase: persistedCase(), ir: persistedIr(), gaps: [] }], await wmsCatalogueWithDb(), "db-run");

  // `dataIntegrity.findRows(...)` is the model's method, not SQL. What must not appear is a query: the spec says
  // which table and which comparison, and the helper turns that into one parameterised statement.
  assert.equal(/SELECT\s|\sFROM\s|\sWHERE\s/.test(rendered.contents), false, "a query was written into the spec");
  assert.match(rendered.contents, /dataIntegrity\.findRows\("warehouse", \[/);
});

test("a database-only case becomes a database spec, with no request fixture", async () => {
  const testCase = persistedCase();
  const ir = persistedIr();
  ir.ops = [ir.ops.find((op) => op.kind === "db.read")!];
  ir.assertions = [{ ...ir.assertions[1]!, obligation: "the-warehouse-is-persisted.step-1" }, ir.assertions[1]!];

  const rendered = renderApiSpec("FDN-501", [{ testCase, ir, gaps: [] }], await wmsCatalogueWithDb(), "db-run");
  assert.equal(rendered.file, "tests/generated/db/FDN-501.spec.ts");
  assert.match(rendered.contents, /async \(\{\}\) => \{/, "a case that never calls the API does not ask for the request fixture");
});

test("the generated helper can only select, and binds its values", async () => {
  const support = renderDbSupport(await wmsCatalogueWithDb(), FIXTURE_DB, resolveFromRoot("automation"));

  assert.match(support, /SELECT \* FROM/);
  assert.equal(/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/.test(support.replace(/\/\*[\s\S]*?\*\//g, "")), false, "there is no code path to a write");
  assert.match(support, /readOnly: true/);
  assert.match(support, /export const dataIntegrity/);
  assert.match(support, /async findRows/);
  assert.match(support, /parameters\.push/, "values are bound, never interpolated into the query");
  assert.match(support, /No table "\$\{table\}" in the schema these tests were generated from/);
});

test("the helper carries the schema it was generated against, so a stray name cannot be queried", async () => {
  const support = renderDbSupport(await wmsCatalogueWithDb(), FIXTURE_DB, resolveFromRoot("automation"));
  assert.match(support, /"warehouse": \[\s*"id",/);
  assert.match(support, /No column "\$\{predicate\.column\}"/);
});

test("the database path is relative to the helper, which is what import.meta.url resolves against", async () => {
  // The bug this guards: the path was first computed from the project root, so at run time it
  // resolved to tests/generated/_support/<project-relative-path> and the database was not there.
  const support = renderDbSupport(await wmsCatalogueWithDb(), resolveFromRoot(".e2e", "wms.sqlite3"), resolveFromRoot("automation"));
  const declared = /const DATABASE_FILE = "([^"]+)"/.exec(support)![1]!;

  const resolved = path.resolve(resolveFromRoot("automation", "tests", "generated", "_support"), declared);
  assert.equal(resolved, resolveFromRoot(".e2e", "wms.sqlite3"));
});

test("a path with a space in it survives the trip through import.meta.url", async () => {
  const support = renderDbSupport(await wmsCatalogueWithDb(), FIXTURE_DB, resolveFromRoot("automation"));
  assert.match(support, /fileURLToPath/, "URL.pathname would leave %20 in the path of every project under a folder with a space");
  assert.equal(/\)\s*\.pathname/.test(support), false, "the comment may mention it; the code must not use it");
});
