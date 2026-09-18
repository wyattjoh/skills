#!/usr/bin/env bun

/**
 * `sql`: run a read-only statement against the index database directly.
 * `--schema` prints the CREATE statements stored in sqlite_master.
 *
 * Usage:
 *   bun $SKILL_DIR/scripts/cli.ts sql <statement> [options]
 *   bun $SKILL_DIR/scripts/cli.ts sql --schema
 */

import { Database } from "bun:sqlite";
import { booleanFlagNames, flagBoolean, flagString, parseArgv } from "../lib/args.ts";
import { resolveDbPath } from "../lib/db.ts";
import {
  buildDocument,
  OUTPUT_OPTIONS,
  renderOptionsFromFlags,
  renderOutput,
  type RenderOptions,
} from "../lib/output.ts";
import type { Command, CommandOption } from "./index.ts";
export type { Command, CommandOption } from "./index.ts";

const options: CommandOption[] = [
  {
    name: "schema",
    type: "boolean",
    description: "Print the index database schema instead of running a statement",
  },
  {
    name: "limit",
    type: "string",
    description:
      "Maximum rows to return; applied only when the statement has no LIMIT (default 200)",
  },
  ...OUTPUT_OPTIONS,
];

interface SqlToken {
  kind: "word" | "punctuation" | "value";
  value: string;
  depth: number;
  start: number;
  end: number;
}

interface SchemaRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string;
}

const DML_KEYWORDS = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "REPLACE"]);

function skipQuoted(sql: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] !== quote) {
      index += 1;
      continue;
    }
    if (sql[index + 1] === quote) {
      index += 2;
      continue;
    }
    return index + 1;
  }
  throw new Error("unterminated quoted value");
}

function skipBracketIdentifier(sql: string, start: number): number {
  const end = sql.indexOf("]", start + 1);
  if (end === -1) throw new Error("unterminated quoted identifier");
  return end + 1;
}

function tokenize(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let index = 0;
  let depth = 0;

  while (index < sql.length) {
    const character = sql[index]!;
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }

    if (character === "-" && sql[index + 1] === "-") {
      const newline = sql.indexOf("\n", index + 2);
      index = newline === -1 ? sql.length : newline + 1;
      continue;
    }

    if (character === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end === -1) throw new Error("unterminated SQL comment");
      index = end + 2;
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      const start = index;
      index = skipQuoted(sql, index, character);
      tokens.push({ kind: "value", value: "", depth, start, end: index });
      continue;
    }

    if (character === "[") {
      const start = index;
      index = skipBracketIdentifier(sql, index);
      tokens.push({ kind: "value", value: "", depth, start, end: index });
      continue;
    }

    if (character === "(") {
      tokens.push({
        kind: "punctuation",
        value: character,
        depth,
        start: index,
        end: index + 1,
      });
      depth += 1;
      index += 1;
      continue;
    }

    if (character === ")") {
      depth -= 1;
      if (depth < 0) throw new Error("unbalanced parentheses");
      tokens.push({
        kind: "punctuation",
        value: character,
        depth,
        start: index,
        end: index + 1,
      });
      index += 1;
      continue;
    }

    if (character === ";") {
      tokens.push({
        kind: "punctuation",
        value: character,
        depth,
        start: index,
        end: index + 1,
      });
      index += 1;
      continue;
    }

    if (/[A-Za-z_]/.test(character)) {
      const start = index;
      index += 1;
      while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index]!)) index += 1;
      tokens.push({
        kind: "word",
        value: sql.slice(start, index).toUpperCase(),
        depth,
        start,
        end: index,
      });
      continue;
    }

    tokens.push({ kind: "value", value: character, depth, start: index, end: index + 1 });
    index += 1;
  }

  if (depth !== 0) throw new Error("unbalanced parentheses");
  return tokens;
}

