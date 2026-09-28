import { saveRun, type NodeKind, type RelationDecision, type Run } from "../core/runtime.js";
import type { GraphStore, ReviewResult, WorkItemClient } from "../contracts.js";
import { isSemanticEdgeAllowed, normalizeRelationshipType } from "../ontology/rules.js";
import { NodeTypeSchema, isSemanticRelationship } from "../ontology/types.js";

export function validRelation(type: string, source: NodeKind, target: NodeKind): boolean {
  const relationshipType = normalizeRelationshipType(type);
  const sourceType = NodeTypeSchema.safeParse(source);
  const targetType = NodeTypeSchema.safeParse(target);
  return Boolean(relationshipType && isSemanticRelationship(relationshipType) && sourceType.success && targetType.success
    && isSemanticEdgeAllowed(relationshipType, sourceType.data, targetType.data));
}

export function parseDecision(text: string, expectedHash: string, reviewer: string, taskId: number): RelationDecision | null {
  const clean = text.replace(/<br\s*\/?\s*>|<\/p>|<\/div>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ");
  const fields = new Map<string, string>();
  for (const line of clean.split(/\r?\n/)) {
    const match = /^([a-z-]+):\s*(.*)$/i.exec(line.trim());
    if (match) fields.set(match[1]!.toLowerCase(), match[2]!.trim());
  }
  if (fields.get("review-hash") !== expectedHash) return null;
  const action = fields.get("decision")?.toLowerCase();
  const reason = fields.get("reason");
  const at = new Date().toISOString();
  if (action === "approve") return { action, reviewer, reason, taskId, at };
  if (action === "reject" && reason) return { action, reviewer, reason, taskId, at };
  if (action === "correct" && reason) {
    const type = normalizeRelationshipType(fields.get("type") ?? "");
    const direction = fields.get("direction")?.toLowerCase();
    if (type && isSemanticRelationship(type) && (direction === "forward" || direction === "reverse")) {
      return { action, reviewer, reason, type, reverse: direction === "reverse", taskId, at };
    }
  }
  return null;
}

export function consensus(decisions: RelationDecision[]): RelationDecision | null {
  if (!decisions.length) return null;
  const first = decisions[0]!;
  return decisions.every((decision) => decision.action === first.action && decision.type === first.type && decision.reverse === first.reverse) ? first : null;
}

export async function stageReviews(run: Run, ado: WorkItemClient): Promise<void> {
  if (run.relations.length) {
    run.status = "review_relations";
    await saveRun(run);
  }
  for (const relation of run.relations) {
    if (relation.state !== "needs_review") continue;
    if (!relation.storyIds.length) {
      run.status = "mapping_error";
      run.errors.push(`No Story mapped to relationship ${relation.id}`);
      await saveRun(run);
      return;
    }
    for (const storyId of relation.storyIds) {
      const story = run.stories.find((item) => item.id === storyId);
      if (!story) {
        run.status = "mapping_error";
        run.errors.push(`No Story mapped to relationship ${relation.id}`);
        await saveRun(run);
        return;
      }
      relation.tasks[storyId] = await ado.task(run.id, relation, story);
      await saveRun(run);
    }
  }
  run.status = run.relations.length ? "review_relations" : "ready_design";
  await saveRun(run);
}

export async function applyReviews(run: Run, ado: WorkItemClient, graph: GraphStore): Promise<ReviewResult> {
  if (run.status !== "review_relations") throw new Error(`Run ${run.id} is not ready for relationship decisions`);
  const result = { pending: 0, conflicts: 0, applied: 0 };
  for (const relation of run.relations) {
    if (relation.state !== "needs_review") continue;
    const decisions: RelationDecision[] = [];
    for (const storyId of relation.storyIds) {
      const task = relation.tasks[storyId];
      if (!task) throw new Error(`Relationship ${relation.id} has no Task under ${storyId}`);
      const decision = await ado.decision(task.id, task.hash);
      if (decision) decisions.push(decision);
    }
    if (decisions.length !== relation.storyIds.length) { result.pending += 1; continue; }
    const agreed = consensus(decisions);
    if (!agreed) { result.conflicts += 1; continue; }
    if (agreed.action === "approve" && !validRelation(relation.type, relation.sourceType, relation.targetType)) { result.conflicts += 1; continue; }
    if (agreed.action === "correct") {
      const source = agreed.reverse ? relation.targetType : relation.sourceType;
      const target = agreed.reverse ? relation.sourceType : relation.targetType;
      if (!agreed.type || !validRelation(agreed.type, source, target)) { result.conflicts += 1; continue; }
      relation.type = agreed.type;
    }
    relation.decisions = decisions;
    relation.state = agreed.action === "reject" ? "rejected" : "approved";
    await graph.decide(relation);
    await saveRun(run);
    result.applied += 1;
  }
  if (!result.pending && !result.conflicts) run.status = "ready_design";
  await saveRun(run);
  return result;
}
