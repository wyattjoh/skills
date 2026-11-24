import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Effect } from "effect";
import { archivePath, backlogsDir, documentPath } from "./backlog-store/paths.ts";
import {
  BacklogError,
  ClaimBusy,
  claimHeld,
  type ListedKind,
  type StateKey,
  type StateStore,
  type StoreClaim,
  StoreConflict,
  type StoreSession,
  StoreUnreadable,
  type Version,
} from "./state-store.ts";

/**
 * The reserved backlog lock that serializes harness policy edits. It starts with "@", which cannot
 * be a domain name.
 */
const POLICY_LOCK_DOMAIN = "@delegate-harness-policy";

/**
 * Where the files backend keeps a document.
 * @param stateDir Coordinate state directory.
 * @param key Document.
 * @returns Its file path.
 */
export const filesPath = (stateDir: string, key: StateKey): string => {
  switch (key.kind) {
    case "backlog":
      return documentPath(stateDir, key.domain);
    case "policy":
      return join(stateDir, "delegate-harness-policy.json");
    case "queue":
      return join(stateDir, "capacity", `${key.domain}.json`);
    case "ended":
      return join(stateDir, "ended", `${key.session}.json`);
    case "session":
      return join(stateDir, "sessions", `${key.session}.json`);
    case "lint":
      return join(stateDir, "wiki-lint", `${key.domain}.json`);
  }
};

const listedDir = (stateDir: string, kind: ListedKind): string =>
  kind === "backlog" ? backlogsDir(stateDir) : join(stateDir, "ended");

/**
 * The backlog lock a document's writes take: a domain's backlog and capacity queue share the
 * domain's lock, the policy has its reserved one, and the rest were never locked.
 */
const lockDomain = (key: StateKey): string | undefined => {
  switch (key.kind) {
    case "backlog":
    case "queue":
      return key.domain;
    case "policy":
      return POLICY_LOCK_DOMAIN;
    default:
      return undefined;
  }
};

/**
 * Each document keeps the exact bytes it has always had on disk.
 */
const serialize = (key: StateKey, value: unknown): string => {
  switch (key.kind) {
    case "ended":
    case "session":
      return `${JSON.stringify(value, null, 1)}\n`;
    case "lint":
      return `${JSON.stringify(value)}\n`;
    default:
      return `${JSON.stringify(value, null, 2)}\n`;
  }
};

const ABSENT = "absent" as Version;

const versionOf = (text: string | null): Version =>
  text === null ? ABSENT : (`sha256:${createHash("sha256").update(text).digest("hex")}` as Version);

const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const readText = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
};

/**
 * Write a file durably: a temp file in the same folder, fsync, rename, then fsync the folder.
 */
