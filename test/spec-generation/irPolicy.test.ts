import assert from "node:assert/strict";
import test from "node:test";
import { assertionsUnchanged, validateIr, validateRepair } from "../../src/spec-generation/ir/irPolicy.js";
import { assertionFingerprint, fingerprintsOf, TestIrSchema, type TestIr } from "../../src/spec-generation/ir/testIr.js";
import { createDistinctWarehouseCase, createDistinctWarehouseIr, createWarehouseCase, createWarehouseIr, wmsCatalogue } from "./helpers/apiFixtures.js";

/** The plan's one API call, and its two assertions, by the kind each test needs to bend. */
const apiOp = (ir: TestIr) => ir.ops.find((op) => op.kind === "api.request")!;
const statusAssertion = (ir: TestIr) => ir.assertions.find((a) => a.kind === "assert.status")!;
const fieldAssertion = (ir: TestIr) => ir.assertions.find((a) => a.kind === "assert.body.field")!;

const check = async (mutate: (ir: TestIr) => void = () => {}) => {
  const ir = createWarehouseIr();
  mutate(ir);
  return validateIr(ir, createWarehouseCase(), await wmsCatalogue());
};

test("a plan drawn entirely from the evidence passes with nothing to say", async () => {
  assert.deepEqual(await check(), { errors: [], gaps: [] });
});

test("a secured request requires an explicit authentication operation", async () => {
  const ir = createWarehouseIr();
  ir.ops = ir.ops.filter((op) => op.kind !== "auth.header");
  const findings = validateIr(ir, createWarehouseCase(), await wmsCatalogue());
  assert.match(findings.errors.join("\n"), /secured API operation but has no authentication/);
});

test("bearer authentication must cite the security scheme grounded by target evidence", async () => {
  const ir = createWarehouseIr();
  const auth = ir.ops.find((op) => op.kind === "auth.header");
  assert.ok(auth?.kind === "auth.header");
  auth.headerName = "Authorization";
  auth.scheme = "Bearer";
  auth.evidenceRefs = ["auth:invented"];
  const findings = validateIr(ir, createWarehouseCase(), await wmsCatalogue());
  assert.match(findings.errors.join("\n"), /must cite auth:http-bearer:HTTPBearer/);
});

test("authentication cannot be declared unavailable when a grounded mechanism exists", async () => {
  const ir = createWarehouseIr();
  ir.ops[0] = { kind: "auth.unavailable", id: "authenticationBlocked", reason: "No authentication is available", evidenceRefs: [] };
  const findings = validateIr(ir, createWarehouseCase(), await wmsCatalogue());
  assert.match(findings.errors.join("\n"), /provides a usable authentication mechanism/);
});

test("the IR schema refuses a shape it does not know", () => {
  const parsed = TestIrSchema.safeParse({ ...createWarehouseIr(), ops: [{ kind: "shell.run", command: "rm -rf /" }] });
  assert.equal(parsed.success, false, "only the operation kinds the renderer can render are representable");
});

test("an operation that is not in the evidence is rejected", async () => {
  const findings = await check((ir) => {
    apiOp(ir).operationId = "create_warehouse_v2";
  });
  assert.match(findings.errors.join("\n"), /"create_warehouse_v2" is not in the evidence/);
});

test("a body field the document does not declare is rejected", async () => {
  const findings = await check((ir) => {
    apiOp(ir).body!["region"] = { literal: "north" };
  });
  assert.match(findings.errors.join("\n"), /declares no body field "region"/);
});

test("omitting a required body field is rejected, because the call would fail before reaching the behaviour", async () => {
  const findings = await check((ir) => {
    delete apiOp(ir).body!["timezone"];
  });
  assert.match(findings.errors.join("\n"), /requires the body field "timezone"/);
});

test("a response field the document does not declare is rejected", async () => {
  const findings = await check((ir) => {
    fieldAssertion(ir).path = "warehouseCode";
  });
  assert.match(findings.errors.join("\n"), /declares no response field "warehouseCode"/);
});

test("a string literal the case never supplied is rejected — this is the invention that matters", async () => {
  const findings = await check((ir) => {
    apiOp(ir).body!["code"] = { literal: "WH-999" };
  });
  assert.match(findings.errors.join("\n"), /uses the literal "WH-999", which appears nowhere in the case/);
});

test("a literal the case did supply is accepted", async () => {
  const findings = await check((ir) => {
    apiOp(ir).body!["code"] = { literal: "WH-01" };
  });
  assert.deepEqual(findings.errors, []);
});

