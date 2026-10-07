import { chromium, type Browser, type Page } from "@playwright/test";
import type { TargetConfig } from "../config/targetConfig.js";
import { EvidenceError } from "../errors.js";
import type { Logger } from "../logging/logger.js";

/**
 * Looks at a live screen and *proposes* how its controls might be found.
 *
 * It never approves anything, and the distinction is the whole of milestone 4.
 *
 * An accessibility snapshot is excellent evidence: it is what a screen reader sees, so a control
 * with a role and an accessible name is a control a user can find. What it cannot tell you is
 * whether this "Save" button is the one the test case means when three of them exist, whether the
 * name comes from static text or from data that will differ tomorrow, or whether the control is
 * part of the feature at all. Those are judgements about intent, and a generator that makes them
 * silently produces a suite that looks right and rots quietly.
 *
 * So this writes proposals to a file a person edits. Nothing here reaches a test until it appears
 * in the approved contract.
 */

export interface ProposedElement {
  name: string;
  testId?: string;
  role?: string;
  /** The accessible name, where the snapshot gives one. */
  accessibleName?: string;
  /** How confident the explorer is that this locator is durable. Never a substitute for a human. */
  confidence: "high" | "medium" | "low";
  /** Why it is proposed at this confidence, in words a reviewer can act on. */
  note: string;
}

export interface ScreenProposal {
  screen: string;
  url: string;
  exploredAt: string;
  /** The raw accessibility snapshot, so a reviewer can see what the explorer saw. */
  ariaSnapshot: string;
  elements: ProposedElement[];
}

/** Roles worth proposing: the things a test acts on or reads. */
const INTERESTING_ROLES = new Set(["button", "link", "textbox", "checkbox", "radio", "combobox", "listbox", "option", "heading", "alert", "status", "cell", "row"]);

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

/**
 * A control with a `data-testid` is the strongest proposal: it exists to be selected by, so it is
 * the one thing on a page that is meant not to change. A role with a stable-looking accessible
 * name is next. A name that looks like data — a code, an id, a date — is proposed at low
 * confidence and says so, because it will pass today and fail next week.
 */
const looksLikeData = (value: string): boolean => /\d{3,}|[A-Z]{2,}-\d|@|\d{4}-\d{2}-\d{2}|^\s*\d+\s*$/.test(value);

export async function exploreScreen(target: TargetConfig, screen: string, urlPath: string, logger: Logger): Promise<ScreenProposal> {
  const url = new URL(urlPath, target.uiBaseUrl ?? target.baseUrl).toString();
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch();
    const context = await browser.newContext({
      ...(target.auth.storageState ? { storageState: target.auth.storageState } : {}),
      extraHTTPHeaders: target.headers,
    });
    const page = await context.newPage();

    logger.info(`exploring ${url}`);
    const response = await page.goto(url, { waitUntil: "domcontentloaded" });
    if (response && !response.ok()) {
      throw new EvidenceError(`${url} answered ${response.status()} ${response.statusText()}; there is nothing to propose from.`);
    }
    await page.waitForLoadState("networkidle").catch(() => undefined);

    const ariaSnapshot = await page.locator("body").ariaSnapshot();
    const elements = await proposeElements(page, ariaSnapshot);

    return { screen, url: urlPath, exploredAt: new Date().toISOString(), ariaSnapshot, elements };
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    throw new EvidenceError(`Could not explore ${url}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await browser?.close();
  }
}

/** `- textbox "Warehouse code"`, `- heading "Warehouses" [level=1]`, `- status`. */
const SNAPSHOT_LINE = /^\s*-\s+([a-z]+)(?:\s+"([^"]*)")?/;

/**
 * Reads the accessibility snapshot for what exists, then checks each candidate with the locator a
 * test would actually use.
 *
 * The snapshot is the right source for an accessible name — an `<input>` takes its name from its
 * `<label>`, which is not text on the element and which a first version of this missed entirely,
 * collapsing four labelled fields into one nameless `textbox`.
 *
 * The locator check is the part that earns its keep. A name that reads well can still match three
 * controls, and a locator that matches three controls is not a locator: it is a coin toss that
 * passes until the page grows a fourth. So every proposal is resolved, counted, and told on
 * itself.
 */
async function proposeElements(page: Page, ariaSnapshot: string): Promise<ProposedElement[]> {
  const proposals: ProposedElement[] = [];
  const seen = new Set<string>();

  // Test ids first: they outrank anything else, and claim their name before a role proposal can.
  const withTestIds = new Set<string>();
  for (const element of await page.locator("[data-testid]").all()) {
    const testId = await element.getAttribute("data-testid");
    if (!testId) continue;
    withTestIds.add(testId);

    const name = slug(testId);
    if (!name || seen.has(name)) continue;
    seen.add(name);

    const matches = await page.getByTestId(testId).count();
    proposals.push({
      name,
      testId,
      confidence: matches === 1 ? "high" : "low",
      note:
        matches === 1
          ? "has a data-testid, which exists to be selected by and should not change with content"
          : `${matches} elements share this test id, so it does not identify one control`,
    });
  }

  for (const line of ariaSnapshot.split("\n")) {
    const match = SNAPSHOT_LINE.exec(line);
    if (!match) continue;
    const [, role, accessibleName = ""] = match;
    if (!role || !INTERESTING_ROLES.has(role)) continue;

    const name = slug(accessibleName ? `${role}-${accessibleName}` : role);
    if (!name || seen.has(name)) continue;
    seen.add(name);

    // The locator a generated test would use, resolved now rather than hoped for later.
    const locator = accessibleName
      ? page.getByRole(role as Parameters<Page["getByRole"]>[0], { name: accessibleName })
      : page.getByRole(role as Parameters<Page["getByRole"]>[0]);
    const matches = await locator.count();
    const unstable = looksLikeData(accessibleName);

    proposals.push({
      name,
      role,
      ...(accessibleName ? { accessibleName } : {}),
      confidence: matches !== 1 ? "low" : unstable ? "low" : accessibleName ? "medium" : "low",
      note:
        matches === 0
          ? "nothing matched this locator, so it cannot be used as it stands"
          : matches > 1
            ? `${matches} controls match this locator, so it does not identify one of them: give the control a test id, or a name of its own`
            : !accessibleName
              ? "no accessible name, so this locator will stop identifying one control as soon as another of the same role appears"
              : unstable
                ? "the accessible name looks like data rather than a label, so this will pass today and fail when the data changes"
                : "role and accessible name resolve to exactly one control, but confirm it is the one the test case means",
    });
  }

  return proposals;
}
