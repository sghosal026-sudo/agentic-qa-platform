import {
  BUSINESS_NODE_TYPES,
  CONTEXT_NODE_TYPES,
  NODE_TYPES,
  PLANNING_NODE_TYPES,
  QA_NODE_TYPES,
  QA_RELATIONSHIP_TYPES,
  RelationshipTypeSchema,
  SEMANTIC_RELATIONSHIP_TYPES,
  SOURCE_NODE_TYPES,
  STRUCTURAL_RELATIONSHIP_TYPES,
  SUT_NODE_TYPES,
  WORK_ITEM_NODE_TYPES,
  type NodeType,
  type RelationshipType,
  type ReviewState,
} from "./types.js";

// ---------------------------------------------------------------- descriptions

export const NODE_TYPE_DESCRIPTIONS: Record<NodeType, string> = {
  Epic: "Large body of work that groups features (source metadata)",
  Feature: "Deliverable feature that groups stories (source metadata)",
  Story: "User story (source metadata)",
  Task: "Implementation task (source metadata)",
  Sprint: "Iteration a work item is planned for (source metadata)",
  PI: "Program increment (source metadata)",

  TestPlan: "The test strategy for a sprint or release: its scope, suites and the risks it mitigates",
  TestSuite: "A group of test scenarios and cases for one test type (smoke, sanity, functional, integration, e2e, regression), e.g. WMS Sprint 1 regression suite",
  TestScenario:
    "A behaviour to validate with its expected outcome, e.g. duplicate receipt confirmation is rejected. Acceptance criteria written as checks ('X is rejected', 'X is created as draft', 'given … when … then …') are TestScenarios, not BusinessRules. Not a concrete test case: one scenario can be covered by several test cases",
  TestCase:
    "A concrete test with specific steps, inputs or expected results. Comes from test management; extract one only when the content describes an actual test case",
  TestRun: "Execution of test cases (source metadata)",
  Defect: "Bug or defect (source metadata)",

  SystemElement: "A named technical part that fits no more specific system type, such as a device or model; record its actual kind in the name or properties",
  Application: "A deployable application or external system, e.g. WMS, ERP, carrier system",
  Service: "A backend service, e.g. inventory service",
  Module: "A software module or bounded context, e.g. inbound, inventory",
  Component:
    "An internal software part inside a module or service, e.g. putaway suggestion engine. A user-facing operation such as 'Create warehouse' is a Capability, not a Component",
  Interface: "A named boundary for interaction, including a file feed, UI, command interface or API. Use API for an explicitly HTTP or service API",
  Operation: "A technical action such as a batch job, consumer handler, procedure or scheduled task. Use Endpoint for a named API route",
  API: "An API offered by a service, e.g. inventory API",
  Endpoint: "A single API operation, written as method and path when given, e.g. POST /receipts/{id}/confirm",
  DataStore: "A named persistent or shared data store such as a cache, object store, file store or search index. Use Database for a database",
  Database: "A database or schema, e.g. inventory database",
  DataTable: "A database table, named exactly as written, e.g. stock_movement",
  Field: "A column or data attribute, e.g. batch number, expiry date",
  DataContract: "A named payload, file layout or schema exchanged between parts of a system, with a version when stated",
  DomainEvent: "An event the system publishes, named exactly as written, e.g. inbound.receipt_confirmed",
  MessageTopic: "A message topic, queue or stream that carries events, e.g. inbound-events",
  IntegrationFlow: "One documented hop of data or control between two parts of a system; use separate hops for intermediaries",

  BusinessEntity: "A business object, e.g. receipt, purchase order, pallet",
  Capability: "A business capability or user-facing operation the system provides, e.g. blind receiving, create warehouse, deactivate reason code",
  Requirement: "A functional or non-functional requirement that is not itself a work item",
  BusinessRule:
    "The rule itself that the system must always enforce, e.g. a receipt can only be confirmed once. A check that the rule holds ('confirming twice is rejected') is a TestScenario",
  Constraint: "A technical or business constraint, e.g. confirm must run in one transaction",
  Workflow: "A multi-step business flow through the system, e.g. receive, put away, confirm. Not a test area: something that checks behaviour is a TestScenario",
  WorkflowStep: "A named step within a business workflow, such as validate, reserve or notify",
  Process: "A business process, e.g. inbound receiving",
  State: "A lifecycle state of an entity or workflow, e.g. receipt status confirmed",
  StateTransition: "A named change between two states when its trigger, condition or outcome matters independently",
  Role: "A user role or persona, e.g. receiving clerk",

  Concept: "A domain or technical concept, e.g. idempotency, FEFO",
  Risk: "A delivery or operational risk, e.g. partial commit on confirm",
  Environment: "A deployment or test environment",
  Release: "A release, stage or milestone",
  Team: "A team or organisational unit",
  Decision:
    "Behaviour or scope that a discussion or document states was agreed, e.g. partial receipt confirmation is out of scope for this release. Only when the content says it was agreed or decided; a point left open is an OpenQuestion",
  OpenQuestion:
    "A point the content leaves unresolved or asks to be clarified, e.g. whether a confirmed receipt can be reversed. Only when the content raises it as open; never a question the content answers",

  Document:
    "A document the knowledge was read from: a meeting transcript, SRS, mapping sheet, legacy test-case suite or other QA document (source metadata)",
};

