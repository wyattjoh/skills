#!/usr/bin/env bun

/**
 * `projects`: list indexed project directories with cwd, last activity,
 * session count, and worktree parent when the cwd sits under
 * .claude/worktrees/.
 *
 * Usage:
 *   bun $SKILL_DIR/scripts/cli.ts projects [options]
 */

import { booleanFlagNames, flagString, parseArgv } from "../lib/args.ts";
import type { SQLQueryBindings } from "bun:sqlite";
import { openDb } from "../lib/db.ts";
import {
  buildWhereFragments,
  parseFilters,
  SHARED_FILTER_OPTIONS,
  whereClause,
} from "../lib/filters.ts";
import {
  buildDocument,
  OUTPUT_OPTIONS,
  renderOptionsFromFlags,
  renderOutput,
  toIsoTimestamp,
} from "../lib/output.ts";
import type { Command, CommandOption } from "./index.ts";

const options: CommandOption[] = [
  ...SHARED_FILTER_OPTIONS,
  {
    name: "search",
    type: "string",
    description: "Filter by substring of the encoded project dir or cwd",
  },
  ...OUTPUT_OPTIONS,
];

interface ProjectRow {
  project_dir: string;
  cwd: string | null;
  timestamp: string | null;
  session_count: number;
}

interface ProjectOutputRow {
  project_dir: string;
  cwd: string | null;
  timestamp: string | null;
  session_count: number;
  worktree_parent?: string;
}

function worktreeParent(cwd: string | null): string | undefined {
  if (cwd === null) return undefined;
  const marker = "/.claude/worktrees/";
  const markerStart = cwd.indexOf(marker);
  if (markerStart === -1) return undefined;
  return cwd.slice(0, markerStart);
}

function toOutputRow(row: ProjectRow): ProjectOutputRow {
  const parent = worktreeParent(row.cwd);
  const output: ProjectOutputRow = {
    project_dir: row.project_dir,
    cwd: row.cwd,
    timestamp: toIsoTimestamp(row.timestamp),
    session_count: row.session_count,
  };
  if (parent !== undefined) output.worktree_parent = parent;
  return output;
}

async function run(argv: string[]): Promise<void> {
  const { flags } = parseArgv(argv, booleanFlagNames(options));
  const filters = parseFilters(flags);
  const search = flagString(flags, "search");
  const projectActivity = filters.includeSubagents
    ? "(SELECT MAX(COALESCE(activity_sessions.ended_at, activity_sessions.started_at)) FROM sessions AS activity_sessions WHERE activity_sessions.project_dir = projects.dir)"
    : "projects.last_activity";
  const projectSessionCount = filters.includeSubagents
    ? "(SELECT COUNT(*) FROM sessions AS count_sessions WHERE count_sessions.project_dir = projects.dir)"
    : "projects.session_count";
  const filter = buildWhereFragments(filters, {
    project: ["projects.dir", "projects.cwd"],
    timestamp: projectActivity,
  });
  const clauses = [...filter.clauses];
  const params = [...filter.params];
  if (!filters.includeSubagents) clauses.push("projects.session_count > 0");

  if (search !== undefined) {
    clauses.push(
      "(instr(lower(projects.dir), lower(?)) > 0 OR instr(lower(COALESCE(projects.cwd, '')), lower(?)) > 0)",
    );
    params.push(search, search);
  }

  if (filters.sessions.length > 0) {
    clauses.push(
      `EXISTS (
         SELECT 1 FROM sessions AS filtered_sessions
         WHERE filtered_sessions.project_dir = projects.dir
           AND filtered_sessions.session_id IN (${filters.sessions.map(() => "?").join(", ")})
           ${filters.includeSubagents ? "" : "AND filtered_sessions.parent_session_id IS NULL"}
       )`,
    );
    params.push(...filters.sessions);
  }

  if (filters.model !== undefined) {
    clauses.push(
      `EXISTS (
         SELECT 1 FROM sessions AS filtered_sessions
         WHERE filtered_sessions.project_dir = projects.dir
           AND EXISTS (
             SELECT 1 FROM json_each(filtered_sessions.models) AS filtered_models
             WHERE filtered_models.value = ?
           )
           ${filters.includeSubagents ? "" : "AND filtered_sessions.parent_session_id IS NULL"}
       )`,
    );
    params.push(filters.model);
  }

  const db = openDb();
  try {
    const queryParams = [...params, filters.limit] as SQLQueryBindings[];
    const rows = db
      .query(
        `SELECT
           projects.dir AS project_dir,
           projects.cwd AS cwd,
           ${projectActivity} AS timestamp,
           ${projectSessionCount} AS session_count
         FROM projects
         ${whereClause({ clauses, params })}
         ORDER BY CASE WHEN ${projectActivity} IS NULL THEN 1 ELSE 0 END,
                  ${projectActivity} DESC,
                  projects.dir ASC
         LIMIT ?`,
      )
      .all(...queryParams) as ProjectRow[];
    const document = buildDocument("projects", rows.map(toOutputRow));

    console.log(renderOutput(document, renderOptionsFromFlags(flags)));
  } finally {
    db.close();
  }
}

export const command: Command = {
  name: "projects",
  description: "List indexed project directories with cwd, activity, and session count.",
  options,
  run,
};

if (import.meta.main) {
  command.run(process.argv.slice(2)).catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
