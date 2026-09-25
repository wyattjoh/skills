import { Data, Effect, Fiber, Result, Semaphore } from "effect";
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CliIssue } from "./contract.ts";
import {
  claimEngineLease,
  EngineLeaseError,
  leaseHeld,
  leaseIssue,
  parseEngineLease,
  readEngineLease,
  releaseEngineLease,
  writeEngineHeartbeat,
  type EngineLease,
} from "./engine-lease.ts";
import { openEventLog, type EventLog, type RuntimeEvent } from "./event-log.ts";
import { heartbeatStateFile } from "./state-mutation.ts";

/**
 * Services the engine hands to the workflow it runs.
 */
export type EngineContext = {
  runPath: string;
  statePath: string;
  lease: EngineLease;
  emit: (
    type: string,
    ticket: string | null,
    data: Record<string, unknown>,
    attention?: boolean,
  ) => Effect.Effect<RuntimeEvent, EngineError>;
  exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
};

/**
 * Workflow body the engine executes once it holds the lease.
 */
export type EngineWorkflow = (context: EngineContext) => Effect.Effect<void, unknown>;

/**
 * Inputs for one engine process.
 */
export type EngineOptions = {
  statePath: string;
  expectedGeneration: number;
  scriptSha256: string;
  pid: number;
  host: string;
  pane: string | null;
  heartbeatMs: number;
  now: () => Date;
  workflow: EngineWorkflow;
};

/**
 * Why an engine process ended.
 */
export type EngineExit =
  | { reason: "completed"; generation: number }
  | { reason: "stopped"; generation: number }
  | { reason: "lease_lost"; generation: number }
  | { reason: "failed"; generation: number; issue: CliIssue };

/**
 * Typed engine failure outside the workflow body.
 */
export class EngineError extends Data.TaggedError("EngineError")<{
  issue: CliIssue;
}> {}

/**
 * Stop request file written by `runtime.ts stop` beside RESUME.md.
 *
 * @param statePath - Run RESUME.md path.
 * @returns The stop request path.
 */
export const stopRequestPath = (statePath: string): string =>
  join(dirname(statePath), "engine-stop.json");

const stopRequested = (statePath: string, generation: number): Effect.Effect<boolean> =>
  Effect.promise(async () => {
    try {
      const value = JSON.parse(await readFile(stopRequestPath(statePath), "utf8")) as {
        generation?: number;
      };
      return value.generation === generation;
    } catch {
      return false;
    }
  });

const issueOf = (error: unknown): CliIssue => {
  if (typeof error === "object" && error !== null && "issue" in error) {
    return (error as { issue: CliIssue }).issue;
  }
  return {
    code: "engine.workflow_failed",
    message: `The workflow failed: ${String(error)}`,
    remediation: "Inspect the event log, fix the cause, and start the engine again.",
  };
};

type Signal = "stopped" | "lease_lost";

/**
 * Claims the lease, runs the workflow with heartbeats and fencing, and releases the lease.
 *
 * @param options - Run paths, identity, clock, and workflow.
 * @returns An Effect describing why the engine ended.
 */
