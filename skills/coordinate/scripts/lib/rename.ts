import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { Effect, Result } from "effect";
import { archivePath, BacklogError, readDocument, refSessions } from "./backlog-doc.ts";
import { validateBacklog } from "./backlog-store/schema.ts";
import { stateStore } from "./state.ts";
import { writeFileAtomic } from "./state-files.ts";
import { keys, runInSession, type StateKey, type StoreSession } from "./state-store.ts";
import { type Config, configPath } from "./config.ts";
import { checkDomainName, L, members, readEnded, Refused, resolveDomain } from "./fleet.ts";
import * as hc from "./herdr.ts";
import { lockPath, watcherAlive } from "./watch-lock.ts";
import { statePath } from "./watch.ts";
import { checkHarnessPolicyDomainRename, holdingHarnessPolicyLocks } from "./harness-policy.ts";

/**
 * Options for `coordinate backlog rename`.
 */
export type RenameOptions = {
  /**
   * The new name.
   */
  to: string;
  /**
   * `--domain`: the domain to rename; default this coordinator's label.
   */
  domain: string | undefined;
  json: boolean;
};

/**
 * What a rename moved, and what it could not.
 */
export type RenameResult = {
  from: string;
  to: string;
  backlog: string;
  archive: string | null;
  snapshot: string | null;
  capacityQueue: string | undefined;
  stalePid: string | null;
  ended: string[];
  endedSkipped: string[];
  relabelled: string[];
  unrelabelled: Array<{ address: string; message: string }>;
  warnings: string[];
};

const refuseLiveWatcher = Effect.fn("refuseLiveWatcher")(function* (
  config: Config,
  domain: string,
) {
  const pid = yield* watcherAlive(config.stateDir, domain);
  if (pid !== undefined)
    return yield* new Refused({
      message: `a watcher (pid ${pid}) holds ${domain}'s lock at ${lockPath(config.stateDir, domain)}; stop it first (kill ${pid})`,
    });
});

/**
 * Whether a shared document exists; one that exists but cannot be read still counts.
 */
const present = (config: Config, key: StateKey) =>
  stateStore(config.stateDir)
    .read(key)
    .pipe(
      Effect.map((stored) => stored.value !== null),
      Effect.catchTag("StoreUnreadable", () => Effect.succeed(true)),
    );

const refuseExisting = (config: Config, from: string, to: string) =>
  Effect.gen(function* () {
    const store = stateStore(config.stateDir);
    const refusal = store.refusal(keys.backlog(to));
    if (refusal !== undefined) return yield* new Refused({ message: refusal });
    // The archive is a file beside the state, so only the machine that holds it can move it.
    if (!(yield* store.archivesHere))
      return yield* new Refused({
        message: `${from}'s archive is a file on the state home that holds ${store.location(keys.backlog(from))}; run coordinate backlog rename on that machine`,
      });
    if (!(yield* present(config, keys.backlog(from))))
      return yield* new Refused({
        message: `no backlog for ${from} at ${store.location(keys.backlog(from))}`,
      });
    if (yield* present(config, keys.backlog(to)))
      return yield* new Refused({
        message: `a backlog for ${to} already exists at ${store.location(keys.backlog(to))}`,
      });
    const archive = archivePath(config.stateDir, to);
    if (existsSync(archive))
      return yield* new Refused({ message: `an archive for ${to} already exists at ${archive}` });
    if (yield* present(config, keys.queue(to)))
      return yield* new Refused({
        message: `a capacity queue for ${to} already exists at ${store.location(keys.queue(to))}`,
      });
  });

/**
 * Copy a local file (an archive or watcher snapshot) to its new name with the atomic write, when
 * it exists.
 * @returns The new path, or null when there was nothing to copy.
 */
const copyIfPresent = Effect.fn("copyIfPresent")(function* (source: string, target: string) {
  if (!existsSync(source)) return null;
  const text = yield* Effect.promise(() => readFile(source, "utf8"));
  yield* writeFileAtomic(target, text);
  return target;
});

const unreadable = (error: { location: string; message: string }) =>
  new BacklogError({ path: error.location, message: error.message });

/**
 * Change one shared document inside the rename's exclusive section, re-reading and re-applying
 * `next` when another writer won the race (`runInSession`), then refusing after three.
 */
const change = (
  config: Config,
  session: StoreSession,
  key: StateKey,
  next: (current: unknown) => unknown,
) =>
  runInSession(stateStore(config.stateDir), session, key, (current) =>
    Effect.succeed({ write: true as const, next: next(current.value), value: undefined }),
  ).pipe(Effect.catchTag("StoreUnreadable", (error) => Effect.fail(unreadable(error))));

/**
 * Replace a shared document whatever it holds now.
 */
const replace = (config: Config, session: StoreSession, key: StateKey, value: unknown) =>
  change(config, session, key, () => value);

