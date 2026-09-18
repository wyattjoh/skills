import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  AuthenticationError,
  RateLimitError,
  TypeSafeClient,
  UnprocessableEntityError,
} from "@typesafe-ai/sdk";
import type { Questions, SystemOneResult } from "@typesafe-ai/sdk";
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { openDb } from "../db.ts";
import { findPreset } from "./presets/index.ts";
import { buildJudgeFileState, buildState, judgeFileAsPreset } from "./state.ts";
import type {
  JudgeFileDefinition,
  JudgePreset,
  JudgePresetName,
  JudgeReason,
  JudgeResult,
  JudgeRowsOptions,
  JudgeStateContext,
  JudgeSummary,
  RowJudgment,
} from "./types.ts";

const DEFAULT_MAX_ROWS = 500;
const DEFAULT_MIN_CONFIDENCE = 0.5;
const MAX_CONCURRENCY = 8;
const DEFAULT_MODEL = "jev-latest";
const NOUL_UNCERTAIN_MIN = 0.35;
const NOUL_UNCERTAIN_MAX = 0.65;

type PreparedRow<T> = {
  index: number;
  row: T;
  state: string;
  stateHash: string;
};

type RequestResult = {
  index: number;
  judgment: RowJudgment;
  answered: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function modelName(options: Partial<JudgeRowsOptions>): string {
  const explicit = options.model?.trim();
  if (explicit) return explicit;
  const fromEnvironment = process.env.TYPESAFE_DEFAULT_MODEL?.trim();
  return fromEnvironment || DEFAULT_MODEL;
}

function hasApiKey(options: Partial<JudgeRowsOptions>): boolean {
  const key = options.apiKey ?? process.env.TYPESAFE_API_KEY;
  return key !== undefined && key.trim().length > 0;
}

function diagnosticSink(options: Partial<JudgeRowsOptions>): (message: string) => void {
  return options.diagnostic ?? ((message) => console.error(message));
}

function resolvedMaxRows(options: Partial<JudgeRowsOptions>): number {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  if (!Number.isInteger(maxRows) || maxRows < 0) {
    throw new Error(`Invalid max judge rows: ${maxRows}`);
  }
  return maxRows;
}

function resolvedMinConfidence(options: Partial<JudgeRowsOptions>): number {
  const confidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`Invalid minimum confidence: ${confidence}`);
  }
  return confidence;
}

function resolvePreset(
  preset: JudgePresetName | string | JudgePreset,
  options: Partial<JudgeRowsOptions>,
): { definition: JudgePreset; fileDefinition: JudgeFileDefinition | undefined } {
  if (options.judgeFile !== undefined) {
    return {
      definition: judgeFileAsPreset(options.judgeFile),
      fileDefinition: options.judgeFile,
    };
  }
  if (typeof preset !== "string") return { definition: preset, fileDefinition: undefined };

  const definition = findPreset(preset);
  if (definition === undefined) throw new Error(`Unknown judge preset: ${preset}`);
  if (preset === "relevance" && !options.query?.trim()) {
    throw new Error("The relevance judge requires --query.");
  }
  return { definition, fileDefinition: undefined };
}

function isFiniteProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validProbabilityMap(value: unknown, requiredKeys: readonly string[] = []): boolean {
  if (!isRecord(value) || !Object.values(value).every(isFiniteProbability)) return false;
  return requiredKeys.every((key) => Object.hasOwn(value, key));
}

function answerUncertain(
  question: Questions[string],
  answer: Record<string, unknown>,
  minConfidence: number,
): boolean {
  if (question.type === "noul") {
    const probability = answer.noul;
    return (
      typeof probability === "number" &&
      probability >= NOUL_UNCERTAIN_MIN &&
      probability <= NOUL_UNCERTAIN_MAX
    );
  }
  const confidence = answer.confidence;
  return typeof confidence === "number" && confidence < minConfidence;
}

