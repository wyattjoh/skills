import type { Fetch, Questions, RetryPolicy, TypeSafeClient } from "@typesafe-ai/sdk";
import type { Database } from "bun:sqlite";

/**
 * A named built-in TypeSafe judge preset.
 */
export type JudgePresetName = "steering" | "error-resolved" | "task-kind" | "relevance";

/**
 * The lifecycle state of a batch of judge requests.
 */
export type JudgeStatus = "ok" | "skipped" | "partial";

/**
 * A reason a row or judge batch could not be evaluated.
 */
export type JudgeReason =
  | "no_api_key"
  | "connection"
  | "timeout"
  | "auth"
  | "rate_limit"
  | "bad_answer"
  | "max_rows";

/**
 * Context supplied to a preset while it builds the state for one row.
 */
export interface JudgeStateContext {
  /**
   * The relevance query, when the caller supplied one.
   */
  query: string | undefined;
}

/**
 * A row-level judgment annotation added to command output.
 */
export interface RowJudgment {
  /**
   * Whether this row was evaluated successfully.
   */
  status: "ok" | "skipped";
  /**
   * Why evaluation was skipped, or null for a successful answer.
   */
  reason: JudgeReason | null;
  /**
   * The SDK error class, or null when no SDK error occurred.
   */
  error_class: string | null;
  /**
   * Validated TypeSafe answers with uncertainty annotations.
   */
  answers: Record<string, unknown> | undefined;
}

/**
 * Batch-level judgment metadata included in the command response envelope.
 */
export interface JudgeSummary {
  /**
   * The aggregate outcome of the batch.
   */
  status: JudgeStatus;
  /**
   * The common skip reason when the batch has no successful rows.
   */
  reason: JudgeReason | null;
  /**
   * The common SDK error class when the batch has no successful rows.
   */
  error_class: string | null;
  /**
   * Number of rows answered by a network request.
   */
  rows_judged: number;
  /**
   * Number of rows served from the local cache.
   */
  rows_cached: number;
  /**
   * Estimated input tokens for the selected states, using chars divided by four.
   */
  estimated_input_tokens: number;
}

/**
 * A batch result with a judgment annotation attached to every input row.
 */
export interface JudgeResult<T> extends JudgeSummary {
  /**
   * Input rows in their original order, each carrying a judgment annotation.
   */
  rows: Array<T & { judge: RowJudgment }>;
}

/**
 * A reusable state builder and question set for one judge preset.
 */
export interface JudgePreset<T = unknown> {
  /**
   * The cache-key name of this preset.
   */
  name: string;
  /**
   * Questions sent with every request for this preset.
   */
  questions: Questions;
  /**
   * Build the unredacted state for one command row.
   */
  buildState: (row: T, context: JudgeStateContext) => unknown;
}

/**
 * An ad hoc judge definition loaded from a `--judge-file` JSON document.
 */
export interface JudgeFileDefinition {
  /**
   * Questions sent with every request.
   */
  questions: Questions;
  /**
   * Row field paths copied into the request state.
   */
  state_fields: string[];
}

/**
 * Options controlling one `judgeRows` invocation.
 */
export interface JudgeRowsOptions {
  /**
   * Database used for judgment cache reads and writes.
   */
  db: Database | undefined;
  /**
   * Explicit model name, otherwise the SDK/default-model environment value.
   */
  model: string | undefined;
  /**
   * Explicit API key for tests or callers that do not use the environment.
   */
  apiKey: string | undefined;
  /**
   * Custom fetch implementation passed to the SDK client.
   */
  fetch: Fetch | undefined;
  /**
   * An injected client, primarily useful for deterministic tests.
   */
  client: TypeSafeClient | undefined;
  /**
   * Maximum number of rows eligible for judging.
   */
  maxRows: number | undefined;
  /**
   * Skip both cache reads and cache writes.
   */
  noCache: boolean;
  /**
   * Minimum confidence used to set the answer-level uncertain flag.
   */
  minConfidence: number | undefined;
  /**
   * Query text required by the relevance preset.
   */
  query: string | undefined;
  /**
   * Ad hoc questions and state-field selection from `--judge-file`.
   */
  judgeFile: JudgeFileDefinition | undefined;
  /**
   * Diagnostic sink for estimates and fallback reasons.
   */
  diagnostic: ((message: string) => void) | undefined;
  /**
   * Per-request timeout passed to the SDK, when set.
   */
  timeoutMs: number | undefined;
  /**
   * SDK retry overrides, primarily useful for bounded tests.
   */
  retry: Partial<RetryPolicy> | undefined;
  /**
   * Fixed cache timestamp used by deterministic tests, when supplied.
   */
  now: Date | undefined;
}
