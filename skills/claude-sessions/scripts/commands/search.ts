#!/usr/bin/env bun

/**
 * `search`: full-text search over messages and/or tool calls, with context.
 *
 * Usage:
 *   bun $SKILL_DIR/scripts/cli.ts search <query> [options]
 */

import type { Database } from "bun:sqlite";
import { parseArgv, flagBoolean, flagString } from "../lib/args.ts";
import {
  buildWhereFragments,
  parseFilters,
  whereClause,
  SHARED_FILTER_OPTIONS,
} from "../lib/filters.ts";
import { openDb } from "../lib/db.ts";
import { OUTPUT_OPTIONS, buildDocument, renderOutput } from "../lib/output.ts";

/**
 * Metadata for one option accepted by a CLI command.
 */
export interface CommandOption {
  name: string;
  type: "string" | "boolean";
  multiple: boolean | undefined;
  description: string;
  negated: boolean | undefined;
}

/**
 * Runtime contract implemented by every command module.
 */
export interface Command {
  name: string;
  description: string;
  options: CommandOption[];
  usage: string | undefined;
  run: (argv: string[]) => Promise<void>;
}

const options = [
  ...SHARED_FILTER_OPTIONS,
  { name: "in", type: "string", description: "Search messages, tools, or all (default: messages)" },
  { name: "type", type: "string", description: "Filter message hits by user or assistant" },
  {
    name: "regex",
    type: "string",
    description: "Run a regular expression pass over FTS candidates",
  },
  {
    name: "context",
    type: "string",
    description: "Characters of context on each side of a match (default: 160)",
  },
  {
    name: "include-injected",
    type: "boolean",
    description: "Include injected text (skill bodies, slash-command expansions, system reminders)",
  },
  ...OUTPUT_OPTIONS,
] as CommandOption[];

type SearchSource = "messages" | "tools";

type SearchRow = {
  session_id: string;
  project_dir: string | null;
  timestamp: string | null;
  uuid: string;
  role: string | null;
  snippet: string;
  tool_name: string | undefined;
};

type CandidateRow = {
  session_id: string;
  project_dir: string | null;
  timestamp: string | null;
  uuid: string;
  role: string | null;
  text: string;
  tool_name: string | null;
};

type QueryParam = string | number | boolean | bigint | null;

const BOOLEAN_FLAGS = options
  .filter((option) => option.type === "boolean")
  .map((option) => option.name);
const FTS_OPERATORS = new Set(["and", "or", "not", "near"]);
// Regexes run synchronously, so keep the pattern, candidate set, and input
// text bounded before handing user-controlled data to JavaScript's engine.
const MAX_REGEX_PATTERN_LENGTH = 256;
const MAX_REGEX_CANDIDATES = 1_000;
const MAX_REGEX_TEXT_LENGTH = 32 * 1024;

type RegexGroup = {
  hasQuantifier: boolean;
  hasAlternation: boolean;
};

