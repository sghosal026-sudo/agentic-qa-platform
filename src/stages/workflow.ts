import { loadTargetConfig } from "../spec-generation/config/targetConfig.js";
import { planSpecs, renderBatch } from "../spec-generation/stages.js";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { hash, newRun, runPath, saveRun, type Artifact, type NodeKind, type Relation, type Run, type Spec, type Story, type WorkItemParent } from "../core/runtime.js";
import type { GraphStore, ModelClient, WorkItemClient } from "../contracts.js";
import { normalizeName, semanticNodeId } from "../ontology/identifiers.js";
import { isSemanticEdgeAllowed, normalizeRelationshipType, resolveSemanticRelationship } from "../ontology/rules.js";
import { EXTRACTABLE_NODE_TYPES, QA_RELATIONSHIP_TYPES, SEMANTIC_RELATIONSHIP_TYPES, type NodeType } from "../ontology/types.js";
import { documentRelationshipsPrompt, entityConnectionFeedback, entityConnectionsPrompt, invalidRelationshipFeedback, RELATIONSHIP_SHAPE_FEEDBACK, storyRelationshipsPrompt } from "../prompts/relationships.js";
import { stageReviews } from "./review.js";
import type { SourceDocument } from "../adapters/postgres.js";
import { authorStory, buildArtifacts, buildAuthorContext } from "./test-author.js";
import { exportAuthorReport } from "./test-author-export.js";

export type DocumentStore = { setup(): Promise<void>; upsert(document: SourceDocument): Promise<number>; readText?(id: string): Promise<string | null>; close(): Promise<void> };

const RELATION_TARGET_TYPES = [...EXTRACTABLE_NODE_TYPES, "Story"] as const;
const EXTRACTABLE_RELATIONSHIP_TYPES = [...SEMANTIC_RELATIONSHIP_TYPES, ...QA_RELATIONSHIP_TYPES];
const RelationshipOutput = z.object({
  targetName: z.string().min(1), targetType: z.enum(RELATION_TARGET_TYPES),
  type: z.string().min(1), evidence: z.string().min(1), confidence: z.number().min(0).max(1),
  reason: z.string().min(1), storyIds: z.array(z.string()).optional(),
});
const RelationEnvelope = z.object({ relationships: z.array(z.unknown()) });
const EntityConnections = z.object({ connections: z.array(z.object({
  sourceId: z.string(), targetId: z.string(), type: z.string().min(1),
  evidence: z.string().min(1), confidence: z.number().min(0).max(1), reason: z.string().min(1),
})) });
const Route = z.object({ method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]), path: z.string().startsWith("/"), expectedStatus: z.number().int(), body: z.record(z.string(), z.unknown()).optional() });
export type Target = { projectDir: string; baseUrl: string; safeEnvironments: string[]; routes: Array<{ method: string; path: string; responses: number[]; requiresAuth?: boolean; requestBody?: Record<string, unknown> }> } & Partial<import("../spec-generation/config/targetConfig.js").TargetConfig>;

async function files(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await files(file));
    else if (/\.(json|md|txt)$/i.test(entry.name)) output.push(file);
  }
  return output;
}

