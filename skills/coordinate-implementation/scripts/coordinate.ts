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
import { runPreflight } from "./lib/preflight.ts";
import { acceptSnapshot, checkSnapshot } from "./lib/snapshot.ts";
import { validateStateFile } from "./lib/state.ts";

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
