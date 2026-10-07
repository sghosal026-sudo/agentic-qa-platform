import { planSpecs, renderBatch, readBatch, batchFile } from "./spec-generation/stages.js";
import { diagnoseExecution, repairSpecs } from "./spec-generation/diagnosis.js";
import { saveRun } from "./core/runtime.js";
import { Ado } from "./adapters/ado.js";
import { Graph } from "./adapters/graph.js";
import { Model } from "./adapters/model.js";
import { PostgresDocuments } from "./adapters/postgres.js";
import { loadRun, type Run } from "./core/runtime.js";
import type { ExecutionResult, GraphStore, ModelClient, ReviewResult, RunSummary, SprintWorkItemClient, WorkItemClient } from "./contracts.js";
import { StoryPipeline, type StoryAdvanceResult } from "./story-pipeline.js";
import { executeApproved } from "./stages/execution.js";
import { applyReviews, stageReviews } from "./stages/review.js";
import { approveArtifact, design, generateSpecs, ingest, ingestDesign, loadTarget, type DocumentStore, type Target } from "./stages/workflow.js";
import { withTrace } from "./observability/tracing.js";

export type PipelineDependencies = {
  graph: () => GraphStore;
  model: () => ModelClient;
  reviewerModel?: () => ModelClient;
  specModel?: () => ModelClient;
  diagnosisModel?: () => ModelClient;
  repairModel?: () => ModelClient;
  authorModel?: () => ModelClient;
  workItems: () => WorkItemClient;
  sprintWorkItems?: () => SprintWorkItemClient;
  documents?: () => DocumentStore;
};

export class QaPipeline {
  constructor(private dependencies: PipelineDependencies) {}

  private async withGraph<T>(work: (graph: GraphStore) => Promise<T>): Promise<T> {
    const graph = this.dependencies.graph();
    try {
      return await work(graph);
    } finally {
      await graph.close?.();
    }
  }

  private async withDocuments<T>(work: (documents?: DocumentStore) => Promise<T>): Promise<T> {
    const documents = this.dependencies.documents?.();
    try { return await work(documents); }
    finally { await documents?.close(); }
  }

  async ingest(directory: string): Promise<Run> {
    return withTrace("ingest-directory", {}, async (trace) => {
      const run = await this.withDocuments((documents) => this.withGraph((graph) => ingest(directory, graph, this.dependencies.model(), this.dependencies.workItems(), documents)));
      trace.update({ output: { runId: run.id, status: run.status, relationships: run.relations.length, errors: run.errors } });
      return run;
    });
  }

  async reviewRelationships(runId: string): Promise<{ result: ReviewResult; run: Run }> {
    const run = await loadRun(runId);
    const workItems = this.dependencies.workItems();
    if (run.status === "review_relations") await stageReviews(run, workItems);
    const result = await this.withGraph((graph) => applyReviews(run, workItems, graph));
    return { result, run };
  }

  async design(runId: string): Promise<Run> {
    return withTrace("author-tests", { runId }, async (trace) => {
      const run = await loadRun(runId);
      await this.withDocuments((documents) => this.withGraph((graph) => design(run, graph, this.dependencies.authorModel?.() ?? this.dependencies.model(), documents)));
      trace.update({ output: { status: run.status, artifacts: run.artifacts.length,
        gaps: run.testDesign?.gaps.length ?? 0, failedBatches: run.testDesign?.failedBatches.length ?? 0 } });
      return run;
    });
  }

  async approveArtifact(runId: string, artifactId: string, reviewer: string): Promise<void> {
    await approveArtifact(await loadRun(runId), artifactId, reviewer);
  }

  async ingestDesign(runId: string): Promise<Run> {
    const run = await loadRun(runId);
    await this.withGraph((graph) => ingestDesign(run, graph));
    return run;
  }

  async generate(runId: string, targetFile: string): Promise<Run> {
    const run = await loadRun(runId);
    const awaitTarget = await loadTarget(targetFile);
    await this.withGraph(graph => generateSpecs(run, awaitTarget, undefined, this.dependencies.specModel?.() ?? this.dependencies.model(), graph));
    return run;
  }

  async executeApproved(runId: string, targetFile: string, owner: string, repo: string, pullRequest: number, sha: string): Promise<ExecutionResult> {
    const run = await loadRun(runId);
    const target: Target = await loadTarget(targetFile);
    return await this.withGraph((graph) => executeApproved(run, graph, target, owner, repo, pullRequest, sha));
  }

  async storyStatus(adoId: number): Promise<unknown> {
    return this.withGraph(async graph => {
      const record = await graph.storyPipeline(adoId);
      if (!record?.run) throw new Error("Story has no pipeline run");
      await saveRun(record.run);
      const batch = record.run.specBatches?.at(-1);
      return { storyId: record.story.id, adoId, runId: record.run.id, status: record.run.status, batch: record.run.specBatches?.length ?? 0, executionId: batch?.executionId };
    });
  }

  private async persistRun(run: Run): Promise<void> {
    await this.withGraph(async graph => {
      const record = await graph.storyPipeline(run.stories[0].adoId);
      if (!record || record.run?.id !== run.id) return;
      if (record.run.specBatches?.length !== run.specBatches?.length) delete record.pullRequest;
      record.run = run; record.stage = run.status; record.status = "active";
      await graph.saveStoryPipeline(record);
    });
  }

  async planSpecs(runId: string, targetFile: string): Promise<string> {
    const run = await loadRun(runId);
    const target = await loadTarget(targetFile);
    await this.withGraph(graph => planSpecs(run, target, (this.dependencies.specModel ?? this.dependencies.model)(), graph));
    return batchFile(run.id, (run.specBatches?.length ?? 0) + 1);
  }

