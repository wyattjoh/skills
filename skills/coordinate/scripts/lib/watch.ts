import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect, Option, Result } from "effect";
import { findingAdd, readDocument } from "./backlog-doc.ts";
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
import {
  canonicalMachine,
  liveDelegateCount,
  localMachine,
  machineDelegateBudget,
} from "./delegate-capacity.ts";
import { resolveEffectiveHarnessPolicy } from "./harness-policy.ts";
import { outboxPath } from "./remote-launch.ts";
import { lastLint, LINT_INTERVAL_DAYS, settledWikiPages, wikiCreated } from "./wiki.ts";
import { markSettled, readSession, retroDue, type RetroMarker } from "./sessions.ts";

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

/**
 * One watcher event before it is queued: its kind, identifying attributes, free-text fields (titles,
 * answers, errors) rendered as child elements, and the action text for the coordinator. A field
 * holding a list renders one child element per entry, such as a settled event's `<wiki>` pages.
 */
export type WatchEventData = {
  kind: string;
  attrs: Record<string, string>;
  fields: Record<string, string | readonly string[]>;
  text: string;
};

/**
 * One pending event with its stable delivery identifier.
 */
export type WatchEvent = WatchEventData & { id: string };

const watchEvent = (
  kind: string,
  attrs: Record<string, string>,
  text = "",
  fields: WatchEventData["fields"] = {},
): WatchEventData => ({ kind, attrs, fields, text });

const oneLine = (value: string): string => value.replace(/[\r\n]+/gu, " ").trim();
const escapeText = (value: string): string =>
  oneLine(value).replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
const escapeAttr = (value: string): string => escapeText(value).replace(/"/gu, "&quot;");

/**
 * Render one event as a single-line `<event>` element, escaping every value so free text such as a
 * backlog title cannot close the element or forge another one.
 * @param event Queued event.
 * @returns The element.
 */
export const renderEvent = (event: WatchEvent): string => {
  const attrs = Object.entries({ id: `e${event.id}`, kind: event.kind, ...event.attrs })
    .map(([name, value]) => ` ${name}="${escapeAttr(value)}"`)
    .join("");
  const body = [
    ...Object.entries(event.fields).flatMap(([name, value]) =>
      (typeof value === "string" ? [value] : value).map(
        (entry) => `<${name}>${escapeText(entry)}</${name}>`,
      ),
    ),
    escapeText(event.text),
  ].join("");
  return body === "" ? `<event${attrs}/>` : `<event${attrs}>${body}</event>`;
};

/**
 * A plain one-line summary of an event for the watcher's own terminal view.
 * @param event Queued event.
 * @returns Kind, attribute and field values, then the action text.
 */
export const eventSummary = (event: WatchEvent): string => {
  const head = [event.kind, ...Object.values(event.attrs), ...Object.values(event.fields).flat()]
    .map(oneLine)
    .join(" ");
  const text = oneLine(event.text);
  return text === "" ? head : `${head}: ${text}`;
};

/**
 * Read a persisted outbox entry, wrapping an entry from before events were structured as a
 * `legacy` event whose text is the old line, so a re-armed watcher still delivers it.
 */
const persistedEvent = (entry: WatchEvent | { id: string; line: string }): WatchEvent =>
  "kind" in entry ? entry : { id: entry.id, ...watchEvent("legacy", {}, entry.line) };

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
  /** The last `lint-due` date that fired; absent until the first one. */
  lintDue: string | undefined;
  /** Delegate sessions settled in the domain, each counted once, for every-5th retro sampling. */
  settled: number;
  /**
   * Machines already reported unreachable in their current outage, so each outage fires once.
   */
  unreachable: string[];
  /** How far each remote delegate's outbox has been applied, by session. */
  remoteOutboxes: Record<string, OutboxCursor>;
};

/** The watcher's committed snapshot, pending events, and recovery point. */
export type WatchState = WatchSnapshot & {
  outbox: WatchEvent[];
  /** Finding lines being added this tick; cleared when the tick commits. */
  outboxIntents: OutboxIntent[];
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
  lintDue: undefined,
  settled: 0,
  unreachable: [],
  remoteOutboxes: {},
  outbox: [],
  outboxIntents: [],
  nextEventId: 1,
  staged: undefined,
});