function isSingleSelect(sql: string): boolean {
  let tokens: SqlToken[];
  try {
    tokens = tokenize(sql);
  } catch {
    return false;
  }

  if (tokens.length === 0) return false;
  const semicolonIndexes = tokens
    .map((token, index) => (token.value === ";" ? index : -1))
    .filter((index) => index >= 0);
  if (
    semicolonIndexes.length > 1 ||
    (semicolonIndexes.length === 1 && semicolonIndexes[0] !== tokens.length - 1)
  ) {
    return false;
  }

  const firstToken = tokens[0];
  if (firstToken?.kind !== "word") return false;
  if (firstToken.value === "SELECT") return true;
  if (firstToken.value !== "WITH") return false;

  // SELECT inside a CTE has positive parenthesis depth. The first DML word
  // at depth zero is the statement that follows the CTE declarations.
  const mainStatement = tokens.find(
    (token, index) =>
      index > 0 && token.kind === "word" && token.depth === 0 && DML_KEYWORDS.has(token.value),
  );
  return mainStatement?.value === "SELECT";
}

function hasTopLevelLimit(sql: string): boolean {
  let tokens: SqlToken[];
  try {
    tokens = tokenize(sql);
  } catch {
    return false;
  }
  return tokens.some(
    (token) => token.kind === "word" && token.depth === 0 && token.value === "LIMIT",
  );
}

function withDefaultLimit(sql: string, limit: number): string {
  if (hasTopLevelLimit(sql)) return sql;

  const tokens = tokenize(sql);
  const finalToken = tokens.at(-1);
  if (finalToken === undefined) return sql;
  const insertionPoint = finalToken.value === ";" ? finalToken.start : finalToken.end;
  const prefix = sql.slice(0, insertionPoint).trimEnd();
  const suffix = sql.slice(insertionPoint);
  return `${prefix} LIMIT ${limit}${suffix}`;
}

function parseLimit(flags: Record<string, string | boolean | string[]>): number {
  const raw = flagString(flags, "limit");
  if (flags.limit !== undefined && raw === undefined) throw new Error("--limit requires a value");
  if (raw === undefined) return 200;
  if (!/^(0|[1-9]\d*)$/.test(raw)) throw new Error(`Invalid --limit: ${raw}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid --limit: ${raw}`);
  return value;
}

function schemaRows(db: Database): SchemaRow[] {
  return db
    .query(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_master
       WHERE sql IS NOT NULL
       ORDER BY type, name`,
    )
    .all() as SchemaRow[];
}

function parseSqlArgs(argv: string[]): {
  statement: string;
  schema: boolean;
  limit: number;
  output: RenderOptions;
} {
  const { flags, positionals } = parseArgv(argv, booleanFlagNames(options));
  const schema = flagBoolean(flags, "schema");
  const statement = positionals.join(" ").trim();
  if (schema && statement.length > 0) {
    throw new Error("--schema cannot be combined with a SQL statement");
  }
  if (!schema && statement.length === 0) {
    throw new Error("sql requires a SELECT statement or --schema");
  }

  return {
    statement,
    schema,
    limit: parseLimit(flags),
    output: renderOptionsFromFlags(flags),
  };
}

async function run(argv: string[]): Promise<void> {
  const parsed = parseSqlArgs(argv);
  if (!parsed.schema && !isSingleSelect(parsed.statement)) {
    throw new Error("SQL must be a single SELECT statement");
  }

  const db = new Database(resolveDbPath(), { readonly: true });
  try {
    const rows = parsed.schema
      ? schemaRows(db)
      : db.query(withDefaultLimit(parsed.statement, parsed.limit)).all();
    console.log(renderOutput(buildDocument("sql", rows), parsed.output));
  } finally {
    db.close();
  }
}

export const command: Command = {
  name: "sql",
  description: "Run a read-only SQL statement against the index database, or print the schema.",
  options,
  usage: "sql <statement> [options]  |  sql --schema",
  run,
};

if (import.meta.main) {
  command.run(process.argv.slice(2)).catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
