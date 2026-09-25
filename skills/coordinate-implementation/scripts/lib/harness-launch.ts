import type { RoleRecord } from "./contract.ts";

/**
 * Shell-free command representation executed by the coordinator.
 */
export type ArgumentCommand = {
  command: string;
  args: string[];
};

/**
 * Portable Herdr start and prompt commands for one role session.
 */
export type HarnessLaunchPlan = {
  start: ArgumentCommand;
  prompt: ArgumentCommand;
};

/**
 * Complete values required to build one harness launch without shell interpolation.
 */
export type HarnessLaunchInput = {
  role: RoleRecord;
  session: string;
  pane: string;
  prompt: string;
  skillPath: string | undefined;
};

/**
 * Constructs exact Herdr and harness argument arrays for a role session.
 *
 * @param input - Persisted role binding, Herdr identity, prompt, and optional Pi skill path.
 * @returns Start and prompt commands whose arguments can be executed directly.
 */
export const buildHarnessLaunch = (input: HarnessLaunchInput): HarnessLaunchPlan => {
  const harnessArgs =
    input.role.harness === "pi"
      ? [
          "--approve",
          "--model",
          input.role.model,
          "--thinking",
          input.role.effort,
          ...(input.skillPath === undefined ? [] : ["--skill", input.skillPath]),
        ]
      : ["--model", input.role.model, "--effort", input.role.effort, "--permission-mode", "auto"];
  return {
    start: {
      command: "herdr",
      args: [
        "agent",
        "start",
        input.session,
        "--kind",
        input.role.harness,
        "--pane",
        input.pane,
        "--timeout",
        "300000",
        "--",
        ...harnessArgs,
      ],
    },
    prompt: herdrPromptCommand(input.session, input.prompt),
  };
};

/**
 * Builds the Herdr command that delivers one prompt to a session and waits for it.
 *
 * @param session - Herdr agent session name.
 * @param prompt - Exact prompt text.
 * @returns The shell-free `herdr agent prompt` command.
 */
export const herdrPromptCommand = (session: string, prompt: string): ArgumentCommand => ({
  command: "herdr",
  args: ["agent", "prompt", session, prompt, "--wait", "--timeout", "300000"],
});

/**
 * Reads the session and prompt text back from a {@link herdrPromptCommand} command.
 *
 * @param command - A command built by {@link herdrPromptCommand}.
 * @returns The target session and prompt text.
 */
export const herdrPromptTarget = (
  command: ArgumentCommand,
): { session: string; prompt: string } => {
  const [verb, action, session, prompt] = command.args;
  if (
    command.command !== "herdr" ||
    verb !== "agent" ||
    action !== "prompt" ||
    session === undefined ||
    prompt === undefined
  ) {
    throw new Error(`Not a Herdr prompt command: ${JSON.stringify(command)}`);
  }
  return { session, prompt };
};
