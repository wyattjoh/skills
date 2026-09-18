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

export interface Command {
  name: string;
  description: string;
  options: CommandOption[];
  /** Overrides the generated "<name> [options]" usage line, e.g. to show a positional: "search <query> [options]". */
  usage?: string;
  run: (argv: string[]) => Promise<void>;
}

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

export function findCommand(name: string): Command | undefined {
  return commands.find((command) => command.name === name);
}