/**
 * Events for delegate changes between two snapshots. A delegate that settles (or takes another settled
 * turn) fires; so do blocked, errored and gone ones.
 * @param previous Last snapshot.
 * @param next Current snapshot.
 * @returns Events.
 */
export const delegateEvents = (
  previous: Readonly<Record<string, SeenDelegate>>,
  next: Readonly<Record<string, SeenDelegate>>,
): WatchEventData[] => {
  const lines: WatchEventData[] = [];
  for (const [address, now] of Object.entries(next)) {
    const before = previous[address];
    const changed =
      before === undefined || before.status !== now.status || before.turn !== now.turn;
    if (!changed) continue;
    if (now.status === "blocked")
      lines.push(
        watchEvent(
          "blocked",
          { delegate: now.name, address },
          `a dialog or question; read it with hc read ${address}`,
        ),
      );
    else if (now.status === "error")
      lines.push(watchEvent("error", { delegate: now.name, address }, "read its terminal"));
    else if (
      (now.status === "idle" || now.status === "done") &&
      before !== undefined &&
      (before.status === "working" || before.turn !== now.turn)
    )
      lines.push(
        watchEvent(
          "settled",
          { delegate: now.name, address },
          "read its REPORT.md, verify, then report",
        ),
      );
  }
  for (const [address, before] of Object.entries(previous))
    if (next[address] === undefined)
      lines.push(
        watchEvent(
          "gone",
          { delegate: before.name, address },
          `resume with coordinate resume ${before.name}, or record it ended`,
        ),
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
): WatchEventData[] => {
  const lines: WatchEventData[] = [];
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
        (item) =>
          item.status === "parked" ||
          item.status === "in-review" ||
          (item.status === "waiting-user" && item.ask !== null),
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
    lines.push(watchEvent("idle", { delegate: delegate.name, address, age }, next));
    reminder.next = now + reminder.interval * 60_000;
    reminder.interval = Math.min(reminder.interval * 2, 60);
  }
  return lines;
};

/**
 * Events for PR changes. Only PRs seen before fire, so arming never floods with history.
 * @param previous Last snapshot.
 * @param next Current snapshot.
 * @returns Events.
 */
export const prEvents = (
  previous: Readonly<Record<string, SeenPr>>,
  next: Readonly<Record<string, SeenPr>>,
): WatchEventData[] => {
  const lines: WatchEventData[] = [];
  for (const [key, now] of Object.entries(next)) {
    const change = (name: string, text = "") =>
      lines.push(watchEvent("pr", { pr: key, change: name, url: now.url }, text));
    const before = previous[key];
    if (before === undefined) continue;
    if (before.state === "open" && now.state === "merged") change("merged", "sweep its worktree");
    else if (before.state === "open" && now.state === "closed") change("closed-unmerged");
    if (now.state !== "open") continue;
    if (now.checks === "fail" && before.checks !== "fail") change("checks-failed");
    if (now.review === "changes_requested" && before.review !== "changes_requested")
      change("changes-requested");
    if (now.review === "approved" && before.review !== "approved") change("approved");
  }
  return lines;
};

/**
 * A one-line count of the fleet, printed beside a settle event.
 * @param delegates Current snapshot.
 * @returns The status beat.
 */
export const statusBeat = (delegates: Readonly<Record<string, SeenDelegate>>): WatchEventData => {
  const counts = new Map<string, number>();
  for (const delegate of Object.values(delegates))
    counts.set(
      delegate.status ?? "no status",
      (counts.get(delegate.status ?? "no status") ?? 0) + 1,
    );
  const parts = [...counts]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([status, count]) => `${count} ${status}`);
  return watchEvent(
    "status",
    { fleet: parts.length === 0 ? "no live delegates" : parts.join(", ") },
    "give the user a short status in your next reply",
  );
};

type SettleMark = { session: string; retro: RetroMarker | undefined };

/**
 * Decide retro sampling for each settled event: count each delegate session once toward the
 * domain's settled counter, and add `retro="due"`, `reason`, `session` and, for a re-retro,
 * `since-turn` when a retro is due. A terminal with no session is left as it is.
 * @param stateDir State dir.
 * @param events Delegate events of this tick.
 * @param delegates Current snapshot, for each settle's turn.
 * @param settled The domain's settled-delegate counter before this tick.
 * @param now Clock, for the marker time.
 * @returns The events, the new counter, and the session writes to make once the events are committed.
 */
