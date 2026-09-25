import { Effect, Result } from "effect";
import {
  failureResponse,
  parseRequest,
  successResponse,
  type CliIssue,
  type CoordinateOperation,
  type CoordinateRequest,
  type CoordinateResponse,
} from "./lib/contract.ts";
import { updateAgreements } from "./lib/agreements.ts";
import { claimCoordinator, markCoordinatorReady, verifyCoordinator } from "./lib/coordinator.ts";
import { liveEngineLease } from "./lib/engine-lease.ts";
import { drainGlobalWarnings, setCurrentOperation } from "./lib/global-state.ts";
import {
  migrateClosedImplementorRuntime,
  recoverImplementorRuntimeMigration,
  prepareImplementorLaunch,
  recoverImplementorLaunch,
  recordImplementorLaunch,
} from "./lib/implementor.ts";
import { checkLandingRebase, completeLanding } from "./lib/landing.ts";
import { runPreflight } from "./lib/preflight.ts";
import {
  finalizeReviewRound,
  supersedeInterruptedReviewerAttempt,
  prepareReviewerLaunch,
  prepareReviewPolicy,
  recordGate,
  recordGateRerun,
  recordReviewerLaunch,
} from "./lib/review.ts";
import { recordInfrastructureRetry } from "./lib/retry.ts";
import { finalizeRun } from "./lib/run.ts";
import { planSchedule } from "./lib/scheduler.ts";
import { discoverRoles, validateRole } from "./lib/roles.ts";
import { acceptSnapshot, checkSnapshot } from "./lib/snapshot.ts";
import {
  applyStallAssessment,
  evaluateStallAssessment,
  prepareStallAssessment,
} from "./lib/stall-assessment.ts";
import { validateStateFile } from "./lib/state.ts";
import { preflightWorktreePolicy, prepareWorktree } from "./lib/worktrees.ts";

type Output = string[];

const print = (output: Output, response: CoordinateResponse<unknown>): void => {
  const warnings = drainGlobalWarnings();
  output.push(
    `${JSON.stringify(warnings.length === 0 ? response : { ...response, warnings }, null, 2)}\n`,
  );
};

/**
 * What one operation reports: its errors (empty on success) and the result or
 * partial report printed with them.
 */
type Outcome = { errors: CliIssue[]; result: unknown };

type InputOf<K extends CoordinateOperation> = Extract<CoordinateRequest, { operation: K }>["input"];

/**
 * Adapts a helper operation that fails with a typed `{ issue }` error.
 */
const op =
  <I, A>(
    run: (input: I) => Effect.Effect<A, { issue: CliIssue }>,
    shape: (success: A) => unknown = (success) => success,
  ) =>
  (input: I): Effect.Effect<Outcome> =>
    Effect.match(run(input), {
      onFailure: (failure) => ({ errors: [failure.issue], result: null }),
      onSuccess: (success) => ({ errors: [], result: shape(success) }),
    });

const HANDLERS: { [K in CoordinateOperation]: (input: InputOf<K>) => Effect.Effect<Outcome> } = {
  preflight: (input) =>
    runPreflight(input).pipe(
      Effect.map((outcome) => ({ errors: outcome.errors, result: outcome.report })),
    ),
  "state.validate": op(
    (input: InputOf<"state.validate">) => validateStateFile(input.statePath),
    (state) => ({ state }),
  ),
  "roles.discover": () =>
    discoverRoles().pipe(
      Effect.map((outcome) => ({ errors: outcome.errors, result: outcome.discovery })),
    ),
  "role.validate": (input) =>
    validateRole(input).pipe(
      Effect.map((outcome) => ({ errors: outcome.errors, result: outcome.result })),
    ),
  "coordinator.claim": op(claimCoordinator, (ownership) => ({ ownership })),
  "coordinator.ready": op(markCoordinatorReady, (ownership) => ({ ownership })),
  "coordinator.verify": op(verifyCoordinator),
  "snapshot.check": op(checkSnapshot),
  "snapshot.accept": op(acceptSnapshot),
  "worktree.preflight": op(preflightWorktreePolicy),
  "worktree.prepare": op(prepareWorktree),
  "implementor.runtime.migrate": op(migrateClosedImplementorRuntime),
  "implementor.runtime.migration.recover": op(recoverImplementorRuntimeMigration),
  "implementor.launch.prepare": op(prepareImplementorLaunch),
  "implementor.launch.recover": op(recoverImplementorLaunch),
  "implementor.launch.record": op(recordImplementorLaunch),
  "scheduler.plan": op(planSchedule),
  "stall.assessment.prepare": op(prepareStallAssessment),
  "stall.assessment.evaluate": op(evaluateStallAssessment),
  "stall.assessment.apply": op(applyStallAssessment),
  "infrastructure.retry.record": op(recordInfrastructureRetry),
  "review.policy.prepare": op(prepareReviewPolicy),
  "review.attempt.supersede": op(supersedeInterruptedReviewerAttempt),
  "review.launch.prepare": op(prepareReviewerLaunch),
  "review.launch.record": op(recordReviewerLaunch),
  "gate.record": op(recordGate),
  "gate.rerun.record": op(recordGateRerun),
  "review.round.finalize": op(finalizeReviewRound),
  "landing.rebase.check": op(checkLandingRebase),
  "landing.complete": op(completeLanding),
  "run.finalize": op(finalizeRun),
  "agreements.update": op(updateAgreements),
};

