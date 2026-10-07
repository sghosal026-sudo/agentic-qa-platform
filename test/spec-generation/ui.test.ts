import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { format } from "prettier";
import { elementOf, screenByName, type EvidenceCatalogue } from "../../src/spec-generation/evidence/catalogue.js";
import { loadUiContract, locatorExpression } from "../../src/spec-generation/evidence/uiContract.js";
import { EvidenceError } from "../../src/spec-generation/errors.js";
import { obligationsFor } from "../../src/spec-generation/ingest/obligations.js";
import { validateIr } from "../../src/spec-generation/ir/irPolicy.js";
import type { TestIr } from "../../src/spec-generation/ir/testIr.js";
import type { NormalisedCase } from "../../src/spec-generation/model/testCase.js";
import { checkGeneratedSpec } from "../../src/spec-generation/render/generatedPolicy.js";
import { layerOf, renderApiSpec } from "../../src/spec-generation/render/renderer.js";
import { renderScreens } from "../../src/spec-generation/render/uiSupport.js";
import { createWarehouseCase, wmsCatalogue } from "./helpers/apiFixtures.js";
import { throwing } from "./helpers/assertions.js";

const CONTRACT = `
screens:
  warehouse-form:
    url: /
    description: The admin screen for creating a warehouse
    elements:
      code-field:
        role: textbox
        name: Warehouse code
        description: The unique code for the new warehouse
      save-button:
        role: button
        name: Save warehouse
      save-status:
        testId: save-status
`;

function contractFile(yaml: string = CONTRACT): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "specgen-ui-")), "ui-contract.yaml");
  writeFileSync(file, yaml);
  return file;
}

async function uiCatalogue(yaml: string = CONTRACT): Promise<EvidenceCatalogue> {
  const file = contractFile(yaml);
  return { ...(await wmsCatalogue()), ui: loadUiContract(path.basename(file), file) };
}

test("an approved contract becomes screens and elements", async () => {
  const screen = screenByName(await uiCatalogue(), "warehouse-form")!;

  assert.equal(screen.url, "/");
  assert.deepEqual(screen.elements.map((element) => element.id), ["code-field", "save-button", "save-status"]);
});

test("an element's id stays its id, and its accessible name stays a locator detail", async () => {
  // The bug this guards: spreading the locator over the element let `name` (the accessible name)
  // overwrite the element's id, so generated code referred to elements the contract never defined.
  const element = elementOf(screenByName(await uiCatalogue(), "warehouse-form")!, "code-field")!;

  assert.equal(element.id, "code-field");
  assert.equal(element.name, "Warehouse code");
});

test("one element, one locator, in the order Playwright recommends", () => {
  assert.equal(locatorExpression({ id: "x", testId: "save-status", role: "status" }), 'getByTestId("save-status")', "a test id outranks a role");
  assert.equal(locatorExpression({ id: "x", role: "button", name: "Save" }), 'getByRole("button", { name: "Save" })');
  assert.equal(locatorExpression({ id: "x", role: "list" }), 'getByRole("list")');
  assert.equal(locatorExpression({ id: "x", label: "Code" }), 'getByLabel("Code")');
  assert.equal(locatorExpression({ id: "x", text: "Saved" }), 'getByText("Saved")');
});

test("an element with no way to find it is refused", () => {
  const file = contractFile(`
screens:
  s:
    url: /
    elements:
      mystery:
        description: nobody said how to find it
`);
  const error = throwing(() => loadUiContract(path.basename(file), file), EvidenceError);
  assert.match(error.message, /needs one of testId, role, label, placeholder or text/);
});

test("a missing contract says how to make one", () => {
  const error = throwing(() => loadUiContract("nowhere.yaml", contractFile()), EvidenceError);
  assert.match(error.message, /explore --screen/);
});

function formCase(): NormalisedCase {
  const steps = [
    { stepNumber: 1, action: "Open the warehouse admin screen.", expectedResult: "The warehouse code field is shown." },
    { stepNumber: 2, action: "Fill the code and click Save warehouse.", expectedResult: 'The status message contains "was saved".' },
  ];
  return createWarehouseCase({
    caseId: "TestCase:a-warehouse-is-created-from-the-form",
    key: "from-form",
    name: "A warehouse is created from the form",
    steps,
    testData: [
      { name: "code", value: "WH-01" },
      { name: "confirmation", value: "was saved" },
    ],
    obligations: obligationsFor("TestCase:a-warehouse-is-created-from-the-form", "from-form", steps),
  });
}

function formIr(): TestIr {
  return {
    caseId: "TestCase:a-warehouse-is-created-from-the-form",
    layer: "ui",
    ops: [
      { kind: "ui.goto", id: "open", step: 1, screen: "warehouse-form", evidenceRefs: ["ui:warehouse-form"] },
      { kind: "ui.act", id: "fillCode", step: 2, screen: "warehouse-form", element: "code-field", action: "fill", value: { testData: "code" }, evidenceRefs: ["ui:warehouse-form"] },
      { kind: "ui.act", id: "save", step: 2, screen: "warehouse-form", element: "save-button", action: "click", evidenceRefs: ["ui:warehouse-form"] },
    ],
    assertions: [
      { kind: "assert.ui.element", obligation: "from-form.step-1", screen: "warehouse-form", element: "code-field", state: "visible", evidenceRefs: ["ui:warehouse-form"] },
      { kind: "assert.ui.element", obligation: "from-form.step-2", screen: "warehouse-form", element: "save-status", state: "hasText", value: { testData: "confirmation" }, evidenceRefs: ["ui:warehouse-form"] },
    ],
    unautomatable: [],
  };
}