function validateAnswer(
  question: Questions[string],
  answer: unknown,
  minConfidence: number,
): Record<string, unknown> | undefined {
  if (!isRecord(answer) || answer.type !== question.type) return undefined;

  if (question.type === "noul") {
    if (!isFiniteProbability(answer.noul)) return undefined;
    return { ...answer, uncertain: answerUncertain(question, answer, minConfidence) };
  }

  if (!isFiniteProbability(answer.confidence)) return undefined;
  if (question.type === "choice") {
    if (typeof answer.choice !== "string") return undefined;
    if (!Object.hasOwn(question.criteria, answer.choice)) return undefined;
    if (!validProbabilityMap(answer.probabilities, Object.keys(question.criteria))) {
      return undefined;
    }
    return { ...answer, uncertain: answerUncertain(question, answer, minConfidence) };
  }

  const criteria = question.criteria;
  const criterionKeys = Array.isArray(criteria)
    ? criteria.map((_, index) => String(index))
    : Object.keys(criteria);
  const highestScore = Array.isArray(criteria)
    ? criteria.length - 1
    : Math.max(...criterionKeys.map((key) => Number(key)));
  if (typeof answer.score !== "number" || !Number.isFinite(answer.score)) return undefined;
  if (answer.score < 0 || answer.score > highestScore) return undefined;
  const legend = answer.legend;
  if (!isRecord(legend) || !criterionKeys.every((key) => Object.hasOwn(legend, key))) {
    return undefined;
  }
  if (!validProbabilityMap(answer.probabilities, criterionKeys)) return undefined;
  return { ...answer, uncertain: answerUncertain(question, answer, minConfidence) };
}

function validateAnswers(
  questions: Questions,
  response: unknown,
  minConfidence: number,
): Record<string, unknown> | undefined {
  if (!isRecord(response) || !isRecord(response.answers)) return undefined;
  const answers: Record<string, unknown> = {};
  for (const [name, question] of Object.entries(questions)) {
    const answer = validateAnswer(question, response.answers[name], minConfidence);
    if (answer === undefined) return undefined;
    answers[name] = answer;
  }
  return answers;
}

function errorClass(error: unknown): string | null {
  return error instanceof Error ? error.constructor.name : null;
}

function mappedError(error: unknown): { reason: JudgeReason; errorClass: string | null } {
  if (error instanceof APITimeoutError) {
    return { reason: "timeout", errorClass: errorClass(error) };
  }
  if (error instanceof APIConnectionError) {
    return { reason: "connection", errorClass: errorClass(error) };
  }
  if (error instanceof AuthenticationError) {
    return { reason: "auth", errorClass: errorClass(error) };
  }
  if (error instanceof RateLimitError) {
    return { reason: "rate_limit", errorClass: errorClass(error) };
  }
  if (error instanceof UnprocessableEntityError || error instanceof APIError) {
    return { reason: "bad_answer", errorClass: errorClass(error) };
  }
  return { reason: "bad_answer", errorClass: errorClass(error) };
}

function skipped(reason: JudgeReason, errorClassName: string | null = null): RowJudgment {
  return {
    status: "skipped",
    reason,
    error_class: errorClassName,
    answers: undefined,
  };
}

function successful(answers: Record<string, unknown>): RowJudgment {
  return {
    status: "ok",
    reason: null,
    error_class: null,
    answers,
  };
}

function cachedJudgment(
  value: string,
  questions: Questions,
  minConfidence: number,
): RowJudgment | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed) || parsed.status !== "ok" || !isRecord(parsed.answers)) {
      return undefined;
    }
    const answers = validateAnswers(questions, { answers: parsed.answers }, minConfidence);
    return answers === undefined ? undefined : successful(answers);
  } catch {
    return undefined;
  }
}

function readCachedJudgment(
  db: Database,
  model: string,
  preset: string,
  questionHash: string,
  stateHash: string,
  questions: Questions,
  minConfidence: number,
): RowJudgment | undefined {
  const row = db
    .query(
      `SELECT answer FROM judgments
       WHERE model = ? AND preset = ? AND question_hash = ? AND state_hash = ?`,
    )
    .get(model, preset, questionHash, stateHash) as { answer: string } | null;
  return row === null ? undefined : cachedJudgment(row.answer, questions, minConfidence);
}