export interface NodeCategory {
  name: string;
  description: string;
  types: readonly NodeType[];
}

export const NODE_CATEGORIES: readonly NodeCategory[] = [
  { name: "Work items", description: "Backlog items from the delivery tool. Source metadata only.", types: WORK_ITEM_NODE_TYPES },
  { name: "Planning", description: "Iterations and program increments. Source metadata only.", types: PLANNING_NODE_TYPES },
  {
    name: "Quality assurance",
    description:
      "Test plans and suites, scenarios to validate, concrete test cases, their runs and the defects they find (TestPlan → TestSuite → TestScenario → TestCase → TestRun → Defect).",
    types: QA_NODE_TYPES,
  },
  { name: "System under test (SUT)", description: "The parts of the software that are built, changed and tested.", types: SUT_NODE_TYPES },
  { name: "Business", description: "What the system must do, the rules it enforces and how work flows through it.", types: BUSINESS_NODE_TYPES },
  { name: "Context", description: "Cross-cutting concepts, risks, delivery context, and what meetings agreed or left open.", types: CONTEXT_NODE_TYPES },
  { name: "Sources", description: "Documents the knowledge was read from. Source metadata only.", types: SOURCE_NODE_TYPES },
];

// ---------------------------------------------------------------- relationship rules

/**
 * structural: only source metadata may create the edge.
 * semantic: the LLM extractor or an agent may create it.
 */
export type EdgeOrigin = "structural" | "semantic";

/** Every source type in `from` may point to every target type in `to`. */
export interface RelationshipPair {
  from: readonly NodeType[];
  to: readonly NodeType[];
  origin: EdgeOrigin;
}

export interface RelationshipRule {
  description: string;
  pairs: readonly RelationshipPair[];
}

const structural = (from: readonly NodeType[], to: readonly NodeType[]): RelationshipPair => ({ from, to, origin: "structural" });
const semantic = (from: readonly NodeType[], to: readonly NodeType[]): RelationshipPair => ({ from, to, origin: "semantic" });

const WORK_ITEMS = WORK_ITEM_NODE_TYPES;
const SUT = SUT_NODE_TYPES;
const BUSINESS = BUSINESS_NODE_TYPES;
const TEST_EXECUTION: readonly NodeType[] = ["TestCase", "TestRun", "Defect"];
/** Things data can be mapped between: a field, payload, API operation, event or business object. */
const DATA_ELEMENTS: readonly NodeType[] = ["Field", "DataTable", "DataContract", "Endpoint", "Operation", "DomainEvent", "MessageTopic", "BusinessEntity"];
const SYSTEM_PARTS: readonly NodeType[] = ["SystemElement", "Application", "Service", "Module", "Component", "Interface", "API", "Endpoint", "Operation"];
const FLOW_ENDPOINTS: readonly NodeType[] = [...SYSTEM_PARTS, "DataStore", "Database", "DataTable", "MessageTopic"];
const DATA_SOURCES: readonly NodeType[] = ["DataStore", "Database", "DataTable", "Field"];
const DATA_REPRESENTATIONS: readonly NodeType[] = ["DataContract", "DataTable", "Field", "DomainEvent", "BusinessEntity"];
const ANY: readonly NodeType[] = NODE_TYPES;

