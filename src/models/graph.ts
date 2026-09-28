import { z } from "zod";
import { ExtractionMethodSchema, NodeTypeSchema, RelationshipTypeSchema, ReviewStateSchema } from "../ontology/types.js";

export const ProvenanceSchema = z.object({
  sourceSystem: z.string(),
  sourceDocument: z.string().optional(),
  sourceDocumentId: z.string().optional(),
  sourceChunkId: z.string().optional(),
  extractionMethod: ExtractionMethodSchema,
  model: z.string().optional(),
  evidenceText: z.string().optional(),
  confidence: z.number().min(0).max(1),
  /** true when the fact is derived by reasoning rather than stated in the source. */
  inferred: z.boolean().default(false),
  reviewState: ReviewStateSchema.default("pending"),
});

export type Provenance = z.infer<typeof ProvenanceSchema>;

export const NodeSchema = z.object({
  id: z.string().min(1),
  nodeType: NodeTypeSchema,
  canonicalName: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  properties: z.record(z.string(), z.unknown()).default({}),
  description: z.string().optional(),
  provenance: z.array(ProvenanceSchema).default([]),
  createdAt: z.coerce.date().default(() => new Date()),
  updatedAt: z.coerce.date().default(() => new Date()),
});

export type Node = z.infer<typeof NodeSchema>;

export const EdgeSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  relationshipType: RelationshipTypeSchema,
  targetId: z.string().min(1),
  properties: z.record(z.string(), z.unknown()).default({}),
  provenance: z.array(ProvenanceSchema).default([]),
  confidence: z.number().min(0).max(1).default(1),
  inferred: z.boolean().default(false),
  reviewState: ReviewStateSchema.default("pending"),
  evidence: z.array(z.string()).default([]),
});

export type Edge = z.infer<typeof EdgeSchema>;

/** A relationship whose source or target did not exist when its document was extracted. */
export interface UnresolvedRelationship {
  id: string;
  sourceDocumentId: string;
  sourceName: string;
  sourceId?: string;
  proposedType: string;
  targetName: string;
  targetId?: string;
  evidence: string;
  confidence: number;
  inferred: boolean;
  provenance: Provenance[];
  reason: "unknown_source" | "unknown_target" | "unknown_endpoints";
}

/** Identity of an edge: at most one relationship of a given type between two nodes. */
export function edgeKey(edge: Pick<Edge, "sourceId" | "relationshipType" | "targetId">): string {
  return `${edge.sourceId}|${edge.relationshipType}|${edge.targetId}`;
}

/**
 * Where a piece of knowledge comes from, strongest first:
 * - source_metadata: parsed deterministically from the source system
 * - extracted: stated in document content (LLM extraction with evidence, not inferred)
 * - inferred: derived by reasoning (inferred LLM output, entity resolution, agents)
 */
export type KnowledgeOrigin = "source_metadata" | "extracted" | "inferred";

export function knowledgeOrigin(provenance: readonly Provenance[]): KnowledgeOrigin | undefined {
  if (provenance.length === 0) return undefined;
  if (provenance.some((p) => p.extractionMethod === "deterministic" && !p.inferred)) return "source_metadata";
  if (provenance.some((p) => !p.inferred)) return "extracted";
  return "inferred";
}

/** Authoritative means backed by source metadata. LLM-extracted and inferred knowledge never is. */
export function isAuthoritative(provenance: readonly Provenance[]): boolean {
  return knowledgeOrigin(provenance) === "source_metadata";
}

export function maxConfidence(provenance: readonly Provenance[], fallback = 0): number {
  return provenance.reduce((max, p) => Math.max(max, p.confidence), fallback);
}

function provenanceKey(p: Provenance): string {
  return [p.sourceSystem, p.extractionMethod, p.sourceDocumentId ?? "", p.sourceChunkId ?? "", p.evidenceText ?? ""].join("|");
}

/** Concatenates provenance lists, dropping duplicates (later entries replace earlier ones). */
export function mergeProvenance(...lists: ReadonlyArray<readonly Provenance[]>): Provenance[] {
  const merged = new Map<string, Provenance>();
  for (const list of lists) {
    for (const p of list) merged.set(provenanceKey(p), p);
  }
  return Array.from(merged.values());
}
