import { Effect, Result } from "effect";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import type { CliIssue } from "./contract.ts";
import {
  claimEngineLease,
  engineLiveness,
  isPidAlive,
  leaseIssue,
  readEngineHeartbeat,
  readEngineLease,
  releaseEngineLease,
  type EngineLease,
} from "./engine-lease.ts";
import { runEngine, stopRequestPath, type EngineWorkflow } from "./engine.ts";
import { answerEscalation, listOpenEscalations } from "./escalations.ts";
import { readEventsSince, type RuntimeEvent } from "./event-log.ts";
import { projectRun } from "./global-state.ts";
import { makeHerdrActuator, type HerdrActuator } from "./herdr-actuator.ts";

/**
 * Heartbeat cadence of a production engine.
 */
export const HEARTBEAT_MS = 10_000;

/**
 * Heartbeat age after which `wait` and `start` treat the engine as stale.
 */
export const STALE_AFTER_MS = 45_000;

/**
 * Longest `wait` budget, kept below the shortest supported harness tool limit.
 */
export const MAX_WAIT_MS = 9 * 60_000;

/**
 * Workflow module contract: the default export of a run script.
 */
export type WorkflowModule = {
  kind: "coordinate-workflow";
  run: EngineWorkflow;
};

/**
 * Injectable process, clock, and Herdr dependencies for the runtime CLI.
 */
export type RuntimeDeps = {
  actuator: HerdrActuator;
  now: () => Date;
  host: string;
  pid: number;
  env: Record<string, string | undefined>;
  skillDir: string;
  sleep: (ms: number) => Promise<void>;
  loadWorkflow: (scriptPath: string) => Promise<WorkflowModule>;
  pollMs: number;
  startTimeoutMs: number;
  heartbeatMs: number;
};

/**
 * JSON result printed by every runtime command.
 */
export type RuntimeOutput = {
  exitCode: number;
  stdout: string;
};

class CommandFailure extends Error {
  constructor(readonly issue: CliIssue) {
    super(issue.message);
  }
}

const fail = (code: string, message: string, remediation: string): never => {
  throw new CommandFailure({ code, message, remediation });
};

const run = async <A, E>(effect: Effect.Effect<A, E>, toIssue: (error: E) => CliIssue) => {
  const outcome = await Effect.runPromise(Effect.result(effect));
  if (Result.isFailure(outcome)) throw new CommandFailure(toIssue(outcome.failure));
  return outcome.success;
};

const withIssue = (error: { issue: CliIssue }): CliIssue => error.issue;

const loadModule = async (scriptPath: string): Promise<WorkflowModule> => {
  const module = (await import(scriptPath)) as { default?: Partial<WorkflowModule> };
  const value = module.default;
  if (value?.kind !== "coordinate-workflow" || typeof value.run !== "function") {
    return fail(
      "runtime.script_invalid",
      `\`${scriptPath}\` does not default-export a workflow created by \`workflow()\`.`,
      "Export `default workflow(async (run) => { ... })` from the run script.",
    );
  }
  return value as WorkflowModule;
};

/**
 * Production dependencies.
 *
 * @param skillDir - Absolute skill root used to relaunch the engine.
 * @returns Real Herdr, clock, and process dependencies.
 */
export const defaultRuntimeDeps = (skillDir: string): RuntimeDeps => ({
  actuator: makeHerdrActuator(),
  now: () => new Date(),
  host: hostname(),
  pid: process.pid,
  env: process.env,
  skillDir,
  sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  loadWorkflow: loadModule,
  pollMs: 500,
  startTimeoutMs: 20_000,
  heartbeatMs: HEARTBEAT_MS,
});

type Flags = Map<string, string | true>;

const parseFlags = (argv: string[]): Flags => {
  const flags: Flags = new Map();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) {
      fail("runtime.usage", `Unexpected argument \`${arg}\`.`, "See references/runtime-cli.md.");
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(arg.slice(2), true);
    } else {
      flags.set(arg.slice(2), next);
      index++;
    }
  }
  return flags;
};

const stringFlag = (flags: Flags, name: string): string | undefined => {
  const value = flags.get(name);
  if (value === true) {
    return fail(
      "runtime.usage",
      `\`--${name}\` requires a value.`,
      "See references/runtime-cli.md.",
    );
  }
  return value;
};

const requiredFlag = (flags: Flags, name: string): string =>
  stringFlag(flags, name) ??
  fail("runtime.usage", `\`--${name}\` is required.`, "See references/runtime-cli.md.");