const commitText = async (path: string, text: string): Promise<void> => {
  const dir = join(path, "..");
  const temp = join(dir, `.${randomUUID()}.tmp`);
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(text);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
  const parent = await open(dir, "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
};

/**
 * A lock left by a writer that died on this host is moved aside to a name unique to its token,
 * never deleted, so two recoveries cannot remove a lock a third writer just took.
 */
const recoverDeadWriter = async (lock: string): Promise<void> => {
  let owner: { pid: unknown; token: unknown; hostname: unknown };
  try {
    owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
  } catch {
    return;
  }
  if (
    owner.hostname !== hostname() ||
    typeof owner.token !== "string" ||
    !/^[a-f0-9-]{36}$/.test(owner.token) ||
    typeof owner.pid !== "number" ||
    !Number.isInteger(owner.pid) ||
    owner.pid <= 0
  )
    return;
  try {
    process.kill(owner.pid, 0);
    return;
  } catch (error) {
    if (!hasCode(error, "ESRCH")) return;
  }
  try {
    await rename(lock, `${lock}.abandoned-${owner.token}`);
  } catch (error) {
    if (!["ENOENT", "EEXIST", "ENOTEMPTY"].some((code) => hasCode(error, code))) throw error;
  }
};

/**
 * Take the domain's exclusive write lock (a directory next to the document).
 * @returns The lock directory, for `dropLock`.
 */
const takeLock = async (path: string, timeoutMs: number): Promise<string> => {
  const lock = path.replace(/\.json$/, ".lock");
  await mkdir(join(path, ".."), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      if (Date.now() >= deadline)
        throw new Error(`backlog lock timed out: ${lock}; inspect its owner.json`, {
          cause: error,
        });
      await recoverDeadWriter(lock);
      await sleep(Math.min(25, Math.max(1, deadline - Date.now())));
    }
  }
  const owner = join(lock, "owner.json");
  try {
    const file = await open(owner, "wx", 0o600);
    try {
      await file.writeFile(
        JSON.stringify({
          pid: process.pid,
          token: randomUUID(),
          hostname: hostname(),
          createdAt: new Date().toISOString(),
        }),
      );
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (error) {
    await dropLock(lock);
    throw error;
  }
  return lock;
};

const dropLock = async (lock: string): Promise<void> => {
  await unlink(join(lock, "owner.json")).catch(() => undefined);
  await rmdir(lock);
};

// A burst of writers serializes fsync-backed commits, so allow time for a loaded filesystem.
const LOCK_TIMEOUT_MS = 30_000;

const failure = (path: string) => (cause: unknown) =>
  new BacklogError({ path, message: message(cause) });

const claimPath = (stateDir: string, domain: string, item: string): string =>
  join(stateDir, "capacity", "claims", `${domain}-${item}.lock`);

// Files claims carry no expiry, so a claim from another host stays held.
const isHeld = (host: string, pid: number): boolean =>
  claimHeld(
    { host, pid, expires: undefined },
    { host: hostname(), now: Date.now(), foreignWithoutExpiry: true },
  );

const acquireClaim = async (path: string): Promise<StoreClaim> => {
  await mkdir(join(path, ".."), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(path, { mode: 0o700 });
      const token = randomUUID();
      const owner = await open(join(path, "owner.json"), "wx", 0o600);
      try {
        await owner.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), token }));
        await owner.sync();
      } finally {
        await owner.close();
      }
      return { location: path, token };
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        await rm(path, { recursive: true, force: true });
        throw error;
      }
      let current: { pid?: unknown; hostname?: unknown; token?: unknown };
      try {
        current = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
      } catch (cause) {
        throw new Error(`queued launch claim is unreadable: ${path}`, { cause });
      }
      if (
        current.hostname !== hostname() ||
        typeof current.pid !== "number" ||
        !Number.isInteger(current.pid) ||
        current.pid <= 0 ||
        typeof current.token !== "string"
      )
        throw new Error(`queued launch claim has an invalid owner: ${path}`, { cause: error });
      if (isHeld(current.hostname, current.pid))
        throw new Error(`queued item is already being retried (pid ${current.pid})`, {
          cause: error,
        });
      const abandoned = `${path}.abandoned-${current.token}`;
      try {
        await rename(path, abandoned);
      } catch (renameError) {
        if (!hasCode(renameError, "ENOENT") && !hasCode(renameError, "EEXIST")) throw renameError;
      }
    }
  }
  throw new Error(`could not acquire queued launch claim: ${path}`);
};

/**
 * Every claim folder whose owner is not known to have died on this host.
 */
const heldClaimFiles = async (stateDir: string): Promise<string[]> => {
  const dir = join(stateDir, "capacity", "claims");
  const names = (await readdir(dir).catch((): string[] => [])).filter((name) =>
    name.endsWith(".lock"),
  );
  const held: string[] = [];
  for (const name of names.toSorted()) {
    const path = join(dir, name);
    const owner = await readFile(join(path, "owner.json"), "utf8")
      .then((text) => JSON.parse(text) as { pid?: unknown; hostname?: unknown })
      .catch(() => undefined);
    if (
      owner === undefined ||
      typeof owner.pid !== "number" ||
      isHeld(String(owner.hostname), owner.pid)
    )
      held.push(path);
  }
  return held;
};

const releaseClaim = async (claim: StoreClaim): Promise<void> => {
  try {
    const owner = JSON.parse(await readFile(join(claim.location, "owner.json"), "utf8")) as {
      token?: unknown;
    };
    if (owner.token === claim.token) await rm(claim.location, { recursive: true, force: true });
  } catch {
    // A replaced or removed claim belongs to its new owner, not this release.
  }
};

/**
 * Write a local file that is not a shared document (an archive or watcher snapshot) with the same
 * durable write the documents use: temp file, fsync, rename.
 * @param path File.
 * @param text Contents.
 */
export const writeFileAtomic = (path: string, text: string): Effect.Effect<void, BacklogError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true });
      await commitText(path, text);
    },
    catch: failure(path),
  });

/**
 * Append lines to a local archive file and fsync it. Runs before the document is committed, so a
 * crash between the two repeats a line rather than losing a record.
 * @param path Archive file.
 * @param lines Lines, without newlines.
 */
export const appendArchiveFile = (
  path: string,
  lines: readonly string[],
): Effect.Effect<void, BacklogError> =>
  lines.length === 0
    ? Effect.void
    : Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(path), { recursive: true });
          await appendFile(path, lines.map((line) => `${line}\n`).join(""), { mode: 0o600 });
          const file = await open(path, "r");
          try {
            await file.sync();
          } finally {
            await file.close();
          }
        },
        catch: failure(path),
      });

/**
 * Read a local archive file whole.
 * @param path Archive file.
 * @returns Its text, or undefined when there is none.
 */
