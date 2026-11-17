import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, open, readFile, rename, rmdir, unlink } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Effect, Schema } from "effect";
import {
  addBoundary,
  addFinding,
  addItem,
  addStanding,
  type BoundaryList,
  closeFinding,
  closeItem,
  emptyBacklog,
  type ItemUpdate,
  type OpResult,
  removeBoundary,
  RETAINED_CLOSED,
  retain,
  setFocus,
  updateItem,
} from "./backlog-store/ops.ts";
import { renderBacklog } from "./backlog-store/render.ts";
import { type Backlog, type Finding, validateBacklog } from "./backlog-store/schema.ts";
import type { Config } from "./config.ts";
import { backlogPath, Refused } from "./fleet.ts";

/**
 * The backlog document could not be read, locked or written (exit 2, not a refusal).
 */
export class BacklogError extends Schema.TaggedError<BacklogError>()("BacklogError", {
  path: Schema.String,
  message: Schema.String,
}) {}

/**
 * Folder of backlog documents, beside the watch and ended folders.
 * @param stateDir State dir.
 * @returns Path.
 */
export const backlogsDir = (stateDir: string): string => join(stateDir, "backlogs");

/**
 * The backlog document of a domain.
 * @param stateDir State dir.
 * @param domain Domain.
 * @returns Path.
 */
export const documentPath = (stateDir: string, domain: string): string =>
  join(backlogsDir(stateDir), `${domain}.json`);

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
 * Write the document durably: a temp file in the same folder, fsync, rename, then fsync the folder.
 */
const commit = async (path: string, backlog: Backlog): Promise<void> => {
  const dir = join(path, "..");
  const temp = join(dir, `.${randomUUID()}.tmp`);
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(backlog, null, 2)}\n`);
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
 * Run an operation holding the domain's exclusive write lock (a directory next to the document).
 */
const locked = async <A>(path: string, timeoutMs: number, operation: () => Promise<A>) => {
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
    return await operation();
  } finally {
    await unlink(owner).catch(() => undefined);
    await rmdir(lock);
  }
};

const LOCK_TIMEOUT_MS = 5_000;

const failure = (path: string) => (cause: unknown) =>
  new BacklogError({ path, message: cause instanceof Error ? cause.message : String(cause) });

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
 * @returns Lines to print.
 */
export const showBacklog = Effect.fn("showBacklog")(function* (
  config: Config,
  domain: string,
  asJson: boolean,
) {
  const { backlog } = yield* readDocument(config, domain);
  return asJson ? json(backlog) : [renderBacklog(backlog).trimEnd()];
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
 * @param input Path, `--adjacent`, `--json`.
 * @returns Lines to print.
 */
export const boundaryAdd = Effect.fn("boundaryAdd")(function* (
  config: Config,
  domain: string,
  input: { path: string; adjacent: boolean; json: boolean },
) {
  const path = normalizeBoundary(input.path);
  const list: BoundaryList = input.adjacent ? "adjacent" : "owned";
  if (path.startsWith("/") && !/[\r\n]/.test(path) && !existsSync(path))
    return yield* new Refused({ message: `${path} does not exist` });
  let boundary: Backlog["boundary"] | undefined;
  const result = yield* change(config, domain, (backlog) => {
    const applied = addBoundary(backlog, { path, list });
    if (applied.ok) boundary = applied.backlog.boundary;
    return applied;
  });
  if (input.json) return json(boundary);
  return [result.added ? `${list}: added ${path}` : `${list}: ${path} is already listed`];
});

/**
 * `coordinate backlog boundary rm`: remove a path from the owned (or adjacent) Boundary.
 * @param config Config.
 * @param domain Domain.
 * @param input Path, `--adjacent`, `--json`.
 * @returns Lines to print.
 */
export const boundaryRm = Effect.fn("boundaryRm")(function* (
  config: Config,
  domain: string,
  input: { path: string; adjacent: boolean; json: boolean },
) {
  const path = normalizeBoundary(input.path);
  const list: BoundaryList = input.adjacent ? "adjacent" : "owned";
  let boundary: Backlog["boundary"] | undefined;
  yield* change(config, domain, (backlog) => {
    const applied = removeBoundary(backlog, { path, list });
    if (applied.ok) boundary = applied.backlog.boundary;
    return applied;
  });
  return input.json ? json(boundary) : [`${list}: removed ${path}`];
});

/**
 * `coordinate backlog standing add`: record a standing approval verbatim, dated today or `--at`.
 * @param config Config.
 * @param domain Domain.
 * @param input Text, `--at`, `--json`, and the time.
 * @returns Lines to print.
 */
export const standingAdd = Effect.fn("standingAdd")(function* (
  config: Config,
  domain: string,
  input: { text: string; at: string | undefined; json: boolean; now: string },
) {
  const entry = yield* change(config, domain, (backlog) =>
    addStanding(backlog, { text: input.text, at: input.at ?? input.now.slice(0, 10) }),
  );
  return input.json ? json(entry) : [`standing yes ${entry.at}: ${entry.text}`];
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
