import type { Questions } from "@typesafe-ai/sdk";
import { redactValue } from "../redact.ts";
import type { JudgeFileDefinition, JudgePreset, JudgeStateContext } from "./types.ts";

/**
 * Maximum state budget used by TypeSafe requests.
 */
export const MAX_STATE_TOKENS = 32_000;

/**
 * Character budget corresponding to MAX_STATE_TOKENS at four characters per token.
 */
export const MAX_STATE_CHARS = MAX_STATE_TOKENS * 4 - 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEntry(value: unknown): boolean {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isEntry);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isEntry);
}

function validateChoiceCriteria(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length === 0) return false;
  return Object.values(value).every(isEntry);
}

function validateScoreCriteria(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0 && value.every(isEntry);
  if (!isRecord(value)) return false;

  const scores = Object.keys(value)
    .map((key) => Number(key))
    .toSorted((a, b) => a - b);
  return (
    scores.length > 0 &&
    scores.every((score, index) => Number.isInteger(score) && score === index) &&
    Object.values(value).every(isEntry)
  );
}

function validateQuestion(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.instructions !== undefined && !isEntry(value.instructions)) return false;

  if (value.type === "noul") {
    if (value.criteria === undefined || value.criteria === null) return true;
    if (!isRecord(value.criteria)) return false;
    return (
      Object.keys(value.criteria).every((key) => key === "true" || key === "false") &&
      Object.values(value.criteria).every(isEntry)
    );
  }
  if (value.type === "choice") return validateChoiceCriteria(value.criteria);
  if (value.type === "score") return validateScoreCriteria(value.criteria);
  return false;
}

/**
 * Validate and normalize the JSON shape accepted by `--judge-file`.
 *
 * @param value Parsed JSON from a judge definition file.
 * @returns A validated ad hoc judge definition.
 * @throws When questions or state_fields do not have the required shape.
 */
export function validateJudgeFile(value: unknown): JudgeFileDefinition {
  if (!isRecord(value)) throw new Error("Judge file must contain a JSON object.");
  if (!isRecord(value.questions) || Object.keys(value.questions).length === 0) {
    throw new Error("Judge file questions must be a non-empty object.");
  }
  if (!Object.values(value.questions).every(validateQuestion)) {
    throw new Error("Judge file contains an invalid question.");
  }
  if (
    !Array.isArray(value.state_fields) ||
    value.state_fields.length === 0 ||
    !value.state_fields.every(
      (field): field is string => typeof field === "string" && field.trim().length > 0,
    )
  ) {
    throw new Error("Judge file state_fields must be a non-empty string array.");
  }

  return {
    questions: value.questions as Questions,
    state_fields: [...value.state_fields],
  };
}

/**
 * Read and validate a JSON judge definition from disk.
 *
 * @param pathOrJson File path or inline JSON supplied by the caller.
 * @returns A validated ad hoc judge definition.
 */
export async function readJudgeFile(pathOrJson: string): Promise<JudgeFileDefinition> {
  const source = pathOrJson.trim();
  if (source.startsWith("{")) return validateJudgeFile(JSON.parse(source) as unknown);
  return validateJudgeFile(await Bun.file(pathOrJson).json());
}

function fieldValue(row: unknown, path: string): unknown {
  let current: unknown = row;
  for (const segment of path.split(".")) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return null;
    current = current[segment];
  }
  return current === undefined ? null : current;
}

/**
 * Select state fields from a row for an ad hoc judge definition.
 *
 * @param row Command output row.
 * @param fields Dot-separated row field paths.
 * @returns An object with fields in the definition's declared order.
 */
export function selectStateFields(
  row: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  for (const field of fields) selected[field] = fieldValue(row, field);
  return selected;
}

/**
 * Serialize state deterministically for TypeSafe and cache requests.
 *
 * @param state State returned by a preset builder.
 * @returns JSON text, or the original string when state is already text.
 */
export function serializeState(state: unknown): string {
  if (typeof state === "string") return state;
  return JSON.stringify(state) ?? "null";
}

/**
 * Truncate state from both ends while retaining a deterministic marker.
 *
 * @param state Serialized state text.
 * @param maxChars Maximum output length, defaulting to the 32k-token budget.
 * @returns The original text or a head-marker-tail representation.
 */
export function truncateState(state: string, maxChars = MAX_STATE_CHARS): string {
  if (maxChars <= 0) throw new Error("State truncation budget must be positive.");
  if (state.length <= maxChars) return state;

  let removed = state.length - maxChars;
  let marker = `[truncated ${removed} chars]`;
  let contentBudget = maxChars - marker.length - 2;
  while (contentBudget < 2 || state.length - contentBudget !== removed) {
    removed = state.length - contentBudget;
    marker = `[truncated ${removed} chars]`;
    const nextBudget = maxChars - marker.length - 2;
    if (nextBudget === contentBudget) break;
    contentBudget = nextBudget;
  }

  if (contentBudget < 2) throw new Error("State truncation budget is too small for a marker.");
  const headLength = Math.ceil(contentBudget / 2);
  const tailLength = contentBudget - headLength;
  return `${state.slice(0, headLength)}\n${marker}\n${state.slice(-tailLength)}`;
}

/**
 * Build the redacted, serialized, and bounded state for a preset row.
 *
 * @param preset Preset or ad hoc state builder.
 * @param row Raw command output row.
 * @param context Preset context such as the relevance query.
 * @returns State text safe to send to the external judge.
 */
export function buildState<T>(preset: JudgePreset<T>, row: T, context: JudgeStateContext): string {
  const redactedRow = redactValue(row) as T;
  const state = preset.buildState(redactedRow, context);
  return truncateState(serializeState(redactValue(state)));
}

/**
 * Build the redacted, serialized, and bounded state for an ad hoc definition.
 *
 * @param definition Validated judge-file definition.
 * @param row Raw command output row.
 * @returns State text safe to send to the external judge.
 */
export function buildJudgeFileState<T>(definition: JudgeFileDefinition, row: T): string {
  const redactedRow = redactValue(row);
  return truncateState(serializeState(selectStateFields(redactedRow, definition.state_fields)));
}

/**
 * Create a preset-compatible builder from a validated judge-file definition.
 *
 * @param definition Validated judge-file definition.
 * @returns A judge preset definition with a stable custom cache name.
 */
export function judgeFileAsPreset(definition: JudgeFileDefinition): JudgePreset {
  return {
    name: "custom",
    questions: definition.questions,
    buildState: (row) => selectStateFields(row, definition.state_fields),
  };
}
