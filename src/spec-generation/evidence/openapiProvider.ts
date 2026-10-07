import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { dereference, validate } from "@scalar/openapi-parser";
import type { TargetConfig } from "../config/targetConfig.js";
import { EvidenceError } from "../errors.js";
import type { ApiOperation, EvidenceCatalogue, FieldSpec, ParamSpec, ResponseSpec } from "./catalogue.js";

/**
 * Reads the target's OpenAPI document into evidence.
 *
 * The document is validated and dereferenced first, so the catalogue holds no `$ref` for the model
 * to resolve and no half-understood schema. What comes out is deliberately flat: an operation id, a
 * templated path, the parameters it takes, the fields its body accepts, and the responses it
 * declares. Anything the document does not say is not in the catalogue, and so cannot be asserted.
 */

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"] as const;
type Method = (typeof METHODS)[number];

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

/** JSON pointer escaping: `/warehouses/{id}` → `~1warehouses~1{id}`. */
const pointerFor = (pathTemplate: string, method: string): string =>
  `#/paths/${pathTemplate.replace(/~/g, "~0").replace(/\//g, "~1")}/${method}`;

async function readDocument(source: { url?: string; file?: string }, relativeTo: string): Promise<{ text: string; source: string }> {
  if (source.url) {
    let response: Response;
    try {
      response = await fetch(source.url);
    } catch (error) {
      throw new EvidenceError(
        `Could not fetch the OpenAPI document at ${source.url}: ${error instanceof Error ? error.message : String(error)}. ` +
          `Is the application running? A document can also be given as openapi.file.`
      );
    }
    if (!response.ok) throw new EvidenceError(`The OpenAPI document at ${source.url} answered ${response.status} ${response.statusText}.`);
    return { text: await response.text(), source: source.url };
  }

  const file = path.resolve(path.dirname(relativeTo), source.file!);
  if (!existsSync(file)) throw new EvidenceError(`No OpenAPI document at ${file}.`);
  return { text: readFileSync(file, "utf8"), source: file };
}

/** A JSON Schema, flattened into the field paths an assertion is allowed to name. */
function fieldsOf(schema: unknown, prefix = "", depth = 0): FieldSpec[] {
  if (!schema || typeof schema !== "object" || depth > 3) return [];
  const node = schema as Record<string, any>;

  if (node.type === "array" || node.items) return fieldsOf(node.items, `${prefix}[].`, depth + 1);

  const properties = node.properties as Record<string, any> | undefined;
  if (!properties) return [];

  const required = new Set<string>(Array.isArray(node.required) ? (node.required as string[]) : []);
  const fields: FieldSpec[] = [];
  for (const [name, property] of Object.entries(properties)) {
    const fieldPath = `${prefix}${name}`;
    // A nullable field in OpenAPI 3.1 is `anyOf: [{type}, {type: "null"}]`; take the first real type.
    const resolved = Array.isArray(property.anyOf) ? (property.anyOf.find((entry: any) => entry?.type && entry.type !== "null") ?? property) : property;
    fields.push({
      path: fieldPath,
      type: typeof resolved.type === "string" ? resolved.type : "unknown",
      required: required.has(name),
      ...(Array.isArray(resolved.enum) ? { enum: resolved.enum.map(String) } : {}),
      ...(typeof resolved.format === "string" ? { format: resolved.format } : {}),
      ...(typeof resolved.minLength === "number" ? { minLength: resolved.minLength } : {}),
      ...(typeof resolved.maxLength === "number" ? { maxLength: resolved.maxLength } : {}),
      ...(typeof property.description === "string" ? { description: property.description } : {}),
    });
    fields.push(...fieldsOf(resolved, `${fieldPath}.`, depth + 1));
  }
  return fields;
}

function parametersOf(operation: Record<string, any>, shared: unknown): ParamSpec[] {
  const all = [...(Array.isArray(shared) ? shared : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])];
  const parameters: ParamSpec[] = [];
  for (const raw of all as Record<string, any>[]) {
    if (!raw?.name || !["path", "query", "header"].includes(raw.in)) continue;
    const schema = (raw.schema ?? {}) as Record<string, any>;
    const resolved = Array.isArray(schema.anyOf) ? (schema.anyOf.find((entry: any) => entry?.type && entry.type !== "null") ?? schema) : schema;
    parameters.push({
      name: String(raw.name),
      in: raw.in as ParamSpec["in"],
      type: typeof resolved.type === "string" ? resolved.type : "string",
      required: raw.in === "path" ? true : Boolean(raw.required),
      ...(Array.isArray(resolved.enum) ? { enum: resolved.enum.map(String) } : {}),
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    });
  }
  return parameters;
}

