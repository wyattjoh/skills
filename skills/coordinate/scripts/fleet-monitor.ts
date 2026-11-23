#!/usr/bin/env bun
import { Cause, Console, Effect, Exit, FileSystem, Layer, Path, Stdio, Terminal } from "effect";
import { CliConfig, CliError, Command, Flag, GlobalFlag } from "effect/cli";
import { ChildProcessSpawner } from "effect/process";
import { monitorFleet } from "./lib/fleet-monitor.ts";
import { Proc } from "./lib/proc.ts";

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
    minutes: Flag.Int("minutes").pipe(
      Flag.withDescription("stop with a monitor expired line after this long"),
      Flag.withDefault(30),
    ),
  },
  (options) =>
    monitorFleet({
      intervalMs: Math.max(1, options.interval) * 1000,
      durationMs: Math.max(1, options.minutes) * 60_000,
      exclude: new Set([
        ...options.exclude,
        ...(process.env.HC_TERMINAL_ID ? [process.env.HC_TERMINAL_ID] : []),
      ]),
      emit: (line) => Console.log(line),
    }).pipe(Effect.provide(Proc.layer)),
).pipe(
  Command.withDescription(
    "Print one line per coordinator fleet change: settled, other state changes, arrival, departure and machine visibility. Entering working is silent.",
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
