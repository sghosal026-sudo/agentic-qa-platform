import assert from "node:assert/strict";
import test from "node:test";
import { operationById, pathPlaceholders, responseFor } from "../../src/spec-generation/evidence/catalogue.js";
import { collectOpenApiEvidence } from "../../src/spec-generation/evidence/openapiProvider.js";
import { EvidenceError } from "../../src/spec-generation/errors.js";
import { wmsCatalogue, wmsTarget } from "./helpers/apiFixtures.js";

test("the real wms-api document is read into operations", async () => {
  const catalogue = await wmsCatalogue();
  assert.ok(catalogue.api.length > 20, `expected the whole document, got ${catalogue.api.length} operation(s)`);

  const create = operationById(catalogue, "create_warehouse_warehouses_post");
  assert.ok(create);
  assert.equal(create.method, "post");
  assert.equal(create.pathTemplate, "/warehouses");
  assert.equal(create.secured, true, "the document says this endpoint takes a bearer token");
});

test("a request body is flattened into the field paths a plan may name", async () => {
  const create = operationById(await wmsCatalogue(), "create_warehouse_warehouses_post")!;
  const fields = create.requestBody!.fields;

  assert.deepEqual(fields.map((field) => field.path).sort(), ["address", "code", "name", "timezone"]);
  assert.equal(fields.every((field) => field.required), true, "all four are required by the document");
  assert.equal(fields.find((field) => field.path === "code")!.minLength, 1);
  assert.equal(fields.find((field) => field.path === "code")!.maxLength, 32);
  assert.equal(create.requestBody!.contentType, "application/json");
});

test("declared responses carry their fields, and nothing else is offered", async () => {
  const create = operationById(await wmsCatalogue(), "create_warehouse_warehouses_post")!;

  assert.deepEqual(create.responses.map((response) => response.status), [201, 422]);
  assert.deepEqual(
    responseFor(create, 201)!.fields.map((field) => field.path).sort(),
    ["active", "address", "code", "id", "name", "timezone"]
  );
  assert.equal(responseFor(create, 409), undefined, "the document does not declare a conflict response — which the policy has to handle");
});

test("path parameters are taken from the template, not only from the document", async () => {
  const catalogue = await wmsCatalogue();
  const get = operationById(catalogue, "get_warehouse_warehouses__warehouse_id__get")!;

  assert.deepEqual(pathPlaceholders(get.pathTemplate), ["warehouse_id"]);
  assert.deepEqual(get.parameters.map((parameter) => `${parameter.in}:${parameter.name}`), ["path:warehouse_id"]);
});

test("every operation carries where it came from", async () => {
  const create = operationById(await wmsCatalogue(), "create_warehouse_warehouses_post")!;

  assert.match(create.provenance.pointer, /^#\/paths\/~1warehouses\/post$/);
  assert.match(create.provenance.source, /wms-openapi\.json$/);
  assert.match(create.provenance.contentHash, /^[0-9a-f]{16}$/);
});

test("a target naming no OpenAPI document is told so, not guessed at", async () => {
  const target = { ...wmsTarget() };
  delete (target as { openapi?: unknown }).openapi;

  await assert.rejects(() => collectOpenApiEvidence(target), EvidenceError);
});

test("a missing document fails with the path it looked in", async () => {
  const target = { ...wmsTarget(), openapi: { file: "nowhere.json" } };
  const error = await collectOpenApiEvidence(target).catch((caught: unknown) => caught);

  assert.ok(error instanceof EvidenceError);
  assert.match(error.message, /nowhere\.json/);
});

test("a document that is not OpenAPI at all is rejected before anything is read from it", async () => {
  const target = { ...wmsTarget(), openapi: { file: "design.fixture.json" } };
  await assert.rejects(() => collectOpenApiEvidence(target), EvidenceError);
});
