import { Effect, Option, Schema } from "effect";
import { HerdrError, herdr } from "./herdr.ts";

/**
 * One fleet reading: `m:<machine>` and `t:<address>` keys mapped to a state.
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
 * How long and how often to watch, and where lines go.
 */
export type MonitorOptions = {
  intervalMs: number;
  durationMs: number;
  exclude: ReadonlySet<string>;
  emit: (line: string) => Effect.Effect<void>;
};

/**
 * Poll the fleet until the duration runs out, emitting only changes. The first good read is a
 * silent baseline; a failed or empty read keeps the last good snapshot.
 * @param options Interval, duration, exclusions and output.
 */
export const monitorFleet = Effect.fn("fleet.monitor")(function* (options: MonitorOptions) {
  const deadline = Date.now() + options.durationMs;
  let previous: FleetSnapshot | undefined;
  while (Date.now() < deadline) {
    const current = yield* readFleet(options.exclude).pipe(Effect.option);
    if (Option.isSome(current) && current.value.size > 0) {
      if (previous !== undefined)
        for (const line of fleetEvents(previous, current.value)) yield* options.emit(line);
      previous = current.value;
    }
    yield* Effect.sleep(options.intervalMs);
  }
  yield* options.emit("monitor expired");
});
