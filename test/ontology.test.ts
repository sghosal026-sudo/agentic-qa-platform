import assert from "node:assert/strict";
import test from "node:test";
import { isSemanticEdgeAllowed, resolveSemanticRelationship } from "../src/ontology/rules.js";
import { NodeTypeSchema, RelationshipTypeSchema, type NodeType, type RelationshipType } from "../src/ontology/types.js";

test("system ontology represents integration hops, data access, and business behavior", () => {
  for (const type of ["SystemElement", "Interface", "Operation", "DataStore", "DataContract", "IntegrationFlow", "WorkflowStep", "StateTransition"]) {
    assert.equal(NodeTypeSchema.safeParse(type).success, true);
  }

  const links: Array<[RelationshipType, NodeType, NodeType]> = [
    ["CALLS", "Service", "Interface"],
    ["CALLS", "SystemElement", "Operation"],
    ["PUBLISHES", "Application", "DomainEvent"],
    ["CARRIES", "MessageTopic", "DomainEvent"],
    ["SUBSCRIBES_TO", "Application", "MessageTopic"],
    ["READS_FROM", "Service", "DataStore"],
    ["WRITES_TO", "Operation", "Database"],
    ["FLOW_SOURCE", "IntegrationFlow", "Application"],
    ["FLOW_TARGET", "IntegrationFlow", "DataStore"],
    ["USES_CONTRACT", "IntegrationFlow", "DataContract"],
    ["HAS_STEP", "Workflow", "WorkflowStep"],
    ["PART_OF", "StateTransition", "BusinessEntity"],
    ["HAS_STATE", "BusinessEntity", "State"],
    ["FROM_STATE", "StateTransition", "State"],
    ["TO_STATE", "StateTransition", "State"],
    ["CONSTRAINED_BY", "StateTransition", "BusinessRule"],
    ["EXERCISES", "TestScenario", "IntegrationFlow"],
  ];
  for (const [type, from, to] of links) {
    assert.equal(RelationshipTypeSchema.safeParse(type).success, true);
    assert.equal(isSemanticEdgeAllowed(type, from, to), true, `${from} -[${type}]-> ${to}`);
  }

  assert.equal(isSemanticEdgeAllowed("SUBSCRIBES_TO", "Story", "MessageTopic"), false);
  assert.equal(isSemanticEdgeAllowed("PUBLISHES", "Story", "DomainEvent"), false);
  assert.equal(isSemanticEdgeAllowed("WRITES_TO", "BusinessRule", "Database"), false);
  assert.equal(resolveSemanticRelationship("SUBSCRIBES_TO", "Story", "MessageTopic").relationshipType, "RELATES_TO");
});
