import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, open, readFile, rename, rmdir, unlink } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Effect, Option, Schema } from "effect";
import {
  addBoundary,
  addFinding,
  addItem,
  addPolicy,
  type BoundaryList,
  closeFinding,
  closeItem,
  emptyBacklog,
  fileDelegate,
  idleDelegated,
  type ItemUpdate,
  type OpResult,
  removeBoundary,
  removePolicy,
  replacePolicy,
  RETAINED_CLOSED,
  retain,
  setFocus,
  unfileable,
  unfileDelegate,
  updateItem,
} from "./backlog-store/ops.ts";
import { backlogsDir, documentPath } from "./backlog-store/paths.ts";
import { renderBacklog } from "./backlog-store/render.ts";
import {
  type Backlog,
  type DelegateRef,
  type Finding,
  type Item,
  validateBacklog,
} from "./backlog-store/schema.ts";
import type { Config } from "./config.ts";
import { backlogPath, members, Refused } from "./fleet.ts";

/**
 * The backlog document could not be read, locked or written (exit 2, not a refusal).
 */
export class BacklogError extends Schema.TaggedError<BacklogError>()("BacklogError", {
  path: Schema.String,
  message: Schema.String,
}) {}

const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

const parse = (path: string, json: string): Backlog => {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (cause) {
    throw new Error(`${path} is not JSON: ${String(cause)}`, { cause });
  }
  const checked = validateBacklog(value);
  if (!checked.ok) throw new Error(`${path} is invalid: ${checked.errors.join("; ")}`);
  return checked.backlog;
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

const commit = (path: string, backlog: Backlog): Promise<void> =>
  commitText(path, `${JSON.stringify(backlog, null, 2)}\n`);

/**
 * The domain's append-only archive of closed records, one JSON record per line.
 * @param stateDir State dir.
 * @param domain Domain.
 * @returns Path.
 */
export const archivePath = (stateDir: string, domain: string): string =>
  join(backlogsDir(stateDir), `${domain}.archive.jsonl`);

/**
 * Append records to the archive and fsync it. Runs before the document is committed, so a crash
 * between the two repeats a line rather than losing a record.
 */
const appendArchive = async (path: string, records: unknown[]): Promise<void> => {
  if (records.length === 0) return;
  await appendFile(path, records.map((record) => `${JSON.stringify(record)}\n`).join(""), {
    mode: 0o600,
  });
  const file = await open(path, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
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

/**
 * Run an operation holding the domain's exclusive write lock.
 */
const locked = async <A>(path: string, timeoutMs: number, operation: () => Promise<A>) => {
  const lock = await takeLock(path, timeoutMs);
  try {
    return await operation();
  } finally {
    await dropLock(lock);
  }
};

// A burst of writers serializes fsync-backed commits, so allow time for a loaded filesystem.
const LOCK_TIMEOUT_MS = 30_000;

const failure = (path: string) => (cause: unknown) =>
  new BacklogError({ path, message: cause instanceof Error ? cause.message : String(cause) });

/**
 * Run an effect holding the backlog locks of several domains. They are taken in name order, so two
 * callers locking the same pair cannot deadlock, and released in reverse.
 * @param config Config.
 * @param domains Domains to lock.
 * @param effect What to run under the locks.
 * @returns The effect's value.
 */
export const holdingLocks = <A, E, R>(
  config: Config,
  domains: readonly string[],
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | BacklogError, R> =>
  [...new Set(domains)]
    .toSorted()
    .reduceRight<Effect.Effect<A, E | BacklogError, R>>((inner, domain) => {
      const path = documentPath(config.stateDir, domain);
      return Effect.acquireUseRelease(
        Effect.tryPromise({ try: () => takeLock(path, LOCK_TIMEOUT_MS), catch: failure(path) }),
        () => inner,
        (lock) => Effect.promise(() => dropLock(lock)),
      );
    }, effect);

/**
 * Write a file with the backlog's atomic write (temp file, fsync, rename). The caller holds the lock.
 * @param path File.
 * @param text Contents.
 */
export const writeAtomic = Effect.fn("writeAtomic")(function* (path: string, text: string) {
  yield* Effect.tryPromise({ try: () => commitText(path, text), catch: failure(path) });
});

/**
 * Write a whole document atomically, validated first. The caller holds the domain's lock.
 * @param path Document path.
 * @param backlog Document.
 */
export const writeDocument = Effect.fn("writeDocument")(function* (path: string, backlog: Backlog) {
  const checked = validateBacklog(backlog);
  if (!checked.ok) return yield* new Refused({ message: checked.errors.join("; ") });
  yield* Effect.tryPromise({ try: () => commit(path, checked.backlog), catch: failure(path) });
});

/**
 * Create the domain's document when it is missing. An existing document is left untouched.
 * @param config Config.
 * @param domain Domain.
 * @returns The path, whether it was created, and the legacy Markdown path recorded.
 */
export const createDocument = Effect.fn("createDocument")(function* (
  config: Config,
  domain: string,
) {
  const path = documentPath(config.stateDir, domain);
  const markdown = backlogPath(config.backlogDir, domain);
  return yield* Effect.tryPromise({
    try: () =>
      locked(path, LOCK_TIMEOUT_MS, async () => {
        if (existsSync(path)) return { path, created: false, legacy: null };
        const legacy = existsSync(markdown) ? markdown : null;
        await commit(path, emptyBacklog(domain, legacy));
        return { path, created: true, legacy };
      }),
    catch: failure(path),
  });
});

/**
 * Seed the backlog of a coordinator about to start, in one write under the lock: create the
 * document when missing, add the folder to the owned Boundary when absent, and add each title as an
 * open item. A refused step writes nothing, and an unchanged document is not rewritten.
 * @param config Config.
 * @param domain Domain.
 * @param input The owned folder, the item titles, and the time as an ISO string.
 * @returns The path, whether the document was created, whether the folder was added, and the items.
 */
export const seedDocument = Effect.fn("seedDocument")(function* (
  config: Config,
  domain: string,
  input: { owned: string; titles: readonly string[]; now: string },
) {
  const path = documentPath(config.stateDir, domain);
  const markdown = backlogPath(config.backlogDir, domain);
  const result = yield* Effect.tryPromise({
    try: () =>
      locked(path, LOCK_TIMEOUT_MS, async () => {
        const created = !existsSync(path);
        const current = created
          ? emptyBacklog(domain, existsSync(markdown) ? markdown : null)
          : parse(path, await readFile(path, "utf8"));
        const bounded = addBoundary(current, { path: input.owned, list: "owned" });
        if (!bounded.ok) return { ok: false as const, reason: bounded.reason };
        const seeded = input.titles.reduce<OpResult<Item[]>>(
          (previous, title) => {
            if (!previous.ok) return previous;
            const added = addItem(previous.backlog, { title, now: input.now });
            if (!added.ok) return added;
            return { ok: true, backlog: added.backlog, value: [...previous.value, added.value] };
          },
          { ok: true, backlog: bounded.backlog, value: [] },
        );
        if (!seeded.ok) return { ok: false as const, reason: seeded.reason };
        const value = { path, created, added: bounded.value.added, items: seeded.value };
        if (!created && !bounded.value.added && seeded.value.length === 0)
          return { ok: true as const, value };
        const checked = validateBacklog(seeded.backlog);
        if (!checked.ok) return { ok: false as const, reason: checked.errors.join("; ") };
        await commit(path, checked.backlog);
        return { ok: true as const, value };
      }),
    catch: failure(path),
  });
  if (!result.ok) return yield* new Refused({ message: result.reason });
  return result.value;
});

/**
 * Read and validate the domain's document.
 * @param config Config.
 * @param domain Domain.
 * @returns The document and its path; refused when missing, a `BacklogError` when unreadable.
 */
export const readDocument = Effect.fn("readDocument")(function* (config: Config, domain: string) {
  const path = documentPath(config.stateDir, domain);
  if (!existsSync(path))
    return yield* new Refused({
      message: `no backlog for ${domain} at ${path}; run coordinate start ${domain}`,
    });
  const backlog = yield* Effect.tryPromise({
    try: async () => parse(path, await readFile(path, "utf8")),
    catch: failure(path),
  });
  return { path, backlog };
});

/**
 * Apply a pure operation under the lock: read, apply, validate, archive closed records beyond the
 * newest `RETAINED_CLOSED`, write. A refused operation or an invalid result writes nothing.
 * @param config Config.
 * @param domain Domain.
 * @param operation Pure operation.
 * @returns The operation's value.
 */
const change = <A>(config: Config, domain: string, operation: (backlog: Backlog) => OpResult<A>) =>
  Effect.gen(function* () {
    const path = documentPath(config.stateDir, domain);
    if (!existsSync(path))
      return yield* new Refused({
        message: `no backlog for ${domain} at ${path}; run coordinate start ${domain}`,
      });
    const result = yield* Effect.tryPromise({
      try: () =>
        locked(path, LOCK_TIMEOUT_MS, async () => {
          const applied = operation(parse(path, await readFile(path, "utf8")));
          if (!applied.ok) return { ok: false as const, reason: applied.reason };
          const checked = validateBacklog(applied.backlog);
          if (!checked.ok) return { ok: false as const, reason: checked.errors.join("; ") };
          const kept = retain(checked.backlog, RETAINED_CLOSED);
          await appendArchive(archivePath(config.stateDir, domain), kept.archived);
          await commit(path, kept.backlog);
          return { ok: true as const, value: applied.value };
        }),
      catch: failure(path),
    });
    if (!result.ok) return yield* new Refused({ message: result.reason });
    return result.value;
  });

const json = (value: unknown): string[] => [JSON.stringify(value, null, 2)];

/**
 * `coordinate backlog show`: the document rendered as Markdown, or printed as JSON.
 * @param config Config.
 * @param domain Domain.
 * @param asJson Print the document instead.
 * @param live Session ids of the live delegates when the caller already has them; otherwise
 * they are read, only when an item is delegated. Unreadable liveness marks nothing.
 * @param showDone Include closed items in text output; JSON output is unchanged.
 * @param verbose Render full context, options and recommendations for answered asks.
 * @returns Lines to print.
 */
export const showBacklog = Effect.fn("showBacklog")(function* (
  config: Config,
  domain: string,
  asJson: boolean,
  live: ReadonlySet<string> | undefined = undefined,
  showDone = false,
  verbose = false,
) {
  const { backlog } = yield* readDocument(config, domain);
  if (asJson) return json(backlog);
  const sessions =
    live ??
    (backlog.items.some((item) => item.status === "delegated")
      ? yield* members(domain, yield* refSessions(config, domain)).pipe(
          Effect.map((found) => new Set(found.map((delegate) => delegate.session))),
          Effect.catch(() => Effect.succeed(undefined)),
        )
      : undefined);
  const idle = sessions ? idleDelegated(backlog, sessions).map((item) => item.id) : [];
  return [renderBacklog(backlog, new Set(idle), showDone, verbose).trimEnd()];
});

/**
 * `coordinate item add`: add an open item.
 * @param config Config.
 * @param domain Domain.
 * @param input Title, `--json`, and the time.
 * @returns Lines to print.
 */
export const itemAdd = Effect.fn("itemAdd")(function* (
  config: Config,
  domain: string,
  input: { title: string; json: boolean; now: string },
) {
  const item = yield* change(config, domain, (backlog) =>
    addItem(backlog, { title: input.title, now: input.now }),
  );
  return input.json ? json(item) : [`added ${item.id}: ${item.title}`];
});

/**
 * `coordinate item close`: close an item as done or dismissed with an outcome.
 * @param config Config.
 * @param domain Domain.
 * @param input Item id, outcome, `--dismissed`, `--json`, and the time.
 * @returns Lines to print.
 */
export const itemClose = Effect.fn("itemClose")(function* (
  config: Config,
  domain: string,
  input: { id: string; outcome: string; dismissed: boolean; json: boolean; now: string },
) {
  const item = yield* change(config, domain, (backlog) =>
    closeItem(backlog, {
      id: input.id,
      outcome: input.outcome,
      dismissed: input.dismissed,
      now: input.now,
    }),
  );
  return input.json ? json(item) : [`${item.status} ${item.id}: ${item.outcome ?? ""}`];
});

/**
 * `coordinate finding add`: record an open issue or opportunity. Delegates may run it.
 * @param config Config.
 * @param domain Domain.
 * @param input Kind, title, optional detail, path and source item, and `--json`.
 * @returns Lines to print.
 */
export const findingAdd = Effect.fn("findingAdd")(function* (
  config: Config,
  domain: string,
  input: {
    kind: Finding["kind"];
    title: string;
    detail: string | undefined;
    path: string | undefined;
    from: string | undefined;
    json: boolean;
  },
) {
  const finding = yield* change(config, domain, (backlog) =>
    addFinding(backlog, {
      kind: input.kind,
      title: input.title,
      detail: input.detail,
      path: input.path,
      from: input.from,
    }),
  );
  return input.json ? json(finding) : [`added ${finding.id}: ${finding.title}`];
});

/**
 * `coordinate finding close`: close a finding as acted on (or dismissed) with an outcome.
 * @param config Config.
 * @param domain Domain.
 * @param input Finding id, outcome, `--dismissed`, `--json`, and the time.
 * @returns Lines to print.
 */
export const findingClose = Effect.fn("findingClose")(function* (
  config: Config,
  domain: string,
  input: { id: string; outcome: string; dismissed: boolean; json: boolean; now: string },
) {
  const finding = yield* change(config, domain, (backlog) =>
    closeFinding(backlog, {
      id: input.id,
      outcome: input.outcome,
      dismissed: input.dismissed,
      now: input.now,
    }),
  );
  return input.json ? json(finding) : [`${finding.status} ${finding.id}: ${finding.outcome ?? ""}`];
});

/**
 * `coordinate item update`: change an item's status, touches, due date, decisions or ask.
 * @param config Config.
 * @param domain Domain.
 * @param input The changes, `--json`, and the time.
 * @returns Lines to print.
 */
export const itemUpdate = Effect.fn("itemUpdate")(function* (
  config: Config,
  domain: string,
  input: ItemUpdate & { json: boolean },
) {
  const item = yield* change(config, domain, (backlog) => updateItem(backlog, input));
  return input.json ? json(item) : [`updated ${item.id} [${item.status}] ${item.title}`];
});

/**
 * A Boundary path as stored: `~` expanded, made absolute, trailing slashes dropped.
 * @param path Path as given.
 * @param home Home directory for `~`.
 * @returns The stored form; an empty or multi-line path is returned as given, for the op to refuse.
 */
const normalizeBoundary = (path: string, home: string = homedir()): string => {
  if (path.trim() === "" || /[\r\n]/.test(path)) return path.trim() === "" ? "" : path;
  const expanded = path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
  const absolute = resolve(expanded);
  return absolute === "/" ? absolute : absolute.replace(/\/+$/, "");
};

/**
 * `coordinate backlog boundary add`: add an existing path to the owned (or adjacent) Boundary.
 * @param config Config.
 * @param domain Domain.
 * @param input Path, `--adjacent`, `--json`, and whether the caller is outside a Herdr terminal.
 * @returns Lines to print.
 */
export const boundaryAdd = Effect.fn("boundaryAdd")(function* (
  config: Config,
  domain: string,
  input: { path: string; adjacent: boolean; json: boolean; outsideTerminal: boolean },
) {
  const path = normalizeBoundary(input.path);
  const list: BoundaryList = input.adjacent ? "adjacent" : "owned";
  if (path.startsWith("/") && !/[\r\n]/.test(path) && !existsSync(path))
    return yield* new Refused({ message: `${path} does not exist` });
  let boundary: Backlog["boundary"] | undefined;
  const result = yield* change(config, domain, (backlog) => {
    const applied = addBoundary(backlog, { path, list });
    if (!applied.ok) return applied;
    if (input.outsideTerminal && !applied.value.added)
      return { ok: false as const, reason: `${path} is already in the ${list} Boundary` };
    boundary = applied.backlog.boundary;
    return applied;
  });
  if (input.json) return json(boundary);
  return [result.added ? `${list}: added ${path}` : `${list}: ${path} is already listed`];
});

/**
 * `coordinate backlog boundary rm`: remove a path from the owned (or adjacent) Boundary.
 * @param config Config.
 * @param domain Domain.
 * @param input Path, `--adjacent`, `--json`, and whether the caller is outside a Herdr terminal.
 * @returns Lines to print.
 */
export const boundaryRm = Effect.fn("boundaryRm")(function* (
  config: Config,
  domain: string,
  input: { path: string; adjacent: boolean; json: boolean; outsideTerminal: boolean },
) {
  const path = normalizeBoundary(input.path);
  const list: BoundaryList = input.adjacent ? "adjacent" : "owned";
  let boundary: Backlog["boundary"] | undefined;
  yield* change(config, domain, (backlog) => {
    const other: BoundaryList = list === "owned" ? "adjacent" : "owned";
    const selected =
      input.outsideTerminal &&
      !backlog.boundary[list].includes(path) &&
      backlog.boundary[other].includes(path)
        ? other
        : list;
    const applied = removeBoundary(backlog, { path, list: selected });
    if (applied.ok) boundary = applied.backlog.boundary;
    return applied;
  });
  return input.json ? json(boundary) : [`${list}: removed ${path}`];
});

/**
 * `coordinate backlog policy ls`: list policies in document order.
 * @param config Config.
 * @param domain Domain.
 * @param asJson Print the policies as JSON.
 * @returns Lines to print.
 */
export const policyLs = Effect.fn("policyLs")(function* (
  config: Config,
  domain: string,
  asJson: boolean,
) {
  const { backlog } = yield* readDocument(config, domain);
  return asJson
    ? json(backlog.policies)
    : backlog.policies.length === 0
      ? ["(none)"]
      : backlog.policies.map(({ id, at, text }) => `${id} ${at}: ${text}`);
});

/**
 * `coordinate backlog policy add`: add a reusable policy with its date.
 * @param config Config.
 * @param domain Domain.
 * @param input Text, `--at`, `--json`, and the time.
 * @returns Lines to print.
 */
export const policyAdd = Effect.fn("policyAdd")(function* (
  config: Config,
  domain: string,
  input: { text: string; at: string | undefined; json: boolean; now: string },
) {
  const policy = yield* change(config, domain, (backlog) =>
    addPolicy(backlog, { text: input.text, at: input.at ?? input.now.slice(0, 10) }),
  );
  return input.json ? json(policy) : [`added policy ${policy.id}: ${policy.text}`];
});

/**
 * `coordinate backlog policy rm`: remove a policy by id.
 * @param config Config.
 * @param domain Domain.
 * @param input Policy id and `--json`.
 * @returns Lines to print.
 */
export const policyRm = Effect.fn("policyRm")(function* (
  config: Config,
  domain: string,
  input: { id: string; json: boolean },
) {
  const policy = yield* change(config, domain, (backlog) => removePolicy(backlog, input.id));
  return input.json ? json(policy) : [`removed policy ${policy.id}: ${policy.text}`];
});

/**
 * `coordinate backlog policy replace`: replace text and date while preserving the id.
 * @param config Config.
 * @param domain Domain.
 * @param input Policy id, text, `--at`, `--json`, and the time.
 * @returns Lines to print.
 */
export const policyReplace = Effect.fn("policyReplace")(function* (
  config: Config,
  domain: string,
  input: { id: string; text: string; at: string | undefined; json: boolean; now: string },
) {
  const policy = yield* change(config, domain, (backlog) =>
    replacePolicy(backlog, {
      id: input.id,
      text: input.text,
      at: input.at ?? input.now.slice(0, 10),
    }),
  );
  return input.json ? json(policy) : [`replaced policy ${policy.id}: ${policy.text}`];
});

/**
 * `coordinate backlog focus`: set the domain's focus line, or clear it with null.
 * @param config Config.
 * @param domain Domain.
 * @param input Focus line or null, `--json`.
 * @returns Lines to print.
 */
export const focusSet = Effect.fn("focusSet")(function* (
  config: Config,
  domain: string,
  input: { focus: string | null; json: boolean },
) {
  const focus = yield* change(config, domain, (backlog) =>
    setFocus(backlog, { focus: input.focus }),
  );
  if (input.json) return json({ focus });
  return [focus === null ? "focus cleared" : `focus: ${focus}`];
});

/**
 * Refuse, before anything is created, an item a delegate cannot be filed under.
 * @param config Config.
 * @param domain Domain.
 * @param id Item id.
 */
export const checkFileable = Effect.fn("checkFileable")(function* (
  config: Config,
  domain: string,
  id: string,
) {
  const { backlog } = yield* readDocument(config, domain);
  const problem = unfileable(backlog, id);
  if (problem) return yield* new Refused({ message: problem });
});

/**
 * Record a delegate ref on an item and set the item to delegated.
 * @param config Config.
 * @param domain Domain.
 * @param input Item id and the delegate ref.
 * @returns The updated item.
 */
export const recordDelegate = Effect.fn("recordDelegate")(function* (
  config: Config,
  domain: string,
  input: { id: string; ref: DelegateRef },
) {
  return yield* change(config, domain, (backlog) => fileDelegate(backlog, input));
});

/**
 * Remove a delegate ref from an item, matched by session id or name; an item left delegated with
 * no delegates goes back to open.
 * @param config Config.
 * @param domain Domain.
 * @param input Item id, and the delegate's session id or name.
 * @returns The updated item and the removed ref.
 */
export const releaseDelegate = Effect.fn("releaseDelegate")(function* (
  config: Config,
  domain: string,
  input: { id: string; key: string },
) {
  return yield* change(config, domain, (backlog) => unfileDelegate(backlog, input));
});

/**
 * The session ids every item's delegate refs name, or an empty set when the domain has no document.
 * @param config Config.
 * @param domain Domain.
 * @returns Session ids.
 */
export const refSessions = Effect.fn("refSessions")(function* (config: Config, domain: string) {
  const read = yield* readDocument(config, domain).pipe(Effect.option);
  if (Option.isNone(read)) return new Set<string>();
  return new Set(
    read.value.backlog.items.flatMap((item) => item.delegates.map((ref) => ref.session)),
  );
});
