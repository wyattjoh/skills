#!/usr/bin/env bun

/**
 * `plans`: search markdown files under ~/.claude/plans/.
 *
 * Usage:
 *   bun $SKILL_DIR/scripts/cli.ts plans --pattern=<text> [options]
 */

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { booleanFlagNames, flagString, parseArgv } from "../lib/args.ts";
import {
  buildDocument,
  OUTPUT_OPTIONS,
  renderOptionsFromFlags,
  renderOutput,
  type RenderOptions,
} from "../lib/output.ts";
import type { Command, CommandOption } from "./index.ts";
export type { Command, CommandOption } from "./index.ts";

/** A markdown plan that contains one or more case-insensitive matches. */
export interface PlanMatch {
  filename: string;
  filepath: string;
  timestamp: string;
  snippet: string;
  match_count: number;
}

/** Options for searching a plans directory. */
export interface PlanSearchOptions {
  pattern: string;
  root: string;
  limit: number;
  context: number;
}

export interface PlanSearchDependencies {
  getFileCreatedTime?: (filepath: string) => Promise<string | null>;
}

const options: CommandOption[] = [
  {
    name: "pattern",
    type: "string",
    description: "Case-insensitive pattern to search for (required)",
  },
  { name: "root", type: "string", description: "Plans directory (default: ~/.claude/plans)" },
  { name: "limit", type: "string", description: "Maximum matches to return (default 10)" },
  {
    name: "context",
    type: "string",
    description: "Characters of context around each match (default 150)",
  },
  ...OUTPUT_OPTIONS,
];

function countMatches(text: string, pattern: string): number {
  const lowerText = text.toLowerCase();
  const lowerPattern = pattern.toLowerCase();
  let count = 0;
  let offset = 0;
  while (true) {
    const index = lowerText.indexOf(lowerPattern, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + lowerPattern.length;
  }
}

/**
 * Extract a whitespace-normalized snippet and count all non-overlapping matches.
 *
 * @param text Plan text to inspect.
 * @param pattern Case-insensitive literal pattern.
 * @param contextLength Characters to include on either side of the first match.
 * @returns The first-match snippet and total match count.
 */
export function extractSnippet(
  text: string,
  pattern: string,
  contextLength: number,
): { snippet: string; matchCount: number } {
  if (pattern.length === 0) return { snippet: "", matchCount: 0 };
  const lowerText = text.toLowerCase();
  const index = lowerText.indexOf(pattern.toLowerCase());
  const matchCount = countMatches(text, pattern);
  if (index === -1) return { snippet: "", matchCount };

  const context = Math.max(0, contextLength);
  const start = Math.max(0, index - context);
  const end = Math.min(text.length, index + pattern.length + context);
  let snippet = text.slice(start, end);
  if (start > 0) snippet = `...${snippet}`;
  if (end < text.length) snippet = `${snippet}...`;
  return {
    snippet: snippet
      .replace(/\r\n|\r|\n/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    matchCount,
  };
}

/**
 * Return the file creation timestamp, falling back to the modification time.
 *
 * @param filepath Plan file path.
 * @returns An ISO timestamp, or null when the file cannot be read.
 */
export async function getFileCreatedTime(filepath: string): Promise<string | null> {
  try {
    const file = await stat(filepath);
    return (file.birthtimeMs > 0 ? file.birthtime : file.mtime).toISOString();
  } catch {
    return null;
  }
}

/**
 * Search markdown files in a plans directory and sort the most frequent matches first.
 *
 * @param searchOptions Search pattern, root, result limit, and snippet context.
 * @returns Matching plan rows in relevance order.
 */
export async function searchPlans(
  searchOptions: PlanSearchOptions,
  dependencies: PlanSearchDependencies = {},
): Promise<PlanMatch[]> {
  if (searchOptions.pattern.length === 0) throw new Error("plans requires --pattern=<text>");

  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(searchOptions.root, { withFileTypes: true });
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") return [];
    throw error;
  }

  const matches: PlanMatch[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filepath = join(searchOptions.root, entry.name);

    try {
      const content = await Bun.file(filepath).text();
      const extracted = extractSnippet(content, searchOptions.pattern, searchOptions.context);
      if (extracted.matchCount === 0) continue;
      const timestamp = await (dependencies.getFileCreatedTime ?? getFileCreatedTime)(filepath);
      if (timestamp === null) continue;
      matches.push({
        filename: entry.name,
        filepath,
        timestamp,
        snippet: extracted.snippet,
        match_count: extracted.matchCount,
      });
    } catch {
      // A plan can disappear or become unreadable while the directory is being searched.
    }
  }

  return matches
    .toSorted((left, right) => {
      const countOrder = right.match_count - left.match_count;
      return countOrder === 0 ? left.filename.localeCompare(right.filename) : countOrder;
    })
    .slice(0, searchOptions.limit);
}

function parseNonNegativeInteger(
  flags: Record<string, string | boolean | string[]>,
  key: string,
  fallback: number,
): number {
  const raw = flagString(flags, key);
  if (flags[key] !== undefined && raw === undefined) throw new Error(`--${key} requires a value`);
  if (raw === undefined) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(raw)) throw new Error(`Invalid --${key}: ${raw}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid --${key}: ${raw}`);
  return value;
}

function parsePlansArgs(argv: string[]): {
  search: PlanSearchOptions;
  output: RenderOptions;
} {
  const { flags, positionals } = parseArgv(argv, booleanFlagNames(options));
  if (positionals.length > 0) throw new Error("plans requires --pattern=<text>");
  const pattern = flagString(flags, "pattern");
  if (pattern === undefined || pattern.length === 0) {
    throw new Error("plans requires --pattern=<text>");
  }

  const root = flagString(flags, "root");
  if (flags.root !== undefined && root === undefined) throw new Error("--root requires a value");

  return {
    search: {
      pattern,
      root: root ?? join(homedir(), ".claude", "plans"),
      limit: parseNonNegativeInteger(flags, "limit", 10),
      context: parseNonNegativeInteger(flags, "context", 150),
    },
    output: renderOptionsFromFlags(flags),
  };
}

async function run(argv: string[]): Promise<void> {
  const parsed = parsePlansArgs(argv);
  const rows = await searchPlans(parsed.search);
  console.log(renderOutput(buildDocument("plans", rows), parsed.output));
}

export const command: Command = {
  name: "plans",
  description: "Search markdown plans under ~/.claude/plans/.",
  options,
  usage: "plans --pattern=<text> [options]",
  run,
};

if (import.meta.main) {
  command.run(process.argv.slice(2)).catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