function writeCachedJudgment(
  db: Database,
  model: string,
  preset: string,
  questionHash: string,
  stateHash: string,
  judgment: RowJudgment,
  createdAt: string,
): void {
  db.query(
    `INSERT INTO judgments (model, preset, question_hash, state_hash, answer, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(model, preset, question_hash, state_hash) DO UPDATE SET
       answer = excluded.answer,
       created_at = excluded.created_at`,
  ).run(model, preset, questionHash, stateHash, JSON.stringify(judgment), createdAt);
}

async function requestOne(
  client: TypeSafeClient,
  item: PreparedRow<unknown>,
  questions: Questions,
  minConfidence: number,
  model: string,
  timeoutMs: number | undefined,
): Promise<RequestResult> {
  try {
    const response: SystemOneResult<Questions> = await client.systemOne(
      { state: item.state, questions, model },
      timeoutMs === undefined ? undefined : { timeout: timeoutMs },
    );
    const answers = validateAnswers(questions, response, minConfidence);
    if (answers === undefined) {
      return { index: item.index, judgment: skipped("bad_answer"), answered: false };
    }
    return { index: item.index, judgment: successful(answers), answered: true };
  } catch (error) {
    const mapped = mappedError(error);
    return {
      index: item.index,
      judgment: skipped(mapped.reason, mapped.errorClass),
      answered: false,
    };
  }
}

async function requestConcurrent(
  client: TypeSafeClient,
  items: PreparedRow<unknown>[],
  questions: Questions,
  minConfidence: number,
  model: string,
  timeoutMs: number | undefined,
): Promise<RequestResult[]> {
  const results: RequestResult[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results.push(
        await requestOne(client, items[index]!, questions, minConfidence, model, timeoutMs),
      );
    }
  };
  const workers = Math.min(MAX_CONCURRENCY, items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results.toSorted((a, b) => a.index - b.index);
}

function summaryFor(
  rows: Array<{ judge: RowJudgment }>,
  rowsJudged: number,
  rowsCached: number,
  estimatedInputTokens: number,
): JudgeSummary {
  const successfulRows = rows.filter((row) => row.judge.status === "ok").length;
  const skippedRows = rows.filter((row) => row.judge.status === "skipped");
  if (successfulRows === rows.length) {
    return {
      status: "ok",
      reason: null,
      error_class: null,
      rows_judged: rowsJudged,
      rows_cached: rowsCached,
      estimated_input_tokens: estimatedInputTokens,
    };
  }
  if (successfulRows === 0) {
    const first = skippedRows[0]?.judge ?? skipped("bad_answer");
    return {
      status: "skipped",
      reason: first.reason,
      error_class: first.error_class,
      rows_judged: rowsJudged,
      rows_cached: rowsCached,
      estimated_input_tokens: estimatedInputTokens,
    };
  }
  return {
    status: "partial",
    reason: null,
    error_class: null,
    rows_judged: rowsJudged,
    rows_cached: rowsCached,
    estimated_input_tokens: estimatedInputTokens,
  };
}

/**
 * Judge command rows through one TypeSafe request per row, with bounded
 * concurrency, deterministic state truncation, and sqlite-backed caching.
 *
 * @param rows Command rows to annotate.
 * @param preset Built-in preset name or a custom preset definition.
 * @param options API, cache, budget, and diagnostic options.
 * @returns Every input row with a row-level annotation and batch metadata.
 */
