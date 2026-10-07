export type EvidenceType =
  | "PLAYWRIGHT_ERROR"
  | "SCREENSHOT"
  | "TRACE"
  | "DOM"
  | "CONSOLE"
  | "PAGE_ERROR"
  | "NETWORK_REQUEST"
  | "NETWORK_RESPONSE"
  | "API_RESPONSE"
  | "DATA_QUERY"
  | "DATA_RESULT"
  | "KNOWLEDGE_GRAPH";

export interface Evidence {
  type: EvidenceType;
  summary: string;
  data?: unknown;
  timestamp?: number;
}
