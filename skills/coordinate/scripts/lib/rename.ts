import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { Effect, Result } from "effect";
import {
  archivePath,
  holdingLocks,
  readDocument,
  refSessions,
  writeAtomic,
  writeDocument,
} from "./backlog-doc.ts";
import { documentPath } from "./backlog-store/paths.ts";
import { type Config, configPath } from "./config.ts";
import { checkDomainName, L, members, readEnded, Refused, resolveDomain } from "./fleet.ts";
import * as hc from "./herdr.ts";
import { lockPath, watcherAlive } from "./watch-lock.ts";
import { statePath } from "./watch.ts";

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

const refuseExisting = (config: Config, from: string, to: string) =>
  Effect.gen(function* () {
    if (!existsSync(documentPath(config.stateDir, from)))
      return yield* new Refused({
        message: `no backlog for ${from} at ${documentPath(config.stateDir, from)}`,
      });
    for (const [what, path] of [
      ["a backlog", documentPath(config.stateDir, to)],
      ["an archive", archivePath(config.stateDir, to)],
    ] as const)
      if (existsSync(path))
        return yield* new Refused({ message: `${what} for ${to} already exists at ${path}` });
  });

/**
 * Copy a file to its new name with the atomic write, when it exists.
 * @returns The new path, or null when there was nothing to copy.
 */
const copyIfPresent = Effect.fn("copyIfPresent")(function* (source: string, target: string) {
  if (!existsSync(source)) return null;
  const text = yield* Effect.promise(() => readFile(source, "utf8"));
  yield* writeAtomic(target, text);
  return target;
});

const lines = (result: RenameResult): string[] => [
  `renamed ${result.from} to ${result.to}: backlog ${result.backlog}`,
  ...(result.archive ? [`  archive ${result.archive}`] : []),
  ...(result.snapshot ? [`  watcher snapshot ${result.snapshot}`] : []),
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
 * the new backlog (domain field set), archive and watcher snapshot, points ended-delegate records
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

  const result = yield* holdingLocks(
    config,
    [from, to],
    Effect.gen(function* () {
      yield* refuseExisting(config, from, to);
      yield* refuseLiveWatcher(config, from);
      const state = config.stateDir;
      const { backlog } = yield* readDocument(config, from);

      // New files first: until the old backlog is removed below, the old domain stays whole.
      const backlogPath = documentPath(state, to);
      yield* writeDocument(backlogPath, { ...backlog, domain: to });
      const archive = yield* copyIfPresent(archivePath(state, from), archivePath(state, to));
      const snapshot = yield* copyIfPresent(statePath(state, from), statePath(state, to));

      // In place: each ended record is rewritten whole, keeping fields this CLI does not read.
      const { records, skipped } = yield* readEnded(state);
      const ended: string[] = [];
      for (const { path, record } of records) {
        if (record.domain !== from) continue;
        const raw = yield* Effect.promise(async () => JSON.parse(await readFile(path, "utf8")));
        yield* writeAtomic(path, `${JSON.stringify({ ...raw, domain: to }, null, 1)}\n`);
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
      yield* Effect.promise(() => rm(documentPath(state, from), { force: true }));
      for (const path of [archivePath(state, from), statePath(state, from)])
        yield* Effect.promise(() => rm(path, { force: true }));
      const pidFile = lockPath(state, from);
      const stalePid = existsSync(pidFile) ? pidFile : null;
      if (stalePid) yield* Effect.promise(() => rm(stalePid, { force: true }));

      return {
        from,
        to,
        backlog: backlogPath,
        archive,
        snapshot,
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