export const RELATIONSHIP_RULES: Record<RelationshipType, RelationshipRule> = {
  // ------------------------------------------------ structural
  PARENT_OF: {
    description: "Work-item hierarchy, including tasks, bugs and test cases under stories and bugs",
    pairs: [structural(["Epic", "Feature", "Story", "Defect", "PI"], ["Feature", "Story", "Task", "Defect", "TestCase", "Sprint"])],
  },
  CONTAINS: {
    description:
      "Containment. Structural when a planning container holds an item; semantic when a SUT part contains a smaller part (Application → Service → Module → Component, Database → DataTable → Field, API → Endpoint, a service or module owns its data tables), a process contains workflows and states, or a test plan contains suites and a suite contains scenarios and cases",
    pairs: [
      structural(["PI", "Sprint", "Release"], ["Sprint", ...WORK_ITEMS, "Defect"]),
      semantic(["Application"], ["SystemElement", "Service", "Module", "Component", "Interface", "API", "DataStore", "Database"]),
      semantic(["Service"], ["Module", "Component", "Interface", "Operation", "API", "Endpoint"]),
      semantic(["Module"], ["Module", "Component", "Interface", "Operation", "API", "Endpoint"]),
      semantic(["Component"], ["Component", "Operation"]),
      semantic(["Interface"], ["Operation", "API", "Endpoint"]),
      semantic(["API"], ["Endpoint"]),
      semantic(["DataStore"], ["DataTable"]),
      semantic(["Database"], ["DataTable"]),
      semantic(["DataTable", "DataContract", "BusinessEntity"], ["Field"]),
      semantic(["Process", "Workflow"], ["Workflow", "State"]),
      semantic(["Service", "Module"], ["DataTable"]),
      semantic(["TestPlan"], ["TestSuite"]),
      semantic(["TestSuite"], ["TestScenario", "TestCase"]),
    ],
  },
  PLANNED_FOR: { description: "Item is planned for an iteration", pairs: [structural([...WORK_ITEMS, "Defect"], ["Sprint", "PI", "Release"])] },
  BELONGS_TO: { description: "Sprint belongs to a program increment", pairs: [structural(["Sprint"], ["PI"])] },
  VERIFIED_BY: { description: "Item is verified by a test case (test management link)", pairs: [structural([...WORK_ITEMS, "Requirement"], ["TestCase"])] },
  TESTS: { description: "Test case tests an item (test management link)", pairs: [structural(["TestCase"], [...WORK_ITEMS, "Requirement"])] },
  EXECUTED_IN: { description: "Test case executed in a run", pairs: [structural(["TestCase"], ["TestRun"])] },
  FOUND: { description: "Run found a defect", pairs: [structural(["TestRun"], ["Defect"])] },

  // ------------------------------------------------ SUT and semantic
  USES: {
    description: "Source uses or touches a SUT part, business entity or capability, e.g. a service uses a database",
    pairs: [semantic([...WORK_ITEMS, ...SUT, "Role", "Capability", "Workflow", "Process"], [...SUT, "BusinessEntity", "Capability"])],
  },
  IMPLEMENTS: {
    description: "Source implements a capability, requirement, business rule or workflow",
    pairs: [
      semantic(
        [...WORK_ITEMS, ...SYSTEM_PARTS, "IntegrationFlow"],
        ["Capability", "Requirement", "BusinessRule", "Feature", "Workflow", "Process"]
      ),
    ],
  },
  PART_OF: {
    description: "Source is part of a larger component, entity, capability or process",
    pairs: [
      semantic(
        [...SUT, "BusinessEntity", "Capability", "Workflow", "WorkflowStep", "Process", "State", "StateTransition"],
        ["SystemElement", "Application", "Service", "Module", "Component", "Interface", "API", "DataStore", "Database", "DataTable", "BusinessEntity", "Capability", "Workflow", "Process"]
      ),
    ],
  },
  OWNS: {
    description: "A system part is responsible for a store, topic, contract or event; ownership must be stated, not inferred from access",
    pairs: [semantic(["SystemElement", "Application", "Service", "Module", "Component"], ["DataStore", "Database", "DataTable", "MessageTopic", "DataContract", "DomainEvent"])],
  },
  CALLS: {
    description: "A system part synchronously invokes another interface, operation or system part",
    pairs: [semantic(SYSTEM_PARTS, ["Application", "Service", "Interface", "API", "Endpoint", "Operation"])],
  },
  PUBLISHES: {
    description: "Source publishes a domain event or to a message topic",
    pairs: [
      semantic([...SYSTEM_PARTS, "IntegrationFlow", "Workflow", "WorkflowStep", "Process"], ["DomainEvent", "MessageTopic"]),
    ],
  },
  CARRIES: {
    description: "A topic, queue or stream carries an event or payload contract",
    pairs: [semantic(["MessageTopic"], ["DomainEvent", "DataContract"])],
  },
  SUBSCRIBES_TO: {
    description: "A system part consumes messages from a topic or subscribes to a named event",
    pairs: [semantic([...SYSTEM_PARTS, "IntegrationFlow"], ["MessageTopic", "DomainEvent"])],
  },
  READS_FROM: {
    description: "A system part or integration flow reads persisted data from a store, table or field",
    pairs: [semantic([...SYSTEM_PARTS, "IntegrationFlow"], DATA_SOURCES)],
  },
  WRITES_TO: {
    description: "A system part or integration flow writes persisted data to a store, table or field",
    pairs: [semantic([...SYSTEM_PARTS, "IntegrationFlow"], DATA_SOURCES)],
  },
  TRANSFORMS_TO: {
    description: "One data representation is transformed into another; evidence must state the conversion, not just a shared name",
    pairs: [semantic(DATA_REPRESENTATIONS, DATA_REPRESENTATIONS)],
  },
  TRIGGERS: {
    description: "An event, operation, endpoint, flow or workflow step starts a flow, step, operation or state transition",
    pairs: [semantic(["DomainEvent", "Endpoint", "Operation", "IntegrationFlow", "WorkflowStep"], ["IntegrationFlow", "Workflow", "WorkflowStep", "Operation", "StateTransition"])],
  },
  HAS_STATE: {
    description: "A business entity, process or workflow has a named lifecycle state",
    pairs: [semantic(["BusinessEntity", "Process", "Workflow"], ["State"])],
  },
  HAS_STEP: {
    description: "A process or workflow includes a named step",
    pairs: [semantic(["Process", "Workflow"], ["WorkflowStep"])],
  },
  TRANSITIONS_TO: {
    description: "A state can move to another state; use a StateTransition node when trigger or conditions need separate identity",
    pairs: [semantic(["State"], ["State"])],
  },
  FROM_STATE: {
    description: "A named transition starts in this state",
    pairs: [semantic(["StateTransition"], ["State"])],
  },
  TO_STATE: {
    description: "A named transition ends in this state",
    pairs: [semantic(["StateTransition"], ["State"])],
  },
  FLOW_SOURCE: {
    description: "An integration flow starts at this system part or data source",
    pairs: [semantic(["IntegrationFlow"], FLOW_ENDPOINTS)],
  },
  FLOW_TARGET: {
    description: "An integration flow ends at this system part or data destination",
    pairs: [semantic(["IntegrationFlow"], FLOW_ENDPOINTS)],
  },
  USES_CONTRACT: {
    description: "An interface, operation, event, topic or flow uses a named payload or file contract",
    pairs: [semantic(["IntegrationFlow", "Interface", "API", "Endpoint", "Operation", "DomainEvent", "MessageTopic"], ["DataContract"])],
  },
  DEPLOYED_IN: {
    description: "A system part or shared store is deployed in a named environment",
    pairs: [semantic([...SYSTEM_PARTS, "DataStore", "Database", "MessageTopic"], ["Environment"])],
  },
  PERFORMED_BY: {
    description: "Work, a capability or a scenario is performed by a role or team",
    pairs: [semantic([...WORK_ITEMS, "Capability", "BusinessRule", "Workflow", "WorkflowStep", "Process", "TestScenario"], ["Role", "Team"])],
  },
  HAS_RISK: {
    description: "Source is exposed to a risk",
    pairs: [semantic([...WORK_ITEMS, ...SUT, "Capability", "BusinessRule", "Requirement", "BusinessEntity", "Workflow", "Process"], ["Risk"])],
  },
  MITIGATES: {
    description: "Source reduces a risk, e.g. a guard component, a business rule, a business entity or a test. Work that removes the risk RESOLVES it",
    pairs: [
      semantic(
        [...WORK_ITEMS, ...SUT, "BusinessRule", "Constraint", "Requirement", "Capability", "BusinessEntity", "Concept", "TestPlan", "TestScenario", "TestCase"],
        ["Risk"]
      ),
    ],
  },
  CONSTRAINED_BY: {
    description: "Source must respect a constraint or business rule",
    pairs: [semantic([...WORK_ITEMS, ...SUT, "Capability", "Requirement", "BusinessEntity", "Workflow", "WorkflowStep", "Process", "State", "StateTransition"], ["Constraint", "BusinessRule"])],
  },
  DEPENDS_ON: {
    description: "Source depends on target",
    pairs: [semantic([...WORK_ITEMS, ...SUT, "Capability", "Workflow", "Process", "TestCase"], [...WORK_ITEMS, ...SUT, "Capability", "Workflow", "Process", "TestCase"])],
  },
  BLOCKS: { description: "Source blocks target", pairs: [semantic([...WORK_ITEMS, ...TEST_EXECUTION, "Risk"], [...WORK_ITEMS, ...TEST_EXECUTION])] },
  BLOCKED_BY: { description: "Source is blocked by target", pairs: [semantic([...WORK_ITEMS, ...TEST_EXECUTION], [...WORK_ITEMS, ...TEST_EXECUTION, "Risk"])] },
  INTEGRATES_WITH: {
    description: "SUT parts integrate with each other",
    pairs: [semantic(SYSTEM_PARTS, [...SYSTEM_PARTS, "MessageTopic"])],
  },
  AFFECTS: {
    description: "Source affects target, e.g. an API updates a data table, or a capability changes how a module behaves",
    pairs: [semantic([...WORK_ITEMS, ...TEST_EXECUTION, ...SUT, "Risk", "Constraint", "BusinessRule", "Capability", "Workflow", "Process"], ANY)],
  },
  IMPACTS: { description: "Source has an impact on target", pairs: [semantic(ANY, ANY)] },
  SUPPORTS: {
    description: "Source supports target",
    pairs: [
      semantic(
        [...SUT, "Capability", "BusinessEntity", "Requirement", "BusinessRule", "Concept", "Workflow", "Process"],
        ["Capability", "BusinessEntity", "Requirement", "Workflow", "Process", ...WORK_ITEMS]
      ),
    ],
  },
  RELATES_TO: {
    description: "Generic association. Also holds extracted relationships that do not fit the ontology, kept for review with properties.suggestedType",
    pairs: [semantic(ANY, ANY)],
  },
  MENTIONS: { description: "Source text refers to target", pairs: [semantic(ANY, ANY)] },
  EXPOSES: {
    description:
      "A system part exposes an interface, API or operation; an API or interface exposes its operations. A work item never exposes anything",
    pairs: [semantic(["SystemElement", "Application", "Service", "Module", "Component"], ["Interface", "API", "Endpoint", "Operation"]), semantic(["Interface", "API"], ["Endpoint", "Operation"])],
  },
  CHANGES: {
    description:
      "A work item changes a SUT part or business rule. Use only when the source explicitly or strongly indicates the change; otherwise prefer USES, AFFECTS or TRACES_TO",
    pairs: [semantic(["Story", "Feature", "Task", "Defect"], [...SUT, "BusinessRule", "Capability", "Requirement", "BusinessEntity", "Workflow", "WorkflowStep", "Process", "State", "StateTransition"])],
  },

  RESOLVES: {
    description:
      "A work item removes a risk, so the risk no longer applies from that item's sprint on. Use only when the content says the risk is removed, eliminated, resolved or no longer applies; a change that only reduces a risk is MITIGATES",
    pairs: [semantic([...WORK_ITEMS, "Defect"], ["Risk"])],
  },

  // ------------------------------------------------ documents
  DESCRIBES: {
    description:
      "A document defines or specifies the target: an SRS section specifying a business rule, a mapping sheet defining a data mapping, a legacy test suite describing a test case. A document that only discusses something MENTIONS it",
    pairs: [semantic(["Document"], ANY)],
  },
  CONCERNS: {
    description: "A decision or open question is about the target: the rule, endpoint, table, workflow or work item it settles or leaves open",
    pairs: [semantic(["Decision", "OpenQuestion"], ANY)],
  },
  MAPS_TO: {
    description:
      "Data on the source side maps to data on the target side, e.g. legacy column inventory.qty maps to stock_movement.quantity. A stated transformation, default or validation rule goes in the evidence quote",
    pairs: [semantic(DATA_ELEMENTS, DATA_ELEMENTS)],
  },

  // ------------------------------------------------ QA traceability
  COVERS: {
    description: "A test case covers a test scenario; a test scenario covers a requirement, capability, business rule, constraint or workflow",
    pairs: [
      semantic(["TestCase"], ["TestScenario"]),
      semantic(["TestScenario"], ["Requirement", "Capability", "BusinessRule", "Constraint", "Workflow", "WorkflowStep", "Process", "StateTransition"]),
    ],
  },
  VALIDATES: {
    description: "A test case or test scenario checks that a requirement, business rule or constraint holds",
    pairs: [semantic(["TestCase", "TestScenario"], ["Requirement", "BusinessRule", "Constraint"])],
  },
  EXERCISES: {
    description:
      "A test case or scenario runs against a part of the SUT or checks a data field or business entity. Only tests exercise: a component that reads or writes a table USES or AFFECTS it, and an endpoint or component that enforces a business rule IMPLEMENTS the rule",
    pairs: [
      semantic(
        ["TestCase", "TestScenario"],
        [...SUT, "BusinessEntity", "Workflow", "WorkflowStep", "State", "StateTransition"]
      ),
    ],
  },
  TRACES_TO: {
    description:
      "Generic traceability link between backlog, requirements, tests and the SUT when no more specific relationship is justified; business entities, workflows and processes trace to the work items that describe them, and test plans, suites, scenarios and cases to the sprint, PI or release they are planned for",
    pairs: [
      semantic(
        [...WORK_ITEMS, ...QA_NODE_TYPES, "Requirement", "Capability", "BusinessRule", "Constraint"],
        [...WORK_ITEMS, ...QA_NODE_TYPES, ...SUT, ...BUSINESS]
      ),
      semantic(["BusinessEntity", "Workflow", "Process"], WORK_ITEMS),
      semantic(QA_NODE_TYPES, ["Sprint", "PI", "Release"]),
    ],
  },
};

