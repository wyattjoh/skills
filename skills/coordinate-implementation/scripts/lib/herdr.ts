import { Data, Effect } from "effect";
import { createConnection, type Socket } from "node:net";
import type {
  CliIssue,
  CoordinatorPhase,
  HerdrCoordinatorInput,
  HerdrWaitAnyInput,
  HerdrWorkerInput,
} from "./contract.ts";

const TERMINAL_STATUSES = new Set(["idle", "done", "blocked"]);
const AGENT_STATUSES = new Set(["idle", "working", "blocked", "done", "unknown"]);

/**
 * Refreshed status snapshot for one durable worker runtime.
 */
export type HerdrWorkerSnapshot = {
  runtime_id: string;
  ticket: string;
  session: string;
  pane_id: string;
  previous_pane_id: string;
  status: "idle" | "working" | "blocked" | "done" | "unknown" | "exited";
};

/**
 * Normalized coordinator context observed in the same Herdr snapshot as workers.
 */
export type HerdrCoordinatorSnapshot = {
  session: string;
  pane_id: string;
  previous_pane_id: string;
  context_used: number;
  context_limit: number;
  utilization_percent: number;
  handoff: "continue" | "deferred" | "required";
};

/**
 * Result of waiting for the first meaningful worker or coordinator condition.
 */
export type HerdrWaitAnyResult = {
  reason: "status" | "pane_exited" | "handoff" | "timeout";
  worker: HerdrWorkerSnapshot | null;
  workers: HerdrWorkerSnapshot[];
  coordinator: HerdrCoordinatorSnapshot | undefined;
};

/**
 * Typed Herdr socket, protocol, or event failure.
 */
export class HerdrWaitError extends Data.TaggedError("HerdrWaitError")<{
  issue: CliIssue;
}> {}

const herdrError = (code: string, message: string, remediation: string): HerdrWaitError =>
  new HerdrWaitError({ issue: { code, message, remediation } });

class LineReader {
  readonly socket: Socket;
  private buffer = "";
  private lines: string[] = [];
  private waiters: Array<{
    resolve: (line: string | null) => void;
    reject: (error: HerdrWaitError) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private failure: HerdrWaitError | undefined;
  private intentionalClose = false;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.push(chunk));
    socket.on("error", (error) =>
      this.fail(
        herdrError(
          "herdr.socket_failed",
          `Herdr socket failed: ${error.message}`,
          "Retry with the same workers and bound runtime configuration.",
        ),
      ),
    );
    socket.on("close", () => {
      if (this.intentionalClose) return;
      this.fail(
        herdrError(
          "herdr.subscription_disconnected",
          "Herdr closed the event subscription before a terminal condition or timeout.",
          "Apply the bounded Herdr infrastructure retry for each affected ticket.",
        ),
      );
    });
  }

  private push(chunk: string): void {
    this.buffer += chunk;
    const parts = this.buffer.split("\n");
    this.buffer = parts.pop() ?? "";
    for (const line of parts) {
      if (line.length === 0) continue;
      const waiter = this.waiters.shift();
      if (waiter === undefined) {
        this.lines.push(line);
        continue;
      }
      clearTimeout(waiter.timer);
      waiter.resolve(line);
    }
  }

  private fail(error: HerdrWaitError): void {
    if (this.failure !== undefined) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  takeBuffered(): string[] {
    return this.lines.splice(0);
  }

  nextLine(timeoutMs: number): Promise<string | null> {
    const line = this.lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return new Promise<string | null>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          resolve(null);
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  close(): void {
    this.intentionalClose = true;
    this.socket.destroy();
  }
}

const connect = (path: string, timeoutMs: number): Promise<LineReader> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        herdrError(
          "herdr.connect_timeout",
          "Timed out connecting to the Herdr control socket.",
          "Apply the bounded Herdr infrastructure retry for each affected ticket.",
        ),
      );
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(new LineReader(socket));
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(
        herdrError(
          "herdr.connect_failed",
          `Could not connect to the Herdr control socket: ${error.message}`,
          "Verify HERDR_SOCKET_PATH and apply the bounded Herdr infrastructure retry.",
        ),
      );
    });
  });

