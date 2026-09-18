#!/usr/bin/env bun

/**
 * `messages`: ordered turns of one or more sessions.
 *
 * Usage:
 *   bun $SKILL_DIR/scripts/cli.ts messages [options]
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
  { name: "include-tools", type: "boolean", description: "Include tool_use and tool_result turns" },
  { name: "include-thinking", type: "boolean", description: "Include thinking blocks" },
  { name: "around", type: "string", description: "Context window around a message: <uuid>:<n>" },
  ...OUTPUT_OPTIONS,
];

async function run(_argv: string[]): Promise<void> {
  throw new Error("not implemented");
}

export const command: Command = {
  name: "messages",
  description: "List the ordered turns of one or more sessions.",
  options,
  run,
};

if (import.meta.main) {
  command.run(process.argv.slice(2)).catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
