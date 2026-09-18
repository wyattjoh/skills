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

import { parseArgs } from "node:util";
import { openDb } from "../lib/db.ts";
import { sync, type SyncSummary } from "../lib/ingest.ts";

export interface CommandOption {
  name: string;
  type: "string" | "boolean";
  multiple?: boolean;
  description: string;
}

export interface Command {
  name: string;
  description: string;
  options: CommandOption[];
  run: (argv: string[]) => Promise<void>;
}

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
  { name: "table", type: "boolean", description: "Print a human-readable table instead of JSON" },
];

function parseSyncArgs(argv: string[]): {
  root?: string;
  projects?: string[];
  vacuum: boolean;
  quiet: boolean;
  table: boolean;
} {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      projects: { type: "string", multiple: true },
      vacuum: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      table: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  return {
    root: values.root,
    projects: values.projects,
    vacuum: values.vacuum ?? false,
    quiet: values.quiet ?? false,
    table: values.table ?? false,
  };
}

function printTable(summary: SyncSummary): void {
  const rows: Array<[string, string]> = [
    ["Scanned", String(summary.scanned)],
    ["Added", String(summary.added)],
    ["Updated", String(summary.updated)],
    ["Unchanged", String(summary.unchanged)],
    ["Removed", String(summary.removed)],
    ["Malformed lines", String(summary.malformedLines)],
    ["Elapsed", `${(summary.elapsedMs / 1000).toFixed(2)}s`],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  console.log("Sync summary");
  for (const [label, value] of rows) {
    console.log(`  ${label.padEnd(width)}  ${value}`);
  }
}

async function run(argv: string[]): Promise<void> {
  const opts = parseSyncArgs(argv);
  const db = openDb();

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

  if (opts.vacuum) {
    db.exec("VACUUM");
  }

  db.close();

  if (opts.table) {
    printTable(summary);
  } else {
    console.log(JSON.stringify(summary));
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
