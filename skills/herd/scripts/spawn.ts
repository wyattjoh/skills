#!/usr/bin/env bun
import { Command } from "commander";
import { Data, Duration, Effect, Schedule } from "effect";
import { readFileSync } from "node:fs";

// Launches one worker: a herdr tab in the coordinator's workspace, an agent CLI
// started inside it, and the brief submitted as that agent's first turn.
//
// The three steps are one script because they are one transaction. A tab whose
// agent failed to start is a dead pane that still looks like a running worker in
// the tab bar, and the coordinator would wait forever for a report from a
// session that never came up. On any failure after the tab exists, the tab is
// closed so a failed spawn leaves nothing behind.
//
// The brief is passed through an argv array, never a shell string. Briefs carry
// ticket prose with quotes, backticks and newlines, and interpolating that into
// a shell command is how a worker silently receives a truncated task.

export type AgentKind = "claude" | "pi";

export class TabCreateFailed extends Data.TaggedError("TabCreateFailed")<{
  readonly detail: string;
}> {}

export class AgentStartFailed extends Data.TaggedError("AgentStartFailed")<{
  readonly peerName: string;
  readonly detail: string;
}> {}

export class PromptFailed extends Data.TaggedError("PromptFailed")<{
  readonly peerName: string;
  readonly detail: string;
}> {}

export class InvalidRequest extends Data.TaggedError("InvalidRequest")<{
  readonly detail: string;
}> {}

export interface SpawnRequest {
  workspaceId: string;
  label: string;
  cwd: string;
  peerName: string;
  kind: AgentKind;
  brief: string;
  agent?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  permissionMode?: string | undefined;
  startTimeoutMs: number;
  promptTimeoutMs: number;
}

export interface SpawnResult {
  peerName: string;
  tabId: string;
  paneId: string;
  command: string[];
}

// The operator's shorthand for the three gpt-5.6 variants. "use terra" means
// the gpt-5.6 terra model, not some other model that happens to be named terra.
const GPT_ALIASES: Record<string, string> = {
  luna: "gpt-5.6-luna",
  sol: "gpt-5.6-sol",
  terra: "gpt-5.6-terra",
};

export const OPENAI_PROVIDER = "openai-codex";

// Models served by pi: the gpt- family, its bare aliases, and anything already
// carrying an explicit provider prefix. Everything else is a Claude model and
// runs under the claude CLI.
export function kindForModel(model: string | undefined): AgentKind {
  if (!model) return "claude";
  if (model.startsWith("gpt-")) return "pi";
  if (model in GPT_ALIASES) return "pi";
  if (model.startsWith(`${OPENAI_PROVIDER}/`)) return "pi";
  return "claude";
}

// pi resolves a bare `gpt-5.6-terra` against its default provider, which is not
// necessarily openai-codex. Qualifying the model means the worker runs on the
// model that was actually chosen rather than whatever the local pi settings
// happen to default to.
export function normalizePiModel(model: string): string {
  const alias = GPT_ALIASES[model];
  if (alias) return `${OPENAI_PROVIDER}/${alias}`;
  if (model.startsWith("gpt-")) return `${OPENAI_PROVIDER}/${model}`;
  return model;
}

const CLAUDE_EFFORT = ["low", "medium", "high", "xhigh", "max"] as const;
const PI_THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

// claude spells reasoning depth `--effort`, pi spells it `--thinking`, and pi
// accepts two levels claude rejects. Validating here turns a typo into a refused
// spawn instead of a CLI that exits immediately inside a fresh pane.
export function reasoningFlag(kind: AgentKind, effort: string): string[] {
  if (kind === "claude") {
    if (!CLAUDE_EFFORT.includes(effort as (typeof CLAUDE_EFFORT)[number])) {
      throw new Error(`claude --effort accepts ${CLAUDE_EFFORT.join(", ")}; received '${effort}'`);
    }
    return ["--effort", effort];
  }
  if (!PI_THINKING.includes(effort as (typeof PI_THINKING)[number])) {
    throw new Error(`pi --thinking accepts ${PI_THINKING.join(", ")}; received '${effort}'`);
  }
  return ["--thinking", effort];
}

// Builds the arguments passed after `--` to `herdr agent start`. Both CLIs need
// an explicit peer name: without one they derive a name from cwd and pid, which
// the coordinator cannot predict and therefore cannot address.
export function agentArgs(request: SpawnRequest): string[] {
  const args: string[] = [];
  if (request.kind === "claude") {
    args.push("-n", request.peerName);
    args.push("--permission-mode", request.permissionMode ?? "auto");
    if (request.agent) args.push("--agent", request.agent);
    if (request.model) args.push("--model", request.model);
  } else {
    args.push("--claude-peer", "--cc-name", request.peerName);
    if (request.model) args.push("--model", normalizePiModel(request.model));
  }
  if (request.effort) args.push(...reasoningFlag(request.kind, request.effort));
  return args;
}

