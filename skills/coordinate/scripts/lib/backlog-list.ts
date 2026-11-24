import { Effect } from "effect";
import { isRecord } from "./backlog-store/schema.ts";
import { leaseLive, leaseOf, type Lease } from "./lease.ts";
import type { Config } from "./config.ts";
import { localMachine } from "./delegate-capacity.ts";
import { stateStore } from "./state.ts";
import { keys, StoreUnreadable, type StateStore, type StoreOffline } from "./state-store.ts";

/**
 * A domain's coordinator lease as this machine sees it: the stored lease, whether it is live now,
 * and the terminal to focus from this machine (bare on the holder's own core, else
 * `<machine>/<address>`; null when this core's name is unknown).
 */
export type ListedLease = Lease & { live: boolean; terminal: string | null };

/**
 * One domain in `backlog list --json`: its name and its lease.
 */
export type ListedDomain = { domain: string; lease: ListedLease | null };

/**
 * One domain in `backlog list --json --documents`: also its stored backlog (null when it has
 * none), why it could not be read (null when it could), and the `ended_at` of each ended record a
 * delegate ref in it names.
 */
export type DocumentedDomain = ListedDomain & {
  document: unknown;
  unreadable: string | null;
  ended: Record<string, string>;
};

/**
 * What `backlog list --json` prints: this core's name (null when unknown) and the domains.
 */
export type BacklogListing = {
  machine: string | null;
  domains: (ListedDomain | DocumentedDomain)[];
};

/**
 * What to list.
 */
export type BacklogListOptions = {
  /**
   * This core's Herdr machine name, or undefined when it cannot be read.
   */
  machine: string | undefined;
  /**
   * Milliseconds since the epoch, to judge leases.
   */
  now: number;
  /**
   * Include each stored document and its delegates' ended records.
   */
  documents: boolean;
  /**
   * Only this domain, or every domain when undefined.
   */
  domain: string | undefined;
};

const listedLease = (lease: Lease, machine: string | undefined, now: number): ListedLease => ({
  ...lease,
  live: leaseLive(lease, now),
  terminal:
    machine === undefined
      ? null
      : lease.machine === machine
        ? lease.address
        : `${lease.machine}/${lease.address}`,
});

// The sessions a stored document's delegate refs name, once each, in document order.
const refSessions = (document: unknown): string[] => {
  if (!isRecord(document) || !Array.isArray(document.items)) return [];
  const seen = new Set<string>();
  for (const item of document.items) {
    if (!isRecord(item) || !Array.isArray(item.delegates)) continue;
    for (const ref of item.delegates)
      if (isRecord(ref) && typeof ref.session === "string" && ref.session !== "")
        seen.add(ref.session);
  }
  return [...seen];
};

const endedAt = (value: unknown): string | undefined =>
  isRecord(value) && typeof value.ended_at === "string" ? value.ended_at : undefined;

/**
 * Every domain with a backlog in the store, in name order, with its coordinator lease, read in
 * one batch (two with documents, for the ended records). Read-only.
 * @param store The state store.
 * @param options This core's name, the time, whether to include documents, and an optional domain.
 * @returns The listing.
 */
export const backlogList = Effect.fn("backlogList")(function* (
  store: StateStore,
  options: BacklogListOptions,
) {
  const all = yield* store
    .list("backlog")
    .pipe(Effect.catchTag("StoreUnreadable", () => Effect.succeed([] as readonly string[])));
  const names = [...all]
    .filter((name) => options.domain === undefined || name === options.domain)
    .toSorted();
  const read = yield* store.readMany(names.map(keys.backlog));
  const rows = names.map((domain, index) => {
    const stored = read[index];
    const unreadable = stored === undefined || stored instanceof StoreUnreadable;
    const value = unreadable ? null : stored.value;
    const lease = leaseOf(value);
    return {
      domain,
      value,
      reason: stored instanceof StoreUnreadable ? stored.message : unreadable ? "not read" : null,
      lease: lease === undefined ? null : listedLease(lease, options.machine, options.now),
    };
  });
  const domains: ListedDomain[] = rows.map(({ domain, lease }) => ({ domain, lease }));
  if (!options.documents) return { machine: options.machine ?? null, domains } as BacklogListing;
  const sessions = [...new Set(rows.flatMap((row) => refSessions(row.value)))];
  const records = yield* store.readMany(sessions.map(keys.ended));
  const ended = new Map<string, string>();
  for (const [index, session] of sessions.entries()) {
    const record = records[index];
    const at =
      record === undefined || record instanceof StoreUnreadable ? undefined : endedAt(record.value);
    if (at !== undefined) ended.set(session, at);
  }
  return {
    machine: options.machine ?? null,
    domains: rows.map(({ domain, lease, value, reason }) => ({
      domain,
      lease,
      document: value,
      unreadable: reason,
      ended: Object.fromEntries(
        refSessions(value).flatMap((session) => {
          const at = ended.get(session);
          return at === undefined ? [] : [[session, at]];
        }),
      ),
    })),
  } as BacklogListing;
}) as (
  store: StateStore,
  options: BacklogListOptions,
) => Effect.Effect<BacklogListing, StoreOffline>;

/**
 * `coordinate backlog list`: every domain with its coordinator lease, as JSON or one line each.
 * Read-only; an unreachable home fails with `StoreOffline` (exit 2).
 * @param config Config.
 * @param options `--json`, `--documents` and `--domain`.
 * @returns Lines to print.
 */
export const listBacklogs = Effect.fn("listBacklogs")(function* (
  config: Config,
  options: { json: boolean; documents: boolean; domain: string | undefined },
) {
  const machine = yield* localMachine().pipe(
    Effect.map((name): string | undefined => name),
    Effect.catch(() => Effect.succeed(undefined)),
  );
  const listing = yield* backlogList(stateStore(config.stateDir), {
    machine,
    now: Date.now(),
    documents: options.json && options.documents,
    domain: options.domain,
  });
  if (options.json) return [JSON.stringify(listing, null, 2)];
  return listing.domains.map(({ domain, lease }) =>
    lease === null
      ? `${domain}: no coordinator lease`
      : `${domain}: ${lease.machine}/${lease.address} ${lease.live ? "holds" : "held"} its lease until ${lease.expiry}`,
  );
});