export async function judgeRows<T extends object>(
  rows: T[],
  preset: JudgePresetName | string | JudgePreset,
  options: Partial<JudgeRowsOptions> = {},
): Promise<JudgeResult<T>> {
  const { definition, fileDefinition } = resolvePreset(preset, options);
  const maxRows = resolvedMaxRows(options);
  const minConfidence = resolvedMinConfidence(options);
  const model = modelName(options);
  const diagnostic = diagnosticSink(options);
  const selectedRows = rows.slice(0, maxRows);
  const prepared = selectedRows.map((row, index) => {
    const context: JudgeStateContext = { query: options.query };
    const state =
      fileDefinition === undefined
        ? buildState(definition, row, context)
        : buildJudgeFileState(fileDefinition, row);
    return {
      index,
      row,
      state,
      stateHash: hash(state),
    } satisfies PreparedRow<T>;
  });
  const estimatedInputTokens = prepared.reduce(
    (total, item) => total + Math.ceil(item.state.length / 4),
    0,
  );

  if (rows.length > 0) diagnostic(`judge: estimated input tokens: ${estimatedInputTokens}`);

  const annotations: Array<RowJudgment | undefined> = Array.from({ length: rows.length });
  if (rows.length === 0) {
    return {
      status: "ok",
      reason: null,
      error_class: null,
      rows_judged: 0,
      rows_cached: 0,
      estimated_input_tokens: 0,
      rows: [],
    };
  }

  if (!hasApiKey(options)) {
    for (let index = 0; index < rows.length; index += 1) {
      annotations[index] = skipped("no_api_key");
    }
    diagnostic("judge: skipped (no_api_key)");
    const judgedRows = rows.map((row, index) => ({
      ...row,
      judge: annotations[index]!,
    }));
    return {
      ...summaryFor(judgedRows, 0, 0, estimatedInputTokens),
      rows: judgedRows,
    };
  }

  for (let index = maxRows; index < rows.length; index += 1) {
    annotations[index] = skipped("max_rows");
  }

  let cacheDb = options.db;
  let ownsDb = false;
  if (!options.noCache && cacheDb === undefined) {
    cacheDb = openDb();
    ownsDb = true;
  }

  let rowsCached = 0;
  let rowsJudged = 0;
  const questionHash = hash(`${model}${definition.name}${JSON.stringify(definition.questions)}`);
  const pending: PreparedRow<unknown>[] = [];
  const cachedWrites: Array<{ item: PreparedRow<unknown>; judgment: RowJudgment }> = [];

  try {
    for (const item of prepared) {
      const cached =
        !options.noCache && cacheDb !== undefined
          ? readCachedJudgment(
              cacheDb,
              model,
              definition.name,
              questionHash,
              item.stateHash,
              definition.questions,
              minConfidence,
            )
          : undefined;
      if (cached === undefined) {
        pending.push(item as PreparedRow<unknown>);
      } else {
        annotations[item.index] = cached;
        rowsCached += 1;
      }
    }

    if (pending.length > 0) {
      let client: TypeSafeClient | undefined;
      try {
        const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
        client =
          options.client ??
          new TypeSafeClient({
            apiKey,
            defaultModel: model,
            fetch: options.fetch,
            retry: options.retry,
          });
      } catch (error) {
        const mapped = mappedError(error);
        for (const item of pending)
          annotations[item.index] = skipped(mapped.reason, mapped.errorClass);
      }

      if (client !== undefined) {
        const requestResults = await requestConcurrent(
          client,
          pending,
          definition.questions,
          minConfidence,
          model,
          options.timeoutMs,
        );
        for (const result of requestResults) {
          annotations[result.index] = result.judgment;
          if (result.answered) {
            rowsJudged += 1;
            const item = pending.find((candidate) => candidate.index === result.index);
            if (item !== undefined) cachedWrites.push({ item, judgment: result.judgment });
          }
        }
      }
    }

    if (!options.noCache && cacheDb !== undefined) {
      const createdAt = options.now?.toISOString() ?? new Date().toISOString();
      for (const cached of cachedWrites) {
        writeCachedJudgment(
          cacheDb,
          model,
          definition.name,
          questionHash,
          cached.item.stateHash,
          cached.judgment,
          createdAt,
        );
      }
    }
  } finally {
    if (ownsDb) cacheDb?.close();
  }

  const completedRows = rows.map((row, index) => ({
    ...row,
    judge: annotations[index] ?? skipped("bad_answer"),
  }));
  const summary = summaryFor(completedRows, rowsJudged, rowsCached, estimatedInputTokens);
  const failureReasons = [
    ...new Set(
      completedRows
        .map((row) => row.judge.reason)
        .filter((reason): reason is JudgeReason => reason !== null),
    ),
  ];
  if (summary.status === "partial") {
    diagnostic(`judge: partial (${failureReasons.join(", ")})`);
  }
  if (summary.status === "skipped" && summary.reason !== "max_rows") {
    diagnostic(`judge: skipped (${summary.reason ?? "bad_answer"})`);
  }
  return { ...summary, rows: completedRows };
}
