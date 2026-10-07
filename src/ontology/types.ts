import { z } from "zod";

// ---------------------------------------------------------------- node types, by category

/** Backlog items from the delivery tool (source metadata). */
export const WORK_ITEM_NODE_TYPES = ["Epic", "Feature", "Story", "Task"] as const;

/** Iterations and program increments (source metadata). */
export const PLANNING_NODE_TYPES = ["Sprint", "PI"] as const;

/** Quality assurance: test plans and suites, scenarios to validate, concrete test cases, their runs, and the defects they find. */
export const QA_NODE_TYPES = ["TestPlan", "TestSuite", "TestScenario", "TestCase", "TestRun", "Defect"] as const;

/** Parts of the system under test (SUT). */
export const SUT_NODE_TYPES = [
  "SystemElement",
  "Application",
  "Service",
  "Module",
  "Component",
  "Interface",
  "Operation",
  "API",
  "Endpoint",
  "DataStore",
  "Database",
  "DataTable",
  "Field",
  "DataContract",
  "DomainEvent",
  "MessageTopic",
  "IntegrationFlow",
] as const;

/** What the system must do, the rules it enforces, and how work flows through it. */
export const BUSINESS_NODE_TYPES = [
  "BusinessEntity",
  "Capability",
  "Requirement",
  "BusinessRule",
  "Constraint",
  "Workflow",
  "WorkflowStep",
  "Process",
  "State",
  "StateTransition",
  "Role",
] as const;

/** Cross-cutting knowledge and delivery context, including what meetings agreed or left open. */
export const CONTEXT_NODE_TYPES = ["Concept", "Risk", "Environment", "Release", "Team", "Decision", "OpenQuestion"] as const;

/** Documents the knowledge was read from: transcripts, SRS, mapping sheets, legacy test cases (source metadata). */
export const SOURCE_NODE_TYPES = ["Document"] as const;

// ---------------------------------------------------------------- node types, by origin

/** Node types that come from authoritative source metadata (work-item trackers, test management, the documents themselves). */
export const STRUCTURAL_NODE_TYPES = ["Epic", "Feature", "Story", "Task", "TestCase", "TestRun", "Defect", "Sprint", "PI", ...SOURCE_NODE_TYPES] as const;

/** Test plans and suites come only from the test design agent: never from source metadata or LLM extraction. */
export const TEST_DESIGN_AGENT_NODE_TYPES = ["TestPlan", "TestSuite"] as const;

/** Node types that only exist when extracted from document content or created by an agent (e.g. a test design agent). */
export const SEMANTIC_NODE_TYPES = [...SUT_NODE_TYPES, ...BUSINESS_NODE_TYPES, ...CONTEXT_NODE_TYPES, ...TEST_DESIGN_AGENT_NODE_TYPES, "TestScenario"] as const;

/**
 * Node types the LLM may create from content. TestCase is structural when it comes from a
 * test-management work item, but a concrete test case described in a document may also be extracted.
 */
export const EXTRACTABLE_NODE_TYPES = [...SUT_NODE_TYPES, ...BUSINESS_NODE_TYPES, ...CONTEXT_NODE_TYPES, "TestScenario", "TestCase"] as const;

export const NODE_TYPES = [...STRUCTURAL_NODE_TYPES, ...SEMANTIC_NODE_TYPES] as const;

export const NodeTypeSchema = z.enum(NODE_TYPES);
export type NodeType = z.infer<typeof NodeTypeSchema>;
export type StructuralNodeType = (typeof STRUCTURAL_NODE_TYPES)[number];
export type SemanticNodeType = (typeof SEMANTIC_NODE_TYPES)[number];
export type ExtractableNodeType = (typeof EXTRACTABLE_NODE_TYPES)[number];

// ---------------------------------------------------------------- relationship types

/**
 * Relationships derived from source metadata. CONTAINS is listed here for backward compatibility but
 * also has semantic uses (SUT composition); which pairs are structural is decided in rules.ts.
 */
export const STRUCTURAL_RELATIONSHIP_TYPES = [
  "PARENT_OF",
  "CONTAINS",
  "PLANNED_FOR",
  "BELONGS_TO",
  "VERIFIED_BY",
  "TESTS",
  "EXECUTED_IN",
  "FOUND",
] as const;

