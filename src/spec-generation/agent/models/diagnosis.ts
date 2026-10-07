export type FailureCategory =
  | "PRODUCT_UI"
  | "PRODUCT_API"
  | "PRODUCT_BUSINESS_RULE"
  | "PRODUCT_INTEGRATION"
  | "DATA_INTEGRITY"
  | "UI_API_MISMATCH"
  | "API_DATA_MISMATCH"
  | "CROSS_SERVICE_DATA_MISMATCH"
  | "EVENTUAL_CONSISTENCY_TIMEOUT"
  | "TEST_INVALID_LOCATOR"
  | "TEST_INVALID_EXPECTATION"
  | "TEST_BAD_SYNCHRONIZATION"
  | "TEST_OUTDATED"
  | "TEST_DATA_MISSING"
  | "TEST_DATA_INVALID"
  | "TEST_DATA_DIRTY_STATE"
  | "ENVIRONMENT_SERVICE_UNAVAILABLE"
  | "ENVIRONMENT_DATABASE_UNAVAILABLE"
  | "ENVIRONMENT_AUTHENTICATION"
  | "ENVIRONMENT_CONFIGURATION"
  | "ENVIRONMENT_NETWORK"
  | "FLAKY_TIMING"
  | "FLAKY_RACE_CONDITION"
  | "UNKNOWN";

export interface FailureHypothesis {
  id: string;
  category: FailureCategory;
  summary: string;
  confidence: number;
  supportingEvidence: string[];
  contradictingEvidence?: string[];
  requiredProbe?: DiagnosticProbe;
}

export interface DiagnosticProbe {
  id: string;
  description: string;
  safe: boolean;
}

export interface StateObservation {
  entity: string;
  property: string;
  source: "UI" | "API" | "DATA";
  value: unknown;
  timestamp: number;
}

export interface FailureDiagnosis {
  testId: string;
  testTitle: string;
  failedStep?: string;
  expected: {
    summary: string;
  };
  observed: {
    summary: string;
  };
  classification: FailureCategory;
  rootCause: {
    summary: string;
    confidence: number;
  };
  affectedEntities: string[];
  evidence: Array<{
    type: string;
    summary: string;
  }>;
  hypothesesConsidered?: Array<{
    summary: string;
    confidence: number;
  }>;
  recommendation?: {
    summary: string;
  };
}
