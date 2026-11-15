/**
 * Current core agent states, plus unreported and finished terminals.
 */
export type FleetStatus =
  | "idle"
  | "working"
  | "blocked"
  | "done"
  | "error"
  | "finished"
  | "unknown";

/**
 * Terminal observations that need coordinator attention, not proof of an async outcome.
 */
export const SETTLED: readonly FleetStatus[] = ["idle", "done", "blocked", "error", "finished"];

/**
 * A core terminal projected for fleet tools. `pane` is the tool API's historical
 * field name; its value is always a core terminal address, never an app pane ID.
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
 * Normalized current-core failure.
 */
export type HerdrError = { code: string; message: string };

/**
 * One bounded subprocess result.
 */
export type RunOutput = { exitCode: number; stdout: string; stderr: string };

/**
 * Harness-injected process execution; the mod implementation remains Node-free.
 */
export type Runner = (
  argv: readonly string[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
) => Promise<RunOutput>;

/**
 * A core protocol or command failure, preserving the core's error kind.
 */
export class HerdrFailure extends Error {
  readonly code: string;
  /**
   * Preserve a normalized core error kind and message.
   */
  constructor(error: HerdrError) {
    super(`${error.code}: ${error.message}`);
    this.code = error.code;
  }
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
const string = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;
const STATUSES: readonly FleetStatus[] = [
  "idle",
  "working",
  "blocked",
  "done",
  "error",
  "finished",
  "unknown",
];

/**
 * Make untrusted names safe for wake prompts.
 * @param value Raw terminal label.
 * @param max Maximum retained length.
 * @returns A plain single-line label.
 */
export const label = (value: string, max = 48): string =>
  value
    .replace(/[^A-Za-z0-9 ._:/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

const toAgent = (raw: Record<string, unknown>): FleetAgent => {
  const status = record(raw.status);
  const argv = Array.isArray(raw.argv) ? raw.argv : [];
  const command = string(argv[0]).split("/").pop();
  const state = raw.state === "finished" ? "finished" : string(status.state, "unknown");
  return {
    pane: string(raw.address),
    name: label(string(raw.name) || string(raw.title)),
    harness: label(
      string(status.app) || (command === "pi" || command === "claude" ? command : "unknown"),
      16,
    ),
    status: STATUSES.includes(state as FleetStatus) ? (state as FleetStatus) : "unknown",
    cwd: string(record(raw.foreground).cwd) || string(raw.cwd),
    workspace: string(record(raw.labels)["herdr.space"]) || undefined,
    // Core turns advance on leaving working. Startup idle alone must not wake a
    // dispatch watch. An exit adds one observation even without a final root word.
    seq: (typeof raw.turn === "number" ? raw.turn : 0) + (raw.state === "finished" ? 1 : 0),
  };
};

const parseDocument = (output: RunOutput): Record<string, unknown> => {
  const text = (output.exitCode !== 0 ? output.stderr || output.stdout : output.stdout).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HerdrFailure({
      code: "unreadable_output",
      message: text.slice(0, 300) || `exit ${output.exitCode}`,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new HerdrFailure({ code: "unreadable_output", message: text.slice(0, 300) });
  const document = record(parsed);
  if (document.error !== undefined) {
    const error = record(document.error);
    throw new HerdrFailure({
      code: string(error.kind, "unknown_error"),
      message: string(error.message),
    });
  }
  if (output.exitCode !== 0)
    throw new HerdrFailure({ code: "command_failed", message: text.slice(0, 300) });
  return document;
};

/**
 * Parse local agents from `hc ls --all`, rejecting legacy envelopes rather than hiding workers.
 * @param output Bounded CLI result.
 * @returns Local agent terminals, including finished workers but excluding plain programs and remote cores.
 */
export const parseAgentList = (output: RunOutput): FleetAgent[] => {
  const document = parseDocument(output);
  if (!Array.isArray(document.terminals))
    throw new HerdrFailure({
      code: "incompatible_runtime",
      message: "Expected hc terminal list; legacy Herdr is unsupported",
    });
  return document.terminals
    .map((value) => toAgent(record(value)))
    .filter(
      (agent) => agent.pane !== "" && !agent.pane.includes("/") && agent.harness !== "unknown",
    );
};

/**
 * Parse one `hc get` result; core wait results must be handled separately.
 * @param output Bounded CLI result.
 * @returns The terminal's fleet projection.
 */
export const parseAgentInfo = (output: RunOutput): FleetAgent => {
  const document = parseDocument(output);
  if (typeof document.address !== "string")
    throw new HerdrFailure({
      code: "incompatible_runtime",
      message: "Expected hc terminal document",
    });
  return toAgent(document);
};

/**
 * Classify a core wait without treating messages, startup or timeouts as completion.
 * @param output Bounded CLI result.
 * @param terminal Expected immutable terminal address.
 * @returns Settlement, timeout/check-in or message interruption.
 */
export const parseWait = (
  output: RunOutput,
  terminal: string,
): "settled" | "timeout" | "message" => {
  const document = parseDocument(output);
  if (
    document.terminal !== terminal ||
    typeof document.reason !== "string" ||
    typeof document.ended !== "boolean"
  )
    throw new HerdrFailure({ code: "incompatible_runtime", message: "Expected hc wait result" });
  if (document.reason === "message") return "message";
  if (document.reason === "timeout" || document.reason === "not_started") return "timeout";
  if ((document.reason === "status" || document.reason === "exit") && document.ended === true)
    return "settled";
  throw new HerdrFailure({ code: "unexpected_wait", message: string(document.reason) });
};

/**
 * Require a successful command, preserving structured core errors when present.
 * @param output Bounded CLI result.
 * @returns Nothing on success; throws a normalized core failure otherwise.
 */
export const assertOk = (output: RunOutput): void => {
  if (output.exitCode === 0) return;
  parseDocument(output);
};

/**
 * Include finished terminals so owned exits remain observable.
 * @returns Current-core list argv.
 */
export const listArgv = (): string[] => ["hc", "ls", "--all"];

/**
 * Convert the public millisecond budget to core seconds. State selection is local.
 * @param pane Core terminal address (historical tool field name).
 * @param _until Settlement filter applied by the caller, not passed to core.
 * @param timeoutMs Public timeout budget in milliseconds.
 * @returns Current-core wait argv.
 */
export const waitArgv = (
  pane: string,
  _until: readonly FleetStatus[],
  timeoutMs: number,
): string[] => ["hc", "wait", pane, "--timeout", String(timeoutMs / 1000)];

/**
 * Read a bounded amount of terminal screen/history as plain text.
 * @param pane Core terminal address.
 * @param lines Requested history limit.
 * @returns Current-core read argv.
 */
export const readArgv = (pane: string, lines: number): string[] => [
  "hc",
  "read",
  pane,
  "--lines",
  String(lines),
];

/**
 * Submit without forcing blocked terminals or granting native permissions.
 * @param pane Core terminal address.
 * @param text Assignment text to submit.
 * @returns Current-core send argv, without a force flag.
 */
export const promptArgv = (pane: string, text: string): string[] => ["hc", "send", pane, text];
