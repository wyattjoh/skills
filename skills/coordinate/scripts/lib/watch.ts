import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { Effect, Option, Result } from "effect";
import { readDocument } from "./backlog-doc.ts";
import { isAnswer } from "./backlog-store/ops.ts";
import { isDiscussion } from "./backlog-store/schema.ts";
import type { Item } from "./backlog-store/schema.ts";
import type { Config } from "./config.ts";
import { checkDomainName, L, Refused, sessionOf } from "./fleet.ts";
import * as hc from "./herdr.ts";
import { repoPullRequests } from "./prs.ts";
import { domainRepos } from "./status.ts";
import { acquireLock, releaseLock, releaseLockSync } from "./watch-lock.ts";
import type { WatchLogEntry, WatchView } from "./watch-terminal.ts";
import {
  capacityItemEligible,
  pruneCapacityWaits,
  readCapacityQueue,
  type CapacityWait,
} from "./capacity-queue.ts";
import { liveDelegateCount, machineDelegateBudget } from "./delegate-capacity.ts";
import { resolveEffectiveHarnessPolicy } from "./harness-policy.ts";

/**
 * What the watcher remembers about one delegate terminal.
 */
export type SeenDelegate = { name: string; status: string | undefined; turn: number };

/**
 * What the watcher remembers about one pull request.
 */
export type SeenPr = { state: string; checks: string; review: string; url: string };

/** A reminder schedule belongs to one uninterrupted delegate state and turn. */
export type IdleReminder = {
  status: string;
  turn: number;
  since: number;
  next: number;
  interval: number;
};

/** One pending event with its stable delivery identifier. */
export type WatchEvent = { id: string; line: string };

/** The watcher's last committed snapshot, separate from its staged update. */
export type WatchSnapshot = {
  delegates: Record<string, SeenDelegate>;
  prs: Record<string, SeenPr>;
  /**
   * Due events already fired, keyed `<item id> <date>`.
   */
  due: string[];
  /**
   * Answers already fired, keyed `<item id> <date> #<ordinal> <decision text>`. Null until the first read of
   * the document seeds it, so arming (or re-arming on a state file from before answers fired) never
   * floods with answers recorded earlier.
   */
  answered: string[] | null;
  /**
   * Discussion requests already fired, keyed like answers.
   */
  discussed: string[] | null;
  idle: Record<string, IdleReminder>;
  capacity: Record<string, { order: number; ready: boolean }>;
  /** Last effective policy signature, or its current read error. */
  harnessPolicy: string | undefined;
};

/** The watcher's committed snapshot, pending events, and recovery point. */
export type WatchState = WatchSnapshot & {
  outbox: WatchEvent[];
  nextEventId: number;
  staged: WatchSnapshot | undefined;
};

/**
 * An empty state.
 */
export const emptyState = (): WatchState => ({
  delegates: {},
  prs: {},
  due: [],
  answered: null,
  discussed: null,
  idle: {},
  capacity: {},
  harnessPolicy: undefined,
  outbox: [],
  nextEventId: 1,
  staged: undefined,
});

/**
 * Lines for delegate changes between two snapshots. A delegate that settles (or takes another settled
 * turn) fires; so do blocked, errored and gone ones.
 * @param previous Last snapshot.
 * @param next Current snapshot.
 * @returns Event lines.
 */
export const delegateEvents = (
  previous: Readonly<Record<string, SeenDelegate>>,
  next: Readonly<Record<string, SeenDelegate>>,
): string[] => {
  const lines: string[] = [];
  for (const [address, now] of Object.entries(next)) {
    const before = previous[address];
    const changed =
      before === undefined || before.status !== now.status || before.turn !== now.turn;
    if (!changed) continue;
    if (now.status === "blocked")
      lines.push(
        `blocked ${now.name} (${address}): a dialog or question; read it with hc read ${address}`,
      );
    else if (now.status === "error")
      lines.push(`error ${now.name} (${address}): read its terminal`);
    else if (
      (now.status === "idle" || now.status === "done") &&
      before !== undefined &&
      (before.status === "working" || before.turn !== now.turn)
    )
      lines.push(`settled ${now.name} (${address}): read its REPORT.md, verify, then report`);
  }
  for (const [address, before] of Object.entries(previous))
    if (next[address] === undefined)
      lines.push(
        `gone ${before.name} (${address}): resume with coordinate resume ${before.name}, or record it ended`,
      );
  return lines;
};

