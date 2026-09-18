#!/usr/bin/env bun

/**
 * claude-sessions CLI: subcommand router over commands/index.ts.
 *
 * Usage:
 *   bun $SKILL_DIR/scripts/cli.ts <command> [options]
 *   bun $SKILL_DIR/scripts/cli.ts --help
 *   bun $SKILL_DIR/scripts/cli.ts <command> --help
 *
 * Every command except `sync` runs an incremental index sync first (quiet;
 * prints one stderr line only when files changed, and a warning if the sync
 * itself fails rather than aborting the command). Pass --no-sync to skip
 * it. Each command renders its own JSON (default) or --table output through
 * lib/output.ts. Diagnostics go to stderr. Exit is 0 unless the command
 * itself fails.
 */

import { type Command, type CommandOption, commands, findCommand } from "./commands/index.ts";
import { openDb } from "./lib/db.ts";
import { sync } from "./lib/ingest.ts";

function optionLabel(option: CommandOption): string {
  const name = option.negated === true ? `no-${option.name}` : option.name;
  const value = option.type === "boolean" ? "" : "=<value>";
  const repeatable = option.multiple === true ? " (repeatable)" : "";
  return `--${name}${value}${repeatable}`;
}

function printRootHelp(): void {
  const width = Math.max(...commands.map((command) => command.name.length));
  const lines = [
    "claude-sessions: query the indexed Claude Code conversation history.",
    "",
    "Usage: bun scripts/cli.ts <command> [options]",
    "",
    "Commands:",
    ...commands.map((command) => `  ${command.name.padEnd(width)}  ${command.description}`),
    "",
    "Run 'bun scripts/cli.ts <command> --help' for command-specific options.",
  ];
  appendGlobalHelp(lines);
  appendJudgeHelp(lines);
  console.log(lines.join("\n"));
}

function printCommandHelp(command: Command): void {
  const usage = command.usage ?? `${command.name} [options]`;
  const lines = [
    `${command.name}: ${command.description}`,
    "",
    `Usage: bun scripts/cli.ts ${usage}`,
  ];
  if (command.options.length > 0) {
    const width = Math.max(...command.options.map((option) => optionLabel(option).length));
    lines.push("", "Options:");
    lines.push(
      ...command.options.map(
        (option) => `  ${optionLabel(option).padEnd(width)}  ${option.description}`,
      ),
    );
  }
  if (command.name !== "sync") appendGlobalHelp(lines);
  console.log(lines.join("\n"));
}

const NO_SYNC_DESCRIPTION = "Skip the automatic index sync before running a read command";

function appendGlobalHelp(lines: string[]): void {
  lines.push("", "Global options:", `  --no-sync   ${NO_SYNC_DESCRIPTION}`);
}

const JUDGE_HELP = [
  "Judge options:",
  "  --judge=<preset>          Annotate supported rows with a TypeSafe preset",
  "  --judge-file=<json>      Load ad hoc questions and state fields from JSON",
  "  --query=<text>           Query text required by the relevance preset",
  "  --min-confidence=<value> Mark low-confidence answers as uncertain",
  "  --no-cache               Bypass the judgment cache",
  "  --max-judge-rows=<value> Cap TypeSafe requests (default: 500)",
];

function appendJudgeHelp(lines: string[]): void {
  lines.push("", ...JUDGE_HELP);
}

const SLOW_SYNC_NOTICE_MS = 5_000;

/**
 * Run an incremental sync quietly. Prints a one-line stderr note only when
 * files changed. If the sync is still running after a few seconds, prints
 * one "still syncing" note so the command does not look hung; a full
 * directory walk over a large corpus can take minutes (known cost, tracked
 * against lib/ingest.ts). A sync failure (e.g. the corpus root is
 * unreadable) is reported on stderr but does not abort the command: the
 * index may already hold useful data from a previous sync.
 */
async function autoSync(): Promise<void> {
  const db = openDb();
  const slowNotice = setTimeout(() => {
    console.error("sync: still syncing the conversation index, this can take a while...");
  }, SLOW_SYNC_NOTICE_MS);
  try {
    const summary = await sync({ db });
    const changed = summary.added + summary.updated + summary.removed;
    if (changed > 0) {
      console.error(
        `sync: ${summary.added} added, ${summary.updated} updated, ${summary.removed} removed`,
      );
    }
  } catch (err) {
    console.error(`sync: skipped (${err instanceof Error ? err.message : String(err)})`);
  } finally {
    clearTimeout(slowNotice);
    db.close();
  }
}

/**
 * True when `--help`/`-h` appears as a flag, not as a literal positional.
 * Only tokens before a bare `--` separator count: `search -- --help` and
 * `search "--help"` (its own token, but after `--`) mean "search for the
 * literal string --help", not "show help".
 */
function hasHelpFlag(argv: string[]): boolean {
  const separator = argv.indexOf("--");
  const flagTokens = separator === -1 ? argv : argv.slice(0, separator);
  return flagTokens.includes("--help") || flagTokens.includes("-h");
}

/**
 * Extract router flags without interpreting tokens after a bare `--`.
 *
 * @param argv Arguments after the command name.
 * @returns The router's sync decision and arguments for the command.
 */
export function routeGlobalFlags(argv: string[]): {
  noSync: boolean;
  forwardedArgv: string[];
} {
  const separator = argv.indexOf("--");
  const flagEnd = separator === -1 ? argv.length : separator;
  const noSync = argv.slice(0, flagEnd).includes("--no-sync");
  const forwardedArgv = argv.filter((token, index) => index >= flagEnd || token !== "--no-sync");
  return { noSync, forwardedArgv };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [name, ...rest] = argv;

  if (name === undefined || name === "--help" || name === "-h") {
    printRootHelp();
    return;
  }

  const command = findCommand(name);
  if (command === undefined) {
    console.error(`Unknown command: ${name}`);
    console.error(`Run "bun scripts/cli.ts --help" to list commands.`);
    process.exitCode = 1;
    return;
  }

  if (hasHelpFlag(rest)) {
    printCommandHelp(command);
    return;
  }

  const { noSync, forwardedArgv } = routeGlobalFlags(rest);

  // `sync` performs the sync itself, so it must not pay for a second
  // multi-minute incremental sync over the full conversation corpus.
  const skipsAutoSync = command.name === "sync";

  if (!skipsAutoSync && !noSync) {
    await autoSync();
  }

  await command.run(forwardedArgv);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
