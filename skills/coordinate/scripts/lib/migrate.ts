import { chmod, mkdir, readdir, rename } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Effect } from "effect";
import { type Config, configPath } from "./config.ts";
import { members, Refused } from "./fleet.ts";
import { homeStore } from "./state.ts";
import { filesPath, filesStore } from "./state-files.ts";
import {
  keys,
  type StateKey,
  type StateStore,
  type StoreSession,
  type Stored,
  StoreUnreadable,
} from "./state-store.ts";
import { watcherInfo } from "./watch-terminal.ts";

/**
 * Where `coordinate state migrate` moves the shared documents.
 */
export type MigrateTarget = "herdr-doc" | "files";

const label = (key: StateKey): string => {
  switch (key.kind) {
    case "backlog":
      return `backlog ${key.domain}`;
    case "queue":
      return `queue ${key.domain}`;
    case "policy":
      return "policy";
    case "ended":
      return `ended ${key.session}`;
    default:
      return key.kind;
  }
};

const unreadable = (error: StoreUnreadable) =>
  new Refused({
    message: `${error.location} is unreadable (${error.message}); fix or remove it, then migrate again`,
  });

/**
 * Read one document whole, refusing when it cannot be read.
 */
const readOne = (store: StateStore, key: StateKey) =>
  store
    .read(key)
    .pipe(Effect.catchTag("StoreUnreadable", (error) => Effect.fail(unreadable(error))));

/**
 * Every shared document the source holds, in report order: backlogs, queues, the policy, then
 * ended records. Absent queues and policy are left out.
 */
const sourceDocuments = (source: StateStore, stateDir: string) =>
  Effect.gen(function* () {
    const listed = (kind: "backlog" | "ended") =>
      source
        .list(kind)
        .pipe(Effect.catchTag("StoreUnreadable", (error) => Effect.fail(unreadable(error))));
    const domains = yield* listed("backlog");
    const sessions = yield* listed("ended");
    if (source.backend === "files") {
      // A queue is found through its domain, so one without a backlog would be left behind.
      const queueDir = dirname(filesPath(stateDir, keys.queue("x")));
      const orphans = (yield* Effect.promise(() => readdir(queueDir).catch((): string[] => [])))
        .filter((name) => name.endsWith(".json") && !domains.includes(name.slice(0, -5)))
        .toSorted();
      if (orphans.length > 0)
        return yield* new Refused({
          message: `capacity queues without a backlog: ${orphans.map((name) => join(queueDir, name)).join(", ")}; remove them or start their domain, then migrate again`,
        });
    }
    const wanted = [
      ...domains.map(keys.backlog),
      ...domains.map(keys.queue),
      keys.policy(),
      ...sessions.map(keys.ended),
    ];
    const read = yield* source.readMany(wanted);
    const documents: Array<{ key: StateKey; stored: Stored }> = [];
    for (const [index, key] of wanted.entries()) {
      const stored = read[index];
      if (stored === undefined) continue;
      if (stored instanceof StoreUnreadable) return yield* unreadable(stored);
      if (stored.value !== null) documents.push({ key, stored });
    }
    return { domains, documents };
  });

/**
 * Refuse while anything could write the shared state behind the migration: a watcher of any
 * domain (its pid here, or its labelled terminal on any machine), a live delegate, or a queued
 * launch retry holding a claim.
 */
const refuseLive = (
  config: Config,
  source: StateStore,
  domains: readonly string[],
  documents: ReadonlyArray<{ key: StateKey; stored: Stored }>,
) =>
  Effect.gen(function* () {
    for (const domain of domains) {
      const watcher = yield* watcherInfo(config, domain);
      if (watcher.state !== "missing")
        return yield* new Refused({
          message: `${domain} has a live watcher (${[watcher.terminal, watcher.pid === undefined ? undefined : `pid ${watcher.pid}`].filter((part) => part !== undefined).join(", ")}); stop every watcher and delegate before migrating`,
        });
      const backlog = documents.find(({ key }) => key.kind === "backlog" && key.domain === domain)
        ?.stored.value as
        | { items?: Array<{ delegates?: Array<{ session?: unknown }> }> }
        | undefined;
      const sessions = new Set(
        (backlog?.items ?? []).flatMap((item) =>
          (item.delegates ?? []).flatMap((ref) =>
            typeof ref.session === "string" ? [ref.session] : [],
          ),
        ),
      );
      const live = yield* members(domain, sessions);
      if (live.length > 0)
        return yield* new Refused({
          message: `${domain} has live delegates: ${live.map((terminal) => `${terminal.name} (${terminal.address})`).join(", ")}; stop every watcher and delegate before migrating`,
        });
    }
    const claims = yield* source.heldClaims(domains);
    if (claims.length > 0)
      return yield* new Refused({
        message: `queued launch claims are held: ${claims.join(", ")}; let those retries finish before migrating`,
      });
  });

/**
 * Write one document to the target unless it already holds the same value; refuse when it holds
 * a different one.
 * @returns Whether it was written.
 */
