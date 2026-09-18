#!/usr/bin/env bun

/**
 * `projects`: list indexed project directories with cwd, last activity,
 * session count, and worktree parent when the cwd sits under
 * .claude/worktrees/.
 *
 * Usage:
 *   bun $SKILL_DIR/scripts/cli.ts projects [options]
 */

import { flagBoolean, flagString, parseArgv } from "../lib/args.ts";
import { openDb } from "../lib/db.ts";
import { whereClause } from "../lib/filters.ts";
import { buildDocument, renderOutput, OUTPUT_OPTIONS } from "../lib/output.ts";

export interface CommandOption {
  name: string;
  type: "string" | "boolean";
  multiple?: boolean;
  description: string;
  negated?: boolean;
}

export interface Command {
  name: string;
  description: string;
  options: CommandOption[];
  usage?: string;
  run: (argv: string[]) => Promise<void>;
}

const options: CommandOption[] = [
  {
    name: "search",
    type: "string",
    description: "Filter by substring of the encoded project dir or cwd",
  },
  ...OUTPUT_OPTIONS,
];

interface ProjectRow {
  dir: string;
  cwd: string | null;
  last_activity: string | null;
  session_count: number;
}

interface ProjectOutputRow {
  project_dir: string;
  cwd: string | null;
  last_activity: string | null;
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
    project_dir: row.dir,
    cwd: row.cwd,
    last_activity: row.last_activity,
    session_count: row.session_count,
  };
  if (parent !== undefined) output.worktree_parent = parent;
  return output;
}

async function run(argv: string[]): Promise<void> {
  const booleanFlags = options
    .filter((option) => option.type === "boolean")
    .map((option) => option.name);
  const { flags } = parseArgv(argv, booleanFlags);
  const search = flagString(flags, "search");
  const db = openDb();

  try {
    const clauses: string[] = [];
    const params: string[] = [];
    if (search !== undefined) {
      clauses.push(
        "(instr(lower(dir), lower(?)) > 0 OR instr(lower(COALESCE(cwd, '')), lower(?)) > 0)",
      );
      params.push(search, search);
    }

    const where = whereClause({ clauses, params });
    const rows = db
      .query(
        `SELECT dir, cwd, last_activity, session_count
         FROM projects
         ${where}
         ORDER BY CASE WHEN last_activity IS NULL THEN 1 ELSE 0 END,
                  last_activity DESC,
                  dir ASC`,
      )
      .all(...params) as ProjectRow[];
    const outputRows = rows.map(toOutputRow);
    const document = buildDocument("projects", outputRows);

    console.log(
      renderOutput(document, {
        table: flagBoolean(flags, "table"),
        redact: flagBoolean(flags, "redact", true),
      }),
    );
  } finally {
    db.close();
  }
}

export const command: Command = {
  name: "projects",
  description: "List indexed project directories with cwd, last activity, and session count.",
  options,
  run,
};

if (import.meta.main) {
  command.run(process.argv.slice(2)).catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
