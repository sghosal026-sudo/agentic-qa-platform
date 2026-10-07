import { diagnoseExecution, repairSpecs } from "./spec-generation/diagnosis.js";
import { loadTarget, design, generateSpecs, ingestDesign, ingestStory } from "./stages/workflow.js";
import { applyReviews } from "./stages/review.js";
import { recommendPending } from "./stages/reviewer.js";
import { applyArtifactReviews, stageArtifactReviews } from "./stages/artifact-review.js";
import { executeApproved, pullRequestHead, specsApproved } from "./stages/execution.js";
import { hash, newRun, saveRun, type StoryPipelineRecord } from "./core/runtime.js";
import type { GraphStore, ModelClient, SprintWorkItemClient } from "./contracts.js";
import type { DocumentStore } from "./stages/workflow.js";
import { observe, withTrace } from "./observability/tracing.js";
import { applyStoryTestReview, createTestReview, stageStoryTestReview } from "./stages/story-test-review.js";
import { assessTestImpact } from "./stages/test-impact.js";

export type StoryAction = "ingestion_review" | "test_review" | "specs_generated" | "spec_review" | "executed" | "blocked" | "waiting";
export type StoryAdvanceResult = { storyId: string; adoId: number; action: StoryAction; runId?: string; batch?: number; failures?: number; gaps?: string[] };
const STORY_PIPELINE_VERSION = 4;

export class StoryPipeline {
  constructor(
    private graph: GraphStore,
    private model: () => ModelClient,
    private workItems: SprintWorkItemClient,
    private reviewerModel?: () => ModelClient,
    private documents?: DocumentStore,
    private authorModel?: () => ModelClient,
    private specModel?: () => ModelClient,
    private diagnosisModel?: () => ModelClient,
    private repairModel?: () => ModelClient,
  ) {}

  async pollSprint(iterationPath: string): Promise<Array<{ storyId: string; adoId: number; revision: number }>> {
    await this.graph.setup();
    const stories = await this.workItems.sprintStories(iterationPath);
    const eligible: Array<{ storyId: string; adoId: number; revision: number }> = [];
    for (const story of stories) {
      await this.writeStoryStructure(story);
      const revision = story.revision ?? 0;
      let record = await this.graph.storyPipeline(story.adoId);
      const storyChanged = record && this.storyContent(record.story) !== this.storyContent(story);
      if (!record || storyChanged) {
        const previousRunId = storyChanged ? record?.run?.id : undefined;
        const previousStory = storyChanged ? record?.story : undefined;
        record = {
          version: STORY_PIPELINE_VERSION,
          adoId: story.adoId,
          revision,
          iterationPath,
          story,
          stage: "discovered",
          status: "active",
          updatedAt: new Date().toISOString(),
          reviewMode: "story",
          ...(previousRunId ? { previousRunId } : {}),
          ...(previousStory ? { previousStory } : {}),
          ...(record?.pendingImpacts?.length ? { pendingImpacts: record.pendingImpacts } : {}),
          ...(record?.pendingImpact ? { pendingImpact: record.pendingImpact } : {}),
        };
        await this.graph.saveStoryPipeline(record);
      } else if (record.revision !== revision || record.version !== STORY_PIPELINE_VERSION) {
        record.version = STORY_PIPELINE_VERSION;
        record.revision = revision;
        record.story = story;
        record.updatedAt = new Date().toISOString();
        await this.graph.saveStoryPipeline(record);
      }
      if (record.status !== "passed" && record.status !== "failed") eligible.push({ storyId: story.id, adoId: story.adoId, revision });
    }
    for (const impact of await this.graph.pendingImpactStories?.() ?? []) {
      if (!eligible.some((story) => story.adoId === impact.adoId)) eligible.push(impact);
    }
    return eligible;
  }

  private storyContent(story: StoryPipelineRecord["story"]): string {
    const { revision: _revision, ...content } = story;
    return JSON.stringify(content);
  }

  private async writeStoryStructure(story: StoryPipelineRecord["story"]): Promise<void> {
    await this.graph.node(story.id, "Story", story.title, story);
    let child = { id: story.id, adoId: story.adoId, title: story.title };
    for (const parent of story.parents ?? []) {
      await this.graph.node(parent.id, parent.kind, parent.title, parent);
      await this.graph.hierarchy(parent.id, child.id, child);
      child = { id: parent.id, adoId: parent.adoId, title: parent.title };
    }
    await this.graph.plannedFor(story.id, story.iterationPath, { adoId: story.adoId, title: story.title });
  }

  async advanceStory(adoId: number, targetFile?: string, workflowUrl?: string): Promise<StoryAdvanceResult> {
    return withTrace("advance-story", { adoId: String(adoId) }, async (root) => {
      const result = await this.advanceStoryInner(adoId, targetFile, workflowUrl);
      root.update({ output: result, ...(result.action === "blocked" ? { level: "WARNING" as const,
        statusMessage: `Story ${adoId} is blocked` } : {}) });
      return result;
    });
  }