function responsesOf(operation: Record<string, any>): ResponseSpec[] {
  const responses: ResponseSpec[] = [];
  for (const [status, raw] of Object.entries((operation.responses ?? {}) as Record<string, any>)) {
    const code = Number.parseInt(status, 10);
    if (!Number.isFinite(code)) continue; // "default" carries no status to assert
    const schema = raw?.content?.["application/json"]?.schema;
    responses.push({
      status: code,
      ...(typeof raw?.description === "string" ? { description: raw.description } : {}),
      fields: fieldsOf(schema),
    });
  }
  return responses.sort((a, b) => a.status - b.status);
}

/**
 * An operation id every time, even when the document omits one.
 *
 * A document without operation ids would otherwise give the model nothing stable to point at.
 * The fallback is derived from the method and path, so it is stable across runs of the same
 * document — but it is derived, not invented: it names a path that is really there.
 */
const derivedOperationId = (method: string, pathTemplate: string): string =>
  `${method}${pathTemplate
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/[{}]/g, "").replace(/(^|[-_])([a-z])/g, (_m, _s, letter: string) => letter.toUpperCase()))
    .join("")}`;

export interface OpenApiEvidence {
  operations: ApiOperation[];
  auth: EvidenceCatalogue["auth"];
  source: string;
  /** Problems the document has that do not stop it being read. */
  warnings: string[];
}

export async function collectOpenApiEvidence(target: TargetConfig): Promise<OpenApiEvidence> {
  if (!target.openapi) throw new EvidenceError(`${target.file} names no OpenAPI document, so API cases cannot be grounded.`);

  const { text, source } = await readDocument(target.openapi, target.file);
  const warnings: string[] = [];

  const validation = await validate(text);
  if (!validation.valid) {
    const problems = (validation.errors ?? []).slice(0, 5).map((error) => error.message ?? String(error));
    throw new EvidenceError(`The OpenAPI document at ${source} is not valid:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }

  const { schema } = await dereference(text);
  const paths = (schema as Record<string, any> | undefined)?.paths as Record<string, any> | undefined;
  if (!paths || Object.keys(paths).length === 0) throw new EvidenceError(`The OpenAPI document at ${source} declares no paths.`);

  const collectedAt = new Date().toISOString();
  const auth: EvidenceCatalogue["auth"] = [];
  const securitySchemes = ((schema as Record<string, any>).components?.securitySchemes ?? {}) as Record<string, any>;
  for (const [name, securityScheme] of Object.entries(securitySchemes)) {
    if (securityScheme?.type !== "http" || String(securityScheme.scheme).toLowerCase() !== "bearer") continue;
    auth.push({
      id: `auth:http-bearer:${name}`,
      kind: "http-bearer",
      headerName: "Authorization",
      scheme: "Bearer",
      provenance: { source, collectedAt, contentHash: hash(securityScheme), pointer: `#/components/securitySchemes/${name}` },
    });
  }
  const globalSecurity = Array.isArray((schema as Record<string, any>).security) && (schema as Record<string, any>).security.length > 0;
  const operations: ApiOperation[] = [];
  const seen = new Map<string, string>();

  for (const [pathTemplate, item] of Object.entries(paths)) {
    for (const method of METHODS) {
      const operation = item?.[method] as Record<string, any> | undefined;
      if (!operation) continue;

      const declared = typeof operation.operationId === "string" ? operation.operationId : undefined;
      const operationId = declared ?? derivedOperationId(method, pathTemplate);
      const previous = seen.get(operationId);
      if (previous) {
        warnings.push(`Two operations share the id "${operationId}" (${previous} and ${method.toUpperCase()} ${pathTemplate}); the second is not offered as evidence.`);
        continue;
      }
      seen.set(operationId, `${method.toUpperCase()} ${pathTemplate}`);
      if (!declared) warnings.push(`${method.toUpperCase()} ${pathTemplate} declares no operationId; it is offered as "${operationId}".`);

      const bodyContent = (operation.requestBody?.content ?? {}) as Record<string, any>;
      const contentType = Object.keys(bodyContent).find((type) => type.includes("json")) ?? Object.keys(bodyContent)[0];

      operations.push({
        id: `api:${operationId}`,
        layer: "api",
        operationId,
        method: method as Method,
        pathTemplate,
        ...(typeof operation.summary === "string" ? { summary: operation.summary } : {}),
        parameters: parametersOf(operation, item.parameters),
        ...(contentType
          ? {
              requestBody: {
                required: Boolean(operation.requestBody?.required),
                contentType,
                fields: fieldsOf(bodyContent[contentType]?.schema),
              },
            }
          : {}),
        responses: responsesOf(operation),
        secured: Array.isArray(operation.security) ? operation.security.length > 0 : globalSecurity,
        provenance: {
          source,
          collectedAt,
          contentHash: hash(operation),
          pointer: pointerFor(pathTemplate, method),
        },
      });
    }
  }

  return { operations, auth, source, warnings };
}
