import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { createHash } from "node:crypto";
import { EvidenceError } from "../errors.js";
import type { UiElement, UiScreen } from "./catalogue.js";

/**
 * The approved UI contract: which screens exist, and how each element on them is found.
 *
 * This is the one piece of evidence the agent will not collect for itself, and the reason is worth
 * stating plainly. A live page can tell you that a button labelled "Save" exists. It cannot tell
 * you that this is *the* save button rather than one of three, that its accessible name is stable
 * rather than built from data that changes, or that clicking it is the action the test case means.
 * Those are judgements, and a generator that makes them silently produces tests that look right
 * and drift without anyone noticing.
 *
 * So the explorer proposes and a human disposes. Only what is in this file can appear in a test;
 * anything else makes the case a `fixme` that says which element was missing.
 */

const LocatorSchema = z
  .object({
    /** `data-testid`. The most stable, and the one to prefer. */
    testId: z.string().min(1).optional(),
    /** An ARIA role, usually with a name: the accessible way a user finds the control. */
    role: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    placeholder: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    /** What this element is for, in the words of whoever approved it. */
    description: z.string().min(1).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.testId || value.role || value.label || value.placeholder || value.text), {
    message: "an element needs one of testId, role, label, placeholder or text",
  })
  .refine((value) => !value.name || Boolean(value.role), { message: "name only means something alongside role" });

const ScreenSchema = z
  .object({
    /** Path relative to the target's base URL. */
    url: z.string().min(1),
    description: z.string().min(1).optional(),
    elements: z.record(z.string().min(1), LocatorSchema),
  })
  .strict();

const ContractSchema = z
  .object({
    screens: z.record(z.string().min(1), ScreenSchema),
  })
  .strict();

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

/** Reads and validates the approved contract. Its absence is not an error — it means no UI cases. */
export function loadUiContract(file: string, relativeTo: string): UiScreen[] {
  const absolute = path.resolve(path.dirname(relativeTo), file);
  if (!existsSync(absolute)) {
    throw new EvidenceError(
      `No UI contract at ${absolute}. Run \`npm run agent -- explore --screen <name> --url <path>\` to propose one from the live page, then approve it.`
    );
  }

  let parsed: unknown;
  try {
    parsed = absolute.endsWith(".json") ? JSON.parse(readFileSync(absolute, "utf8")) : parseYaml(readFileSync(absolute, "utf8"));
  } catch (error) {
    throw new EvidenceError(`${absolute} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }

  const result = ContractSchema.safeParse(parsed);
  if (!result.success) throw new EvidenceError(`${absolute} is not a usable UI contract:\n${z.prettifyError(result.error)}`);

  const collectedAt = new Date().toISOString();
  return Object.entries(result.data.screens).map(([name, screen]) => ({
    id: `ui:${name}`,
    layer: "ui" as const,
    name,
    url: screen.url,
    ...(screen.description ? { description: screen.description } : {}),
    elements: Object.entries(screen.elements).map(
      // Spread first, then the id: the locator's own `name` is the accessible name and must not
      // be allowed to become the element's identity.
      ([elementId, locator]): UiElement => ({ ...locator, id: elementId })
    ),
    provenance: { source: absolute, collectedAt, contentHash: hash(screen), pointer: `#/screens/${name}` },
  }));
}

/**
 * The Playwright locator for an approved element.
 *
 * One element, one locator, decided here and nowhere else — so a spec cannot express a locator at
 * all, and two tests for the same control cannot disagree about how to find it. The order is
 * Playwright's own advice: a test id when there is one, then the accessible role and name, then
 * the visible label, and only then text.
 */
export function locatorExpression(element: UiElement): string {
  const quote = (value: string): string => JSON.stringify(value);
  if (element.testId) return `getByTestId(${quote(element.testId)})`;
  if (element.role) return element.name ? `getByRole(${quote(element.role)}, { name: ${quote(element.name)} })` : `getByRole(${quote(element.role)})`;
  if (element.label) return `getByLabel(${quote(element.label)})`;
  if (element.placeholder) return `getByPlaceholder(${quote(element.placeholder)})`;
  return `getByText(${quote(element.text!)})`;
}
