#!/usr/bin/env bun

/**
 * `tools`: tool calls paired with their results.
 *
 * Usage:
 *   bun $SKILL_DIR/scripts/cli.ts tools [options]
 */

import { flagBoolean, flagString, flagStrings, parseArgv } from "../lib/args.ts";
import {
  buildWhereFragments,
  parseFilters,
  SHARED_FILTER_OPTIONS,
  whereClause,
} from "../lib/filters.ts";
import { openDb } from "../lib/db.ts";
import type { SQLQueryBindings } from "bun:sqlite";
import { buildDocument, OUTPUT_OPTIONS, renderOutput } from "../lib/output.ts";
import type { Command, CommandOption } from "./index.ts";

const options: CommandOption[] = [
  ...SHARED_FILTER_OPTIONS,
  { name: "name", type: "string", multiple: true, description: "Filter by tool name (repeatable)" },
  { name: "input", type: "string", description: "Filter by regex over the tool input" },
  {
    name: "errors-only",
    type: "boolean",
    description: "Only include calls whose result was an error",
  },
  { name: "agent-type", type: "string", description: "Filter Agent calls by subagent type" },
  { name: "skill", type: "string", description: "Filter Skill calls by skill name" },
  {
    name: "result-chars",
    type: "string",
    description: "Maximum result text characters (default 400)",
  },
  ...OUTPUT_OPTIONS,
];

interface ToolQueryRow {
  id: string;
  name: string;
  input: string;
  result_text: string | null;
  is_error: number;
  latency_ms: number | null;
  session_id: string;
  project_dir: string | null;
  timestamp: string | null;
  uuid: string;
}

interface ToolOutputRow {
  id: string;
  name: string;
  input: unknown;
  result_text: string | null;
  is_error: boolean;
  latency_ms: number | null;
  session_id: string;
  project_dir: string | null;
  timestamp: string | null;
  uuid: string;
}

function parseJsonInput(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

function parseResultChars(raw: string | undefined): number {
  if (raw === undefined) return 400;
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid --result-chars: ${raw}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid --result-chars: ${raw}`);
  return value;
}

function truncateResult(value: string | null, maxChars: number): string | null {
  if (value === null || value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - 3)}...`;
}

function queryRows(db: ReturnType<typeof openDb>, argv: string[]): ToolOutputRow[] {
  const booleanFlags = options
    .filter((option) => option.type === "boolean")
    .map((option) => option.name);
  const parsed = parseArgv(argv, booleanFlags);
  const filters = parseFilters(parsed.flags);
  const names = flagStrings(parsed.flags, "name");
  const inputPattern = flagString(parsed.flags, "input");
  const inputRegex = inputPattern === undefined ? undefined : new RegExp(inputPattern);
  const resultChars = parseResultChars(flagString(parsed.flags, "result-chars"));
  const clauses = buildWhereFragments(filters, {
    project: ["s.project_dir", "s.cwd"],
    session: "s.session_id",
    timestamp: "tc.ts",
    model: "m.model",
    subagentParent: "s.parent_session_id",
  });
  const params = [...clauses.params];

  if (names.length > 0) {
    clauses.clauses.push(`tc.name IN (${names.map(() => "?").join(", ")})`);
    params.push(...names);
  }
  if (flagBoolean(parsed.flags, "errors-only")) {
    clauses.clauses.push("tc.is_error = 1");
  }
  const agentType = flagString(parsed.flags, "agent-type");
  if (agentType !== undefined) {
    clauses.clauses.push("tc.subagent_type = ?");
    params.push(agentType);
  }
  const skill = flagString(parsed.flags, "skill");
  if (skill !== undefined) {
    clauses.clauses.push("tc.skill_name = ?");
    params.push(skill);
  }

  const query = db.query(
    `SELECT
       tc.id,
       tc.name,
       tc.input,
       tc.result_text,
       tc.is_error,
       tc.latency_ms,
       COALESCE(s.session_id, tc.session_id) AS session_id,
       s.project_dir AS project_dir,
       tc.ts AS timestamp,
       tc.message_uuid AS uuid
     FROM tool_calls tc
     LEFT JOIN sessions s ON s.id = tc.session_id
     LEFT JOIN messages m ON m.session_id = tc.session_id AND m.uuid = tc.message_uuid
     ${whereClause({ clauses: clauses.clauses, params })}
     ORDER BY tc.ts IS NULL, tc.ts ASC, tc.id ASC`,
  );
  const matchingRows: ToolQueryRow[] = [];
  for (const row of query.iterate(
    ...(params as SQLQueryBindings[]),
  ) as IterableIterator<ToolQueryRow>) {
    if (inputRegex !== undefined && !inputRegex.test(row.input)) continue;
    matchingRows.push(row);
    if (matchingRows.length >= filters.limit) break;
  }

  return matchingRows.map((row) => ({
    id: row.id,
    name: row.name,
    input: parseJsonInput(row.input),
    result_text: truncateResult(row.result_text, resultChars),
    is_error: row.is_error === 1,
    latency_ms: row.latency_ms,
    session_id: row.session_id,
    project_dir: row.project_dir,
    timestamp: row.timestamp,
    uuid: row.uuid,
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
      renderOutput(buildDocument("tools", rows), {
        table: flagBoolean(parsed.flags, "table"),
        redact: flagBoolean(parsed.flags, "redact", true),
      }),
    );
  } finally {
    db.close();
  }
}

export const command: Command = {
  name: "tools",
  description: "List tool calls paired with their results.",
  options,
  run,
};

if (import.meta.main) {
  command.run(process.argv.slice(2)).catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