  private async advanceStoryInner(adoId: number, targetFile?: string, workflowUrl?: string): Promise<StoryAdvanceResult> {
    const record = await this.requiredRecord(adoId);
    if (record.run) await saveRun(record.run);
    if ((record.pendingImpacts?.length || record.pendingImpact) && (record.status === "passed" || record.status === "failed" || record.status === "blocked" || !record.run)) {
      return this.startPendingImpact(record);
    }

    if (record.stage === "discovered") {
      if (record.previousStory) {
        const previous = [record.previousStory, ...(record.previousStory.parents ?? [])];
        const current = new Map([record.story, ...(record.story.parents ?? [])].map((source) => [source.adoId, source.text]));
        const changed = previous.filter((source) => current.get(source.adoId) !== source.text);
        for (const source of changed) await this.graph.archiveSourceRevision?.(source);
        await this.graph.pruneChangedSources?.(changed.map((source) => String(source.adoId)));
      }
      const run = await observe("ingest-story", { adoId, storyId: record.story.id },
        () => ingestStory(record.story, this.graph, this.model(), this.workItems, this.documents),
        (value) => ({ runId: value.id, status: value.status, relationships: value.relations.length, errors: value.errors }));
      if (run.status === "review_relations") await this.recommend(run);
      await this.update(record, run.status, run.status === "mapping_error" ? "blocked" : "active", run);
      if (run.status === "mapping_error") return this.result(record, "blocked");
      if (run.status === "review_relations") return this.result(record, "ingestion_review");
    }

    const run = record.run;
    if (!run) throw new Error(`Story ${adoId} has no persisted run`);

    if (run.status === "review_relations") {
      let review;
      try {
        review = await observe("review-relationships", { runId: run.id },
          () => applyReviews(run, this.workItems, this.graph), (value) => value);
      } finally {
        await this.update(record, run.status, "active", run);
      }
      if (review.pending || review.conflicts) {
        await this.recommend(run);
        await this.update(record, run.status, "active", run);
        return this.result(record, "waiting");
      }
    }

    if (run.status === "ready_design" && record.previousStory && !record.impactSourceHash) {
      await this.reconcileChangedStory(record);
    }

    if (run.status === "ready_design") {
      if (record.reviewMode === "story") run.testReview ??= { items: [],
        sourceHash: record.impactSourceHash ?? hash([record.story.text, ...(record.story.parents ?? []).map((parent) => parent.text)]) };
      const designStatus = await observe("author-tests", { runId: run.id, storyId: record.story.id, attempt: (run.designAttempt ?? 0) + 1 },
        () => design(run, this.graph, this.authorModel?.() ?? this.model(), this.documents),
        (status) => ({ status, cases: run.artifacts.filter((item) => item.kind === "TestCase").length,
          gaps: run.testDesign?.gaps.length ?? 0, failedBatches: run.testDesign?.failedBatches.length ?? 0 }));
      if (designStatus === "design_gap") {
        await this.update(record, run.status, "blocked", run);
        return this.result(record, "blocked");
      }
      if (run.testReview) {
        for (const revision of record.impactRevisions ?? []) {
          run.artifacts = run.artifacts.filter((artifact) => artifact.id !== revision.artifact.id);
          run.artifacts.push(revision.artifact);
        }
        createTestReview(run, run.testReview.sourceHash, record.impactRevisions, record.impactGaps);
        await stageStoryTestReview(run, this.workItems);
        await this.update(record, run.status, "active", run);
        return this.result(record, "test_review");
      }
      await observe("stage-test-reviews", { runId: run.id, artifacts: run.artifacts.length },
        () => stageArtifactReviews(run, this.workItems), () => ({ reviewTasks: run.artifacts.filter((item) => item.reviewTask).length }));
      await this.update(record, run.status, "active", run);
      return this.result(record, "test_review");
    }

    if (run.status === "design_gap") return this.result(record, "blocked");

    if (run.status === "review_artifacts") {
      if (run.testReview) {
        await stageStoryTestReview(run, this.workItems);
        const result = await applyStoryTestReview(run, this.workItems, this.graph, this.authorModel?.() ?? this.model());
        await stageStoryTestReview(run, this.workItems);
        const batched = new Set((run.specBatches ?? []).flatMap((batch) => batch.caseIds));
        const ready = run.artifacts.filter((item) => item.kind === "TestCase" && item.approvedAt && !batched.has(item.id)).map((item) => item.id);
        if (ready.length) {
          if (!targetFile) throw new Error("Target configuration is required for spec generation");
          run.status = "ready_specs";
          await generateSpecs(run, await loadTarget(targetFile), ready, (this.specModel ?? this.model)(), this.graph);
          await this.update(record, run.status, "active", run);
          return this.result(record, "specs_generated");
        }
        const failed = run.specBatches?.some((batch) => batch.failures) ?? false;
        await this.update(record, run.status, result.pending ? "active" : result.manualFix || result.rejected ? "blocked" : failed ? "failed" : "passed", run);
        return this.result(record, result.pending ? "waiting" : result.manualFix || result.rejected ? "blocked" : "waiting");
      }
      let review;
      try {
        review = await observe("review-test-artifacts", { runId: run.id },
          () => applyArtifactReviews(run, this.workItems), (value) => value);
      } finally {
        await this.update(record, run.status, "active", run);
      }
      if (review.rejected) {
        await this.update(record, run.status, "blocked", run);
        return this.result(record, "blocked");
      }
      if (review.pending) {
        await this.update(record, run.status, "active", run);
        return this.result(record, "waiting");
      }
      await observe("ingest-approved-design", { runId: run.id }, () => ingestDesign(run, this.graph),
        (status) => ({ status }));
    }

    if (run.status === "ready_specs") {
      if (!targetFile) throw new Error("Target configuration is required for spec generation");
      await observe("generate-specs", { runId: run.id }, async () => generateSpecs(run, await loadTarget(targetFile), undefined, (this.specModel ?? this.model)(), this.graph),
        (status) => ({ status, specs: run.specs.length }));
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
        const batch = run.specBatches?.at(-1);
        if (batch) batch.sha = currentSha;
        record.updatedAt = new Date().toISOString();
        await this.graph.saveStoryPipeline(record);
        return this.result(record, "spec_review");
      }
      if (!await specsApproved(run, pullRequest.owner, pullRequest.repo, pullRequest.number, pullRequest.sha, token)) return this.result(record, "waiting");
      if (!targetFile) throw new Error("Target configuration is required for execution");
      const execution = await observe("execute-specs", { runId: run.id, pullRequest: pullRequest.number },
        async () => executeApproved(run, this.graph, await loadTarget(targetFile), pullRequest.owner, pullRequest.repo, pullRequest.number, pullRequest.sha),
        (value) => ({ tests: value.tests, failures: value.failures }));
      record.result = { ...execution, ...(workflowUrl ? { workflowUrl } : {}) };
      const currentBatch = run.specBatches?.at(-1);
      if (currentBatch) {
        currentBatch.executionId = execution.executionId;
        currentBatch.failures = execution.failures;
      }
      await this.workItems.publishResult(record.story, execution, workflowUrl);
      if (execution.failures && currentBatch?.manifest) {
        try {
          await diagnoseExecution(run, execution.executionId, (this.diagnosisModel ?? this.model)());
          if (await repairSpecs(run, execution.executionId, (this.repairModel ?? this.model)(), this.graph, true)) {
            delete record.pullRequest;
            await this.update(record, run.status, "active", run);
            return this.result(record, "specs_generated");
          }
        } catch (error) {
          (run.warnings ??= []).push(`Diagnosis/repair failed; original result preserved: ${String(error)}`);
        }
      }

      if (run.testReview) {
        run.status = "review_artifacts";
        await this.update(record, run.status, "active", run);
        return { ...this.result(record, "executed"), failures: execution.failures };
      }
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
    const batch = record.run?.specBatches?.at(-1);
    if (batch) batch.sha = sha;
    record.updatedAt = new Date().toISOString();
    await this.graph.saveStoryPipeline(record);
  }