const checkUi = async (mutate: (ir: TestIr) => void = () => {}) => {
  const ir = formIr();
  mutate(ir);
  return validateIr(ir, formCase(), await uiCatalogue());
};

test("a plan using only approved screens and elements passes", async () => {
  assert.deepEqual(await checkUi(), { errors: [], gaps: [] });
});

test("an element nobody approved is refused, even though it is on the page", async () => {
  const findings = await checkUi((ir) => {
    (ir.ops[1] as { element: string }).element = "warehouse-list";
  });
  assert.match(findings.errors.join("\n"), /has no approved element "warehouse-list"/);
  assert.match(findings.errors.join("\n"), /An element nobody has approved cannot be used, even if it is on the page/);
});

test("a screen nobody approved is refused", async () => {
  const findings = await checkUi((ir) => {
    (ir.ops[0] as { screen: string }).screen = "warehouse-list-page";
  });
  assert.match(findings.errors.join("\n"), /is not in the approved UI contract/);
});

test("a target with no contract at all says so, rather than naming a missing screen", async () => {
  const ir = formIr();
  const findings = validateIr(ir, formCase(), { ...(await wmsCatalogue()), ui: [] });
  assert.match(findings.errors.join("\n"), /has no approved UI contract, so no screen can be driven/);
});

test("a fill with no value, or a click with one, is refused", async () => {
  const noValue = await checkUi((ir) => {
    delete (ir.ops[1] as { value?: unknown }).value;
  });
  assert.match(noValue.errors.join("\n"), /The "fill" action on warehouse-form.code-field gives no value/);

  const spurious = await checkUi((ir) => {
    (ir.ops[2] as { value?: unknown }).value = { testData: "code" };
  });
  assert.match(spurious.errors.join("\n"), /The "click" action on warehouse-form.save-button takes no value/);
});

test("a hasText assertion with nothing to compare against is refused", async () => {
  const findings = await checkUi((ir) => {
    delete (ir.assertions[1] as { value?: unknown }).value;
  });
  assert.match(findings.errors.join("\n"), /gives no value to compare against/);
});

test("a case that drives a screen is a UI spec, whatever else it does", async () => {
  const ir = formIr();
  assert.equal(layerOf(ir), "ui");

  const withApi = formIr();
  withApi.ops.push({ kind: "api.request", id: "check", operationId: "create_warehouse_warehouses_post", evidenceRefs: ["api:create_warehouse_warehouses_post"] });
  assert.equal(layerOf(withApi), "ui", "only the browser can perform the action, so the browser decides the layer");
});

test("the rendered spec names elements by their contract id and asserts in step order", async () => {
  const catalogue = await uiCatalogue();
  const rendered = renderApiSpec("FDN-503", [{ testCase: formCase(), ir: formIr(), gaps: [] }], catalogue, "ui-run");
  const contents = await format(rendered.contents, { parser: "typescript", printWidth: 120 });

  assert.equal(rendered.file, "tests/generated/ui/FDN-503.spec.ts");
  assert.match(contents, /import \{ pages \} from "\.\.\/_support\/screens\.js"/);
  assert.match(contents, /const warehouseFormPage = pages\.warehouseForm\(page\)/);
  assert.match(contents, /await warehouseFormPage\.goto\(\)/);
  assert.match(contents, /warehouseFormPage\.codeField\.fill\(code\)/);
  assert.match(contents, /await expect\(warehouseFormPage\.saveStatus\)\.toContainText\(String\(confirmation\)\)/);
  assert.deepEqual(checkGeneratedSpec("x.spec.ts", contents), []);

  // The bug this guards: step 1's assertion was emitted after step 2 had filled the form and
  // clicked Save, so it proved the field was visible *after* the thing it was meant to precede.
  const lines = contents.split("\n");
  const stepOneAssertion = lines.findIndex((line) => line.includes("toBeVisible"));
  const firstFill = lines.findIndex((line) => line.includes(".fill("));
  assert.ok(stepOneAssertion < firstFill, "the step-1 assertion belongs before the step-2 actions");
});

test("no selector is ever written into a UI spec", async () => {
  const rendered = renderApiSpec("FDN-503", [{ testCase: formCase(), ir: formIr(), gaps: [] }], await uiCatalogue(), "ui-run");

  assert.equal(/getByRole|getByTestId|getByLabel|locator\(/.test(rendered.contents), false, "locators live in the screens module alone");
  assert.match(rendered.contents, /pages\.warehouseForm/);
  assert.equal(rendered.contents.includes("page.goto("), false);
});

test("the screens module carries every approved element and nothing else", async () => {
  const screens = renderScreens(await uiCatalogue());

  assert.match(screens, /export class WarehouseFormPage/);
  assert.match(screens, /this\.codeField = page\.getByRole\("textbox", \{ name: "Warehouse code" \}\)/);
  assert.match(screens, /this\.saveStatus = page\.getByTestId\("save-status"\)/);
  assert.match(screens, /warehouseForm: \(page: Page\): WarehouseFormPage => new WarehouseFormPage\(page\)/);
  assert.equal(screens.includes("warehouseList"), false, "an element nobody approved is not in the module at all");
  assert.match(screens, /The unique code for the new warehouse/, "the approver's own words are kept");
});
