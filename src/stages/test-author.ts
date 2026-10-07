import { z } from "zod";
import { startActiveObservation } from "@langfuse/tracing";
import type { DesignGraphContext, GraphStore, ModelClient } from "../contracts.js";
import { hash, type Artifact, type Run, type Story } from "../core/runtime.js";
import { normalizeName, semanticNodeId } from "../ontology/identifiers.js";
import { isSemanticEdgeAllowed } from "../ontology/rules.js";
import { NodeTypeSchema } from "../ontology/types.js";
import { designRetryPrompt, testCasesPrompt, testPlanPrompt, testScenariosPrompt } from "../prompts/test-author.js";
import type { DocumentStore } from "./workflow.js";

export const TEST_TYPES = ["functional", "integration", "e2e", "regression", "sanity", "smoke"] as const;
export type TestType = typeof TEST_TYPES[number];
type Node = DesignGraphContext["nodes"][number];
type Edge = DesignGraphContext["edges"][number];
export type Criterion = { label: string; text: string };
export type Target = { id: string; label: string; detail: string; nodeId?: string; criterion?: string };
export type SourcePassage = { id: string; sourceId: string; kind: string; title: string; text: string };
export type AuthorContext = {
  story: Story; sources: Array<{ id: string; kind: string; title: string; text: string }>;
  criteria: Criterion[]; nodes: Node[]; edges: Edge[];
};
export type Scenario = { id: string; name: string; origin: "existingInGraph" | "createdByAgent";
  description: string; expectedOutcome: string; priority: string; evidence: string;
  sourceId?: string; category?: string; riskRationale?: string;
  targetIds: string[]; acceptanceCriteria: string[]; coversNodeIds: string[]; exercisesNodeIds: string[];
  testTypes: TestType[]; parentSuite?: string };
export type Case = { id: string; name: string; origin: "existingInGraph" | "createdByAgent"; scenarioId: string;
  testTypes: TestType[]; objective?: string; caseKind?: string; priority?: string; preconditions?: string[];
  testData?: Array<{ name: string; value: string }>; steps?: Array<{ action: string; expectedResult: string; expectedResultEvidence?: string }>;
  acceptanceCriteria?: string[]; validatesNodeIds?: string[]; exercisesNodeIds?: string[];
  automation?: { candidate: boolean; notes: string }; evidence?: string; sourceId?: string; route?: unknown };
export type AuthorReport = { plan: z.infer<typeof PlanSchema>; suites: Array<{ testType: TestType; targets: Target[]; scenarioIds: string[]; caseIds: string[] }>;
  scenarios: Scenario[]; cases: Case[]; inapplicable: TestType[]; inapplicableReasons: Partial<Record<TestType, string>>; gaps: string[]; failedBatches: string[];
  coverage: { acceptanceCriteria: { total: number; covered: number; uncovered: string[] }; byTestType: Record<TestType, number> } };

const Priority = z.enum(["critical", "high", "medium", "low"]);
const Route = z.object({ method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]), path: z.string().startsWith("/"),
  expectedStatus: z.number().int(), body: z.record(z.string(), z.unknown()).optional() });
const PlanSchema = z.object({ objective: z.string().min(1), scopeSummary: z.string().min(1),
  inScope: z.array(z.object({ nodeId: z.string(), reason: z.string().min(1) })),
  outOfScope: z.array(z.object({ item: z.string(), reason: z.string() })).default([]),
  approaches: z.array(z.object({ testType: z.enum(TEST_TYPES), purpose: z.string().min(1), focus: z.string().min(1),
    entryCriteria: z.array(z.string()).min(1), exitCriteria: z.array(z.string()).min(1) })),
  risks: z.array(z.object({ name: z.string(), description: z.string(), likelihood: z.enum(["high", "medium", "low"]),
    impact: z.enum(["high", "medium", "low"]), mitigation: z.string() })).default([]),
  environments: z.array(z.string()).default([]), testDataNeeds: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]), openQuestions: z.array(z.string()).default([]),
  inapplicable: z.array(z.object({ testType: z.enum(TEST_TYPES), reason: z.string().min(1) })).default([]) });
