#!/usr/bin/env bun

/**
 * `sessions`: list session metadata and counts.
 *
 * Usage:
 *   bun $SKILL_DIR/scripts/cli.ts sessions [options]
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
  {
    name: "sort",
    type: "string",
    description: "Sort by date, messages, tokens, or errors (default: date)",
  },
  {
    name: "first-prompt",
    type: "string",
    description: "Filter by substring of the session's first prompt",
  },
  ...OUTPUT_OPTIONS,
];

async function run(_argv: string[]): Promise<void> {
  throw new Error("not implemented");
}

export const command: Command = {
  name: "sessions",
  description: "List session metadata and counts.",
  options,
  run,
};

if (import.meta.main) {
  command.run(process.argv.slice(2)).catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
