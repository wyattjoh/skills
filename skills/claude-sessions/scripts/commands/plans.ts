#!/usr/bin/env bun

/**
 * `plans`: search markdown files under ~/.claude/plans/.
 *
 * Usage:
 *   bun $SKILL_DIR/scripts/cli.ts plans --pattern=<text> [options]
 */

import { Effect } from "effect";
import { runEffectPromise, tryIO, tryPromiseIO } from "../lib/io.ts";
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
export type { Command } from "./index.ts";

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
export function getFileCreatedTime(filepath: string): Promise<string | null> {
  return runEffectPromise(getFileCreatedTimeEffect(filepath));
}

/**
 * Inspect a plan timestamp lazily, tolerating files that disappear.
 * @param filepath - Plan file path.
 * @returns Creation time, falling back to modification time, or null.
 */
export const getFileCreatedTimeEffect = Effect.fn("plans.createdTime")(function* (
  filepath: string,
) {
  return yield* tryPromiseIO(`stat ${filepath}`, () => stat(filepath)).pipe(
    Effect.flatMap((file) =>
      tryIO("format plan timestamp", () =>
        (file.birthtimeMs > 0 ? file.birthtime : file.mtime).toISOString(),
      ),
    ),
    Effect.catch(() => Effect.succeed(null)),
  );
});

/**
 * Preserve the public Promise interface for searching markdown plans.
 * @param searchOptions - Pattern, root, result limit and context.
 * @param dependencies - Optional timestamp inspection implementation.
 * @returns Matching rows in relevance order.
 */
export function searchPlans(
  searchOptions: PlanSearchOptions,
  dependencies: PlanSearchDependencies = {},
): Promise<PlanMatch[]> {
  return runEffectPromise(searchPlansEffect(searchOptions, dependencies));
}

/**
 * Compose per-file reads and timestamp inspection with partial-failure tolerance.
 * @param searchOptions - Pattern, root, result limit and context.
 * @param dependencies - Optional foreign timestamp implementation.
 * @returns Matching readable plans in relevance order.
 */
export const searchPlansEffect = Effect.fn("plans.search")(function* (
  searchOptions: PlanSearchOptions,
  dependencies: PlanSearchDependencies = {},
) {
  if (searchOptions.pattern.length === 0)
    return yield* Effect.fail(new Error("plans requires --pattern=<text>"));
  const entries = yield* tryPromiseIO("list plans", () =>
    readdir(searchOptions.root, { withFileTypes: true }),
  ).pipe(
    Effect.catch((error) => {
      const cause = error.cause as NodeJS.ErrnoException;
      return cause.code === "ENOENT" ? Effect.succeed([]) : Effect.fail(error);
    }),
  );
  const matches: PlanMatch[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filepath = join(searchOptions.root, entry.name);
    const content = yield* tryPromiseIO(`read ${filepath}`, () => Bun.file(filepath).text()).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (content === undefined) continue;
    const extracted = yield* tryIO("match plan content", () =>
      extractSnippet(content, searchOptions.pattern, searchOptions.context),
    ).pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (extracted === undefined || extracted.matchCount === 0) continue;
    const getTime = dependencies.getFileCreatedTime;
    const timestamp = yield* getTime === undefined
      ? getFileCreatedTimeEffect(filepath)
      : tryPromiseIO("inspect injected timestamp", () => getTime(filepath)).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
    if (timestamp === null) continue;
    matches.push({
      filename: entry.name,
      filepath,
      timestamp,
      snippet: extracted.snippet,
      match_count: extracted.matchCount,
    });
  }
  return matches
    .toSorted((left, right) => {
      const countOrder = right.match_count - left.match_count;
      return countOrder === 0 ? left.filename.localeCompare(right.filename) : countOrder;
    })
    .slice(0, searchOptions.limit);
});

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

const runEffect = Effect.fn("plans.run")(function* (argv: string[]) {
  const parsed = yield* Effect.try({ try: () => parsePlansArgs(argv), catch: (cause) => cause });
  const rows = yield* searchPlansEffect(parsed.search);
  yield* tryIO("execute plans command", () =>
    console.log(renderOutput(buildDocument("plans", rows), parsed.output)),
  );
});

function run(argv: string[]): Promise<void> {
  return runEffectPromise(runEffect(argv));
}

export const command: Command = {
  name: "plans",
  description: "Search markdown plans under ~/.claude/plans/.",
  options,
  usage: "plans --pattern=<text> [options]",
  run,
  runEffect,
};

if (import.meta.main) {
  runEffectPromise(command.runEffect(process.argv.slice(2))).catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
