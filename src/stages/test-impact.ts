import { z } from "zod";
import { hash, type Artifact, type Story } from "../core/runtime.js";
import type { GraphStore, ModelClient } from "../contracts.js";

export type ManagedCase = { id: string; name: string; storyIds: string[]; dependsOnCaseIds?: string[]; content: Record<string, unknown>; contentHash: string };
export type ImpactGap = { id: string; name: string; suite?: string; confidence: number; reason: string; evidence: string; sourceText: string; storyId: string; caseId?: string };
export type ImpactRevision = { artifact: Artifact; baseHash: string; confidence: number; reason: string; evidence: string; sourceText: string };

const Assessment = z.object({ affected: z.boolean(), confidence: z.number().min(0).max(1), reason: z.string().min(1),
  evidence: z.string(), changes: z.array(z.object({ index: z.number().int().min(0), action: z.string().min(1).optional(),
    expectedResult: z.string().min(1).optional(), expectedResultEvidence: z.string().min(1).optional() })).default([]),
  gap: z.string().optional(), dependsOnCaseIds: z.array(z.string()).default([]) });

function supported(quote: string, text: string): boolean {
  return quote.trim().length >= 4 && text.toLowerCase().replace(/\s+/g, " ").includes(quote.toLowerCase().replace(/\s+/g, " ").trim());
}

function ownerStory(item: ManagedCase, fallback: string): string {
  return typeof item.content.ownerStoryId === "string" ? item.content.ownerStoryId : item.storyIds[0] ?? fallback;
}

function suite(item: ManagedCase): string {
  const types = item.content.testTypes;
  return Array.isArray(types) ? types.filter((type): type is string => typeof type === "string").join(", ") : String(item.content.testType ?? "unspecified");
}

export async function assessTestImpact(story: Story, previous: Story, graph: GraphStore, model: ModelClient): Promise<{
  revisions: ImpactRevision[]; gaps: ImpactGap[]; checked: number;
}> {
  if (!graph.managedTestCases) throw new Error("Graph test-case impact search is unavailable");
  const cases = await graph.managedTestCases();
  const oldText = [previous.text, ...(previous.parents ?? []).map((parent) => parent.text)].join("\n\n");
  const currentText = [story.text, ...(story.parents ?? []).map((parent) => parent.text)].join("\n\n");
  const revisions: ImpactRevision[] = [];
  const gaps: ImpactGap[] = [];
  const checked = new Set<string>();
  const affected = new Set<string>();
  const rechecked = new Set<string>();
  // Scan every graph-managed case. Lexical matching alone misses renamed behavior and indirect reuse.
  const pending = [...cases].sort((left, right) => Number(right.storyIds.includes(story.id)) - Number(left.storyIds.includes(story.id)));
  while (pending.length) {
    const item = pending.shift()!;
      if (checked.has(item.id)) continue;
      checked.add(item.id);
      const prompt = `Decide whether this existing test case must change because of the Story revision. Check direct behavior, explicit graph dependencies, and whether a step reuses an affected case. Similar wording alone is insufficient. Return JSON with affected, confidence, reason, one exact evidence quote from the NEW Story, changes (only changed step indices, with action, expectedResult, expectedResultEvidence), dependsOnCaseIds (only confirmed affected case IDs), and optional gap if the safe new behavior is unknown. Preserve all unrelated steps and assertions.\n`
        + `Previous source: ${oldText}\nCurrent source: ${currentText}\nExisting case: ${JSON.stringify(item)}\nAlready affected cases: ${JSON.stringify([...affected])}`;
      let draft: z.infer<typeof Assessment>;
      try {
        draft = Assessment.parse(await model.json(prompt, { name: "test_impact", schema: z.toJSONSchema(Assessment) as Record<string, unknown> }));
      } catch (error) {
        gaps.push({ id: `Gap:${hash(`${story.id}|${item.id}`).slice(0, 16)}`, name: item.name, suite: suite(item), confidence: 0,
          reason: `Impact assessment failed: ${error instanceof Error ? error.message : String(error)}`, evidence: "", sourceText: currentText, storyId: ownerStory(item, story.id), caseId: item.id });
        continue;
      }
      if (!draft.affected) continue;
      affected.add(item.id);
      for (const candidate of cases) {
        const retryKey = `${candidate.id}|${item.id}`;
        if (!checked.has(candidate.id) || rechecked.has(retryKey) || affected.has(candidate.id)) continue;
        const refs = [...(candidate.dependsOnCaseIds ?? []), ...(Array.isArray(candidate.content.dependsOnCaseIds) ? candidate.content.dependsOnCaseIds : [])];
        const explicitlyUses = refs.includes(item.id);
        const stepText = JSON.stringify(candidate.content.steps ?? []).toLowerCase();
        const mentions = stepText.includes(item.name.toLowerCase()) || stepText.includes(item.id.toLowerCase());
        if (explicitlyUses || mentions) {
          checked.delete(candidate.id);
          rechecked.add(retryKey);
          pending.push(candidate);
        }
      }
      const owner = ownerStory(item, story.id);
      const id = `Gap:${hash(`${story.id}|${item.id}`).slice(0, 16)}`;
      if (!supported(draft.evidence, currentText) || draft.gap || !draft.changes.length) {
        gaps.push({ id, name: item.name, suite: suite(item), confidence: draft.confidence, reason: draft.gap || draft.reason,
          evidence: draft.evidence, sourceText: currentText, storyId: owner, caseId: item.id });
        continue;
      }
      const steps = Array.isArray(item.content.steps) ? structuredClone(item.content.steps) as Array<Record<string, unknown>> : [];
      let valid = steps.length > 0;
      for (const id of draft.dependsOnCaseIds) if (id === item.id || !affected.has(id)) valid = false;
      for (const change of draft.changes) {
        if (change.index >= steps.length || !change.expectedResultEvidence || !supported(change.expectedResultEvidence, currentText)) {
          valid = false;
          break;
        }
        steps[change.index] = { ...steps[change.index], ...change };
        delete steps[change.index]!.index;
      }
      if (!valid) {
        gaps.push({ id, name: item.name, suite: suite(item), confidence: draft.confidence, reason: `Unsupported changed step: ${draft.reason}`,
          evidence: draft.evidence, sourceText: currentText, storyId: owner, caseId: item.id });
        continue;
      }
      const beforeContent = { ...item.content };
      for (const key of ["reviewer", "approvedAt", "sourceHash", "baseHash", "baseContent"]) delete beforeContent[key];
      const content = { ...beforeContent, steps,
        dependsOnCaseIds: [...new Set([...(item.dependsOnCaseIds ?? []),
          ...(Array.isArray(item.content.dependsOnCaseIds) ? item.content.dependsOnCaseIds.filter((id): id is string => typeof id === "string") : []),
          ...draft.dependsOnCaseIds])] };
      const artifact: Artifact = { id: item.id, kind: "TestCase", name: item.name, storyId: owner,
        parentId: typeof item.content.scenarioId === "string" ? item.content.scenarioId : undefined,
        content, hash: hash(content), baseHash: item.contentHash, beforeContent };
      revisions.push({ artifact, baseHash: item.contentHash, confidence: draft.confidence, reason: draft.reason, evidence: draft.evidence, sourceText: currentText });
  }
  return { revisions, gaps, checked: checked.size };
}
