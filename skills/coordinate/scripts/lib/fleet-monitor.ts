import { Effect, Option, Result, Schema } from "effect";
import { HerdrError, herdr } from "./herdr.ts";
import { domainLeases } from "./lease.ts";
import type { Proc } from "./proc.ts";
import type { StateStore } from "./state-store.ts";

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
 * The lines one fleet change produces. Entering `working` is tracked silently; settling,
 * any other state change, arrival and departure each produce a line.
 * @param previous Last good snapshot.
 * @param current New snapshot.
 * @returns Event lines, arrivals and changes first, then departures.
 */
export const fleetEvents = (previous: FleetSnapshot, current: FleetSnapshot): string[] => {
  const lines: string[] = [];
  for (const [key, state] of current) {
    const before = previous.get(key);
    if (before === undefined) lines.push(`arrived ${key}=${state}`);
    else if (before === state || state === "working") continue;
    else if (state === "settled") lines.push(`settled ${key} (${before}->settled)`);
    else lines.push(`state ${key} ${before}->${state}`);
  }
  for (const key of previous.keys()) if (!current.has(key)) lines.push(`departed ${key}`);
  return lines;
};

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
 * Where the monitor reads leases from, how often, and the home that holds them. A failed read
 * keeps the last good leases, so an unreachable home never reports every coordinator departed;
 * `LEASE_BLIND_READS` failures in a row print a blind line naming `home`.
 */
export type LeaseSource = {
  read: Effect.Effect<FleetSnapshot, unknown, Proc>;
  everyMs: number;
  home: string;
};

/**
 * How many lease reads in a row may fail before the monitor says it is blind, as the watcher does.
 */
export const LEASE_BLIND_READS = 3;

const failureText = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error);

/**
 * How long and how often to watch, where lines go, and the leases to add (undefined: labels only).
 */
export type MonitorOptions = {
  intervalMs: number;
  durationMs: number;
  exclude: ReadonlySet<string>;
  emit: (line: string) => Effect.Effect<void>;
  leases: LeaseSource | undefined;
};

/**
 * Poll the fleet until the duration runs out, emitting only changes. The first good read is a
 * silent baseline; a failed or empty read keeps the last good snapshot. After
 * `LEASE_BLIND_READS` failed lease reads in a row it emits one `blind:` line naming the home, and
 * `blind cleared:` on the next good read.
 * @param options Interval, duration, exclusions and output.
 */
export const monitorFleet = Effect.fn("fleet.monitor")(function* (options: MonitorOptions) {
  const deadline = Date.now() + options.durationMs;
  let previous: FleetSnapshot | undefined;
  let leases: FleetSnapshot = new Map();
  let leasesRead = Number.NEGATIVE_INFINITY;
  let failedReads = 0;
  while (Date.now() < deadline) {
    if (options.leases !== undefined && Date.now() - leasesRead >= options.leases.everyMs) {
      leasesRead = Date.now();
      const { home } = options.leases;
      const read = yield* options.leases.read.pipe(Effect.result);
      if (Result.isSuccess(read)) {
        leases = read.success;
        if (failedReads >= LEASE_BLIND_READS)
          yield* options.emit(`blind cleared: state home ${home} readable again`);
        failedReads = 0;
      } else {
        failedReads += 1;
        if (failedReads === LEASE_BLIND_READS)
          yield* options.emit(
            `blind: state home ${home} unreachable ${LEASE_BLIND_READS} times: ${failureText(read.failure)}; lease entries are from the last good read`,
          );
      }
    }
    const labelled = yield* readFleet(options.exclude).pipe(Effect.option);
    // A lease adds only a coordinator this core does not list itself, never the manager's own.
    const current = Option.map(
      labelled,
      (fleet): FleetSnapshot =>
        new Map([
          ...fleet,
          ...[...leases].filter(
            ([, address]) => !options.exclude.has(address) && !fleet.has(`t:${address}`),
          ),
        ]),
    );
    if (Option.isSome(current) && current.value.size > 0) {
      if (previous !== undefined)
        for (const line of fleetEvents(previous, current.value)) yield* options.emit(line);
      previous = current.value;
    }
    yield* Effect.sleep(options.intervalMs);
  }
  yield* options.emit("monitor expired");
});
