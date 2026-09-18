#!/usr/bin/env bun

/**
 * `search`: full-text search over messages and/or tool calls, with context.
 *
 * Usage:
 *   bun $SKILL_DIR/scripts/cli.ts search <query> [options]
 *
 * Stub: not yet implemented. See .scratch/conversation-historian-plan.md.
 */

import { SHARED_FILTER_OPTIONS } from "../lib/filters.ts";
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
  ...SHARED_FILTER_OPTIONS,
  { name: "regex", type: "boolean", description: "Run a regex pass over the FTS candidates" },
  { name: "in", type: "string", description: "Search messages, tools, or all (default: all)" },
  { name: "type", type: "string", description: "Filter message hits by user or assistant" },
  {
    name: "include-injected",
    type: "boolean",
    description: "Include injected text (skill bodies, slash-command expansions, system reminders)",
  },
  ...OUTPUT_OPTIONS,
];

async function run(_argv: string[]): Promise<void> {
  throw new Error("not implemented");
}

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