function hasUnsafeRegexStructure(source: string): string | undefined {
  if (/\\(?:[1-9]\d*|k<[^>]+>)/.test(source)) {
    return "backreferences are not allowed";
  }

  const groups: RegexGroup[] = [];
  let escaped = false;
  let inCharacterClass = false;
  let previousGroupHadQuantifier = false;
  let variableQuantifiers = 0;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "[") {
      inCharacterClass = true;
      continue;
    }
    if (character === "]") {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) continue;

    if (character === "(") {
      groups.push({ hasQuantifier: false, hasAlternation: false });
      previousGroupHadQuantifier = false;
      continue;
    }
    if (character === "|") {
      const group = groups.at(-1);
      if (group !== undefined) group.hasAlternation = true;
      previousGroupHadQuantifier = false;
      continue;
    }
    if (character === ")") {
      const group = groups.pop();
      if (group === undefined) {
        previousGroupHadQuantifier = false;
        continue;
      }
      previousGroupHadQuantifier = group.hasQuantifier || group.hasAlternation;
      const parent = groups.at(-1);
      if (parent !== undefined) {
        parent.hasQuantifier ||= group.hasQuantifier;
        parent.hasAlternation ||= group.hasAlternation;
      }
      continue;
    }

    const isGroupPrefix = character === "?" && source[index - 1] === "(";
    const isQuantifier =
      character === "*" ||
      character === "+" ||
      (character === "?" && !isGroupPrefix) ||
      character === "{";
    if (!isQuantifier) {
      previousGroupHadQuantifier = false;
      continue;
    }

    if (previousGroupHadQuantifier) {
      return "nested or repeated quantified groups are not allowed";
    }

    const rangeEnd = character === "{" ? source.indexOf("}", index + 1) : -1;
    const range =
      rangeEnd === -1
        ? undefined
        : (/^\{(\d+)(?:,(\d*))?\}$/.exec(source.slice(index, rangeEnd + 1)) ?? undefined);
    let isVariableRange = false;
    if (range !== undefined) {
      const lower = Number(range[1]);
      const hasComma = range[2] !== undefined;
      const upper = !hasComma ? lower : range[2] === "" ? undefined : Number(range[2]);
      if (lower > MAX_REGEX_TEXT_LENGTH || (upper !== undefined && upper > MAX_REGEX_TEXT_LENGTH)) {
        return `repetition bounds must not exceed ${MAX_REGEX_TEXT_LENGTH} characters`;
      }
      isVariableRange = hasComma && (range[2] === "" || range[2] !== range[1]);
    }

    const group = groups.at(-1);
    if (group !== undefined) group.hasQuantifier = true;
    if (
      character === "*" ||
      character === "+" ||
      (character === "?" && !isGroupPrefix) ||
      isVariableRange
    ) {
      variableQuantifiers += 1;
      if (variableQuantifiers > 1) {
        return "multiple variable-length quantifiers are not allowed";
      }
    }
    previousGroupHadQuantifier = false;
  }

  return undefined;
}

function parseContext(raw: string | undefined): number {
  if (raw === undefined) return 160;
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid --context: ${raw}`);
  return Number(raw);
}

function parseSource(raw: string | undefined): SearchSource | "all" {
  if (raw === undefined || raw === "messages") return "messages";
  if (raw === "tools") return "tools";
  if (raw === "all") return "all";
  throw new Error(`Invalid --in: ${raw}. Expected messages, tools, or all.`);
}

function parseType(raw: string | undefined): "user" | "assistant" | undefined {
  if (raw === undefined) return undefined;
  if (raw === "user" || raw === "assistant") return raw;
  throw new Error(`Invalid --type: ${raw}. Expected user or assistant.`);
}

function parseRegex(raw: string | undefined): RegExp | undefined {
  if (raw === undefined) return undefined;
  if (raw.length > MAX_REGEX_PATTERN_LENGTH) {
    throw new Error(
      `Rejected --regex: pattern length must be at most ${MAX_REGEX_PATTERN_LENGTH} characters.`,
    );
  }
  const unsafeReason = hasUnsafeRegexStructure(raw);
  if (unsafeReason !== undefined) throw new Error(`Rejected --regex: ${unsafeReason}.`);
  try {
    return new RegExp(raw, "i");
  } catch (err) {
    throw new Error(`Invalid --regex: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
}

function normalizeSnippet(text: string, start: number, end: number): string {
  const boundedStart = Math.max(0, start);
  const boundedEnd = Math.min(text.length, end);
  let snippet = text.slice(boundedStart, boundedEnd).replace(/\s+/g, " ").trim();
  if (boundedStart > 0) snippet = `...${snippet}`;
  if (boundedEnd < text.length) snippet = `${snippet}...`;
  return snippet;
}

function queryTerms(query: string): string[] {
  return (query.match(/[A-Za-z0-9_]+/g) ?? []).filter(
    (term) => !FTS_OPERATORS.has(term.toLowerCase()),
  );
}