function plain(value: string): string {
  return value.replace(/<br\s*\/?\s*>|<\/p>|<\/li>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
}

function storyFromJson(value: unknown): Story | null {
  if (!value || typeof value !== "object") return null;
  const item = value as { id?: unknown; rev?: unknown; code?: unknown; fields?: Record<string, unknown> };
  const fields = item.fields;
  if (!fields || !["User Story", "Product Backlog Item", "Story"].includes(String(fields["System.WorkItemType"]))) return null;
  const id = typeof item.code === "string" ? item.code : String(fields["System.Title"] ?? "").match(/[A-Z]+-\d+/)?.[0];
  if (!id || typeof item.id !== "number") throw new Error("Story JSON needs a code and numeric ADO id");
  return { id, adoId: item.id, revision: typeof item.rev === "number" ? item.rev : undefined, title: String(fields["System.Title"] ?? id), text: plain(String(fields["System.Description"] ?? "")), areaPath: String(fields["System.AreaPath"] ?? ""), iterationPath: String(fields["System.IterationPath"] ?? "") };
}

export function relationFromModel(
  story: Story, item: z.infer<typeof RelationshipOutput>, knownStories: Set<string>,
  source = story.id, sourceItem?: WorkItemParent, existing: EntityCandidate[] = [],
): Relation {
  const storyIds = [...new Set([story.id, ...(item.storyIds ?? [])])];
  for (const id of storyIds) if (!knownStories.has(id)) throw new Error(`Relationship has no resolved Story mapping: ${id}`);
  const previous = existing.find((node) => node.type === item.targetType && normalizeName(node.name) === normalizeName(item.targetName));
  const targetId = item.targetType === "Story" ? item.targetName : previous?.id ?? semanticNodeId(item.targetType, item.targetName);
  const sourceId = sourceItem?.id ?? story.id;
  const sourceType = sourceItem?.kind ?? "Story";
  // Keep explicitly named Story context without assigning the system's or test's behavior to the Story.
  let type = item.type;
  let evidence = item.evidence;
  if (sourceType === "Story" && item.targetType === "Endpoint" && type.toUpperCase() === "EXPOSES") type = "MENTIONS";
  if (["Epic", "Feature", "Story"].includes(sourceType) && item.targetType === "Module" && type.toUpperCase() === "USES"
    && /primary module|modules?\s*:/i.test(evidence)) type = "MENTIONS";
  if (sourceType === "Story" && item.targetType === "TestCase" && type.toUpperCase() === "VALIDATES"
    && story.text.toLowerCase().includes(item.targetName.toLowerCase())) {
    type = "TRACES_TO";
    evidence = item.targetName;
  }
  const targetName = normalizeName(item.targetName);
  const sourceText = sourceItem?.text ?? story.text;
  if (item.targetType !== "Story" && resolveSemanticRelationship(type, sourceType, item.targetType).fallbackReason === "invalid_endpoints"
    && targetName.length >= 4
    && normalizeName(sourceText).includes(targetName)
    && normalizeName(evidence).includes(targetName)) type = "MENTIONS";
  const resolved = resolveSemanticRelationship(type, sourceType, item.targetType);
  const threshold = Number(process.env.RELATION_AUTO_APPROVE_CONFIDENCE ?? "0.9");
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("RELATION_AUTO_APPROVE_CONFIDENCE must be between 0 and 1");
  const state = resolved.reviewState !== "needs_review" && item.confidence >= threshold ? "approved" : "needs_review";
  return {
    id: hash(`${sourceId}|${type}|${targetId}|${evidence}`).slice(0, 32),
    sourceId, sourceType, targetId, targetType: item.targetType as NodeKind,
    type: type.toUpperCase(), evidence, confidence: item.confidence, reason: item.reason,
    storyIds, source, state, tasks: {}, decisions: [],
  };
}

function validRelationshipItems(run: Run, storyId: string, value: unknown): Array<z.infer<typeof RelationshipOutput>> | null {
  const envelope = RelationEnvelope.safeParse(value);
  if (!envelope.success) return null;
  const relationships: Array<z.infer<typeof RelationshipOutput>> = [];
  envelope.data.relationships.forEach((raw, index) => {
    const parsed = RelationshipOutput.safeParse(raw);
    if (parsed.success) relationships.push(parsed.data);
    else (run.warnings ??= []).push(`${storyId}: relationship #${index} ignored (${parsed.error.issues[0]?.message ?? "invalid"})`);
  });
  return relationships;
}

function relevantToStory(item: z.infer<typeof RelationshipOutput>, story: Story, source: Story | WorkItemParent): boolean {
  if (!("kind" in source)) return true;
  if (item.targetType === "Story" && item.targetName === story.id && item.type.toUpperCase() === "SUPPORTS") {
    const evidence = normalizeName(item.evidence);
    const title = normalizeName(story.title.replace(story.id, ""));
    if (!evidence.includes(normalizeName(story.id)) && (!title || !evidence.includes(title))) return false;
    return true;
  }
  const targetName = normalizeName(item.targetName);
  if (!targetName) return false;
  const context = source.kind === "Epic" ? `${story.text} ${story.parents?.find((parent) => parent.kind === "Feature")?.text ?? ""}` : story.text;
  return normalizeName(context).includes(targetName);
}

function relationshipChoices(sourceType: "Epic" | "Feature" | "Story"): string {
  return RELATION_TARGET_TYPES.map((targetType) => {
    const allowed = EXTRACTABLE_RELATIONSHIP_TYPES.filter((type) => isSemanticEdgeAllowed(type, sourceType, targetType));
    return `${targetType}: ${allowed.join("|")}`;
  }).join("; ");
}

function modelRelationshipIsAllowed(item: z.infer<typeof RelationshipOutput>, sourceType: "Epic" | "Feature" | "Story"): boolean {
  const type = normalizeRelationshipType(item.type);
  return Boolean(type && isSemanticEdgeAllowed(type, sourceType, item.targetType));
}

async function extractRelationshipItems(run: Run, storyId: string, model: ModelClient, prompt: string, sourceType: "Epic" | "Feature" | "Story"): Promise<Array<z.infer<typeof RelationshipOutput>>> {
  let feedback = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const relationships = validRelationshipItems(run, storyId, await model.json(`${prompt}${feedback}`));
    if (!relationships) {
      feedback = RELATIONSHIP_SHAPE_FEEDBACK;
      continue;
    }
    const invalid = relationships.filter((item) => !modelRelationshipIsAllowed(item, sourceType));
    if (!invalid.length) return relationships;
    if (attempt === 0) {
      feedback = invalidRelationshipFeedback(invalid.map((item) => `${sourceType} -[${item.type}]-> ${item.targetType}`));
      continue;
    }
    for (const item of invalid) (run.warnings ??= []).push(`${storyId}: model kept invalid relationship ${sourceType} -[${item.type}]-> ${item.targetType} after retry`);
    return relationships;
  }
  throw new Error("model output is not an object with relationships after retry");
}