const ScenarioSchema = z.object({ reusedScenarios: z.array(z.object({ id: z.string(), targetIds: z.array(z.string()).min(1) })).default([]),
  newScenarios: z.array(z.object({ name: z.string().min(5), description: z.string().min(1), expectedOutcome: z.string().min(1),
    priority: Priority, evidence: z.string().min(1), sourceId: z.string().min(1),
    category: z.enum(["normal", "invalid", "boundary", "state", "integration", "recovery", "regression"]),
    riskRationale: z.string().min(1), targetIds: z.array(z.string()).min(1),
    acceptanceCriteria: z.array(z.string()).default([]), coversNodeIds: z.array(z.string()).default([]),
    exercisesNodeIds: z.array(z.string()).default([]) })).default([]) });
const CaseSchema = z.object({ reusedCaseIds: z.array(z.string()).default([]), newCases: z.array(z.object({
  name: z.string().min(5), objective: z.string().min(1), caseKind: z.enum(["positive", "negative", "boundary", "edge", "error-handling", "end-to-end"]),
  priority: Priority, preconditions: z.array(z.string()).default([]), testData: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
  steps: z.array(z.object({ action: z.string().min(1), expectedResult: z.string().min(1), expectedResultEvidence: z.string().min(1) })).min(1),
  acceptanceCriteria: z.array(z.string()).default([]), validatesNodeIds: z.array(z.string()).default([]),
  exercisesNodeIds: z.array(z.string()).default([]), automationCandidate: z.boolean(), automationNotes: z.string().default(""),
  evidence: z.string().min(1), sourceId: z.string().min(1), route: Route.optional(),
  })).default([]) });

export function parseAcceptanceCriteria(text: string): Criterion[] {
  const found = new Map<string, string>();
  const pieces = text.split(/(?=\bAC-\d+[a-z]?\b)/i);
  for (const piece of pieces) {
    const match = /^(AC-\d+[a-z]?)\b/i.exec(piece);
    if (!match) continue;
    const label = match[1].toUpperCase();
    const value = piece.slice(match[0].length).split(/(?=\bAC-\d+[a-z]?\b)|(?:\n\s*\n)/i)[0]
      .replace(/^[\s:–—-]+/, "").replace(/\s+/g, " ").trim();
    if (value && value.length > (found.get(label)?.length ?? 0)) found.set(label, value);
  }
  return [...found].sort((a, b) => a[0].localeCompare(b[0], "en", { numeric: true })).map(([label, value]) => ({ label, text: value }));
}

function connected(id: string, edge: Edge): boolean { return edge.sourceId === id || edge.targetId === id; }
function other(id: string, edge: Edge): string { return edge.sourceId === id ? edge.targetId : edge.sourceId; }
function isRelevant(node: Node, sources: Set<string>, edges: Edge[]): boolean {
  return edges.some((edge) => connected(node.id, edge) && sources.has(other(node.id, edge)));
}

export async function buildAuthorContext(story: Story, graph: GraphStore, documents?: DocumentStore): Promise<AuthorContext> {
  const sources = [];
  for (const source of [...(story.parents ?? []).slice().reverse(), story]) {
    const text = await documents?.readText?.(source.id) ?? source.text;
    if (!text.trim()) throw new Error(`No source text for ${source.id}`);
    sources.push({ id: source.id, kind: "kind" in source ? source.kind : "Story", title: source.title, text });
  }
  let context: DesignGraphContext;
  if (graph.designContext) context = await graph.designContext(story.id, (story.parents ?? []).map((parent) => parent.id));
  else {
    const value = JSON.parse(await graph.storyContext(story.id, (story.parents ?? []).map((parent) => parent.id))) as Partial<DesignGraphContext>;
    context = { nodes: value.nodes ?? [], edges: value.edges ?? [] };
  }
  return { story, sources, criteria: parseAcceptanceCriteria(sources.find((source) => source.id === story.id)?.text ?? story.text),
    nodes: context.nodes, edges: context.edges };
}

