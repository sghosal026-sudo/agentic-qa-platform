import { hash, required, type Artifact, type Relation, type RelationDecision, type Story, type TestReview, type WorkItemParent } from "../core/runtime.js";

type AdoWorkItem = { id: number; rev?: number; fields: Record<string, unknown>; relations?: Array<{ rel: string; url: string }> };
import type { ExecutionResult } from "../contracts.js";
import { parseDecision } from "../stages/review.js";

class AdoHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class Ado {
  private org = required("ADO_ORG_URL").replace(/\/+$/, "");
  private project = required("ADO_PROJECT");
  private token = required("ADO_PAT");
  private done = process.env.ADO_REVIEW_COMPLETED_STATE ?? "Done";
  private pending = process.env.ADO_REVIEW_PENDING_STATE ?? "To Do";

  constructor(private fetcher: typeof fetch = fetch) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetcher(`${this.org}/${encodeURIComponent(this.project)}/_apis/wit/${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`:${this.token}`).toString("base64")}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": path.startsWith("wiql?") || path.includes("/comments?") ? "application/json" : "application/json-patch+json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new AdoHttpError(response.status, `ADO ${method} failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
    return await response.json() as T;
  }

  async task(runId: string, relation: Relation, story: Story): Promise<{ id: number; hash: string }> {
    const workItem = await this.request<{ fields: Record<string, unknown> }>("GET", `workitems/${story.adoId}?api-version=7.1`);
    const area = workItem.fields["System.AreaPath"];
    const iteration = workItem.fields["System.IterationPath"];
    if (typeof area !== "string" || typeof iteration !== "string") throw new Error(`Story ${story.id} has no ADO Area/Iteration Path`);
    const proposalHash = hash({ id: relation.id, type: relation.type, evidence: relation.evidence, confidence: relation.confidence, reason: relation.reason });
    const key = hash(`${runId}|${story.id}|${relation.id}`).slice(0, 16);
    const title = `[QA relation ${runId}] ${key}`;
    const description = `<p>Story: ${escape(story.id)} | Graph relationship: ${escape(relation.id)} | Source: ${escape(relation.source)}</p>`
      + `<p>Source: ${escape(relation.sourceId)} (${relation.sourceType})</p>`
      + `<p>Target: ${escape(relation.targetId)} (${relation.targetType})</p>`
      + `<p>Proposed type: ${escape(relation.type)} | Direction: source to target</p>`
      + `<p>Evidence: ${escape(relation.evidence)} | Confidence: ${relation.confidence} | Review reason: ${escape(relation.reason)}</p>`
      + `<p>Review hash: ${proposalHash}</p>`
      + "<pre>Review-Hash: (copy hash above)\nDecision: approve | reject | correct\nType: (correction only)\nDirection: forward | reverse (correction only)\nReason: (rejection/correction)</pre>";
    const query = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Title] = '${title.replace(/'/g, "''")}'`;
    const found = await this.request<{ workItems?: Array<{ id: number }> }>("POST", "wiql?api-version=7.1", { query });
    const id = found.workItems?.[0]?.id;
    const fields = [
      { op: "add", path: "/fields/System.Title", value: title },
      { op: "add", path: "/fields/System.Description", value: description },
      { op: "add", path: "/fields/System.AreaPath", value: area },
      { op: "add", path: "/fields/System.IterationPath", value: iteration },
      { op: "add", path: "/fields/System.State", value: this.pending },
      { op: "add", path: "/fields/System.Tags", value: "qa-relation-review" },
    ];
    if (id) {
      const current = await this.request<{ fields: Record<string, unknown>; relations?: Array<{ rel: string; url: string }> }>("GET", `workitems/${id}?$expand=Relations&api-version=7.1`);
      if (!current.relations?.some((item) => item.rel === "System.LinkTypes.Hierarchy-Reverse" && item.url.endsWith(`/${story.adoId}`))) throw new Error(`Review Task ${id} has the wrong parent`);
      if (!String(current.fields["System.Description"] ?? "").includes(proposalHash)) {
        await this.request("PATCH", `workitems/${id}?api-version=7.1`, fields.slice(1, 5));
      }
      return { id, hash: proposalHash };
    }
    const created = await this.request<{ id: number }>("POST", "workitems/$Task?api-version=7.1", [
      ...fields,
      { op: "add", path: "/relations/-", value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: `${this.org}/_apis/wit/workItems/${story.adoId}` } },
    ]);
    return { id: created.id, hash: proposalHash };
  }

  async decision(taskId: number, expectedHash: string): Promise<RelationDecision | "missing" | null> {
    let item: { fields: Record<string, unknown> };
    try {
      item = await this.request("GET", `workitems/${taskId}?api-version=7.1`);
    } catch (error) {
      if (error instanceof AdoHttpError && error.status === 404) return "missing";
      throw error;
    }
    if (item.fields["System.State"] !== this.done) return null;
    const comments = await this.request<{ comments?: Array<{ text: string; createdBy?: { uniqueName?: string; displayName?: string } }> }>("GET", `workItems/${taskId}/comments?$top=100&order=desc&api-version=7.1-preview.4`);
    for (const comment of comments.comments ?? []) {
      const reviewer = comment.createdBy?.uniqueName ?? comment.createdBy?.displayName;
      if (!reviewer) continue;
      const parsed = parseDecision(comment.text, expectedHash, reviewer, taskId);
      if (parsed) return parsed;
    }
    throw new Error(`Completed Task ${taskId} has no valid decision for its current proposal`);
  }

  async recommendationStatus(taskId: number, proposalHash: string, model: string): Promise<"needed" | "present" | "unavailable"> {
    let item: { fields: Record<string, unknown> };
    try {
      item = await this.request("GET", `workitems/${taskId}?api-version=7.1`);
    } catch (error) {
      if (error instanceof AdoHttpError && error.status === 404) return "unavailable";
      throw error;
    }
    if (item.fields["System.State"] === this.done || !String(item.fields["System.Description"] ?? "").includes(proposalHash)) return "unavailable";
    const comments = await this.request<{ comments?: Array<{ text: string }> }>("GET", `workItems/${taskId}/comments?$top=100&order=desc&api-version=7.1-preview.4`);
    const marker = `AI relationship recommendation | ${proposalHash} | ${model}`;
    return comments.comments?.some((comment) => comment.text.includes(marker)) ? "present" : "needed";
  }

  async postRecommendation(taskId: number, proposalHash: string, model: string, text: string): Promise<void> {
    if (await this.recommendationStatus(taskId, proposalHash, model) !== "needed") return;
    await this.request("POST", `workItems/${taskId}/comments?api-version=7.1-preview.4`, { text });
  }

  async sprintStories(iterationPath: string): Promise<Story[]> {
    const escapedIteration = iterationPath.replace(/'/g, "''");
    const query = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.IterationPath] = '${escapedIteration}' AND [System.WorkItemType] IN ('User Story', 'Product Backlog Item', 'Story') ORDER BY [System.Id]`;
    const found = await this.request<{ workItems?: Array<{ id: number }> }>("POST", "wiql?api-version=7.1", { query });
    const stories: Story[] = [];
    const workItems = new Map<number, AdoWorkItem>();
    for (const item of found.workItems ?? []) {
      const workItem = await this.request<AdoWorkItem>("GET", `workitems/${item.id}?$expand=Relations&api-version=7.1`);
      workItems.set(workItem.id, workItem);
      const title = String(workItem.fields["System.Title"] ?? `ADO-${workItem.id}`);
      const code = workItemCode(workItem.id, title, "Story");
      stories.push({
        id: code,
        adoId: workItem.id,
        revision: workItem.rev ?? 0,
        title,
        text: plain(String(workItem.fields["System.Description"] ?? "")),
        areaPath: String(workItem.fields["System.AreaPath"] ?? ""),
        iterationPath: String(workItem.fields["System.IterationPath"] ?? ""),
        parents: await this.parents(workItem, workItems),
      });
    }
    return stories;
  }

  async storyById(adoId: number): Promise<Story> {
    const workItem = await this.request<AdoWorkItem>("GET", `workitems/${adoId}?$expand=Relations&api-version=7.1`);
    const title = String(workItem.fields["System.Title"] ?? `ADO-${adoId}`);
    return { id: workItemCode(adoId, title, "Story"), adoId, revision: workItem.rev ?? 0, title,
      text: plain(String(workItem.fields["System.Description"] ?? "")),
      areaPath: String(workItem.fields["System.AreaPath"] ?? ""),
      iterationPath: String(workItem.fields["System.IterationPath"] ?? ""),
      parents: await this.parents(workItem, new Map([[adoId, workItem]])) };
  }

  private async parents(workItem: AdoWorkItem, workItems: Map<number, AdoWorkItem>): Promise<WorkItemParent[]> {
    const parents: WorkItemParent[] = [];
    const visited = new Set<number>([workItem.id]);
    let current = workItem;
    while (true) {
      const parentRelations = current.relations?.filter((item) => item.rel === "System.LinkTypes.Hierarchy-Reverse") ?? [];
      if (parentRelations.length > 1) throw new Error(`Work item ${current.id} has multiple parents`);
      const relation = parentRelations[0];
      if (!relation) return parents;
      const match = relation.url.match(/\/workItems\/(\d+)\/?$/i);
      if (!match) throw new Error(`Work item ${current.id} has an invalid parent URL`);
      const parentId = Number(match[1]);
      if (visited.has(parentId)) throw new Error(`Work item hierarchy contains a cycle at ${parentId}`);
      visited.add(parentId);
      let parent = workItems.get(parentId);
      if (!parent) {
        parent = await this.request<AdoWorkItem>("GET", `workitems/${parentId}?$expand=Relations&api-version=7.1`);
        workItems.set(parentId, parent);
      }
      const kind = String(parent.fields["System.WorkItemType"]);
      if (kind !== "Feature" && kind !== "Epic") throw new Error(`Unsupported parent type ${kind} for work item ${current.id}`);
      const title = String(parent.fields["System.Title"] ?? `ADO-${parent.id}`);
      parents.push({
        id: workItemCode(parent.id, title, kind),
        adoId: parent.id,
        revision: parent.rev ?? 0,
        kind,
        title,
        text: plain(String(parent.fields["System.Description"] ?? "")),
      });
      current = parent;
    }
  }

  async artifactTask(runId: string, artifact: Artifact, story: Story): Promise<{ id: number; hash: string }> {
    const artifactHash = hash({ id: artifact.id, kind: artifact.kind, name: artifact.name, content: artifact.content });
    const key = hash(`${runId}|${artifact.id}`).slice(0, 16);
    const title = `[QA test ${runId}] ${key}`;
    const description = `<p>Story: ${escape(story.id)} | Test artifact: ${escape(artifact.id)}</p>`
      + `<p>Kind: ${escape(artifact.kind)} | Name: ${escape(artifact.name)}</p>`
      + `<p>Artifact hash: ${artifactHash}</p>`
      + `<pre>Review-Hash: ${artifactHash}\nDecision: approve | reject\nReason: (rejection only)</pre>`;
    const query = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Title] = '${title.replace(/'/g, "''")}'`;
    const found = await this.request<{ workItems?: Array<{ id: number }> }>("POST", "wiql?api-version=7.1", { query });
    const id = found.workItems?.[0]?.id;
    const fields = [
      { op: "add", path: "/fields/System.Title", value: title },
      { op: "add", path: "/fields/System.Description", value: description },
      { op: "add", path: "/fields/System.AreaPath", value: story.areaPath },
      { op: "add", path: "/fields/System.IterationPath", value: story.iterationPath },
      { op: "add", path: "/fields/System.State", value: this.pending },
      { op: "add", path: "/fields/System.Tags", value: "qa-test-review" },
    ];
    if (id) {
      const current = await this.request<{ fields: Record<string, unknown>; relations?: Array<{ rel: string; url: string }> }>("GET", `workitems/${id}?$expand=Relations&api-version=7.1`);
      if (!current.relations?.some((item) => item.rel === "System.LinkTypes.Hierarchy-Reverse" && item.url.endsWith(`/${story.adoId}`))) throw new Error(`Test review Task ${id} has the wrong parent`);
      if (!String(current.fields["System.Description"] ?? "").includes(artifactHash)) await this.request("PATCH", `workitems/${id}?api-version=7.1`, fields.slice(1, 5));
      return { id, hash: artifactHash };
    }
    const created = await this.request<{ id: number }>("POST", "workitems/$Task?api-version=7.1", [
      ...fields,
      { op: "add", path: "/relations/-", value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: `${this.org}/_apis/wit/workItems/${story.adoId}` } },
    ]);
    return { id: created.id, hash: artifactHash };
  }

  async artifactDecision(taskId: number, expectedHash: string): Promise<RelationDecision | "missing" | null> {
    const result = await this.decision(taskId, expectedHash);
    return result && result !== "missing" && result.action === "correct" ? null : result;
  }

  async testReviewTask(runId: string, review: TestReview, story: Story): Promise<number> {
    const key = hash(`${runId}|${story.id}|test-review`).slice(0, 16);
    const title = `[QA test ${runId}] ${key}`;
    const workflowUrl = process.env.WORKFLOW_URL;
    const details = review.items.map((item) => `<h3>${escape(item.kind)}: ${escape(item.name)}</h3>`
      + `<p>Item-ID: ${escape(item.id)} | Review-Hash: ${item.hash} | Status: ${item.status}</p>`
      + `<p>Base hash: ${escape(item.baseHash ?? "new item")} | Proposed hash: ${escape(item.proposedHash ?? "not applicable")}</p>`
      + `<p>Suite: ${escape(item.suite ?? "unspecified")}</p>`
      + `<p>Confidence: ${item.confidence ?? "not supplied"} | Review reason: ${escape(item.reviewReason)}</p>`
      + `<p>Evidence: ${escape(item.evidence ?? "none")} | Source revision: ${escape(item.sourceRevision ?? review.sourceHash)}</p>`
      + (item.changedSteps?.length ? `<p>Changed steps: ${escape(item.changedSteps.map((step) => String(step.index + 1)).join(", "))}</p>` : "")
      + `<p>Before: ${escape(JSON.stringify(item.before ?? "none").slice(0, 500))}</p>`
      + `<p>After: ${escape(JSON.stringify(item.after ?? "none").slice(0, 500))}</p>`
      + (item.affectedCaseId ? `<p>Affected test: ${escape(item.affectedCaseId)} | Missing evidence or oracle: ${escape(item.reviewReason)}</p>` : "")).join("");
    const description = `<p>Story: ${escape(story.id)} | Run: ${runId} | Source hash: ${review.sourceHash}</p>`
      + `<p>Full JSON/XLSX diff: ${escape(review.reportPath ?? `runs/${runId}/test-review.json`)} and runs/${runId}/test-review.xlsx${workflowUrl ? ` | Workflow artifact: ${escape(workflowUrl)}` : ""}</p>`
      + details
      + "<pre>Item-ID: (copy item ID)\nReview-Hash: (copy item hash)\nDecision: approve | reject | correct\nReason: (reject/correct)\nCorrection: (plain-language correction only)</pre>";
    const query = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Title] = '${title.replace(/'/g, "''")}'`;
    const found = await this.request<{ workItems?: Array<{ id: number }> }>("POST", "wiql?api-version=7.1", { query });
    const id = found.workItems?.[0]?.id;
    if (id) {
      const current = await this.request<{ fields: Record<string, unknown>; relations?: Array<{ rel: string; url: string }> }>("GET", `workitems/${id}?$expand=Relations&api-version=7.1`);
      if (!current.relations?.some((item) => item.rel === "System.LinkTypes.Hierarchy-Reverse" && item.url.endsWith(`/${story.adoId}`))) throw new Error(`Test review Task ${id} has the wrong parent`);
      if (current.fields["System.Description"] !== description) await this.request("PATCH", `workitems/${id}?api-version=7.1`, [
        { op: "add", path: "/fields/System.Description", value: description },
      ]);
      return id;
    }
    const created = await this.request<{ id: number }>("POST", "workitems/$Task?api-version=7.1", [
      { op: "add", path: "/fields/System.Title", value: title },
      { op: "add", path: "/fields/System.Description", value: description },
      { op: "add", path: "/fields/System.AreaPath", value: story.areaPath },
      { op: "add", path: "/fields/System.IterationPath", value: story.iterationPath },
      { op: "add", path: "/fields/System.State", value: this.pending },
      { op: "add", path: "/fields/System.Tags", value: "qa-test-review" },
      { op: "add", path: "/relations/-", value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: `${this.org}/_apis/wit/workItems/${story.adoId}` } },
    ]);
    return created.id;
  }

  async testReviewComments(taskId: number): Promise<Array<{ text: string; reviewer: string; at: string }>> {
    const comments: Array<{ text: string; reviewer: string; at: string }> = [];
    let continuation = "";
    do {
      const page: { comments?: Array<{ text: string; createdDate?: string; createdBy?: { uniqueName?: string; displayName?: string } }>; continuationToken?: string } =
        await this.request("GET", `workItems/${taskId}/comments?$top=100&order=desc${continuation ? `&continuationToken=${encodeURIComponent(continuation)}` : ""}&api-version=7.1-preview.4`);
      for (const comment of page.comments ?? []) {
        const reviewer = comment.createdBy?.uniqueName ?? comment.createdBy?.displayName;
        if (reviewer) comments.push({ text: comment.text, reviewer, at: comment.createdDate ?? new Date().toISOString() });
      }
      continuation = page.continuationToken ?? "";
    } while (continuation);
    return comments;
  }

  async closeTestReviewTask(taskId: number): Promise<void> {
    const item = await this.request<{ fields: Record<string, unknown> }>("GET", `workitems/${taskId}?api-version=7.1`);
    if (item.fields["System.State"] !== this.done) await this.request("PATCH", `workitems/${taskId}?api-version=7.1`, [
      { op: "add", path: "/fields/System.State", value: this.done },
    ]);
  }

  async resetReviewTasks(): Promise<number> {
    const query = "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] = 'Task' AND ([System.Tags] CONTAINS 'qa-relation-review' OR [System.Tags] CONTAINS 'qa-test-review')";
    const found = await this.request<{ workItems?: Array<{ id: number }> }>("POST", "wiql?api-version=7.1", { query });
    const taskIds: number[] = [];
    for (const item of found.workItems ?? []) {
      const task = await this.request<AdoWorkItem>("GET", `workitems/${item.id}?api-version=7.1`);
      const title = String(task.fields["System.Title"] ?? "");
      const tags = String(task.fields["System.Tags"] ?? "").split(";").map((tag) => tag.trim());
      const expectedTag = title.startsWith("[QA relation ") ? "qa-relation-review" : "qa-test-review";
      if (task.fields["System.WorkItemType"] !== "Task" || !/^\[QA (?:relation|test) [a-f0-9-]{36}\] [a-f0-9]{16}$/.test(title) || !tags.includes(expectedTag)) continue;
      taskIds.push(item.id);
    }
    for (const id of taskIds) {
      const response = await this.fetcher(`${this.org}/${encodeURIComponent(this.project)}/_apis/wit/workitems/${id}?api-version=7.1`, {
        method: "DELETE",
        headers: { Authorization: `Basic ${Buffer.from(`:${this.token}`).toString("base64")}` },
      });
      if (!response.ok) throw new Error(`ADO Task ${id} deletion failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
    }
    return taskIds.length;
  }

  async publishResult(story: Story, result: ExecutionResult, workflowUrl?: string): Promise<void> {
    const status = result.failures ? "failed" : "passed";
    const text = `QA execution ${status}. Tests: ${result.tests}. Failures: ${result.failures}. Execution: ${result.executionId}.${workflowUrl ? ` Workflow: ${workflowUrl}` : ""}`;
    await this.request("POST", `workItems/${story.adoId}/comments?api-version=7.1-preview.4`, { text });
  }
}

function escape(value: unknown): string {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]!);
}

function plain(value: string): string {
  return value.replace(/<br\s*\/?\s*>|<\/p>|<\/li>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
}

function workItemCode(id: number, title: string, kind: "Story" | "Feature" | "Epic"): string {
  const numbered = title.match(/\b[A-Z][A-Z0-9]*-\d+\b/)?.[0];
  if (numbered) return numbered;
  if (kind === "Epic") return title.match(/\bEPIC\s+([A-Z][A-Z0-9]*)\b/i)?.[1]?.toUpperCase() ?? `ADO-${id}`;
  return `ADO-${id}`;
}