/** Calculate idle reminders with an injected clock. */
export const idleEvents = (
  delegates: Readonly<Record<string, SeenDelegate>>,
  details: Readonly<Record<string, { session: string; statusMs: number | undefined }>>,
  items: readonly Item[],
  reminders: Record<string, IdleReminder>,
  now: number,
): string[] => {
  const lines: string[] = [];
  for (const address of Object.keys(reminders))
    if (delegates[address] === undefined) delete reminders[address];
  for (const [address, delegate] of Object.entries(delegates)) {
    if (delegate.status !== "idle" && delegate.status !== "done" && delegate.status !== "blocked") {
      delete reminders[address];
      continue;
    }
    const detail = details[address];
    const associated = detail?.session
      ? items.filter((item) => item.delegates.some((ref) => ref.session === detail.session))
      : [];
    const suppressed =
      associated.length > 0 &&
      associated.every(
        (item) => item.status === "parked" || (item.status === "waiting-user" && item.ask !== null),
      );
    if (suppressed) {
      delete reminders[address];
      continue;
    }
    let reminder = reminders[address];
    if (!reminder || reminder.status !== delegate.status || reminder.turn !== delegate.turn) {
      reminder = {
        status: delegate.status,
        turn: delegate.turn,
        since: detail?.statusMs ?? now,
        next: now,
        interval: 15,
      };
      reminders[address] = reminder;
    }
    if (now < reminder.next) continue;
    const minutes = Math.max(0, now - reminder.since) / 60_000;
    const age =
      minutes < 60
        ? `${Math.round(minutes)}m`
        : minutes < 60 * 48
          ? `${Math.round(minutes / 60)}h`
          : `${Math.round(minutes / 1440)}d`;
    const next =
      delegate.status === "blocked"
        ? `read its terminal with hc read ${address}`
        : "read its REPORT.md and give it a next step or end it";
    lines.push(`idle ${delegate.name} (${address}) ${age}: ${next}`);
    reminder.next = now + reminder.interval * 60_000;
    reminder.interval = Math.min(reminder.interval * 2, 60);
  }
  return lines;
};

/**
 * Lines for PR changes. Only PRs seen before fire, so arming never floods with history.
 * @param previous Last snapshot.
 * @param next Current snapshot.
 * @returns Event lines.
 */
export const prEvents = (
  previous: Readonly<Record<string, SeenPr>>,
  next: Readonly<Record<string, SeenPr>>,
): string[] => {
  const lines: string[] = [];
  for (const [key, now] of Object.entries(next)) {
    const before = previous[key];
    if (before === undefined) continue;
    if (before.state === "open" && now.state === "merged")
      lines.push(`pr ${key} merged: sweep its worktree ${now.url}`);
    else if (before.state === "open" && now.state === "closed")
      lines.push(`pr ${key} closed unmerged ${now.url}`);
    if (now.state !== "open") continue;
    if (now.checks === "fail" && before.checks !== "fail")
      lines.push(`pr ${key} checks failed ${now.url}`);
    if (now.review === "changes_requested" && before.review !== "changes_requested")
      lines.push(`pr ${key} changes requested ${now.url}`);
    if (now.review === "approved" && before.review !== "approved")
      lines.push(`pr ${key} approved ${now.url}`);
  }
  return lines;
};

/**
 * A one-line count of the fleet, printed beside a settle event.
 * @param delegates Current snapshot.
 * @returns The status beat.
 */
export const statusBeat = (delegates: Readonly<Record<string, SeenDelegate>>): string => {
  const counts = new Map<string, number>();
  for (const delegate of Object.values(delegates))
    counts.set(
      delegate.status ?? "no status",
      (counts.get(delegate.status ?? "no status") ?? 0) + 1,
    );
  const parts = [...counts]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([status, count]) => `${count} ${status}`);
  return `status: ${parts.length === 0 ? "no live delegates" : parts.join(", ")}; give the user a short status in your next reply`;
};

