import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect, Option, Result } from "effect";
import { editsClear, findingAdd, readDocument } from "./backlog-doc.ts";
import { FINDING_DETAIL_SHAPE, isAnswer, isDiscussion } from "./backlog-store/schema.ts";
import type { Item, RecordEdit } from "./backlog-store/schema.ts";
import type { Config } from "./config.ts";
import { checkDomainName, L, readEnded, Refused, sessionOf } from "./fleet.ts";
import * as hc from "./herdr.ts";
import { repoPullRequests } from "./prs.ts";
import { copyBackSettled } from "./remote-fetch.ts";
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
  remoteMachineOf,
} from "./delegate-capacity.ts";
import { resolveEffectiveHarnessPolicy } from "./harness-policy.ts";
import { stateStore } from "./state.ts";
import { isOffline, keys, optionUnlessOffline, type StoreOffline } from "./state-store.ts";
import { outboxPath } from "./remote-launch.ts";
import { lastLint, LINT_INTERVAL_DAYS, settledWikiPages, wikiCreated } from "./wiki.ts";
import { renewWatchedLease } from "./lease.ts";
import {
  fleetEvents,
  fleetSummary,
  joinFleet,
  LEASE_BLIND_READS,
  LEASE_INTERVAL_MS,
  readFleet,
  readLeaseFleet,
  type FleetSnapshot,
  type LeaseSource,
} from "./fleet-watch.ts";
import { markSettled, readSession, retroDue, type RetroMarker } from "./sessions.ts";
import {
  digestDelta,
  readDigest,
  readLastMessage,
  sameDigest,
  type BacklogDigest,
} from "./fleet-digest.ts";

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
  /**
   * Start requests already fired, keyed `<item id> <request time>`. Only requests still pending
   * are kept, and none is seeded on arm: a pending request is live, so a first read fires it.
   */
  started: string[];
  /**
   * The user's edits already queued, keyed `<edit id> <time>`. Only edits still in the document are
   * kept; none is seeded on arm, since a pending edit is undelivered.
   */
  edited: string[];
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
  started: [],
  edited: [],
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

/**
 * Drop the `gone` events of delegates `coordinate end` ended: their ended records name the address.
 * @param events Delegate events.
 * @param ended Addresses ended records name.
 * @returns The events a coordinator still needs.
 */
export const withoutEndedGone = (
  events: readonly WatchEventData[],
  ended: ReadonlySet<string>,
): WatchEventData[] =>
  events.filter((event) => event.kind !== "gone" || !ended.has(event.attrs.address ?? ""));

/**
 * How long after the window last focused a coordinator's tab the manager holds that coordinator's
 * settle and blocked events, taking the focus as the user working in it.
 */
export const USER_ACTIVE_MS = 10 * 60_000;

/** How long after a delegate's terminal starts no idle reminder fires: it is still starting up. */
export const LAUNCH_QUIET_MS = 120_000;

/** What an idle reminder reads about one delegate terminal. */
export type IdleDetail = {
  session: string;
  statusMs: number | undefined;
  createdMs?: number | undefined;
};

/** Calculate idle reminders with an injected clock. */
export const idleEvents = (
  delegates: Readonly<Record<string, SeenDelegate>>,
  details: Readonly<Record<string, IdleDetail>>,
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
    if (detail?.createdMs !== undefined && now - detail.createdMs < LAUNCH_QUIET_MS) {
      delete reminders[address];
      continue;
    }
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
      .flatMap(({ text, at }) => (isAnswer(text) ? [{ text, at }] : []))
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
      .flatMap(({ text, at }) => (isDiscussion(text) ? [{ text, at }] : []))
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
 * Start events for the user's pending start requests (`item start`, the Backlog panel's Start),
 * in document order, skipping keys already fired. Unlike answers and discussions, a request is
 * pending state rather than history, so a first read fires every pending one instead of seeding
 * it, and the fired keys keep only requests still pending. A new request after one clears has a
 * new time, so it fires again. A note given with Start rides as a `<note>` child.
 */