export interface RelationshipGroup {
  name: string;
  description: string;
  types: readonly RelationshipType[];
}

export const RELATIONSHIP_GROUPS: readonly RelationshipGroup[] = [
  { name: "Structural", description: "Created from source metadata. CONTAINS also has semantic SUT pairs.", types: STRUCTURAL_RELATIONSHIP_TYPES },
  { name: "SUT and semantic", description: "Extracted from content: how work items, the SUT and business knowledge relate.", types: SEMANTIC_RELATIONSHIP_TYPES },
  { name: "QA traceability", description: "Extracted from content: how tests trace to scenarios, requirements, rules and the SUT.", types: QA_RELATIONSHIP_TYPES },
];

/** Relationship used when an extracted relationship does not fit the ontology. */
export const FALLBACK_RELATIONSHIP_TYPE = "RELATES_TO" satisfies RelationshipType;

// ---------------------------------------------------------------- checks

const pairMatches = (pair: RelationshipPair, fromType: NodeType, toType: NodeType): boolean =>
  pair.from.includes(fromType) && pair.to.includes(toType);

/** True when any rule pair (structural or semantic) allows this edge. */
export function isRelationshipAllowed(type: RelationshipType, fromType: NodeType, toType: NodeType): boolean {
  return RELATIONSHIP_RULES[type].pairs.some((pair) => pairMatches(pair, fromType, toType));
}

