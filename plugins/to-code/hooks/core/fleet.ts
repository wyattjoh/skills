import {
  type FleetAgent,
  type FleetStatus,
  HerdrFailure,
  listArgv,
  parseAgentInfo,
  parseAgentList,
  type Runner,
  SETTLED,
  waitArgv,
} from "./herdr.ts";

/**
 * Longest `fleet_wait` allowed. The Claude Code mod's `$.process.run` stops
 * a child at ten minutes, so this stays under it with room for herdr to exit.
 */
export const MAX_WAIT_MS = 570_000;

/**
 * What both adapters remember for one session.
 *
 * `watched` maps a pane to the `state_change_seq` it had when the watch
 * began: the pane fires once it settles at a later seq. `dispatched` and
 * `nudged` drive the stop gate for the current prompt.
 */
export type FleetMemory = {
  watched: Record<string, number>;
  dispatched: string[];
  nudged: boolean;
};

/**
 * A fresh session's memory.
 */
export const EMPTY_MEMORY: FleetMemory = { watched: {}, dispatched: [], nudged: false };

/**
 * Read-modify-write access to the session's memory, backed by `$.state` in
 * the Claude Code mod and a plain variable in the pi extension.
 */
export type FleetStore = {
  read: () => Promise<FleetMemory>;
  update: (fn: (memory: FleetMemory) => FleetMemory) => Promise<void>;
};

/**
 * Creates a store held in a closure.
 *
 * @param initial the starting memory
 * @returns the store
 */
export const memoryStore = (initial: FleetMemory = EMPTY_MEMORY): FleetStore => {
  let memory = initial;

  return {
    read: async () => memory,
    update: async (fn) => {
      memory = fn(memory);
    },
  };
};

/**
 * A watched pane that settled or disappeared.
 */
export type WakeEvent = {
  pane: string;
  name: string;
  status: FleetStatus | "gone";
};

/**
 * What one watcher tick found.
 */
export type TickResult = {
  agents: FleetAgent[];
  events: WakeEvent[];
};

/**
 * Drops the caller's own pane from a listing.
 *
 * @param agents every agent pane
 * @param selfPane the caller's pane id, when it runs inside herdr
 * @returns the other panes
 */
export const others = (agents: readonly FleetAgent[], selfPane: string | undefined): FleetAgent[] =>
  agents.filter((agent) => agent.pane !== selfPane);

/**
 * Finds the watched panes that settled since their watch began.
 *
 * @param agents the current listing
 * @param watched pane to baseline seq
 * @param awaiting panes an in-flight `fleet_wait` already covers
 * @returns one event per pane to report
 */
export const settledEvents = (
  agents: readonly FleetAgent[],
  watched: Readonly<Record<string, number>>,
  awaiting: ReadonlySet<string>,
): WakeEvent[] =>
  Object.entries(watched).flatMap(([pane, baseline]): WakeEvent[] => {
    if (awaiting.has(pane)) return [];
    const agent = agents.find((one) => one.pane === pane);
    if (agent === undefined) return [{ pane, name: pane, status: "gone" }];
    if (agent.seq <= baseline || !SETTLED.includes(agent.status)) return [];
    return [{ pane, name: agent.name, status: agent.status }];
  });

/**
 * Removes panes from the watch set.
 *
 * @param memory the session's memory
 * @param panes the panes to drop
 * @returns the updated memory
 */
export const unwatch = (memory: FleetMemory, panes: readonly string[]): FleetMemory => ({
  ...memory,
  watched: Object.fromEntries(
    Object.entries(memory.watched).filter(([pane]) => !panes.includes(pane)),
  ),
});

/**
 * Runs one watcher pass: lists the fleet, reports watched panes that settled,
 * and forgets them so each watch fires once.
 *
 * @param runner the harness's process runner
 * @param store the session's memory
 * @param awaiting panes an in-flight `fleet_wait` already covers
 * @param selfPane the caller's pane id
 * @returns the listing and the events to deliver
 */