const sampleRetros = Effect.fn("sampleRetros")(function* (
  stateDir: string,
  events: readonly WatchEventData[],
  delegates: Readonly<Record<string, SeenDelegate>>,
  settled: number,
  now: number,
) {
  let count = settled;
  const marks: SettleMark[] = [];
  const sampled: WatchEventData[] = [];
  for (const event of events) {
    const address = event.attrs.address ?? "";
    const terminal =
      event.kind === "settled"
        ? yield* hc.get(address).pipe(Effect.catch(() => Effect.succeed(undefined)))
        : undefined;
    const session = terminal ? sessionOf(terminal) : "";
    if (session === "") {
      sampled.push(event);
      continue;
    }
    const state = yield* readSession(stateDir, session);
    if (state.counted !== true) count += 1;
    const due = retroDue(state, state.counted !== true && count % 5 === 0);
    const turn = delegates[address]?.turn ?? 0;
    marks.push({
      session,
      retro:
        due === undefined
          ? undefined
          : { turn, reason: due.reason, at: new Date(now).toISOString() },
    });
    sampled.push(
      due === undefined
        ? event
        : {
            ...event,
            attrs: {
              ...event.attrs,
              retro: "due",
              reason: due.reason,
              session,
              ...(due.since === undefined ? {} : { "since-turn": String(due.since) }),
            },
          },
    );
  }
  return { events: sampled, settled: count, marks };
});

const CLOSED: ReadonlySet<Item["status"]> = new Set(["done", "dismissed"]);

/**
 * Produce one coalesced wake for the oldest eligible queued launch per target machine.
 * @param entries Current capacity queue entries.
 * @param observations Live and budget counts by machine; missing entries mean the machine could not be checked.
 * @param previous Previously committed readiness state.
 * @returns Wake events and the next durable readiness snapshot.
 */
export const capacityWakeEvents = (
  entries: readonly CapacityWait[],
  observations: Readonly<Record<string, { live: number; budget: number } | undefined>>,
  previous: Readonly<Record<string, { order: number; ready: boolean }>>,
): { events: WatchEventData[]; capacity: Record<string, { order: number; ready: boolean }> } => {
  const oldestByMachine = new Map<string, CapacityWait>();
  for (const entry of entries.toSorted((left, right) => left.order - right.order))
    if (!oldestByMachine.has(entry.machine)) oldestByMachine.set(entry.machine, entry);
  const capacity: Record<string, { order: number; ready: boolean }> = {};
  const events: WatchEventData[] = [];
  for (const [machine, entry] of oldestByMachine) {
    const observed = observations[machine];
    if (observed === undefined) {
      if (previous[machine] !== undefined) capacity[machine] = previous[machine];
      continue;
    }
    const ready = observed.live < observed.budget;
    capacity[machine] = { order: entry.order, ready };
    if (ready && (previous[machine]?.order !== entry.order || previous[machine]?.ready !== true))
      events.push(
        watchEvent(
          "capacity",
          { machine, item: entry.item, order: String(entry.order) },
          "retry it with coordinate delegate --retry-queued; the regular budget gate still applies",
        ),
      );
  }
  return { events, capacity };
};

const DAY_MS = 86_400_000;

/**
 * The weekly wiki-hygiene event: once the latest lapsed interval since the last marked lint (or,
 * before any, the wiki's creation) is due on or before `today`, fire it unless that due date, or
 * a later one, already fired. Only the latest lapsed date fires, so weeks missed while no watcher
 * ran do not flood.
 * @param base The last lint date, or the wiki's creation date; undefined when there is no wiki.
 * @param last The last lint date, or undefined when none is recorded.
 * @param today Today, `YYYY-MM-DD`.
 * @param fired The last due date that fired.
 * @returns The events and the fired due date to keep.
 */