const copyTo = (target: StateStore, session: StoreSession, key: StateKey, value: unknown) =>
  Effect.gen(function* () {
    const refusal = target.refusal(key);
    if (refusal !== undefined) return yield* new Refused({ message: refusal });
    const current = yield* session
      .read(key)
      .pipe(Effect.catchTag("StoreUnreadable", (error) => Effect.fail(unreadable(error))));
    if (isDeepStrictEqual(current.value, value)) return false;
    if (current.value !== null)
      return yield* new Refused({
        message: `${target.location(key)} already holds a different document; nothing was moved, so compare it with ${label(key)} and remove the stale one`,
      });
    yield* session.write(key, value, current.version);
    return true;
  });

const backupStamp = (now: Date) =>
  now
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

/**
 * Move each migrated source file into one backup folder under the state dir, keeping its path
 * relative to the state dir, and make it read-only.
 */
const backUp = (stateDir: string, paths: readonly string[], now: Date) =>
  Effect.promise(async () => {
    // A second migration in the same second gets its own folder rather than overwriting.
    let backup = join(stateDir, `files-backup-${backupStamp(now)}`);
    for (let attempt = 2; ; attempt += 1) {
      try {
        await mkdir(backup);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        backup = join(stateDir, `files-backup-${backupStamp(now)}-${attempt}`);
      }
    }
    for (const path of paths) {
      const moved = join(backup, relative(stateDir, path));
      await mkdir(dirname(moved), { recursive: true });
      await rename(path, moved);
      await chmod(moved, 0o444);
    }
    return backup;
  });

/**
 * `coordinate state migrate --to herdr-doc|files`: copy every backlog, queue, the harness policy
 * and every ended record between this machine's files and the home's document store, then retire
 * the source: files move into a read-only `files-backup-<stamp>` folder, home documents are set
 * to null. Runs on the home only (archives stay files there), refuses while a watcher, delegate
 * or queued retry is live, and never edits the config: the report says which line to set.
 * @param config Config; `state_home` names the home.
 * @param to Where the documents go.
 * @param now The time, for the backup folder's name.
 * @returns The report.
 */
export const migrateState = Effect.fn("migrateState")(function* (
  config: Config,
  to: MigrateTarget,
  now: Date = new Date(),
) {
  const home = homeStore(config);
  if (home === undefined || config.stateHome === undefined)
    return yield* new Refused({
      message: `state migrate needs state_home in ${configPath()}, the Herdr machine name of the home`,
    });
  const files = filesStore(config.stateDir);
  if (!(yield* home.archivesHere))
    return yield* new Refused({
      message: `archives stay files on the state home ${config.stateHome}; run coordinate state migrate on that machine`,
    });
  const [source, target] = to === "herdr-doc" ? [files, home] : [home, files];
  const { domains, documents } = yield* sourceDocuments(source, config.stateDir);
  yield* refuseLive(config, source, domains, documents);

  // The files side's lock directories are held throughout, so no files writer slips in between.
  const present = new Set<StateKey>();
  const locked = [...domains.map(keys.backlog), ...domains.map(keys.queue), keys.policy()];
  const copied = yield* files.exclusive(locked, (session) =>
    Effect.gen(function* () {
      const targetSession: StoreSession = to === "files" ? session : target;
      const sourceSession: StoreSession = to === "files" ? source : session;
      for (const { key, stored } of documents)
        if (!(yield* copyTo(target, targetSession, key, stored.value))) present.add(key);
      for (const { key, stored } of documents) {
        const landed = yield* readOne(target, key);
        if (!isDeepStrictEqual(landed.value, stored.value))
          return yield* new Refused({
            message: `${target.location(key)} does not hold what was copied; the source was left in place`,
          });
      }
      if (source.backend === "files")
        return yield* backUp(
          config.stateDir,
          documents.map(({ key }) => source.location(key)),
          now,
        );
      for (const { key, stored } of documents) {
        const current = yield* readOne(source, key);
        if (!isDeepStrictEqual(current.value, stored.value))
          return yield* new Refused({
            message: `${source.location(key)} changed while migrating; migrate again`,
          });
        yield* sourceSession.write(key, null, current.version);
      }
      return undefined;
    }),
  );

  const from = (store: StateStore) =>
    store.backend === "files" ? "files" : `herdr-doc on ${config.stateHome}`;
  return [
    `migrated shared state from ${from(source)} to ${from(target)}:`,
    ...documents.map(
      ({ key }) =>
        `  ${label(key)}: ${source.location(key)} -> ${target.location(key)}${present.has(key) ? " (already there)" : ""}`,
    ),
    `copied ${documents.length} document${documents.length === 1 ? "" : "s"}; no queued launch claim is held, and claims are never copied`,
    copied === undefined
      ? `cleared: the documents on ${config.stateHome} now hold null (Herdr keeps each name as a tombstone)`
      : `backup: the source files moved to ${copied}, read-only`,
    `archives, session state, the wiki lint clock and watcher files stay files in ${config.stateDir}`,
    `next: set "state_backend": "${to}" in ${configPath()} (migrate does not edit the config)`,
  ];
});
