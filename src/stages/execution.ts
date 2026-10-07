import { readBatch, collectEvidence } from "../spec-generation/stages.js";
import { observationsFromAttachments, type ExecutionEvidence } from "../spec-generation/diagnosis.js";
import { atomicWriteJson } from "../spec-generation/output/atomicWrite.js";
import { hash } from "../core/runtime.js";
import { maskSensitiveText } from "../observability/masking.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runPath, saveRun, required, type Run } from "../core/runtime.js";
import type { ExecutionResult, GraphStore } from "../contracts.js";
import type { Target } from "./workflow.js";

type Pull = { head: { sha: string }; user: { login: string } };
type Review = { state: string; commit_id: string; user: { login: string } };
type Comment = { path: string; commit_id: string; body: string; user: { login: string } };

async function github<T>(owner: string, repo: string, pr: number, suffix: string, token: string, fetcher: typeof fetch): Promise<T> {
  const response = await fetcher(`https://api.github.com/repos/${owner}/${repo}/pulls/${pr}${suffix}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!response.ok) throw new Error(`GitHub review lookup failed: ${response.status}`);
  return await response.json() as T;
}

export async function pullRequestHead(owner: string, repo: string, pr: number, token: string, fetcher: typeof fetch = fetch): Promise<string> {
  if (!/^[a-z0-9_.-]+$/i.test(owner) || !/^[a-z0-9_.-]+$/i.test(repo) || !Number.isInteger(pr) || pr < 1) throw new Error("Invalid GitHub pull request");
  return (await github<Pull>(owner, repo, pr, "", token, fetcher)).head.sha;
}

export async function verifySpecs(run: Run, owner: string, repo: string, pr: number, sha: string, token: string, fetcher: typeof fetch = fetch): Promise<void> {
  if (!/^[a-f0-9]{40}$/.test(sha) || !/^[a-z0-9_.-]+$/i.test(owner) || !/^[a-z0-9_.-]+$/i.test(repo) || !Number.isInteger(pr) || pr < 1) throw new Error("Invalid GitHub PR or commit SHA");
  if (run.status !== "review_specs" || !run.specs.length) throw new Error("No generated specs await review");
  const pull = await github<Pull>(owner, repo, pr, "", token, fetcher);
  if (pull.head.sha !== sha) throw new Error("PR head changed after the requested commit SHA");
  const reviews = await github<Review[]>(owner, repo, pr, "/reviews?per_page=100", token, fetcher);
  const latest = new Map<string, Review>();
  for (const review of reviews) if (review.user.login !== pull.user.login) latest.set(review.user.login, review);
  if (![...latest.values()].some((review) => review.state === "APPROVED" && review.commit_id === sha)) throw new Error("No current PR approval at this SHA");
  if ([...latest.values()].some((review) => review.state === "CHANGES_REQUESTED")) throw new Error("Requested changes are unresolved");
  const comments = await github<Comment[]>(owner, repo, pr, "/comments?per_page=100", token, fetcher);
  for (const spec of run.specs) {
    if (!comments.some((comment) => comment.path === spec.file.replaceAll("\\", "/") && comment.commit_id === sha
      && /^Decision:\s*approve\s*$/im.test(comment.body) && latest.get(comment.user.login)?.state === "APPROVED")) {
      throw new Error(`Spec ${spec.file} has no individual approval at ${sha}`);
    }
  }
}

export async function specsApproved(run: Run, owner: string, repo: string, pr: number, sha: string, token: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    await verifySpecs(run, owner, repo, pr, sha, token, fetcher);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/No current PR approval|Requested changes are unresolved|has no individual approval/.test(message)) return false;
    throw error;
  }
}

async function command(program: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env, shell: process.platform === "win32" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function checkedCommand(program: string, args: string[], cwd: string): Promise<string> {
  const result = await command(program, args, cwd);
  if (result.code) throw new Error(`${program} failed: ${result.stderr.slice(0, 400)}`);
  return result.stdout.trim();
}

export function caseResults(report: unknown): Array<{ caseId: string; status: string; duration: number; errors: string[]; attachments: any[] }> {
  const output: Array<{ caseId: string; status: string; duration: number; errors: string[]; attachments: any[] }> = [];
  const walk = (suite: any): void => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const caseId = (test.annotations ?? spec.annotations ?? []).find((item: { type: string }) => item.type === "case")?.description;
        if (!caseId) continue;
        const last = test.results?.at(-1);
        output.push({ caseId, status: String(last?.status ?? test.status ?? "unknown"), duration: Number(last?.duration ?? 0), errors: (last?.errors ?? []).map((error: any) => maskSensitiveText(error.message ?? String(error))), attachments: last?.attachments ?? [] });
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of (report as { suites?: unknown[] }).suites ?? []) walk(suite);
  return output;
}

export async function executeApproved(run: Run, graph: GraphStore, target: Target, owner: string, repo: string, pr: number, sha: string): Promise<ExecutionResult> {
  if (!target.safeEnvironments.includes(target.baseUrl)) throw new Error("Target base URL is not approved for execution");
  await verifySpecs(run, owner, repo, pr, sha, required("GITHUB_TOKEN"));
  const project = path.resolve(target.projectDir);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "qa-approved-"));
  const checkout = path.join(temporary, "checkout");
  const executionId = randomUUID();
  const batchNumber = run.specBatches?.length ?? 0;
  const currentBatch = run.specBatches?.at(-1);
  const batch = currentBatch?.manifest ? await readBatch(run, batchNumber) : undefined;
  const observationDirectory = path.join(runPath(run.id), `observations-${executionId}`);
  const evidence: ExecutionEvidence = { executionId, sha, batch: batchNumber, cases: [], infrastructureErrors: [] };
  try {
    await checkedCommand("git", ["fetch", "origin", sha], project);
    await checkedCommand("git", ["worktree", "add", "--detach", checkout, sha], project);
    if (await checkedCommand("git", ["rev-parse", "HEAD"], checkout) !== sha) throw new Error("Checkout SHA differs from approved commit");
    if (batch) {
      for (const file of batch.files) {
        if (hash(await fs.readFile(path.join(checkout, file.file), "utf8")) !== file.hash) throw new Error(`Reviewed batch dependency changed: ${file.file}`);
      }
      const cases = await graph.managedTestCases?.();
      if (!cases) throw new Error("Execution requires graph case revision verification");
      for (const plan of batch.plans) if (cases.find(item => item.id === plan.snapshot.artifact.id)?.contentHash !== plan.snapshot.contentHash) throw new Error(`Stale graph case ${plan.snapshot.artifact.id}`);
      const fresh = await collectEvidence(batch.target);
      const signature = (catalogue: typeof fresh) => [...catalogue.api, ...catalogue.db, ...catalogue.ui, ...catalogue.auth].map(item => `${item.id}:${item.provenance.contentHash}`).sort();
      if (JSON.stringify(signature(fresh)) !== JSON.stringify(signature(batch.evidence))) throw new Error("Target evidence drifted after generation; generate a new reviewed batch");
    }
    for (const spec of run.specs) {
      const relative = path.normalize(spec.file);
      if (path.isAbsolute(relative) || relative.startsWith("..") || !relative.endsWith(".spec.ts")) throw new Error(`Invalid spec file: ${spec.file}`);
      const content = await fs.readFile(path.join(checkout, relative), "utf8");
      if (!content.includes(JSON.stringify(spec.caseId))) throw new Error(`Approved spec does not include ${spec.caseId}`);
      await graph.spec(spec, sha);
    }
    await checkedCommand(process.platform === "win32" ? "npm.cmd" : "npm", ["ci"], checkout);
    if (batch?.plans.some(plan => plan.planned.ir.ops.some(op => op.kind.startsWith("ui.")))) {
      await checkedCommand(process.platform === "win32" ? "npx.cmd" : "npx", ["--no-install", "playwright", "install", "chromium"], checkout);
    }
    if (batch?.target.testData.reset) {
      const reset = await command(process.platform === "win32" ? "powershell.exe" : "/bin/sh",
        process.platform === "win32" ? ["-NoProfile", "-Command", batch.target.testData.reset] : ["-c", batch.target.testData.reset],
        batch.target.testData.cwd ?? checkout);
      if (reset.code) throw new Error(`Configured target reset failed: ${maskSensitiveText(reset.stderr)}`);
    }
    await fs.mkdir(observationDirectory, { recursive: true });
    const args = ["playwright", "test", ...run.specs.map(spec => spec.file), ...(currentBatch?.config ? ["--config", currentBatch.config] : []), "--reporter=json"];
    const playwright = await command(process.platform === "win32" ? "npx.cmd" : "npx", args, checkout, {
      ...process.env, SPECGEN_BASE_URL: target.baseUrl, SPECGEN_UI_BASE_URL: target.uiBaseUrl ?? target.baseUrl,
      QA_OBSERVATION_DIR: observationDirectory, QA_SQLITE_FILE: target.db?.file, QA_STORAGE_STATE: target.auth?.storageState,
    });
    const start = playwright.stdout.indexOf("{");
    if (start < 0) throw new Error(`Playwright returned no JSON report: ${maskSensitiveText(playwright.stderr.slice(0, 300))}`);
    const report = JSON.parse(playwright.stdout.slice(start)) as { errors?: unknown[] };
    evidence.infrastructureErrors = (report.errors ?? []).map(error => maskSensitiveText(JSON.stringify(error)));
    const results = caseResults(report);
    for (const result of results) {
      const observations = await observationsFromAttachments(result.attachments, observationDirectory, result.caseId);
      evidence.cases.push({ ...result, observations });
      const spec = run.specs.find(item => item.caseId === result.caseId);
      if (spec) await graph.testRun(result.caseId, spec.storyId, executionId, sha, { ...result, observations });
    }
    for (const spec of run.specs) if (!results.some(result => result.caseId === spec.caseId)) evidence.infrastructureErrors.push(`Playwright did not report ${spec.caseId}`);
    if (playwright.code && !results.some(item => ["failed", "timedOut", "interrupted"].includes(item.status)) && !evidence.infrastructureErrors.length) evidence.infrastructureErrors.push(`Playwright exited with ${playwright.code}`);
    atomicWriteJson(path.join(runPath(run.id), `playwright-${executionId}.json`), { sha, report });
    const fixme = results.filter(item => item.status === "skipped" && run.specs.find(spec => spec.caseId === item.caseId)?.status === "fixme").length;
    const result = { executionId, tests: results.length,
      failures: results.filter(item => ["failed", "timedOut", "interrupted"].includes(item.status)).length + evidence.infrastructureErrors.length,
      passed: results.filter(item => item.status === "passed").length, failed: results.filter(item => ["failed", "timedOut", "interrupted"].includes(item.status)).length,
      skipped: results.filter(item => item.status === "skipped").length - fixme, fixme, collectionFailures: 0, infrastructureFailures: evidence.infrastructureErrors.length };
    run.status = "executed";
    if (currentBatch) { currentBatch.sha = sha; currentBatch.executionId = executionId; currentBatch.failures = result.failures; currentBatch.executionEvidence = evidence; }
    atomicWriteJson(path.join(runPath(run.id), `execution-${executionId}.json`), evidence);
    await saveRun(run);
    return result;
  } catch (error) {
    evidence.infrastructureErrors.push(maskSensitiveText(String(error)));
    atomicWriteJson(path.join(runPath(run.id), `execution-${executionId}.json`), evidence);
    // Infrastructure and collection failures are results, never invented product failures.
    run.status = "executed";
    if (currentBatch) { currentBatch.sha = sha; currentBatch.executionId = executionId; currentBatch.failures = 1; currentBatch.executionEvidence = evidence; }
    await saveRun(run);
    return { executionId, tests: evidence.cases.length, failures: 1, passed: 0, failed: 0, skipped: 0, fixme: 0, collectionFailures: evidence.infrastructureErrors.some(item => /did not report|no JSON report/.test(item)) ? 1 : 0, infrastructureFailures: 1 };

  } finally {
    await command("git", ["worktree", "remove", "--force", checkout], project).catch(() => undefined);
    if (temporary.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(temporary).startsWith("qa-approved-")) await fs.rm(temporary, { recursive: true, force: true });
  }
}
