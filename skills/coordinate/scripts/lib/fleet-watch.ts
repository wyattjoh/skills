import { Effect, Schema } from "effect";
import { remoteMachineOf } from "./delegate-capacity.ts";
import { HerdrError, herdr } from "./herdr.ts";
import { domainLeases } from "./lease.ts";
import type { Proc } from "./proc.ts";
import type { StateStore } from "./state-store.ts";
import type { WatchEventData } from "./watch.ts";

/**
 * One fleet reading: `m:<machine>` and `t:<address>` keys mapped to a state, and (from the store's
 * leases) `l:<domain>` keys mapped to that domain's live coordinator address.
 * Terminal states fold `idle` and `done` into `settled`.
 */
export type FleetSnapshot = ReadonlyMap<string, string>;

const FleetDocument = Schema.Struct({
  machines: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          name: Schema.String,
          state: Schema.optionalKey(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  ),
  terminals: Schema.Array(
    Schema.Struct({
      address: Schema.String,
      status: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
});

/**
 * Fold a terminal status into the states the manager tracks.
 * @param status Status from `hc ls`, or undefined for a partial row.
 * @returns `settled` for idle and done, `unknown` when missing, otherwise the status.
 */
export const foldStatus = (status: string | undefined): string =>
  status === undefined ? "unknown" : status === "idle" || status === "done" ? "settled" : status;

/**
 * Parse `hc ls --json` into a snapshot, leaving out excluded addresses.
 * @param text JSON text.
 * @param exclude Addresses to skip (the manager's own terminal).
 * @returns The snapshot.
 */
export const parseFleet = (text: string, exclude: ReadonlySet<string>) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(FleetDocument)(JSON.parse(text)),
    catch: (cause) =>
      new HerdrError({
        command: "hc ls",
        kind: "unreadable_output",
        message: String(cause).slice(0, 300),
      }),
  }).pipe(
    Effect.map((document): FleetSnapshot => {
      const entries: Array<[string, string]> = [];
      for (const machine of document.machines ?? [])
        entries.push([`m:${machine.name}`, machine.state ?? "unknown"]);
      for (const terminal of document.terminals)
        if (!exclude.has(terminal.address))
          entries.push([`t:${terminal.address}`, foldStatus(terminal.status ?? undefined)]);
      return new Map(entries);
    }),
  );

/**
 * Read the coordinator fleet once.
 * @param exclude Addresses to skip.
 * @returns The snapshot.
 */
export const readFleet = Effect.fn("fleet.read")(function* (exclude: ReadonlySet<string>) {
  const text = yield* herdr(["hc", "ls", "--json", "--label", "fleet.role=coordinator"], 10_000);
  return yield* parseFleet(text, exclude);
});

/**
 * Every live coordinator lease in the store as `l:<domain>` mapped to its holder's address as the
 * reader names it (bare on the reader's machine, else `<machine>/<address>`), so coordinators on
 * machines this core cannot list are still found.
 * @param store The store holding the backlogs.
 * @param reader The reading machine's own Herdr core name.
 * @param now Milliseconds since the epoch.
 * @returns The lease entries.
 */
export const readLeaseFleet = (store: StateStore, reader: string, now: number) =>
  Effect.map(
    domainLeases(store, reader, now),
    (domains): FleetSnapshot =>
      new Map(
        domains.flatMap((entry) =>
          entry.coordinator === null ? [] : [[`l:${entry.domain}`, entry.coordinator] as const],
        ),
      ),
  );

/**
 * Where a manager watcher reads coordinator leases, how often, and the home that holds them. A
 * failed read keeps the last good leases, so an unreachable home never reports every coordinator
 * departed.
 */
export type LeaseSource = {
  read: Effect.Effect<FleetSnapshot, unknown, Proc>;
  everyMs: number;
  home: string;
};

/** How often a manager watcher reads leases from the home store by default. */
export const LEASE_INTERVAL_MS = 30_000;

/** How many lease reads in a row may fail before the watcher reports the leases blind. */
export const LEASE_BLIND_READS = 3;

/**
 * Join the labelled fleet with the lease entries. A lease adds only a coordinator this core does not
 * list itself, never the manager's own, so each coordinator wakes the manager once.
 * @param labelled The labelled fleet from this core.
 * @param leases The last good lease entries.
 * @param exclude Addresses to skip.
 * @returns The combined snapshot.
 */
export const joinFleet = (
  labelled: FleetSnapshot,
  leases: FleetSnapshot,
  exclude: ReadonlySet<string>,
): FleetSnapshot =>
  new Map([
    ...labelled,
    ...[...leases].filter(([, address]) => !exclude.has(address) && !labelled.has(`t:${address}`)),
  ]);

/**
 * What a fleet event can say about where a coordinator runs: each known address's domain, and this
 * core's name for an address with no machine prefix.
 */
export type FleetContext = { domains: ReadonlyMap<string, string>; machine: string | undefined };

const machineOf = (address: string, context: FleetContext): Record<string, string> => {
  const machine = remoteMachineOf(address) ?? context.machine;
  return machine === undefined ? {} : { machine };
};

const subject = (key: string, value: string, context: FleetContext): Record<string, string> => {
  const name = key.slice(2);
  if (key.startsWith("m:")) return { source: "machine", machine: name };
  if (key.startsWith("l:"))
    return { source: "lease", domain: name, address: value, ...machineOf(value, context) };
  const domain = context.domains.get(name);
  return {
    source: "terminal",
    address: name,
    ...(domain === undefined ? {} : { domain }),
    ...machineOf(name, context),
  };
};

const ARRIVED = {
  terminal: "verify it with hc get (domain, tab, harness) before trusting it",
  lease: "a coordinator this machine does not list; verify it and read it through the home",
  machine: "a machine became visible; rediscover the fleet",
};

const DEPARTED = {
  terminal:
    "hc get says why; an arrival with the same domain and tab is a harness handoff, otherwise report it and ask whether to spawn it again",
  lease: "its lease lapsed; report it and ask whether to spawn it again",
  machine: "a machine is no longer listed; rediscover the fleet",
};

const stateText = (source: string | undefined, to: string): string => {
  if (source === "lease") return "a new coordinator holds this domain's lease; verify it";
  if (source === "machine")
    return "its coordinators may read as departed until it reconnects; rediscover the fleet";
  return to === "blocked"
    ? "relay its question, options and recommendation, and leave the answer to the user"
    : "read its terminal";
};

/**
 * The watcher events one fleet change produces. Entering `working` is tracked silently; settling,
 * any other state change, arrival and departure each produce one event.
 * @param previous Last good snapshot.
 * @param current New snapshot.
 * @param context Domains and this core's machine name, for the events' attributes.
 * @returns Events, arrivals and changes first, then departures.
 */
export const fleetEvents = (
  previous: FleetSnapshot,
  current: FleetSnapshot,
  context: FleetContext,
): WatchEventData[] => {
  const events: WatchEventData[] = [];
  const event = (kind: string, attrs: Record<string, string>, text: string) =>
    events.push({ kind, attrs, fields: {}, text });
  for (const [key, state] of current) {
    const before = previous.get(key);
    const about = subject(key, state, context);
    const source = about.source as keyof typeof ARRIVED;
    const lease = key.startsWith("l:");
    if (before === undefined)
      event("fleet-arrived", { ...about, ...(lease ? {} : { state }) }, ARRIVED[source]);
    else if (before === state || state === "working") continue;
    else if (state === "settled")
      event(
        "fleet-settled",
        { ...about, from: before },
        "read its last message and delta; relay a new ask or result, or report stranded work",
      );
    else
      event("fleet-state", { ...about, from: before, to: state }, stateText(about.source, state));
  }
  for (const [key, before] of previous)
    if (!current.has(key)) {
      const about = subject(key, before, context);
      event("fleet-departed", about, DEPARTED[about.source as keyof typeof DEPARTED]);
    }
  return events;
};

/**
 * The fleet as the watcher's live view lists it.
 * @param fleet Last good snapshot, or undefined before the first.
 * @param domains Known domains by address.
 * @returns One entry per coordinator or machine.
 */
export const fleetSummary = (
  fleet: FleetSnapshot | undefined,
  domains: ReadonlyMap<string, string>,
): string[] =>
  [...(fleet ?? [])].map(([key, value]) => {
    const name = key.slice(2);
    if (key.startsWith("m:")) return `machine ${name} [${value}]`;
    if (key.startsWith("l:")) return `${name} ${value} [lease]`;
    return `${domains.get(name) ?? "?"} ${name} [${value}]`;
  });