const lines = (result: RenameResult): string[] => [
  `renamed ${result.from} to ${result.to}: backlog ${result.backlog}`,
  ...(result.archive ? [`  archive ${result.archive}`] : []),
  ...(result.snapshot ? [`  watcher snapshot ${result.snapshot}`] : []),
  ...(result.capacityQueue ? [`  capacity queue ${result.capacityQueue}`] : []),
  ...(result.stalePid ? [`  removed stale watcher pid file ${result.stalePid}`] : []),
  ...(result.ended.length > 0 ? [`  ended records now ${result.to}: ${result.ended.length}`] : []),
  ...(result.endedSkipped.length > 0
    ? [`  unreadable ended records, not checked: ${result.endedSkipped.join(", ")}`]
    : []),
  ...result.relabelled.map((address) => `  relabelled ${address}: ${L.domain}=${result.to}`),
  ...result.unrelabelled.map(
    ({ address, message }) =>
      `  could not relabel ${address}: ${message}; run hc label ${address} ${L.domain}=${result.to}`,
  ),
  ...result.warnings.map((warning) => `  warning: ${warning}`),
];

/**
 * `coordinate backlog rename`: give a domain a new name. Under both domains' backlog locks it writes
 * the new backlog (domain field set), archive, watcher snapshot and capacity queue, points ended-delegate records
 * at the new name, relabels the domain's terminals, then removes the old files. A crash before the
 * old backlog is removed leaves the old domain whole beside a partial new one.
 * @param config Config.
 * @param options New name, `--domain`, `--json`.
 * @returns Lines to print.
 */
export const renameDomain = Effect.fn("renameDomain")(function* (
  config: Config,
  options: RenameOptions,
) {
  const from = yield* resolveDomain(options.domain);
  const to = options.to;
  yield* checkDomainName(to);
  if (from === to) return yield* new Refused({ message: `${from} is already named ${to}` });
  yield* refuseExisting(config, from, to);
  const live = yield* members(from, yield* refSessions(config, from));
  if (live.length > 0)
    return yield* new Refused({
      message: `${from} has live delegates: ${live.map((terminal) => `${terminal.name} (${terminal.address})`).join(", ")}; end them first (coordinate end <name>)`,
    });
  yield* refuseLiveWatcher(config, from);
  yield* refuseLiveWatcher(config, to);

  const store = stateStore(config.stateDir);
  const result = yield* holdingHarnessPolicyLocks(config, [from, to], (session) =>
    Effect.gen(function* () {
      yield* refuseExisting(config, from, to);
      yield* checkHarnessPolicyDomainRename(config, from, to);
      yield* refuseLiveWatcher(config, from);
      const state = config.stateDir;
      const { backlog } = yield* readDocument(config, from);

      // New files first: until the old backlog is removed below, the old domain stays whole.
      const backlogPath = store.location(keys.backlog(to));
      const checked = validateBacklog({ ...backlog, domain: to });
      if (!checked.ok) return yield* new Refused({ message: checked.errors.join("; ") });
      yield* replace(config, session, keys.backlog(to), checked.backlog);
      const archive = yield* copyIfPresent(archivePath(state, from), archivePath(state, to));
      const snapshot = yield* copyIfPresent(statePath(state, from), statePath(state, to));
      const queue = yield* session
        .read(keys.queue(from))
        .pipe(Effect.catchTag("StoreUnreadable", (error) => Effect.fail(unreadable(error))));
      const capacityQueue =
        queue.value === null
          ? null
          : yield* replace(config, session, keys.queue(to), queue.value).pipe(
              Effect.as(store.location(keys.queue(to))),
            );

      // In place: each ended record is rewritten whole, keeping fields this CLI does not read.
      const { records, skipped } = yield* readEnded(state);
      const ended: string[] = [];
      for (const { id, path, record } of records) {
        if (record.domain !== from) continue;
        const key = keys.ended(id);
        yield* change(config, session, key, (raw) => ({ ...(raw as object), domain: to }));
        ended.push(path);
      }

      const relabelled: string[] = [];
      const unrelabelled: RenameResult["unrelabelled"] = [];
      const listed = yield* Effect.result(hc.list([`${L.domain}=${from}`]));
      if (Result.isFailure(listed))
        unrelabelled.push({ address: "(hc ls)", message: listed.failure.message });
      else
        for (const terminal of listed.success) {
          const labelled = yield* Effect.result(hc.label(terminal.address, { [L.domain]: to }));
          if (Result.isSuccess(labelled)) relabelled.push(terminal.address);
          else unrelabelled.push({ address: terminal.address, message: labelled.failure.message });
        }

      // The old backlog goes first: once it is gone the rename is done, and what follows is cleanup.
      yield* replace(config, session, keys.backlog(from), null);
      for (const path of [archivePath(state, from), statePath(state, from)])
        yield* Effect.promise(() => rm(path, { force: true }));
      yield* replace(config, session, keys.queue(from), null);
      const pidFile = lockPath(state, from);
      const stalePid = existsSync(pidFile) ? pidFile : null;
      if (stalePid) yield* Effect.promise(() => rm(stalePid, { force: true }));

      return {
        from,
        to,
        backlog: backlogPath,
        archive,
        snapshot,
        capacityQueue: capacityQueue ?? undefined,
        stalePid,
        ended,
        endedSkipped: skipped,
        relabelled,
        unrelabelled,
        warnings: config.keepRunning.includes(from)
          ? [`keep_running in ${configPath()} lists ${from}; change it to ${to}`]
          : [],
      } satisfies RenameResult;
    }),
  );
  return options.json ? [JSON.stringify(result, null, 2)] : lines(result);
});
