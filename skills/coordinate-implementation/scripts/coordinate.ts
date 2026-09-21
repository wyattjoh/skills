#!/usr/bin/env bun
import { Effect, Result } from "effect";
import {
  failureResponse,
  parseRequest,
  RequestError,
  successResponse,
  type CoordinateRequest,
  type CoordinateResponse,
} from "./lib/contract.ts";
import { claimCoordinator, markCoordinatorReady, verifyCoordinator } from "./lib/coordinator.ts";
import {
  prepareCoordinatorHandoff,
  readyCoordinatorHandoff,
  retryCoordinatorHandoff,
  verifyCoordinatorHandoff,
} from "./lib/handoff.ts";
import { waitAnyWorker } from "./lib/herdr.ts";
import {
  prepareImplementorLaunch,
  recoverImplementorLaunch,
  recordImplementorLaunch,
} from "./lib/implementor.ts";
import { completeLanding, recordLandingConflict, synchronizeLanding } from "./lib/landing.ts";
import { runPreflight } from "./lib/preflight.ts";
import {
  authorizeReviewEscalation,
  finalizeReviewRound,
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

const readStdin = (): Effect.Effect<string, RequestError> =>
  Effect.tryPromise({
    try: () => Bun.stdin.text(),
    catch: (error) =>
      new RequestError({
        operation: null,
        issue: {
          code: "request.read_failed",
          message: `Could not read request stdin: ${(error as Error).message}`,
          remediation: "Retry with one JSON request on stdin.",
        },
      }),
  });

const print = (response: CoordinateResponse<unknown>): void => {
  console.log(JSON.stringify(response, null, 2));
};

const execute = (request: CoordinateRequest): Effect.Effect<number, never> =>
  Effect.gen(function* () {
    if (request.operation === "run.finalize") {
      const outcome = yield* Effect.result(finalizeRun(request.input));
      if (Result.isFailure(outcome)) {
        print(failureResponse(request.operation, [outcome.failure.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.success));
      return 0;
    }

    if (request.operation === "preflight") {
      const outcome = yield* runPreflight(request.input);
      if (outcome.errors.length > 0) {
        print(failureResponse(request.operation, outcome.errors, outcome.report));
        return 1;
      }
      print(successResponse(request.operation, outcome.report));
      return 0;
    }

    if (request.operation === "state.validate") {
      const validation = yield* Effect.result(validateStateFile(request.input.statePath));
      if (Result.isFailure(validation)) {
        print(failureResponse(request.operation, [validation.failure.issue], null));
        return 1;
      }
      print(successResponse(request.operation, { state: validation.success }));
      return 0;
    }

    if (request.operation === "snapshot.check" || request.operation === "snapshot.accept") {
      const snapshot = yield* Effect.result(
        request.operation === "snapshot.check"
          ? checkSnapshot(request.input)
          : acceptSnapshot(request.input),
      );
      if (Result.isFailure(snapshot)) {
        print(failureResponse(request.operation, [snapshot.failure.issue], null));
        return 1;
      }
      print(successResponse(request.operation, snapshot.success));
      return 0;
    }

    if (request.operation === "roles.discover") {
      const outcome = yield* discoverRoles();
      if (outcome.errors.length > 0) {
        print(failureResponse(request.operation, outcome.errors, outcome.discovery));
        return 1;
      }
      print(successResponse(request.operation, outcome.discovery));
      return 0;
    }

    if (request.operation === "role.validate") {
      const outcome = yield* validateRole(request.input);
      if (outcome.result === null) {
        print(failureResponse(request.operation, outcome.errors, null));
        return 1;
      }
      print(successResponse(request.operation, outcome.result));
      return 0;
    }

    if (request.operation === "worktree.preflight") {
      const outcome = yield* Effect.result(preflightWorktreePolicy(request.input));
      if (Result.isFailure(outcome)) {
        print(failureResponse(request.operation, [outcome.failure.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.success));
      return 0;
    }

    if (request.operation === "worktree.prepare") {
      const outcome = yield* Effect.result(prepareWorktree(request.input));
      if (Result.isFailure(outcome)) {
        print(failureResponse(request.operation, [outcome.failure.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.success));
      return 0;
    }

    if (request.operation === "landing.synchronize") {
      const outcome = yield* Effect.result(synchronizeLanding(request.input));
      if (Result.isFailure(outcome)) {
        print(failureResponse(request.operation, [outcome.failure.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.success));
      return 0;
    }

    if (request.operation === "landing.conflict.record") {
      const outcome = yield* Effect.result(recordLandingConflict(request.input));
      if (Result.isFailure(outcome)) {
        print(failureResponse(request.operation, [outcome.failure.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.success));
      return 0;
    }

    if (request.operation === "landing.complete") {
      const outcome = yield* Effect.result(completeLanding(request.input));
      if (Result.isFailure(outcome)) {
        print(failureResponse(request.operation, [outcome.failure.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.success));
      return 0;
    }

    if (request.operation === "gate.record") {
      const outcome = yield* Effect.result(recordGate(request.input));
      if (Result.isFailure(outcome)) {
        print(failureResponse(request.operation, [outcome.failure.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.success));
      return 0;
    }

    if (request.operation === "gate.rerun.record") {
      const outcome = yield* Effect.result(recordGateRerun(request.input));
      if (Result.isFailure(outcome)) {
        print(failureResponse(request.operation, [outcome.failure.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.success));
      return 0;
    }

    if (request.operation === "review.round.finalize") {
      const outcome = yield* Effect.result(finalizeReviewRound(request.input));
      if (Result.isFailure(outcome)) {
        print(failureResponse(request.operation, [outcome.failure.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.success));
      return 0;
    }

    if (request.operation === "review.escalation.authorize") {
      const outcome = yield* Effect.result(authorizeReviewEscalation(request.input));
      if (Result.isFailure(outcome)) {
        print(failureResponse(request.operation, [outcome.failure.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.success));
      return 0;
    }

    if (request.operation === "review.launch.prepare") {
      const outcome = yield* Effect.result(prepareReviewerLaunch(request.input));
      if (Result.isFailure(outcome)) {
        print(failureResponse(request.operation, [outcome.failure.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.success));
      return 0;
    }

    if (request.operation === "review.launch.record") {
      const outcome = yield* Effect.result(recordReviewerLaunch(request.input));
      if (Result.isFailure(outcome)) {
        print(failureResponse(request.operation, [outcome.failure.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.success));
      return 0;
    }

    if (request.operation === "review.policy.prepare") {
      const outcome = yield* Effect.result(prepareReviewPolicy(request.input));
      if (Result.isFailure(outcome)) {
        print(failureResponse(request.operation, [outcome.failure.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.success));
      return 0;
    }

    if (request.operation === "implementor.launch.prepare") {
      const outcome = yield* Effect.result(prepareImplementorLaunch(request.input));
      if (Result.isFailure(outcome)) {
        print(failureResponse(request.operation, [outcome.failure.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.success));
      return 0;
    }

    if (request.operation === "implementor.launch.recover") {
      const outcome = yield* Effect.result(recoverImplementorLaunch(request.input));
      if (Result.isFailure(outcome)) {
        print(failureResponse(request.operation, [outcome.failure.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.success));
      return 0;
    }

    if (request.operation === "implementor.launch.record") {
      const outcome = yield* Effect.result(recordImplementorLaunch(request.input));
      if (Result.isFailure(outcome)) {
        print(failureResponse(request.operation, [outcome.failure.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.success));
      return 0;
    }

    if (request.operation === "scheduler.plan") {
      const outcome = yield* Effect.result(planSchedule(request.input));
      if (Result.isFailure(outcome)) {
        print(failureResponse(request.operation, [outcome.failure.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.success));
      return 0;
    }

    if (request.operation === "herdr.wait_any") {
      const outcome = yield* Effect.result(waitAnyWorker(request.input));
      if (Result.isFailure(outcome)) {
        print(failureResponse(request.operation, [outcome.failure.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.success));
      return 0;
    }

    if (request.operation === "stall.assessment.prepare") {
      const outcome = yield* Effect.result(prepareStallAssessment(request.input));
      if (Result.isFailure(outcome)) {
        print(failureResponse(request.operation, [outcome.failure.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.success));
      return 0;
    }

    if (request.operation === "stall.assessment.evaluate") {
      const outcome = yield* Effect.result(evaluateStallAssessment(request.input));
      if (Result.isFailure(outcome)) {
        print(failureResponse(request.operation, [outcome.failure.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.success));
      return 0;
    }

    if (request.operation === "stall.assessment.apply") {
      const outcome = yield* Effect.result(applyStallAssessment(request.input));
      if (Result.isFailure(outcome)) {
        print(failureResponse(request.operation, [outcome.failure.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.success));
      return 0;
    }

    if (request.operation === "infrastructure.retry.record") {
      const outcome = yield* Effect.result(recordInfrastructureRetry(request.input));
      if (Result.isFailure(outcome)) {
        print(failureResponse(request.operation, [outcome.failure.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.success));
      return 0;
    }

    if (request.operation === "coordinator.handoff.prepare") {
      const outcome = yield* Effect.result(prepareCoordinatorHandoff(request.input));
      if (Result.isFailure(outcome)) {
        print(failureResponse(request.operation, [outcome.failure.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.success));
      return 0;
    }

    if (request.operation === "coordinator.handoff.retry") {
      const outcome = yield* Effect.result(retryCoordinatorHandoff(request.input));
      if (Result.isFailure(outcome)) {
        print(failureResponse(request.operation, [outcome.failure.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.success));
      return 0;
    }

    if (request.operation === "coordinator.handoff.ready") {
      const outcome = yield* Effect.result(readyCoordinatorHandoff(request.input));
      if (Result.isFailure(outcome)) {
        print(failureResponse(request.operation, [outcome.failure.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.success));
      return 0;
    }

    if (request.operation === "coordinator.handoff.verify") {
      const outcome = yield* Effect.result(verifyCoordinatorHandoff(request.input));
      if (Result.isFailure(outcome)) {
        print(failureResponse(request.operation, [outcome.failure.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.success));
      return 0;
    }

    if (request.operation === "coordinator.claim") {
      const outcome = yield* Effect.result(claimCoordinator(request.input));
      if (Result.isFailure(outcome)) {
        print(failureResponse(request.operation, [outcome.failure.issue], null));
        return 1;
      }
      print(successResponse(request.operation, { ownership: outcome.success }));
      return 0;
    }

    if (request.operation === "coordinator.ready") {
      const outcome = yield* Effect.result(markCoordinatorReady(request.input));
      if (Result.isFailure(outcome)) {
        print(failureResponse(request.operation, [outcome.failure.issue], null));
        return 1;
      }
      print(successResponse(request.operation, { ownership: outcome.success }));
      return 0;
    }

    const outcome = yield* Effect.result(verifyCoordinator(request.input));
    if (Result.isFailure(outcome)) {
      print(failureResponse(request.operation, [outcome.failure.issue], null));
      return 1;
    }
    print(successResponse(request.operation, outcome.success));
    return 0;
  });

const program = Effect.gen(function* () {
  const raw = yield* readStdin();
  const request = yield* parseRequest(raw);
  return yield* execute(request);
});

const outcome = await Effect.runPromise(Effect.result(program));
if (Result.isFailure(outcome)) {
  print(failureResponse(outcome.failure.operation, [outcome.failure.issue], null));
  process.exitCode = 2;
} else {
  process.exitCode = outcome.success;
}