const lintDueEvents = (
  base: string | undefined,
  last: string | undefined,
  today: string,
  fired: string | undefined,
) => {
  if (base === undefined) return { events: [], fired };
  const start = Date.parse(`${base}T00:00:00Z`);
  const days = Math.floor((Date.parse(`${today}T00:00:00Z`) - start) / DAY_MS);
  const intervals = Math.floor(days / LINT_INTERVAL_DAYS);
  if (!Number.isFinite(intervals) || intervals < 1) return { events: [], fired };
  const due = new Date(start + intervals * LINT_INTERVAL_DAYS * DAY_MS).toISOString().slice(0, 10);
  if (fired !== undefined && fired >= due) return { events: [], fired };
  return {
    events: [
      watchEvent(
        "lint-due",
        { due, last: last ?? "never" },
        "run wiki lint, close stale findings and look for contradictions between pages, then run wiki lint --mark",
      ),
    ],
    fired: due,
  };
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
    events: fresh.map((item) =>
      watchEvent("due", { item: item.id, due: item.due ?? "" }, "", { title: item.title }),
    ),
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
          event: watchEvent("answered", { item: item.id }, "", {
            title: item.title,
            answer: decision.text,
          }),
        };
      });
  });
  if (fired === null) return { events: [], fired: answers.map((answer) => answer.key) };
  const seen = new Set(fired);
  const fresh = answers.filter((answer) => !seen.has(answer.key));
  return {
    events: fresh.map((answer) => answer.event),
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
          event: watchEvent("discuss", { item: item.id }, "", {
            title: item.title,
            request: decision.text.slice("Discuss ".length),
          }),
        };
      });
  });
  if (fired === null) return { events: [], fired: discussions.map((entry) => entry.key) };
  const seen = new Set(fired);
  const fresh = discussions.filter((entry) => !seen.has(entry.key));
  return {
    events: fresh.map((entry) => entry.event),
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
        lintDue: parsed.lintDue,
        settled: parsed.settled ?? 0,
        unreachable: parsed.unreachable ?? [],
        remoteOutboxes: parsed.remoteOutboxes ?? {},
        outbox: (parsed.outbox ?? []).map(persistedEvent),
        outboxIntents: parsed.outboxIntents ?? [],
        nextEventId: parsed.nextEventId ?? 1,
        staged: parsed.staged,
      };
    } catch {
      return undefined;
    }
  });

/**
 * Show the events the watcher has queued but not yet delivered to the coordinator. Read-only: no
 * lock is taken and nothing is written, so a missing or unreadable state file shows no events.
 * @param config Coordinate config.
 * @param domain Domain name.
 * @param json Print `{ domain, events }` as JSON, each event's kind, attributes, fields and text.
 * @returns Output lines.
 */
