#!/usr/bin/env bun

/**
 * `sql`: run a read-only statement against the index database directly.
 * `--schema` prints the schema instead of running a statement.
 *
 * Usage:
 *   bun $SKILL_DIR/scripts/cli.ts sql <statement> [options]
 *   bun $SKILL_DIR/scripts/cli.ts sql --schema
 *
 * Stub: not yet implemented. See .scratch/conversation-historian-plan.md.
 */

import { OUTPUT_OPTIONS } from "../lib/output.ts";

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
    name: "schema",
    type: "boolean",
    description: "Print the index database schema instead of running a statement",
  },
  {
    name: "limit",
    type: "string",
    description:
      "Maximum rows to return; applied only when the statement has no LIMIT (default 100)",
  },
  ...OUTPUT_OPTIONS,
];

async function run(_argv: string[]): Promise<void> {
  throw new Error("not implemented");
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