interface CommandOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const run = (argv: readonly string[]): Effect.Effect<CommandOutput, never> =>
  Effect.promise(async () => {
    const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
  });

// herdr replies with one JSON document per command; the ids the next step needs
// are nested under `result`.
export function parseTabCreate(stdout: string): { tabId: string; paneId: string } {
  const parsed: unknown = JSON.parse(stdout);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("tab create returned a non-object");
  }
  const result = (parsed as { result?: unknown }).result;
  if (typeof result !== "object" || result === null) {
    throw new Error("tab create response has no 'result'");
  }
  const { tab, root_pane: rootPane } = result as {
    tab?: { tab_id?: unknown };
    root_pane?: { pane_id?: unknown };
  };
  const tabId = tab?.tab_id;
  const paneId = rootPane?.pane_id;
  if (typeof tabId !== "string" || typeof paneId !== "string") {
    throw new Error("tab create response is missing tab_id or root_pane.pane_id");
  }
  return { tabId, paneId };
}

const createTab = (request: SpawnRequest) =>
  Effect.gen(function* () {
    const argv = [
      "herdr",
      "tab",
      "create",
      "--workspace",
      request.workspaceId,
      "--label",
      request.label,
      "--cwd",
      request.cwd,
      "--no-focus",
    ];
    const out = yield* run(argv);
    if (out.exitCode !== 0) {
      return yield* new TabCreateFailed({ detail: out.stderr || out.stdout });
    }
    const parsed = yield* Effect.try({
      try: () => parseTabCreate(out.stdout),
      catch: (error) => new TabCreateFailed({ detail: (error as Error).message }),
    });
    return parsed;
  });

const closeTab = (tabId: string) =>
  run(["herdr", "tab", "close", tabId]).pipe(Effect.asVoid, Effect.ignore);

// `herdr agent start` requires the target pane to already be sitting at its
// interactive shell prompt, and a freshly created tab is not there yet: the
// shell is still starting. herdr answers `agent_pane_busy` for that window,
// which is a "not yet" rather than a real failure.
//
// Observed against a real herdr instance: starting an agent immediately after
// `tab create` fails every time. Retrying is what makes dispatch reliable.
export function isPaneNotReady(error: AgentStartFailed): boolean {
  return (
    error.detail.includes("agent_pane_busy") || error.detail.includes("not an available shell")
  );
}

const attemptStart = (request: SpawnRequest, paneId: string) =>
  Effect.gen(function* () {
    const argv = [
      "herdr",
      "agent",
      "start",
      request.peerName,
      "--kind",
      request.kind,
      "--pane",
      paneId,
      "--timeout",
      String(request.startTimeoutMs),
      "--",
      ...agentArgs(request),
    ];
    const out = yield* run(argv);
    if (out.exitCode !== 0) {
      return yield* new AgentStartFailed({
        peerName: request.peerName,
        detail: out.stderr || out.stdout,
      });
    }
    return argv;
  });

const startAgent = (request: SpawnRequest, paneId: string) =>
  Effect.retry(attemptStart(request, paneId), {
    while: isPaneNotReady,
    schedule: Schedule.spaced("300 millis").pipe(
      Schedule.intersect(Schedule.recurUpTo(Duration.millis(request.startTimeoutMs))),
    ),
  });

// An agent CLI reports `interactive_ready` before its TUI will actually accept a
// submitted prompt. herdr requires an observed state change within a hardcoded
// 5s of submission and otherwise answers `agent_prompt_stalled`, so a brief sent
// straight after `agent start` reliably stalls.
export function isPromptStalled(error: PromptFailed): boolean {
  return error.detail.includes("agent_prompt_stalled");
}

export function statusForPeer(stdout: string, peerName: string): string | null {
  const parsed = JSON.parse(stdout) as {
    result?: { agents?: { name?: string; agent_status?: string }[] };
  };
  const agent = (parsed.result?.agents ?? []).find((a) => a.name === peerName);
  return agent?.agent_status ?? null;
}

// A stall means herdr saw no state change, which normally means the brief never
// landed. It can also mean the turn started and finished inside the detection
// window, so check before concluding anything: re-submitting a brief to an agent
// that already accepted it would give the worker its task twice.
const acceptedAlready = (peerName: string) =>
  Effect.gen(function* () {
    const out = yield* run(["herdr", "agent", "list"]);
    if (out.exitCode !== 0) return false;
    const status = yield* Effect.try({
      try: () => statusForPeer(out.stdout, peerName),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null));
    return status === "working" || status === "done";
  });

