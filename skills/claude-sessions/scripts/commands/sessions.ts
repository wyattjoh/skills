#!/usr/bin/env bun

/**
 * `sessions`: list session metadata and counts.
 *
 * Usage:
 *   bun $SKILL_DIR/scripts/cli.ts sessions [options]
 */

import { Effect } from "effect";
import { runEffectPromise, tryIO } from "../lib/io.ts";
import { booleanFlagNames, flagString, parseArgv } from "../lib/args.ts";
import {
  buildWhereFragments,
  parseFilters,
  SHARED_FILTER_OPTIONS,
  whereClause,
} from "../lib/filters.ts";
import { withDbEffect } from "../lib/effect.ts";
import { parseJsonStringArray } from "../lib/json.ts";
import {
  JUDGE_OPTIONS,
  OUTPUT_OPTIONS,
  renderDocumentWithJudgeEffect,
  toIsoTimestamp,
} from "../lib/output.ts";
import type { CommandOption, JudgeCommand } from "./index.ts";

const options: CommandOption[] = [
  ...SHARED_FILTER_OPTIONS,
  {
    name: "sort",
    type: "string",
    description: "Sort by date, messages, tokens, or errors (default: date)",
  },
  {
    name: "first-prompt",
    type: "string",
    description: "Filter by substring of the session's first prompt",
  },
  ...OUTPUT_OPTIONS,
  ...JUDGE_OPTIONS,
];

interface SessionRow {
  session_id: string;
  project_dir: string | null;
  project_identity: string | null;
  cwd: string | null;
  git_branch: string | null;
  parent_session_id: string | null;
  agent_name: string | null;
  first_prompt: string | null;
  started_at: string | null;
  ended_at: string | null;
  models: string;
  versions: string;
  message_count: number;
  tool_call_count: number;
  error_count: number;
  interruption_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
}

interface SessionOutputRow {
  session_id: string;
  project_dir: string | null;
  project_identity: string | null;
  timestamp: string | null;
  cwd: string | null;
  git_branch: string | null;
  parent_session_id: string | null;
  agent_name: string | null;
  first_prompt: string | null;
  started_at: string | null;
  ended_at: string | null;
  models: string[];
  versions: string[];
  message_count: number;
  tool_call_count: number;
  error_count: number;
  interruption_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
}

const SORT_FIELDS = {
  date: "COALESCE(sessions.ended_at, sessions.started_at)",
  messages: "sessions.message_count",
  tokens:
    "(sessions.input_tokens + sessions.output_tokens + sessions.cache_read_tokens + sessions.cache_create_tokens)",
  errors: "sessions.error_count",
} as const;

type SortField = keyof typeof SORT_FIELDS;

function parseSort(raw: string | undefined): SortField {
  const sort = raw ?? "date";
  if (Object.hasOwn(SORT_FIELDS, sort)) return sort as SortField;
  throw new Error(`Invalid --sort: ${sort}`);
}

function toOutputRow(row: SessionRow): SessionOutputRow {
  return {
    session_id: row.session_id,
    project_dir: row.project_dir,
    project_identity: row.project_identity,
    timestamp: toIsoTimestamp(row.ended_at ?? row.started_at),
    cwd: row.cwd,
    git_branch: row.git_branch,
    parent_session_id: row.parent_session_id,
    agent_name: row.agent_name,
    first_prompt: row.first_prompt === null ? null : row.first_prompt.slice(0, 200),
    started_at: toIsoTimestamp(row.started_at),
    ended_at: toIsoTimestamp(row.ended_at),
    models: parseJsonStringArray(row.models),
    versions: parseJsonStringArray(row.versions),
    message_count: row.message_count,
    tool_call_count: row.tool_call_count,
    error_count: row.error_count,
    interruption_count: row.interruption_count,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cache_read_tokens: row.cache_read_tokens,
    cache_create_tokens: row.cache_create_tokens,
  };
}

const runEffect = Effect.fn("sessions.run")(function* (argv: string[]) {
  const { flags } = yield* Effect.try({
    try: () => parseArgv(argv, booleanFlagNames(options)),
    catch: (cause) => cause,
  });
  const filters = yield* Effect.try({ try: () => parseFilters(flags), catch: (cause) => cause });
  const sort = yield* Effect.try({
    try: () => parseSort(flagString(flags, "sort")),
    catch: (cause) => cause,
  });
  const firstPrompt = flagString(flags, "first-prompt");
  const where = buildWhereFragments(filters, {
    project: "sessions.project_identity",
    session: "sessions.session_id",
    timestamp: "COALESCE(sessions.ended_at, sessions.started_at)",
    subagentParent: "sessions.parent_session_id",
  });

  if (firstPrompt !== undefined) {
    where.clauses.push("instr(lower(COALESCE(sessions.first_prompt, '')), lower(?)) > 0");
    where.params.push(firstPrompt);
  }
  if (filters.model !== undefined) {
    where.clauses.push(
      "EXISTS (SELECT 1 FROM json_each(sessions.models) AS session_models WHERE session_models.value = ?)",
    );
    where.params.push(filters.model);
  }

  return yield* withDbEffect((db) =>
    Effect.gen(function* () {
      const rows = yield* tryIO(
        "execute sessions command",
        () =>
          db
            .query(
              `SELECT
           sessions.session_id,
           sessions.project_dir,
           sessions.project_identity,
           sessions.cwd,
           sessions.git_branch,
           sessions.parent_session_id,
           sessions.agent_name,
           sessions.first_prompt,
           sessions.started_at,
           sessions.ended_at,
           sessions.models,
           sessions.versions,
           sessions.message_count,
           sessions.tool_call_count,
           sessions.error_count,
           sessions.interruption_count,
           sessions.input_tokens,
           sessions.output_tokens,
           sessions.cache_read_tokens,
           sessions.cache_create_tokens
         FROM sessions
         ${whereClause(where)}
         ORDER BY
           CASE WHEN ${SORT_FIELDS[sort]} IS NULL THEN 1 ELSE 0 END,
           ${SORT_FIELDS[sort]} DESC,
           COALESCE(sessions.ended_at, sessions.started_at) DESC,
           sessions.id ASC
         LIMIT ?`,
            )
            .all(...(where.params as Array<string | number | null>), filters.limit) as SessionRow[],
      );
      const output = yield* renderDocumentWithJudgeEffect(
        "sessions",
        rows.map(toOutputRow),
        flags,
        db,
        ["task-kind"],
      );
      yield* tryIO("execute sessions command", () => console.log(output));
    }),
  );
});

function run(argv: string[]): Promise<void> {
  return runEffectPromise(runEffect(argv));
}

export const command: JudgeCommand = {
  name: "sessions",
  description: "List session metadata and counts.",
  options,
  judgePresets: ["task-kind"],
  run,
  runEffect,
};

if (import.meta.main) {
  runEffectPromise(command.runEffect(process.argv.slice(2))).catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
