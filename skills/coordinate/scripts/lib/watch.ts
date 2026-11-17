import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Option, Result } from "effect";
import { readDocument } from "./backlog-doc.ts";
import type { Item } from "./backlog-store/schema.ts";
import type { Config } from "./config.ts";
import { L, Refused } from "./fleet.ts";
import * as hc from "./herdr.ts";
import { repoPullRequests } from "./prs.ts";
import { domainRepos } from "./status.ts";
import { acquireLock, releaseLock } from "./watch-lock.ts";

/**
 * What the watcher remembers about one delegate terminal.
 */
export type SeenDelegate = { name: string; status: string | undefined; turn: number };

/**
 * What the watcher remembers about one pull request.
 */
export type SeenPr = { state: string; checks: string; review: string; url: string };

/**
 * The watcher's state file: the last snapshot, so changes while it was not running fire on re-arm.
 */
export type WatchState = {
  delegates: Record<string, SeenDelegate>;
  prs: Record<string, SeenPr>;
  /**
   * Due events already fired, keyed `<item id> <date>`.
   */
  due: string[];
};

/**
 * An empty state.
 */
export const emptyState = (): WatchState => ({ delegates: {}, prs: {}, due: [] });

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

const statePath = (stateDir: string, domain: string): string =>
  join(stateDir, "watch", `${domain}.json`);

const readState = (path: string) =>
  Effect.promise(async (): Promise<WatchState | undefined> => {
    if (!existsSync(path)) return undefined;
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<WatchState>;
      return { delegates: parsed.delegates ?? {}, prs: parsed.prs ?? {}, due: parsed.due ?? [] };
    } catch {
      return undefined;
    }
  });

const writeState = (path: string, state: WatchState) =>
  Effect.promise(async () => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, `${JSON.stringify(state, null, 1)}\n`);
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
 * Watch options.
 */
export type WatchOptions = {
  domain: string;
  intervalMs: number;
  forgeIntervalMs: number;
  maxMs: number;
  owner: string | undefined;
  replace: boolean;
  today: () => string;
};

/**
 * Watch one domain until something needs the coordinator, then print one line per event and exit.
 * @param config Config.
 * @param options Watch options.
 * @returns Event lines.
 */
export const watch = Effect.fn("watch")(function* (config: Config, options: WatchOptions) {
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
    Effect.runFork(release);
    console.log("stopped");
    process.exit(0);
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  return yield* Effect.gen(function* () {
    const path = statePath(config.stateDir, options.domain);
    const saved = yield* readState(path);
    const state: WatchState = saved ?? emptyState();
    const repos = yield* domainRepos(config, options.domain);
    const started = Date.now();
    let lastForge = 0;
    let failures = 0;
    let first = saved === undefined;
    for (;;) {
      const lines: string[] = [];
      const polled = yield* snapshotDelegates(options.domain).pipe(Effect.result);
      if (Result.isFailure(polled)) {
        failures += 1;
        if (failures >= 3)
          return [
            `blind: herdr-core unreadable 3 times: ${polled.failure.message}; re-arm the watcher`,
          ];
      } else {
        failures = 0;
        const events = first ? [] : delegateEvents(state.delegates, polled.success);
        if (first)
          for (const [address, now] of Object.entries(polled.success))
            if (now.status === "blocked" || now.status === "error")
              events.push(`${now.status} ${now.name} (${address}): read its terminal`);
        if (events.some((line) => line.startsWith("settled ")))
          events.push(statusBeat(polled.success));
        lines.push(...events);
        state.delegates = polled.success;
      }
      if (Date.now() - lastForge >= options.forgeIntervalMs) {
        lastForge = Date.now();
        const prs = yield* snapshotPrs(config, repos, state.prs);
        lines.push(...prEvents(state.prs, prs.snapshot));
        state.prs = prs.snapshot;
        const document = yield* readDocument(config, options.domain).pipe(Effect.option);
        if (Option.isSome(document)) {
          const due = dueEvents(document.value.backlog.items, options.today(), state.due);
          lines.push(...due.lines);
          state.due = due.fired;
        }
      }
      first = false;
      if (options.owner) {
        const owner = yield* hc
          .get(options.owner)
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (owner === undefined || !owner.live)
          lines.push(`owner gone: ${options.owner} no longer runs; nothing will read these events`);
      }
      yield* writeState(path, state);
      if (lines.length > 0) return lines;
      if (Date.now() - started >= options.maxMs)
        return [`alive: no events in ${Math.round(options.maxMs / 60_000)}m; re-arm the watcher`];
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
