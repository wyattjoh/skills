import { Effect } from "effect";
import { isRecord } from "./backlog-store/schema.ts";
import type { Config } from "./config.ts";
import { localMachine } from "./delegate-capacity.ts";
import { Refused } from "./fleet.ts";
import { stateStore } from "./state.ts";
import { keys, runCommand, type StateStore } from "./state-store.ts";

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
 * @returns The lease written.
 */
export const takeLease = (store: StateStore, domain: string, holder: LeaseHolder, now: number) =>
  runCommand(store, keys.backlog(domain), (current) => {
    if (!isRecord(current.value))
      return Effect.fail(
        new Refused({ message: `no backlog for ${domain}; run coordinate start ${domain}` }),
      );
    const held = leaseOf(current.value);
    if (held !== undefined && leaseLive(held, now) && !sameHolder(held, holder))
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
 * holder has (undefined when the domain has no backlog).
 */
export type Renewal =
  | { renewed: true; lease: Lease }
  | { renewed: false; lease: Lease | undefined };

/**
 * Renew the holder's lease: move its expiry when the holder still has it (live or lapsed), or take
 * it when the document has none. Never takes back a lease another holder took.
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
    if (held !== undefined && !sameHolder(held, holder))
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
