#!/usr/bin/env bun

/**
 * `errors`: is_error tool results with the preceding call and the next
 * assistant text.
 *
 * Usage:
 *   bun $SKILL_DIR/scripts/cli.ts errors [options]
 */

import { flagBoolean, flagString, flagStrings, parseArgv } from "../lib/args.ts";
import type { SQLQueryBindings } from "bun:sqlite";
import { openDb } from "../lib/db.ts";
import {
  buildWhereFragments,
  parseFilters,
  SHARED_FILTER_OPTIONS,
  whereClause,
} from "../lib/filters.ts";
import { buildDocument, OUTPUT_OPTIONS, renderOutput } from "../lib/output.ts";
import type { Command, CommandOption } from "./index.ts";

const options: CommandOption[] = [
  ...SHARED_FILTER_OPTIONS,
  { name: "name", type: "string", description: "Filter by tool name" },
  { name: "pattern", type: "string", description: "Filter by regex over the error result text" },
  ...OUTPUT_OPTIONS,
];

interface ErrorQueryRow {
  id: string;
  name: string;
  input: string;
  result_text: string;
  is_error: number;
  latency_ms: number | null;
  internal_session_id: string;
  session_id: string;
  project_dir: string | null;
  timestamp: string | null;
  uuid: string;
}

interface MessageRow {
  session_id: string;
  timestamp: string | null;
  type: string;
  text: string;
}

interface ErrorOutputRow {
  id: string;
  name: string;
  input: unknown;
  result_text: string;
  is_error: boolean;
  latency_ms: number | null;
  session_id: string;
  project_dir: string | null;
  timestamp: string | null;
  uuid: string;
  assistant_text_after: string | null;
}

function parseJsonInput(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

function nextAssistantText(
  messagesBySession: ReadonlyMap<string, MessageRow[]>,
  sessionId: string,
  resultTimestamp: string | null,
): string | null {
  if (resultTimestamp === null) return null;
  const messages = messagesBySession.get(sessionId) ?? [];
  return (
    messages.find(
      (message) =>
        message.type === "assistant" &&
        message.timestamp !== null &&
        message.timestamp > resultTimestamp,
    )?.text ?? null
  );
}

function queryRows(db: ReturnType<typeof openDb>, argv: string[]): ErrorOutputRow[] {
  const booleanFlags = options
    .filter((option) => option.type === "boolean")
    .map((option) => option.name);
  const parsed = parseArgv(argv, booleanFlags);
  const filters = parseFilters(parsed.flags);
  const names = flagStrings(parsed.flags, "name");
  const pattern = flagString(parsed.flags, "pattern");
  const resultRegex = pattern === undefined ? undefined : new RegExp(pattern);
  const filterWhere = buildWhereFragments(filters, {
    project: ["s.project_dir", "s.cwd"],
    session: "s.session_id",
    timestamp: "tc.result_ts",
    model: "m.model",
    subagentParent: "s.parent_session_id",
  });
  const params = [...filterWhere.params];

  filterWhere.clauses.push("tc.is_error = 1");
  if (names.length > 0) {
    filterWhere.clauses.push(`tc.name IN (${names.map(() => "?").join(", ")})`);
    params.push(...names);
  }

  const query = db.query(
    `SELECT
       tc.id,
       tc.name,
       tc.input,
       tc.result_text,
       tc.is_error,
       tc.latency_ms,
       tc.session_id AS internal_session_id,
       COALESCE(s.session_id, tc.session_id) AS session_id,
       s.project_dir AS project_dir,
       tc.result_ts AS timestamp,
       tc.message_uuid AS uuid
     FROM tool_calls tc
     LEFT JOIN sessions s ON s.id = tc.session_id
     LEFT JOIN messages m ON m.session_id = tc.session_id AND m.uuid = tc.message_uuid
     ${whereClause({ clauses: filterWhere.clauses, params })}
     ORDER BY tc.result_ts IS NULL, tc.result_ts ASC, tc.id ASC`,
  );
  const matchingRows: ErrorQueryRow[] = [];
  for (const row of query.iterate(
    ...(params as SQLQueryBindings[]),
  ) as IterableIterator<ErrorQueryRow>) {
    if (resultRegex !== undefined && !resultRegex.test(row.result_text)) continue;
    matchingRows.push(row);
    if (matchingRows.length >= filters.limit) break;
  }

  const sessionIds = [...new Set(matchingRows.map((row) => row.internal_session_id))];
  const messagesBySession = new Map<string, MessageRow[]>();
  if (sessionIds.length > 0) {
    const messages = db
      .query(
        `SELECT session_id, ts AS timestamp, type, text
         FROM messages
         WHERE session_id IN (${sessionIds.map(() => "?").join(", ")})
         ORDER BY session_id, ts IS NULL, ts ASC, rowid ASC`,
      )
      .all(...sessionIds) as MessageRow[];
    for (const message of messages) {
      const sessionMessages = messagesBySession.get(message.session_id) ?? [];
      sessionMessages.push(message);
      messagesBySession.set(message.session_id, sessionMessages);
    }
  }

  return matchingRows.map((row) => ({
    id: row.id,
    name: row.name,
    input: parseJsonInput(row.input),
    result_text: row.result_text,
    is_error: row.is_error === 1,
    latency_ms: row.latency_ms,
    session_id: row.session_id,
    project_dir: row.project_dir,
    timestamp: row.timestamp,
    uuid: row.uuid,
    assistant_text_after: nextAssistantText(
      messagesBySession,
      row.internal_session_id,
      row.timestamp,
    ),
  }));
}

async function run(argv: string[]): Promise<void> {
  const db = openDb();
  try {
    const parsed = parseArgv(
      argv,
      options.filter((option) => option.type === "boolean").map((option) => option.name),
    );
    const rows = queryRows(db, argv);
    console.log(
      renderOutput(buildDocument("errors", rows), {
        table: flagBoolean(parsed.flags, "table"),
        redact: flagBoolean(parsed.flags, "redact", true),
      }),
    );
  } finally {
    db.close();
  }
}

export const command: Command = {
  name: "errors",
  description: "List is_error tool results with the preceding call and the next assistant text.",
  options,
  run,
};

if (import.meta.main) {
  command.run(process.argv.slice(2)).catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
