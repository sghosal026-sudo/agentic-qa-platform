import { mergeProvenance, type Edge, type Node } from "../models/graph.js";
import { unique } from "../utils/text.js";

/** Merges two descriptions of the same node. `primary` keeps its identity and wins conflicts. */
export function mergeNodes(primary: Node, secondary: Node): Node {
  const aliases = unique([secondary.canonicalName, ...primary.aliases, ...secondary.aliases]).filter(
    (alias) => alias && alias !== primary.canonicalName
  );
  return {
    ...primary,
    aliases,
    properties: { ...secondary.properties, ...primary.properties },
    description: primary.description ?? secondary.description,
    provenance: mergeProvenance(primary.provenance, secondary.provenance),
    createdAt: primary.createdAt <= secondary.createdAt ? primary.createdAt : secondary.createdAt,
    updatedAt: primary.updatedAt >= secondary.updatedAt ? primary.updatedAt : secondary.updatedAt,
  };
}

/** Merges two occurrences of the same (source, type, target) relationship. */
export function mergeEdges(primary: Edge, secondary: Edge): Edge {
  const authoritative = !primary.inferred ? primary : !secondary.inferred ? secondary : undefined;
  const reviewed = [primary, secondary].find((edge) => edge.reviewState === "approved" || edge.reviewState === "rejected");
  const provenance = mergeProvenance(primary.provenance, secondary.provenance);
  return {
    ...primary,
    properties: { ...secondary.properties, ...primary.properties },
    provenance: reviewed ? provenance.map((entry) => ({ ...entry, reviewState: reviewed.reviewState })) : provenance,
    confidence: Math.max(primary.confidence, secondary.confidence),
    inferred: primary.inferred && secondary.inferred,
    reviewState: reviewed?.reviewState ?? authoritative?.reviewState ?? primary.reviewState,
    evidence: unique([...primary.evidence, ...secondary.evidence]),
  };
}