export function sourcePassages(context: AuthorContext): SourcePassage[] {
  const passages: SourcePassage[] = [];
  for (const source of context.sources) {
    const parts = source.text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
      passages.push({ id: `${source.id}#${index + 1}`, sourceId: source.id, kind: source.kind,
        title: source.title, text: parts[index] });
    }
  }
  return passages;
}

export function planTargets(context: AuthorContext): Record<TestType, Target[]> {
  const { story, nodes, edges, criteria } = context;
  const sourceIds = new Set([story.id, ...(story.parents ?? []).map((item) => item.id)]);
  const related = nodes.filter((node) => isRelevant(node, sourceIds, edges));
  const nodeTarget = (node: Node): Target => ({ id: node.id, label: `${node.nodeType} ${node.canonicalName}`, detail: node.description ?? node.canonicalName, nodeId: node.id });
  const functional: Target[] = criteria.map((criterion) => ({ id: `${story.id} ${criterion.label}`, label: criterion.label,
    detail: criterion.text, criterion: criterion.label }));
  for (const node of related.filter((item) => ["BusinessRule", "Requirement", "Constraint", "StateTransition"].includes(item.nodeType))) functional.push(nodeTarget(node));
  if (!functional.length) functional.push({ id: story.id, label: story.title, detail: story.text });
  const surfaces = related.filter((item) => isRelevant(item, new Set([story.id]), edges) && [
    "Application", "Service", "Interface", "Operation", "API", "Endpoint",
    "DataStore", "Database", "DataContract", "DomainEvent", "MessageTopic", "IntegrationFlow",
  ].includes(item.nodeType));
  const journeys = related.filter((item) => ["Capability", "Workflow", "WorkflowStep", "Process", "StateTransition"].includes(item.nodeType));
  const smokeJourneys = related.filter((item) => ["Capability", "Workflow", "Process"].includes(item.nodeType));
  const regression: Target[] = [];
  for (const node of related.filter((item) => [
    "Interface", "Operation", "Endpoint", "Service", "Module", "Component",
    "DataStore", "Database", "DataTable", "DataContract", "IntegrationFlow", "BusinessRule", "StateTransition",
  ].includes(item.nodeType))) {
    const older = edges.some((edge) => connected(node.id, edge) && nodes.some((candidate) => candidate.id === other(node.id, edge)
      && candidate.nodeType === "Story" && candidate.id !== story.id && candidate.properties.iterationPath !== story.iterationPath));
    if (older) regression.push(nodeTarget(node));
  }
  return { functional, integration: surfaces.map(nodeTarget), e2e: journeys.map(nodeTarget), regression,
    sanity: [{ id: story.id, label: story.title, detail: story.text }], smoke: smokeJourneys.map(nodeTarget) };
}

function evidenceSupported(quote: string, sourceId: string, context: AuthorContext): boolean {
  const normalized = normalizeName(quote);
  if (normalized.length < 4) return false;
  const source = sourcePassages(context).find((item) => item.id === sourceId);
  return Boolean(source && normalizeName(source.text).includes(normalized));
}

function existingCriteria(properties: Record<string, unknown>): string[] {
  const value = properties.acceptanceCriteria ?? properties.coversAcceptanceCriteria;
  if (!Array.isArray(value)) return [];
  const labels: string[] = [];
  for (const item of value) {
    if (typeof item === "string") labels.push(item.toUpperCase());
    else if (item && typeof item === "object" && "label" in item && typeof item.label === "string") labels.push(item.label.toUpperCase());
  }
  return labels;
}

