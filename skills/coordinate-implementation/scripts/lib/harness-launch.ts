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
    prompt: {
      command: "herdr",
      args: ["agent", "prompt", input.session, input.prompt, "--wait", "--timeout", "300000"],
    },
  };
};