type EntityCandidate = { id: string; type: NodeType; name: string };

function explicitConnectionEvidence(from: EntityCandidate, to: EntityCandidate, type: string, evidence: string): boolean {
  const quote = normalizeName(evidence);
  const names = (text: string, name: string): boolean => ` ${normalizeName(text)} `.includes(` ${normalizeName(name)} `);
  if (!names(quote, from.name) || !names(quote, to.name)) return false;
  // Complex flow and mapping directions need human review; these verbs have a simple subject-to-object order.
  const verbs: Record<string, RegExp> = {
    CALLS: /\b(calls?|invokes?|requests?)\b/i,
    EXPOSES: /\b(exposes?|provides?|serves?|offers?)\b/i,
    PUBLISHES: /\b(publishes?|emits?|sends?)\b/i,
    CARRIES: /\b(carries?|contains?)\b/i,
    SUBSCRIBES_TO: /\b(subscribes?|consumes?|listens?)\b/i,
    READS_FROM: /\b(reads?|queries?|fetches?)\b/i,
    WRITES_TO: /\b(writes?|persists?|stores?)\b/i,
  };
  const verb = verbs[type]?.exec(evidence);
  if (!verb) return false;
  if (["CALLS", "EXPOSES", "PUBLISHES", "CARRIES", "SUBSCRIBES_TO", "READS_FROM", "WRITES_TO"].includes(type)) {
    const before = normalizeName(evidence.slice(0, verb.index));
    const after = normalizeName(evidence.slice(verb.index + verb[0].length));
    return names(before, from.name) && names(after, to.name);
  }
  return true;
}