test("test data the case does not define is rejected", async () => {
  const findings = await check((ir) => {
    apiOp(ir).body!["code"] = { testData: "warehouseCode" };
  });
  assert.match(findings.errors.join("\n"), /uses test data "warehouseCode", which this case does not define/);
});

test("an obligation left neither asserted nor declared unautomatable is rejected", async () => {
  const findings = await check((ir) => {
    ir.assertions.pop();
  });
  assert.match(findings.errors.join("\n"), /is neither asserted nor listed as unautomatable/);
});

test("an obligation cannot be both asserted and declared unautomatable", async () => {
  const findings = await check((ir) => {
    ir.unautomatable.push({ obligation: "create-a-warehouse.step-1", reason: "too hard" });
  });
  assert.match(findings.errors.join("\n"), /both asserted and listed as unautomatable/);
});

test("declaring an obligation unautomatable is accepted, and is the honest exit", async () => {
  const findings = await check((ir) => {
    ir.assertions.pop();
    ir.unautomatable.push({
      obligation: "create-a-warehouse.step-2",
      reason: "the expected result names no field of the response",
    });
  });
  assert.deepEqual(findings.errors, []);
});

test("an assertion naming an obligation of some other case is rejected", async () => {
  const findings = await check((ir) => {
    ir.assertions[0]!.obligation = "some-other-case.step-1";
  });
  assert.match(findings.errors.join("\n"), /which this case does not have/);
});

