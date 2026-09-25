import { Effect, Scope } from "effect";
import {
  agentsNamed,
  HerdrWaitError,
  herdrError,
  openSubscription,
  parseJson,
  parseStatus,
  readSnapshot,
  type LineReader,
  type LiveAgentStatus,
  type RawSnapshot,
} from "./herdr-protocol.ts";

/**
 * Observed status of one watched agent, including pane exit.
 */
export type PaneStatus = LiveAgentStatus | "exited";

/**
 * Durable agent identity the hub resolves by session name, falling back to pane id.
 */
export type WatchTarget = {
  session: string;
  paneId: string;
};

/**
 * Status that satisfied a wait plus the agent's current, possibly refreshed, pane id.
 */
export type WatchResult = {
  session: string;
  pane_id: string;
  status: PaneStatus;
};

/**
 * Tunables for the shared subscription.
 */
export type HerdrHubOptions = {
  reconcileMs: number;
  reconnectDelaysMs: number[];
  requestTimeoutMs: number;
};

/**
 * Engine-wide Herdr status hub over one persistent event subscription.
 */
export type HerdrHub = {
  awaitStatus: (
    target: WatchTarget,
    statuses: ReadonlyArray<PaneStatus>,
  ) => Effect.Effect<WatchResult, HerdrWaitError>;
  snapshot: () => Effect.Effect<RawSnapshot, HerdrWaitError>;
};

const DEFAULTS: HerdrHubOptions = {
  reconcileMs: 30_000,
  reconnectDelaysMs: [1_000, 2_000, 4_000],
  requestTimeoutMs: 10_000,
};

