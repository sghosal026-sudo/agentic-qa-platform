import fs from "node:fs/promises";
import path from "node:path";
import type { ModelClient } from "../../src/contracts.js";
export async function setupTarget(project: string): Promise<void> {
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, "package.json"), JSON.stringify({ type: "module" }));
  await fs.symlink(path.resolve("node_modules"), path.join(project, "node_modules"), process.platform === "win32" ? "junction" : "dir");
}
export const statusModel: ModelClient = { complete: async messages => {
  const prompt = messages.map(message => message.content).join("\n");
  const caseId = prompt.match(/Case ID: ([^\n]+)/)?.[1] ?? "TestCase:missing";
  const key = caseId.replace(/^TestCase:/, "");
  const status = Number(prompt.match(/Expected: HTTP (\d+)/)?.[1] ?? 200);
  return { content: JSON.stringify({ caseId, layer: "api", ops: [{ id: "response", kind: "api.request", operationId: "legacy-1", evidenceRefs: ["api:legacy-1"], step: 1 }],
    assertions: [{ kind: "assert.status", of: "response", status, obligation: key + ".step-1" }], unautomatable: [] }) };
}, json: async () => ({}) };
