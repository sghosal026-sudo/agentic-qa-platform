import type { Layer } from "../model/testCase.js";

/**
 * What the agent knows about the target, and how it came to know it.
 *
 * The catalogue is the only vocabulary the model is given. It may pick an operation id from here,
 * a field path from here, a status code from here — and nothing else. That is what makes "never
 * invent a route" a property of the system rather than an instruction in a prompt.
 *
 * Every item carries its provenance, so a spec written today can still be explained next month:
 * which document, read when, and what it hashed to.
 */

export interface Provenance {
  /** The URL or file the item was read from. */
  source: string;
  collectedAt: string;
  /** Hash of the item's own slice of the document, so a changed operation is visible as changed. */
  contentHash: string;
  /** A JSON pointer into the source document. */
  pointer: string;
}

export interface FieldSpec {
  /** Dotted path within the body: `code`, `address.city`, `[].id` for an array of objects. */
  path: string;
  type: string;
  required: boolean;
  enum?: string[];
  format?: string;
  minLength?: number;
  maxLength?: number;
  description?: string;
}

export interface ParamSpec {
  name: string;
  in: "path" | "query" | "header";
  type: string;
  required: boolean;
  enum?: string[];
  description?: string;
}

export interface ResponseSpec {
  status: number;
  description?: string;
  fields: FieldSpec[];
}

export interface ApiOperation {
  /** The id the model refers to this operation by: `api:<operationId>`. */
  id: string;
  layer: "api";
  operationId: string;
  method: "get" | "put" | "post" | "delete" | "patch" | "head" | "options";
  /** The templated path, e.g. `/warehouses/{warehouse_id}`. Never written into a spec directly. */
  pathTemplate: string;
  summary?: string;
  parameters: ParamSpec[];
  requestBody?: {
    required: boolean;
    contentType: string;
    fields: FieldSpec[];
  };
  responses: ResponseSpec[];
  /** The operation requires authentication, so a run without a token would fail for that reason. */
  secured: boolean;
  provenance: Provenance;
}

export interface DbColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  /** The database enforces uniqueness on this column alone. */
  unique: boolean;
}

/** One table, as the schema declares it. The only vocabulary a database assertion may use. */
export interface DbTable {
  /** `db:warehouse`. */
  id: string;
  layer: "db";
  name: string;
  columns: DbColumn[];
  primaryKey: string[];
  provenance: Provenance;
}

/**
 * One control on a screen, as a human approved it.
 *
 * `id` is what the plan and the generated code call it; `name` is the control's *accessible name*,
 * which is Playwright's vocabulary and part of how it is found. Keeping them apart matters: an
 * earlier version used `name` for both, and the accessible name silently overwrote the id, so the
 * generated code referred to elements by labels that the contract had never defined.
 */
export interface UiElement {
  /** The key in the contract: `code-field`. */
  id: string;
  testId?: string;
  role?: string;
  /** The accessible name, alongside a role. */
  name?: string;
  label?: string;
  placeholder?: string;
  text?: string;
  description?: string;
}

/** A screen from the approved UI contract. Never collected automatically — always approved. */
export interface UiScreen {
  /** `ui:warehouse-form`. */
  id: string;
  layer: "ui";
  name: string;
  /** Path relative to the target's base URL. */
  url: string;
  description?: string;
  elements: UiElement[];
  provenance: Provenance;
}

export interface EvidenceCatalogue {
  target: string;
  collectedAt: string;
  api: ApiOperation[];
  db: DbTable[];
  ui: UiScreen[];
  /** Runtime authentication mechanisms the target explicitly configured. Secrets are never stored. */
  auth: { id: string; kind: "http-bearer"; headerName: "Authorization"; scheme: "Bearer"; provenance: Provenance }[];
  /** Why a layer holds nothing: the target names no OpenAPI document, the database is not configured. */
  absent: { layer: Layer; reason: string }[];
}

export const emptyCatalogue = (target: string): EvidenceCatalogue => ({
  target,
  collectedAt: new Date().toISOString(),
  api: [],
  db: [],
  ui: [],
  auth: [],
  absent: [],
});

export function screenByName(catalogue: EvidenceCatalogue, name: string): UiScreen | undefined {
  return catalogue.ui.find((screen) => screen.name === name || screen.id === name);
}

export function elementOf(screen: UiScreen, id: string): UiElement | undefined {
  return screen.elements.find((element) => element.id === id);
}

export function tableByName(catalogue: EvidenceCatalogue, name: string): DbTable | undefined {
  return catalogue.db.find((table) => table.name === name || table.id === name);
}

export function columnOf(table: DbTable, name: string): DbColumn | undefined {
  return table.columns.find((column) => column.name === name);
}

export function operationById(catalogue: EvidenceCatalogue, id: string): ApiOperation | undefined {
  return catalogue.api.find((operation) => operation.id === id || operation.operationId === id);
}

/** Field paths an assertion may name on a given response, and the operation's own parameter names. */
export function responseFor(operation: ApiOperation, status: number): ResponseSpec | undefined {
  return operation.responses.find((response) => response.status === status);
}

export function parameterNames(operation: ApiOperation, where: ParamSpec["in"]): string[] {
  return operation.parameters.filter((parameter) => parameter.in === where).map((parameter) => parameter.name);
}

/** Path parameters the template itself demands, whatever the document declares. */
export function pathPlaceholders(pathTemplate: string): string[] {
  return [...pathTemplate.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
}
