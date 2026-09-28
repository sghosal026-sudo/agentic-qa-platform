import assert from "node:assert/strict";
import test from "node:test";
import type { Driver } from "neo4j-driver";
import { Graph } from "../src/adapters/graph.js";
import { Neo4jClient, type DriverFactory } from "../src/graph/neo4j-client.js";
import { resolveSemanticRelationship } from "../src/ontology/rules.js";

function queryResult(rows: Array<Record<string, unknown>> = []) {
  return { records: rows.map((row) => ({ get: (key: string) => row[key] })) };
}

test("graph adapter uses the KnowledgeGraph schema and PARENT_OF hierarchy", async () => {
  const calls: Array<{ cypher: string; params: Record<string, unknown> }> = [];
  let verified = false;
  let driverClosed = false;
  const session = {
    run: async (cypher: string, params: Record<string, unknown> = {}) => {
      calls.push({ cypher, params });
      if (cypher.includes("RETURN count(r) AS written")) return queryResult([{ written: 1 }]);
      return queryResult();
    },
    close: async () => {},
    executeWrite: async () => undefined,
  };
  const driver = {
    verifyConnectivity: async () => { verified = true; },
    session: () => session,
    close: async () => { driverClosed = true; },
  } as unknown as Driver;
  const factory: DriverFactory = () => driver;
  const client = new Neo4jClient({ uri: "neo4j+s://example", username: "neo4j", password: "secret", database: "neo4j" }, factory);
  const graph = new Graph(client);

  await graph.setup();
  await graph.node("FDN", "Epic", "Foundation", { adoId: 1, title: "Foundation" });
  await graph.node("FDN-5", "Feature", "Locations", { adoId: 2, title: "Locations" });
  await graph.hierarchy("FDN", "FDN-5", { adoId: 2, title: "Locations" });
  await graph.plannedFor("FDN-5", "WMS\\Sprint 1", { adoId: 2, title: "Locations" });
  await graph.close();

  assert.equal(verified, true);
  assert.equal(driverClosed, true);
  assert.ok(calls.some((call) => call.cypher.includes("CREATE FULLTEXT INDEX node_text_idx")));
  const hierarchy = calls.find((call) => call.cypher.includes("MERGE (s)-[r:PARENT_OF]->(t)"));
  assert.ok(hierarchy);
  const row = (hierarchy.params.rows as Array<Record<string, unknown>>)[0]!;
  assert.equal(row.id, "FDN|PARENT_OF|FDN-5");
  assert.equal(row.reviewState, "approved");
  assert.match(String(row.provenanceJson), /"extractionMethod":"deterministic"/);
  assert.match(String(row.provenanceJson), /"sourceDocumentId":"ado:2"/);
  assert.ok(calls.some((call) => call.cypher.includes("MERGE (s)-[r:PLANNED_FOR]->(t)")));
});

test("ontology preserves unsupported proposals as reviewable RELATES_TO edges", () => {
  assert.deepEqual(resolveSemanticRelationship("AFFECTS", "Story", "Endpoint"), {
    relationshipType: "AFFECTS",
    reviewState: "pending",
    properties: {},
  });
  assert.deepEqual(resolveSemanticRelationship("PROVIDES_READ", "Story", "Endpoint"), {
    relationshipType: "RELATES_TO",
    reviewState: "needs_review",
    properties: { suggestedType: "PROVIDES_READ", fallbackReason: "unknown_type" },
    fallbackReason: "unknown_type",
  });
});