type Waiter = {
  target: WatchTarget;
  statuses: Set<PaneStatus>;
  resolve: (result: WatchResult) => void;
  reject: (error: HerdrWaitError) => void;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Resolves a target's current status from one Herdr snapshot, preferring the
 * session name and falling back to the pane id.
 *
 * @param target - Agent identity to resolve.
 * @param snapshot - Herdr snapshot read after the event of interest.
 * @returns The target's status and current pane id.
 */
export const statusFromSnapshot = (target: WatchTarget, snapshot: RawSnapshot): WatchResult => {
  const named = agentsNamed(snapshot, target.session);
  if (named.length > 1) {
    throw herdrError(
      "herdr.worker_ambiguous",
      `Herdr reported multiple agents named \`${target.session}\`.`,
      "Restore unique session names before the engine continues.",
    );
  }
  const agent = named[0];
  if (agent !== undefined) {
    return { session: target.session, pane_id: agent.paneId, status: agent.status };
  }
  const pane = snapshot.panes.find((candidate) => candidate.paneId === target.paneId);
  return {
    session: target.session,
    pane_id: target.paneId,
    status: pane?.status ?? "exited",
  };
};

class Hub {
  private readonly waiters = new Set<Waiter>();
  private reader: LineReader | undefined;
  private subscribed = "";
  private closed = false;
  private dirty = false;
  private wake: (() => void) | undefined;
  private readonly loop: Promise<void>;

  constructor(
    private readonly socketPath: string,
    private readonly options: HerdrHubOptions,
  ) {
    this.loop = this.run();
  }

  add(waiter: Waiter): void {
    this.waiters.add(waiter);
    this.dirty = true;
    this.wake?.();
  }

  remove(waiter: Waiter): void {
    this.waiters.delete(waiter);
  }

  snapshot(): Promise<RawSnapshot> {
    return readSnapshot(this.socketPath, Date.now() + this.options.requestTimeoutMs, Date.now);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.reader?.close();
    this.wake?.();
    await this.loop;
  }

  private settle(waiter: Waiter, result: WatchResult): void {
    if (!waiter.statuses.has(result.status)) {
      waiter.target = { ...waiter.target, paneId: result.pane_id };
      return;
    }
    this.waiters.delete(waiter);
    waiter.resolve(result);
  }

  private panes(): string[] {
    return [...new Set([...this.waiters].map((waiter) => waiter.target.paneId))].toSorted();
  }

  /**
   * Opens the replacement subscription first, then snapshots, so a status
   * change is either in the snapshot or delivered on the new subscription.
   */
  private async resubscribe(): Promise<void> {
    const panes = this.panes();
    const deadline = Date.now() + this.options.requestTimeoutMs;
    const next = await openSubscription(this.socketPath, panes, deadline, Date.now);
    this.reader?.close();
    this.reader = next;
    this.subscribed = panes.join(",");
    await this.reconcile();
  }

  private async reconcile(): Promise<void> {
    if (this.waiters.size === 0) return;
    const snapshot = await this.snapshot();
    for (const waiter of this.waiters) {
      try {
        this.settle(waiter, statusFromSnapshot(waiter.target, snapshot));
      } catch (error) {
        this.waiters.delete(waiter);
        waiter.reject(error as HerdrWaitError);
      }
    }
  }

  private dispatch(line: string): void {
    const envelope = parseJson(line, "herdr.event_malformed", "event");
    const data = envelope.data as Record<string, unknown> | undefined;
    const paneId = typeof data?.pane_id === "string" ? data.pane_id : undefined;
    if (paneId === undefined) return;
    let status: PaneStatus | undefined;
    if (envelope.event === "pane.exited" || envelope.event === "pane.closed") status = "exited";
    if (envelope.event === "pane.agent_status_changed") status = parseStatus(data?.agent_status);
    if (status === undefined) return;
    for (const waiter of this.waiters) {
      if (waiter.target.paneId !== paneId) continue;
      this.settle(waiter, { session: waiter.target.session, pane_id: paneId, status });
    }
  }

  private idle(): Promise<void> {
    return new Promise((resolve) => {
      this.wake = resolve;
    });
  }

  private async run(): Promise<void> {
    let failures = 0;
    let lastReconcile = Date.now();
    while (!this.closed) {
      try {
        if (this.waiters.size === 0) {
          await this.idle();
          continue;
        }
        if (this.reader === undefined || this.panes().join(",") !== this.subscribed) {
          this.dirty = false;
          await this.resubscribe();
          lastReconcile = Date.now();
          continue;
        }
        if (this.dirty) {
          this.dirty = false;
          await this.reconcile();
          lastReconcile = Date.now();
          continue;
        }
        const untilReconcile = Math.max(1, lastReconcile + this.options.reconcileMs - Date.now());
        const woken = this.idle();
        const line = await Promise.race([
          this.reader!.nextLine(untilReconcile),
          woken.then(() => undefined),
        ]);
        this.wake = undefined;
        if (line === undefined) continue;
        if (line === null) {
          await this.reconcile();
          lastReconcile = Date.now();
          continue;
        }
        this.dispatch(line);
        failures = 0;
      } catch (error) {
        if (this.closed) return;
        this.reader?.close();
        this.reader = undefined;
        const delay = this.options.reconnectDelaysMs[failures];
        failures += 1;
        if (delay === undefined) {
          const failure =
            error instanceof HerdrWaitError
              ? error
              : herdrError(
                  "herdr.hub_failed",
                  `Herdr event hub failed: ${String(error)}`,
                  "Apply the bounded Herdr infrastructure retry for each affected ticket.",
                );
          for (const waiter of this.waiters) {
            this.waiters.delete(waiter);
            waiter.reject(failure);
          }
          failures = 0;
          continue;
        }
        await sleep(delay);
      }
    }
  }
}

/**
 * Opens the engine-wide Herdr hub; the scope closes its subscription.
 *
 * @param socketPath - Herdr control socket.
 * @param options - Optional reconcile and reconnect tunables.
 * @returns A scoped Effect containing the hub.
 */
export const makeHerdrHub = (
  socketPath: string,
  options: Partial<HerdrHubOptions> = {},
): Effect.Effect<HerdrHub, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => new Hub(socketPath, { ...DEFAULTS, ...options })),
    (hub) => Effect.promise(() => hub.close()),
  ).pipe(
    Effect.map((hub): HerdrHub => ({
      awaitStatus: (target, statuses) =>
        Effect.callback<WatchResult, HerdrWaitError>((resume) => {
          const waiter: Waiter = {
            target,
            statuses: new Set(statuses),
            resolve: (result) => resume(Effect.succeed(result)),
            reject: (error) => resume(Effect.fail(error)),
          };
          hub.add(waiter);
          return Effect.sync(() => hub.remove(waiter));
        }),
      snapshot: () =>
        Effect.tryPromise({
          try: () => hub.snapshot(),
          catch: (error) =>
            error instanceof HerdrWaitError
              ? error
              : herdrError(
                  "herdr.snapshot_failed",
                  String(error),
                  "Apply the bounded Herdr infrastructure retry.",
                ),
        }),
    })),
  );