const parseJson = (line: string, code: string, subject: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw herdrError(
      code,
      `Herdr returned malformed ${subject} JSON.`,
      "Treat this as a Herdr infrastructure failure and retry with the same worker bindings.",
    );
  }
};

type Clock = () => number;

const remaining = (deadline: number, clock: Clock): number => Math.max(0, deadline - clock());

const openSubscription = async (
  socketPath: string,
  paneIds: string[],
  deadline: number,
  clock: Clock,
): Promise<LineReader> => {
  const connectTimeout = remaining(deadline, clock);
  if (connectTimeout === 0) {
    throw herdrError(
      "herdr.subscribe_timeout",
      "Timed out before opening the Herdr event subscription.",
      "Apply the bounded Herdr infrastructure retry for each affected ticket.",
    );
  }
  const subscriptions: Array<Record<string, unknown>> = paneIds.map((paneId) => ({
    type: "pane.agent_status_changed",
    pane_id: paneId,
    agent_status: null,
  }));
  subscriptions.push({ type: "pane.exited" }, { type: "pane.closed" });
  const request = `${JSON.stringify({
    id: "subscribe",
    method: "events.subscribe",
    params: { subscriptions },
  })}\n`;
  const reader = await connect(socketPath, connectTimeout);
  if (remaining(deadline, clock) === 0) {
    reader.close();
    throw herdrError(
      "herdr.subscribe_timeout",
      "Timed out before writing the Herdr event subscription request.",
      "Apply the bounded Herdr infrastructure retry for each affected ticket.",
    );
  }
  reader.socket.write(request);
  const acknowledgementTimeout = remaining(deadline, clock);
  const line = acknowledgementTimeout === 0 ? null : await reader.nextLine(acknowledgementTimeout);
  if (line === null) {
    reader.close();
    throw herdrError(
      "herdr.subscribe_timeout",
      "Timed out waiting for the Herdr subscription acknowledgement.",
      "Apply the bounded Herdr infrastructure retry for each affected ticket.",
    );
  }
  try {
    const response = parseJson(line, "herdr.subscribe_malformed", "subscription acknowledgement");
    const result = response.result as Record<string, unknown> | undefined;
    if (response.id !== "subscribe" || result?.type !== "subscription_started") {
      throw herdrError(
        "herdr.subscribe_failed",
        "Herdr did not acknowledge the worker event subscription.",
        "Verify the installed Herdr protocol and retry without polling.",
      );
    }
    return reader;
  } catch (error) {
    reader.close();
    throw error;
  }
};

type RawAgent = {
  displayAgent: string | null;
  title: string | null;
  paneId: string;
  status: HerdrWorkerSnapshot["status"];
  contextUsed: number | undefined;
  contextLimit: number | undefined;
};

type RawPane = {
  paneId: string;
  status: HerdrWorkerSnapshot["status"];
};

type RawSnapshot = {
  agents: RawAgent[];
  panes: RawPane[];
};

const parseStatus = (value: unknown): HerdrWorkerSnapshot["status"] | undefined =>
  typeof value === "string" && AGENT_STATUSES.has(value)
    ? (value as HerdrWorkerSnapshot["status"])
    : undefined;