/** True when the LLM extractor or an agent may create this edge. */
export function isSemanticEdgeAllowed(type: RelationshipType, fromType: NodeType, toType: NodeType): boolean {
  return RELATIONSHIP_RULES[type].pairs.some((pair) => pair.origin === "semantic" && pairMatches(pair, fromType, toType));
}

/** True when only source metadata may create this edge, e.g. Sprint CONTAINS Story (but not Service CONTAINS Module). */
export function isStructuralEdge(type: RelationshipType, fromType: NodeType, toType: NodeType): boolean {
  const pairs = RELATIONSHIP_RULES[type].pairs;
  return (
    pairs.some((pair) => pair.origin === "structural" && pairMatches(pair, fromType, toType)) &&
    !pairs.some((pair) => pair.origin === "semantic" && pairMatches(pair, fromType, toType))
  );
}

/** A relationship name as a type-style key: "part of" and "part-of" become PART_OF. */
export const relationshipKey = (raw: string): string => raw.trim().toUpperCase().replace(/[\s-]+/g, "_");

/** Common extractor spelling or tense variants that mean an existing ontology relationship. */
const RELATIONSHIP_TYPE_ALIASES: Readonly<Record<string, RelationshipType>> = {
  IMPLEMENT: "IMPLEMENTS",
  IMPLEMENTES: "IMPLEMENTS",
  CONSUMES: "SUBSCRIBES_TO",
  LISTENS_TO: "SUBSCRIBES_TO",
  READS: "READS_FROM",
  WRITES: "WRITES_TO",
};

