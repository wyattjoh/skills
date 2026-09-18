#!/usr/bin/env bun

/**
 * `projects`: aggregate indexed sessions by canonical primary repository root.
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
    description: "Filter by substring of the canonical project root",
  },
  ...OUTPUT_OPTIONS,
];

interface ProjectRow {
  project_identity: string;
  project_dirs: string;
  timestamp: string | null;
  session_count: number;
}

interface ProjectOutputRow {
  project_identity: string;
  project_dirs: string[];
  cwd: string;
  timestamp: string | null;
  session_count: number;
}

function toOutputRow(row: ProjectRow): ProjectOutputRow {
  return {
    project_identity: row.project_identity,
    project_dirs: (JSON.parse(row.project_dirs) as string[]).toSorted(),
    cwd: row.project_identity,
    timestamp: toIsoTimestamp(row.timestamp),
    session_count: row.session_count,
  };
}

async function run(argv: string[]): Promise<void> {
  const { flags } = parseArgv(argv, booleanFlagNames(options));
  const filters = parseFilters(flags);
  const search = flagString(flags, "search");
  const filter = buildWhereFragments(filters, {
    project: "sessions.project_identity",
    session: "sessions.session_id",
    timestamp: "COALESCE(sessions.ended_at, sessions.started_at)",
    model: "sessions.models",
    subagentParent: "sessions.parent_session_id",
  });
  const clauses = ["sessions.project_identity IS NOT NULL", ...filter.clauses];
  const params = [...filter.params];

  if (search !== undefined) {
    clauses.push("instr(lower(sessions.project_identity), lower(?)) > 0");
    params.push(search);
  }

  if (filters.model !== undefined) {
    const modelClause = filter.clauses.find((clause) => clause.includes("sessions.models"));
    if (modelClause !== undefined) {
      const index = clauses.indexOf(modelClause);
      clauses[index] = `EXISTS (
        SELECT 1 FROM json_each(sessions.models) AS filtered_models
        WHERE filtered_models.value = ?
      )`;
    }
  }

  const db = openDb();
  try {
    const rows = db
      .query(
        `SELECT
           sessions.project_identity AS project_identity,
           json_group_array(DISTINCT sessions.project_dir) AS project_dirs,
           MAX(COALESCE(sessions.ended_at, sessions.started_at)) AS timestamp,
           COUNT(*) AS session_count
         FROM sessions
         ${whereClause({ clauses, params })}
         GROUP BY sessions.project_identity
         ORDER BY timestamp DESC, sessions.project_identity ASC
         LIMIT ?`,
      )
      .all(...([...params, filters.limit] as SQLQueryBindings[])) as ProjectRow[];
    console.log(
      renderOutput(buildDocument("projects", rows.map(toOutputRow)), renderOptionsFromFlags(flags)),
    );
  } finally {
    db.close();
  }
}

export const command: Command = {
  name: "projects",
  description: "List canonical repository roots with activity and session counts.",
  options,
  run,
};

if (import.meta.main) {
  command.run(process.argv.slice(2)).catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
