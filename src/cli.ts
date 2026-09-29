import "dotenv/config";
import { Command } from "commander";
import { createDefaultPipeline } from "./pipeline.js";

const cli = new Command();
const pipeline = createDefaultPipeline();
cli.name("qa").description("CI/CD framework for the agentic QA pipeline");

cli.command("ingest").argument("<directory>").action(async (directory: string) => {
  const run = await pipeline.ingest(directory);
  console.log(JSON.stringify({ runId: run.id, status: run.status, relationships: run.relations.length, warnings: run.warnings ?? [], errors: run.errors }, null, 2));
});

cli.command("review-relationships").requiredOption("--run <id>").action(async ({ run: id }: { run: string }) => {
  const { result, run } = await pipeline.reviewRelationships(id);
  console.log(JSON.stringify({ ...result, status: run.status }, null, 2));
  if (result.pending || result.conflicts) process.exitCode = 2;
});

cli.command("design").requiredOption("--run <id>").action(async ({ run: id }: { run: string }) => {
  const run = await pipeline.design(id);
  console.log(JSON.stringify({ runId: run.id, status: run.status, artifacts: run.artifacts.map((item) => ({ id: item.id, kind: item.kind, storyId: item.storyId })) }, null, 2));
});

cli.command("approve-artifact").requiredOption("--run <id>").requiredOption("--id <artifact-id>").requiredOption("--reviewer <name>").action(async ({ run: id, id: artifactId, reviewer }: { run: string; id: string; reviewer: string }) => {
  await pipeline.approveArtifact(id, artifactId, reviewer);
  console.log(`Approved ${artifactId}`);
});

cli.command("ingest-design").requiredOption("--run <id>").action(async ({ run: id }: { run: string }) => {
  const run = await pipeline.ingestDesign(id);
  console.log(JSON.stringify({ runId: run.id, status: run.status, artifacts: run.artifacts.length }, null, 2));
});

cli.command("generate").requiredOption("--run <id>").requiredOption("--target <file>").action(async ({ run: id, target: targetFile }: { run: string; target: string }) => {
  const run = await pipeline.generate(id, targetFile);
  console.log(JSON.stringify({ runId: run.id, status: run.status, specs: run.specs }, null, 2));
});

cli.command("execute-approved").requiredOption("--run <id>").requiredOption("--target <file>").requiredOption("--owner <owner>").requiredOption("--repo <repo>").requiredOption("--pr <number>").requiredOption("--sha <commit>")
  .action(async (options: { run: string; target: string; owner: string; repo: string; pr: string; sha: string }) => {
    const result = await pipeline.executeApproved(options.run, options.target, options.owner, options.repo, Number(options.pr), options.sha);
    console.log(JSON.stringify(result, null, 2));
    if (result.failures) process.exitCode = 1;
  });

cli.command("status").requiredOption("--run <id>").action(async ({ run: id }: { run: string }) => {
  console.log(JSON.stringify(await pipeline.status(id), null, 2));
});

cli.command("poll-sprint").requiredOption("--iteration <path>").action(async ({ iteration }: { iteration: string }) => {
  const stories = await pipeline.pollSprint(iteration);
  console.log(JSON.stringify({ iteration, stories }, null, 2));
});

cli.command("reset").requiredOption("--all", "Delete the full Neo4j graph and pipeline ADO review Tasks")
  .action(async () => {
    console.log(JSON.stringify(await pipeline.resetAll(), null, 2));
  });

cli.command("advance-story").requiredOption("--ado-id <id>").option("--target <file>").option("--workflow-url <url>")
  .action(async ({ adoId, target, workflowUrl }: { adoId: string; target?: string; workflowUrl?: string }) => {
    const id = Number(adoId);
    if (!Number.isInteger(id) || id < 1) throw new Error("Invalid ADO Story ID");
    const result = await pipeline.advanceStory(id, target, workflowUrl);
    console.log(JSON.stringify(result, null, 2));
    if (result.failures) process.exitCode = 1;
  });

cli.command("record-spec-pr").requiredOption("--ado-id <id>").requiredOption("--owner <owner>").requiredOption("--repo <repo>").requiredOption("--pr <number>").requiredOption("--sha <commit>")
  .action(async ({ adoId, owner, repo, pr, sha }: { adoId: string; owner: string; repo: string; pr: string; sha: string }) => {
    const id = Number(adoId);
    const number = Number(pr);
    if (!Number.isInteger(id) || id < 1) throw new Error("Invalid ADO Story ID");
    await pipeline.recordSpecPullRequest(id, owner, repo, number, sha);
    console.log(JSON.stringify({ adoId: id, pullRequest: number, sha }, null, 2));
  });

cli.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