/** "depends on", "has-risk" and known aliases become canonical ontology types; unknown names return undefined. */
export function normalizeRelationshipType(raw: string): RelationshipType | undefined {
  const key = relationshipKey(raw);
  const parsed = RelationshipTypeSchema.safeParse(key);
  return parsed.success ? parsed.data : RELATIONSHIP_TYPE_ALIASES[key];
}

/** Names that read an ontology type backwards: "rule CONSTRAINS table" means "table CONSTRAINED_BY rule". */
export const INVERSE_RELATIONSHIP_NAMES: Readonly<Record<string, RelationshipType>> = {
  CONSTRAINS: "CONSTRAINED_BY",
  IMPLEMENTED_BY: "IMPLEMENTS",
  USED_BY: "USES",
  OWNED_BY: "OWNS",
  CALLED_BY: "CALLS",
  PUBLISHED_BY: "PUBLISHES",
  CARRIED_BY: "CARRIES",
  SUBSCRIBED_BY: "SUBSCRIBES_TO",
  READ_BY: "READS_FROM",
  WRITTEN_BY: "WRITES_TO",
  TRANSFORMED_FROM: "TRANSFORMS_TO",
  TRIGGERED_BY: "TRIGGERS",
  EXPOSED_BY: "EXPOSES",
  CHANGED_BY: "CHANGES",
  PERFORMS: "PERFORMED_BY",
  MITIGATED_BY: "MITIGATES",
  DEPENDED_ON_BY: "DEPENDS_ON",
  REQUIRED_BY: "DEPENDS_ON",
  AFFECTED_BY: "AFFECTS",
  IMPACTED_BY: "IMPACTS",
  SUPPORTED_BY: "SUPPORTS",
  HAS_PART: "PART_OF",
  CONTAINED_IN: "CONTAINS",
  COVERED_BY: "COVERS",
  VALIDATED_BY: "VALIDATES",
  EXERCISED_BY: "EXERCISES",
  RESOLVED_BY: "RESOLVES",
  DESCRIBED_BY: "DESCRIBES",
  MAPPED_FROM: "MAPS_TO",
};