  private async reconcileChangedStory(record: StoryPipelineRecord): Promise<void> {
    if (!record.previousStory) return;
    const previous = new Map([record.previousStory, ...(record.previousStory.parents ?? [])].map((source) => [source.adoId, source.text]));
    const changedSources = [record.story, ...(record.story.parents ?? [])]
      .filter((source) => previous.get(source.adoId) !== source.text)
      .map((source) => ({ adoId: source.adoId, text: source.text }));
    const sourceHash = hash(changedSources);
    const impact = await assessTestImpact(record.story, record.previousStory, this.graph, this.authorModel?.() ?? this.model());
    record.impactRevisions = impact.revisions.filter((item) => item.artifact.storyId === record.story.id);
    record.impactGaps = impact.gaps.filter((item) => item.storyId === record.story.id);
    const ownerIds = new Set([
      ...impact.revisions.map((item) => item.artifact.storyId), ...impact.gaps.map((item) => item.storyId),
    ]);
    for (const storyId of ownerIds) {
      if (storyId === record.story.id) continue;
      const savedStory = await this.graph.graphStory?.(storyId);
      if (!savedStory) {
        record.impactGaps.push({ id: `Gap:${hash(`owner|${storyId}`).slice(0, 16)}`, name: storyId,
          confidence: 1, reason: `Affected test owner ${storyId} is unavailable`, evidence: "" });
        continue;
      }
      const owner = this.workItems.storyById ? await this.workItems.storyById(savedStory.adoId) : savedStory;
      const dependent = await this.graph.storyPipeline(owner.adoId) ?? {
        version: STORY_PIPELINE_VERSION, adoId: owner.adoId, revision: owner.revision ?? 0,
        iterationPath: owner.iterationPath, story: owner, stage: "discovered" as const, status: "active" as const,
        updatedAt: new Date().toISOString(), reviewMode: "story" as const,
      };
      const queued = {
        sourceHash,
        revisions: impact.revisions.filter((item) => item.artifact.storyId === storyId),
        gaps: impact.gaps.filter((item) => item.storyId === storyId),
      };
      dependent.pendingImpacts ??= [];
      if (!dependent.pendingImpacts.some((item) => item.sourceHash === sourceHash)) dependent.pendingImpacts.push(queued);
      dependent.impactSourceHash = sourceHash;
      dependent.updatedAt = new Date().toISOString();
      await this.graph.saveStoryPipeline(dependent);
    }
    record.impactSourceHash = sourceHash;
    record.updatedAt = new Date().toISOString();
    await this.graph.saveStoryPipeline(record);
  }