export const runEngine = (options: EngineOptions): Effect.Effect<EngineExit, EngineError> =>
  Effect.gen(function* () {
    const lease = yield* claimEngineLease({
      statePath: options.statePath,
      expectedGeneration: options.expectedGeneration,
      pid: options.pid,
      host: options.host,
      pane: options.pane,
      scriptSha256: options.scriptSha256,
      now: options.now(),
    }).pipe(Effect.mapError((error) => new EngineError({ issue: leaseIssue(error) })));
    const generation = lease.generation;
    const runPath = dirname(options.statePath);
    const log: EventLog = yield* openEventLog(runPath, options.now).pipe(
      Effect.mapError((error) => new EngineError({ issue: error.issue })),
    );
    const semaphore = yield* Semaphore.make(1);
    const emit: EngineContext["emit"] = (type, ticket, data, attention = false) =>
      log
        .append({ type, ticket, attention, data: { generation, ...data } })
        .pipe(Effect.mapError((error) => new EngineError({ issue: error.issue })));
    const context: EngineContext = {
      runPath,
      statePath: options.statePath,
      lease,
      emit,
      exclusive: (effect) => Semaphore.withPermits(semaphore, 1)(effect),
    };

    const beat = writeEngineHeartbeat(options.statePath, {
      generation,
      pid: options.pid,
      at: options
        .now()
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z"),
    }).pipe(Effect.ignore);
    yield* beat;
    yield* emit("engine.started", null, {
      pid: options.pid,
      host: options.host,
      pane: options.pane,
    });

    const watch: Effect.Effect<Signal> = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(options.heartbeatMs);
        yield* writeEngineHeartbeat(options.statePath, {
          generation,
          pid: options.pid,
          at: options
            .now()
            .toISOString()
            .replace(/\.\d{3}Z$/, "Z"),
        }).pipe(Effect.ignore);
        yield* heartbeatStateFile(options.statePath);
        const current = yield* readEngineLease(options.statePath).pipe(
          Effect.orElseSucceed(() => lease),
        );
        if (!leaseHeld(current, generation)) {
          return "lease_lost" as const;
        }
        if (yield* stopRequested(options.statePath, generation)) return "stopped" as const;
      }
    });

    const workflowFiber = yield* Effect.forkChild(Effect.result(options.workflow(context)));
    const watchFiber = yield* Effect.forkChild(watch);
    const winner = yield* Effect.raceFirst(
      Fiber.join(workflowFiber).pipe(
        Effect.map((outcome) => ({ kind: "workflow" as const, outcome })),
      ),
      Fiber.join(watchFiber).pipe(Effect.map((signal) => ({ kind: "signal" as const, signal }))),
    );
    yield* Fiber.interrupt(workflowFiber);
    yield* Fiber.interrupt(watchFiber);

    const finish = (exit: EngineExit, event: string, attention: boolean) =>
      Effect.gen(function* () {
        if (exit.reason !== "lease_lost") {
          yield* emit(
            event,
            null,
            exit.reason === "failed" ? { issue: exit.issue } : {},
            attention,
          ).pipe(Effect.ignore);
          yield* releaseEngineLease(options.statePath, generation, options.now()).pipe(
            Effect.ignore,
          );
        }
        yield* Effect.promise(() => rm(stopRequestPath(options.statePath), { force: true }));
        return exit;
      });

    if (winner.kind === "signal") {
      return yield* winner.signal === "stopped"
        ? finish({ reason: "stopped", generation }, "engine.stopped", true)
        : finish({ reason: "lease_lost", generation }, "engine.lease_lost", false);
    }
    const outcome = winner.outcome;
    if (Result.isSuccess(outcome)) {
      return yield* finish({ reason: "completed", generation }, "engine.completed", true);
    }
    const issue = issueOf(Result.isFailure(outcome) ? outcome.failure : undefined);
    if (issue.code === "engine.lease_lost") {
      return yield* finish({ reason: "lease_lost", generation }, "engine.lease_lost", false);
    }
    return yield* finish({ reason: "failed", generation, issue }, "engine.failed", true);
  });

/**
 * Refuses a state write unless `generation` still holds an unreleased lease in `markdown`.
 * Provide it as the {@link StateMutationGuard} so the check runs under the state lock.
 *
 * @param generation - Generation the calling engine claimed.
 * @returns A guard that returns `engine.lease_lost` after supersession.
 */
export const leaseFence =
  (generation: number) =>
  (markdown: string): CliIssue | null => {
    let current: ReturnType<typeof parseEngineLease>;
    try {
      current = parseEngineLease(markdown);
    } catch (error) {
      return (error as EngineLeaseError).issue;
    }
    return leaseHeld(current, generation)
      ? null
      : {
          code: "engine.lease_lost",
          message: `Engine generation ${generation} no longer holds this run.`,
          remediation: "Exit this engine; the current lease holder owns the run.",
        };
  };
