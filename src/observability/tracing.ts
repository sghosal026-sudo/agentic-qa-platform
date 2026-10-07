import { LangfuseSpanProcessor } from "@langfuse/otel";
import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { maskTraceData } from "./masking.js";

export interface ObservationHandle {
  update(value: { input?: unknown; output?: unknown; metadata?: Record<string, unknown>;
    level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR"; statusMessage?: string }): unknown;
}

export interface TracingHandle {
  enabled: boolean;
  shutdown(): Promise<void>;
}

const disabled: TracingHandle = { enabled: false, shutdown: async () => {} };
let running: { sdk: NodeSDK; processor: LangfuseSpanProcessor } | undefined;

export function startTracing(): TracingHandle {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) return disabled;

  if (!running) {
    const processor = new LangfuseSpanProcessor({
      publicKey,
      secretKey,
      baseUrl: process.env.LANGFUSE_BASE_URL,
      environment: process.env.LANGFUSE_TRACING_ENVIRONMENT ?? process.env.NODE_ENV,
      release: process.env.LANGFUSE_RELEASE,
      mask: maskTraceData,
    });
    const sdk = new NodeSDK({ spanProcessors: [processor] });
    sdk.start();
    running = { sdk, processor };
  }

  const current = running;
  return {
    enabled: true,
    shutdown: async () => {
      if (running === current) running = undefined;
      await current.sdk.shutdown();
    },
  };
}

export function withTrace<T>(name: string, metadata: Record<string, string>, work: (observation: ObservationHandle) => Promise<T>): Promise<T> {
  return propagateAttributes({ traceName: name, tags: ["agentic-qa"], metadata,
    sessionId: metadata.adoId ? `ado-${metadata.adoId}` : metadata.runId }, () =>
    startActiveObservation(name, async (observation) => {
      observation.update({ input: metadata });
      try {
        return await work(observation);
      } catch (error) {
        observation.update({ level: "ERROR", statusMessage: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }, { asType: "chain" }));
}

export function observe<T>(name: string, input: Record<string, unknown>, work: () => Promise<T>, summarize: (result: T) => unknown): Promise<T> {
  return startActiveObservation(name, async (observation) => {
    observation.update({ input });
    try {
      const result = await work();
      observation.update({ output: summarize(result) });
      return result;
    } catch (error) {
      observation.update({ level: "ERROR", statusMessage: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }, { asType: "chain" });
}
