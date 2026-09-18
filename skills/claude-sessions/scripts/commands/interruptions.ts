#!/usr/bin/env bun

/**
 * `interruptions`: interrupt markers, rejected tool calls, and user turns
 * that follow a tool_use mid-run. Each row carries the preceding assistant
 * text and the user's next text.
 *
 * Usage:
 *   bun $SKILL_DIR/scripts/cli.ts interruptions [options]
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

const options: CommandOption[] = [...SHARED_FILTER_OPTIONS, ...OUTPUT_OPTIONS];

async function run(_argv: string[]): Promise<void> {
  throw new Error("not implemented");
}

export const command: Command = {
  name: "interruptions",
  description:
    "List interrupt markers, rejected tool calls, and user turns that follow a tool_use mid-run.",
  options,
  run,
};

if (import.meta.main) {
  command.run(process.argv.slice(2)).catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
