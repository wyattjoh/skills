import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { BacklogError, holdingLocks, writeAtomic } from "./backlog-doc.ts";
import type { Config } from "./config.ts";
import type { ItemStatus } from "./backlog-store/schema.ts";
import { checkDomainName, Refused } from "./fleet.ts";

/**
 * The only durable data retained for a capacity-blocked delegate.
 */
export type CapacityWait = { item: string; machine: string; order: number };

/**
 * One domain's durable capacity queue.
 */
export type CapacityQueue = { version: 1; nextOrder: number; entries: CapacityWait[] };

/**
 * The lock held while one queued delegate is rechecked and launched.
 */
type CapacityClaim = { path: string; token: string };

const emptyQueue = (): CapacityQueue => ({ version: 1, nextOrder: 1, entries: [] });

const ELIGIBLE_STATUSES: ReadonlySet<ItemStatus> = new Set(["open", "building", "delegated"]);

/**
 * Whether a backlog item may receive a queued delegate wake.
 * @param status Item status.
 * @returns True for active work, false while waiting on the user, in review or parked.
 */
export const capacityItemEligible = (status: ItemStatus): boolean => ELIGIBLE_STATUSES.has(status);

/**
 * The durable metadata-only queue for a domain.
 * @param stateDir Coordinate state directory.
 * @param domain Domain name.
 * @returns Queue path.
 */
export const capacityQueuePath = (stateDir: string, domain: string): string =>
  join(stateDir, "capacity", `${domain}.json`);

const failure = (path: string) => (cause: unknown) =>
  new BacklogError({ path, message: cause instanceof Error ? cause.message : String(cause) });

const persistQueue = Effect.fn("persistCapacityQueue")(function* (
  path: string,
  queue: CapacityQueue,
) {
  yield* Effect.tryPromise({
    try: () => mkdir(dirname(path), { recursive: true }),
    catch: failure(path),
  });
  yield* writeAtomic(path, `${JSON.stringify(queue, null, 2)}\n`);
});

const validItem = (value: unknown): value is string =>
  typeof value === "string" && /^i[1-9][0-9]*$/u.test(value);

const validMachine = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);

const ownKeysAre = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

const parseQueue = (value: unknown): CapacityQueue => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !ownKeysAre(value as Record<string, unknown>, ["version", "nextOrder", "entries"])
  )
    throw new Error("must contain only version, nextOrder and entries");
  const queue = value as Record<string, unknown>;
  if (queue.version !== 1) throw new Error("has an unsupported version");
  if (!Number.isSafeInteger(queue.nextOrder) || (queue.nextOrder as number) < 1)
    throw new Error("nextOrder must be a positive safe integer");
  if (!Array.isArray(queue.entries)) throw new Error("entries must be a list");
  const entries: CapacityWait[] = [];
  const items = new Set<string>();
  for (const raw of queue.entries) {
    if (
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw) ||
      !ownKeysAre(raw as Record<string, unknown>, ["item", "machine", "order"])
    )
      throw new Error("each entry must contain only item, machine and order");
    const entry = raw as Record<string, unknown>;
    if (!validItem(entry.item)) throw new Error("each item must be an item id such as i1");
    if (!validMachine(entry.machine)) throw new Error("each machine must be a Herdr machine name");
    if (!Number.isSafeInteger(entry.order) || (entry.order as number) < 1)
      throw new Error("each order must be a positive safe integer");
    if (items.has(entry.item)) throw new Error(`item ${entry.item} occurs more than once`);
    items.add(entry.item);
    entries.push({ item: entry.item, machine: entry.machine, order: entry.order as number });
  }
  const orders = entries.map((entry) => entry.order);
  if (new Set(orders).size !== orders.length) throw new Error("entry orders must be unique");
  if (entries.some((entry) => entry.order >= (queue.nextOrder as number)))
    throw new Error("nextOrder must be greater than every entry order");
  return { version: 1, nextOrder: queue.nextOrder as number, entries };
};

const readQueue = async (path: string): Promise<CapacityQueue> => {
  try {
    return parseQueue(JSON.parse(await readFile(path, "utf8")));
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return emptyQueue();
    throw cause;
  }
};

/**
 * Read the queue, validating that it contains no launch payload or unknown metadata.
 * @param config Coordinate config.
 * @param domain Domain name.
 * @returns Queue in enqueue order.
 */
export const readCapacityQueue = Effect.fn("readCapacityQueue")(function* (
  config: Config,
  domain: string,
) {
  yield* checkDomainName(domain);
  const path = capacityQueuePath(config.stateDir, domain);
  return yield* Effect.tryPromise({ try: () => readQueue(path), catch: failure(path) });
});