const execute = (request: CoordinateRequest, output: Output): Effect.Effect<number> =>
  (HANDLERS[request.operation] as (input: unknown) => Effect.Effect<Outcome>)(request.input).pipe(
    Effect.map(({ errors, result }) => {
      if (errors.length > 0) {
        print(output, failureResponse(request.operation, errors, result));
        return 1;
      }
      print(output, successResponse(request.operation, result));
      return 0;
    }),
  );

/**
 * Operations a coordinator may run while an Engine holds the run: read-only
 * checks, snapshot acceptance for a `snapshot_changed` escalation, and
 * coordinator ownership, which the Engine never writes.
 */
const ENGINE_SAFE_OPERATIONS = new Set<string>([
  "preflight",
  "state.validate",
  "snapshot.check",
  "snapshot.accept",
  "roles.discover",
  "role.validate",
  "scheduler.plan",
  "coordinator.claim",
  "coordinator.ready",
  "coordinator.verify",
]);

const engineGuard = (request: CoordinateRequest): Effect.Effect<CliIssue | undefined> =>
  Effect.gen(function* () {
    const input = request.input as { statePath?: unknown };
    if (ENGINE_SAFE_OPERATIONS.has(request.operation) || typeof input.statePath !== "string") {
      return undefined;
    }
    const lease = yield* liveEngineLease(input.statePath, new Date()).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (lease === null) return undefined;
    return {
      code: "engine.active",
      message: `Engine generation ${lease.generation} (pid ${lease.pid}) owns this run, so \`${request.operation}\` would race its writes.`,
      remediation:
        "Answer the escalation through runtime.ts instead, or run `runtime.ts stop` before this recovery operation.",
    };
  });

/**
 * Runs one coordinator request and returns the exact CLI stdout and exit code.
 *
 * The CLI entry point and in-process tests share this function, so both see the
 * same responses. Calls must not overlap: global warnings and the current
 * operation are collected in module state.
 *
 * @param raw Raw JSON request text, as read from stdin.
 * @returns The process exit code and everything the CLI would print.
 */
export const runCoordinatorRequest = async (
  raw: string,
): Promise<{ exitCode: number; stdout: string }> => {
  const output: Output = [];
  drainGlobalWarnings();
  setCurrentOperation(null);
  const program = Effect.gen(function* () {
    const request = yield* parseRequest(raw);
    setCurrentOperation(request.operation);
    const blocked = yield* engineGuard(request);
    if (blocked !== undefined) {
      print(output, failureResponse(request.operation, [blocked], null));
      return 1;
    }
    return yield* execute(request, output);
  });
  const outcome = await Effect.runPromise(Effect.result(program));
  setCurrentOperation(null);
  let exitCode: number;
  if (Result.isFailure(outcome)) {
    print(output, failureResponse(outcome.failure.operation, [outcome.failure.issue], null));
    exitCode = 2;
  } else {
    exitCode = outcome.success;
  }
  return { exitCode, stdout: output.join("") };
};
