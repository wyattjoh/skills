import { Effect, Option } from "effect";
import { isRecord } from "./backlog-store/schema.ts";
import type { Config } from "./config.ts";
import { localMachine } from "./delegate-capacity.ts";
import { Refused } from "./fleet.ts";
import { stateStore } from "./state.ts";
import * as hc from "./herdr.ts";
import {
  keys,
  optionUnlessOffline,
  runCommand,
  StoreUnreadable,
  type StateStore,
} from "./state-store.ts";

/**
 * How long a coordinator lease lasts after it was last taken or renewed.
 */
export const LEASE_TTL_MS = 180_000;

/**
 * How often a watcher renews its coordinator's lease.
 */
export const LEASE_RENEW_MS = 60_000;

/**
 * The coordinator that holds a domain: its Herdr machine (that core's own name), its terminal
 * address on that machine (bare, as its own core names it), and when the lease expires (ISO).
 */
export type Lease = { machine: string; address: string; expiry: string };

/**
 * Who takes or renews a lease: a coordinator terminal on a machine.
 */
export type LeaseHolder = { machine: string; address: string };

/**
 * The lease a backlog document carries, when it has a well-formed one.
 * @param document A backlog document as stored.
 * @returns The lease, or undefined.
 */
export const leaseOf = (document: unknown): Lease | undefined => {
  if (!isRecord(document) || !isRecord(document.lease)) return undefined;
  const { machine, address, expiry } = document.lease;
  return typeof machine === "string" && typeof address === "string" && typeof expiry === "string"
    ? { machine, address, expiry }
    : undefined;
};

/**
 * Whether a lease is still live at `now`: its expiry is later.
 * @param lease Lease.
 * @param now Milliseconds since the epoch.
 * @returns True while live.
 */
export const leaseLive = (lease: Lease, now: number): boolean => Date.parse(lease.expiry) > now;

const sameHolder = (lease: Lease, holder: LeaseHolder): boolean =>
  lease.machine === holder.machine && lease.address === holder.address;

const sameLease = (left: Lease, right: Lease): boolean =>
  sameHolder(left, right) && left.expiry === right.expiry;

/**
 * A lease's holder as `<machine>/<address>`.
 * @param lease Lease.
 * @returns The holder's fleet-wide name.
 */
export const leaseHolderName = (lease: Lease): string => `${lease.machine}/${lease.address}`;

/**
 * Why a command refuses to start a second coordinator while `lease` is live.
 * @param domain Domain.
 * @param lease The live lease.
 * @returns The refusal message.
 */
export const leaseRefusal = (domain: string, lease: Lease): string =>
  `${domain} already has a coordinator: ${leaseHolderName(lease)} holds its lease until ${lease.expiry}; go to it, or wait for that lease to expire (${LEASE_TTL_MS / 60_000} minutes after its watcher last renewed it)`;

const fresh = (holder: LeaseHolder, now: number): Lease => ({
  machine: holder.machine,
  address: holder.address,
  expiry: new Date(now + LEASE_TTL_MS).toISOString(),
});

/**
 * Take a domain's coordinator lease in its backlog document with a version-checked write, or
 * refuse (exit 1) while another holder's lease is live, naming its machine and terminal. The
 * holder taking its own lease again moves the expiry.
 * @param store The store holding the backlog.
 * @param domain Domain.
 * @param holder The coordinator taking it.
 * @param now Milliseconds since the epoch.
 * @param abandoned A live lease the caller found abandoned (`abandonedLease`): replaced only while
 *   the document still holds exactly it.
 * @returns The lease written.
 */
export const takeLease = (
  store: StateStore,
  domain: string,
  holder: LeaseHolder,
  now: number,
  abandoned: Lease | undefined = undefined,
) =>
  runCommand(store, keys.backlog(domain), (current) => {
    if (!isRecord(current.value))
      return Effect.fail(
        new Refused({ message: `no backlog for ${domain}; run coordinate start ${domain}` }),
      );
    const held = leaseOf(current.value);
    if (
      held !== undefined &&
      leaseLive(held, now) &&
      !sameHolder(held, holder) &&
      !(abandoned !== undefined && sameLease(held, abandoned))
    )
      return Effect.fail(new Refused({ message: leaseRefusal(domain, held) }));
    const lease = fresh(holder, now);
    return Effect.succeed({
      write: true as const,
      next: { ...current.value, lease },
      value: lease,
    });
  });

/**
 * What a renewal found: `renewed` with the lease written, or not renewed with the lease another
 * holder has (undefined when the domain has no backlog or no lease).
 */
export type Renewal =
  | { renewed: true; lease: Lease }
  | { renewed: false; lease: Lease | undefined };

/**
 * Renew the holder's lease: move its expiry when the holder still has it (live or lapsed). Never
 * creates a lease (only a start takes one, so a watcher with an unchecked owner cannot), and never
 * takes back a lease another holder took.
 * @param store The store holding the backlog.
 * @param domain Domain.
 * @param holder The coordinator whose watcher renews it.
 * @param now Milliseconds since the epoch.
 * @returns The renewal.
 */
export const renewLease = (store: StateStore, domain: string, holder: LeaseHolder, now: number) =>
  runCommand(store, keys.backlog(domain), (current) => {
    if (!isRecord(current.value))
      return Effect.succeed({
        write: false as const,
        value: { renewed: false, lease: undefined } satisfies Renewal as Renewal,
      });
    const held = leaseOf(current.value);
    if (held === undefined || !sameHolder(held, holder))
      return Effect.succeed({
        write: false as const,
        value: { renewed: false, lease: held } satisfies Renewal as Renewal,
      });
    const lease = fresh(holder, now);
    return Effect.succeed({
      write: true as const,
      next: { ...current.value, lease },
      value: { renewed: true, lease } satisfies Renewal as Renewal,
    });
  });