const CLOSED: ReadonlySet<Item["status"]> = new Set(["done", "dismissed"]);

/**
 * Produce one coalesced wake for the oldest eligible queued launch per target machine.
 * @param entries Current capacity queue entries.
 * @param observations Live and budget counts by machine; missing entries mean the machine could not be checked.
 * @param previous Previously committed readiness state.
 * @returns Wake lines and the next durable readiness snapshot.
 */
export const capacityWakeEvents = (
  entries: readonly CapacityWait[],
  observations: Readonly<Record<string, { live: number; budget: number } | undefined>>,
  previous: Readonly<Record<string, { order: number; ready: boolean }>>,
): { lines: string[]; capacity: Record<string, { order: number; ready: boolean }> } => {
  const oldestByMachine = new Map<string, CapacityWait>();
  for (const entry of entries.toSorted((left, right) => left.order - right.order))
    if (!oldestByMachine.has(entry.machine)) oldestByMachine.set(entry.machine, entry);
  const capacity: Record<string, { order: number; ready: boolean }> = {};
  const lines: string[] = [];
  for (const [machine, entry] of oldestByMachine) {
    const observed = observations[machine];
    if (observed === undefined) {
      if (previous[machine] !== undefined) capacity[machine] = previous[machine];
      continue;
    }
    const ready = observed.live < observed.budget;
    capacity[machine] = { order: entry.order, ready };
    if (ready && (previous[machine]?.order !== entry.order || previous[machine]?.ready !== true))
      lines.push(
        `capacity available on ${machine}: retry queued item ${entry.item} (order ${entry.order}) with coordinate delegate --retry-queued; the regular budget gate still applies`,
      );
  }
  return { lines, capacity };
};

/**
 * Due events for open items due on or before `today`, oldest first, skipping keys already fired.
 * The key is the item id plus its date, so a title edit never re-fires and a new date fires once.
 * Fired keys are only ever added, so a date that fired once never fires again.
 */
const dueEvents = (items: readonly Item[], today: string, fired: readonly string[]) => {
  const due = items
    .filter((item) => !CLOSED.has(item.status) && item.due !== null && item.due <= today)
    .toSorted((a, b) => (a.due ?? "").localeCompare(b.due ?? ""));
  const seen = new Set(fired);
  const fresh = due.filter((item) => !seen.has(`${item.id} ${item.due}`));
  return {
    lines: fresh.map((item) => `due ${item.due}: ${item.id} ${item.title}`),
    fired: [...fired, ...fresh.map((item) => `${item.id} ${item.due}`)],
  };
};

/**
 * Answered events for answers recorded since the last read, in document order, skipping keys already
 * fired. Any caller's answer counts: the panel's and the CLI's both append an `answerDecision`.
 * With no fired keys yet (null), every current answer is recorded as fired and none fires.
 */
const answeredEvents = (items: readonly Item[], fired: readonly string[] | null) => {
  const answers = items.flatMap((item) => {
    // Decisions are dated by day, so the same answer twice in a day needs its ordinal to stay distinct.
    const seen = new Map<string, number>();
    return item.decided
      .filter((decision) => isAnswer(decision.text))
      .map((decision) => {
        const base = `${item.id} ${decision.at} ${decision.text}`;
        const ordinal = (seen.get(base) ?? 0) + 1;
        seen.set(base, ordinal);
        return {
          key: `${item.id} ${decision.at} #${ordinal} ${decision.text}`,
          line: `answered ${item.id} ${item.title}: ${decision.text}`,
        };
      });
  });
  if (fired === null) return { lines: [], fired: answers.map((answer) => answer.key) };
  const seen = new Set(fired);
  const fresh = answers.filter((answer) => !seen.has(answer.key));
  return {
    lines: fresh.map((answer) => answer.line),
    fired: [...fired, ...fresh.map((answer) => answer.key)],
  };
};

/**
 * Discussion events for requests recorded since the last read, in document order, skipping keys
 * already fired. A null snapshot seeds existing events without notifying on arm.
 */
