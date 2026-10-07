import assert from "node:assert/strict";
import test from "node:test";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider, startActiveObservation } from "@langfuse/tracing";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { maskSensitiveText, maskTraceData } from "../src/observability/masking.js";
import { observe, withTrace } from "../src/observability/tracing.js";

test("Langfuse groups Story stages and model calls under one trace", async () => {
  const exporter = new InMemorySpanExporter();
  const processor = new LangfuseSpanProcessor({ exporter, exportMode: "immediate", mask: maskTraceData });
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  const contextManager = new AsyncLocalStorageContextManager();
  context.setGlobalContextManager(contextManager.enable());
  setLangfuseTracerProvider(provider);
  try {
    await withTrace("advance-story", { adoId: "2580" }, async (root) => {
      const result = await observe("author-tests", { runId: "run-1" }, async () =>
        startActiveObservation("openrouter-json", async (generation) => {
          generation.update({ model: "test-model", input: { prompt: "Create tests" }, output: { cases: 1 },
            usageDetails: { input: 10, output: 5 } });
          return 1;
        }, { asType: "generation" }), (cases) => ({ cases }));
      root.update({ output: { action: "test_review", cases: result } });
    });
    await processor.forceFlush();
    const spans = exporter.getFinishedSpans();
    const root = spans.find((span) => span.name === "advance-story");
    const stage = spans.find((span) => span.name === "author-tests");
    const generation = spans.find((span) => span.name === "openrouter-json");
    assert.ok(root && stage && generation);
    assert.equal(stage.parentSpanContext?.spanId, root.spanContext().spanId);
    assert.equal(generation.parentSpanContext?.spanId, stage.spanContext().spanId);
    assert.equal(generation.attributes["langfuse.observation.type"], "generation");
    assert.equal(generation.attributes["session.id"], "ado-2580");
  } finally {
    setLangfuseTracerProvider(null);
    context.disable();
    await provider.shutdown();
  }
});

test("Langfuse masking removes credentials and email addresses", () => {
  assert.equal(maskSensitiveText("postgres://user:secret@db.example.com"), "postgres://user:[REDACTED]@db.example.com");
  assert.equal(maskSensitiveText("Bearer abcdefghijklmnop"), "Bearer [REDACTED]");
  assert.equal(maskSensitiveText("owner@example.com"), "[REDACTED_EMAIL]");
});
