#!/usr/bin/env bun

/**
 * `stats`: aggregate session counters, token usage, and durations.
 *
 * Usage:
 *   bun $SKILL_DIR/scripts/cli.ts stats [options]
 */

import type { Database } from "bun:sqlite";
import { booleanFlagNames, flagString, parseArgv } from "../lib/args.ts";
import { openDb } from "../lib/db.ts";
import { parseJsonStringArray } from "../lib/json.ts";
import {
  buildWhereFragments,
  parseFilters,
  SHARED_FILTER_OPTIONS,
  whereClause,
  type ParsedFilters,
} from "../lib/filters.ts";
import {
  buildDocument,
  OUTPUT_OPTIONS,
  renderOptionsFromFlags,
  renderOutput,
  type RenderOptions,
} from "../lib/output.ts";
import type { Command, CommandOption } from "./index.ts";
export type { Command, CommandOption } from "./index.ts";

/** The dimensions supported by the stats command. */
export type StatsBy = "project" | "model" | "version" | "day" | "session";

/** One aggregate row returned by the stats command. */
export interface StatsRow {
  group: string | null;
  sessions: number;
  messages: number;
  tool_calls: number;
  errors: number;
  interruptions: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
  duration_seconds: number;
}

interface SessionStatsRow {
  id: string;
  session_id: string;
  project_dir: string | null;
  project_identity: string | null;
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

const options: CommandOption[] = [
  ...SHARED_FILTER_OPTIONS,
  { name: "by", type: "string", description: "Group by project, model, version, day, or session" },
  ...OUTPUT_OPTIONS,
];

const STATS_BY_VALUES: StatsBy[] = ["project", "model", "version", "day", "session"];

function parseStatsBy(raw: string | undefined, present: boolean): StatsBy {
  if (present && raw === undefined) throw new Error("--by requires a value");
  const value = raw ?? "project";
  if ((STATS_BY_VALUES as string[]).includes(value)) return value as StatsBy;
  throw new Error(`Invalid --by: ${value}`);
}

function groupValues(row: SessionStatsRow, by: StatsBy): Array<string | null> {
  switch (by) {
    case "project":
      return [row.project_identity];
    case "session":
      return [row.session_id];
    case "day": {
      const timestamp = row.started_at ?? row.ended_at;
      return [timestamp === null ? null : timestamp.slice(0, 10)];
    }
    case "model": {
      const models = [...new Set(parseJsonStringArray(row.models))];
      return models.length > 0 ? models : [null];
    }
    case "version": {
      const versions = [...new Set(parseJsonStringArray(row.versions))];
      return versions.length > 0 ? versions : [null];
    }
  }
}

function durationSeconds(row: SessionStatsRow): number {
  if (row.started_at === null || row.ended_at === null) return 0;
  const started = Date.parse(row.started_at);
  const ended = Date.parse(row.ended_at);
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return 0;
  return Math.max(0, (ended - started) / 1000);
}

function emptyStatsRow(group: string | null): StatsRow {
  return {
    group,
    sessions: 0,
    messages: 0,
    tool_calls: 0,
    errors: 0,
    interruptions: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_create_tokens: 0,
    duration_seconds: 0,
  };
}

function addSession(row: StatsRow, session: SessionStatsRow): void {
  row.sessions += 1;
  row.messages += session.message_count;
  row.tool_calls += session.tool_call_count;
  row.errors += session.error_count;
  row.interruptions += session.interruption_count;
  row.input_tokens += session.input_tokens;
  row.output_tokens += session.output_tokens;
  row.cache_read_tokens += session.cache_read_tokens;
  row.cache_create_tokens += session.cache_create_tokens;
  row.duration_seconds += durationSeconds(session);
}

function compareGroups(left: StatsRow, right: StatsRow): number {
  if (left.group === null) return right.group === null ? 0 : -1;
  if (right.group === null) return 1;
  return left.group.localeCompare(right.group);
}

function roundDuration(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function loadSessions(db: Database, filters: ParsedFilters): SessionStatsRow[] {
  const base = buildWhereFragments(filters, {
    project: "s.project_identity",
    session: "s.session_id",
    timestamp: "s.started_at",
    subagentParent: "s.parent_session_id",
  });
  const clauses = [...base.clauses];
  const params = [...base.params];

  if (filters.model !== undefined) {
    clauses.push(
      "EXISTS (SELECT 1 FROM json_each(s.models) AS session_model WHERE session_model.value = ?)",
    );
    params.push(filters.model);
  }

  const query = `
    SELECT
      s.id,
      s.session_id,
      s.project_dir,
      s.project_identity,
      s.started_at,
      s.ended_at,
      s.models,
      s.versions,
      s.message_count,
      s.tool_call_count,
      s.error_count,
      s.interruption_count,
      s.input_tokens,
      s.output_tokens,
      s.cache_read_tokens,
      s.cache_create_tokens
    FROM sessions AS s
    ${whereClause({ clauses, params })}
  `;

  return db.query(query).all(...params.map((param) => String(param))) as SessionStatsRow[];
}

/**
 * Aggregate indexed sessions by one of the supported dimensions.
 *
 * @param db Open index database.
 * @param filters Shared command filters to apply before aggregation.
 * @param by Dimension used for the `group` field.
 * @returns Sorted aggregate rows, limited by the shared filter limit.
 */
export function collectStats(db: Database, filters: ParsedFilters, by: StatsBy): StatsRow[] {
  const grouped = new Map<string | null, StatsRow>();
  for (const session of loadSessions(db, filters)) {
    for (const group of groupValues(session, by)) {
      const row = grouped.get(group) ?? emptyStatsRow(group);
      addSession(row, session);
      grouped.set(group, row);
    }
  }

  return [...grouped.values()]
    .map((row) => ({ ...row, duration_seconds: roundDuration(row.duration_seconds) }))
    .toSorted(compareGroups)
    .slice(0, filters.limit);
}

function parseStatsArgs(argv: string[]): {
  filters: ParsedFilters;
  by: StatsBy;
  output: RenderOptions;
} {
  const { flags, positionals } = parseArgv(argv, booleanFlagNames(options));
  if (positionals.length > 0) throw new Error("stats does not accept positional arguments");

  return {
    filters: parseFilters(flags),
    by: parseStatsBy(flagString(flags, "by"), flags.by !== undefined),
    output: renderOptionsFromFlags(flags),
  };
}

async function run(argv: string[]): Promise<void> {
  const parsed = parseStatsArgs(argv);
  const db = openDb();
  try {
    const rows = collectStats(db, parsed.filters, parsed.by);
    console.log(renderOutput(buildDocument("stats", rows), parsed.output));
  } finally {
    db.close();
  }
}

export const command: Command = {
  name: "stats",
  description: "Aggregate tokens, calls, errors, interruptions, and durations.",
  options,
  run,
};

if (import.meta.main) {
  command.run(process.argv.slice(2)).catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