/** Semantic relationships between work items, the SUT and business knowledge. */
export const SEMANTIC_RELATIONSHIP_TYPES = [
  "USES",
  "IMPLEMENTS",
  "PART_OF",
  "OWNS",
  "CALLS",
  "PUBLISHES",
  "CARRIES",
  "SUBSCRIBES_TO",
  "READS_FROM",
  "WRITES_TO",
  "TRANSFORMS_TO",
  "TRIGGERS",
  "HAS_STATE",
  "HAS_STEP",
  "TRANSITIONS_TO",
  "FROM_STATE",
  "TO_STATE",
  "FLOW_SOURCE",
  "FLOW_TARGET",
  "USES_CONTRACT",
  "DEPLOYED_IN",
  "PERFORMED_BY",
  "HAS_RISK",
  "MITIGATES",
  "CONSTRAINED_BY",
  "DEPENDS_ON",
  "BLOCKS",
  "BLOCKED_BY",
  "INTEGRATES_WITH",
  "AFFECTS",
  "IMPACTS",
  "SUPPORTS",
  "RELATES_TO",
  "MENTIONS",
  "EXPOSES",
  "CHANGES",
  "RESOLVES",
  "DESCRIBES",
  "CONCERNS",
  "MAPS_TO",
] as const;

/** QA traceability relationships. */
export const QA_RELATIONSHIP_TYPES = ["COVERS", "VALIDATES", "EXERCISES", "TRACES_TO"] as const;

export const RELATIONSHIP_TYPES = [...STRUCTURAL_RELATIONSHIP_TYPES, ...SEMANTIC_RELATIONSHIP_TYPES, ...QA_RELATIONSHIP_TYPES] as const;

export const RelationshipTypeSchema = z.enum(RELATIONSHIP_TYPES);
export type RelationshipType = z.infer<typeof RelationshipTypeSchema>;
export type StructuralRelationshipType = (typeof STRUCTURAL_RELATIONSHIP_TYPES)[number];
export type SemanticRelationshipType = (typeof SEMANTIC_RELATIONSHIP_TYPES)[number];
export type QARelationshipType = (typeof QA_RELATIONSHIP_TYPES)[number];

// ---------------------------------------------------------------- provenance vocabulary

export const ReviewStateSchema = z.enum(["pending", "approved", "rejected", "needs_review"]);
export type ReviewState = z.infer<typeof ReviewStateSchema>;

/**
 * - deterministic: parsed from source metadata
 * - llm: extracted from document content by the LLM
 * - entity_resolution: produced when duplicates were merged
 * - agent: derived by an agent's reasoning (always inferred)
 */
export const ExtractionMethodSchema = z.enum(["deterministic", "llm", "entity_resolution", "agent"]);
export type ExtractionMethod = z.infer<typeof ExtractionMethodSchema>;

// ---------------------------------------------------------------- membership helpers

const structuralNodeTypes: ReadonlySet<string> = new Set(STRUCTURAL_NODE_TYPES);
const semanticNodeTypes: ReadonlySet<string> = new Set(SEMANTIC_NODE_TYPES);
const extractableNodeTypes: ReadonlySet<string> = new Set(EXTRACTABLE_NODE_TYPES);
const testDesignAgentNodeTypes: ReadonlySet<string> = new Set(TEST_DESIGN_AGENT_NODE_TYPES);
const structuralRelationships: ReadonlySet<string> = new Set(STRUCTURAL_RELATIONSHIP_TYPES);
const semanticRelationships: ReadonlySet<string> = new Set([...SEMANTIC_RELATIONSHIP_TYPES, ...QA_RELATIONSHIP_TYPES]);

export const isStructuralNodeType = (type: string): type is StructuralNodeType => structuralNodeTypes.has(type);
export const isSemanticNodeType = (type: string): type is SemanticNodeType => semanticNodeTypes.has(type);
export const isExtractableNodeType = (type: string): type is ExtractableNodeType => extractableNodeTypes.has(type);
export const isTestDesignAgentNodeType = (type: string): boolean => testDesignAgentNodeTypes.has(type);

/**
 * Type-level grouping only. Whether a specific edge is structural depends on its endpoints
 * (see isStructuralEdge in rules.ts), because CONTAINS is used in both ways.
 */
export const isStructuralRelationship = (type: string): type is StructuralRelationshipType => structuralRelationships.has(type);
export const isSemanticRelationship = (type: string): boolean => semanticRelationships.has(type);
