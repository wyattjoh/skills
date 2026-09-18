#!/usr/bin/env bun

/**
 * `plans`: search matches in ~/.claude/plans/ (port of the old
 * search-plans.ts script).
 *
 * Usage:
 *   bun $SKILL_DIR/scripts/cli.ts plans <query> [options]
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
  { name: "limit", type: "string", description: "Maximum matches to return (default 10)" },
  {
    name: "context",
    type: "string",
    description: "Characters of context around each match (default 150)",
  },
  ...OUTPUT_OPTIONS,
];

async function run(_argv: string[]): Promise<void> {
  throw new Error("not implemented");
}

export const command: Command = {
  name: "plans",
  description: "Search matches in ~/.claude/plans/.",
  options,
  usage: "plans <query> [options]",
  run,
};

if (import.meta.main) {
  command.run(process.argv.slice(2)).catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