export const startEvents = (items: readonly Item[], fired: readonly string[]) => {
  const pending = items.flatMap((item) =>
    item.startRequested === undefined
      ? []
      : [
          {
            key: `${item.id} ${item.startRequested.at}`,
            event: watchEvent(
              "start",
              { item: item.id },
              "the user asked you to start this item: route it per the skill and policies",
              {
                title: item.title,
                requested: item.startRequested.at,
                ...(item.startRequested.noteMarkdown === undefined
                  ? {}
                  : { note: item.startRequested.noteMarkdown }),
              },
            ),
          },
        ],
  );
  const seen = new Set(fired);
  return {
    events: pending.filter((entry) => !seen.has(entry.key)).map((entry) => entry.event),
    fired: pending.map((entry) => entry.key),
  };
};

/**
 * How much of an edit's old or new text an `edited` event carries; the new text stays in the
 * document, so a longer value is cut with an ellipsis.
 */
export const EDIT_TEXT_LIMIT = 2000;

const clip = (value: string): string =>
  value.length > EDIT_TEXT_LIMIT ? `${value.slice(0, EDIT_TEXT_LIMIT)}…` : value;

/**
 * Edited events for the user's pending edits (the Backlog panel's Edit and Delete), in document
 * order, skipping keys already queued. Like start requests, a pending edit is undelivered state, so
 * a first read queues every pending one, and the queued keys keep only edits still pending.
 * @param edits The document's pending edits.
 * @param fired Keys already queued.
 * @returns The events to queue and the keys queued so far.
 */