const discussionEvents = (items: readonly Item[], fired: readonly string[] | null) => {
  const discussions = items.flatMap((item) => {
    const seen = new Map<string, number>();
    return item.decided
      .filter((decision) => isDiscussion(decision.text))
      .map((decision) => {
        const base = `${item.id} ${decision.at} ${decision.text}`;
        const ordinal = (seen.get(base) ?? 0) + 1;
        seen.set(base, ordinal);
        return {
          key: `${item.id} ${decision.at} #${ordinal} ${decision.text}`,
          line: `discuss ${item.id} ${item.title}: ${decision.text.slice("Discuss ".length)}`,
        };
      });
  });
  if (fired === null) return { lines: [], fired: discussions.map((entry) => entry.key) };
  const seen = new Set(fired);
  const fresh = discussions.filter((entry) => !seen.has(entry.key));
  return {
    lines: fresh.map((entry) => entry.line),
    fired: [...fired, ...fresh.map((entry) => entry.key)],
  };
};

/**
 * The watcher's snapshot for a domain.
 * @param stateDir State dir.
 * @param domain Domain.
 * @returns Path.
 */
export const statePath = (stateDir: string, domain: string): string =>
  join(stateDir, "watch", `${domain}.json`);

const readState = (path: string) =>
  Effect.promise(async (): Promise<WatchState | undefined> => {
    if (!existsSync(path)) return undefined;
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<WatchState>;
      return {
        delegates: parsed.delegates ?? {},
        prs: parsed.prs ?? {},
        due: parsed.due ?? [],
        answered: parsed.answered ?? null,
        discussed: parsed.discussed ?? null,
        idle: parsed.idle ?? {},
        capacity: parsed.capacity ?? {},
        harnessPolicy: parsed.harnessPolicy,
        outbox: parsed.outbox ?? [],
        nextEventId: parsed.nextEventId ?? 1,
        staged: parsed.staged,
      };
    } catch {
      return undefined;
    }
  });

