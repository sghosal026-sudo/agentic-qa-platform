import type { EvidenceCatalogue } from "../evidence/catalogue.js";
import { locatorExpression } from "../evidence/uiContract.js";
import { GENERATED_MARKER } from "./renderer.js";

/**
 * The page-object module a generated UI spec imports.
 *
 * Every locator the suite uses lives here, generated from the approved contract. A spec therefore
 * cannot contain a selector — and the policy check enforces that it does not — so there is exactly
 * one place to look when a control is renamed, and exactly one place to change.
 *
 * This is also where the contract stops being a document and starts being code: an element nobody
 * approved is simply not in this file, so a test cannot reach for it.
 */
export function renderScreens(catalogue: EvidenceCatalogue): string {
  const identifier = (value: string): string => {
    const cleaned = value.replace(/[^a-zA-Z0-9]+(.)?/g, (_match, next: string | undefined) => (next ? next.toUpperCase() : ""));
    return /^[a-zA-Z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
  };
  const className = (value: string): string => `${identifier(value).replace(/^./, (first) => first.toUpperCase())}Page`;

  const screens = [...catalogue.ui].sort((a, b) => a.name.localeCompare(b.name));
  const classes = screens.map((screen) => {
    const elements = [...screen.elements]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((element) => {
        const description = element.description ? `  /** ${element.description.replace(/\*\//g, "*​/")} */\n` : "";
        return `${description}  readonly ${identifier(element.id)}: Locator;`;
      });
    const assignments = [...screen.elements]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((element) => `    this.${identifier(element.id)} = page.${locatorExpression(element)};`);

    return [
      `/** ${screen.description ? `${screen.description.replace(/\*\//g, "*​/")} — ` : ""}${screen.url} */`,
      `export class ${className(screen.name)} {`,
      `  readonly url = ${JSON.stringify(screen.url)};`,
      ...elements,
      ``,
      `  constructor(private readonly page: Page) {`,
      ...assignments,
      `  }`,
      ``,
      `  async goto(): Promise<void> {`,
      `    await this.page.goto(this.url);`,
      `  }`,
      `}`,
    ].join("\n");
  });
  const factories = screens.map((screen) => `  ${identifier(screen.name)}: (page: Page): ${className(screen.name)} => new ${className(screen.name)}(page),`);

  return [
    `/* ${GENERATED_MARKER}. Edits are lost on the next run. */`,
    ``,
    `import type { Locator, Page } from "@playwright/test";`,
    ``,
    `/**`,
    ` * Page objects generated from the approved UI contract.`,
    ` *`,
    ` * A spec never writes a selector: a selector typed into a test is a guess about how a control`,
    ` * is found, and it goes stale silently. Everything here was approved by a person, and changing`,
    ` * how an element is located is a change to the contract, made once, here.`,
    ` */`,
    ...classes,
    ``,
    `export const pages = {`,
    ...factories,
    `} as const;`,
    ``,
  ].join("\n");
}
