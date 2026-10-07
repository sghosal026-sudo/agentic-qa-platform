import { type Layer, type NormalisedCase } from "../model/testCase.js";

/**
 * Which layers a case talks about, decided without a model and without touching the target.
 *
 * This is a *hint*, not a decision: it chooses which evidence to spend time collecting (an API case
 * never starts a browser) and which golden shape the IR proposer is shown. The hint never invents
 * anything — where it finds no signal it says so, and an undetermined case is reported rather than
 * guessed into a layer.
 */

export interface StepHint {
  stepNumber: number;
  layers: Layer[];
}

export interface CaseHint {
  caseId: string;
  /** Every layer the case mentions. Drives evidence collection. */
  needs: Layer[];
  /**
   * The layer the spec is written in. A case that drives a screen is a UI spec even when it also
   * checks a row, because only the browser layer can perform the action; `db` can only observe.
   */
  primary?: Layer;
  perStep: StepHint[];
  /** Steps that named no layer at all. */
  undetermined: number[];
}

/** Node types the graph uses for each layer. The strongest signal: it came from the design, not prose. */
const NODE_TYPE_LAYER: Record<string, Layer> = {
  endpoint: "api",
  api: "api",
  service: "api",
  event: "api",
  screen: "ui",
  page: "ui",
  view: "ui",
  uicomponent: "ui",
  datatable: "db",
  table: "db",
  entity: "db",
  column: "db",
};

/** Weaker signal, read from the step's own words. */
const KEYWORDS: Record<Layer, readonly RegExp[]> = {
  api: [
    /\b(GET|POST|PUT|PATCH|DELETE)\b/,
    /\b(endpoint|api|request body|payload|response|status code|http|header|rest|json body)\b/i,
    /\b\d{3} (response|status)\b/i,
    /\bcalls? the [a-z ]*service\b/i,
  ],
  ui: [
    /\b(browser|user interface|ui)\b/i,
    /\b(screen|page|form|dialog|modal|toast|banner)\b/i,
    /\b(click|clicks|tap|fill|fills|select|selects|check|uncheck|press)\b.{0,40}\b(button|link|field|input|dropdown|checkbox|menu|tab|grid)\b/i,
    /\b(button|link|field|input|dropdown|checkbox|menu|tab|grid)\b.{0,40}\b(visible|displayed|shown)\b/i,
    /\b(navigate|navigates|open|opens)\b.{0,40}\b(screen|page|form|dialog|modal)\b/i,
  ],
  db: [
    /\b(database|db|table|row|record|persisted|stored|saved in|written to|audit (log|trail)|column)\b/i,
    /\b(select|insert|update|delete) statement\b/i,
    /\bin the (warehouse|product|location|user)s? table\b/i,
  ],
};

/** Layers a case's graph references point at. */
function layersFromRefs(testCase: NormalisedCase): Layer[] {
  const layers = new Set<Layer>();
  for (const ref of [...testCase.exercises, ...testCase.validates]) {
    const type = ref.nodeType.toLowerCase();
    const layer = NODE_TYPE_LAYER[type];
    if (layer) layers.add(layer);
  }
  return [...layers];
}

function layersFromText(text: string): Layer[] {
  const layers: Layer[] = [];
  for (const layer of ["api", "ui", "db"] as const) {
    if (KEYWORDS[layer].some((pattern) => pattern.test(text))) layers.push(layer);
  }
  return layers;
}

/** UI can act and observe; API can act and observe; DB can only observe, so it never leads. */
const PRIMARY_ORDER: readonly Layer[] = ["ui", "api", "db"];

export function hintFor(testCase: NormalisedCase): CaseHint {
  const refLayers = layersFromRefs(testCase);
  const perStep: StepHint[] = testCase.steps.map((step) => {
    const fromText = layersFromText(`${step.action}\n${step.expectedResult}`);
    // Graph references are explicit design evidence. Step prose may add another layer only when it
    // names that interaction clearly; generic words such as "field", "select" and "appears" do
    // not turn an API/database case into a browser case.
    return { stepNumber: step.stepNumber, layers: [...new Set([...refLayers, ...fromText])] };
  });

  const votes = new Map<Layer, number>();
  for (const step of perStep) for (const layer of step.layers) votes.set(layer, (votes.get(layer) ?? 0) + 1);
  for (const layer of refLayers) votes.set(layer, votes.get(layer) ?? 0);

  const needs = PRIMARY_ORDER.filter((layer) => votes.has(layer));
  const actionable = PRIMARY_ORDER.filter((layer) => layer !== "db" && (votes.get(layer) ?? 0) > 0);
  const primary = actionable[0] ?? needs[0];

  return {
    caseId: testCase.caseId,
    needs,
    ...(primary ? { primary } : {}),
    perStep,
    undetermined: perStep.filter((step) => step.layers.length === 0).map((step) => step.stepNumber),
  };
}

export function hintsFor(cases: readonly NormalisedCase[]): Map<string, CaseHint> {
  return new Map(cases.map((testCase) => [testCase.caseId, hintFor(testCase)]));
}
