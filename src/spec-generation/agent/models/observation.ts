import type { Evidence } from "./evidence.js";

export type ObservationSurface = "UI" | "API" | "DATA" | "UNKNOWN";

export interface QAObservation {
  id: string;
  testId: string;
  stepId?: string;
  surface: ObservationSurface;
  operation: string;
  target?: {
    type?: string;
    id?: string;
    name?: string;
  };
  expected?: unknown;
  observed?: unknown;
  evidence: Evidence[];
  timestamp: number;
}