async function ask<T>(model: ModelClient, schema: z.ZodType<T>, schemaName: string, prompt: string, validate: (value: T) => string[]): Promise<T> {
  return startActiveObservation(`validate-${schemaName}`, async (observation) => {
    observation.update({ input: { stage: prompt.slice(0, 90), schemaName } });
    let feedback = "";
    let lastProblems: string[] = [];
    const output = { name: schemaName, schema: z.toJSONSchema(schema) as Record<string, unknown> };
    for (let attempt = 0; attempt < 3; attempt++) {
      console.error(`[test-author] ${prompt.slice(0, 90)} (attempt ${attempt + 1}/3)`);
      const response = await model.json(prompt + feedback, output);
      const parsed = schema.safeParse(response);
      const problems = parsed.success ? validate(parsed.data) : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
      if (parsed.success && !problems.length) {
        observation.update({ output: { accepted: true, attempts: attempt + 1 } });
        return parsed.data;
      }
      lastProblems = problems;
      observation.update({ level: "WARNING", statusMessage: `${problems.length} validation issue(s) on attempt ${attempt + 1}`,
        metadata: { attempt: attempt + 1, validationErrors: problems.slice(0, 24) } });
      console.error(`[test-author] ${schemaName} rejected: ${problems.length} validation issue(s)`);
      feedback = designRetryPrompt(response, problems);
    }
    observation.update({ level: "ERROR", statusMessage: "Design validation failed after 3 attempts",
      output: { accepted: false, validationErrors: lastProblems.slice(0, 24) } });
    throw new Error(`Model did not return a valid design after 3 attempts: ${lastProblems.slice(0, 24).join("; ")}`);
  }, { asType: "chain" });
}

function artifact(kind: Artifact["kind"], name: string, storyId: string, parentId: string | undefined, content: Record<string, unknown>): Artifact {
  return { id: semanticNodeId(kind, name), kind, name, storyId, parentId, content, hash: hash(content) };
}

