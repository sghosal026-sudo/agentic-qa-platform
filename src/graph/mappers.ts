import {
  EdgeSchema,
  NodeSchema,
  ProvenanceSchema,
  isAuthoritative,
  maxConfidence,
  type Edge,
  type Node,
  type Provenance,
} from "../models/graph.js";
import { errorMessage } from "../utils/text.js";

type Properties = Record<string, unknown>;

/** Accepts a neo4j-driver Node/Relationship (with `.properties`) or a plain property map. */
function propertiesOf(value: unknown): Properties {
  if (value && typeof value === "object") {
    const inner = (value as { properties?: unknown }).properties;
    return inner && typeof inner === "object" ? (inner as Properties) : (value as Properties);
  }
  return {};
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseProvenance(value: unknown): Provenance[] {
  return parseJson<unknown[]>(value, []).flatMap((entry) => {
    const parsed = ProvenanceSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (value !== null && value !== undefined) {
    const date = new Date(typeof value === "number" ? value : String(value));
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date(0);
}

/** Neo4j properties must be primitives or arrays of primitives, so maps are stored as JSON strings. */
export function nodeToRow(node: Node): Properties {
  return {
    id: node.id,
    nodeType: node.nodeType,
    canonicalName: node.canonicalName,
    title: typeof node.properties.title === "string" ? node.properties.title : null,
    aliases: node.aliases,
    aliasText: node.aliases.join(" | "),
    description: node.description ?? null,
    propertiesJson: JSON.stringify(node.properties),
    provenanceJson: JSON.stringify(node.provenance),
    authoritative: isAuthoritative(node.provenance),
    confidence: maxConfidence(node.provenance),
    createdAt: node.createdAt.toISOString(),
    updatedAt: node.updatedAt.toISOString(),
  };
}

export function nodeFromRecord(value: unknown): Node {
  const p = propertiesOf(value);
  const parsed = NodeSchema.safeParse({
    id: p.id,
    nodeType: p.nodeType,
    canonicalName: p.canonicalName ?? p.id,
    aliases: Array.isArray(p.aliases) ? p.aliases.map(String) : [],
    properties: parseJson<Properties>(p.propertiesJson, {}),
    description: typeof p.description === "string" ? p.description : undefined,
    provenance: parseProvenance(p.provenanceJson),
    createdAt: toDate(p.createdAt),
    updatedAt: toDate(p.updatedAt),
  });
  if (!parsed.success) {
    throw new Error(`Unreadable node ${String(p.id)} in Neo4j (re-run "ingest --reset"): ${errorMessage(parsed.error.issues[0]?.message)}`);
  }
  return parsed.data;
}

export function edgeToRow(edge: Edge, now: string): Properties {
  return {
    id: edge.id,
    sourceId: edge.sourceId,
    targetId: edge.targetId,
    relationshipType: edge.relationshipType,
    propertiesJson: JSON.stringify(edge.properties),
    provenanceJson: JSON.stringify(edge.provenance),
    confidence: edge.confidence,
    inferred: edge.inferred,
    reviewState: edge.reviewState,
    evidence: edge.evidence,
    updatedAt: now,
  };
}

export function edgeFromRecord(value: unknown, sourceId: string, targetId: string, relationshipType: string): Edge {
  const p = propertiesOf(value);
  return EdgeSchema.parse({
    id: typeof p.id === "string" ? p.id : `${sourceId}|${relationshipType}|${targetId}`,
    sourceId,
    targetId,
    relationshipType,
    properties: parseJson<Properties>(p.propertiesJson, {}),
    provenance: parseProvenance(p.provenanceJson),
    confidence: typeof p.confidence === "number" ? p.confidence : 1,
    inferred: p.inferred === true,
    reviewState: typeof p.reviewState === "string" ? p.reviewState : "pending",
    evidence: Array.isArray(p.evidence) ? p.evidence.map(String) : [],
  });
}