const parseSnapshotResponse = (line: string): RawSnapshot => {
  const response = parseJson(line, "herdr.snapshot_malformed", "snapshot response");
  const result = response.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw herdrError(
      "herdr.snapshot_malformed",
      "Herdr snapshot response has no result object.",
      "Verify the installed Herdr socket schema before retrying.",
    );
  }
  const snapshot = (result as Record<string, unknown>).snapshot;
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    throw herdrError(
      "herdr.snapshot_malformed",
      "Herdr snapshot response has no session snapshot.",
      "Verify the installed Herdr socket schema before retrying.",
    );
  }
  const record = snapshot as Record<string, unknown>;
  if (!Array.isArray(record.agents) || !Array.isArray(record.panes)) {
    throw herdrError(
      "herdr.snapshot_malformed",
      "Herdr session snapshot is missing agents or panes.",
      "Verify the installed Herdr socket schema before retrying.",
    );
  }
  const agents: RawAgent[] = [];
  for (const candidate of record.agents) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
    const agent = candidate as Record<string, unknown>;
    const status = parseStatus(agent.agent_status);
    if (typeof agent.pane_id !== "string" || status === undefined) continue;
    agents.push({
      displayAgent: typeof agent.display_agent === "string" ? agent.display_agent : null,
      title: typeof agent.title === "string" ? agent.title : null,
      paneId: agent.pane_id,
      status,
      contextUsed:
        typeof agent.context_used === "number" && Number.isSafeInteger(agent.context_used)
          ? agent.context_used
          : undefined,
      contextLimit:
        typeof agent.context_limit === "number" && Number.isSafeInteger(agent.context_limit)
          ? agent.context_limit
          : undefined,
    });
  }
  const panes: RawPane[] = [];
  for (const candidate of record.panes) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
    const pane = candidate as Record<string, unknown>;
    const status = parseStatus(pane.agent_status);
    if (typeof pane.pane_id !== "string" || status === undefined) continue;
    panes.push({ paneId: pane.pane_id, status });
  }
  return { agents, panes };
};

const readSnapshot = async (
  socketPath: string,
  deadline: number,
  clock: Clock,
): Promise<RawSnapshot> => {
  const connectTimeout = remaining(deadline, clock);
  if (connectTimeout === 0) {
    throw herdrError(
      "herdr.snapshot_timeout",
      "Timed out before opening a Herdr session snapshot connection.",
      "Apply the bounded Herdr infrastructure retry for each affected ticket.",
    );
  }
  const request = `${JSON.stringify({ id: "snapshot", method: "session.snapshot", params: {} })}\n`;
  const reader = await connect(socketPath, connectTimeout);
  try {
    if (remaining(deadline, clock) === 0) {
      throw herdrError(
        "herdr.snapshot_timeout",
        "Timed out before writing the Herdr session snapshot request.",
        "Apply the bounded Herdr infrastructure retry for each affected ticket.",
      );
    }
    reader.socket.write(request);
    const responseTimeout = remaining(deadline, clock);
    const line = responseTimeout === 0 ? null : await reader.nextLine(responseTimeout);
    if (line === null) {
      throw herdrError(
        "herdr.snapshot_timeout",
        "Timed out waiting for a complete Herdr session snapshot.",
        "Apply the bounded Herdr infrastructure retry for each affected ticket.",
      );
    }
    return parseSnapshotResponse(line);
  } finally {
    reader.close();
  }
};

const resolveWorkers = (
  workers: HerdrWorkerInput[],
  snapshot: RawSnapshot,
): HerdrWorkerSnapshot[] =>
  workers.map((worker) => {
    const named = snapshot.agents.filter(
      (agent) => agent.displayAgent === worker.session || agent.title === worker.session,
    );
    if (named.length > 1) {
      throw herdrError(
        "herdr.worker_ambiguous",
        `Herdr reported multiple agents named \`${worker.session}\`.`,
        "Restore unique worker session names before resuming coordination.",
      );
    }
    const pane = snapshot.panes.find((candidate) => candidate.paneId === worker.paneId);
    const current = named[0];
    return {
      runtime_id: worker.runtimeId,
      ticket: worker.ticket,
      session: worker.session,
      pane_id: current?.paneId ?? pane?.paneId ?? worker.paneId,
      previous_pane_id: worker.paneId,
      status: current?.status ?? pane?.status ?? "exited",
    };
  });

const SAFE_HANDOFF_PHASES = new Set<CoordinatorPhase>(["waiting", "scheduling"]);

