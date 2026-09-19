#!/usr/bin/env bun
import { Effect, Either } from "effect";
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
import { prepareImplementorLaunch, recordImplementorLaunch } from "./lib/implementor.ts";
import { completeLanding, recordLandingConflict, synchronizeLanding } from "./lib/landing.ts";
import { runPreflight } from "./lib/preflight.ts";
import {
  finalizeReviewRound,
  prepareReviewerLaunch,
  prepareReviewPolicy,
  recordGate,
  recordReviewerLaunch,
} from "./lib/review.ts";
import { recordInfrastructureRetry } from "./lib/retry.ts";
import { planSchedule } from "./lib/scheduler.ts";
import { discoverRoles, validateRole } from "./lib/roles.ts";
import { acceptSnapshot, checkSnapshot } from "./lib/snapshot.ts";
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
      const validation = yield* Effect.either(validateStateFile(request.input.statePath));
      if (Either.isLeft(validation)) {
        print(failureResponse(request.operation, [validation.left.issue], null));
        return 1;
      }
      print(successResponse(request.operation, { state: validation.right }));
      return 0;
    }

    if (request.operation === "snapshot.check" || request.operation === "snapshot.accept") {
      const snapshot = yield* Effect.either(
        request.operation === "snapshot.check"
          ? checkSnapshot(request.input)
          : acceptSnapshot(request.input),
      );
      if (Either.isLeft(snapshot)) {
        print(failureResponse(request.operation, [snapshot.left.issue], null));
        return 1;
      }
      print(successResponse(request.operation, snapshot.right));
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
      const outcome = yield* Effect.either(preflightWorktreePolicy(request.input));
      if (Either.isLeft(outcome)) {
        print(failureResponse(request.operation, [outcome.left.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.right));
      return 0;
    }

    if (request.operation === "worktree.prepare") {
      const outcome = yield* Effect.either(prepareWorktree(request.input));
      if (Either.isLeft(outcome)) {
        print(failureResponse(request.operation, [outcome.left.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.right));
      return 0;
    }

    if (request.operation === "landing.synchronize") {
      const outcome = yield* Effect.either(synchronizeLanding(request.input));
      if (Either.isLeft(outcome)) {
        print(failureResponse(request.operation, [outcome.left.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.right));
      return 0;
    }

    if (request.operation === "landing.conflict.record") {
      const outcome = yield* Effect.either(recordLandingConflict(request.input));
      if (Either.isLeft(outcome)) {
        print(failureResponse(request.operation, [outcome.left.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.right));
      return 0;
    }

    if (request.operation === "landing.complete") {
      const outcome = yield* Effect.either(completeLanding(request.input));
      if (Either.isLeft(outcome)) {
        print(failureResponse(request.operation, [outcome.left.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.right));
      return 0;
    }

    if (request.operation === "gate.record") {
      const outcome = yield* Effect.either(recordGate(request.input));
      if (Either.isLeft(outcome)) {
        print(failureResponse(request.operation, [outcome.left.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.right));
      return 0;
    }

    if (request.operation === "review.round.finalize") {
      const outcome = yield* Effect.either(finalizeReviewRound(request.input));
      if (Either.isLeft(outcome)) {
        print(failureResponse(request.operation, [outcome.left.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.right));
      return 0;
    }

    if (request.operation === "review.launch.prepare") {
      const outcome = yield* Effect.either(prepareReviewerLaunch(request.input));
      if (Either.isLeft(outcome)) {
        print(failureResponse(request.operation, [outcome.left.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.right));
      return 0;
    }

    if (request.operation === "review.launch.record") {
      const outcome = yield* Effect.either(recordReviewerLaunch(request.input));
      if (Either.isLeft(outcome)) {
        print(failureResponse(request.operation, [outcome.left.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.right));
      return 0;
    }

    if (request.operation === "review.policy.prepare") {
      const outcome = yield* Effect.either(prepareReviewPolicy(request.input));
      if (Either.isLeft(outcome)) {
        print(failureResponse(request.operation, [outcome.left.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.right));
      return 0;
    }

    if (request.operation === "implementor.launch.prepare") {
      const outcome = yield* Effect.either(prepareImplementorLaunch(request.input));
      if (Either.isLeft(outcome)) {
        print(failureResponse(request.operation, [outcome.left.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.right));
      return 0;
    }

    if (request.operation === "implementor.launch.record") {
      const outcome = yield* Effect.either(recordImplementorLaunch(request.input));
      if (Either.isLeft(outcome)) {
        print(failureResponse(request.operation, [outcome.left.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.right));
      return 0;
    }

    if (request.operation === "scheduler.plan") {
      const outcome = yield* Effect.either(planSchedule(request.input));
      if (Either.isLeft(outcome)) {
        print(failureResponse(request.operation, [outcome.left.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.right));
      return 0;
    }

    if (request.operation === "herdr.wait_any") {
      const outcome = yield* Effect.either(waitAnyWorker(request.input));
      if (Either.isLeft(outcome)) {
        print(failureResponse(request.operation, [outcome.left.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.right));
      return 0;
    }

    if (request.operation === "infrastructure.retry.record") {
      const outcome = yield* Effect.either(recordInfrastructureRetry(request.input));
      if (Either.isLeft(outcome)) {
        print(failureResponse(request.operation, [outcome.left.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.right));
      return 0;
    }

    if (request.operation === "coordinator.handoff.prepare") {
      const outcome = yield* Effect.either(prepareCoordinatorHandoff(request.input));
      if (Either.isLeft(outcome)) {
        print(failureResponse(request.operation, [outcome.left.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.right));
      return 0;
    }

    if (request.operation === "coordinator.handoff.retry") {
      const outcome = yield* Effect.either(retryCoordinatorHandoff(request.input));
      if (Either.isLeft(outcome)) {
        print(failureResponse(request.operation, [outcome.left.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.right));
      return 0;
    }

    if (request.operation === "coordinator.handoff.ready") {
      const outcome = yield* Effect.either(readyCoordinatorHandoff(request.input));
      if (Either.isLeft(outcome)) {
        print(failureResponse(request.operation, [outcome.left.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.right));
      return 0;
    }

    if (request.operation === "coordinator.handoff.verify") {
      const outcome = yield* Effect.either(verifyCoordinatorHandoff(request.input));
      if (Either.isLeft(outcome)) {
        print(failureResponse(request.operation, [outcome.left.issue], null));
        return 1;
      }
      print(successResponse(request.operation, outcome.right));
      return 0;
    }

    if (request.operation === "coordinator.claim") {
      const outcome = yield* Effect.either(claimCoordinator(request.input));
      if (Either.isLeft(outcome)) {
        print(failureResponse(request.operation, [outcome.left.issue], null));
        return 1;
      }
      print(successResponse(request.operation, { ownership: outcome.right }));
      return 0;
    }

    if (request.operation === "coordinator.ready") {
      const outcome = yield* Effect.either(markCoordinatorReady(request.input));
      if (Either.isLeft(outcome)) {
        print(failureResponse(request.operation, [outcome.left.issue], null));
        return 1;
      }
      print(successResponse(request.operation, { ownership: outcome.right }));
      return 0;
    }

    const outcome = yield* Effect.either(verifyCoordinator(request.input));
    if (Either.isLeft(outcome)) {
      print(failureResponse(request.operation, [outcome.left.issue], null));
      return 1;
    }
    print(successResponse(request.operation, outcome.right));
    return 0;
  });

const program = Effect.gen(function* () {
  const raw = yield* readStdin();
  const request = yield* parseRequest(raw);
  return yield* execute(request);
});

const outcome = await Effect.runPromise(Effect.either(program));
if (Either.isLeft(outcome)) {
  print(failureResponse(outcome.left.operation, [outcome.left.issue], null));
  process.exitCode = 2;
} else {
  process.exitCode = outcome.right;
}