test("an assertion about an operation the plan never makes is rejected", async () => {
  const findings = await check((ir) => {
    (ir.assertions[0] as { of: string }).of = "fetched";
  });
  assert.match(findings.errors.join("\n"), /which is not one of this plan's operations/);
});

test("reading a value from a call that has not happened yet is rejected", async () => {
  const findings = await check((ir) => {
    apiOp(ir).body!["code"] = { from: "created", path: "id" };
  });
  assert.match(findings.errors.join("\n"), /does not run before it/);
});

test("a status the document does not declare is a gap, not an error — the manual case is the authority", async () => {
  const findings = await check((ir) => {
    statusAssertion(ir).status = 409;
  });

  assert.deepEqual(findings.errors, [], "the assertion stands: a silent document is not a contradicting one");
  assert.match(findings.gaps.join("\n"), /declares no 409 response/);
  assert.match(findings.gaps.join("\n"), /rests on the manual case alone/);
});

test("a matcher that needs a value and has none is rejected", async () => {
  const findings = await check((ir) => {
    delete fieldAssertion(ir).value;
  });
  assert.match(findings.errors.join("\n"), /gives no value to compare against/);
});

test("a later response field can be groundedly different from an earlier response field", async () => {
  const findings = validateIr(createDistinctWarehouseIr(), createDistinctWarehouseCase(), await wmsCatalogue());
  assert.deepEqual(findings, { errors: [], gaps: [] });
});

test("a cross-response comparison cannot read from a later operation", async () => {
  const ir = createDistinctWarehouseIr();
  const assertion = ir.assertions[0]!;
  if (assertion.kind !== "assert.body.field") throw new Error("fixture expected a body assertion");
  assertion.of = "firstCreated";
  assertion.value = { from: "secondCreated", path: "id" };

  const findings = validateIr(ir, createDistinctWarehouseCase(), await wmsCatalogue());
  assert.match(findings.errors.join("\n"), /does not run before it/);
});

test("existence does not discharge an explicit inequality obligation", async () => {
  const ir = createDistinctWarehouseIr();
  const assertion = ir.assertions[0]!;
  if (assertion.kind !== "assert.body.field") throw new Error("fixture expected a body assertion");
  assertion.matcher = "exists";
  delete assertion.value;

  const findings = validateIr(ir, createDistinctWarehouseCase(), await wmsCatalogue());
  assert.match(findings.errors.join("\n"), /requires an inequality assertion/);
});

test("an obligation saying a generated id is returned requires an id assertion", async () => {
  const steps = [{ stepNumber: 1, action: "Create a warehouse.", expectedResult: "The response returns a generated id and status 201." }];
  const testCase = createWarehouseCase({
    steps,
    obligations: [{ id: "create-a-warehouse.step-1", caseId: "TestCase:create-a-warehouse", stepNumber: 1, text: steps[0]!.expectedResult, vague: false }],
  });
  const ir = createWarehouseIr();
  ir.assertions = [statusAssertion(ir)];

  const findings = validateIr(ir, testCase, await wmsCatalogue());
  assert.match(findings.errors.join("\n"), /no assertion proves that the id exists/);
});

test("run-unique test data must be grounded in a string request-body field", async () => {
  const ir = createWarehouseIr();
  fieldAssertion(ir).value = { uniqueTestData: "code" };

  const findings = validateIr(ir, createWarehouseCase(), await wmsCatalogue());
  assert.match(findings.errors.join("\n"), /used both as a fixed value and as run-unique data/);
  assert.match(findings.errors.join("\n"), /is not bound to a documented string request-body field/);
});

test("a case requiring run-unique codes rejects a fixed code binding", async () => {
  const testCase = createWarehouseCase({ automationNotes: "Use a run-unique code on every execution." });
  const findings = validateIr(createWarehouseIr(), testCase, await wmsCatalogue());

  assert.match(findings.errors.join("\n"), /must use uniqueTestData because this case requires run-unique values/);
});

test("path parameters are required by the template, not merely encouraged", async () => {
  const ir = createWarehouseIr();
  ir.ops[0] = {
    kind: "api.request",
    id: "fetched",
    operationId: "get_warehouse_warehouses__warehouse_id__get",
    evidenceRefs: ["api:get_warehouse_warehouses__warehouse_id__get"],
  };
  const findings = validateIr(ir, createWarehouseCase(), await wmsCatalogue());
  assert.match(findings.errors.join("\n"), /needs a path parameter "warehouse_id"/);
});

test("an evidence reference pointing somewhere else is rejected", async () => {
  const findings = await check((ir) => {
    apiOp(ir).evidenceRefs = ["api:delete_zone_zones__zone_id__delete"];
  });
  assert.match(findings.errors.join("\n"), /does not point at create_warehouse_warehouses_post/);
});

test("an assertion's identity is its promise: kind, subject and expected value", () => {
  const ir = createWarehouseIr();
  const before = assertionFingerprint(fieldAssertion(ir));

  const weakened = { ...fieldAssertion(ir), matcher: "exists" as const, value: undefined };

  assert.notEqual(assertionFingerprint(weakened), before, "turning an equality check into a presence check changes what is proved");
});

test("cross-response inequality is part of the frozen assertion identity", () => {
  const ir = createDistinctWarehouseIr();
  const before = assertionFingerprint(ir.assertions[0]!);
  const changed = structuredClone(ir.assertions[0]!);
  if (changed.kind !== "assert.body.field") throw new Error("fixture expected a body assertion");
  changed.matcher = "equals";

  assert.notEqual(assertionFingerprint(changed), before);
});

test("a repair may not drop, weaken or add an assertion", () => {
  const accepted = fingerprintsOf(createWarehouseIr());

  const weakened = createWarehouseIr();
  weakened.assertions.pop();
  assert.match(assertionsUnchanged(accepted, fingerprintsOf(weakened)).join("\n"), /was dropped or weakened/);

  const embellished = createWarehouseIr();
  embellished.assertions.push({ ...statusAssertion(embellished), status: 200 });
  assert.match(assertionsUnchanged(accepted, fingerprintsOf(embellished)).join("\n"), /was added after the plan was accepted/);

  assert.deepEqual(assertionsUnchanged(accepted, fingerprintsOf(createWarehouseIr())), [], "an untouched plan is unchanged");

  assert.match(assertionsUnchanged([accepted[0]!, accepted[0]!], [accepted[0]!]).join("\n"), /was dropped or weakened/);
});

test("a repair may revise bindings but not the accepted plan's promises", async () => {
  const catalogue = await wmsCatalogue();
  const accepted = createWarehouseIr();
  const revised = structuredClone(accepted);
  const revisedRequest = revised.ops.find((op) => op.kind === "api.request")!;
  revisedRequest.id = "createResponse";
  for (const assertion of revised.assertions) {
    if ("of" in assertion) assertion.of = "createResponse";
  }

  assert.deepEqual(validateRepair(accepted, revised, createWarehouseCase(), catalogue).errors, []);

  const weakened = structuredClone(revised);
  fieldAssertion(weakened).matcher = "exists";
  delete fieldAssertion(weakened).value;
  assert.match(validateRepair(accepted, weakened, createWarehouseCase(), catalogue).errors.join("\n"), /dropped or weakened/);

  const changedDisposition = structuredClone(revised);
  changedDisposition.unautomatable.push({ obligation: "create-a-warehouse.step-2", reason: "too difficult" });
  assert.match(validateRepair(accepted, changedDisposition, createWarehouseCase(), catalogue).errors.join("\n"), /may not change which obligations/);
});
