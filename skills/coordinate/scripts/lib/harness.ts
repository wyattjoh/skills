/**
 * Delegate harnesses this fork supports.
 */
export type Harness = "pi" | "claude";

/**
 * Implement skills a spec delegate can be started with.
 */
export type ImplementSkill = "implement" | "implement-spec";

/**
 * The first-message prefix that invokes a user-invoked skill: `/name` in Claude Code,
 * `/skill:name` in pi.
 * @param harness Harness.
 * @param skill Skill name.
 * @returns The prefix.
 */
export const skillPrefix = (harness: Harness, skill: string): string =>
  harness === "pi" ? `/skill:${skill}` : `/${skill}`;

/**
 * What a new delegate is told first: read its brief, or run an implement skill with arguments. A
 * skill start may carry a brief too, for the boundary, stop points and report the skill does not know.
 */
export type DelegateFirstMessage =
  | { kind: "brief"; path: string }
  | { kind: "skill"; skill: ImplementSkill; args: string; brief?: string };

/**
 * What a new agent is told first: a delegate's message, or `coordinate` (args: the domain), which
 * starts a coordinator; only spawn uses it, never delegate.
 */
export type FirstMessage =
  | DelegateFirstMessage
  | { kind: "skill"; skill: "coordinate"; args: string; brief?: string };

/**
 * Render the first message.
 * @param harness Harness.
 * @param message Brief or skill.
 * @returns Text sent as the agent's initial prompt.
 */
export const firstMessage = (harness: Harness, message: FirstMessage): string => {
  if (message.kind === "brief") return `Read ${message.path} and do what it says.`;
  const brief = message.brief
    ? `Also read ${message.brief} and follow its Boundary, Stop points and Report sections.`
    : "";
  return [skillPrefix(harness, message.skill), message.args.trim(), brief]
    .filter((part) => part !== "")
    .join(" ");
};

/**
 * How to start or resume one delegate.
 */
export type LaunchSpec = {
  harness: Harness;
  name: string;
  session: string;
  model: string | undefined;
  /**
   * pi `--thinking` level or Claude `--effort`.
   */
  effort: string | undefined;
  extraArgs: readonly string[];
  /**
   * Initial prompt; undefined when resuming.
   */
  message: string | undefined;
  resume: boolean;
};

/**
 * Claude Code effort levels.
 */
export const CLAUDE_EFFORTS: ReadonlySet<string> = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/**
 * pi thinking levels.
 */
export const PI_THINKING: ReadonlySet<string> = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/**
 * The agent's argv. pi's `--session-id` both creates and reopens a session in the folder;
 * Claude takes `--session-id` to start and `--resume` to reopen.
 * @param spec Launch spec.
 * @returns argv.
 */
export const agentArgv = (spec: LaunchSpec): string[] => {
  const model = spec.model ? ["--model", spec.model] : [];
  const message = spec.message === undefined ? [] : [spec.message];
  if (spec.harness === "pi")
    return [
      "pi",
      "--session-id",
      spec.session,
      "--name",
      spec.name,
      ...model,
      ...(spec.effort ? ["--thinking", spec.effort] : []),
      ...spec.extraArgs,
      ...message,
    ];
  return [
    "claude",
    ...(spec.resume ? ["--resume", spec.session] : ["--session-id", spec.session]),
    "--name",
    spec.name,
    ...model,
    ...(spec.effort ? ["--effort", spec.effort] : []),
    ...spec.extraArgs,
    ...message,
  ];
};

/**
 * Wrap argv in the user's login shell, so the agent gets the PATH their own terminals have.
 * The shell becomes the agent (`exec`), so the terminal ends when the agent exits.
 * @param shell Login shell path.
 * @param argv Agent argv.
 * @returns Wrapped argv.
 */
export const inLoginShell = (shell: string, argv: readonly string[]): string[] => {
  const posix = /\/(zsh|bash|sh|ksh|dash)$/.test(shell) ? shell : "/bin/sh";
  return [posix, "-lic", 'exec "$@"', posix, ...argv];
};

/**
 * The harness a terminal runs, from hc's app or program name.
 * @param app `status.app` or the listed agent program.
 * @returns The harness, or undefined for anything else.
 */
export const harnessOf = (app: string | undefined): Harness | undefined =>
  app === "pi" ? "pi" : app === "claude-code" || app === "claude" ? "claude" : undefined;
