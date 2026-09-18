#!/usr/bin/env bun

/**
 * `tools`: tool calls paired with their results.
 *
 * Usage:
 *   bun $SKILL_DIR/scripts/cli.ts tools [options]
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
  { name: "name", type: "string", multiple: true, description: "Filter by tool name (repeatable)" },
  { name: "input", type: "string", description: "Filter by regex over the tool input" },
  {
    name: "errors-only",
    type: "boolean",
    description: "Only include calls whose result was an error",
  },
  { name: "agent-type", type: "string", description: "Filter Agent calls by subagent type" },
  { name: "skill", type: "string", description: "Filter Skill calls by skill name" },
  ...OUTPUT_OPTIONS,
];

async function run(_argv: string[]): Promise<void> {
  throw new Error("not implemented");
}

export const command: Command = {
  name: "tools",
  description: "List tool calls paired with their results.",
  options,
  run,
};

if (import.meta.main) {
  command.run(process.argv.slice(2)).catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
