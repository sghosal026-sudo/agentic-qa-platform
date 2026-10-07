import { resolveFromRoot } from "../../../src/spec-generation/config/paths.js";
import type { EvidenceCatalogue } from "../../../src/spec-generation/evidence/catalogue.js";
import { createDbPort } from "../../../src/spec-generation/evidence/dbPort.js";
import { collectOpenApiEvidence } from "../../../src/spec-generation/evidence/openapiProvider.js";
import type { TargetConfig } from "../../../src/spec-generation/config/targetConfig.js";
import type { TestIr } from "../../../src/spec-generation/ir/testIr.js";
import type { NormalisedCase } from "../../../src/spec-generation/model/testCase.js";
import { obligationsFor } from "../../../src/spec-generation/ingest/obligations.js";

/** The real OpenAPI document published by ../wms-api, captured so tests need no running server. */
export const WMS_OPENAPI = resolveFromRoot("test", "spec-generation", "fixtures", "wms-openapi.json");

/** `openapi.file` is resolved against the config file's own directory, which is where the fixture sits. */
export const wmsTarget = (): TargetConfig => ({
  file: resolveFromRoot("test", "spec-generation", "fixtures", "target.test.yaml"),
  name: "wms-api",
  baseUrl: "http://127.0.0.1:8000",
  safeEnvironments: ["http://127.0.0.1:8000"],
  openapi: { file: "wms-openapi.json" },
  auth: {},
  testData: {},
  uiProposals: "./.specgen/ui-proposals.json",
  headers: {},
});

/** The wms-api SQLite database, as a target config addition. Read-only, always. */
export const wmsTargetWithDb = (): TargetConfig => ({ ...wmsTarget(), db: { kind: "sqlite", file: "wms.fixture.sqlite3" } });

let cached: EvidenceCatalogue | undefined;

/** Parsed once: dereferencing the real document is the slowest thing in the test suite. */
export async function wmsCatalogue(): Promise<EvidenceCatalogue> {
  if (cached) return cached;
  const { operations, auth } = await collectOpenApiEvidence(wmsTarget());
  cached = {
    target: "wms-api",
    collectedAt: "2026-01-01T00:00:00.000Z",
    api: operations,
    db: [],
    ui: [],
    auth,
    absent: [],
  };
  return cached;
}

/** The same catalogue, with the fixture database's schema in it. */
export async function wmsCatalogueWithDb(): Promise<EvidenceCatalogue> {
  const catalogue = { ...(await wmsCatalogue()) };
  const port = createDbPort({ kind: "sqlite", file: "wms.fixture.sqlite3" }, wmsTarget().file);
  catalogue.db = await port.introspect();
  await port.close();
  return catalogue;
}

/** A case matching the manual design's shape: create a warehouse, expect 201 and the code back. */
export function createWarehouseCase(overrides: Partial<NormalisedCase> = {}): NormalisedCase {
  const steps = [
    { stepNumber: 1, action: "Send a create warehouse request with the test data.", expectedResult: "The response status code is 201." },
    { stepNumber: 2, action: "Read the created warehouse.", expectedResult: "The returned code matches the code that was sent." },
  ];
  return {
    caseId: "TestCase:create-a-warehouse",
    key: "create-a-warehouse",
    name: "A warehouse is created",
    objective: "Confirm a warehouse is created.",
    caseKind: "positive",
    priority: "high",
    testTypes: ["functional"],
    suites: ["TestSuite:functional"],
    stories: ["FDN-501"],
    scenario: { nodeId: "TestScenario:create", name: "A warehouse is created", description: "", exercises: [], covers: [] },
    preconditions: ["The tester is signed in as a system administrator."],
    testData: [
      { name: "code", value: "WH-01" },
      { name: "name", value: "Main warehouse" },
      { name: "address", value: "1 Dock Road" },
      { name: "timezone", value: "Europe/London" },
      { name: "administrator bearer token", value: "test-token" },
    ],
    steps,
    exercises: [],
    validates: [],
    automationCandidate: true,
    obligations: obligationsFor("TestCase:create-a-warehouse", "create-a-warehouse", steps),
    ...overrides,
  };
}

/** A plan for that case which the policy should accept without a single finding. */
export const createWarehouseIr = (): TestIr => ({
  caseId: "TestCase:create-a-warehouse",
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
      body: {
        code: { testData: "code" },
        name: { testData: "name" },
        address: { testData: "address" },
        timezone: { testData: "timezone" },
      },
      evidenceRefs: ["api:create_warehouse_warehouses_post"],
    },
  ],
  assertions: [
    {
      kind: "assert.status",
      obligation: "create-a-warehouse.step-1",
      of: "created",
      status: 201,
      evidenceRefs: ["api:create_warehouse_warehouses_post#responses/201"],
    },
    {
      kind: "assert.body.field",
      obligation: "create-a-warehouse.step-2",
      of: "created",
      path: "code",
      matcher: "equals",
      value: { testData: "code" },
      evidenceRefs: ["api:create_warehouse_warehouses_post#responses/201"],
    },
  ],
  unautomatable: [],
});

export function createDistinctWarehouseCase(): NormalisedCase {
  const steps = [
    {
      stepNumber: 1,
      action: "Create two warehouses and compare their generated ids.",
      expectedResult: "The first and second warehouse ids are different values with no collision.",
    },
  ];
  return createWarehouseCase({
    testData: [...createWarehouseCase().testData, { name: "second code", value: "WH-02" }],
    steps,
    obligations: obligationsFor("TestCase:create-a-warehouse", "create-a-warehouse", steps),
  });
}

export function createDistinctWarehouseIr(): TestIr {
  const first = createWarehouseIr().ops.find((op) => op.kind === "api.request")!;
  if (first.kind !== "api.request") throw new Error("fixture expected an API request");
  return {
    caseId: "TestCase:create-a-warehouse",
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
      { ...structuredClone(first), id: "firstCreated", body: { ...first.body, code: { uniqueTestData: "code" } } },
      { ...structuredClone(first), id: "secondCreated", body: { ...first.body, code: { uniqueTestData: "second code" } } },
    ],
    assertions: [
      {
        kind: "assert.body.field",
        obligation: "create-a-warehouse.step-1",
        of: "secondCreated",
        path: "id",
        matcher: "notEquals",
        value: { from: "firstCreated", path: "id" },
        evidenceRefs: ["api:create_warehouse_warehouses_post#responses/201"],
      },
    ],
    unautomatable: [],
  };
}