async function connectRelatedEntities(
  run: Run, story: Story, source: Story | WorkItemParent, newEntities: EntityCandidate[],
  existing: EntityCandidate[], graph: GraphStore, model: ModelClient, sourceName = source.id,
): Promise<void> {
  const previous = new Map(existing.map((node) => [node.id, node]));
  const candidates = new Map(previous);
  for (const node of newEntities) {
    if (!candidates.has(node.id)) candidates.set(node.id, node);
  }
  if (candidates.size < 2) return;
  const types = EXTRACTABLE_RELATIONSHIP_TYPES.filter((type) => !["MENTIONS", "RELATES_TO", "IMPACTS"].includes(type));
  const prompt = entityConnectionsPrompt([...candidates.values()], types, source.text);
  let connections: z.infer<typeof EntityConnections>["connections"] | undefined;
  let feedback = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = EntityConnections.safeParse(await model.json(`${prompt}${feedback}`));
    if (response.success) {
      connections = response.data.connections;
      break;
    }
    const issues = response.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ");
    const diagnostic = `${source.id}: entity connections attempt ${attempt}/3 failed schema validation: ${issues}`;
    (run.warnings ??= []).push(diagnostic);
    if (attempt === 3) throw new Error(diagnostic);
    feedback = entityConnectionFeedback(issues);
  }
  const threshold = Number(process.env.RELATION_AUTO_APPROVE_CONFIDENCE ?? "0.9");
  for (const item of connections ?? []) {
    const from = candidates.get(item.sourceId);
    const to = candidates.get(item.targetId);
    const type = normalizeRelationshipType(item.type);
    if (!from || !to || from.id === to.id || !type || ["MENTIONS", "RELATES_TO", "IMPACTS"].includes(type)
      || !isSemanticEdgeAllowed(type, from.type, to.type)
      || !normalizeName(item.evidence) || !normalizeName(source.text).includes(normalizeName(item.evidence))) {
      (run.warnings ??= []).push(`${story.id}: ignored unsupported existing-entity connection ${item.sourceId} -> ${item.targetId}`);
      continue;
    }
    const relation: Relation = {
      id: hash(`${from.id}|${type}|${to.id}|${item.evidence}`).slice(0, 32),
      sourceId: from.id, sourceType: from.type, targetId: to.id, targetType: to.type,
      type, evidence: item.evidence, confidence: item.confidence, reason: item.reason,
      storyIds: [story.id], source: sourceName, sourceText: source.text,
      state: previous.has(from.id) === previous.has(to.id) || !explicitConnectionEvidence(from, to, type, item.evidence)
        ? "needs_review" : item.confidence >= threshold ? "approved" : "needs_review",
      tasks: {}, decisions: [],
    };
    if (run.relations.some((current) => current.sourceId === relation.sourceId
      && current.targetId === relation.targetId && current.type === relation.type)) continue;
    if (graph.hasApprovedRelationship && await graph.hasApprovedRelationship(from.id, type, to.id)) continue;
    await graph.propose(relation);
    run.relations.push(relation);
  }
}

export async function ingestStory(story: Story, graph: GraphStore, model: ModelClient, ado: WorkItemClient, documents?: DocumentStore): Promise<Run> {
  const run = await newRun();
  run.stories.push(story);
  await graph.setup();
  await graph.node(story.id, "Story", story.title, story);
  let child = { id: story.id, adoId: story.adoId, title: story.title };
  for (const parent of story.parents ?? []) {
    await graph.node(parent.id, parent.kind, parent.title, parent);
    await graph.hierarchy(parent.id, child.id, child);
    child = { id: parent.id, adoId: parent.adoId, title: parent.title };
  }
  await saveRun(run);
  try {
    if (documents) {
      await documents.setup();
      for (const source of [...(story.parents ?? []).slice().reverse(), story]) {
        await documents.upsert({ id: source.id, kind: "kind" in source ? source.kind : "Story", title: source.title,
          text: source.text, sourcePath: `ado:${source.adoId}` });
      }
    }
    const known = new Set([story.id]);
    for (const source of [...(story.parents ?? []).slice().reverse(), story]) {
      const existing = graph.mentionedEntities ? await graph.mentionedEntities(source.text) : [];
      const newEntities: EntityCandidate[] = [];
      const sourceType = "kind" in source ? source.kind : "Story";
      const prompt = storyRelationshipsPrompt(story, source, sourceType, relationshipChoices(sourceType));
      for (const item of await extractRelationshipItems(run, source.id, model, prompt, sourceType)) {
        if (!relevantToStory(item, story, source)) continue;
        const relation = relationFromModel(story, item, known, source.id, "kind" in source ? source : undefined, existing);
        if (relation.targetType !== "Story" && !existing.some((node) => node.id === relation.targetId)) {
          await graph.node(relation.targetId, relation.targetType, item.targetName, { sourceWorkItem: source.id, text: item.evidence });
        }
        await graph.propose(relation);
        run.relations.push(relation);
        if (item.targetType !== "Story" && !existing.some((node) => node.id === relation.targetId)) {
          newEntities.push({ id: relation.targetId, type: item.targetType, name: item.targetName });
        }
      }
      await connectRelatedEntities(run, story, source, newEntities, existing, graph, model);
      await saveRun(run);
    }
  } catch (error) {
    run.status = "mapping_error";
    run.errors.push(`${story.id}: ${error instanceof Error ? error.message : String(error)}`);
    await saveRun(run);
    return run;
  }
  await stageReviews(run, ado);
  return run;
}

