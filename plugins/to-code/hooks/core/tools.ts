import { recordDispatch } from "./dispatch.ts";
import { type FleetStore, MAX_WAIT_MS, others, unwatch, waitAny } from "./fleet.ts";
import {
  assertOk,
  type FleetStatus,
  HerdrFailure,
  listArgv,
  parseAgentList,
  promptArgv,
  readArgv,
  type Runner,
  SETTLED,
} from "./herdr.ts";

/**
 * One model-callable tool, described once for both harnesses.
 */
export type FleetToolSpec = {
  name: FleetToolName;
  label: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

/**
 * The tools both adapters register.
 */
export type FleetToolName =
  | "fleet_status"
  | "fleet_wait"
  | "fleet_read"
  | "fleet_send"
  | "fleet_watch";

/**
 * What a tool hands back to the model.
 */
export type ToolOutcome = {
  text: string;
  isError: boolean;
};

/**
 * What the executor needs from the harness for one call.
 */
export type ToolContext = {
  runner: Runner;
  store: FleetStore;
  selfPane: string | undefined;
  awaiting: Set<string>;
  signal: AbortSignal | undefined;
};

const PANE = {
  type: "string",
  description: "herdr pane id, as fleet_status lists it (for example w5V:p2)",
};
const PANES = { type: "array", items: PANE, minItems: 1 };
const STATES = {
  type: "array",
  items: { type: "string", enum: ["idle", "working", "blocked", "done", "unknown"] },
};

/**
 * The tool specs, in registration order.
 */
export const FLEET_TOOLS: readonly FleetToolSpec[] = [
  {
    name: "fleet_status",
    label: "Fleet status",
    description:
      "List the other herdr agent panes: pane id, name, harness (claude or pi), status (idle, working, blocked, done, unknown), cwd, and whether this session watches it. Use instead of parsing `herdr agent list` in the shell.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "fleet_wait",
    label: "Fleet wait",
    description:
      "Block until the first of the given panes reaches one of the states (default idle, done, or blocked), or the timeout passes. Use instead of sleep or until loops. Returns the pane that settled and its status, or a timeout.",
    inputSchema: {
      type: "object",
      properties: {
        panes: PANES,
        until: { ...STATES, description: "States to match; default idle, done, blocked" },
        timeoutMs: { type: "number", description: `How long to wait; capped at ${MAX_WAIT_MS}` },
      },
      required: ["panes", "timeoutMs"],
      additionalProperties: false,
    },
  },
  {
    name: "fleet_read",
    label: "Fleet read",
    description:
      "Read a pane's recent terminal output to check what its agent is doing or asking. For checking state only: collect final reports from the result files workers write, not from here.",
    inputSchema: {
      type: "object",
      properties: {
        pane: PANE,
        lines: { type: "number", description: "Lines to read; default 80, at most 400" },
      },
      required: ["pane"],
      additionalProperties: false,
    },
  },
  {
    name: "fleet_send",
    label: "Fleet send",
    description:
      "Submit a prompt to a pane's agent and, by default, watch the pane so this session wakes when it settles. A blocked agent rejects the prompt: read it and answer its question instead. A stalled or timed-out submission may still have landed, so check fleet_status before sending again; never resend blindly.",
    inputSchema: {
      type: "object",
      properties: {
        pane: PANE,
        text: { type: "string", description: "The prompt" },
        watch: { type: "boolean", description: "Watch the pane after sending; default true" },
      },
      required: ["pane", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "fleet_watch",
    label: "Fleet watch",
    description:
      "Wake this session once each given pane next settles (idle, done, or blocked), then forget it. Use after dispatching work any other way, so you can end the turn instead of polling. With unwatch true, stop watching the panes.",
    inputSchema: {
      type: "object",
      properties: {
        panes: PANES,
        unwatch: { type: "boolean", description: "Stop watching instead" },
      },
      required: ["panes"],
      additionalProperties: false,
    },
  },
];

const ok = (value: unknown): ToolOutcome => ({
  text: JSON.stringify(value, null, 2),
  isError: false,
});

const fail = (message: string): ToolOutcome => ({ text: message, isError: true });

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item !== "")
    : [];

const listFleet = async (context: ToolContext) =>
  others(
    parseAgentList(await context.runner(listArgv(), 10_000, context.signal)),
    context.selfPane,
  );

const status = async (context: ToolContext): Promise<ToolOutcome> => {
  const agents = await listFleet(context);
  const memory = await context.store.read();
  return ok(agents.map((agent) => ({ ...agent, watched: agent.pane in memory.watched })));
};

const wait = async (input: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> => {
  const panes = strings(input.panes);
  if (panes.length === 0) return fail("panes must list at least one pane id");
  const until = strings(input.until) as FleetStatus[];
  const timeoutMs = typeof input.timeoutMs === "number" ? input.timeoutMs : 60_000;

  for (const pane of panes) context.awaiting.add(pane);
  try {
    const outcome = await waitAny(
      context.runner,
      panes,
      until.length > 0 ? until : SETTLED,
      timeoutMs,
      context.signal,
    );
    if (outcome.kind === "failed") return fail(outcome.error);
    if (outcome.kind === "timeout") return ok({ timedOut: true, panes });
    await context.store.update((memory) => unwatch(memory, [outcome.agent.pane]));
    return ok({ timedOut: false, settled: outcome.agent });
  } finally {
    for (const pane of panes) context.awaiting.delete(pane);
  }
};

const read = async (input: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> => {
  const pane = typeof input.pane === "string" ? input.pane : "";
  if (pane === "") return fail("pane is required");
  const lines = Math.max(1, Math.min(typeof input.lines === "number" ? input.lines : 80, 400));
  const output = await context.runner(readArgv(pane, lines), 15_000, context.signal);
  assertOk(output);
  return { text: output.stdout, isError: false };
};

const send = async (input: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> => {
  const pane = typeof input.pane === "string" ? input.pane : "";
  const text = typeof input.text === "string" ? input.text : "";
  if (pane === "" || text === "") return fail("pane and text are required");
  const before = (await listFleet(context)).find((agent) => agent.pane === pane);
  if (before === undefined)
    return fail(`${pane} is not an agent pane; call fleet_status for the current list`);

  assertOk(await context.runner(promptArgv(pane, text), 30_000, context.signal));
  const watch = input.watch !== false;
  await context.store.update((memory) => {
    const dispatched = recordDispatch(memory, pane);
    return watch
      ? { ...dispatched, watched: { ...dispatched.watched, [pane]: before.seq } }
      : dispatched;
  });
  return ok({ sent: true, pane, watched: watch });
};

const watchPanes = async (
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolOutcome> => {
  const panes = strings(input.panes);
  if (panes.length === 0) return fail("panes must list at least one pane id");
  if (input.unwatch === true) {
    await context.store.update((memory) => unwatch(memory, panes));
    return ok({ unwatched: panes });
  }

  const agents = await listFleet(context);
  const missing = panes.filter((pane) => !agents.some((agent) => agent.pane === pane));
  if (missing.length > 0)
    return fail(`not agent panes: ${missing.join(", ")}; call fleet_status for the current list`);
  await context.store.update((memory) => ({
    ...memory,
    watched: {
      ...memory.watched,
      ...Object.fromEntries(
        panes.map((pane) => [
          pane,
          memory.watched[pane] ?? agents.find((agent) => agent.pane === pane)?.seq ?? 0,
        ]),
      ),
    },
  }));
  return ok({
    watching: agents
      .filter((agent) => panes.includes(agent.pane))
      .map((agent) => ({ pane: agent.pane, name: agent.name, status: agent.status })),
    note: "A pane already idle or done fires only after its next state change; use fleet_wait or fleet_read if it may have finished already.",
  });
};

/**
 * Runs one fleet tool call.
 *
 * @param name the tool
 * @param input the model's arguments
 * @param context the harness's runner, store, and abort signal
 * @returns the text the model reads
 */
export const executeFleetTool = async (
  name: FleetToolName,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolOutcome> => {
  try {
    switch (name) {
      case "fleet_status":
        return await status(context);
      case "fleet_wait":
        return await wait(input, context);
      case "fleet_read":
        return await read(input, context);
      case "fleet_send":
        return await send(input, context);
      case "fleet_watch":
        return await watchPanes(input, context);
    }
  } catch (error) {
    if (error instanceof HerdrFailure && error.code === "agent_blocked") {
      return fail(
        "agent_blocked: the agent is waiting on a question. Read it with fleet_read and answer that instead.",
      );
    }
    return fail(error instanceof Error ? error.message : String(error));
  }
};
