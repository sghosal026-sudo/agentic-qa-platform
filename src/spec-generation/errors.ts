/** Base class for every error this agent raises on purpose; the CLI prints these without a stack. */
export class AgentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A setting is missing or unusable. */
export class ConfigError extends AgentError {}

/** The input document does not satisfy the test-design schema this agent reads. */
export class InputValidationError extends AgentError {
  readonly problems: string[];

  constructor(source: string, problems: string[]) {
    super(`${source} is not a valid sprint test design document:\n${problems.slice(0, 20).map((p) => `  - ${p}`).join("\n")}`);
    this.problems = problems;
  }
}

/** Evidence could not be collected from a source the target adapter names. */
export class EvidenceError extends AgentError {}

/** The LLM call itself failed (transport, HTTP status, empty reply). */
export class LlmError extends AgentError {}

/** The model's reply held no JSON object. */
export class JsonExtractionError extends AgentError {}

/** A prompt template is missing, or its placeholders do not match the values given. */
export class PromptError extends AgentError {}

/**
 * A proposed TestIR broke a rule that is not negotiable: an unknown evidence id, an invented
 * literal, an uncovered obligation. The model is asked again; if it persists, the case is fixme'd.
 */
export class IrPolicyError extends AgentError {}

/** Rendered code broke the generated-test policy, or a write would clobber a file the agent does not own. */
export class RenderError extends AgentError {}

/** The model could not produce an acceptable answer within the allowed attempts. */
export class GenerationFailedError extends AgentError {
  readonly label: string;
  readonly attempts: number;
  readonly problems: string[];

  constructor(label: string, attempts: number, problems: string[]) {
    super(`${label}: no acceptable answer after ${attempts} attempt(s). ${problems.slice(0, 5).join(" | ")}`);
    this.label = label;
    this.attempts = attempts;
    this.problems = problems;
  }
}
