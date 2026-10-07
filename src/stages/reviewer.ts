import { z } from "zod";
import { saveRun, type Relation, type Run } from "../core/runtime.js";
import type { ModelClient, WorkItemClient } from "../contracts.js";
import { normalizeName } from "../ontology/identifiers.js";
import { isSemanticEdgeAllowed } from "../ontology/rules.js";
import { NodeTypeSchema, RELATIONSHIP_TYPES } from "../ontology/types.js";
import { relationshipReviewPrompt } from "../prompts/review.js";
import { validRelation } from "./review.js";

const Recommendation = z.object({
  action: z.enum(["approve", "correct", "reject", "unsure"]),
  reason: z.string().min(1),
  quote: z.string().nullish(),
  type: z.string().nullish(),
  direction: z.enum(["forward", "reverse"]).nullish(),
});

function safeText(value: string): string {
  return value.replace(/\b(Review-Hash|Decision)\s*:/gi, "$1 -").replace(/\s+/g, " ").trim()
    .replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]!);
}

export function reviewRecommendation(relation: Relation, sourceText: string, response: unknown): string {
  const result = Recommendation.parse(response);
  let action = result.action;
  let reason = result.reason;
  const quote = result.quote?.trim() ?? "";
  if (action !== "unsure" && (!normalizeName(quote) || !normalizeName(sourceText).includes(normalizeName(quote)))) {
    action = "unsure";
    reason = "The reviewer did not provide a quote found in the source text.";
  }
  if (action === "approve" && !validRelation(relation.type, relation.sourceType, relation.targetType)) {
    action = "unsure";
    reason = "The proposed relationship is not allowed by the ontology.";
  }
  if (action === "correct") {
    const source = result.direction === "reverse" ? relation.targetType : relation.sourceType;
    const target = result.direction === "reverse" ? relation.sourceType : relation.targetType;
    if (!result.type || !result.direction || !validRelation(result.type, source, target)) {
      action = "unsure";
      reason = "The suggested correction is not allowed by the ontology.";
    }
  }
  const lines = [`Suggested action: ${action}`, `Why: ${safeText(reason)}`];
  if (quote && action !== "unsure") lines.push(`Source quote: ${safeText(quote)}`);
  if (action === "correct") lines.push(`Suggested relationship: ${result.type!.toUpperCase()} (${result.direction})`);
  return lines.join("\n");
}

export async function recommendPending(run: Run, model: ModelClient, workItems: WorkItemClient, modelName: string): Promise<void> {
  for (const relation of run.relations) {
    if (relation.state !== "needs_review") continue;
    const story = run.stories.find((item) => item.id === relation.storyIds[0]);
    const source = story?.id === relation.source ? story : story?.parents?.find((item) => item.id === relation.source) ?? story;
    if (!source) continue;
    const sourceType = NodeTypeSchema.safeParse(relation.sourceType);
    const targetType = NodeTypeSchema.safeParse(relation.targetType);
    const forward = sourceType.success && targetType.success
      ? RELATIONSHIP_TYPES.filter((type) => isSemanticEdgeAllowed(type, sourceType.data, targetType.data)) : [];
    const reverse = sourceType.success && targetType.success
      ? RELATIONSHIP_TYPES.filter((type) => isSemanticEdgeAllowed(type, targetType.data, sourceType.data)) : [];
    for (const storyId of relation.storyIds) {
      const task = relation.tasks[storyId];
      if (!task) continue;
      try {
        if (await workItems.recommendationStatus(task.id, task.hash, modelName) !== "needed") continue;
        const sourceText = relation.sourceText ?? source.text;
        const prompt = relationshipReviewPrompt(relation, sourceText, forward, reverse);
        const recommendation = reviewRecommendation(relation, sourceText, await model.json(prompt));
        const comment = `AI relationship recommendation | ${task.hash} | ${modelName}\n${recommendation}\nHuman review is still required.`;
        await workItems.postRecommendation(task.id, task.hash, modelName, comment);
      } catch (error) {
        const warning = `AI reviewer Task ${task.id}: ${error instanceof Error ? error.message : String(error)}`;
        if (!(run.warnings ?? []).includes(warning)) (run.warnings ??= []).push(warning);
        await saveRun(run);
      }
    }
  }
}
