import { stableId } from "../utils/hash.js";
import { unique } from "../utils/text.js";

const WORK_ITEM_CODE = /\b([A-Za-z]{2,6})-(\d{1,5})\b/g;
// Not the prefix of a work-item code: "INB-208" must not also yield "INB".
const UPPERCASE_TOKEN = /\b[A-Z][A-Z0-9]{1,9}\b(?!-\d)/g;
const TECHNICAL_IDENTIFIER = /\b[a-z][a-z0-9]+(?:[_.][a-z0-9]+)+\b/g;
const SPRINT_NAME = /\bsprint\s+(\d+(?:\.\d+)?)\b/gi;

/** Work-item codes such as INB-208 or DEF-12, uppercased and de-duplicated. */
export function extractWorkItemCodes(text: string): string[] {
  return unique(Array.from(text.matchAll(WORK_ITEM_CODE), (m) => `${m[1].toUpperCase()}-${m[2]}`));
}

/** Uppercase tokens written as such in the text (e.g. epic codes like INB, or PI). */
export function extractUppercaseTokens(text: string): string[] {
  return unique(text.match(UPPERCASE_TOKEN) ?? []);
}

/** snake_case or dotted identifiers such as stock_movement or inbound.receipt_confirmed. */
export function extractTechnicalIdentifiers(text: string): string[] {
  return unique(text.match(TECHNICAL_IDENTIFIER) ?? []);
}

export function extractSprintNames(text: string): string[] {
  return unique(Array.from(text.matchAll(SPRINT_NAME), (m) => `Sprint ${m[1]}`));
}

/** Lowercase, accent-free, punctuation collapsed to single spaces. */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function slugify(name: string): string {
  return normalizeName(name).replace(/ /g, "-") || stableId(name).slice(0, 12);
}

/** Stable id for LLM-extracted nodes, so the same entity maps to the same node across runs. */
export function semanticNodeId(nodeType: string, canonicalName: string): string {
  return `${nodeType}:${slugify(canonicalName)}`;
}
