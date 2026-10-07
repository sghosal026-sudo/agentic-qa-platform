import type { FailureCategory } from "../models/diagnosis.js";

export const FAILURE_CATEGORIES: readonly FailureCategory[] = [
  "PRODUCT_UI",
  "PRODUCT_API",
  "PRODUCT_BUSINESS_RULE",
  "PRODUCT_INTEGRATION",
  "DATA_INTEGRITY",
  "UI_API_MISMATCH",
  "API_DATA_MISMATCH",
  "CROSS_SERVICE_DATA_MISMATCH",
  "EVENTUAL_CONSISTENCY_TIMEOUT",
  "TEST_INVALID_LOCATOR",
  "TEST_INVALID_EXPECTATION",
  "TEST_BAD_SYNCHRONIZATION",
  "TEST_OUTDATED",
  "TEST_DATA_MISSING",
  "TEST_DATA_INVALID",
  "TEST_DATA_DIRTY_STATE",
  "ENVIRONMENT_SERVICE_UNAVAILABLE",
  "ENVIRONMENT_DATABASE_UNAVAILABLE",
  "ENVIRONMENT_AUTHENTICATION",
  "ENVIRONMENT_CONFIGURATION",
  "ENVIRONMENT_NETWORK",
  "FLAKY_TIMING",
  "FLAKY_RACE_CONDITION",
  "UNKNOWN",
];

export function isFailureCategory(value: unknown): value is FailureCategory {
  return typeof value === "string" && FAILURE_CATEGORIES.includes(value as FailureCategory);
}

export function classifyFromEvidence(observations: import("../models/observation.js").QAObservation[]): FailureCategory {
  const surfaces = new Set(observations.map((o) => o.surface));
  if (surfaces.has("UI") && surfaces.has("API") && surfaces.has("DATA")) return "CROSS_SERVICE_DATA_MISMATCH";
  if (surfaces.has("API") && surfaces.has("DATA")) return "API_DATA_MISMATCH";
  if (surfaces.has("UI") && surfaces.has("API")) return "UI_API_MISMATCH";
  if (surfaces.has("UI")) return "PRODUCT_UI";
  if (surfaces.has("API")) return "PRODUCT_API";
  if (surfaces.has("DATA")) return "DATA_INTEGRITY";
  return "UNKNOWN";
}
