import type { Story, WorkItemParent } from "../core/runtime.js";
import { EXTRACTABLE_NODE_TYPES, QA_RELATIONSHIP_TYPES, SEMANTIC_RELATIONSHIP_TYPES, type NodeType } from "../ontology/types.js";

const RELATION_TARGET_TYPE_PROMPT = [...EXTRACTABLE_NODE_TYPES, "Story"].join("|");
const RELATIONSHIP_TYPE_PROMPT = [...SEMANTIC_RELATIONSHIP_TYPES, ...QA_RELATIONSHIP_TYPES].join("|");
const RELATIONSHIP_GUIDANCE = "Choose the relationship from its source and target types, not just its confidence. Scope lists and module labels MENTION their targets; they do not prove IMPLEMENTS, PART_OF, or USES. Do not turn a Feature title or a broad scope item into a Component. A Story can MENTION an Endpoint or BusinessEntity and TRACES_TO an explicitly named TestCase; only a system component EXPOSES an Endpoint, and only a TestCase or TestScenario VALIDATES. Use Application for a named external system, Interface for a non-API boundary, Operation for a job or handler, DataStore for a cache or file store, Database for a database, DataContract for a named payload or schema, and IntegrationFlow for an explicitly described hop. Name flows, workflow steps and state transitions with their owning system or workflow when the source states it; common names such as Sync or Confirm are ambiguous. Use SystemElement only when no more specific technical type fits. A named database table is DataTable, not Database. Do not infer calls, subscriptions, reads, writes or flow direction from co-occurrence. Use CHANGES only when the work item explicitly changes the target.";
const CONNECTION_GUIDANCE = "CALLS means a synchronous invocation. PUBLISHES names the producer; CARRIES links a topic to an event or contract; SUBSCRIBES_TO names the consumer. READS_FROM and WRITES_TO concern persisted data. MAPS_TO is a stated data correspondence; TRANSFORMS_TO requires a stated conversion. FLOW_SOURCE and FLOW_TARGET point from one IntegrationFlow hop to its endpoints. TRIGGERS starts an activity. Use HAS_STATE, HAS_STEP and state-transition links for explicitly named business behavior.";

export const RELATIONSHIP_SHAPE_FEEDBACK = "\nYour previous response had the wrong JSON shape. Return exactly one JSON object with a relationships array.";

export function invalidRelationshipFeedback(pairs: string[]): string {
  return `\nYour previous response used invalid source/target relationship pairs: ${pairs.join(", ")}. Replace them using the allowed type table or omit them. Return the complete corrected relationships array.`;
}

export function entityConnectionFeedback(issues: string): string {
  return `\nYour previous JSON did not match the required connections schema: ${issues}. Return the complete corrected JSON object with a connections array. Use an empty array when no connection is supported.`;
}

export function entityConnectionsPrompt(candidates: Array<{ id: string; type: NodeType; name: string }>, types: string[], sourceText: string): string {
  return `Find relationships explicitly supported by this source between candidate entities, including entities saved in earlier runs. Return {"connections":[{"sourceId":"candidate id","targetId":"candidate id","type":"allowed type","evidence":"exact short source quote","confidence":0.0,"reason":"why the full relationship is supported"}]}. Omit unsupported pairs. The quote must identify both endpoints and the action in the stated direction; explain direction in reason. A mention of both names is insufficient. For each IntegrationFlow, include FLOW_SOURCE and FLOW_TARGET only when the source identifies the respective endpoints. ${CONNECTION_GUIDANCE} Candidate entities: ${JSON.stringify(candidates)}. Relationship types: ${types.join("|")}. Source text:\n${sourceText}`;
}

export function storyRelationshipsPrompt(story: Story, source: Story | WorkItemParent, sourceType: "Epic" | "Feature" | "Story", choices: string): string {
  return `Extract relationships from ${sourceType} ${source.id} that are relevant to Story ${story.id}. The source of each relationship is ${source.id} (${sourceType}). Return {"relationships": [{"targetName":"...","targetType":"${RELATION_TARGET_TYPE_PROMPT}","type":"one valid type for targetType","evidence":"short source quote","confidence":0.0,"reason":"why the relationship is clear or ambiguous","storyIds":["${story.id}"]}]}. Valid target types and relationship types for this ${sourceType}: ${choices}. Do not infer a direct parent-to-Story relationship merely from the work-item hierarchy or general scope text; include one only if this source explicitly names the Story. ${RELATIONSHIP_GUIDANCE} For Epic and Feature sources, include only facts relevant to this Story, not every item in the parent's scope. Story context: ${story.title}. ${story.text.slice(0, 4000)} Use Story ${story.id} as the only storyIds value. Evidence must quote the source text below. For a behavioral link, quote the target and action; a name alone supports only a mention. Confidence must reflect how explicitly this source supports the complete relationship. Source text:\n${source.text}`;
}

export function documentRelationshipsPrompt(storyId: string, sourceText: string): string {
  return `Extract relationships relevant to Story ${storyId}. Return {"relationships": [{"targetName":"...","targetType":"${RELATION_TARGET_TYPE_PROMPT}","type":"${RELATIONSHIP_TYPE_PROMPT}","evidence":"short source quote","confidence":0.0,"reason":"why the relationship is clear or ambiguous","storyIds":["${storyId}"]}]}. Use only the listed relationship types. ${RELATIONSHIP_GUIDANCE} Confidence must reflect how explicitly the source supports the complete relationship. Source text:\n${sourceText.slice(0, 16000)}`;
}