const resolveCoordinator = (
  coordinator: HerdrCoordinatorInput | undefined,
  snapshot: RawSnapshot,
): HerdrCoordinatorSnapshot | undefined => {
  if (coordinator === undefined) return undefined;
  const named = snapshot.agents.filter(
    (agent) => agent.displayAgent === coordinator.session || agent.title === coordinator.session,
  );
  if (named.length > 1) {
    throw herdrError(
      "herdr.coordinator_ambiguous",
      `Herdr reported multiple agents named \`${coordinator.session}\`.`,
      "Restore a unique coordinator session name before continuing the run.",
    );
  }
  const current = named[0] ?? snapshot.agents.find((agent) => agent.paneId === coordinator.paneId);
  if (current === undefined) {
    throw herdrError(
      "herdr.coordinator_missing",
      `Herdr could not find coordinator \`${coordinator.session}\` in its machine-readable snapshot.`,
      "Keep the current pane open and repair the coordinator runtime binding before handoff.",
    );
  }
  if (
    current.contextUsed === undefined ||
    current.contextLimit === undefined ||
    current.contextUsed < 0 ||
    current.contextLimit <= 0
  ) {
    throw herdrError(
      "herdr.context_missing",
      `Herdr did not report normalized context_used and context_limit values for coordinator \`${coordinator.session}\`.`,
      "Stop coordination and install a Herdr version that exposes both normalized context fields. Never parse rendered terminal status.",
    );
  }
  const atThreshold = BigInt(current.contextUsed) * 5n >= BigInt(current.contextLimit) * 4n;
  return {
    session: coordinator.session,
    pane_id: current.paneId,
    previous_pane_id: coordinator.paneId,
    context_used: current.contextUsed,
    context_limit: current.contextLimit,
    utilization_percent: (current.contextUsed / current.contextLimit) * 100,
    handoff: atThreshold
      ? SAFE_HANDOFF_PHASES.has(coordinator.phase)
        ? "required"
        : "deferred"
      : "continue",
  };
};

const terminalSnapshot = (workers: HerdrWorkerSnapshot[]): HerdrWorkerSnapshot | undefined =>
  workers.find((worker) => worker.status === "exited" || TERMINAL_STATUSES.has(worker.status));

const parseEvent = (
  line: string,
  workers: HerdrWorkerSnapshot[],
): { reason: "status" | "pane_exited"; worker: HerdrWorkerSnapshot } | undefined => {
  const envelope = parseJson(line, "herdr.event_malformed", "event");
  const data = envelope.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw herdrError(
      "herdr.event_malformed",
      "Herdr event has no data object.",
      "Treat this as a Herdr infrastructure failure and retry with the same worker bindings.",
    );
  }
  const event = envelope.event;
  const record = data as Record<string, unknown>;
  const paneId = typeof record.pane_id === "string" ? record.pane_id : undefined;
  if (paneId === undefined) {
    throw herdrError(
      "herdr.event_malformed",
      "Herdr worker event has no pane identity.",
      "Treat this as a Herdr infrastructure failure and retry with the same worker bindings.",
    );
  }
  const worker = workers.find((candidate) => candidate.pane_id === paneId);
  if (worker === undefined) return undefined;

  if (event === "pane.exited" || event === "pane.closed") {
    return { reason: "pane_exited", worker: { ...worker, pane_id: paneId, status: "exited" } };
  }
  if (event !== "pane.agent_status_changed") return undefined;
  const status = parseStatus(record.agent_status);
  if (status === undefined) {
    throw herdrError(
      "herdr.event_malformed",
      "Herdr status event contains an unsupported agent status.",
      "Verify the installed Herdr socket schema before retrying.",
    );
  }
  if (!TERMINAL_STATUSES.has(status)) return undefined;
  return { reason: "status", worker: { ...worker, pane_id: paneId, status } };
};

const firstBufferedEvent = (
  reader: LineReader,
  workers: HerdrWorkerSnapshot[],
): { reason: "status" | "pane_exited"; worker: HerdrWorkerSnapshot } | undefined => {
  for (const line of reader.takeBuffered()) {
    const event = parseEvent(line, workers);
    if (event !== undefined) return event;
  }
  return undefined;
};

const subscribedPanes = (
  workers: HerdrWorkerSnapshot[] | HerdrWorkerInput[],
  coordinator: HerdrCoordinatorSnapshot | HerdrCoordinatorInput | undefined,
): string[] => [
  ...new Set([
    ...workers.map((worker) => ("pane_id" in worker ? worker.pane_id : worker.paneId)),
    ...(coordinator === undefined
      ? []
      : ["pane_id" in coordinator ? coordinator.pane_id : coordinator.paneId]),
  ]),
];