// `--until working` is deliberate. The default settle states include `idle`,
// which an agent reports before it has read the brief; waiting for `working`
// confirms the brief was accepted and the turn actually began.
const attemptPrompt = (request: SpawnRequest) =>
  Effect.gen(function* () {
    const out = yield* run([
      "herdr",
      "agent",
      "prompt",
      request.peerName,
      request.brief,
      "--wait",
      "--until",
      "working",
      "--timeout",
      String(request.promptTimeoutMs),
    ]);
    if (out.exitCode === 0) return;

    const error = new PromptFailed({
      peerName: request.peerName,
      detail: out.stderr || out.stdout,
    });
    if (!isPromptStalled(error)) return yield* error;
    if (yield* acceptedAlready(request.peerName)) return;

    // Clear whatever partial text may be sitting in the composer, so a retry
    // submits the brief once rather than appending it to a half-typed copy.
    yield* run(["herdr", "agent", "send-keys", request.peerName, "esc"]);
    return yield* error;
  });

const submitBrief = (request: SpawnRequest) =>
  Effect.retry(attemptPrompt(request), {
    while: isPromptStalled,
    schedule: Schedule.spaced("1 seconds").pipe(
      Schedule.intersect(Schedule.recurUpTo(Duration.millis(request.promptTimeoutMs))),
    ),
  });

export const spawnWorker = (
  request: SpawnRequest,
): Effect.Effect<SpawnResult, TabCreateFailed | AgentStartFailed | PromptFailed | InvalidRequest> =>
  Effect.gen(function* () {
    if (request.brief.trim().length === 0) {
      return yield* new InvalidRequest({ detail: "brief is empty" });
    }
    const { tabId, paneId } = yield* createTab(request);

    // Everything after the tab exists must clean the tab up on failure, or a
    // failed spawn leaves an orphan pane that reads as a live worker.
    const rest = Effect.gen(function* () {
      const command = yield* startAgent(request, paneId);
      yield* submitBrief(request);
      return { peerName: request.peerName, tabId, paneId, command } satisfies SpawnResult;
    });

    return yield* Effect.onError(rest, () => closeTab(tabId));
  });

if (import.meta.main) {
  const program = new Command()
    .name("spawn")
    .description("Create a herdr tab, start an agent CLI in it, and submit the brief")
    .requiredOption("--workspace <id>", "herdr workspace id to create the tab in")
    .requiredOption("--label <text>", "tab label, normally the ticket id")
    .requiredOption("--cwd <path>", "worker's working directory (its worktree)")
    .requiredOption("--peer-name <name>", "peer name the worker advertises")
    .requiredOption("--brief <path>", "file containing the worker's full prompt")
    .option("--kind <kind>", "claude or pi; inferred from --model when omitted")
    .option("--agent <name>", "agent definition to launch the session as")
    .option("--model <model>", "model override")
    .option("--effort <level>", "reasoning effort (claude) or thinking level (pi)")
    .option("--permission-mode <mode>", "claude permission mode", "auto")
    .option("--start-timeout <ms>", "readiness timeout for agent start", "60000")
    .option("--prompt-timeout <ms>", "timeout waiting for the brief to be accepted", "120000")
    .parse();

  const opts = program.opts<{
    workspace: string;
    label: string;
    cwd: string;
    peerName: string;
    brief: string;
    kind?: string;
    agent?: string;
    model?: string;
    effort?: string;
    permissionMode: string;
    startTimeout: string;
    promptTimeout: string;
  }>();

  const kind: AgentKind =
    opts.kind === "pi" || opts.kind === "claude" ? opts.kind : kindForModel(opts.model);

  const request: SpawnRequest = {
    workspaceId: opts.workspace,
    label: opts.label,
    cwd: opts.cwd,
    peerName: opts.peerName,
    kind,
    brief: readFileSync(opts.brief, "utf8"),
    agent: opts.agent,
    model: opts.model,
    effort: opts.effort,
    permissionMode: opts.permissionMode,
    startTimeoutMs: Number(opts.startTimeout),
    promptTimeoutMs: Number(opts.promptTimeout),
  };

  const exit = await Effect.runPromise(
    spawnWorker(request).pipe(
      Effect.map((result) => {
        console.log(JSON.stringify({ ok: true, ...result }, null, 2));
        return 0;
      }),
      // Spreading the tagged error carries its `_tag` and payload through, so
      // the caller sees which step failed and why without this reaching in.
      Effect.catchAll((error) => {
        console.error(JSON.stringify({ ok: false, ...error }, null, 2));
        return Effect.succeed(1);
      }),
    ),
  );
  process.exit(exit);
}
