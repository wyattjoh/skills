#!/usr/bin/env bun

/**
 * `errors`: is_error tool results with the preceding call and the next
 * assistant text.
 *
 * Usage:
 *   bun $SKILL_DIR/scripts/cli.ts errors [options]
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
  { name: "name", type: "string", description: "Filter by tool name" },
  { name: "pattern", type: "string", description: "Filter by regex over the error result text" },
  ...OUTPUT_OPTIONS,
];

async function run(_argv: string[]): Promise<void> {
  throw new Error("not implemented");
}

export const command: Command = {
  name: "errors",
  description: "List is_error tool results with the preceding call and the next assistant text.",
  options,
  run,
};

if (import.meta.main) {
  command.run(process.argv.slice(2)).catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