export const tick = async (
  runner: Runner,
  store: FleetStore,
  awaiting: ReadonlySet<string>,
  selfPane: string | undefined,
): Promise<TickResult> => {
  const agents = others(parseAgentList(await runner(listArgv(), 10_000, undefined)), selfPane);
  const memory = await store.read();
  const events = settledEvents(agents, memory.watched, awaiting);
  if (events.length > 0) {
    await store.update((current) =>
      unwatch(
        current,
        events.map((event) => event.pane),
      ),
    );
  }
  return { agents, events };
};

/**
 * Formats the one-line status summary both harnesses show.
 *
 * @param agents the other panes
 * @param memory the session's memory
 * @returns the summary, or undefined when there is nothing to show
 */
export const summarize = (
  agents: readonly FleetAgent[],
  memory: FleetMemory,
): string | undefined => {
  const watched = Object.keys(memory.watched).length;
  if (agents.length === 0 && watched === 0) return undefined;
  const counts = new Map<FleetStatus, number>();
  for (const agent of agents) counts.set(agent.status, (counts.get(agent.status) ?? 0) + 1);
  const parts = (["working", "blocked", "idle", "done", "unknown"] as const)
    .filter((status) => counts.has(status))
    .map((status) => `${counts.get(status)} ${status}`);
  if (watched > 0) parts.push(`${watched} watched`);
  return `fleet: ${parts.join(", ")}`;
};

/**
 * Formats the message that wakes or steers the session.
 *
 * @param events the panes that settled
 * @returns the message text
 */
export const formatWake = (events: readonly WakeEvent[]): string => {
  const lines = events.map((event) =>
    event.status === "gone"
      ? `- ${event.pane}: the pane is gone (closed or its agent exited)`
      : `- ${event.pane} (${event.name}): ${event.status}`,
  );
  return [
    "[to-code fleet] Watched herdr panes settled:",
    ...lines,
    "Reconcile each one: read its result file or use fleet_read, then continue, answer a blocked agent, or record the outcome.",
  ].join("\n");
};

/**
 * How a `fleet_wait` ended.
 */
export type WaitOutcome =
  | { kind: "settled"; agent: FleetAgent }
  | { kind: "timeout" }
  | { kind: "failed"; error: string };

/**
 * Waits for the first of several panes to reach a state, one herdr child per
 * pane. The children that lose the race are aborted where the runner can
 * abort, and otherwise exit at their own timeout.
 *
 * @param runner the harness's process runner
 * @param panes the panes to wait on
 * @param until the states to match
 * @param timeoutMs how long to wait, capped at MAX_WAIT_MS
 * @param signal aborts the whole wait
 * @returns the first pane to match, a timeout, or a failure
 */
export const waitAny = async (
  runner: Runner,
  panes: readonly string[],
  until: readonly FleetStatus[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<WaitOutcome> => {
  const bounded = Math.max(1_000, Math.min(timeoutMs, MAX_WAIT_MS));
  const losers = new AbortController();
  const onAbort = () => losers.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  const attempts = panes.map(async (pane): Promise<WaitOutcome> => {
    try {
      const output = await runner(waitArgv(pane, until, bounded), bounded + 15_000, losers.signal);
      return { kind: "settled", agent: parseAgentInfo(output) };
    } catch (error) {
      if (error instanceof HerdrFailure && error.code === "timeout") return { kind: "timeout" };
      return {
        kind: "failed",
        error: `${pane}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });

  try {
    const first = await Promise.any(
      attempts.map((attempt) =>
        attempt.then((outcome) => (outcome.kind === "settled" ? outcome : Promise.reject(outcome))),
      ),
    ).catch(async () => {
      const all = await Promise.all(attempts);
      return all.find((outcome) => outcome.kind === "failed") ?? ({ kind: "timeout" } as const);
    });
    return first;
  } finally {
    losers.abort();
    signal?.removeEventListener("abort", onAbort);
  }
};
