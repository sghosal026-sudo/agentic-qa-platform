import { hash, saveRun, type Run } from "../core/runtime.js";
import type { SprintWorkItemClient } from "../contracts.js";

export type ArtifactReviewResult = { pending: number; rejected: number; approved: number };

export async function stageArtifactReviews(run: Run, workItems: SprintWorkItemClient): Promise<void> {
  if (run.status !== "review_artifacts") throw new Error(`Run ${run.id} is not ready for test review`);
  const story = run.stories[0];
  if (!story || run.stories.length !== 1) throw new Error("Story pipeline runs must contain exactly one Story");
  for (const artifact of run.artifacts) {
    if (artifact.reviewTask) continue;
    artifact.reviewTask = await workItems.artifactTask(run.id, artifact, story);
    await saveRun(run);
  }
}

export async function applyArtifactReviews(run: Run, workItems: SprintWorkItemClient): Promise<ArtifactReviewResult> {
  if (run.status !== "review_artifacts") throw new Error(`Run ${run.id} is not ready for test review`);
  const result: ArtifactReviewResult = { pending: 0, rejected: 0, approved: 0 };
  for (const artifact of run.artifacts) {
    if (artifact.reviewer && artifact.approvedAt && artifact.hash === hash(artifact.content)) {
      result.approved += 1;
      continue;
    }
    if (!artifact.reviewTask) throw new Error(`Artifact ${artifact.id} has no ADO review Task`);
    const decision = await workItems.artifactDecision(artifact.reviewTask.id, artifact.reviewTask.hash);
    if (!decision) {
      result.pending += 1;
      continue;
    }
    if (decision.action === "reject") {
      result.rejected += 1;
      continue;
    }
    artifact.hash = hash(artifact.content);
    artifact.reviewer = decision.reviewer;
    artifact.approvedAt = decision.at;
    result.approved += 1;
    await saveRun(run);
  }
  return result;
}