export const showOutbox = Effect.fn("showOutbox")(function* (
  config: Config,
  domain: string,
  json: boolean,
) {
  yield* checkDomainName(domain);
  const state = yield* readState(statePath(config.stateDir, domain));
  const events = (state?.outbox ?? []).map(({ id, kind, attrs, fields, text }) => ({
    id,
    kind,
    attrs,
    fields,
    text,
  }));
  if (json) return [JSON.stringify({ domain, events })];
  if (events.length === 0) return [`no undelivered watcher events in ${domain}`];
  return events.map((event) => `e${event.id} ${eventSummary(event)}`);
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
 * The machine a remote terminal address names (`strix/t5`), or undefined for this core's own.
 * @param address Terminal address.
 * @returns Machine name.
 */
const remoteMachine = (address: string): string | undefined => {
  const slash = address.indexOf("/");
  return slash === -1 ? undefined : address.slice(0, slash);
};

/**
 * Carry a remote delegate through its machine's outage: a machine that is not connected lists none
 * of its terminals, so its delegates keep their last state instead of reading as gone. Each machine
 * hosting a delegate fires one `machine-unreachable` event per outage.
 * @param previous Last delegate snapshot.
 * @param listed Delegates listed now.
 * @param down Machines Herdr lists as not connected.
 * @param reported Machines already reported in their current outage.
 * @returns The delegate snapshot, the outage events, and the machines now reported.
 */
export const outageEvents = (
  previous: Readonly<Record<string, SeenDelegate>>,
  listed: Readonly<Record<string, SeenDelegate>>,
  down: readonly string[],
  reported: readonly string[],
) => {
  const delegates: Record<string, SeenDelegate> = { ...listed };
  for (const [address, seen] of Object.entries(previous)) {
    const machine = remoteMachine(address);
    if (machine !== undefined && down.includes(machine) && delegates[address] === undefined)
      delegates[address] = seen;
  }
  const hosting = new Set(Object.keys(delegates).map(remoteMachine));
  const unreachable = down.filter((machine) => hosting.has(machine)).toSorted();
  const events = unreachable
    .filter((machine) => !reported.includes(machine))
    .map((machine) =>
      watchEvent(
        "machine-unreachable",
        { machine },
        "its delegates keep their last state until it reconnects",
      ),
    );
  return { delegates, events, unreachable };
};

/**
 * How far the watcher has applied one remote delegate's outbox: whole lines read, and where the file
 * is. `address` is null once the delegate is gone and its outbox was read a last time; a resume
 * under the same session picks the cursor up again.
 */
export type OutboxCursor = {
  delegate: string;
  machine: string;
  path: string;
  address: string | null;
  read: number;
};

/**
 * A finding line about to be added, saved before the backlog write so a watcher stopped between
 * that write and committing its cursor recognizes the finding instead of adding it again.
 */
export type OutboxIntent = { session: string; line: number; at: string };

type OutboxLine =
  | { type: "notify"; text: string }
  | {
      type: "finding";
      kind: "issue" | "opportunity";
      title: string;
      detail: string | undefined;
      path: string | undefined;
      from: string | undefined;
    }
  | { type: "invalid"; error: string };

const parseOutboxLine = (line: string): OutboxLine => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { type: "invalid", error: "not a JSON object" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { type: "invalid", error: "not a JSON object" };
  const record = value as Record<string, unknown>;
  const text = (key: string): string | undefined => {
    const field = record[key];
    return typeof field === "string" && field.trim() !== "" ? field : undefined;
  };
  if (record.type === "notify") {
    const said = text("text");
    return said === undefined
      ? { type: "invalid", error: "a notify line needs text" }
      : { type: "notify", text: said };
  }
  if (record.type === "finding") {
    if (record.kind !== "issue" && record.kind !== "opportunity")
      return { type: "invalid", error: "a finding line needs kind issue or opportunity" };
    const title = text("title");
    if (title === undefined) return { type: "invalid", error: "a finding line needs a title" };
    return {
      type: "finding",
      kind: record.kind,
      title,
      detail: text("detail"),
      path: text("path"),
      from: text("from"),
    };
  }
  return {
    type: "invalid",
    error: typeof record.type === "string" ? `unknown type ${record.type}` : "a line needs a type",
  };
};

/**
 * Drain each remote delegate's outbox (`OUTBOX.jsonl` in its scratch folder on its machine) into
 * the backlog: a finding line becomes an open finding whose source is the delegate, a notify line
 * becomes a `notify` event, and a line that cannot be applied becomes an `outbox-invalid` event.
 * Only newline-terminated lines count, so a line still being written waits. A machine that is down
 * or a file that cannot be read keeps its cursor for the next tick.
 * @param config Config.
 * @param domain Domain.
 * @param delegates This tick's delegate snapshot.
 * @param down Machines Herdr lists as not connected.
 * @param cursors Cursors by session, from the last committed snapshot.
 * @param intents Finding lines a stopped watcher may already have added.
 * @param now Clock, for each new finding's time.
 * @param recordIntent Save an intent durably before its finding is added.
 * @returns The new cursors and the events to queue with them.
 */
export const drainOutboxes = Effect.fn("drainOutboxes")(function* (
  config: Config,
  domain: string,
  delegates: Readonly<Record<string, SeenDelegate>>,
  down: readonly string[],
  cursors: Readonly<Record<string, OutboxCursor>>,
  intents: readonly OutboxIntent[],
  now: () => number,
  recordIntent: (intent: OutboxIntent) => Effect.Effect<void>,
) {
  const next: Record<string, OutboxCursor> = Object.fromEntries(
    Object.entries(cursors).map(([session, cursor]) => [session, { ...cursor }]),
  );
  const tracked = new Set(Object.values(next).map((cursor) => cursor.address));
  for (const [address, seen] of Object.entries(delegates)) {
    const machine = remoteMachine(address);
    if (machine === undefined || down.includes(machine) || tracked.has(address)) continue;
    const terminal = yield* hc.get(address).pipe(Effect.catch(() => Effect.succeed(undefined)));
    const worktree = terminal?.labels[L.worktree];
    const session = terminal === undefined ? "" : sessionOf(terminal);
    if (worktree === undefined || session === "") continue;
    const known = next[session];
    next[session] = known
      ? { ...known, delegate: seen.name, address }
      : { delegate: seen.name, machine, path: outboxPath(worktree), address, read: 0 };
  }
  const events: WatchEventData[] = [];
  for (const [session, cursor] of Object.entries(next)) {
    if (cursor.address === null || down.includes(cursor.machine)) continue;
    const address = cursor.address;
    const read = yield* hc.readFileOn(cursor.machine, cursor.path).pipe(Effect.result);
    if (Result.isFailure(read)) continue;
    const complete = (read.success ?? "").split("\n").slice(0, -1);
    const attrs = { delegate: cursor.delegate, address };
    // A backlog that cannot be written stops this outbox at that line, to retry next tick.
    let stopped: number | undefined;
    for (let index = cursor.read; index < complete.length; index += 1) {
      const raw = (complete[index] ?? "").trim();
      if (raw === "") continue;
      const line = index + 1;
      const parsed = parseOutboxLine(raw);
      const invalid = (error: string) =>
        watchEvent(
          "outbox-invalid",
          { ...attrs, line: String(line) },
          "skipped; ask the delegate to append a corrected line",
          { error },
        );
      if (parsed.type === "invalid") {
        events.push(invalid(parsed.error));
        continue;
      }
      if (parsed.type === "notify") {
        events.push(watchEvent("notify", attrs, parsed.text));
        continue;
      }
      const source = `delegate:${cursor.delegate}`;
      // Every watcher stopped on this line left an intent; any one of them may have added it.
      const tried = new Set(
        intents
          .filter((entry) => entry.session === session && entry.line === line)
          .map((entry) => entry.at),
      );
      if (tried.size > 0) {
        const document = yield* readDocument(config, domain).pipe(Effect.option);
        const added =
          Option.isSome(document) &&
          document.value.backlog.findings.some(
            (finding) =>
              finding.source === source &&
              finding.createdAt !== undefined &&
              tried.has(finding.createdAt) &&
              finding.title === parsed.title.trim(),
          );
        if (added) continue;
      }
      const at = new Date(now()).toISOString();
      yield* recordIntent({ session, line, at });
      const added = yield* findingAdd(config, domain, {
        kind: parsed.kind,
        title: parsed.title,
        detail: parsed.detail,
        path: parsed.path,
        from: parsed.from,
        source,
        json: false,
        now: at,
      }).pipe(Effect.result);
      if (Result.isSuccess(added)) continue;
      if (added.failure._tag === "BacklogError") {
        stopped = index;
        break;
      }
      events.push(invalid(added.failure.message));
    }
    next[session] = {
      ...cursor,
      read: stopped ?? Math.max(cursor.read, complete.length),
      // A gone delegate's outbox was just read a last time.
      address: delegates[address] === undefined && stopped === undefined ? null : address,
    };
  }
  return { cursors: next, events };
});

/**
 * One delegate snapshot: two `hc ls --label` calls (domain members, minus coordinators), no `hc get` per terminal.
 * Connected machines' terminals come back as `machine/tN`.
 * @param domain Domain.
 * @returns Snapshot by address, and the machines Herdr lists as not connected.
 */
export const snapshotDelegates = Effect.fn("snapshotDelegates")(function* (domain: string) {
  const [listing, coordinators] = yield* Effect.all([
    hc.listing([`${L.domain}=${domain}`]),
    hc.list([`${L.role}=coordinator`]),
  ]);
  const members = listing.terminals;
  const skip = new Set(coordinators.map((terminal) => terminal.address));
  const snapshot: Record<string, SeenDelegate> = {};
  for (const terminal of members)
    if (terminal.live && !skip.has(terminal.address))
      snapshot[terminal.address] = {
        name: terminal.name ?? terminal.address,
        status: terminal.status,
        turn: terminal.turn,
      };
  const down = listing.machines
    .filter((machine) => machine.state !== "connected")
    .map((machine) => machine.name);
  return { delegates: snapshot, down };
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
   * Write one rendered `<event>` element, or a plain control line, to stdout. A rejected promise
   * leaves the event pending.
   */
  emit: (line: string) => void | Promise<void>;
  /**
   * Best-effort read-only view, invoked only for delivery watchers.
   * @param view Current watcher snapshot.
   */
  render?: (view: WatchView) => void;
};

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
    // A wiki's creation date never changes, so it is read from git once, after the wiki exists.
    let wikiStart: string | undefined;

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
            .send(options.owner ?? "", state.outbox.map(renderEvent).join("\n"))
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
            await options.emit(renderEvent(event));
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
        lintDue: state.lintDue,
        settled: state.settled,
        unreachable: [...state.unreachable],
        remoteOutboxes: state.remoteOutboxes,
      };
      const lines: WatchEventData[] = [];
      let marks: SettleMark[] = [];
      const policy = yield* resolveEffectiveHarnessPolicy(config, options.domain).pipe(
        Effect.result,
      );
      const policySignature = Result.isSuccess(policy)
        ? JSON.stringify({
            enabled: policy.success.selection.enabled,
            default: policy.success.selection.default,
            // A global change that a domain replacement keeps re-enabled leaves the effective
            // selection alone, so the re-enable list is part of the signature too. An empty list
            // is left out so signatures saved before it existed still match.
            ...(policy.success.reenabled.length > 0 ? { reenabled: policy.success.reenabled } : {}),
          })
        : `error:${policy.failure.message}`;
      if (snapshot.harnessPolicy !== undefined && snapshot.harnessPolicy !== policySignature) {
        if (Result.isSuccess(policy)) {
          const enabled = policy.success.selection.enabled.join(", ") || "none";
          lines.push(
            watchEvent("harness-policy", {
              domain: options.domain,
              enabled,
              default: policy.success.selection.default ?? "none",
              ...(policy.success.source === "domain"
                ? { reenabled: policy.success.reenabled.join(", ") || "none" }
                : {}),
            }),
          );
        } else {
          lines.push(
            watchEvent("harness-policy-unavailable", { domain: options.domain }, "", {
              error: policy.failure.message,
            }),
          );
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
        const outage = outageEvents(
          snapshot.delegates,
          polled.success.delegates,
          polled.success.down,
          snapshot.unreachable,
        );
        const seen = outage.delegates;
        snapshot.unreachable = outage.unreachable;
        lines.push(...outage.events);
        const events = first ? [] : delegateEvents(snapshot.delegates, seen);
        if (first)
          for (const [address, current] of Object.entries(seen))
            if (current.status === "blocked" || current.status === "error")
              events.push(
                watchEvent(
                  current.status,
                  { delegate: current.name, address },
                  "read its terminal",
                ),
              );
        for (const [index, event] of events.entries()) {
          if (event.kind !== "settled") continue;
          const terminal = yield* hc
            .get(event.attrs.address ?? "")
            .pipe(Effect.catch(() => Effect.succeed(undefined)));
          // A remote delegate's folder is a path on its own machine, not one to read git in here.
          if (!terminal || remoteMachine(terminal.address) !== undefined) continue;
          const pages = yield* settledWikiPages(
            config,
            options.domain,
            terminal.cwd,
            terminal.labels[L.base],
          );
          if (pages.length > 0)
            events[index] = { ...event, fields: { ...event.fields, wiki: pages } };
        }
        const sampled = yield* sampleRetros(
          config.stateDir,
          events,
          seen,
          snapshot.settled,
          clock(),
        );
        snapshot.settled = sampled.settled;
        marks = sampled.marks;
        if (events.some((event) => event.kind === "settled")) sampled.events.push(statusBeat(seen));
        lines.push(...sampled.events);
        snapshot.delegates = seen;
        const drained = yield* drainOutboxes(
          config,
          options.domain,
          seen,
          polled.success.down,
          snapshot.remoteOutboxes,
          state.outboxIntents,
          clock,
          (intent) =>
            Effect.gen(function* () {
              state = { ...state, outboxIntents: [...state.outboxIntents, intent] };
              yield* writeState(path, state);
            }),
        );
        snapshot.remoteOutboxes = drained.cursors;
        lines.push(...drained.events);
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
        // A delegate on a machine that is down is neither asked about nor reminded of; its
        // reminder waits for the machine to reconnect.
        const down = (address: string) =>
          snapshot.unreachable.includes(remoteMachine(address) ?? "");
        const reachable = Object.fromEntries(
          Object.entries(snapshot.delegates).filter(([address]) => !down(address)),
        );
        const waiting = Object.entries(snapshot.idle).filter(([address]) => down(address));
        for (const [address, delegate] of Object.entries(reachable)) {
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
          reachable,
          details,
          Option.isSome(document) ? document.value.backlog.items : [],
          snapshot.idle,
          clock(),
        );
        for (const [address, reminder] of waiting) snapshot.idle[address] = reminder;
        lines.push(...idle);
        if (idle.length > 0 && !lines.some((event) => event.kind === "status"))
          lines.push(statusBeat(snapshot.delegates));
      }
      if (Option.isSome(document)) {
        const due = dueEvents(document.value.backlog.items, options.today(), snapshot.due);
        lines.push(...due.events);
        snapshot.due = due.fired;
        const answered = answeredEvents(document.value.backlog.items, snapshot.answered);
        lines.push(...answered.events);
        snapshot.answered = answered.fired;
        const discussed = discussionEvents(document.value.backlog.items, snapshot.discussed);
        lines.push(...discussed.events);
        snapshot.discussed = discussed.fired;
      }
      // The lint clock is read every tick: `wiki lint --mark` writes it while this watcher runs.
      // No wiki, no lint-due, even when a lint was marked.
      wikiStart ??= yield* wikiCreated(config, options.domain);
      const linted = wikiStart === undefined ? undefined : yield* lastLint(config, options.domain);
      const lint = lintDueEvents(
        wikiStart === undefined ? undefined : (linted ?? wikiStart),
        linted,
        options.today(),
        snapshot.lintDue,
      );
      lines.push(...lint.events);
      snapshot.lintDue = lint.fired;
      const readQueue = yield* readCapacityQueue(config, options.domain).pipe(Effect.result);
      if (Result.isFailure(readQueue)) {
        lines.push(
          watchEvent("capacity-unavailable", {}, "capacity was not checked", {
            error: readQueue.failure.message,
          }),
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
            ...removed.map((entry) =>
              watchEvent(
                "capacity-removed",
                { item: entry.item },
                "its backlog item is closed or missing, so its queued delegate was removed",
              ),
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
        let previous = snapshot.capacity;
        // Without this core's name, waits cannot be keyed: keep the snapshot as it is.
        let keyed = waits.length === 0;
        if (waits.length > 0) {
          const resolved = yield* localMachine().pipe(Effect.result);
          if (Result.isFailure(resolved)) {
            lines.push(
              watchEvent("capacity-unavailable", {}, "", { error: resolved.failure.message }),
            );
          } else {
            const core = resolved.success;
            keyed = true;
            // Entries and snapshots written under `local` or the OS hostname name this core.
            waits = waits.map((entry) => ({
              ...entry,
              machine: canonicalMachine(entry.machine, core),
            }));
            previous = Object.fromEntries(
              Object.entries(previous).map(([machine, seen]) => [
                canonicalMachine(machine, core),
                seen,
              ]),
            );
            const listed = yield* hc.list().pipe(Effect.result);
            if (Result.isFailure(listed)) {
              lines.push(
                watchEvent("capacity-unavailable", {}, "", { error: listed.failure.message }),
              );
            } else {
              const machines = [...new Set(waits.map((entry) => entry.machine))];
              for (const machine of machines) {
                const count = yield* liveDelegateCount(machine, listed.success, core).pipe(
                  Effect.result,
                );
                if (Result.isFailure(count)) {
                  lines.push(
                    watchEvent("capacity-unavailable", { machine }, "", {
                      error: count.failure.message,
                    }),
                  );
                  continue;
                }
                const budget = yield* machineDelegateBudget(config, machine, core);
                observations[machine] = { live: count.success, budget: budget.budget };
              }
            }
          }
        }
        if (keyed) {
          const wakes = capacityWakeEvents(waits, observations, previous);
          lines.push(...wakes.events);
          snapshot.capacity = wakes.capacity;
        }
      }
      first = false;

      const owner = yield* ownerState();
      const ownerGone = owner === "gone";
      const ownerNotice = ownerGone
        ? `owner gone: ${options.owner} no longer runs; nothing will read these events`
        : undefined;
      const events: WatchEvent[] = lines.map((event, index) => ({
        ...event,
        id: (state.nextEventId + index).toString(36),
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
      state = { ...staged, ...snapshot, staged: undefined, outboxIntents: [] };
      yield* writeState(path, state);
      // Markers follow the committed events: a crash before them re-samples the session later,
      // duplicating a retro rather than losing one.
      for (const mark of marks) yield* markSettled(config.stateDir, mark.session, mark.retro);

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
