import { homedir } from "node:os";
import { relative } from "node:path";
import { Effect } from "effect";
import type { Config } from "./config.ts";
import { hcConnectTransport } from "./herdr-docs.ts";
import { coreName, execOn, type HerdrError, readFileOn } from "./herdr.ts";
import { Proc } from "./proc.ts";
import { filesStore } from "./state-files.ts";
import { herdrStore, PRODUCTION_PREFIX } from "./state-herdr.ts";
import { BacklogError, type StateStore, StoreOffline } from "./state-store.ts";

const registered = new Map<string, StateStore>();

/**
 * Where coordinate's state lives on the home: `homeStateDir` from the config, else
 * this machine's `state_dir`.
 */
type HomePaths = { stateDir: string; homeStateDir: string | undefined };

const relativeToHome = (stateDir: string, home: string): string | undefined => {
  const inside = relative(home, stateDir);
  return inside.startsWith("..") || inside.startsWith("/") ? undefined : inside;
};

const quoted = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/**
 * The home's backlogs folder as a shell word: `home_state_dir` when the config names it, else
 * this machine's state path relative to its HOME under the home user's HOME (so the default
 * `~/.local/state/coordinate` maps to the home's default), else the same absolute path.
 */
const homeBacklogsDir = (paths: HomePaths, home: string): string => {
  if (paths.homeStateDir !== undefined) return quoted(`${paths.homeStateDir}/backlogs`);
  const inside = relativeToHome(paths.stateDir, home);
  return inside === undefined
    ? quoted(`${paths.stateDir}/backlogs`)
    : `"$HOME"/${quoted(`${inside}/backlogs`)}`;
};

/**
 * A domain's archive path on the home, by the same rule as `archiveAppendScript`.
 * @param paths This machine's state dir and the configured home state dir.
 * @param domain Domain.
 * @param remoteHome The home user's HOME.
 * @param home This user's HOME.
 * @returns The absolute path on the home.
 */
export const homeArchivePath = (
  paths: HomePaths,
  domain: string,
  remoteHome: string,
  home: string = homedir(),
): string => {
  const inside = relativeToHome(paths.stateDir, home);
  const stateDir =
    paths.homeStateDir ?? (inside === undefined ? paths.stateDir : `${remoteHome}/${inside}`);
  return `${stateDir}/backlogs/${domain}.archive.jsonl`;
};

/**
 * The shell script that appends archive lines on the home: an O_APPEND write of a base64 payload
 * into the home's backlogs folder, made when missing.
 * @param paths This machine's state dir and the configured home state dir.
 * @param domain Domain.
 * @param lines Lines, without newlines.
 * @param home This user's HOME, which the state directory is relative to.
 * @returns A POSIX shell script.
 */
export const archiveAppendScript = (
  paths: HomePaths,
  domain: string,
  lines: readonly string[],
  home: string = homedir(),
): string => {
  const payload = Buffer.from(lines.map((line) => `${line}\n`).join("")).toString("base64");
  const dir = homeBacklogsDir(paths, home);
  return `set -e; mkdir -p ${dir}; printf %s '${payload}' | base64 -d >> ${dir}/'${domain}.archive.jsonl'`;
};

/**
 * Append archive lines on the home through `hc exec`: an O_APPEND shell write of a base64
 * payload, so concurrent appends from several machines never overwrite each other.
 */
const appendArchiveOn =
  (paths: HomePaths) => (home: string, domain: string, lines: readonly string[]) =>
    execOn(home, archiveAppendScript(paths, domain, lines), 60).pipe(
      Effect.asVoid,
      Effect.provide(Proc.layer),
      Effect.mapError(homeFailure(home, domain, "append to")),
    );

const homeFailure =
  (home: string, domain: string, action: string) =>
  (error: HerdrError): StoreOffline | BacklogError =>
    error.kind === "unavailable" || error.kind === "machine_unknown" || error.kind === "spawn"
      ? new StoreOffline({
          home,
          message: `the state home ${home} is unreachable (${error.message}); shared state was not read or written`,
        })
      : new BacklogError({
          path: `${home}:${domain}.archive.jsonl`,
          message: `could not ${action} the archive on ${home}: ${error.message}`,
        });

/**
 * Read a domain's archive on the home with spec A's paged remote file reader. Without
 * `home_state_dir`, the home user's HOME is read first to place this machine's state path.
 */
const readArchiveOn = (paths: HomePaths) => (home: string, domain: string) =>
  Effect.gen(function* () {
    const remoteHome =
      paths.homeStateDir === undefined ? (yield* execOn(home, 'printf %s "$HOME"', 30)).trim() : "";
    return yield* readFileOn(home, homeArchivePath(paths, domain, remoteHome));
  }).pipe(Effect.provide(Proc.layer), Effect.mapError(homeFailure(home, domain, "read")));

/**
 * Use the backend the config selects for its state directory. `main` calls this once after
 * loading the config; until then, and for any other state directory, the store is files.
 * @param config Loaded config.
 */
export const useStateBackend = (config: Config): void => {
  const home = config.stateBackend === "herdr-doc" ? homeStore(config) : undefined;
  if (home === undefined) registered.delete(config.stateDir);
  else registered.set(config.stateDir, home);
};

/**
 * The herdr-doc store on the config's `state_home`, whichever backend the config selects, so
 * `state migrate` can reach it before the config is switched.
 * @param config Loaded config.
 * @returns The store, or undefined when the config names no home.
 */
export const homeStore = (config: Config): StateStore | undefined =>
  config.stateHome === undefined
    ? undefined
    : herdrStore({
        home: config.stateHome,
        prefix: PRODUCTION_PREFIX,
        transport: hcConnectTransport,
        self: coreName().pipe(Effect.provide(Proc.layer)),
        stateDir: config.stateDir,
        appendRemote: appendArchiveOn(config),
        readRemote: readArchiveOn(config),
      });

/**
 * The store that holds a state directory's shared documents: the one `useStateBackend`
 * registered for it, else the files backend.
 * @param stateDir Coordinate state directory.
 * @returns The store.
 */
export const stateStore = (stateDir: string): StateStore =>
  registered.get(stateDir) ?? filesStore(stateDir);