export async function authorStory(context: AuthorContext, model: ModelClient): Promise<{ report: AuthorReport; artifacts: Artifact[] }> {
  const targets = planTargets(context);
  const candidates = TEST_TYPES.filter((testType) => targets[testType].length > 0);
  const ids = new Set([context.story.id, ...(context.story.parents ?? []).map((item) => item.id), ...context.nodes.map((node) => node.id)]);
  const nodes = new Map(context.nodes.map((node) => [node.id, node]));
  const source = sourcePassages(context).map((item) => `${item.kind} ${item.sourceId} passage ${item.id}: ${item.title}\n${item.text}`).join("\n\n");
  const failedBatches: string[] = [];
  let plan: z.infer<typeof PlanSchema>;
  try {
    plan = await ask(model, PlanSchema, "test_plan", testPlanPrompt(context, candidates, source, targets), (draft) => {
    const problems = draft.inScope.filter((item) => !ids.has(item.nodeId)).map((item) => `Unknown inScope id ${item.nodeId}`);
    for (const type of candidates) {
      const count = draft.approaches.filter((item) => item.testType === type).length + draft.inapplicable.filter((item) => item.testType === type).length;
      if (count !== 1) problems.push(`Choose one approach or inapplicable reason for ${type}`);
    }
    for (const item of draft.approaches) if (!candidates.includes(item.testType)) problems.push(`Unsupported approach ${item.testType}`);
    for (const item of draft.inapplicable) if (!candidates.includes(item.testType)) problems.push(`Unsupported inapplicable type ${item.testType}`);
    if (!draft.approaches.length) problems.push("At least one test approach is required");
    return problems;
    });
  } catch (error) {
    failedBatches.push(`plan: ${error instanceof Error ? error.message : String(error)}`);
    plan = { objective: context.story.title, scopeSummary: "Plan generation failed", inScope: [], outOfScope: [],
      approaches: candidates.map((testType) => ({ testType, purpose: "Generation failed", focus: "Generation failed", entryCriteria: ["Resolve plan generation"], exitCriteria: ["Resolve plan generation"] })),
      risks: [], environments: [], testDataNeeds: [], assumptions: [], openQuestions: [], inapplicable: [] };
  }
  const active = TEST_TYPES.filter((testType) => plan.approaches.some((item) => item.testType === testType));
  const inapplicable = TEST_TYPES.filter((testType) => !active.includes(testType));
  const inapplicableReasons: Partial<Record<TestType, string>> = {};
  for (const testType of inapplicable) {
    inapplicableReasons[testType] = plan.inapplicable.find((item) => item.testType === testType)?.reason ?? "No supported target in the approved context";
  }
  const scenarios = new Map<string, Scenario>();
  const cases = new Map<string, Case>();
  const usedNames = new Set(context.nodes.filter((node) => ["TestScenario", "TestCase"].includes(node.nodeType)).map((node) => `${node.nodeType}:${normalizeName(node.canonicalName)}`));
  const suites: AuthorReport["suites"] = [];
  const gaps: string[] = [];
  const criteria = new Set(context.criteria.map((item) => item.label));

  for (const testType of active) {
    const batch = targets[testType];
    const coverIds = context.nodes.filter((node) => NodeTypeSchema.safeParse(node.nodeType).success &&
      isSemanticEdgeAllowed("COVERS", "TestScenario", node.nodeType as z.infer<typeof NodeTypeSchema>)).map((node) => node.id);
    const exerciseIds = context.nodes.filter((node) => NodeTypeSchema.safeParse(node.nodeType).success &&
      isSemanticEdgeAllowed("EXERCISES", "TestScenario", node.nodeType as z.infer<typeof NodeTypeSchema>)).map((node) => node.id);
    const candidateScenarios = context.nodes.filter((node) => node.nodeType === "TestScenario" &&
      context.edges.some((edge) => connected(node.id, edge) && batch.some((target) =>
        target.nodeId === other(node.id, edge) || target.id === other(node.id, edge) ||
        (target.criterion && other(node.id, edge) === context.story.id && existingCriteria(node.properties).includes(target.criterion)))));
    const priorScenarios = [...scenarios.values()].filter((scenario) =>
      batch.some((target) => scenario.targetIds.includes(target.id)));
    const candidateIds = new Set([...candidateScenarios.map((item) => item.id), ...priorScenarios.map((item) => item.id)]);
    let draft: z.infer<typeof ScenarioSchema>;
    try {
      draft = await ask(model, ScenarioSchema, "test_scenarios", testScenariosPrompt(testType, context, coverIds, exerciseIds, batch, candidateScenarios, priorScenarios, source,
        sourcePassages(context).map((item) => item.id)), (value) => {
        const problems: string[] = [];
        const covered = new Set<string>();
        const names = new Set<string>();
        for (const item of value.reusedScenarios) {
          if (!candidateIds.has(item.id)) problems.push(`Unknown reusable scenario ${item.id}`);
          for (const id of item.targetIds) {
            if (!batch.some((target) => target.id === id)) problems.push(`Unknown target ${id}; valid target IDs: ${batch.map((target) => target.id).join(", ")}`);
            else if (!scenarios.get(item.id)?.targetIds.includes(id) && !context.edges.some((edge) => connected(item.id, edge) && (other(item.id, edge) === id ||
              (batch.find((target) => target.id === id)?.criterion && other(item.id, edge) === context.story.id &&
                existingCriteria(nodes.get(item.id)?.properties ?? {}).includes(batch.find((target) => target.id === id)!.criterion!))))) problems.push(`Scenario ${item.id} has no approved link to ${id}`);
            else covered.add(id);
          }
        }
        for (const item of value.newScenarios) {
          const key = `TestScenario:${normalizeName(item.name)}`;
          if (usedNames.has(key) || names.has(key)) problems.push(`Duplicate scenario name ${item.name}`);
          names.add(key);
          if (!evidenceSupported(item.evidence, item.sourceId, context)) problems.push(`Unsupported scenario evidence ${item.sourceId}: ${item.evidence}`);
          for (const id of item.targetIds) {
            if (!batch.some((target) => target.id === id)) problems.push(`Unknown target ${id}; valid target IDs: ${batch.map((target) => target.id).join(", ")}`);
            else covered.add(id);
            const target = batch.find((candidate) => candidate.id === id);
            if (target?.nodeId && ["integration", "e2e", "regression", "smoke"].includes(testType)
              && ![...item.coversNodeIds, ...item.exercisesNodeIds].includes(target.nodeId)) {
              problems.push(`Scenario ${item.name} must cover or exercise ${target.nodeId}`);
            }
            if (target?.nodeId && testType === "functional" && !item.coversNodeIds.includes(target.nodeId)) {
              problems.push(`Functional scenario ${item.name} must cover ${target.nodeId}`);
            }
          }
          for (const label of item.acceptanceCriteria) if (!criteria.has(label.toUpperCase())) problems.push(`Unknown criterion ${label}`);
          for (const [field, type, references] of [["covers", "COVERS", item.coversNodeIds], ["exercises", "EXERCISES", item.exercisesNodeIds]] as const) {
            for (const id of references) {
              const node = nodes.get(id);
              const nodeType = NodeTypeSchema.safeParse(node?.nodeType);
              if (!nodeType.success || !isSemanticEdgeAllowed(type, "TestScenario", nodeType.data)) problems.push(`Invalid ${field} node ${id}`);
            }
          }
        }
        for (const target of batch) if (!covered.has(target.id)) problems.push(`Uncovered target ${target.id}`);
        return problems;
      });
    } catch (error) {
      failedBatches.push(`${testType} scenarios: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const suite = { testType, targets: batch, scenarioIds: [] as string[], caseIds: [] as string[] };
    suites.push(suite);
    for (const reused of draft.reusedScenarios) {
      const node = nodes.get(reused.id);
      const existing = scenarios.get(reused.id) ?? { id: reused.id, name: node!.canonicalName, origin: "existingInGraph" as const,
        description: node!.description ?? "", expectedOutcome: String(node!.properties.expectedOutcome ?? ""), priority: "medium", evidence: "",
        targetIds: [], acceptanceCriteria: [], coversNodeIds: [], exercisesNodeIds: [], testTypes: [] };
      existing.targetIds.push(...reused.targetIds.filter((id) => !existing.targetIds.includes(id)));
      if (!existing.testTypes.includes(testType)) existing.testTypes.push(testType);
      scenarios.set(existing.id, existing);
      suite.scenarioIds.push(existing.id);
    }
    for (const item of draft.newScenarios) {
      const id = semanticNodeId("TestScenario", item.name);
      usedNames.add(`TestScenario:${normalizeName(item.name)}`);
      const scenario: Scenario = { id, name: item.name, origin: "createdByAgent", description: item.description,
        expectedOutcome: item.expectedOutcome, priority: item.priority, evidence: item.evidence, targetIds: item.targetIds,
        sourceId: item.sourceId, category: item.category, riskRationale: item.riskRationale,
        acceptanceCriteria: item.acceptanceCriteria.map((label) => label.toUpperCase()), coversNodeIds: item.coversNodeIds,
        exercisesNodeIds: item.exercisesNodeIds, testTypes: [testType] };
      scenarios.set(id, scenario);
      suite.scenarioIds.push(id);
    }
    for (const id of suite.scenarioIds) {
      const scenario = scenarios.get(id)!;
      const existingCases = context.nodes.filter((node) => node.nodeType === "TestCase" && node.properties.outdated !== true && context.edges.some((edge) =>
        edge.relationshipType === "COVERS" && edge.sourceId === node.id && edge.targetId === id));
      if (cases.size && [...cases.values()].some((item) => item.scenarioId === id)) {
        for (const item of cases.values()) if (item.scenarioId === id) {
          if (!item.testTypes.includes(testType)) item.testTypes.push(testType);
          suite.caseIds.push(item.id);
        }
        continue;
      }
      try {
        const validateIds = context.nodes.filter((node) => NodeTypeSchema.safeParse(node.nodeType).success &&
          isSemanticEdgeAllowed("VALIDATES", "TestCase", node.nodeType as z.infer<typeof NodeTypeSchema>)).map((node) => node.id);
        const caseExerciseIds = context.nodes.filter((node) => NodeTypeSchema.safeParse(node.nodeType).success &&
          isSemanticEdgeAllowed("EXERCISES", "TestCase", node.nodeType as z.infer<typeof NodeTypeSchema>)).map((node) => node.id);
        const result = await ask(model, CaseSchema, "test_cases", testCasesPrompt(testType, scenario, context.criteria, existingCases, source,
          validateIds, caseExerciseIds), (value) => {
          const problems: string[] = [];
          const names = new Set<string>();
          for (const reused of value.reusedCaseIds) if (!existingCases.some((item) => item.id === reused)) problems.push(`Unknown reusable case ${reused}`);
          for (const item of value.newCases) {
            const key = `TestCase:${normalizeName(item.name)}`;
            if (usedNames.has(key) || names.has(key)) problems.push(`Duplicate case name ${item.name}`);
            names.add(key);
            if (!evidenceSupported(item.evidence, item.sourceId, context)) problems.push(`Unsupported case evidence ${item.sourceId}: ${item.evidence}`);
            for (const step of item.steps) {
              if (!evidenceSupported(step.expectedResultEvidence, item.sourceId, context)) problems.push(`Unsupported expected result evidence ${item.sourceId}: ${step.expectedResultEvidence}`);
              if (/^(works? correctly|success(?:ful(?:ly)?)?|expected (?:result|outcome) is observed|as expected)$/i.test(step.expectedResult.trim())) {
                problems.push(`Unobservable expected result for ${item.name}`);
              }
            }
            if (item.route) {
              const routeText = `${item.route.method} ${item.route.path}`;
              if (!normalizeName(source).includes(normalizeName(routeText)) ||
                !source.includes(String(item.route.expectedStatus)) ||
                item.steps.length !== 1 || item.steps[0].expectedResult !== `HTTP ${item.route.expectedStatus}` ||
                !item.automationCandidate) problems.push(`Unsupported executable route for ${item.name}`);
            }
            for (const label of item.acceptanceCriteria) if (!criteria.has(label.toUpperCase())) problems.push(`Unknown criterion ${label}`);
            for (const [type, references] of [["VALIDATES", item.validatesNodeIds], ["EXERCISES", item.exercisesNodeIds]] as const) {
              for (const ref of references) {
                const node = nodes.get(ref);
                const nodeType = NodeTypeSchema.safeParse(node?.nodeType);
                if (!nodeType.success || !isSemanticEdgeAllowed(type, "TestCase", nodeType.data)) {
                  const allowed = type === "VALIDATES" ? validateIds : caseExerciseIds;
                  problems.push(`Invalid ${type} node ${ref}; allowed IDs: ${allowed.join(", ") || "none"}`);
                }
              }
            }
          }
          if (!value.reusedCaseIds.length && !value.newCases.length) problems.push(`No case covers scenario ${id}`);
          return problems;
        });
        for (const reused of result.reusedCaseIds) {
          const node = nodes.get(reused)!;
          const prior = cases.get(reused) ?? { id: reused, name: node.canonicalName, origin: "existingInGraph" as const,
            scenarioId: id, testTypes: [], acceptanceCriteria: existingCriteria(node.properties) };
          if (!prior.testTypes.includes(testType)) prior.testTypes.push(testType);
          cases.set(reused, prior);
          suite.caseIds.push(reused);
        }
        for (const item of result.newCases) {
          const caseId = semanticNodeId("TestCase", item.name);
          usedNames.add(`TestCase:${normalizeName(item.name)}`);
          cases.set(caseId, { id: caseId, name: item.name, origin: "createdByAgent", scenarioId: id, testTypes: [testType],
            objective: item.objective, caseKind: item.caseKind, priority: item.priority, preconditions: item.preconditions,
            testData: item.testData, steps: item.steps, acceptanceCriteria: item.acceptanceCriteria.map((label) => label.toUpperCase()),
            validatesNodeIds: item.validatesNodeIds, exercisesNodeIds: item.exercisesNodeIds,
            automation: { candidate: item.automationCandidate, notes: item.automationNotes }, evidence: item.evidence, sourceId: item.sourceId, route: item.route });
          suite.caseIds.push(caseId);
        }
      } catch (error) {
        failedBatches.push(`${testType} cases for ${scenario.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const authoredScenarios = [...scenarios.values()];
  const authoredCases = [...cases.values()];
  const covered = new Set(authoredCases.flatMap((item) => item.acceptanceCriteria ?? []));
  const uncovered = context.criteria.filter((item) => !covered.has(item.label)).map((item) => item.label);
  for (const label of uncovered) gaps.push(`No test case covers ${context.story.id} ${label}`);
  for (const scenario of authoredScenarios) if (!authoredCases.some((item) => item.scenarioId === scenario.id)) gaps.push(`No test case covers scenario ${scenario.id}`);
  for (const suite of suites) {
    const coveredTargets = new Set(suite.scenarioIds.flatMap((id) => scenarios.get(id)?.targetIds ?? []));
    for (const target of suite.targets) if (!coveredTargets.has(target.id)) gaps.push(`${suite.testType} target ${target.id} is uncovered`);
  }
  const byTestType = Object.fromEntries(TEST_TYPES.map((type) => [type, authoredCases.filter((item) => item.testTypes.includes(type)).length])) as Record<TestType, number>;
  const report: AuthorReport = { plan, suites, scenarios: authoredScenarios, cases: authoredCases, inapplicable, inapplicableReasons, gaps, failedBatches,
    coverage: { acceptanceCriteria: { total: context.criteria.length, covered: context.criteria.length - uncovered.length, uncovered }, byTestType } };
  return { report, artifacts: report.gaps.length || report.failedBatches.length ? [] : buildArtifacts(context.story, report) };
}

export function buildArtifacts(story: Story, report: AuthorReport): Artifact[] {
  const output: Artifact[] = [];
  const plan = artifact("TestPlan", `${story.id} test plan`, story.id, undefined,
    { ...report.plan, inapplicableReasons: report.inapplicableReasons, coverage: report.coverage });
  output.push(plan);
  const createdScenarios = new Set<string>();
  const createdCases = new Set<string>();
  for (const suite of report.suites) {
    const approach = report.plan.approaches.find((item) => item.testType === suite.testType)!;
    const reusedScenarioIds = suite.scenarioIds.filter((id) => report.scenarios.find((item) => item.id === id)?.origin === "existingInGraph" || createdScenarios.has(id));
    const reusedCaseIds = suite.caseIds.filter((id) => report.cases.find((item) => item.id === id)?.origin === "existingInGraph" || createdCases.has(id));
    const suiteArtifact = artifact("TestSuite", `${story.id} ${suite.testType} suite`, story.id, plan.id,
      { ...approach, targetIds: suite.targets.map((item) => item.id), reusedScenarioIds, reusedCaseIds });
    output.push(suiteArtifact);
    for (const scenario of report.scenarios.filter((item) => suite.scenarioIds.includes(item.id) && item.origin === "createdByAgent" && !createdScenarios.has(item.id))) {
      output.push(artifact("TestScenario", scenario.name, story.id, suiteArtifact.id, { ...scenario }));
      createdScenarios.add(scenario.id);
    }
    for (const testCase of report.cases.filter((item) => suite.caseIds.includes(item.id) && item.origin === "createdByAgent" && !createdCases.has(item.id))) {
      const expected = testCase.steps?.length === 1 ? testCase.steps[0].expectedResult : undefined;
      output.push(artifact("TestCase", testCase.name, story.id, testCase.scenarioId, { ...testCase, expected }));
      createdCases.add(testCase.id);
    }
  }
  return output;
}