/**
 * The coordinator address a reader on `reader` uses for a lease's holder: the bare address when the
 * holder runs on the reader's own machine, else `<machine>/<address>`. This assumes the reader's
 * Herdr names each machine by that machine's own core name.
 * @param lease Lease.
 * @param reader The reading machine's own Herdr core name.
 * @returns The address.
 */
export const leaseAddress = (lease: Lease, reader: string): string =>
  lease.machine === reader ? lease.address : leaseHolderName(lease);

/**
 * One domain's coordinator as its lease records it: the lease (null without one), whether it is
 * live, and the live holder's address as the reader names it (null when not live).
 */
export type DomainLease = {
  domain: string;
  lease: Lease | null;
  live: boolean;
  coordinator: string | null;
};

/**
 * A domain's lease with the backlog document it was read from.
 */
export type StoredDomainLease = DomainLease & {
  /**
   * The backlog document as stored (null when it has none or could not be read).
   */
  document: unknown;
  /**
   * Why the document could not be read, or null when it could.
   */
  unreadable: string | null;
};

/**
 * Every domain in the store with its coordinator lease, in name order: the fleet's coordinators on
 * every machine, seen from `reader`. A document that cannot be read counts as having no lease; an
 * unreachable home fails (`StoreOffline`).
 * @param store The store holding the backlogs.
 * @param reader The reading machine's own Herdr core name.
 * @param now Milliseconds since the epoch.
 * @param only Read only this domain, or every domain when undefined.
 * @returns The domains and their leases, each with the document it came from.
 */
export const storedDomainLeases = (
  store: StateStore,
  reader: string,
  now: number,
  only: string | undefined = undefined,
) =>
  Effect.gen(function* () {
    const domains = [...(yield* store.list("backlog"))]
      .filter((domain) => only === undefined || domain === only)
      .toSorted();
    const stored = yield* store.readMany(domains.map(keys.backlog));
    return domains.map((domain, index): StoredDomainLease => {
      const read = stored[index];
      const document = read === undefined || read instanceof StoreUnreadable ? null : read.value;
      const lease = leaseOf(document);
      const live = lease !== undefined && leaseLive(lease, now);
      return {
        domain,
        lease: lease ?? null,
        live,
        coordinator: live ? leaseAddress(lease, reader) : null,
        document,
        unreadable:
          read instanceof StoreUnreadable ? read.message : read === undefined ? "not read" : null,
      };
    });
  });

/**
 * Every domain in the store with its coordinator lease, in name order: the fleet's coordinators on
 * every machine, seen from `reader`. A document that cannot be read counts as having no lease; an
 * unreachable home fails (`StoreOffline`).
 * @param store The store holding the backlogs.
 * @param reader The reading machine's own Herdr core name.
 * @param now Milliseconds since the epoch.
 * @returns The domains and their leases.
 */
export const domainLeases = (store: StateStore, reader: string, now: number) =>
  Effect.map(storedDomainLeases(store, reader, now), (rows) =>
    rows.map(({ domain, lease, live, coordinator }): DomainLease => ({
      domain,
      lease,
      live,
      coordinator,
    })),
  );

/**
 * A watcher's renewal of its coordinator's lease on this machine, at most once per
 * `LEASE_RENEW_MS`. Best effort: an unreachable home or a lost race leaves it for the next one.
 * @param config Config.
 * @param domain Domain.
 * @param owner The coordinator's terminal address on this machine.
 * @param now Milliseconds since the epoch.
 * @param last When the watcher last tried, in the same clock.
 * @returns When this call tried (`last` when it was not yet due).
 */
export const renewWatchedLease = (
  config: Config,
  domain: string,
  owner: string,
  now: number,
  last: number,
) =>
  now - last < LEASE_RENEW_MS
    ? Effect.succeed(last)
    : Effect.gen(function* () {
        const machine = yield* localMachine();
        yield* renewLease(stateStore(config.stateDir), domain, { machine, address: owner }, now);
      }).pipe(Effect.ignore, Effect.as(now));

/**
 * A domain's lease as stored now, when it has one.
 * @param store The store holding the backlog.
 * @param domain Domain.
 * @returns The lease, or undefined (no backlog, unreadable, or no lease).
 */
export const currentLease = (store: StateStore, domain: string) =>
  optionUnlessOffline(store.read(keys.backlog(domain))).pipe(
    Effect.map((stored) => (Option.isSome(stored) ? leaseOf(stored.value.value) : undefined)),
  );

/**
 * Whether a live lease was left behind on this machine: its holder is on this core and Herdr
 * reports that terminal gone or ended, as after a harness handoff. A holder on another machine is
 * never asked about and stays authoritative until its lease expires; a Herdr that cannot answer
 * leaves the lease standing.
 * @param lease The lease.
 * @param machine This core's Herdr machine name.
 * @returns The lease when abandoned, else undefined.
 */
export const abandonedLease = Effect.fn("abandonedLease")(function* (
  lease: Lease,
  machine: string,
) {
  if (lease.machine !== machine) return undefined;
  const found = yield* hc.get(lease.address).pipe(
    Effect.map((terminal) => ({ terminal })),
    Effect.catch(() => Effect.succeed(undefined)),
  );
  if (found === undefined) return undefined;
  return found.terminal === undefined || !found.terminal.live ? lease : undefined;
});