/**
 * Add or retain one metadata-only wait record, preserving its original FIFO order on retries.
 * @param config Coordinate config.
 * @param domain Domain name.
 * @param input Item and target machine.
 * @returns The durable queue entry.
 */
export const enqueueCapacityWait = Effect.fn("enqueueCapacityWait")(function* (
  config: Config,
  domain: string,
  input: { item: string; machine: string },
) {
  yield* checkDomainName(domain);
  if (!validItem(input.item))
    return yield* new Refused({ message: `${input.item} is not an item id such as i1` });
  if (!validMachine(input.machine))
    return yield* new Refused({ message: `${input.machine} is not a Herdr machine name` });
  const path = capacityQueuePath(config.stateDir, domain);
  return yield* holdingLocks(
    config,
    [domain],
    Effect.gen(function* () {
      const queue = yield* readCapacityQueue(config, domain);
      const existing = queue.entries.find((entry) => entry.item === input.item);
      if (existing) {
        if (existing.machine === input.machine) return existing;
        const updated = { ...existing, machine: input.machine };
        const next = {
          ...queue,
          entries: queue.entries.map((entry) => (entry.item === input.item ? updated : entry)),
        };
        yield* persistQueue(path, next);
        return updated;
      }
      const entry = { ...input, order: queue.nextOrder };
      const next: CapacityQueue = {
        ...queue,
        nextOrder: queue.nextOrder + 1,
        entries: [...queue.entries, entry],
      };
      yield* persistQueue(path, next);
      return entry;
    }),
  );
});

/**
 * Remove queued entries whose items are no longer eligible for delegation.
 * @param config Coordinate config.
 * @param domain Domain name.
 * @param keep Set of still-open item ids.
 * @returns Removed entries in enqueue order.
 */
export const pruneCapacityWaits = Effect.fn("pruneCapacityWaits")(function* (
  config: Config,
  domain: string,
  keep: ReadonlySet<string>,
) {
  yield* checkDomainName(domain);
  const path = capacityQueuePath(config.stateDir, domain);
  return yield* holdingLocks(
    config,
    [domain],
    Effect.gen(function* () {
      const queue = yield* readCapacityQueue(config, domain);
      const removed = queue.entries.filter((entry) => !keep.has(entry.item));
      if (removed.length > 0) {
        const next = {
          ...queue,
          entries: queue.entries.filter((entry) => keep.has(entry.item)),
        };
        yield* persistQueue(path, next);
      }
      return removed;
    }),
  );
});

/**
 * Remove a queue entry after its launch starts, keeping the queue's order counter durable.
 * @param config Coordinate config.
 * @param domain Domain name.
 * @param item Item id.
 * @returns The removed entry, or undefined.
 */
export const removeCapacityWait = Effect.fn("removeCapacityWait")(function* (
  config: Config,
  domain: string,
  item: string,
) {
  yield* checkDomainName(domain);
  const path = capacityQueuePath(config.stateDir, domain);
  return yield* holdingLocks(
    config,
    [domain],
    Effect.gen(function* () {
      const queue = yield* readCapacityQueue(config, domain);
      const removed = queue.entries.find((entry) => entry.item === item);
      if (removed)
        yield* persistQueue(path, {
          ...queue,
          entries: queue.entries.filter((entry) => entry.item !== item),
        });
      return removed;
    }),
  );
});

const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

const claimPath = (stateDir: string, domain: string, item: string): string =>
  join(stateDir, "capacity", "claims", `${domain}-${item}.lock`);

const ownerIsLive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const acquireClaim = async (path: string): Promise<CapacityClaim> => {
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
      return { path, token };
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
      if (ownerIsLive(current.pid))
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

const releaseClaim = async (claim: CapacityClaim): Promise<void> => {
  try {
    const owner = JSON.parse(await readFile(join(claim.path, "owner.json"), "utf8")) as {
      token?: unknown;
    };
    if (owner.token === claim.token) await rm(claim.path, { recursive: true, force: true });
  } catch {
    // A replaced or removed claim belongs to its new owner, not this release.
  }
};

/**
 * Serialize retries of the same queued item across coordinators and recover claims left by a dead process.
 * @param config Coordinate config.
 * @param domain Domain name.
 * @param item Item id.
 * @param use The retry path, which rechecks the durable queue before launch.
 * @returns The retry result.
 */
export const withCapacityClaim = <A, E, R>(
  config: Config,
  domain: string,
  item: string,
  use: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Refused, R> => {
  const path = claimPath(config.stateDir, domain, item);
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => acquireClaim(path),
      catch: (cause) =>
        new Refused({ message: cause instanceof Error ? cause.message : String(cause) }),
    }),
    () => use,
    (claim) => Effect.promise(() => releaseClaim(claim)),
  );
};