const wait = async (input: HerdrWaitAnyInput, clock: Clock): Promise<HerdrWaitAnyResult> => {
  const deadline = clock() + input.timeoutMs;
  let subscription = await openSubscription(
    input.socketPath,
    subscribedPanes(input.workers, input.coordinator),
    deadline,
    clock,
  );
  try {
    const initialSnapshot = await readSnapshot(input.socketPath, deadline, clock);
    let workers = resolveWorkers(input.workers, initialSnapshot);
    let coordinator = resolveCoordinator(input.coordinator, initialSnapshot);
    if (coordinator?.handoff === "required") {
      return { reason: "handoff", worker: null, workers, coordinator };
    }
    const terminal = terminalSnapshot(workers);
    if (terminal !== undefined) {
      return {
        reason: terminal.status === "exited" ? "pane_exited" : "status",
        worker: terminal,
        workers,
        coordinator,
      };
    }

    const panesChanged =
      workers.some((worker) => worker.pane_id !== worker.previous_pane_id) ||
      (coordinator !== undefined && coordinator.pane_id !== coordinator.previous_pane_id);
    if (panesChanged) {
      const replacement = await openSubscription(
        input.socketPath,
        subscribedPanes(workers, coordinator),
        deadline,
        clock,
      );
      let replacementTransferred = false;
      try {
        const refreshedSnapshot = await readSnapshot(input.socketPath, deadline, clock);
        const secondSnapshot = resolveWorkers(
          input.workers.map((worker) => ({
            ...worker,
            paneId: workers.find((current) => current.runtime_id === worker.runtimeId)!.pane_id,
          })),
          refreshedSnapshot,
        ).map((worker) => ({
          ...worker,
          previous_pane_id: input.workers.find(
            (original) => original.runtimeId === worker.runtime_id,
          )!.paneId,
        }));
        const secondCoordinator = resolveCoordinator(
          input.coordinator === undefined
            ? undefined
            : { ...input.coordinator, paneId: coordinator!.pane_id },
          refreshedSnapshot,
        );
        const oldEvent = firstBufferedEvent(subscription, workers);
        const newEvent = firstBufferedEvent(replacement, secondSnapshot);
        subscription.close();
        subscription = replacement;
        replacementTransferred = true;
        workers = secondSnapshot;
        coordinator =
          secondCoordinator === undefined
            ? undefined
            : { ...secondCoordinator, previous_pane_id: input.coordinator!.paneId };
        if (coordinator?.handoff === "required") {
          return { reason: "handoff", worker: null, workers, coordinator };
        }
        const event = oldEvent ?? newEvent;
        if (event !== undefined) return { ...event, workers, coordinator };
        const secondTerminal = terminalSnapshot(workers);
        if (secondTerminal !== undefined) {
          return {
            reason: secondTerminal.status === "exited" ? "pane_exited" : "status",
            worker: secondTerminal,
            workers,
            coordinator,
          };
        }
      } finally {
        if (!replacementTransferred) replacement.close();
      }
    }

    const buffered = firstBufferedEvent(subscription, workers);
    if (buffered !== undefined) return { ...buffered, workers, coordinator };

    while (clock() < deadline) {
      const line = await subscription.nextLine(remaining(deadline, clock));
      if (line === null) break;
      const event = parseEvent(line, workers);
      if (event !== undefined) return { ...event, workers, coordinator };
    }

    return { reason: "timeout", worker: null, workers, coordinator };
  } finally {
    subscription.close();
  }
};

/**
 * Subscribes before snapshotting and waits for the first terminal worker condition.
 *
 * @param input - Herdr socket, timeout, and durable active worker identities.
 * @param clock - Time source used to enforce the absolute deadline.
 * @returns An Effect containing the wake reason and a complete worker snapshot.
 */
export const waitAnyWorker = (
  input: HerdrWaitAnyInput,
  clock: Clock = Date.now,
): Effect.Effect<HerdrWaitAnyResult, HerdrWaitError> =>
  Effect.tryPromise({
    try: () => wait(input, clock),
    catch: (error) =>
      error instanceof HerdrWaitError
        ? error
        : herdrError(
            "herdr.wait_failed",
            `Herdr wait-any failed: ${(error as Error).message}`,
            "Apply the bounded Herdr infrastructure retry for each affected ticket.",
          ),
  });