  private async startPendingImpact(record: StoryPipelineRecord): Promise<StoryAdvanceResult> {
    const impact = record.pendingImpact ?? record.pendingImpacts?.shift();
    if (!impact) throw new Error("No pending impact run");
    const run = await newRun();
    run.stories = [record.story];
    run.artifacts = impact.revisions.map((item) => item.artifact);
    run.status = "review_artifacts";
    createTestReview(run, impact.sourceHash, impact.revisions, impact.gaps);
    await stageStoryTestReview(run, this.workItems);
    record.previousRunId = record.run?.id;
    record.pendingImpact = undefined;
    await this.update(record, run.status, "active", run);
    return this.result(record, "test_review");
  }

  async retryDesign(adoId: number): Promise<void> {
    const record = await this.requiredRecord(adoId);
    if (record.stage !== "design_gap" || !record.run || record.run.status !== "design_gap") {
      throw new Error(`Story ${adoId} has no blocked test design`);
    }
    record.run.status = "ready_design";
    record.run.artifacts = [];
    record.run.testDesign = undefined;
    await saveRun(record.run);
    await this.update(record, "ready_design", "active", record.run);
  }

  async retryMapping(adoId: number): Promise<string> {
    const record = await this.requiredRecord(adoId);
    if (record.stage !== "mapping_error" || !record.run || record.run.status !== "mapping_error") {
      throw new Error(`Story ${adoId} has no blocked graph mapping`);
    }
    const previousRunId = record.run.id;
    record.run = undefined;
    record.stage = "discovered";
    record.status = "active";
    record.updatedAt = new Date().toISOString();
    await this.graph.saveStoryPipeline(record);
    return previousRunId;
  }

  private async requiredRecord(adoId: number): Promise<StoryPipelineRecord> {
    const record = await this.graph.storyPipeline(adoId);
    if (!record) throw new Error(`Story pipeline ${adoId} was not discovered`);
    return record;
  }

  private async recommend(run: NonNullable<StoryPipelineRecord["run"]>): Promise<void> {
    if (!this.reviewerModel) return;
    try {
      await recommendPending(run, this.reviewerModel(), this.workItems, process.env.REVIEWER_OPENROUTER_MODEL ?? "qwen/qwen3.8-flash");
    } catch (error) {
      const warning = `AI reviewer: ${error instanceof Error ? error.message : String(error)}`;
      if (!(run.warnings ?? []).includes(warning)) (run.warnings ??= []).push(warning);
      await saveRun(run);
    }
  }

  private async update(record: StoryPipelineRecord, stage: StoryPipelineRecord["stage"], status: StoryPipelineRecord["status"], run: NonNullable<StoryPipelineRecord["run"]>): Promise<void> {
    record.stage = stage;
    record.status = status;
    record.run = run;
    record.updatedAt = new Date().toISOString();
    await this.graph.saveStoryPipeline(record);
  }

  private result(record: StoryPipelineRecord, action: StoryAction): StoryAdvanceResult {
    return { storyId: record.story.id, adoId: record.adoId, action, ...(record.run ? { runId: record.run.id } : {}),
      ...(action === "specs_generated" && record.run?.specBatches ? { batch: record.run.specBatches.length } : {}),
      ...(record.run?.status === "design_gap" ? { gaps: [...(record.run.testDesign?.gaps ?? []), ...(record.run.testDesign?.failedBatches ?? [])] } : {}) };
  }
}
