/**
 * Shared response envelope and rendering for every read command: one JSON
 * document by default (`{command, count, judge?, rows}`), or a `--table`
 * text rendering for humans. Both pass every row through redact.ts unless
 * the caller opts out.
 */

import { flagBoolean, type FlagValue } from "./args.ts";
import { redactValue } from "./redact.ts";

export interface OutputDocument<T = unknown> {
  command: string;
  count: number;
  judge?: unknown;
  rows: T[];
}

export interface RenderOptions {
  /** Render as a text table instead of JSON. Default false. */
  table?: boolean;
  /** Redact secrets in the rendered output. Default true. */
  redact?: boolean;
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

/** The shared output-format flags every command that renders rows accepts. */
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

/** Build the standard response envelope for a command's rows. */
export function buildDocument<T>(command: string, rows: T[], judge?: unknown): OutputDocument<T> {
  return judge === undefined
    ? { command, count: rows.length, rows }
    : { command, count: rows.length, judge, rows };
}

/** Render a document as JSON or, with `options.table`, as a text table. */
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