export async function ingest(directory: string, graph: GraphStore, model: ModelClient, ado: WorkItemClient, documents?: DocumentStore): Promise<Run> {
  const run = await newRun();
  await graph.setup();
  const inputs = await files(directory);
  for (const file of inputs) {
    if (!file.endsWith(".json")) continue;
    const value = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    const story = storyFromJson(value);
    if (story) run.stories.push(story);
  }
  if (!run.stories.length) throw new Error("No ADO Stories found in input directory");
  const known = new Set(run.stories.map((story) => story.id));
  for (const story of run.stories) await graph.node(story.id, "Story", story.title, story);
  await saveRun(run);
  const sources: Array<{ story: Story; text: string; name: string }> = run.stories.map((story) => ({ story, text: story.text, name: story.id }));
  for (const file of inputs.filter((name) => /\.(md|txt)$/i.test(name))) {
    const text = plain(await fs.readFile(file, "utf8"));
    const linked = run.stories.filter((story) => new RegExp(`\\b${story.id}\\b`, "i").test(text));
    if (!linked.length) {
      run.status = "mapping_error";
      run.errors.push(`No Story mapping for ${path.basename(file)}`);
      await saveRun(run);
      continue;
    }
    for (const story of linked) sources.push({ story, text, name: path.basename(file) });
  }
  if (run.errors.length) return run;
  if (documents) {
    await documents.setup();
    for (const source of sources) {
      await documents.upsert({ id: source.name === source.story.id ? source.story.id : hash(`${source.story.id}:${source.name}`),
        kind: source.name === source.story.id ? "Story" : "Document", title: source.name, text: source.text,
        sourcePath: source.name === source.story.id ? `ado:${source.story.adoId}` : source.name });
    }
  }
  const seen = new Set<string>();
  for (const source of sources) {
    const { story } = source;
    try {
      const existing = graph.mentionedEntities ? await graph.mentionedEntities(source.text) : [];
      const newEntities: EntityCandidate[] = [];
      const prompt = documentRelationshipsPrompt(story.id, source.text);
      for (const item of await extractRelationshipItems(run, story.id, model, prompt, "Story")) {
        const relation = relationFromModel({ ...story, text: source.text }, item, known, source.name, undefined, existing);
        if (seen.has(relation.id)) continue;
        seen.add(relation.id);
        if (relation.targetType !== "Story" && !existing.some((node) => node.id === relation.targetId)) {
          await graph.node(relation.targetId, relation.targetType, item.targetName, { sourceStory: story.id, text: item.evidence });
        }
        await graph.propose(relation);
        run.relations.push(relation);
        if (item.targetType !== "Story" && !existing.some((node) => node.id === relation.targetId)) {
          newEntities.push({ id: relation.targetId, type: item.targetType, name: item.targetName });
        }
      }
      await connectRelatedEntities(run, story, { ...story, text: source.text }, newEntities, existing, graph, model, source.name);
      await saveRun(run);
    } catch (error) {
      run.status = "mapping_error";
      run.errors.push(`${story.id}: ${error instanceof Error ? error.message : String(error)}`);
      await saveRun(run);
    }
  }
  if (run.errors.length) return run;
  await stageReviews(run, ado);
  return run;
}

export async function design(run: Run, graph: GraphStore, model: ModelClient, documents?: DocumentStore): Promise<Run["status"]> {
  if (run.status !== "ready_design") throw new Error("Relationship review must resolve before design");
  if (run.stories.length !== 1) throw new Error("Test authoring requires exactly one Story per run");
  run.artifacts = [];
  await saveRun(run);
  const context = await buildAuthorContext(run.stories[0], graph, documents);
  const { report, artifacts } = await authorStory(context, model);
  const attempt = (run.designAttempt ?? 0) + 1;
  const files = await exportAuthorReport(run, context, report, attempt);
  run.designAttempt = attempt;
  run.testDesign = { ...files, gaps: report.gaps, failedBatches: report.failedBatches };
  run.artifacts = run.testReview ? buildArtifacts(context.story, report) : artifacts;
  run.status = run.testReview ? "review_artifacts" : report.gaps.length || report.failedBatches.length ? "design_gap" : "review_artifacts";
  await saveRun(run);
  return run.status;
}