const writeState = (path: string, state: WatchState) =>
  Effect.promise(async () => {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let created = false;
    let renamed = false;
    try {
      const file = await open(temporary, "wx", 0o600);
      created = true;
      try {
        await file.writeFile(`${JSON.stringify(state, null, 1)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
      renamed = true;
      const parent = await open(directory, "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } finally {
      if (created && !renamed) await unlink(temporary).catch(() => undefined);
    }
  });

/**
 * One delegate snapshot: two `hc ls --label` calls (domain members, minus coordinators), no `hc get` per terminal.
 * @param domain Domain.
 * @returns Snapshot by address.
 */
export const snapshotDelegates = Effect.fn("snapshotDelegates")(function* (domain: string) {
  const [members, coordinators] = yield* Effect.all([
    hc.list([`${L.domain}=${domain}`]),
    hc.list([`${L.role}=coordinator`]),
  ]);
  const skip = new Set(coordinators.map((terminal) => terminal.address));
  const snapshot: Record<string, SeenDelegate> = {};
  for (const terminal of members)
    if (terminal.live && !skip.has(terminal.address))
      snapshot[terminal.address] = {
        name: terminal.name ?? terminal.address,
        status: terminal.status,
        turn: terminal.turn,
      };
  return snapshot;
});

/**
 * One PR snapshot across the domain's repos. A forge that cannot be read keeps its last state.
 * @param config Config.
 * @param repos Main checkouts.
 * @param previous Last snapshot.
 * @returns Snapshot by `host/slug#n`, and repos that could not be read.
 */
export const snapshotPrs = Effect.fn("snapshotPrs")(function* (
  config: Config,
  repos: readonly string[],
  previous: Readonly<Record<string, SeenPr>>,
) {
  const snapshot: Record<string, SeenPr> = {};
  const blind: string[] = [];
  const read = new Set<string>();
  for (const repo of repos) {
    const result = yield* repoPullRequests(config, repo, true);
    if (!result.ok) {
      blind.push(`${repo}: ${result.error}`);
      continue;
    }
    read.add(`${result.ref.host}/${result.ref.slug}`);
    for (const pr of result.prs) {
      const key = `${result.ref.host}/${result.ref.slug}#${pr.number}`;
      if (pr.state === "open" || previous[key] !== undefined)
        snapshot[key] = { state: pr.state, checks: pr.checks, review: pr.review, url: pr.url };
    }
  }
  // A repo that could not be read this time keeps its last state, so its PRs neither vanish nor fire.
  for (const [key, seen] of Object.entries(previous))
    if (!read.has(key.slice(0, key.lastIndexOf("#"))) && snapshot[key] === undefined)
      snapshot[key] = seen;
  return { snapshot, blind };
});

/**
 * Options for one watch loop.
 */
export type WatchOptions = {
  domain: string;
  intervalMs: number;
  forgeIntervalMs: number;
  maxMs: number;
  owner: string | undefined;
  replace: boolean;
  deliver: boolean;
  today: () => string;
  now?: () => number;
  /**
   * Keep polling and emit every event batch until stopped or the owner is gone.
   */
  follow: boolean;
  /**
   * Write one already-identified outbox event to stdout. A rejected promise leaves it pending.
   */
  emit: (line: string) => void | Promise<void>;
  /**
   * Best-effort read-only view, invoked only for delivery watchers.
   * @param view Current watcher snapshot.
   */
  render?: (view: WatchView) => void;
};

const eventLine = (event: WatchEvent): string => `${event.line} [e${event.id}]`;
// Keep a watcher alive through a Herdr restart without retrying more than once per minute.
const MAX_RETRY_DELAY_MS = 60_000;

/**
 * Watch one domain, durably queuing each event before committing its snapshot. Events are removed
 * only after stdout accepts them or Herdr confirms a send.
 * @param config Config.
 * @param options Watch options.
 * @returns Control lines such as `alive`, `blind`, or `owner gone`.
 */
export const watch = Effect.fn("watch")(function* (config: Config, options: WatchOptions) {
  yield* checkDomainName(options.domain);
  if (options.deliver && !options.owner)
    return yield* new Refused({ message: "watch --deliver requires an explicit --owner address" });
  if (options.deliver) {
    const owner = yield* hc.get(options.owner ?? "");
    if (
      !owner?.live ||
      owner.labels[L.role] !== "coordinator" ||
      owner.labels[L.domain] !== options.domain
    )
      return yield* new Refused({
        message: `--owner ${options.owner} is not a live coordinator for ${options.domain}`,
      });
  }
  const pid = process.pid;
  let lock = yield* acquireLock(config.stateDir, options.domain, pid);
  if (!lock.ok && options.replace && lock.holder !== undefined) {
    process.kill(lock.holder, "SIGTERM");
    yield* Effect.sleep("1 second");
    lock = yield* acquireLock(config.stateDir, options.domain, pid);
  }
  if (!lock.ok)
    return yield* new Refused({
      message: `a watcher for ${options.domain} already runs (pid ${lock.holder ?? "?"}); pass --replace to take over`,
    });
  const release = releaseLock(config.stateDir, options.domain, pid);
  const onSignal = () => {
    releaseLockSync(config.stateDir, options.domain, pid);
    console.log("stopped");
    process.exit(0);
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  return yield* Effect.gen(function* () {
    const path = statePath(config.stateDir, options.domain);
    const saved = yield* readState(path);
    let state: WatchState = saved ?? emptyState();
    if (state.staged !== undefined) {
      state = { ...state, ...state.staged, staged: undefined };
      yield* writeState(path, state);
    }
    let repos = yield* domainRepos(config, options.domain);
    const clock = options.now ?? Date.now;
    const started = clock();
    let lastForge = Number.NEGATIVE_INFINITY;
    let lastTick: number | undefined;
    let viewOwnerState: WatchView["ownerState"] = "live";
    let lastDelivery = state.outbox.length > 0 ? "pending from outbox" : "not sent yet";
    const log: WatchLogEntry[] = [];
    let failures = 0;
    let failureMessage = "";
    let first = saved === undefined;

    const appendLog = (event: WatchEvent, delivery: string, at: number) => {
      log.push({ at, event, delivery });
      if (log.length > 500) log.splice(0, log.length - 500);
    };

    const renderView = (items: readonly Item[]) => {
      if (!options.deliver || options.render === undefined) return;
      try {
        options.render({
          domain: options.domain,
          owner: options.owner ?? "unknown",
          ownerState: viewOwnerState,
          pid,
          started,
          intervalMs: options.intervalMs,
          forgeIntervalMs: options.forgeIntervalMs,
          lastTick,
          nextForge: Number.isFinite(lastForge) ? lastForge + options.forgeIntervalMs : started,
          nextDue: (lastTick ?? started) + options.intervalMs,
          outboxDepth: state.outbox.length,
          lastDelivery,
          delegates: state.delegates,
          repos,
          prs: state.prs,
          items,
          log: [...log],
        });
      } catch {
        // The terminal view is observational; a renderer failure must never affect delivery.
      }
    };

    renderView([]);

    const deliverPending = () =>
      Effect.gen(function* () {
        if (state.outbox.length === 0) return { sent: true, failure: undefined };
        if (options.deliver) {
          const result = yield* hc
            .send(options.owner ?? "", state.outbox.map(eventLine).join("\n"))
            .pipe(Effect.result);
          if (Result.isFailure(result))
            return {
              sent: false,
              failure: { kind: result.failure.kind, message: result.failure.message },
            };
          state = { ...state, outbox: [] };
          yield* writeState(path, state);
          return { sent: true, failure: undefined };
        }
        for (const event of state.outbox) {
          yield* Effect.promise(async () => {
            await options.emit(eventLine(event));
          });
          state = { ...state, outbox: state.outbox.filter((pending) => pending.id !== event.id) };
          yield* writeState(path, state);
        }
        return { sent: true, failure: undefined };
      });

    const ownerState = () =>
      Effect.gen(function* () {
        if (!options.owner) return "live" as const;
        const result = yield* hc.get(options.owner).pipe(Effect.result);
        if (Result.isFailure(result)) return "unknown" as const;
        return result.success === undefined || !result.success.live
          ? ("gone" as const)
          : ("live" as const);
      });

    for (;;) {
      const snapshot: WatchSnapshot = {
        delegates: state.delegates,
        prs: state.prs,
        due: [...state.due],
        answered: state.answered === null ? null : [...state.answered],
        discussed: state.discussed === null ? null : [...state.discussed],
        idle: Object.fromEntries(
          Object.entries(state.idle).map(([address, reminder]) => [address, { ...reminder }]),
        ),
        capacity: Object.fromEntries(
          Object.entries(state.capacity).map(([machine, ready]) => [machine, { ...ready }]),
        ),
        harnessPolicy: state.harnessPolicy,
      };
      const lines: string[] = [];
      const policy = yield* resolveEffectiveHarnessPolicy(config, options.domain).pipe(
        Effect.result,
      );
      const policySignature = Result.isSuccess(policy)
        ? JSON.stringify({
            enabled: policy.success.selection.enabled,
            default: policy.success.selection.default,
          })
        : `error:${policy.failure.message}`;
      if (snapshot.harnessPolicy !== undefined && snapshot.harnessPolicy !== policySignature) {
        if (Result.isSuccess(policy)) {
          const enabled = policy.success.selection.enabled.join(", ") || "none";
          lines.push(
            `harness policy changed for ${options.domain}: enabled ${enabled}; default ${policy.success.selection.default ?? "none"}`,
          );
        } else {
          lines.push(`harness policy unavailable for ${options.domain}: ${policy.failure.message}`);
        }
      }
      snapshot.harnessPolicy = policySignature;
      const latestRepos = yield* domainRepos(config, options.domain);
      const reposChanged =
        repos.length !== latestRepos.length ||
        repos.some((repo, index) => repo !== latestRepos[index]);
      repos = latestRepos;
      if (reposChanged) lastForge = Number.NEGATIVE_INFINITY;
      const polled = yield* snapshotDelegates(options.domain).pipe(Effect.result);
      if (Result.isFailure(polled)) {
        failures += 1;
        failureMessage = polled.failure.message;
      } else {
        failures = 0;
        failureMessage = "";
        const events = first ? [] : delegateEvents(snapshot.delegates, polled.success);
        if (first)
          for (const [address, current] of Object.entries(polled.success))
            if (current.status === "blocked" || current.status === "error")
              events.push(`${current.status} ${current.name} (${address}): read its terminal`);
        if (events.some((line) => line.startsWith("settled ")))
          events.push(statusBeat(polled.success));
        lines.push(...events);
        snapshot.delegates = polled.success;
      }
      if (clock() - lastForge >= options.forgeIntervalMs) {
        lastForge = clock();
        const prs = yield* snapshotPrs(config, repos, snapshot.prs);
        lines.push(...prEvents(snapshot.prs, prs.snapshot));
        snapshot.prs = prs.snapshot;
      }
      // The local backlog is read every tick, so an answer wakes within one interval, not forge cadence.
      const document = yield* readDocument(config, options.domain).pipe(Effect.option);
      if (Result.isSuccess(polled)) {
        const details: Record<string, { session: string; statusMs: number | undefined }> = {};
        for (const [address, delegate] of Object.entries(polled.success)) {
          if (
            delegate.status !== "idle" &&
            delegate.status !== "done" &&
            delegate.status !== "blocked"
          )
            continue;
          const terminal = yield* hc
            .get(address)
            .pipe(Effect.catch(() => Effect.succeed(undefined)));
          if (terminal)
            details[address] = { session: sessionOf(terminal), statusMs: terminal.statusMs };
        }
        const idle = idleEvents(
          polled.success,
          details,
          Option.isSome(document) ? document.value.backlog.items : [],
          snapshot.idle,
          clock(),
        );
        lines.push(...idle);
        if (idle.length > 0 && !lines.some((line) => line.startsWith("status: ")))
          lines.push(statusBeat(polled.success));
      }
      if (Option.isSome(document)) {
        const due = dueEvents(document.value.backlog.items, options.today(), snapshot.due);
        lines.push(...due.lines);
        snapshot.due = due.fired;
        const answered = answeredEvents(document.value.backlog.items, snapshot.answered);
        lines.push(...answered.lines);
        snapshot.answered = answered.fired;
        const discussed = discussionEvents(document.value.backlog.items, snapshot.discussed);
        lines.push(...discussed.lines);
        snapshot.discussed = discussed.fired;
      }
      const readQueue = yield* readCapacityQueue(config, options.domain).pipe(Effect.result);
      if (Result.isFailure(readQueue)) {
        lines.push(
          `capacity queue unavailable: ${readQueue.failure.message}; capacity was not checked`,
        );
      } else {
        let waits = readQueue.success.entries;
        if (waits.length > 0 && Option.isSome(document)) {
          const keep = new Set(
            document.value.backlog.items
              .filter((item) => !CLOSED.has(item.status))
              .map((item) => item.id),
          );
          const removed = yield* pruneCapacityWaits(config, options.domain, keep);
          lines.push(
            ...removed.map(
              (entry) =>
                `removed queued delegate for ${entry.item}: its backlog item is closed or missing`,
            ),
          );
          if (removed.length > 0)
            waits = (yield* readCapacityQueue(config, options.domain)).entries;
          const eligibleItems = new Set(
            document.value.backlog.items
              .filter((item) => capacityItemEligible(item.status))
              .map((item) => item.id),
          );
          waits = waits.filter((entry) => eligibleItems.has(entry.item));
        }
        const observations: Record<string, { live: number; budget: number } | undefined> = {};
        if (waits.length > 0) {
          const listed = yield* hc.list().pipe(Effect.result);
          if (Result.isFailure(listed)) {
            lines.push(`capacity check unavailable: ${listed.failure.message}`);
          } else {
            const machines = [...new Set(waits.map((entry) => entry.machine))];
            for (const machine of machines) {
              const count = yield* liveDelegateCount(machine, listed.success).pipe(Effect.result);
              if (Result.isFailure(count)) {
                lines.push(`capacity check unavailable for ${machine}: ${count.failure.message}`);
                continue;
              }
              const budget = yield* machineDelegateBudget(config, machine, machine === hostname());
              observations[machine] = { live: count.success, budget: budget.budget };
            }
          }
        }
        const wakes = capacityWakeEvents(waits, observations, snapshot.capacity);
        lines.push(...wakes.lines);
        snapshot.capacity = wakes.capacity;
      }
      first = false;

      const owner = yield* ownerState();
      const ownerGone = owner === "gone";
      const ownerNotice = ownerGone
        ? `owner gone: ${options.owner} no longer runs; nothing will read these events`
        : undefined;
      const events = lines.map((line, index) => ({
        id: (state.nextEventId + index).toString(36),
        line: line.replace(/[\r\n]+/gu, " ").trim(),
      }));
      const newEventIds = new Set(events.map((event) => event.id));
      const staged: WatchState = {
        ...state,
        outbox: [...state.outbox, ...events],
        nextEventId: state.nextEventId + events.length,
        staged: snapshot,
      };
      // The outbox and staged snapshot are one atomic write. Recovery commits the staged snapshot
      // before another poll, so a crash cannot regenerate and enqueue the same snapshot transition.
      yield* writeState(path, staged);
      state = { ...staged, ...snapshot, staged: undefined };
      yield* writeState(path, state);

      const items = Option.isSome(document) ? document.value.backlog.items : [];
      lastTick = clock();
      viewOwnerState = owner;
      if (ownerGone && options.deliver) {
        lastDelivery =
          state.outbox.length > 0 ? "error: owner gone; events remain queued" : "owner gone";
        for (const event of state.outbox) appendLog(event, "error: owner gone", lastTick);
        renderView(items);
        return [];
      }
      if (owner === "unknown" && options.deliver) {
        const retryMs = Math.min(
          options.intervalMs * 2 ** Math.max(0, failures),
          MAX_RETRY_DELAY_MS,
        );
        lastDelivery = `error: owner status unavailable; retry in ${Math.ceil(retryMs / 1000)}s`;
        for (const event of state.outbox) appendLog(event, lastDelivery, lastTick);
        renderView(items);
        yield* Effect.sleep(retryMs);
        continue;
      }
      const pendingEvents = [...state.outbox];
      const pending = pendingEvents.length > 0;
      const delivery = yield* deliverPending();
      if (options.deliver && pending) {
        const retrySeconds = Math.ceil(options.intervalMs / 1000);
        lastDelivery = delivery.sent
          ? `sent to ${options.owner}`
          : `${delivery.failure?.kind === "blocked" ? "refused" : "error"}: ${delivery.failure?.message ?? "delivery failed"}; retry in ${retrySeconds}s`;
        for (const event of pendingEvents) {
          const replayed = newEventIds.has(event.id) ? "" : "replayed from outbox, ";
          appendLog(
            event,
            delivery.sent ? `${replayed}sent to ${options.owner}` : `${replayed}${lastDelivery}`,
            lastTick,
          );
        }
      }
      renderView(items);
      if (options.follow && ownerNotice !== undefined)
        yield* Effect.promise(async () => options.emit(ownerNotice));
      if (ownerGone) return options.follow ? [] : [ownerNotice ?? "owner gone"];
      if (!options.follow && (pending || events.length > 0)) return [];

      if (failures >= 3) {
        const blind = `blind: herdr-core unreadable 3 times: ${failureMessage}; re-arm the watcher`;
        if (!options.deliver) {
          if (options.follow) {
            yield* Effect.promise(async () => options.emit(blind));
            return [];
          }
          return [blind];
        }
        // Stay alive through Herdr restarts, backing off to at most one retry per minute.
        yield* Effect.sleep(Math.min(options.intervalMs * 2 ** (failures - 1), MAX_RETRY_DELAY_MS));
        continue;
      }
      if (options.follow) {
        yield* Effect.sleep(options.intervalMs);
        continue;
      }
      if (clock() - started >= options.maxMs)
        return [`alive: no events in ${Math.round(options.maxMs / 60_000)}m; re-arm the watcher`];
      if (!delivery.sent && pending) return [];
      yield* Effect.sleep(options.intervalMs);
    }
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        process.removeListener("SIGTERM", onSignal);
        process.removeListener("SIGINT", onSignal);
        yield* release;
      }),
    ),
  );
});
