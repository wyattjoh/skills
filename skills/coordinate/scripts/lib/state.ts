import { homedir } from "node:os";
import { relative } from "node:path";
import { Effect } from "effect";
import type { Config } from "./config.ts";
import { hcConnectTransport } from "./herdr-docs.ts";
import { coreName, execOn } from "./herdr.ts";
import { Proc } from "./proc.ts";
import { filesStore } from "./state-files.ts";
import { herdrStore, PRODUCTION_PREFIX } from "./state-herdr.ts";
import { BacklogError, type StateStore, StoreOffline } from "./state-store.ts";

const registered = new Map<string, StateStore>();

/**
 * Where the home keeps a state directory's archives: the same path relative to the home user's
 * HOME when it is under this user's HOME (so the default `~/.local/state/coordinate` maps to the
 * home's default), else the same absolute path.
 * @param stateDir This machine's state directory.
 * @param home This user's HOME.
 * @returns A shell word that expands to the home's backlogs folder.
 */
const homeBacklogsDir = (stateDir: string, home: string = homedir()): string => {
  const inside = relative(home, stateDir);
  const quoted = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  return inside.startsWith("..") || inside.startsWith("/")
    ? quoted(`${stateDir}/backlogs`)
    : `"$HOME"/${quoted(`${inside}/backlogs`)}`;
};

/**
 * The shell script that appends archive lines on the home: an O_APPEND write of a base64 payload
 * into the home's backlogs folder, made when missing.
 * @param stateDir This machine's state directory.
 * @param domain Domain.
 * @param lines Lines, without newlines.
 * @param home This user's HOME, which the state directory is relative to.
 * @returns A POSIX shell script.
 */
export const archiveAppendScript = (
  stateDir: string,
  domain: string,
  lines: readonly string[],
  home: string = homedir(),
): string => {
  const payload = Buffer.from(lines.map((line) => `${line}\n`).join("")).toString("base64");
  const dir = homeBacklogsDir(stateDir, home);
  return `set -e; mkdir -p ${dir}; printf %s '${payload}' | base64 -d >> ${dir}/'${domain}.archive.jsonl'`;
};

/**
 * Append archive lines on the home through `hc exec`: an O_APPEND shell write of a base64
 * payload, so concurrent appends from several machines never overwrite each other.
 */
const appendArchiveOn =
  (stateDir: string) => (home: string, domain: string, lines: readonly string[]) => {
    return execOn(home, archiveAppendScript(stateDir, domain, lines), 60).pipe(
      Effect.asVoid,
      Effect.provide(Proc.layer),
      Effect.mapError((error) =>
        error.kind === "unavailable" || error.kind === "machine_unknown" || error.kind === "spawn"
          ? new StoreOffline({
              home,
              message: `the state home ${home} is unreachable (${error.message}); shared state was not read or written`,
            })
          : new BacklogError({
              path: `${home}:${domain}.archive.jsonl`,
              message: `could not append to the archive on ${home}: ${error.message}`,
            }),
      ),
    );
  };

/**
 * Use the backend the config selects for its state directory. `main` calls this once after
 * loading the config; until then, and for any other state directory, the store is files.
 * @param config Loaded config.
 */
export const useStateBackend = (config: Config): void => {
  if (config.stateBackend !== "herdr-doc" || config.stateHome === undefined) {
    registered.delete(config.stateDir);
    return;
  }
  registered.set(
    config.stateDir,
    herdrStore({
      home: config.stateHome,
      prefix: PRODUCTION_PREFIX,
      transport: hcConnectTransport,
      self: coreName().pipe(Effect.provide(Proc.layer)),
      stateDir: config.stateDir,
      appendRemote: appendArchiveOn(config.stateDir),
    }),
  );
};

/**
 * The store that holds a state directory's shared documents: the one `useStateBackend`
 * registered for it, else the files backend.
 * @param stateDir Coordinate state directory.
 * @returns The store.
 */
export const stateStore = (stateDir: string): StateStore =>
  registered.get(stateDir) ?? filesStore(stateDir);
