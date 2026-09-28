import { Ado } from "./adapters/ado.js";
import { Graph } from "./adapters/graph.js";
import { Model } from "./adapters/model.js";
import { loadRun, type Run } from "./core/runtime.js";
import type { ExecutionResult, GraphStore, ModelClient, ReviewResult, RunSummary, SprintWorkItemClient, WorkItemClient } from "./contracts.js";
import { StoryPipeline, type StoryAdvanceResult } from "./story-pipeline.js";
import { executeApproved } from "./stages/execution.js";
import { applyReviews, stageReviews } from "./stages/review.js";
import { approveArtifact, design, generateSpecs, ingest, ingestDesign, loadTarget, type Target } from "./stages/workflow.js";

export type PipelineDependencies = {
  graph: () => GraphStore;
  model: () => ModelClient;
  workItems: () => WorkItemClient;
  sprintWorkItems?: () => SprintWorkItemClient;
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

  async ingest(directory: string): Promise<Run> {
    return await this.withGraph((graph) => ingest(directory, graph, this.dependencies.model(), this.dependencies.workItems()));
  }

  async reviewRelationships(runId: string): Promise<{ result: ReviewResult; run: Run }> {
    const run = await loadRun(runId);
    const workItems = this.dependencies.workItems();
    if (run.status === "review_relations") await stageReviews(run, workItems);
    const result = await this.withGraph((graph) => applyReviews(run, workItems, graph));
    return { result, run };
  }

  async design(runId: string): Promise<Run> {
    const run = await loadRun(runId);
    await this.withGraph((graph) => design(run, graph, this.dependencies.model()));
    return run;
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
    await generateSpecs(run, await loadTarget(targetFile));
    return run;
  }

  async executeApproved(runId: string, targetFile: string, owner: string, repo: string, pullRequest: number, sha: string): Promise<ExecutionResult> {
    const run = await loadRun(runId);
    const target: Target = await loadTarget(targetFile);
    return await this.withGraph((graph) => executeApproved(run, graph, target, owner, repo, pullRequest, sha));
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
    };
  }

  async pollSprint(iterationPath: string): Promise<Array<{ storyId: string; adoId: number; revision: number }>> {
    return await this.withGraph((graph) => new StoryPipeline(graph, this.dependencies.model, this.sprintWorkItems()).pollSprint(iterationPath));
  }

  async advanceStory(adoId: number, targetFile?: string, workflowUrl?: string): Promise<StoryAdvanceResult> {
    return await this.withGraph((graph) => new StoryPipeline(graph, this.dependencies.model, this.sprintWorkItems()).advanceStory(adoId, targetFile, workflowUrl));
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
    workItems: () => new Ado(),
    sprintWorkItems: () => new Ado(),
  });
}
