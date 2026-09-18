/**
 * Shared response envelope and rendering for every read command: one JSON
 * document by default (`{command, count, judge?, rows}`), or a `--table`
 * text rendering for humans. Both pass every row through redact.ts unless
 * the caller opts out.
 */

import { flagBoolean, flagString, type FlagValue } from "./args.ts";
import type { Database } from "bun:sqlite";
import { judgeRows } from "./judge/client.ts";
import { readJudgeFile } from "./judge/state.ts";
import type {
  JudgeFileDefinition,
  JudgePresetName,
  JudgeReason,
  JudgeResult,
  RowJudgment,
} from "./judge/types.ts";
import { redactValue } from "./redact.ts";

/**
 * Standard response envelope emitted by read commands.
 *
 * @typeParam T Row shape in the response.
 */
export interface OutputDocument<T = unknown> {
  command: string;
  count: number;
  judge?: unknown;
  rows: T[];
}

/**
 * Rendering options shared by table and JSON command output.
 */
export interface RenderOptions {
  /** Render as a text table instead of JSON. Default false. */
  table?: boolean;
  /** Redact secrets in the rendered output. Default true. */
  redact?: boolean;
}

type MaybeJudged<T> = T & { judge: RowJudgment | undefined };

function parseJudgeNumber(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid --${name}: ${raw}`);
  return value;
}

function parseMaxJudgeRows(raw: string | undefined): number | undefined {
  const value = parseJudgeNumber(raw, "max-judge-rows");
  if (value === undefined || !Number.isInteger(value) || value < 0) {
    if (raw !== undefined) throw new Error(`Invalid --max-judge-rows: ${raw}`);
    return value;
  }
  return value;
}

function parseMinConfidence(raw: string | undefined): number | undefined {
  const value = parseJudgeNumber(raw, "min-confidence");
  if (value !== undefined && (value < 0 || value > 1)) {
    throw new Error(`Invalid --min-confidence: ${raw}`);
  }
  return value;
}

function skippedJudgeDocument<T extends object>(
  command: string,
  rows: T[],
  reason: JudgeReason,
): OutputDocument<MaybeJudged<T>> {
  const judge: RowJudgment = {
    status: "skipped",
    reason,
    error_class: null,
    answers: undefined,
  };
  const judgedRows = rows.map((row) => ({ ...row, judge }));
  return buildDocument(command, judgedRows, {
    status: "skipped",
    reason,
    error_class: null,
    rows_judged: 0,
    rows_cached: 0,
    estimated_input_tokens: 0,
  });
}

function skippedBadAnswerDocument<T extends object>(
  command: string,
  rows: T[],
): OutputDocument<MaybeJudged<T>> {
  console.error("judge: skipped (bad_answer)");
  return skippedJudgeDocument(command, rows, "bad_answer");
}

/**
 * Run an accepted judge preset for a command and add its batch and row fields.
 * Commands without a --judge flag return the same document as before.
 *
 * @param command Command name used in the output envelope.
 * @param rows Raw command rows.
 * @param flags Parsed command flags.
 * @param db Open index database used by the judgment cache.
 * @param acceptedPresets Presets supported by this command.
 * @returns A standard output document, optionally annotated with judgments.
 */
export async function buildDocumentWithJudge<T extends object>(
  command: string,
  rows: T[],
  flags: Record<string, FlagValue>,
  db: Database,
  acceptedPresets: readonly JudgePresetName[],
): Promise<OutputDocument<MaybeJudged<T>>> {
  const presetName = flagString(flags, "judge");
  const judgeFilePath = flagString(flags, "judge-file");
  if (presetName === undefined && judgeFilePath === undefined) {
    return buildDocument(command, rows) as OutputDocument<MaybeJudged<T>>;
  }
  if (presetName !== undefined && judgeFilePath !== undefined) {
    return skippedBadAnswerDocument(command, rows);
  }

  let judgeFile: JudgeFileDefinition | undefined;
  if (judgeFilePath !== undefined) {
    try {
      judgeFile = await readJudgeFile(judgeFilePath);
    } catch {
      return skippedBadAnswerDocument(command, rows);
    }
  }

  if (presetName !== undefined && !acceptedPresets.includes(presetName as JudgePresetName)) {
    throw new Error(`Invalid --judge for ${command}: ${presetName}`);
  }
  if (presetName === "relevance" && !flagString(flags, "query")?.trim()) {
    return skippedBadAnswerDocument(command, rows);
  }

  const result: JudgeResult<T> = await judgeRows(rows, presetName ?? "custom", {
    db,
    judgeFile,
    model: undefined,
    apiKey: undefined,
    fetch: undefined,
    client: undefined,
    maxRows: parseMaxJudgeRows(flagString(flags, "max-judge-rows")),
    noCache: !flagBoolean(flags, "cache", true),
    minConfidence: parseMinConfidence(flagString(flags, "min-confidence")),
    query: flagString(flags, "query"),
    diagnostic: (message) => console.error(message),
    timeoutMs: undefined,
    retry: undefined,
    now: undefined,
  });
  const { rows: judgedRows, ...summary } = result;
  return buildDocument(command, judgedRows, summary);
}

/**
 * Build and render a command document with optional TypeSafe judgments.
 *
 * @param command Command name used in the output envelope.
 * @param rows Raw command rows.
 * @param flags Parsed command flags.
 * @param db Open index database used by the judgment cache.
 * @param acceptedPresets Presets supported by this command.
 * @returns The rendered command output.
 */
export async function renderDocumentWithJudge<T extends object>(
  command: string,
  rows: T[],
  flags: Record<string, FlagValue>,
  db: Database,
  acceptedPresets: readonly JudgePresetName[],
): Promise<string> {
  const document = await buildDocumentWithJudge(command, rows, flags, db, acceptedPresets);
  return renderOutput(document, renderOptionsFromFlags(flags));
}

/**
 * Parse a JSON-encoded scalar, object, or array for a row field.
 *
 * @param value JSON text, or arbitrary text when the value is not JSON.
 * @returns The decoded JSON value, or the original text when decoding fails.
 */
export function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/**
 * Normalize a stored timestamp to an ISO 8601 UTC string when it is valid.
 *
 * @param value Stored timestamp, or null for a missing timestamp.
 * @returns A normalized ISO string, or null for missing or invalid values.
 */
export function toIsoTimestamp(value: string | null): string | null {
  if (value === null) return null;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

/**
 * Read the shared table and redaction flags from parsed command arguments.
 *
 * @param flags Parsed command flags.
 * @returns Rendering settings for renderOutput.
 */
export function renderOptionsFromFlags(flags: Record<string, FlagValue>): RenderOptions {
  return {
    table: flagBoolean(flags, "table"),
    redact: flagBoolean(flags, "redact", true),
  };
}

/**
 * The shared output-format flags every command that renders rows accepts.
 */
export const OUTPUT_OPTIONS = [
  {
    name: "table",
    type: "boolean" as const,
    description: "Print a human-readable table instead of JSON",
  },
  {
    name: "redact",
    type: "boolean" as const,
    negated: true as const,
    description: "Redact secrets in output (default: on; use --no-redact to disable)",
  },
];

/**
 * Shared TypeSafe judge flags for commands that support row annotations.
 */
export const JUDGE_OPTIONS = [
  {
    name: "judge",
    type: "string" as const,
    description: "Annotate supported rows with a TypeSafe preset",
  },
  {
    name: "judge-file",
    type: "string" as const,
    description: "Load ad hoc TypeSafe questions and state fields from JSON",
  },
  {
    name: "query",
    type: "string" as const,
    description: "Query text required by the relevance preset",
  },
  {
    name: "min-confidence",
    type: "string" as const,
    description: "Mark answers below this confidence as uncertain",
  },
  {
    name: "cache",
    type: "boolean" as const,
    negated: true as const,
    description: "Use the judgment cache (default: on; use --no-cache to disable)",
  },
  {
    name: "max-judge-rows",
    type: "string" as const,
    description: "Cap TypeSafe requests (default: 500)",
  },
] as const;

/**
 * Build the standard response envelope for a command's rows.
 *
 * @param command Command name used in the output envelope.
 * @param rows Rows to include in the response.
 * @param judge Optional batch judgment metadata.
 * @returns The response envelope.
 */
export function buildDocument<T>(
  command: string,
  rows: T[],
  judge: unknown | undefined = undefined,
): OutputDocument<T> {
  return judge === undefined
    ? { command, count: rows.length, rows }
    : { command, count: rows.length, judge, rows };
}

/**
 * Render a document as JSON or, with `options.table`, as a text table.
 *
 * @param document Response envelope to render.
 * @param options Rendering and redaction options.
 * @returns The rendered response text.
 */
export function renderOutput<T>(document: OutputDocument<T>, options: RenderOptions = {}): string {
  const redact = options.redact ?? true;
  const rendered = redact ? redactValue(document) : document;
  return options.table === true ? renderTable(rendered) : renderJson(rendered);
}

function renderJson<T>(document: OutputDocument<T>): string {
  return JSON.stringify(document, null, 2);
}

function formatCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  // renderTable lays out one line per row; a literal newline in the cell
  // (e.g. multi-line message text) would otherwise break column alignment
  // for every row after it.
  return text.replace(/\r\n|\r|\n/g, "\\n");
}

function renderTable<T>(document: OutputDocument<T>): string {
  const rows = document.rows as unknown as Array<Record<string, unknown>>;
  if (rows.length === 0) {
    return `${document.command}: 0 rows`;
  }

  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
    }
  }

  const cells = rows.map((row) => columns.map((column) => formatCell(row[column])));
  // A reduce, not `Math.max(...cells.map(...))`: spreading one array
  // element per row into Math.max can overflow the call stack for a large
  // --limit (e.g. from `sql`).
  const widths = columns.map((column, i) =>
    cells.reduce((max, row) => Math.max(max, row[i]!.length), column.length),
  );

  const formatRow = (values: string[]): string =>
    values.map((value, i) => value.padEnd(widths[i]!)).join("  ");

  const lines = [
    formatRow(columns),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...cells.map((row) => formatRow(row)),
  ];
  return lines.join("\n");
}
