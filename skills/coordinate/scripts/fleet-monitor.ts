#!/usr/bin/env bun
import { Cause, Console, Effect, Exit, FileSystem, Layer, Path, Stdio, Terminal } from "effect";
import { CliConfig, CliError, Command, Flag, GlobalFlag } from "effect/cli";
import { ChildProcessSpawner } from "effect/process";
import { loadConfig } from "./lib/config.ts";
import { localMachine } from "./lib/delegate-capacity.ts";
import { monitorFleet, readLeaseFleet } from "./lib/fleet-monitor.ts";
import { Proc } from "./lib/proc.ts";
import { stateStore, useStateBackend } from "./lib/state.ts";

// On herdr-doc, coordinators on every machine are also found by the leases in the home store;
// on files, labels on this core are the whole fleet.
const leaseSource = (everyMs: number) =>
  Effect.gen(function* () {
    const config = yield* loadConfig();
    if (config.stateBackend !== "herdr-doc" || config.stateHome === undefined) return undefined;
    useStateBackend(config);
    const reader = yield* localMachine();
    const store = stateStore(config.stateDir);
    return {
      read: Effect.suspend(() => readLeaseFleet(store, reader, Date.now())),
      everyMs,
      home: config.stateHome,
    };
  });

const fleetMonitor = Command.make(
  "fleet-monitor",
  {
    exclude: Flag.String("exclude").pipe(
      Flag.withDescription(
        "terminal address to skip; repeatable (HC_TERMINAL_ID is always skipped)",
      ),
      Flag.atLeast(0),
    ),
    interval: Flag.Int("interval").pipe(
      Flag.withDescription("seconds between hc reads"),
      Flag.withDefault(5),
    ),
    leaseInterval: Flag.Int("lease-interval").pipe(
      Flag.withDescription("seconds between lease reads from the home store (herdr-doc only)"),
      Flag.withDefault(30),
    ),
    minutes: Flag.Int("minutes").pipe(
      Flag.withDescription("stop with a monitor expired line after this long"),
      Flag.withDefault(30),
    ),
  },
  (options) =>
    Effect.gen(function* () {
      const leases = yield* leaseSource(Math.max(1, options.leaseInterval) * 1000);
      yield* monitorFleet({
        intervalMs: Math.max(1, options.interval) * 1000,
        durationMs: Math.max(1, options.minutes) * 60_000,
        exclude: new Set([
          ...options.exclude,
          ...(process.env.HC_TERMINAL_ID ? [process.env.HC_TERMINAL_ID] : []),
        ]),
        emit: (line) => Console.log(line),
        leases,
      });
    }).pipe(Effect.provide(Proc.layer)),
).pipe(
  Command.withDescription(
    "Print one line per coordinator fleet change: settled, other state changes, arrival, departure and machine visibility. Entering working is silent. On herdr-doc, l:<domain> lines follow each domain's coordinator lease on any machine.",
  ),
);

const cliLayer = (args: readonly string[]) =>
  Layer.mergeAll(
    FileSystem.layerNoop({}),
    Path.layer,
    Stdio.layerTest({ args: Effect.succeed([...args]) }),
    Layer.succeed(
      Terminal.Terminal,
      Terminal.make({
        columns: Effect.succeed(process.stdout.columns ?? 80),
        rows: Effect.succeed(process.stdout.rows ?? 24),
        size: Effect.die("terminal size is unavailable"),
        readInput: Effect.die("terminal input is unavailable"),
        readLine: Effect.die("terminal input is unavailable"),
        display: () => Effect.void,
      }),
    ),
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("CLI child processes are unavailable")),
    ),
    CliConfig.layer({ builtIns: [GlobalFlag.Help] }),
  );

const exit = await Effect.runPromiseExit(
  Command.run(fleetMonitor, { version: "0.0.0" }).pipe(
    Effect.provide(cliLayer(process.argv.slice(2))),
  ),
);
if (Exit.isFailure(exit)) {
  const failure = exit.cause.reasons.find(Cause.isFailReason)?.error;
  if (failure instanceof CliError.ShowHelp) process.exitCode = failure.errors.length > 0 ? 1 : 0;
  else {
    console.error(`could not check: ${Cause.pretty(exit.cause)}`);
    process.exitCode = 2;
  }
}
