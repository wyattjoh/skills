import { Effect } from "effect";
import { heartbeatStateFile } from "./state-mutation.ts";
import type {
  CoordinatorPhase,
  HerdrCoordinatorInput,
  HerdrWaitAnyInput,
  HerdrWorkerInput,
} from "./contract.ts";
import {
  HerdrWaitError,
  herdrError,
  openSubscription,
  parseJson,
  parseStatus,
  readSnapshot,
  remaining,
  resolveWorkers,
  TERMINAL_STATUSES,
  type Clock,
  type HerdrWorkerSnapshot,
  type LineReader,
  type RawSnapshot,
} from "./herdr-protocol.ts";

export { HerdrWaitError, type HerdrWorkerSnapshot } from "./herdr-protocol.ts";

/**
 * Exact live Herdr identity required by compatibility recovery.
 */
export type HerdrWorkerInspectionInput = {
  socketPath: string;
  timeoutMs: number;
  session: string;
  paneId: string;
};

/**
 * Live Herdr worker identity returned after exact session and pane validation.
 */
export type HerdrWorkerInspection = {
  session: string;
  pane_id: string;
  status: "idle" | "working" | "blocked" | "done" | "unknown";
};

/**
 * Coordinator identity plus optional normalized context observed with workers.
 */
export type HerdrCoordinatorSnapshot = {
  session: string;
  pane_id: string;
  previous_pane_id: string;
  context_used: number | null;
  context_limit: number | null;
  utilization_percent: number | null;
  handoff: "continue" | "deferred" | "required" | "unavailable";
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

const SAFE_HANDOFF_PHASES = new Set<CoordinatorPhase>(["waiting", "scheduling"]);

const resolveCoordinator = (
  coordinator: HerdrCoordinatorInput | undefined,
  snapshot: RawSnapshot,
): HerdrCoordinatorSnapshot | undefined => {
  if (coordinator === undefined) return undefined;
  const named = snapshot.agents.filter(
    (agent) =>
      agent.name === coordinator.session ||
      agent.displayAgent === coordinator.session ||
      agent.title === coordinator.session,
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
  const contextUsed = current.contextUsed;
  const contextLimit = current.contextLimit;
  if (
    contextUsed === undefined ||
    contextLimit === undefined ||
    contextUsed < 0 ||
    contextLimit <= 0
  ) {
    return {
      session: coordinator.session,
      pane_id: current.paneId,
      previous_pane_id: coordinator.paneId,
      context_used: null,
      context_limit: null,
      utilization_percent: null,
      handoff: "unavailable",
    };
  }
  const atThreshold = BigInt(contextUsed) * 5n >= BigInt(contextLimit) * 4n;
  return {
    session: coordinator.session,
    pane_id: current.paneId,
    previous_pane_id: coordinator.paneId,
    context_used: contextUsed,
    context_limit: contextLimit,
    utilization_percent: (contextUsed / contextLimit) * 100,
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
 * Reads one Herdr snapshot and requires an exact live session and pane identity.
 *
 * @param input - Socket, timeout, and exact worker identity to inspect.
 * @returns An Effect containing the current recognized agent status.
 */
export const inspectHerdrWorker = (
  input: HerdrWorkerInspectionInput,
): Effect.Effect<HerdrWorkerInspection, HerdrWaitError> =>
  Effect.tryPromise({
    try: async () => {
      const snapshot = await readSnapshot(input.socketPath, Date.now() + input.timeoutMs, Date.now);
      const named = snapshot.agents.filter(
        (agent) =>
          agent.name === input.session ||
          agent.displayAgent === input.session ||
          agent.title === input.session,
      );
      if (named.length === 0) {
        throw herdrError(
          "herdr.worker_missing",
          `Herdr could not find worker session \`${input.session}\` in its machine-readable snapshot.`,
          "Keep the recorded worker alive and restore its exact session identity before recovery.",
        );
      }
      if (named.length > 1) {
        throw herdrError(
          "herdr.worker_ambiguous",
          `Herdr reported multiple agents named \`${input.session}\`.`,
          "Restore a unique worker session name before recovery.",
        );
      }
      const worker = named[0]!;
      if (worker.paneId !== input.paneId) {
        throw herdrError(
          "herdr.worker_pane_mismatch",
          `Worker \`${input.session}\` is in pane \`${worker.paneId}\`, not recorded pane \`${input.paneId}\`.`,
          "Refresh run state only through an explicit pane-migration operation before recovery.",
        );
      }
      return { session: input.session, pane_id: worker.paneId, status: worker.status };
    },
    catch: (error) =>
      error instanceof HerdrWaitError
        ? error
        : herdrError(
            "herdr.inspect_failed",
            `Could not inspect the existing Herdr worker: ${(error as Error).message}`,
            "Verify the Herdr socket and recorded worker identity before recovery.",
          ),
  });

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
  }).pipe(
    Effect.ensuring(
      input.statePath === undefined ? Effect.void : heartbeatStateFile(input.statePath),
    ),
  );