  async renderSpecs(runId: string, number: number): Promise<void> {
    const run = await loadRun(runId);
    await renderBatch(run, await readBatch(run, number), number);
    await this.persistRun(run);
  }

  async diagnose(runId: string, executionId: string): Promise<unknown> {
    const run = await loadRun(runId);
    const result = await diagnoseExecution(run, executionId, (this.dependencies.diagnosisModel ?? this.dependencies.model)());
    await this.persistRun(run);
    return result;
  }

  async repair(runId: string, executionId: string): Promise<boolean> {
    const run = await loadRun(runId);
    const result = await this.withGraph(graph => repairSpecs(run, executionId, (this.dependencies.repairModel ?? this.dependencies.model)(), graph));
    await this.persistRun(run);
    return result;
  }

  async repairStory(adoId: number): Promise<StoryAdvanceResult> {
    return this.withGraph(async graph => {
      const record = await graph.storyPipeline(adoId);
      const run = record?.run;
      const executionId = run?.specBatches?.at(-1)?.executionId;
      if (!record || !run || !executionId) throw new Error("Story has no executed batch to repair");
      await saveRun(run);
      // Rehydrate portable observation files from the saved run evidence.
      const repaired = await repairSpecs(run, executionId, (this.dependencies.repairModel ?? this.dependencies.model)(), graph);
      if (repaired) { delete record.pullRequest; record.stage = run.status; record.status = "active"; await graph.saveStoryPipeline(record); }
      return { storyId: record.story.id, adoId, runId: run.id, action: repaired ? "specs_generated" : "waiting", batch: run.specBatches?.length };
    });
  }

  async status(runId: string): Promise<RunSummary> {
    const run = await loadRun(runId);
    return {
      runId: run.id,
      status: run.status,
      stories: run.stories.length,
      relationships: run.relations.length,
      artifacts: run.artifacts.length,
      specs: run.specs.length,
      warnings: run.warnings ?? [],
      errors: run.errors,
      testDesign: run.testDesign,
    };
  }

  async pollSprint(iterationPath: string): Promise<Array<{ storyId: string; adoId: number; revision: number }>> {
    return withTrace("poll-sprint", { iterationPath }, async (trace) => {
      const stories = await this.withGraph((graph) => new StoryPipeline(graph, this.dependencies.model, this.sprintWorkItems()).pollSprint(iterationPath));
      trace.update({ output: { stories: stories.length, adoIds: stories.map((story) => story.adoId) } });
      return stories;
    });
  }

  async resetAll(): Promise<{ deletedTasks: number; deletedGraphNodes: number }> {
    const workItems = this.sprintWorkItems();
    return await this.withGraph(async (graph) => {
      await graph.setup();
      const deletedTasks = await workItems.resetReviewTasks();
      const deletedGraphNodes = await graph.deleteAll();
      return { deletedTasks, deletedGraphNodes };
    });
  }

  async advanceStory(adoId: number, targetFile?: string, workflowUrl?: string): Promise<StoryAdvanceResult> {
    return await this.withDocuments((documents) => this.withGraph((graph) => new StoryPipeline(graph, this.dependencies.model, this.sprintWorkItems(), this.dependencies.reviewerModel, documents, this.dependencies.authorModel, this.dependencies.specModel, this.dependencies.diagnosisModel, this.dependencies.repairModel).advanceStory(adoId, targetFile, workflowUrl)));
  }

  async retryDesign(adoId: number): Promise<void> {
    await this.withGraph((graph) => new StoryPipeline(graph, this.dependencies.model, this.sprintWorkItems()).retryDesign(adoId));
  }

  async retryMapping(adoId: number): Promise<string> {
    return await this.withGraph((graph) => new StoryPipeline(graph, this.dependencies.model, this.sprintWorkItems()).retryMapping(adoId));
  }

  async recordSpecPullRequest(adoId: number, owner: string, repo: string, number: number, sha: string): Promise<void> {
    await this.withGraph((graph) => new StoryPipeline(graph, this.dependencies.model, this.sprintWorkItems()).recordSpecPullRequest(adoId, owner, repo, number, sha));
  }

  private sprintWorkItems(): SprintWorkItemClient {
    if (!this.dependencies.sprintWorkItems) throw new Error("Sprint work-item integration is unavailable");
    return this.dependencies.sprintWorkItems();
  }
}

export function createDefaultPipeline(): QaPipeline {
  return new QaPipeline({
    graph: () => new Graph(),
    model: () => new Model(),
    reviewerModel: () => new Model(process.env.REVIEWER_OPENROUTER_MODEL ?? "qwen/qwen3.8-flash", "You are an independent QA relationship reviewer. Return only JSON. Judge the proposal against the quoted source and ontology. Do not assume the extracting model is correct."),
    diagnosisModel: () => new Model(process.env.SPEC_DIAGNOSIS_MODEL ?? process.env.OPENROUTER_MODEL),
    repairModel: () => new Model(process.env.SPEC_REPAIR_MODEL ?? process.env.OPENROUTER_MODEL),
    specModel: () => new Model(process.env.SPEC_GENERATION_MODEL ?? process.env.OPENROUTER_MODEL),
    authorModel: () => new Model(process.env.TEST_DESIGN_MODEL ?? "openai/gpt-oss-120b", "You are a senior QA test author. Return only JSON. Use exact source and approved graph evidence. Reuse existing coverage, expose gaps, and never invent routes, fields, states, or outcomes."),
    workItems: () => new Ado(),
    sprintWorkItems: () => new Ado(),
    ...(process.env.POSTGRES_HOST ? { documents: () => new PostgresDocuments() } : {}),
  });
}
