#!/usr/bin/env bun

/**
 * `sync`: incrementally index the conversation corpus into
 * ~/.cache/claude-sessions/index.db.
 *
 * Usage:
 *   bun $SKILL_DIR/scripts/commands/sync.ts [options]
 *
 * Options:
 *   --root=PATH            Corpus root (default: ~/.claude/projects)
 *   --projects=SUBSTRING   Only sync project dirs containing SUBSTRING (repeatable)
 *   --vacuum                Run VACUUM after syncing
 *   --quiet                 Suppress progress lines on stderr
 *   --table                 Print a human-readable table instead of JSON
 */

import { booleanFlagNames, flagBoolean, flagString, flagStrings, parseArgv } from "../lib/args.ts";
import { openDb } from "../lib/db.ts";
import { sync, type SyncSummary } from "../lib/ingest.ts";
import {
  buildDocument,
  OUTPUT_OPTIONS,
  renderOptionsFromFlags,
  renderOutput,
} from "../lib/output.ts";
import type { Command, CommandOption } from "./index.ts";

const options: CommandOption[] = [
  { name: "root", type: "string", description: "Corpus root (default: ~/.claude/projects)" },
  {
    name: "projects",
    type: "string",
    multiple: true,
    description: "Only sync project dirs containing this substring (repeatable)",
  },
  {
    name: "vacuum",
    type: "boolean",
    description: "Run VACUUM on the index database after syncing",
  },
  { name: "quiet", type: "boolean", description: "Suppress progress lines on stderr" },
  ...OUTPUT_OPTIONS,
];

function parseSyncArgs(argv: string[]): {
  root: string | undefined;
  projects: string[];
  vacuum: boolean;
  quiet: boolean;
  output: ReturnType<typeof renderOptionsFromFlags>;
} {
  const { flags, positionals } = parseArgv(argv, booleanFlagNames(options));
  if (positionals.length > 0) throw new Error("sync does not accept positional arguments");

  return {
    root: flagString(flags, "root"),
    projects: flagStrings(flags, "projects"),
    vacuum: flagBoolean(flags, "vacuum"),
    quiet: flagBoolean(flags, "quiet"),
    output: renderOptionsFromFlags(flags),
  };
}

function toOutputRow(summary: SyncSummary): Record<string, number> {
  return {
    scanned: summary.scanned,
    added: summary.added,
    updated: summary.updated,
    removed: summary.removed,
    unchanged: summary.unchanged,
    malformed_lines: summary.malformedLines,
    elapsed_ms: summary.elapsedMs,
  };
}

async function run(argv: string[]): Promise<void> {
  const opts = parseSyncArgs(argv);
  const db = openDb();

  try {
    const summary = await sync({
      root: opts.root,
      db,
      projects: opts.projects,
      progressEvery: 100,
      onProgress: opts.quiet
        ? undefined
        : (info) => {
            console.error(`sync: ${info.filesProcessed}/${info.totalFiles} files`);
          },
    });

    if (opts.vacuum) db.exec("VACUUM");

    const document = buildDocument("sync", [toOutputRow(summary)]);
    console.log(renderOutput(document, opts.output));
  } finally {
    db.close();
  }
}

export const command: Command = {
  name: "sync",
  description: "Incrementally index the conversation corpus into the sqlite index database.",
  options,
  run,
};

if (import.meta.main) {
  command.run(process.argv.slice(2)).catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
