/**
 * Static command registry. cli.ts routes a subcommand name to one of these
 * without any dynamic discovery, so adding a command means adding its
 * import and its entry in `commands` here.
 */

import { command as errors } from "./errors.ts";
import { command as interruptions } from "./interruptions.ts";
import { command as messages } from "./messages.ts";
import { command as plans } from "./plans.ts";
import { command as projects } from "./projects.ts";
import { command as search } from "./search.ts";
import { command as sessions } from "./sessions.ts";
import { command as sql } from "./sql.ts";
import { command as stats } from "./stats.ts";
import { command as sync } from "./sync.ts";
import { command as tools } from "./tools.ts";
import type { JudgePresetName } from "../lib/judge/types.ts";

/**
 * Metadata describing one command-line option.
 */
export interface CommandOption {
  name: string;
  type: "string" | "boolean";
  multiple?: boolean;
  description: string;
  /**
   * True when this boolean option defaults on and is meant to be invoked in
   * its negated form, e.g. `--no-redact`. Help text prints `--no-<name>`
   * instead of `--<name>` for these.
   */
  negated?: boolean;
}

/**
 * A registered CLI command and its execution metadata.
 */
export interface Command {
  name: string;
  description: string;
  options: CommandOption[];
  /**
   * Overrides the generated "<name> [options]" usage line, for example to
   * show a positional: "search <query> [options]".
   */
  usage?: string;
  run: (argv: string[]) => Promise<void>;
}

/**
 * A command that accepts built-in TypeSafe judge presets.
 */
export interface JudgeCommand extends Command {
  judgePresets: readonly JudgePresetName[];
}

/**
 * All commands exposed by the CLI, in root-help order.
 */
export const commands: Command[] = [
  sync,
  projects,
  sessions,
  search,
  messages,
  tools,
  errors,
  interruptions,
  stats,
  sql,
  plans,
];

/**
 * Find a registered command by its subcommand name.
 *
 * @param name Command name from argv.
 * @returns The matching command, or undefined when unknown.
 */
export function findCommand(name: string): Command | undefined {
  return commands.find((command) => command.name === name);
}