export const readArchiveFile = (path: string): Effect.Effect<string | undefined, BacklogError> =>
  Effect.tryPromise({
    try: async () => (await readText(path)) ?? undefined,
    catch: failure(path),
  });

/**
 * Today's state files as a store: one JSON file per document under the state directory, written
 * with a temp file, fsync and rename, under the backlog lock directories the documents have always
 * used. A version is a hash of the file's bytes, so it detects any change between a read and a
 * write except a rewrite of identical bytes, which changes nothing.
 * @param stateDir Coordinate state directory.
 * @returns The store.
 */
export const filesStore = (stateDir: string): StateStore => {
  const location = (key: StateKey) => filesPath(stateDir, key);

  const read = (key: StateKey) =>
    Effect.gen(function* () {
      const path = location(key);
      const text = yield* Effect.tryPromise({
        try: () => readText(path),
        catch: (cause) =>
          new StoreUnreadable({
            location: path,
            stage: "read",
            message: message(cause),
            detail: String(cause),
            version: null,
          }),
      });
      if (text === null) return { value: null, version: ABSENT };
      try {
        return { value: JSON.parse(text) as unknown, version: versionOf(text) };
      } catch (cause) {
        return yield* new StoreUnreadable({
          location: path,
          stage: "parse",
          message: message(cause),
          detail: String(cause),
          version: versionOf(text),
        });
      }
    });

  /**
   * The version check and write, for a caller that already holds the document's lock (or a
   * document that has none).
   */
  const writeHeld = (key: StateKey, value: unknown, expected: Version) =>
    Effect.gen(function* () {
      const path = location(key);
      const current = yield* Effect.tryPromise({ try: () => readText(path), catch: failure(path) });
      if (versionOf(current) !== expected) return yield* new StoreConflict({ location: path });
      if (value === null) {
        yield* Effect.tryPromise({ try: () => rm(path, { force: true }), catch: failure(path) });
        return ABSENT;
      }
      const text = serialize(key, value);
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(path), { recursive: true });
          await commitText(path, text);
        },
        catch: failure(path),
      });
      return versionOf(text);
    });

  const exclusive = <A, E, R>(
    held: readonly StateKey[],
    use: (session: StoreSession) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | BacklogError, R> => {
    const domains = [
      ...new Set(held.map(lockDomain).filter((domain) => domain !== undefined)),
    ].toSorted();
    const holding = new Set(domains);
    const session: StoreSession = {
      read,
      write: (key, value, expected) => {
        const domain = lockDomain(key);
        return domain === undefined || holding.has(domain)
          ? writeHeld(key, value, expected)
          : write(key, value, expected);
      },
    };
    // Taken in name order, so two callers locking the same pair cannot deadlock, and released in
    // reverse.
    return domains.reduceRight<Effect.Effect<A, E | BacklogError, R>>((inner, domain) => {
      const path = documentPath(stateDir, domain);
      return Effect.acquireUseRelease(
        Effect.tryPromise({ try: () => takeLock(path, LOCK_TIMEOUT_MS), catch: failure(path) }),
        () => inner,
        (lock) => Effect.promise(() => dropLock(lock)),
      );
    }, use(session));
  };

  const write = (
    key: StateKey,
    value: unknown,
    expected: Version,
  ): Effect.Effect<Version, StoreConflict | BacklogError> =>
    lockDomain(key) === undefined
      ? writeHeld(key, value, expected)
      : exclusive([key], () => writeHeld(key, value, expected));

  return {
    backend: "files",
    location,
    refusal: () => undefined,
    read,
    readMany: (wanted) =>
      Effect.forEach(wanted, (key) =>
        read(key).pipe(Effect.catchTag("StoreUnreadable", (error) => Effect.succeed(error))),
      ),
    write,
    appendArchive: (domain, lines) => appendArchiveFile(archivePath(stateDir, domain), lines),
    archivesHere: Effect.succeed(true),
    readArchive: (domain) => readArchiveFile(archivePath(stateDir, domain)),
    list: (kind) =>
      Effect.promise(async () =>
        (await readdir(listedDir(stateDir, kind)).catch((): string[] => []))
          .filter((name) => name.endsWith(".json"))
          .toSorted()
          .map((name) => name.slice(0, -".json".length)),
      ),
    exclusive,
    claim: (domain, item) =>
      Effect.tryPromise({
        try: () => acquireClaim(claimPath(stateDir, domain, item)),
        catch: (cause) => new ClaimBusy({ message: message(cause) }),
      }),
    release: (claim) => Effect.promise(() => releaseClaim(claim)),
    heldClaims: () => Effect.promise(() => heldClaimFiles(stateDir)),
  };
};
