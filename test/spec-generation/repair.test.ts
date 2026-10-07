import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage, LlmClient, LlmCompletion } from "../../src/spec-generation/llm/llmClient.js";
import { SilentLogger } from "../../src/spec-generation/logging/logger.js";
import { IrRepairer } from "../../src/spec-generation/plan/irRepairer.js";
import { createWarehouseCase, createWarehouseIr, wmsCatalogue } from "./helpers/apiFixtures.js";

class Replies implements LlmClient {
  readonly model = "test";
  readonly prompts: ChatMessage[][] = [];

  constructor(private readonly replies: string[]) {}

  async complete(messages: readonly ChatMessage[]): Promise<LlmCompletion> {
    this.prompts.push([...messages]);
    return { content: this.replies.shift() ?? "{}", usage: { promptTokens: 1, completionTokens: 1 } };
  }
}

test("repair rejects a weakened assertion and accepts a binding-only revision", async () => {
  const acceptedIr = createWarehouseIr();
  const weakened = structuredClone(acceptedIr);
  weakened.assertions.pop();

  const rebound = structuredClone(acceptedIr);
  rebound.ops.find((op) => op.kind === "api.request")!.id = "createResponse";
  for (const assertion of rebound.assertions) {
    if ("of" in assertion) assertion.of = "createResponse";
  }

  const llm = new Replies([JSON.stringify(weakened), JSON.stringify(rebound)]);
  const outcome = await new IrRepairer(llm, new SilentLogger(), 2).repair(
    createWarehouseCase(),
    { ir: acceptedIr, gaps: [], attempts: 1 },
    await wmsCatalogue(),
    "created is not defined",
    "GRAPH-CONTEXT-FOR-THIS-CASE",
  );

  assert.equal(outcome.planned?.ir.ops.find((op) => op.kind === "api.request")?.id, "createResponse");
  assert.deepEqual(outcome.planned?.ir.assertions.map((assertion) => assertion.obligation), acceptedIr.assertions.map((assertion) => assertion.obligation));
  assert.equal(llm.prompts.length, 2);
  assert.match(llm.prompts[0]!.at(-1)!.content, /GRAPH-CONTEXT-FOR-THIS-CASE/);
  assert.match(llm.prompts[1]!.at(-1)!.content, /dropped or weakened/);
});

test("repair gives up instead of accepting a changed assertion", async () => {
  const acceptedIr = createWarehouseIr();
  const weakened = structuredClone(acceptedIr);
  weakened.assertions.pop();
  const outcome = await new IrRepairer(new Replies([JSON.stringify(weakened)]), new SilentLogger(), 1).repair(
    createWarehouseCase(),
    { ir: acceptedIr, gaps: [], attempts: 1 },
    await wmsCatalogue(),
    "failure"
  );

  assert.equal(outcome.planned, undefined);
  assert.match(outcome.failure ?? "", /dropped or weakened/);
});
