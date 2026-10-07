import type { StateObservation } from "../models/diagnosis.js";
import type { QAObservation } from "../models/observation.js";

export function buildStateObservations(observations: QAObservation[]): StateObservation[] {
  const out: StateObservation[] = [];
  for (const obs of observations) {
    if (obs.surface === "UNKNOWN" || !obs.observed) continue;
    out.push({
      entity: obs.target?.id ?? obs.target?.name ?? "unknown",
      property: obs.operation,
      source: obs.surface,
      value: obs.observed,
      timestamp: obs.timestamp,
    });
  }
  return out;
}

export function findMismatches(states: StateObservation[]): { entity: string; property: string; values: { source: StateObservation["source"]; value: unknown }[] }[] {
  const byKey = new Map<string, StateObservation[]>();
  for (const state of states) {
    const key = `${state.entity}:${state.property}`;
    const list = byKey.get(key) ?? [];
    list.push(state);
    byKey.set(key, list);
  }
  const mismatches: { entity: string; property: string; values: { source: StateObservation["source"]; value: unknown }[] }[] = [];
  for (const [key, items] of byKey) {
    const unique = new Map<string, StateObservation>();
    for (const item of items) {
      const valueKey = JSON.stringify(item.value);
      if (!unique.has(valueKey)) unique.set(valueKey, item);
    }
    if (unique.size > 1 && new Set(items.map(item => item.source)).size > 1) {
      mismatches.push({
        entity: items[0]!.entity,
        property: items[0]!.property,
        values: [...unique.values()].map((v) => ({ source: v.source, value: v.value })),
      });
    }
  }
  return mismatches;
}
