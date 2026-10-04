/**
 * Agent states herdr reports for a pane.
 */
export type FleetStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/**
 * States that mean an agent stopped and wants attention.
 */
export const SETTLED: readonly FleetStatus[] = ["idle", "done", "blocked"];

/**
 * One agent pane, projected from herdr's `agent list` / `agent wait` JSON.
 */
export type FleetAgent = {
  pane: string;
  name: string;
  harness: string;
  status: FleetStatus;
  cwd: string;
  workspace: string | undefined;
  seq: number;
};

/**
 * The `error` object herdr prints on stdout when a command fails.
 */
export type HerdrError = {
  code: string;
  message: string;
};

/**
 * What a runner reports for one finished child process.
 */
export type RunOutput = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/**
 * Runs an argv to completion. Each harness adapter supplies its own: the
 * Claude Code mod through `$.process.run`, the pi extension through Node.
 */
export type Runner = (
  argv: readonly string[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
) => Promise<RunOutput>;

/**
 * Raised when herdr answers with an error document or unreadable output.
 */
export class HerdrFailure extends Error {
  readonly code: string;

  /**
   * @param error the parsed herdr error
   */
  constructor(error: HerdrError) {
    super(`${error.code}: ${error.message}`);
    this.code = error.code;
  }
}

type RawAgent = {
  pane_id?: unknown;
  workspace_id?: unknown;
  name?: unknown;
  display_agent?: unknown;
  title?: unknown;
  agent?: unknown;
  agent_status?: unknown;
  cwd?: unknown;
  state_change_seq?: unknown;
};

const STATUSES: readonly FleetStatus[] = ["idle", "working", "blocked", "done", "unknown"];

const asString = (value: unknown, fallback: string): string =>
  typeof value === "string" ? value : fallback;

const firstText = (...values: unknown[]): string =>
  values.find((value): value is string => typeof value === "string" && value !== "") ?? "";

/**
 * Reduces a herdr-reported label to a short, single-line, plain token.
 * Pane names and titles are set by whoever runs in the pane, and they reach
 * the session inside wake prompts, so they must not carry instructions.
 *
 * @param value the raw label
 * @param max the longest label kept
 * @returns the label with anything outside letters, digits, and `._:/-` turned into spaces
 */
export const label = (value: string, max = 48): string =>
  value
    .replace(/[^A-Za-z0-9 ._:/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

const toAgent = (raw: RawAgent): FleetAgent => {
  const status = asString(raw.agent_status, "unknown") as FleetStatus;

  return {
    pane: label(asString(raw.pane_id, ""), 32),
    // herdr's own agent name is set at `agent start`; the display name and
    // title come later from the agent and drift with its session.
    name: label(firstText(raw.name, raw.display_agent, raw.title)),
    harness: label(asString(raw.agent, "unknown"), 16),
    status: STATUSES.includes(status) ? status : "unknown",
    cwd: asString(raw.cwd, ""),
    workspace:
      typeof raw.workspace_id === "string" && raw.workspace_id !== ""
        ? raw.workspace_id
        : undefined,
    seq: typeof raw.state_change_seq === "number" ? raw.state_change_seq : 0,
  };
};

const parseDocument = (output: RunOutput): Record<string, unknown> => {
  const text = output.stdout.trim() || output.stderr.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HerdrFailure({
      code: "unreadable_output",
      message: text.slice(0, 300) || `exit ${output.exitCode}`,
    });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new HerdrFailure({ code: "unreadable_output", message: text.slice(0, 300) });
  }
  const document = parsed as Record<string, unknown>;
  const error = document.error as Partial<HerdrError> | undefined;
  if (error !== undefined) {
    throw new HerdrFailure({ code: error.code ?? "unknown_error", message: error.message ?? "" });
  }
  return document;
};

/**
 * Parses `herdr agent list` output.
 *
 * @param output the finished command
 * @returns every agent pane herdr knows about
 * @throws HerdrFailure when herdr reported an error
 */
export const parseAgentList = (output: RunOutput): FleetAgent[] => {
  const result = parseDocument(output).result as { agents?: RawAgent[] } | undefined;
  return (result?.agents ?? []).map(toAgent).filter((agent) => agent.pane !== "");
};

/**
 * Parses the single agent `herdr agent wait` and `agent prompt --wait` print.
 *
 * @param output the finished command
 * @returns the agent as it settled
 * @throws HerdrFailure when herdr reported an error (including `timeout`)
 */
export const parseAgentInfo = (output: RunOutput): FleetAgent => {
  const result = parseDocument(output).result as { agent?: RawAgent } | undefined;
  return toAgent(result?.agent ?? {});
};

/**
 * Throws when a command that prints no JSON on success failed.
 *
 * @param output the finished command
 * @throws HerdrFailure when the command failed
 */
export const assertOk = (output: RunOutput): void => {
  if (output.exitCode === 0) return;
  parseDocument(output);
  throw new HerdrFailure({
    code: "command_failed",
    message: (output.stderr || output.stdout).slice(0, 300),
  });
};

/**
 * Argv for listing every agent pane.
 *
 * @returns the argv
 */
export const listArgv = (): string[] => ["herdr", "agent", "list"];

/**
 * Argv for waiting on one pane to reach a state.
 *
 * @param pane the pane id
 * @param until the states to match
 * @param timeoutMs herdr's own timeout
 * @returns the argv
 */
export const waitArgv = (
  pane: string,
  until: readonly FleetStatus[],
  timeoutMs: number,
): string[] => [
  "herdr",
  "agent",
  "wait",
  pane,
  ...until.flatMap((status) => ["--until", status]),
  "--timeout",
  String(timeoutMs),
];

/**
 * Argv for reading a pane's recent terminal output.
 *
 * @param pane the pane id
 * @param lines how many lines
 * @returns the argv
 */
export const readArgv = (pane: string, lines: number): string[] => [
  "herdr",
  "agent",
  "read",
  pane,
  "--source",
  "recent-unwrapped",
  "--lines",
  String(lines),
];

/**
 * Argv for submitting a prompt to a pane's agent without waiting.
 *
 * @param pane the pane id
 * @param text the prompt
 * @returns the argv
 */
export const promptArgv = (pane: string, text: string): string[] => [
  "herdr",
  "agent",
  "prompt",
  pane,
  text,
];