function matchPosition(
  text: string,
  query: string,
  regex: RegExp | undefined,
  regexText: string = text,
): [number, number] {
  if (regex !== undefined) {
    const match = regex.exec(regexText);
    if (match !== null) return [match.index, Math.max(match[0].length, 1)];
  }

  const lowerText = text.toLowerCase();
  const quotedQuery = query.replace(/^\s*['"]|['"]\s*$/g, "").trim();
  if (quotedQuery.length > 0) {
    const exactIndex = lowerText.indexOf(quotedQuery.toLowerCase());
    if (exactIndex !== -1) return [exactIndex, quotedQuery.length];
  }

  let bestIndex = -1;
  let bestLength = 0;
  for (const term of queryTerms(query)) {
    const index = lowerText.indexOf(term.toLowerCase());
    if (index !== -1 && (bestIndex === -1 || index < bestIndex)) {
      bestIndex = index;
      bestLength = term.length;
    }
  }
  if (bestIndex !== -1) return [bestIndex, bestLength];
  return [0, 0];
}

function snippetFor(
  text: string,
  query: string,
  regex: RegExp | undefined,
  context: number,
  regexText: string = text,
): string {
  const [index, matchLength] = matchPosition(text, query, regex, regexText);
  return normalizeSnippet(text, index - context, index + matchLength + context);
}

function orderedRows(
  rows: CandidateRow[],
  query: string,
  regex: RegExp | undefined,
  context: number,
): SearchRow[] {
  if (regex !== undefined && rows.length > MAX_REGEX_CANDIDATES) {
    throw new Error(`Rejected --regex: candidate set exceeds ${MAX_REGEX_CANDIDATES} rows.`);
  }

  return rows
    .map((row) => {
      const regexText = row.text.slice(0, MAX_REGEX_TEXT_LENGTH);
      if (regex !== undefined && !regex.test(regexText)) return undefined;
      const result: SearchRow = {
        session_id: row.session_id,
        project_dir: row.project_dir,
        timestamp: row.timestamp,
        uuid: row.uuid,
        role: row.role,
        snippet: snippetFor(row.text, query, regex, context, regexText),
      } as SearchRow;
      if (row.tool_name !== null) result.tool_name = row.tool_name;
      return result;
    })
    .filter((row): row is SearchRow => row !== undefined);
}

function messageWhere(
  filters: ReturnType<typeof parseFilters>,
  type: "user" | "assistant" | undefined,
  includeInjected: boolean,
): { sql: string; params: QueryParam[] } {
  const fragment = buildWhereFragments(filters, {
    project: ["s.project_dir", "s.cwd"],
    session: "s.session_id",
    timestamp: "m.ts",
    model: "m.model",
    subagentParent: "s.parent_session_id",
  });
  const clauses = [...fragment.clauses];
  const params = [...fragment.params] as QueryParam[];
  if (type !== undefined) {
    clauses.push("m.role = ?");
    params.push(type);
  }
  if (!includeInjected) clauses.push("m.is_injected = 0");
  return { sql: whereClause({ clauses, params }), params };
}

function toolWhere(
  filters: ReturnType<typeof parseFilters>,
  includeInjected: boolean,
): { sql: string; params: QueryParam[] } {
  const fragment = buildWhereFragments(filters, {
    project: ["s.project_dir", "s.cwd"],
    session: "s.session_id",
    timestamp: "t.ts",
    model: "m.model",
    subagentParent: "s.parent_session_id",
  });
  const clauses = [...fragment.clauses];
  const params = [...fragment.params] as QueryParam[];
  if (!includeInjected) clauses.push("COALESCE(m.is_injected, 0) = 0");
  return { sql: whereClause({ clauses, params }), params };
}

function messageCandidates(
  db: Database,
  filters: ReturnType<typeof parseFilters>,
  query: string,
  type: "user" | "assistant" | undefined,
  includeInjected: boolean,
  useFts: boolean,
  candidateLimit: number | undefined,
): CandidateRow[] {
  const filter = messageWhere(filters, type, includeInjected);
  const ftsJoin = useFts ? "JOIN messages_fts ON messages_fts.rowid = m.rowid" : "";
  const ftsClause = useFts
    ? ["messages_fts MATCH ?", ...(filter.sql ? [filter.sql.slice(6)] : [])].join(" AND ")
    : filter.sql.slice(6);
  const sql = `
    SELECT
      s.session_id AS session_id,
      s.project_dir AS project_dir,
      m.ts AS timestamp,
      m.uuid AS uuid,
      m.role AS role,
      m.text AS text,
      NULL AS tool_name
    FROM messages m
    JOIN sessions s ON s.id = m.session_id
    ${ftsJoin}
    ${ftsClause.length > 0 ? `WHERE ${ftsClause}` : ""}
    ORDER BY m.ts ASC, m.uuid ASC`;
  const params = useFts ? [query, ...filter.params] : filter.params;
  return runCandidateQuery(db, sql, params, query, useFts, candidateLimit);
}

function runCandidateQuery(
  db: Database,
  sql: string,
  params: QueryParam[],
  query: string,
  useFts: boolean,
  candidateLimit: number | undefined,
): CandidateRow[] {
  const boundedSql = candidateLimit === undefined ? sql : `${sql}\nLIMIT ?`;
  const boundedParams = candidateLimit === undefined ? params : [...params, candidateLimit];
  try {
    return db.query(boundedSql).all(...boundedParams) as CandidateRow[];
  } catch (err) {
    if (!useFts) throw err;
    const phrase = `"${query.replaceAll('"', '""')}"`;
    return db.query(boundedSql).all(phrase, ...boundedParams.slice(1)) as CandidateRow[];
  }
}

function toolCandidates(
  db: Database,
  filters: ReturnType<typeof parseFilters>,
  query: string,
  includeInjected: boolean,
  useFts: boolean,
  candidateLimit: number | undefined,
): CandidateRow[] {
  const filter = toolWhere(filters, includeInjected);
  const ftsJoin = useFts ? "JOIN tool_calls_fts ON tool_calls_fts.rowid = t.rowid" : "";
  const ftsClause = useFts
    ? ["tool_calls_fts MATCH ?", ...(filter.sql ? [filter.sql.slice(6)] : [])].join(" AND ")
    : filter.sql.slice(6);
  const sql = `
    SELECT
      s.session_id AS session_id,
      s.project_dir AS project_dir,
      t.ts AS timestamp,
      t.message_uuid AS uuid,
      'tool' AS role,
      CASE
        WHEN t.result_text IS NULL OR t.result_text = '' THEN t.input
        ELSE t.input || char(10) || t.result_text
      END AS text,
      t.name AS tool_name
    FROM tool_calls t
    JOIN sessions s ON s.id = t.session_id
    LEFT JOIN messages m ON m.session_id = t.session_id AND m.uuid = t.message_uuid
    ${ftsJoin}
    ${ftsClause.length > 0 ? `WHERE ${ftsClause}` : ""}
    ORDER BY t.ts ASC, t.id ASC`;
  const params = useFts ? [query, ...filter.params] : filter.params;
  return runCandidateQuery(db, sql, params, query, useFts, candidateLimit);
}

async function run(argv: string[]): Promise<void> {
  const { positionals, flags } = parseArgv(argv, BOOLEAN_FLAGS);
  const query = positionals.join(" ").trim();
  const regexSource = flagString(flags, "regex");
  const regex = parseRegex(regexSource);
  if (query.length === 0 && regex === undefined) {
    throw new Error("A search query or --regex pattern is required.");
  }

  const filters = parseFilters(flags);
  const source = parseSource(flagString(flags, "in"));
  const context = parseContext(flagString(flags, "context"));
  const type = parseType(flagString(flags, "type"));
  const includeInjected = flagBoolean(flags, "include-injected");
  const useFts = query.length > 0;
  const candidateLimit = regex === undefined ? undefined : MAX_REGEX_CANDIDATES + 1;
  const db = openDb();

  try {
    const candidates: CandidateRow[] = [];
    if (source === "messages" || source === "all") {
      candidates.push(
        ...messageCandidates(db, filters, query, type, includeInjected, useFts, candidateLimit),
      );
    }
    if (source === "tools" || source === "all") {
      candidates.push(
        ...toolCandidates(db, filters, query, includeInjected, useFts, candidateLimit),
      );
    }

    const rows = orderedRows(candidates, query, regex, context)
      .toSorted((a, b) => {
        const aTime = a.timestamp ?? "";
        const bTime = b.timestamp ?? "";
        return aTime.localeCompare(bTime) || a.uuid.localeCompare(b.uuid);
      })
      .slice(0, filters.limit);
    const document = buildDocument("search", rows);
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

/**
 * Search the indexed message and tool-call corpus.
 */
export const command: Command = {
  name: "search",
  description: "Full-text search over messages and tool calls, with context.",
  options,
  usage: "search <query> [options]",
  run,
};

if (import.meta.main) {
  command.run(process.argv.slice(2)).catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