const integerFlag = (flags: Flags, name: string): number | undefined => {
  const raw = stringFlag(flags, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("runtime.usage", `\`--${name}\` must be a non-negative integer.`, "Pass a whole number.");
  }
  return value;
};

type RunPaths = { runPath: string; statePath: string };

const runPaths = (flags: Flags): RunPaths => {
  const runPath = resolve(requiredFlag(flags, "run"));
  const statePath = join(runPath, "RESUME.md");
  if (!existsSync(statePath)) {
    fail(
      "runtime.run_missing",
      `\`${statePath}\` does not exist.`,
      "Create the run with preflight and snapshot acceptance before starting the engine.",
    );
  }
  return { runPath, statePath };
};

const sha256 = async (path: string): Promise<string> =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

const shellQuote = (value: string): string =>
  /^[\w./:@=-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

const prefixOf = (markdown: string): string =>
  /^Prefix:\s*(\S+)\s*$/mu.exec(markdown)?.[1] ??
  fail("runtime.prefix_missing", "RESUME.md has no `Prefix:` line.", "Repair RESUME.md.");

const cursorPath = (runPath: string): string => join(runPath, "coordinator-cursor.json");

const readCursor = async (runPath: string): Promise<number> => {
  try {
    const value = JSON.parse(await readFile(cursorPath(runPath), "utf8")) as { cursor?: number };
    return typeof value.cursor === "number" ? value.cursor : 0;
  } catch {
    return 0;
  }
};

const writeCursor = async (runPath: string, cursor: number): Promise<void> => {
  const path = cursorPath(runPath);
  await writeFile(`${path}.tmp`, `${JSON.stringify({ cursor })}\n`, "utf8");
  await rename(`${path}.tmp`, path);
};

type EngineView = {
  liveness: ReturnType<typeof engineLiveness>;
  generation: number;
  pid: number | null;
  pane: string | null;
  script_sha256: string | null;
  heartbeat_at: string | null;
};

const observeEngine = async (statePath: string, deps: RuntimeDeps): Promise<EngineView> => {
  const lease = await run(readEngineLease(statePath), withIssue);
  const heartbeat = await Effect.runPromise(readEngineHeartbeat(statePath));
  return {
    liveness: engineLiveness(lease, heartbeat, deps.now(), STALE_AFTER_MS),
    generation: lease?.generation ?? 0,
    pid: lease?.pid ?? null,
    pane: lease?.pane ?? null,
    script_sha256: lease?.script_sha256 ?? null,
    heartbeat_at: heartbeat?.generation === lease?.generation ? (heartbeat?.at ?? null) : null,
  };
};

const lastSeq = async (runPath: string): Promise<number> =>
  (await run(readEventsSince(runPath, 0), withIssue)).next_cursor;

const start = async (flags: Flags, deps: RuntimeDeps): Promise<Record<string, unknown>> => {
  const { runPath, statePath } = runPaths(flags);
  const scriptPath = resolve(requiredFlag(flags, "script"));
  const scriptSha = await sha256(scriptPath);
  const accepted = stringFlag(flags, "accept-script");
  const engine = await observeEngine(statePath, deps);
  const lease = await run(readEngineLease(statePath), withIssue);

  if (engine.liveness === "alive") {
    return {
      engine: "running",
      generation: engine.generation,
      pane: engine.pane,
      script_changed: engine.script_sha256 !== scriptSha,
      cursor: await readCursor(runPath),
    };
  }
  if (
    engine.liveness === "stale" &&
    lease !== null &&
    lease.host === deps.host &&
    isPidAlive(lease.pid)
  ) {
    fail(
      "engine.unresponsive",
      `Engine generation ${lease.generation} (pid ${lease.pid}) is alive but has not heartbeated.`,
      "Run `runtime.ts stop --run <run> --force` to fence it, then start again.",
    );
  }
  if (lease !== null && lease.script_sha256 !== scriptSha && accepted !== scriptSha) {
    fail(
      "engine.script_changed",
      `The run script changed since generation ${lease.generation} (recorded ${lease.script_sha256}, now ${scriptSha}).`,
      `Review the change, then start again with \`--accept-script ${scriptSha}\`.`,
    );
  }
  await deps.loadWorkflow(scriptPath);

  const workspace =
    stringFlag(flags, "workspace") ??
    deps.env.HERDR_WORKSPACE_ID ??
    fail(
      "runtime.workspace_missing",
      "No Herdr workspace was given and HERDR_WORKSPACE_ID is unset.",
      "Run inside a Herdr pane or pass `--workspace <id>`.",
    );
  const prefix = prefixOf(await readFile(statePath, "utf8"));
  const tab = await run(
    deps.actuator.ensureTab({ workspace, cwd: runPath, label: `engine ${prefix}`, env: {} }),
    withIssue,
  );
  const expected = lease?.generation ?? 0;
  const command = [
    "bun",
    join(deps.skillDir, "scripts", "runtime.ts"),
    "engine",
    "--run",
    runPath,
    "--script",
    scriptPath,
    "--expected-generation",
    String(expected),
    "--pane",
    tab.pane_id,
  ]
    .map(shellQuote)
    .join(" ");
  await run(deps.actuator.runInPane(tab.pane_id, command), withIssue);

  const deadline = deps.now().getTime() + deps.startTimeoutMs;
  while (deps.now().getTime() < deadline) {
    const view = await observeEngine(statePath, deps);
    if (view.generation > expected) {
      return {
        engine: view.liveness === "alive" ? "started" : view.liveness,
        generation: view.generation,
        pane: tab.pane_id,
        tab: tab.tab_id,
        cursor: await readCursor(runPath),
      };
    }
    await deps.sleep(deps.pollMs);
  }
  const tail = await Effect.runPromise(
    Effect.orElseSucceed(deps.actuator.readPane(tab.pane_id, 40), () => ""),
  );
  return fail(
    "engine.start_timeout",
    `The engine did not claim generation ${expected + 1} within ${deps.startTimeoutMs}ms. Pane tail:\n${tail}`,
    "Fix the reported error in the engine pane, then start again.",
  );
};

const engineCommand = async (flags: Flags, deps: RuntimeDeps): Promise<Record<string, unknown>> => {
  const { statePath } = runPaths(flags);
  const scriptPath = resolve(requiredFlag(flags, "script"));
  const module = await deps.loadWorkflow(scriptPath);
  const exit = await run(
    runEngine({
      statePath,
      expectedGeneration: integerFlag(flags, "expected-generation") ?? 0,
      scriptSha256: await sha256(scriptPath),
      pid: deps.pid,
      host: deps.host,
      pane: stringFlag(flags, "pane") ?? null,
      heartbeatMs: deps.heartbeatMs,
      now: deps.now,
      workflow: module.run,
    }),
    withIssue,
  );
  return { exit };
};

const TERMINAL_TYPES = new Set([
  "engine.completed",
  "engine.stopped",
  "engine.failed",
  "engine.lease_lost",
]);
const MAX_RETURNED_EVENTS = 100;

const wait = async (flags: Flags, deps: RuntimeDeps): Promise<Record<string, unknown>> => {
  const { runPath, statePath } = runPaths(flags);
  const cursor = integerFlag(flags, "cursor") ?? (await readCursor(runPath));
  const budgetSeconds = integerFlag(flags, "budget-seconds");
  const budgetMs =
    budgetSeconds === undefined
      ? (integerFlag(flags, "budget-minutes") ?? 8) * 60_000
      : budgetSeconds * 1_000;
  const deadline = deps.now().getTime() + Math.min(budgetMs, MAX_WAIT_MS);
  while (true) {
    const page = await run(readEventsSince(runPath, cursor), withIssue);
    const attention = page.events.filter(
      (event) => event.attention || TERMINAL_TYPES.has(event.type),
    );
    const engine = await observeEngine(statePath, deps);
    const engineDown = engine.liveness !== "alive";
    const expired = deps.now().getTime() >= deadline;
    if (attention.length > 0 || engineDown || expired) {
      await writeCursor(runPath, page.next_cursor);
      const events: RuntimeEvent[] = page.events.slice(-MAX_RETURNED_EVENTS);
      return {
        reason: attention.length > 0 ? "attention" : engineDown ? "engine" : "budget",
        events,
        omitted_events: page.events.length - events.length,
        attention,
        open_escalations: await run(listOpenEscalations(runPath), withIssue),
        next_cursor: page.next_cursor,
        engine,
      };
    }
    await deps.sleep(deps.pollMs);
  }
};

const status = async (flags: Flags, deps: RuntimeDeps): Promise<Record<string, unknown>> => {
  const { runPath, statePath } = runPaths(flags);
  const markdown = await readFile(statePath, "utf8");
  const projection = projectRun(
    markdown,
    statePath,
    { common_dir: null, base_checkout: null },
    deps.now().toISOString(),
  );
  return {
    engine: await observeEngine(statePath, deps),
    last_seq: await lastSeq(runPath),
    cursor: await readCursor(runPath),
    open_escalations: await run(listOpenEscalations(runPath), withIssue),
    tickets: projection?.tickets ?? [],
    active_runtimes: projection?.active_runtimes ?? [],
  };
};

const answer = async (flags: Flags, deps: RuntimeDeps): Promise<Record<string, unknown>> => {
  const { runPath } = runPaths(flags);
  const by = stringFlag(flags, "by") ?? "coordinator";
  if (by !== "coordinator" && by !== "user") {
    fail(
      "runtime.usage",
      "`--by` must be `coordinator` or `user`.",
      "Pass who decided the answer.",
    );
  }
  const recorded = await run(
    answerEscalation(runPath, {
      id: requiredFlag(flags, "id"),
      answer: requiredFlag(flags, "text"),
      answered_by: by as "coordinator" | "user",
      answered_at: deps
        .now()
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z"),
    }),
    withIssue,
  );
  return { answered: recorded };
};

const revoke = async (statePath: string, lease: EngineLease, deps: RuntimeDeps) => {
  const fenced = await run(
    claimEngineLease({
      statePath,
      expectedGeneration: lease.generation,
      pid: deps.pid,
      host: deps.host,
      pane: null,
      scriptSha256: lease.script_sha256,
      now: deps.now(),
    }),
    leaseIssue,
  );
  return run(releaseEngineLease(statePath, fenced.generation, deps.now()), leaseIssue);
};

const stop = async (flags: Flags, deps: RuntimeDeps): Promise<Record<string, unknown>> => {
  const { statePath } = runPaths(flags);
  const lease = await run(readEngineLease(statePath), withIssue);
  if (lease === null || lease.released_at !== null) return { engine: "not_running" };
  await writeFile(
    stopRequestPath(statePath),
    `${JSON.stringify({ generation: lease.generation })}\n`,
  );
  const deadline = deps.now().getTime() + (flags.has("force") ? 0 : deps.startTimeoutMs);
  while (deps.now().getTime() < deadline) {
    const current = await run(readEngineLease(statePath), withIssue);
    if (current?.generation !== lease.generation || current.released_at !== null) {
      return { engine: "stopped", generation: lease.generation };
    }
    await deps.sleep(deps.pollMs);
  }
  if (!flags.has("force")) {
    return fail(
      "engine.stop_timeout",
      `Engine generation ${lease.generation} did not stop within ${deps.startTimeoutMs}ms.`,
      "Retry with `--force` to fence the generation.",
    );
  }
  if (lease.host === deps.host && isPidAlive(lease.pid) && lease.pid !== deps.pid) {
    process.kill(lease.pid, "SIGTERM");
  }
  const released = await revoke(statePath, lease, deps);
  return { engine: "fenced", fenced_generation: lease.generation, generation: released.generation };
};

const COMMANDS: Record<
  string,
  (flags: Flags, deps: RuntimeDeps) => Promise<Record<string, unknown>>
> = {
  start,
  engine: engineCommand,
  wait,
  status,
  stop,
  answer,
};

/**
 * Runs one runtime command and returns its JSON output.
 *
 * @param argv - Command name followed by `--flag value` pairs.
 * @param deps - Injectable dependencies.
 * @returns Exit code 0 with `ok: true`, 1 for an operation failure, or 2 for usage errors.
 */
export const runRuntimeCommand = async (
  argv: string[],
  deps: RuntimeDeps,
): Promise<RuntimeOutput> => {
  const [name, ...rest] = argv;
  const command = name === undefined ? undefined : COMMANDS[name];
  try {
    if (command === undefined) {
      fail(
        "runtime.usage",
        `Unknown command \`${name ?? ""}\`.`,
        "Use one of: start, wait, answer, status, stop.",
      );
    }
    const result = await command!(parseFlags(rest), deps);
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ ok: true, command: name, result }, null, 2)}\n`,
    };
  } catch (error) {
    const issue =
      error instanceof CommandFailure
        ? error.issue
        : {
            code: "runtime.failed",
            message: String(error),
            remediation: "Report this runtime failure with the command that produced it.",
          };
    return {
      exitCode: issue.code === "runtime.usage" ? 2 : 1,
      stdout: `${JSON.stringify({ ok: false, command: name ?? null, errors: [issue] }, null, 2)}\n`,
    };
  }
};
