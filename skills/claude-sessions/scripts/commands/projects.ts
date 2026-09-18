#!/usr/bin/env bun

/**
 * `projects`: list indexed project directories with cwd, last activity,
 * session count, and worktree parent when the cwd sits under
 * .claude/worktrees/.
 *
 * Usage:
 *   bun $SKILL_DIR/scripts/cli.ts projects [options]
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
    name: "search",
    type: "string",
    description: "Filter by substring of the encoded project dir or cwd",
  },
  ...OUTPUT_OPTIONS,
];

async function run(_argv: string[]): Promise<void> {
  throw new Error("not implemented");
}

export const command: Command = {
  name: "projects",
  description: "List indexed project directories with cwd, last activity, and session count.",
  options,
  run,
};

if (import.meta.main) {
  command.run(process.argv.slice(2)).catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
