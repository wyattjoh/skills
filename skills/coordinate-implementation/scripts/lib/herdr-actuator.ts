import { Data, Effect } from "effect";
import type { CliIssue } from "./contract.ts";
import type { ArgumentCommand } from "./harness-launch.ts";

/**
 * Captured result of one Herdr CLI invocation.
 */
export type HerdrCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/**
 * Executes one argument array without a shell and returns its captured output.
 */
export type CommandRunner = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<HerdrCommandResult>;

/**
 * Tab and root pane the engine owns for one agent or for itself.
 */
export type OwnedTab = {
  tab_id: string;
  pane_id: string;
  adopted: boolean;
};

/**
 * Engine-side Herdr operations that the coordinator used to run by hand.
 */
export type HerdrActuator = {
  ensureTab: (input: {
    workspace: string;
    cwd: string;
    label: string;
    env: Record<string, string>;
  }) => Effect.Effect<OwnedTab, HerdrActuatorError>;
  run: (command: ArgumentCommand) => Effect.Effect<HerdrCommandResult, HerdrActuatorError>;
  deliverPrompt: (session: string, text: string) => Effect.Effect<void, HerdrActuatorError>;
  readPane: (paneId: string, lines: number) => Effect.Effect<string, HerdrActuatorError>;
  closePane: (paneId: string) => Effect.Effect<"closed" | "absent", HerdrActuatorError>;
  runInPane: (paneId: string, commandLine: string) => Effect.Effect<void, HerdrActuatorError>;
};

/**
 * Typed Herdr CLI failure observed by the engine.
 */
export class HerdrActuatorError extends Data.TaggedError("HerdrActuatorError")<{
  issue: CliIssue;
}> {}

const actuatorError = (code: string, message: string): HerdrActuatorError =>
  new HerdrActuatorError({
    issue: {
      code,
      message,
      remediation: "Apply the bounded Herdr infrastructure retry for the affected ticket.",
    },
  });

const COMMAND_TIMEOUT_MS = 60_000;
const START_TIMEOUT_MS = 330_000;

/**
 * Spawns a command with a hard timeout and captures stdout and stderr.
 *
 * @param command - Executable name.
 * @param args - Exact argument array.
 * @param timeoutMs - Kill deadline in milliseconds.
 * @returns The exit code and captured output; a killed process reports exit 124.
 */
export const spawnCommand: CommandRunner = async (command, args, timeoutMs) => {
  const child = Bun.spawn([command, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  return { exitCode: timedOut ? 124 : exitCode, stdout, stderr };
};

const resultObject = (stdout: string, subject: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(stdout) as { result?: unknown };
    if (typeof parsed.result === "object" && parsed.result !== null) {
      return parsed.result as Record<string, unknown>;
    }
  } catch {
    // fall through to the typed error
  }
  throw actuatorError("herdr.cli_malformed", `Herdr returned malformed JSON for ${subject}.`);
};

const field = (value: unknown, key: string): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
};

/**
 * Builds a prompt submission that returns once Herdr observes delivery.
 * The engine waits for completion through its event subscription instead.
 *
 * @param session - Agent session name.
 * @param text - Prompt text passed as one argument.
 * @returns Exact Herdr argument array.
 */
export const deliveryPromptArgs = (session: string, text: string): string[] => [
  "agent",
  "prompt",
  session,
  text,
  "--wait",
  "--until",
  "working",
  "--until",
  "blocked",
  "--until",
  "done",
  "--until",
  "idle",
  "--timeout",
  "60000",
];

/**
 * Creates the engine's Herdr actuator over an injectable command runner.
 *
 * @param runner - Process runner; tests inject a scripted fake.
 * @returns The actuator operations.
 */
