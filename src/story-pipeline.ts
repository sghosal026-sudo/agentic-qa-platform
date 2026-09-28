import { loadTarget, design, generateSpecs, ingestDesign, ingestStory } from "./stages/workflow.js";
import { applyReviews } from "./stages/review.js";
import { applyArtifactReviews, stageArtifactReviews } from "./stages/artifact-review.js";
import { executeApproved, pullRequestHead, specsApproved } from "./stages/execution.js";
import { saveRun, type StoryPipelineRecord } from "./core/runtime.js";
import type { GraphStore, ModelClient, SprintWorkItemClient } from "./contracts.js";

export type StoryAction = "ingestion_review" | "test_review" | "specs_generated" | "spec_review" | "executed" | "blocked" | "waiting";
export type StoryAdvanceResult = { storyId: string; adoId: number; action: StoryAction; runId?: string; failures?: number };

export class StoryPipeline {
  constructor(
    private graph: GraphStore,
    private model: () => ModelClient,
    private workItems: SprintWorkItemClient,
  ) {}

  async pollSprint(iterationPath: string): Promise<Array<{ storyId: string; adoId: number; revision: number }>> {
    await this.graph.setup();
    const stories = await this.workItems.sprintStories(iterationPath);
    const eligible: Array<{ storyId: string; adoId: number; revision: number }> = [];
    for (const story of stories) {
      const revision = story.revision ?? 0;
      let record = await this.graph.storyPipeline(story.adoId);
      const hierarchyChanged = record && JSON.stringify(record.story.parents ?? []) !== JSON.stringify(story.parents ?? []);
      if (!record || record.revision !== revision || hierarchyChanged) {
        record = {
          adoId: story.adoId,
          revision,
          iterationPath,
          story,
          stage: "discovered",
          status: "active",
          updatedAt: new Date().toISOString(),
        };
        await this.graph.saveStoryPipeline(record);
      }
      if (record.status !== "passed" && record.status !== "failed") eligible.push({ storyId: story.id, adoId: story.adoId, revision });
    }
    return eligible;
  }

  async advanceStory(adoId: number, targetFile?: string, workflowUrl?: string): Promise<StoryAdvanceResult> {
    const record = await this.requiredRecord(adoId);
    if (record.run) await saveRun(record.run);

    if (record.stage === "discovered") {
      const run = await ingestStory(record.story, this.graph, this.model(), this.workItems);
      await this.update(record, run.status, run.status === "mapping_error" ? "blocked" : "active", run);
      if (run.status === "mapping_error") return this.result(record, "blocked");
      if (run.status === "review_relations") return this.result(record, "ingestion_review");
    }

    const run = record.run;
    if (!run) throw new Error(`Story ${adoId} has no persisted run`);

    if (run.status === "review_relations") {
      const review = await applyReviews(run, this.workItems, this.graph);
      await this.update(record, run.status, "active", run);
      if (review.pending || review.conflicts) return this.result(record, "waiting");
    }

    if (run.status === "ready_design") {
      await design(run, this.graph, this.model());
      await stageArtifactReviews(run, this.workItems);
      await this.update(record, run.status, "active", run);
      return this.result(record, "test_review");
    }

    if (run.status === "review_artifacts") {
      const review = await applyArtifactReviews(run, this.workItems);
      if (review.rejected) {
        await this.update(record, run.status, "blocked", run);
        return this.result(record, "blocked");
      }
      if (review.pending) {
        await this.update(record, run.status, "active", run);
        return this.result(record, "waiting");
      }
      await ingestDesign(run, this.graph);
    }

    if (run.status === "ready_specs") {
      if (!targetFile) throw new Error("Target configuration is required for spec generation");
      await generateSpecs(run, await loadTarget(targetFile));
      await this.update(record, run.status, "active", run);
      return this.result(record, "specs_generated");
    }

    if (run.status === "review_specs") {
      const pullRequest = record.pullRequest;
      if (!pullRequest) return this.result(record, "spec_review");
      const token = process.env.GITHUB_TOKEN;
      if (!token) throw new Error("GITHUB_TOKEN is required");
      const currentSha = await pullRequestHead(pullRequest.owner, pullRequest.repo, pullRequest.number, token);
      if (currentSha !== pullRequest.sha) {
        pullRequest.sha = currentSha;
        record.updatedAt = new Date().toISOString();
        await this.graph.saveStoryPipeline(record);
        return this.result(record, "spec_review");
      }
      if (!await specsApproved(run, pullRequest.owner, pullRequest.repo, pullRequest.number, pullRequest.sha, token)) return this.result(record, "waiting");
      if (!targetFile) throw new Error("Target configuration is required for execution");
      const execution = await executeApproved(run, this.graph, await loadTarget(targetFile), pullRequest.owner, pullRequest.repo, pullRequest.number, pullRequest.sha);
      record.result = { ...execution, ...(workflowUrl ? { workflowUrl } : {}) };
      await this.workItems.publishResult(record.story, execution, workflowUrl);
      await this.update(record, run.status, execution.failures ? "failed" : "passed", run);
      return { ...this.result(record, "executed"), failures: execution.failures };
    }

    if (run.status === "mapping_error") {
      await this.update(record, run.status, "blocked", run);
      return this.result(record, "blocked");
    }
    return this.result(record, "waiting");
  }

  async recordSpecPullRequest(adoId: number, owner: string, repo: string, number: number, sha: string): Promise<void> {
    if (!/^[a-f0-9]{40}$/.test(sha) || !Number.isInteger(number) || number < 1) throw new Error("Invalid pull request or commit SHA");
    const record = await this.requiredRecord(adoId);
    if (record.stage !== "review_specs") throw new Error(`Story ${adoId} has no generated specs awaiting review`);
    record.pullRequest = { owner, repo, number, sha };
    record.updatedAt = new Date().toISOString();
    await this.graph.saveStoryPipeline(record);
  }

  private async requiredRecord(adoId: number): Promise<StoryPipelineRecord> {
    const record = await this.graph.storyPipeline(adoId);
    if (!record) throw new Error(`Story pipeline ${adoId} was not discovered`);
    return record;
  }

  private async update(record: StoryPipelineRecord, stage: StoryPipelineRecord["stage"], status: StoryPipelineRecord["status"], run: NonNullable<StoryPipelineRecord["run"]>): Promise<void> {
    record.stage = stage;
    record.status = status;
    record.run = run;
    record.updatedAt = new Date().toISOString();
    await this.graph.saveStoryPipeline(record);
  }

  private result(record: StoryPipelineRecord, action: StoryAction): StoryAdvanceResult {
    return { storyId: record.story.id, adoId: record.adoId, action, ...(record.run ? { runId: record.run.id } : {}) };
  }
}
