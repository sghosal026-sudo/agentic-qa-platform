import type { Evidence } from "../models/evidence.js";

const REDACTED = "[REDACTED]";
const SECRET_PATTERNS = [
  /authorization/i,
  /cookie/i,
  /set-cookie/i,
  /password/i,
  /token/i,
  /accesstoken/i,
  /refreshtoken/i,
  /apikey/i,
  /secret/i,
];

function redactHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SECRET_PATTERNS.some((pattern) => pattern.test(key))) {
      out[key] = REDACTED;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function redactValue(value: unknown): unknown {
  if (value && typeof value === "object") {
    if (Array.isArray(value)) return value.map(redactValue);
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (SECRET_PATTERNS.some((pattern) => pattern.test(key))) {
        out[key] = REDACTED;
      } else {
        out[key] = redactValue(val);
      }
    }
    return out;
  }
  if (typeof value === "string") {
    return value.length > 4000 ? `${value.slice(0, 4000)}...<truncated>` : value;
  }
  return value;
}

export function filterEvidence(evidence: Evidence[]): Evidence[] {
  return evidence.map((item) => {
    if (item.data && typeof item.data === "object") {
      const data = redactValue({ ...(item.data as Record<string, unknown>) }) as Record<string, unknown>;
      return { ...item, data };
    }
    return { ...item, data: item.data ? redactValue(item.data) : undefined };
  });
}