/**
 * Types that mean the same for particular endpoints: a test case that "COVERS" a business rule VALIDATES it, and a
 * test case that "VALIDATES" a scenario COVERS it. Used only when the proposed type does not fit.
 */
const EQUIVALENT_TYPES: Partial<Record<RelationshipType, readonly RelationshipType[]>> = {
  COVERS: ["VALIDATES"],
  VALIDATES: ["COVERS"],
};

export type FallbackReason = "unknown_type" | "structural_type" | "invalid_endpoints";

export interface ResolvedRelationship {
  relationshipType: RelationshipType;
  reviewState: ReviewState;
  /** Empty when the relationship fits; { reversedFrom } when it fits the other way round; otherwise { suggestedType, fallbackReason }. */
  properties: Record<string, unknown>;
  fallbackReason?: FallbackReason;
  /** The relationship was written the other way round: store it with source and target swapped. */
  reversed?: boolean;
}

/**
 * Decides how an extracted (LLM or agent) relationship enters the graph. A relationship that fits a
 * semantic rule pair is kept as-is. Anything else is kept as RELATES_TO with the original type in
 * properties.suggestedType and reviewState "needs_review", so the intent is preserved without an
 * invalid edge entering the graph.
 */
export function resolveSemanticRelationship(rawType: string, fromType: NodeType, toType: NodeType): ResolvedRelationship {
  const type = normalizeRelationshipType(rawType);
  if (type && isSemanticEdgeAllowed(type, fromType, toType)) {
    return { relationshipType: type, reviewState: "pending", properties: {} };
  }

  // Written the other way round: an inverse name ("rule CONSTRAINS table"), or a type that only fits with source and target swapped.
  const backwards = INVERSE_RELATIONSHIP_NAMES[relationshipKey(rawType)] ?? type;
  if (backwards && isSemanticEdgeAllowed(backwards, toType, fromType)) {
    return { relationshipType: backwards, reviewState: "pending", properties: { reversedFrom: `${fromType} -[${rawType.trim()}]-> ${toType}` }, reversed: true };
  }

  // Same meaning, another type for these endpoints: a test case "COVERS" a business rule is stored as VALIDATES.
  const equivalent = (type ? EQUIVALENT_TYPES[type] ?? [] : []).find((alternative) => isSemanticEdgeAllowed(alternative, fromType, toType));
  if (equivalent) {
    return { relationshipType: equivalent, reviewState: "pending", properties: { correctedFrom: `${fromType} -[${rawType.trim()}]-> ${toType}` } };
  }

  const fallbackReason: FallbackReason = !type ? "unknown_type" : isRelationshipAllowed(type, fromType, toType) ? "structural_type" : "invalid_endpoints";
  return {
    relationshipType: FALLBACK_RELATIONSHIP_TYPE,
    reviewState: "needs_review",
    properties: { suggestedType: type ?? rawType.trim(), fallbackReason },
    fallbackReason,
  };
}

/** Human-readable "A | B → C" description of the semantic pairs of a relationship, for prompts and docs. */
export function describePairs(type: RelationshipType, origin?: EdgeOrigin): string {
  const list = (types: readonly NodeType[]): string => (types.length === NODE_TYPES.length ? "any" : types.join(" | "));
  return RELATIONSHIP_RULES[type].pairs
    .filter((pair) => !origin || pair.origin === origin)
    .map((pair) => `${list(pair.from)} → ${list(pair.to)}`)
    .join("; ");
}