export async function approveArtifact(run: Run, id: string, reviewer: string): Promise<void> {
  if (run.status !== "review_artifacts" || !reviewer.trim()) throw new Error("Artifact review is unavailable or reviewer is empty");
  const item = run.artifacts.find((value) => value.id === id);
  if (!item) throw new Error(`Unknown artifact: ${id}`);
  item.hash = hash(item.content);
  item.reviewer = reviewer.trim();
  item.approvedAt = new Date().toISOString();
  await saveRun(run);
}

export async function ingestDesign(run: Run, graph: GraphStore): Promise<void> {
  if (run.status !== "review_artifacts") throw new Error("Design is not ready for ingestion");
  const missing = run.artifacts.filter((item) => !item.reviewer || !item.approvedAt || item.hash !== hash(item.content));
  if (missing.length) throw new Error(`Artifacts awaiting review: ${missing.map((item) => item.id).join(", ")}`);
  for (const item of run.artifacts) await graph.artifact(item);
  run.status = "ready_specs";
  await saveRun(run);
}

export async function loadTarget(file: string): Promise<import("../spec-generation/config/targetConfig.js").TargetConfig> {
  return loadTargetConfig(file);
}

function safeName(id: string): string { return id.toLowerCase().replace(/[^a-z0-9]+/g, "-"); }

export function renderSpec(item: Artifact, target: Target, sourceText = ""): { code: string; status: Spec["status"]; reason?: string; ir: Record<string, unknown> } {
  const content = item.content as { steps?: string[]; expected?: string; route?: z.infer<typeof Route> };
  const route = Route.safeParse(content.route);
  const known = route.success ? target.routes.find((entry) => entry.method === route.data.method && entry.path === route.data.path) : undefined;
  let reason = "";
  if (!route.success) reason = "No grounded API operation and expected status";
  else if (!known?.responses.includes(route.data.expectedStatus)) reason = "Route or expected status is absent from the approved target contract";
  else if (known.requiresAuth) reason = "auth.unavailable: this case has no approved authentication binding";
  else if (route.data.path.includes("{")) reason = "Path variables have no grounded bindings";
  else if (route.data.method !== "GET" && (!known.requestBody || JSON.stringify(route.data.body) !== JSON.stringify(known.requestBody))) reason = "Request body has no approved target binding";
  else if (content.expected?.trim() !== `HTTP ${route.data.expectedStatus}`) reason = "Expected result has obligations beyond the supported status assertion";
  else if (sourceText && !sourceText.includes(String(route.data.expectedStatus))) reason = "Expected status is absent from Story evidence";
  const body = reason
    ? `  test.fixme(true, ${JSON.stringify(reason)});`
    : `  const response = await request.${route.data!.method.toLowerCase()}(baseUrl + ${JSON.stringify(route.data!.path)}${route.data!.body ? `, { data: ${JSON.stringify(route.data!.body)} }` : ""});\n  expect(response.status()).toBe(${route.data!.expectedStatus});`;
  const code = `import { test, expect } from "@playwright/test";\n\nconst baseUrl = process.env.SPECGEN_BASE_URL;\nif (!baseUrl) throw new Error("SPECGEN_BASE_URL is required");\n\ntest(${JSON.stringify(item.name)}, { annotation: [{ type: "case", description: ${JSON.stringify(item.id)} }] }, async ({ request }) => {\n${body}\n});\n`;
  return { code, status: reason ? "fixme" : "generated", ...(reason ? { reason } : {}), ir: { caseId: item.id, steps: content.steps, expected: content.expected, route: route.success ? route.data : undefined, ...(reason ? { unautomatable: reason } : {}) } };
}

export async function generateSpecs(run: Run, target: Target, caseIds?: string[], model?: ModelClient, graph?: GraphStore): Promise<void> {
  if (!model || !target.file) throw new Error("Evidence-based spec generation requires a model and loaded target configuration");
  const batch = await planSpecs(run, target as import("../spec-generation/config/targetConfig.js").TargetConfig, model, graph, caseIds);
  await renderBatch(run, batch, (run.specBatches?.length ?? 0) + 1);
}
