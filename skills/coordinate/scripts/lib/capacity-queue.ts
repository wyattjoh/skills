import { Effect } from "effect";
import type { Config } from "./config.ts";
import type { ItemStatus } from "./backlog-store/schema.ts";
import { checkDomainName, Refused } from "./fleet.ts";
import { stateStore } from "./state.ts";
import { filesPath } from "./state-files.ts";
import {
  BacklogError,
  type CommandStep,
  keys,
  runCommand,
  type StateStore,
  type StoreUnreadable,
  type StoreOffline,
} from "./state-store.ts";

/**
 * The only durable data retained for a capacity-blocked delegate.
 */
export type CapacityWait = { item: string; machine: string; order: number };

/**
 * One domain's durable capacity queue.
 */
export type CapacityQueue = { version: 1; nextOrder: number; entries: CapacityWait[] };

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
  filesPath(stateDir, keys.queue(domain));

const store = (config: Config): StateStore => stateStore(config.stateDir);

const failure = (path: string) => (cause: unknown) =>
  new BacklogError({ path, message: cause instanceof Error ? cause.message : String(cause) });

const unreadable = (error: StoreUnreadable): BacklogError =>
  new BacklogError({ path: error.location, message: error.message });

const decodeQueue = (path: string, value: unknown): Effect.Effect<CapacityQueue, BacklogError> =>
  value === null
    ? Effect.succeed(emptyQueue())
    : Effect.try({ try: () => parseQueue(value), catch: failure(path) });

/**
 * Change a domain's queue under its backlog lock, re-run on a lost write race.
 */
const changeQueue = <A>(
  config: Config,
  domain: string,
  step: (queue: CapacityQueue) => { next: CapacityQueue | undefined; value: A },
): Effect.Effect<A, BacklogError | Refused | StoreOffline> => {
  const key = keys.queue(domain);
  const path = store(config).location(key);
  return runCommand(store(config), key, (current) =>
    Effect.map(decodeQueue(path, current.value), (queue): CommandStep<A> => {
      const { next, value } = step(queue);
      return next === undefined ? { write: false, value } : { write: true, next, value };
    }),
  ).pipe(
    Effect.mapError((error) => (error._tag === "StoreUnreadable" ? unreadable(error) : error)),
  );
};

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
  const key = keys.queue(domain);
  const stored = yield* store(config)
    .read(key)
    .pipe(Effect.catchTag("StoreUnreadable", (error) => Effect.fail(unreadable(error))));
  return yield* decodeQueue(store(config).location(key), stored.value);
});

/**
 * One queued item as `queue show` reports it: its target machine, its enqueue order, and its
 * 1-based place among the entries waiting for that same machine.
 */
export type QueuedItem = CapacityWait & { position: number };

/**
 * Number each entry by its place in its machine's queue, oldest first.
 * @param queue Queue in any order.
 * @returns Entries in enqueue order, each with its per-machine position.
 */
export const queuePositions = (queue: CapacityQueue): QueuedItem[] => {
  const seen = new Map<string, number>();
  return [...queue.entries]
    .sort((left, right) => left.order - right.order)
    .map((entry) => {
      const position = (seen.get(entry.machine) ?? 0) + 1;
      seen.set(entry.machine, position);
      return { ...entry, position };
    });
};

/**
 * Show a domain's capacity queue without changing it: no lock is taken and nothing is written.
 * @param config Coordinate config.
 * @param domain Domain name.
 * @param json Print `{ domain, entries }` as JSON instead of one line per entry.
 * @returns Output lines.
 */
export const showCapacityQueue = Effect.fn("showCapacityQueue")(function* (
  config: Config,
  domain: string,
  json: boolean,
) {
  const entries = queuePositions(yield* readCapacityQueue(config, domain));
  if (json) return [JSON.stringify({ domain, entries })];
  if (entries.length === 0) return [`no items queued for capacity in ${domain}`];
  return entries.map(
    (entry) => `${entry.item} on ${entry.machine}, #${entry.position} in that machine's queue`,
  );
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
  return yield* changeQueue(config, domain, (queue) => {
    const existing = queue.entries.find((entry) => entry.item === input.item);
    if (existing) {
      if (existing.machine === input.machine) return { next: undefined, value: existing };
      const updated = { ...existing, machine: input.machine };
      return {
        next: {
          ...queue,
          entries: queue.entries.map((entry) => (entry.item === input.item ? updated : entry)),
        },
        value: updated,
      };
    }
    const entry = { ...input, order: queue.nextOrder };
    return {
      next: { ...queue, nextOrder: queue.nextOrder + 1, entries: [...queue.entries, entry] },
      value: entry,
    };
  });
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
  return yield* changeQueue(config, domain, (queue) => {
    const removed = queue.entries.filter((entry) => !keep.has(entry.item));
    return {
      next:
        removed.length > 0
          ? { ...queue, entries: queue.entries.filter((entry) => keep.has(entry.item)) }
          : undefined,
      value: removed,
    };
  });
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
  return yield* changeQueue(config, domain, (queue) => {
    const removed = queue.entries.find((entry) => entry.item === item);
    return {
      next: removed
        ? { ...queue, entries: queue.entries.filter((entry) => entry.item !== item) }
        : undefined,
      value: removed,
    };
  });
});

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
  const claims = store(config);
  return Effect.acquireUseRelease(
    claims
      .claim(domain, item)
      .pipe(Effect.mapError((busy) => new Refused({ message: busy.message }))),
    () => use,
    (claim) => claims.release(claim),
  );
};
