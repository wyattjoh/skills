/**
 * Shared query filters every read command accepts: --project, --session,
 * --since, --until, --model, --include-subagents, --limit. parseFilters()
 * turns parsed flags into a typed, resolved filter set (relative times
 * resolved against an injected `now`, never `Date.now()` internally so
 * callers can test deterministically). buildWhereFragments() turns that
 * filter set into a SQL WHERE fragment with bound params for a given table's
 * column names, since different commands query sessions, messages, or
 * tool_calls, each with different column availability.
 */

import { type FlagValue, flagBoolean, flagString, flagStrings } from "./args.ts";

/** The shared filter flags every read command declares in its options list. */
export const SHARED_FILTER_OPTIONS = [
  {
    name: "project",
    type: "string" as const,
    multiple: true,
    description: "Filter by substring of the encoded project dir or cwd (repeatable)",
  },
  {
    name: "session",
    type: "string" as const,
    multiple: true,
    description: "Filter by session id (repeatable)",
  },
  {
    name: "since",
    type: "string" as const,
    description:
      "Only include records at or after this time (ISO 8601, or relative like 3h, 6d, 2w)",
  },
  {
    name: "until",
    type: "string" as const,
    description:
      "Only include records at or before this time (ISO 8601, or relative like 3h, 6d, 2w)",
  },
  { name: "model", type: "string" as const, description: "Filter by model name" },
  {
    name: "include-subagents",
    type: "boolean" as const,
    description: "Include subagent transcript sessions (excluded by default)",
  },
  {
    name: "limit",
    type: "string" as const,
    description: "Maximum number of rows to return (default 100)",
  },
];

export interface ParsedFilters {
  projects: string[];
  sessions: string[];
  /** Resolved to an ISO 8601 string, or undefined if not given. */
  since?: string;
  /** Resolved to an ISO 8601 string, or undefined if not given. */
  until?: string;
  model?: string;
  includeSubagents: boolean;
  limit: number;
}

const RELATIVE_PATTERN = /^(\d+)(s|m|h|d|w)$/;

// A loose ISO 8601 shape: YYYY-MM-DD, optionally followed by a time and an
// offset or "Z". Guards `new Date(raw)` below, which otherwise accepts
// nonsense like "3" (parsed as March 2001) or "purple" as a valid instant.
const ISO_LIKE_PATTERN =
  /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Resolve a --since/--until value to an ISO 8601 timestamp. Accepts a
 * relative offset (`3h`, `6d`, `2w`, ...) resolved against `now`, or an
 * ISO 8601 (or otherwise `Date`-parseable) absolute timestamp.
 */
export function resolveTimestamp(raw: string, now: Date): string {
  const relative = RELATIVE_PATTERN.exec(raw);
  if (relative !== null) {
    const amount = Number.parseInt(relative[1]!, 10);
    const unitMs = UNIT_MS[relative[2]!]!;
    return new Date(now.getTime() - amount * unitMs).toISOString();
  }

  if (!ISO_LIKE_PATTERN.test(raw)) {
    throw new Error(`Invalid timestamp: ${raw}`);
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid timestamp: ${raw}`);
  }
  return parsed.toISOString();
}

const DEFAULT_LIMIT = 100;

/** A bare positive integer: no sign, no decimal point, no exponent. */
const LIMIT_PATTERN = /^[1-9]\d*$/;

/**
 * Parse --limit. Absent means the default; anything present that is not a
 * bare positive integer is rejected outright rather than silently falling
 * back, since a silent fallback previously made `--limit=1e9` mean 1,
 * `--limit=5.9` mean 5, and `--limit=abc` mean the default with no
 * indication anything was wrong.
 */
function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (!LIMIT_PATTERN.test(raw)) {
    throw new Error(`Invalid --limit: ${raw}`);
  }
  return Number(raw);
}

/**
 * Parse the shared filter flags. `now` defaults to the current time but
 * should be injected by tests so relative --since/--until values resolve
 * deterministically.
 */
export function parseFilters(
  flags: Record<string, FlagValue>,
  now: Date = new Date(),
): ParsedFilters {
  const since = flagString(flags, "since");
  const until = flagString(flags, "until");

  return {
    projects: flagStrings(flags, "project"),
    sessions: flagStrings(flags, "session"),
    since: since === undefined ? undefined : resolveTimestamp(since, now),
    until: until === undefined ? undefined : resolveTimestamp(until, now),
    model: flagString(flags, "model"),
    includeSubagents: flagBoolean(flags, "include-subagents", false),
    limit: parseLimit(flagString(flags, "limit")),
  };
}

/**
 * Column expressions (qualified with a table alias where the caller joins,
 * e.g. "sessions.project_dir") available for a given query. Filters whose
 * column is omitted are silently skipped, since not every table carries
 * every column (only `sessions` has `parent_session_id`, for instance).
 */
export interface FilterColumns {
  /** One or more columns to match --project substrings against (OR'd). */
  project?: string[];
  /**
   * The column --session values are matched against with an exact IN.
   * `sessions.session_id` holds the raw session id, but `messages.session_id`
   * and `tool_calls.session_id` hold the composite `<project_dir>:<session_id>`
   * key (see `sessionKey()` in `lib/ingest.ts`). A message- or tool-call-level
   * query that wants `--session` to work against a raw id must join
   * `sessions` and point this at `sessions.session_id`, not at its own
   * `session_id` column, or every `--session` filter will silently match
   * zero rows.
   */
  session?: string;
  timestamp?: string;
  model?: string;
  /** A column that is NULL for a non-subagent row, e.g. sessions.parent_session_id. */
  subagentParent?: string;
}

export interface WhereFragment {
  clauses: string[];
  params: unknown[];
}

/** Build the AND-ed list of SQL clauses and bound params for a filter set. */
export function buildWhereFragments(filters: ParsedFilters, columns: FilterColumns): WhereFragment {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filters.projects.length > 0 && columns.project !== undefined && columns.project.length > 0) {
    const projectColumns = columns.project;
    const projectClauses: string[] = [];
    for (const project of filters.projects) {
      for (const column of projectColumns) {
        projectClauses.push(`${column} LIKE ?`);
        params.push(`%${project}%`);
      }
    }
    clauses.push(`(${projectClauses.join(" OR ")})`);
  }

  if (filters.sessions.length > 0 && columns.session !== undefined) {
    const placeholders = filters.sessions.map(() => "?").join(", ");
    clauses.push(`${columns.session} IN (${placeholders})`);
    params.push(...filters.sessions);
  }

  if (filters.since !== undefined && columns.timestamp !== undefined) {
    clauses.push(`${columns.timestamp} >= ?`);
    params.push(filters.since);
  }

  if (filters.until !== undefined && columns.timestamp !== undefined) {
    clauses.push(`${columns.timestamp} <= ?`);
    params.push(filters.until);
  }

  if (filters.model !== undefined && columns.model !== undefined) {
    clauses.push(`${columns.model} = ?`);
    params.push(filters.model);
  }

  if (!filters.includeSubagents && columns.subagentParent !== undefined) {
    clauses.push(`${columns.subagentParent} IS NULL`);
  }

  return { clauses, params };
}

/** Render a WhereFragment as a `WHERE ...` clause, or "" when there are no clauses. */
export function whereClause(fragment: WhereFragment): string {
  if (fragment.clauses.length === 0) return "";
  return `WHERE ${fragment.clauses.join(" AND ")}`;
}
