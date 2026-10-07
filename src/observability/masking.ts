const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)[^@\s/]+@/gi;
const API_KEY = /\b(?:sk-or-v1-|sk-or-|sk-lf-|pk-lf-|sk-proj-|sk-ant-)[A-Za-z0-9_-]{8,}/g;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function maskSensitiveText(value: string): string {
  return value.replace(URL_PASSWORD, "$1[REDACTED]@")
    .replace(API_KEY, "[REDACTED_API_KEY]")
    .replace(BEARER_TOKEN, "Bearer [REDACTED]")
    .replace(EMAIL, "[REDACTED_EMAIL]");
}

export function maskTraceData({ data }: { data: unknown }): unknown {
  return typeof data === "string" ? maskSensitiveText(data) : data;
}