export const makeHerdrActuator = (runner: CommandRunner = spawnCommand): HerdrActuator => {
  const invoke = (
    args: string[],
    subject: string,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Effect.Effect<HerdrCommandResult, HerdrActuatorError> =>
    Effect.tryPromise({
      try: () => runner("herdr", args, timeoutMs),
      catch: (error) =>
        actuatorError("herdr.cli_failed", `Could not run herdr ${subject}: ${String(error)}`),
    });

  const invokeOk = (args: string[], subject: string, timeoutMs = COMMAND_TIMEOUT_MS) =>
    invoke(args, subject, timeoutMs).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed(result)
          : Effect.fail(
              actuatorError(
                "herdr.cli_failed",
                `herdr ${subject} exited ${result.exitCode}: ${(result.stderr || result.stdout).trim()}`,
              ),
            ),
      ),
    );

  const parsed = (args: string[], subject: string) =>
    invokeOk(args, subject).pipe(
      Effect.flatMap((result) =>
        Effect.try({
          try: () => resultObject(result.stdout, subject),
          catch: (error) =>
            error instanceof HerdrActuatorError
              ? error
              : actuatorError("herdr.cli_malformed", String(error)),
        }),
      ),
    );

  const ensureTab: HerdrActuator["ensureTab"] = (input) =>
    Effect.gen(function* () {
      const listed = yield* parsed(["tab", "list", "--workspace", input.workspace], "tab list");
      const tabs = Array.isArray(listed.tabs) ? listed.tabs : [];
      const existing = tabs.filter((tab) => field(tab, "label") === input.label);
      if (existing.length > 1) {
        return yield* actuatorError(
          "herdr.tab_ambiguous",
          `More than one Herdr tab is labelled \`${input.label}\`.`,
        );
      }
      const tabId = field(existing[0], "tab_id");
      if (tabId !== undefined) {
        const panes = yield* parsed(["pane", "list", "--workspace", input.workspace], "pane list");
        const pane = (Array.isArray(panes.panes) ? panes.panes : []).find(
          (candidate) => field(candidate, "tab_id") === tabId,
        );
        const paneId = field(pane, "pane_id");
        if (paneId === undefined) {
          return yield* actuatorError(
            "herdr.tab_without_pane",
            `Herdr tab \`${tabId}\` labelled \`${input.label}\` has no pane.`,
          );
        }
        return { tab_id: tabId, pane_id: paneId, adopted: true };
      }
      const created = yield* parsed(
        [
          "tab",
          "create",
          "--workspace",
          input.workspace,
          "--cwd",
          input.cwd,
          "--label",
          input.label,
          ...Object.entries(input.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
          "--no-focus",
        ],
        "tab create",
      );
      const createdTab = field(created.tab, "tab_id");
      const createdPane = field(created.root_pane, "pane_id");
      if (createdTab === undefined || createdPane === undefined) {
        return yield* actuatorError(
          "herdr.cli_malformed",
          "herdr tab create did not return .result.tab.tab_id and .result.root_pane.pane_id.",
        );
      }
      return { tab_id: createdTab, pane_id: createdPane, adopted: false };
    });

  const run: HerdrActuator["run"] = (command) =>
    command.command === "herdr"
      ? invoke(command.args, command.args.slice(0, 2).join(" "), START_TIMEOUT_MS)
      : Effect.fail(
          actuatorError(
            "herdr.command_unsupported",
            `The engine only executes herdr argv, not \`${command.command}\`.`,
          ),
        );

  const deliverPrompt: HerdrActuator["deliverPrompt"] = (session, text) =>
    invokeOk(deliveryPromptArgs(session, text), "agent prompt", 90_000).pipe(Effect.asVoid);

  const readPane: HerdrActuator["readPane"] = (paneId, lines) =>
    invokeOk(
      ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)],
      "pane read",
    ).pipe(Effect.map((result) => result.stdout));

  const closePane: HerdrActuator["closePane"] = (paneId) =>
    invoke(["pane", "close", paneId], "pane close").pipe(
      Effect.flatMap((result) => {
        if (result.exitCode === 0) return Effect.succeed("closed" as const);
        if (`${result.stdout}${result.stderr}`.includes("pane_not_found")) {
          return Effect.succeed("absent" as const);
        }
        return Effect.fail(
          actuatorError(
            "herdr.cli_failed",
            `herdr pane close exited ${result.exitCode}: ${(result.stderr || result.stdout).trim()}`,
          ),
        );
      }),
    );

  const runInPane: HerdrActuator["runInPane"] = (paneId, commandLine) =>
    invokeOk(["pane", "run", paneId, commandLine], "pane run").pipe(Effect.asVoid);

  return { ensureTab, run, deliverPrompt, readPane, closePane, runInPane };
};