export const editEvents = (edits: readonly RecordEdit[], fired: readonly string[]) => {
  const pending = edits.map((edit) => ({
    key: `${edit.id} ${edit.at}`,
    event: watchEvent(
      "edited",
      {
        change: edit.id,
        record: edit.record,
        field: edit.field,
        action: edit.new === null ? "delete" : "edit",
      },
      "the user changed this record: adjust any running work or brief that relied on the old text",
      {
        ...(edit.old === null ? {} : { old: clip(edit.old) }),
        ...(edit.new === null ? {} : { new: clip(edit.new) }),
        at: edit.at,
      },
    ),
  }));
  const seen = new Set(fired);
  return {
    events: pending.filter((entry) => !seen.has(entry.key)).map((entry) => entry.event),
    fired: pending.map((entry) => entry.key),
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
        started: parsed.started ?? [],
        edited: parsed.edited ?? [],
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
    const machine = remoteMachineOf(address);
    if (machine !== undefined && down.includes(machine) && delegates[address] === undefined)
      delegates[address] = seen;
  }
  const hosting = new Set(Object.keys(delegates).map(remoteMachineOf));
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
      detailMarkdown: string;
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
    const detailMarkdown = text("detailMarkdown");
    if (detailMarkdown === undefined)
      return {
        type: "invalid",
        error: `a finding line needs detailMarkdown: ${FINDING_DETAIL_SHAPE}`,
      };
    return {
      type: "finding",
      kind: record.kind,
      title,
      detail: text("detail"),
      detailMarkdown,
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
 * becomes a `notify` event, and a line that cannot be applied becomes a `delegate-outbox-invalid` event.
 * Only newline-terminated lines count, so a line still being written waits. A machine that is down
 * or a file that cannot be read keeps its cursor for the next tick.
 * @param config Config.
 * @param domain Domain.
 * @param tick This tick's delegate snapshot (`delegates`), the machines Herdr lists as not
 * connected (`down`), the cursors by session from the last committed snapshot (`cursors`), the
 * finding lines a stopped watcher may already have added (`intents`), the clock for each new
 * finding's time (`now`), and `recordIntent`, which saves an intent durably before its finding is
 * added.
 * @returns The new cursors and the events to queue with them.
 */
export const drainOutboxes = Effect.fn("drainOutboxes")(function* (
  config: Config,
  domain: string,
  tick: {
    delegates: Readonly<Record<string, SeenDelegate>>;
    down: readonly string[];
    cursors: Readonly<Record<string, OutboxCursor>>;
    intents: readonly OutboxIntent[];
    now: () => number;
    recordIntent: (intent: OutboxIntent) => Effect.Effect<void>;
  },
) {
  const { delegates, down, cursors, intents, now, recordIntent } = tick;
  const next: Record<string, OutboxCursor> = Object.fromEntries(
    Object.entries(cursors).map(([session, cursor]) => [session, { ...cursor }]),
  );
  const tracked = new Set(Object.values(next).map((cursor) => cursor.address));
  for (const [address, seen] of Object.entries(delegates)) {
    const machine = remoteMachineOf(address);
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
          "delegate-outbox-invalid",
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
        detailMarkdown: parsed.detailMarkdown,
        path: parsed.path,
        from: parsed.from,
        source,
        json: false,
        now: at,
      }).pipe(Effect.result);
      if (Result.isSuccess(added)) continue;
      // An unreachable home is retried next tick like an unwritable backlog, never skipped.
      if (added.failure._tag === "BacklogError" || added.failure._tag === "StoreOffline") {
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
 * What a watcher watches: a `coordinator` its domain, a `manager` its domain and the coordinator
 * fleet too.
 */
export type WatchRole = "coordinator" | "manager";

/** Every watcher role, the default first. */
export const WATCH_ROLES: readonly WatchRole[] = ["coordinator", "manager"];

const failureText = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error);

/**
 * Options for one watch loop.
 */
export type WatchOptions = {
  domain: string;
  /** Defaults to `coordinator`. */
  role?: WatchRole;
  /**
   * Where a manager reads coordinator leases (tests inject it); defaults to the home store on
   * herdr-doc and none on files, where labels alone find the fleet.
   */
  fleetLeases?: LeaseSource;
  intervalMs: number;
  forgeIntervalMs: number;
  maxMs: number;
  owner: string | undefined;
  replace: boolean;
  deliver: boolean;
  today: () => string;
  now?: () => number;
  /**
   * Wait between ticks (tests inject it); defaults to `Effect.sleep`.
   */
  sleep?: (ms: number) => Effect.Effect<void>;
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
  let unfollow = () => {};
  const onSignal = () => {
    unfollow();
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
    // The home being unreachable at start is a blind tick to count, not a reason to stop.
    let repos = yield* domainRepos(config, options.domain).pipe(
      Effect.catchTag("StoreOffline", () => Effect.succeed([])),
    );
    const clock = options.now ?? Date.now;
    const sleep = options.sleep ?? ((ms: number) => Effect.sleep(ms));
    // On the home (herdr-doc), a change to a shared document this watcher reads ends the wait
    // between ticks early. Every tick still reads them, so polling alone sees the same changes.
    let changed = false;
    let wake: (() => void) | undefined;
    const followed = yield* (
      stateStore(config.stateDir).follow?.(
        [keys.backlog(options.domain), keys.policy(), keys.queue(options.domain)],
        () => {
          changed = true;
          wake?.();
        },
      ) ?? Effect.succeed(undefined)
    );
    unfollow = () => followed?.close();
    const pause = (ms: number) =>
      Effect.suspend(() =>
        changed
          ? Effect.void
          : Effect.race(
              sleep(ms),
              Effect.callback<void>((resume) => {
                wake = () => resume(Effect.void);
                // A change may land while the wait is starting.
                if (changed) wake();
              }),
            ),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            wake = undefined;
            changed = false;
          }),
        ),
      );
    const started = clock();
    let lastForge = Number.NEGATIVE_INFINITY;
    let lastLease = Number.NEGATIVE_INFINITY;
    let lastTick: number | undefined;
    let viewOwnerState: WatchView["ownerState"] = "live";
    let lastDelivery = state.outbox.length > 0 ? "pending from outbox" : "not sent yet";
    const log: WatchLogEntry[] = [];
    let failures = 0;
    let failureMessage = "";
    // Consecutive ticks whose shared-state reads found the home unreachable (herdr-doc backend).
    let homeFailures = 0;
    let homeMessage = "";
    let homeDown: StoreOffline | undefined;
    // A read of shared state that gives `fallback` and marks this tick blind when the home is
    // unreachable; any other failure is the read's own.
    const homeRead = <A, E, R>(effect: Effect.Effect<A, E, R>, fallback: A) =>
      effect.pipe(
        Effect.catch((error) => {
          if (!isOffline(error)) return Effect.fail(error as Exclude<E, StoreOffline>);
          homeDown = error;
          return Effect.succeed(fallback);
        }),
      );
    let first = saved === undefined;
    // A manager also watches the coordinator fleet. Its first good reading is a silent baseline in
    // each watcher process, as is a coordinator entering working.
    const manager = options.role === "manager";
    const leaseSource: LeaseSource | undefined = !manager
      ? undefined
      : (options.fleetLeases ??
        (config.stateBackend !== "herdr-doc" || config.stateHome === undefined
          ? undefined
          : {
              read: Effect.suspend(() =>
                Effect.flatMap(localMachine(), (reader) =>
                  readLeaseFleet(stateStore(config.stateDir), reader, clock()),
                ),
              ),
              everyMs: LEASE_INTERVAL_MS,
              home: config.stateHome,
            }));
    const fleetExclude: ReadonlySet<string> = new Set(options.owner ? [options.owner] : []);
    let fleet: FleetSnapshot | undefined;
    let fleetLeases: FleetSnapshot = new Map();
    const fleetDomains = new Map<string, string>();
    const fleetLooked = new Set<string>();
    let fleetMachine: string | undefined;
    let lastLeaseRead = Number.NEGATIVE_INFINITY;
    let leaseFailures = 0;
    // Each domain's backlog digest as of the manager's last wake about it, and each coordinator's tab.
    const fleetDigests = new Map<string, BacklogDigest>();
    const fleetTabs = new Map<string, string>();
    // When the open window last had each tab focused, the proxy for the user typing in it (Herdr
    // exposes no input source), and the settle or blocked event held for each coordinator meanwhile.
    const tabFocused = new Map<string, number>();
    const fleetHeld = new Map<string, WatchEventData>();
    const userActive = (address: string) => {
      const tab = fleetTabs.get(address);
      const seen = tab === undefined ? undefined : tabFocused.get(tab);
      return seen !== undefined && clock() - seen < USER_ACTIVE_MS;
    };
    const noteDigest = (domain: string, digest: BacklogDigest | undefined) => {
      if (digest === undefined) fleetDigests.delete(domain);
      else fleetDigests.set(domain, digest);
    };
    // Give a fleet event the coordinator's last message and backlog delta, or hold back a settle
    // whose domain changed nothing since the last wake (undefined: recorded silently).
    const fleetWake = (event: WatchEventData) =>
      Effect.gen(function* () {
        const domain = event.attrs.domain;
        const address = event.attrs.address;
        if (event.attrs.source !== "terminal" || domain === undefined || address === undefined)
          return event;
        if (event.kind === "fleet-arrived") {
          noteDigest(domain, yield* readDigest(config, domain));
          return event;
        }
        const settled = event.kind === "fleet-settled";
        const blocked = event.kind === "fleet-state" && event.attrs.to === "blocked";
        if (!settled && !blocked) return event;
        const before = fleetDigests.get(domain);
        const digest = yield* readDigest(config, domain);
        if (settled && sameDigest(before, digest))
          return "recorded silently: its backlog is unchanged since the last wake";
        if (userActive(address)) {
          fleetHeld.set(address, event);
          return "held: the user is active in its tab; its open asks follow after 10m away";
        }
        fleetHeld.delete(address);
        noteDigest(domain, digest);
        const delta = digest === undefined ? [] : digestDelta(before, digest);
        const message = yield* readLastMessage(address);
        return {
          ...event,
          fields: {
            ...event.fields,
            ...(message === "" ? {} : { "last-message": message }),
            ...(delta.length === 0 ? {} : { delta }),
          },
        };
      });
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
          ...(manager ? { fleet: fleetSummary(fleet, fleetDomains) } : {}),
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
      homeDown = undefined;
      const snapshot: WatchSnapshot = {
        delegates: state.delegates,
        prs: state.prs,
        due: [...state.due],
        answered: state.answered === null ? null : [...state.answered],
        discussed: state.discussed === null ? null : [...state.discussed],
        started: [...state.started],
        edited: [...state.edited],
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
      let nextFleet = fleet;
      const policy = yield* resolveEffectiveHarnessPolicy(config, options.domain).pipe(
        Effect.result,
      );
      if (Result.isFailure(policy) && isOffline(policy.failure)) homeDown = policy.failure;
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
      if (
        homeDown === undefined &&
        snapshot.harnessPolicy !== undefined &&
        snapshot.harnessPolicy !== policySignature
      ) {
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
      if (homeDown === undefined) snapshot.harnessPolicy = policySignature;
      const latestRepos =
        homeDown === undefined
          ? yield* homeRead(domainRepos(config, options.domain), repos)
          : repos;
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
        const delegateChanges = first ? [] : delegateEvents(snapshot.delegates, seen);
        // A delegate `coordinate end` ended leaves an ended record naming its address: not news.
        const ended = delegateChanges.some((event) => event.kind === "gone")
          ? yield* readEnded(config.stateDir).pipe(
              Effect.map(
                ({ records }) =>
                  new Set(
                    records.flatMap(({ record }) => (record.address ? [record.address] : [])),
                  ),
              ),
              Effect.catch(() => Effect.succeed(new Set<string>())),
            )
          : new Set<string>();
        const events = withoutEndedGone(delegateChanges, ended);
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
          if (!terminal) continue;
          // A remote delegate's folder is a path on its own machine, not one to read git in here;
          // its .scratch is copied into the repo's parked folder on this Mac instead.
          if (remoteMachineOf(terminal.address) !== undefined) {
            const copied = yield* copyBackSettled(config, options.domain, terminal).pipe(
              Effect.result,
            );
            if (Result.isFailure(copied))
              events[index] = {
                ...event,
                fields: { ...event.fields, "copy-back": `failed: ${copied.failure.message}` },
              };
            continue;
          }
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
        const drained = yield* drainOutboxes(config, options.domain, {
          delegates: seen,
          down: polled.success.down,
          cursors: snapshot.remoteOutboxes,
          intents: state.outboxIntents,
          now: clock,
          recordIntent: (intent) =>
            Effect.gen(function* () {
              state = { ...state, outboxIntents: [...state.outboxIntents, intent] };
              yield* writeState(path, state);
            }),
        });
        snapshot.remoteOutboxes = drained.cursors;
        lines.push(...drained.events);
      }
      if (clock() - lastForge >= options.forgeIntervalMs) {
        lastForge = clock();
        const prs = yield* snapshotPrs(config, repos, snapshot.prs);
        lines.push(...prEvents(snapshot.prs, prs.snapshot));
        snapshot.prs = prs.snapshot;
      }
      if (options.owner !== undefined)
        lastLease = yield* renewWatchedLease(
          config,
          options.domain,
          options.owner,
          clock(),
          lastLease,
        );
      // The local backlog is read every tick, so an answer wakes within one interval, not forge cadence.
      const document =
        homeDown === undefined
          ? yield* homeRead(
              optionUnlessOffline(readDocument(config, options.domain)),
              Option.none(),
            )
          : Option.none();
      // With the home unreachable, reminders wait: the backlog that would suppress them is unread.
      if (Result.isSuccess(polled) && homeDown === undefined) {
        const details: Record<string, IdleDetail> = {};
        // A delegate on a machine that is down is neither asked about nor reminded of; its
        // reminder waits for the machine to reconnect.
        const down = (address: string) =>
          snapshot.unreachable.includes(remoteMachineOf(address) ?? "");
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
            details[address] = {
              session: sessionOf(terminal),
              statusMs: terminal.statusMs,
              createdMs: terminal.createdMs,
            };
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
        const started = startEvents(document.value.backlog.items, snapshot.started);
        lines.push(...started.events);
        snapshot.started = started.fired;
        const edited = editEvents(document.value.backlog.edits ?? [], snapshot.edited);
        lines.push(...edited.events);
        snapshot.edited = edited.fired;
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
      const readQueue =
        homeDown === undefined
          ? yield* readCapacityQueue(config, options.domain).pipe(Effect.result)
          : undefined;
      if (readQueue !== undefined && Result.isFailure(readQueue) && isOffline(readQueue.failure))
        homeDown = readQueue.failure;
      if (readQueue === undefined || homeDown !== undefined) {
        // The queue lives on the home: capacity is checked once it answers again.
      } else if (Result.isFailure(readQueue)) {
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
          const removed = yield* homeRead(
            pruneCapacityWaits(config, options.domain, keep),
            [] as readonly CapacityWait[],
          );
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
            waits = yield* homeRead(
              readCapacityQueue(config, options.domain).pipe(Effect.map((queue) => queue.entries)),
              waits,
            );
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
            const listed = yield* hc.listing().pipe(Effect.result);
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
      if (manager) {
        if (leaseSource !== undefined && clock() - lastLeaseRead >= leaseSource.everyMs) {
          lastLeaseRead = clock();
          const read = yield* leaseSource.read.pipe(Effect.result);
          if (Result.isSuccess(read)) {
            if (leaseFailures >= LEASE_BLIND_READS)
              lines.push(
                watchEvent(
                  "fleet-blind-cleared",
                  { home: leaseSource.home },
                  "lease entries are current again; rediscover the fleet",
                ),
              );
            leaseFailures = 0;
            fleetLeases = read.success;
          } else {
            // An unreachable home also counts toward the watcher's own blind ticks.
            if (isOffline(read.failure)) homeDown ??= read.failure;
            leaseFailures += 1;
            if (leaseFailures === LEASE_BLIND_READS)
              lines.push(
                watchEvent(
                  "fleet-blind",
                  { home: leaseSource.home, reads: String(LEASE_BLIND_READS) },
                  "lease entries are from the last good read; treat every lease-only coordinator as stale",
                  { error: failureText(read.failure) },
                ),
              );
          }
        }
        // A failed or empty reading keeps the last good one.
        const labelled = yield* readFleet(fleetExclude).pipe(Effect.option);
        const current = Option.map(labelled, (listed) =>
          joinFleet(listed, fleetLeases, fleetExclude),
        );
        if (Option.isSome(current) && current.value.size > 0) {
          for (const [key, address] of fleetLeases) fleetDomains.set(address, key.slice(2));
          for (const key of current.value.keys()) {
            const address = key.slice(2);
            if (!key.startsWith("t:") || fleetDomains.has(address) || fleetLooked.has(address))
              continue;
            fleetLooked.add(address);
            const terminal = yield* hc
              .get(address)
              .pipe(Effect.catch(() => Effect.succeed(undefined)));
            const domain = terminal?.labels[L.domain];
            if (domain !== undefined) fleetDomains.set(address, domain);
            const tab = terminal?.labels["herdr.tab"];
            if (tab !== undefined) fleetTabs.set(address, tab);
          }
          // The silent baseline also takes each domain's digest, so a first settle that changed
          // nothing stays silent too.
          if (fleet === undefined)
            for (const domain of new Set(fleetDomains.values()))
              if (!fleetDigests.has(domain)) noteDigest(domain, yield* readDigest(config, domain));
          if (fleet !== undefined) {
            const changes = fleetEvents(fleet, current.value, {
              domains: fleetDomains,
              machine: (fleetMachine ??= yield* localMachine().pipe(
                Effect.option,
                Effect.map(Option.getOrUndefined),
              )),
            });
            const focused = yield* hc.focusedTab().pipe(Effect.option);
            if (Option.isSome(focused) && focused.value !== undefined)
              tabFocused.set(focused.value, clock());
            for (const change of changes) {
              const woken = yield* fleetWake(change);
              if (typeof woken !== "string") lines.push(woken);
              else appendLog({ ...change, id: "-" }, woken, clock());
            }
            // Once the user has left a held coordinator's tab for 10 minutes, relay its open asks once.
            for (const [address, held] of fleetHeld) {
              const state = current.value.get(`t:${address}`);
              if (state !== undefined && userActive(address)) continue;
              fleetHeld.delete(address);
              const domain = held.attrs.domain;
              if (state === undefined || domain === undefined) continue;
              const before = fleetDigests.get(domain);
              const digest = yield* readDigest(config, domain);
              const asks = Object.entries(digest?.asks ?? {}).map(([id, ask]) => `${id}: ${ask}`);
              if (asks.length === 0 && state !== "blocked") continue;
              noteDigest(domain, digest);
              const delta = digest === undefined ? [] : digestDelta(before, digest);
              const message = yield* readLastMessage(address);
              const about = Object.fromEntries(
                Object.entries(held.attrs).filter(([name]) => name !== "from" && name !== "to"),
              );
              lines.push(
                watchEvent(
                  "fleet-relay",
                  { ...about, state },
                  "the user left its tab 10m ago; relay its open asks and any question it shows, once",
                  {
                    ...(message === "" ? {} : { "last-message": message }),
                    ...(asks.length === 0 ? {} : { ask: asks }),
                    ...(delta.length === 0 ? {} : { delta }),
                  },
                ),
              );
            }
          }
          nextFleet = current.value;
        }
      }
      first = false;
      homeFailures = homeDown === undefined ? 0 : homeFailures + 1;
      homeMessage = homeDown?.message ?? "";

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
      fleet = nextFleet;
      // The user's edits leave the document only once their events are committed to the outbox. A
      // failed clear retries next tick; the fired keys keep the events from queuing twice.
      if (Option.isSome(document) && snapshot.edited.length > 0)
        yield* editsClear(
          config,
          options.domain,
          snapshot.edited.map((key) => key.split(" ")[0] ?? ""),
        ).pipe(Effect.ignore);
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
        yield* sleep(retryMs);
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

      if (failures >= 3 || homeFailures >= 3) {
        const blind =
          failures >= 3
            ? `blind: herdr-core unreadable 3 times: ${failureMessage}; re-arm the watcher`
            : `blind: state home ${homeDown?.home ?? "?"} unreachable 3 times: ${homeMessage}; re-arm the watcher`;
        if (!options.deliver) {
          if (options.follow) {
            yield* Effect.promise(async () => options.emit(blind));
            return [];
          }
          return [blind];
        }
        // Stay alive through Herdr restarts, backing off to at most one retry per minute.
        yield* sleep(
          Math.min(
            options.intervalMs * 2 ** (Math.max(failures, homeFailures) - 1),
            MAX_RETRY_DELAY_MS,
          ),
        );
        continue;
      }
      if (options.follow) {
        yield* pause(options.intervalMs);
        continue;
      }
      if (clock() - started >= options.maxMs)
        return [`alive: no events in ${Math.round(options.maxMs / 60_000)}m; re-arm the watcher`];
      if (!delivery.sent && pending) return [];
      yield* pause(options.intervalMs);
    }
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        process.removeListener("SIGTERM", onSignal);
        process.removeListener("SIGINT", onSignal);
        unfollow();
        yield* release;
      }),
    ),
  );
});
