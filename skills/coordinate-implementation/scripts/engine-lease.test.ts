import { describe, expect, it } from "bun:test";
import { Cause, Effect, Exit, Result } from "effect";
import { readFileSync } from "node:fs";
import {
  claimEngineLease,
  EngineLeaseError,
  engineLiveness,
  leaseIssue,
  fencedMutate,
  readEngineHeartbeat,
  readEngineLease,
  releaseEngineLease,
  writeEngineHeartbeat,
} from "./lib/engine-lease.ts";
import { leaseFence } from "./lib/engine.ts";
import {
  mutateStateFile,
  StateGuardRejected,
  StateMutationGuard,
  type StateMutationError,
} from "./lib/state-mutation.ts";
import { tempStateFile } from "./test-fixtures.ts";

const now = new Date("2026-09-25T12:00:00.000Z");

const stateFile = (): string => tempStateFile("coordinate-lease-");

const claim = (statePath: string, expectedGeneration: number, pid = 101) =>
  claimEngineLease({
    statePath,
    expectedGeneration,
    pid,
    host: "host-a",
    pane: "w1:p9",
    scriptSha256: "abc",
    now,
  });

const failureCode = (
  outcome: Result.Result<unknown, EngineLeaseError | StateMutationError>,
): string => (Result.isFailure(outcome) ? leaseIssue(outcome.failure).code : "ok");

describe("engine lease", () => {
  it("claims generation 1 on a run without a lease and reads it back", async () => {
    const statePath = stateFile();

    const lease = await Effect.runPromise(claim(statePath, 0));
    const read = await Effect.runPromise(readEngineLease(statePath));

    expect(lease).toEqual({
      generation: 1,
      pid: 101,
      host: "host-a",
      pane: "w1:p9",
      script_sha256: "abc",
      claimed_at: "2026-09-25T12:00:00Z",
      released_at: null,
    });
    expect(read).toEqual(lease);
  });

  it("lets exactly one of two racing claimants win", async () => {
    const statePath = stateFile();

    const outcomes = await Promise.all([
      Effect.runPromise(Effect.result(claim(statePath, 0, 1))),
      Effect.runPromise(Effect.result(claim(statePath, 0, 2))),
    ]);

    expect(outcomes.map(failureCode).toSorted()).toEqual(["engine.claim_stale", "ok"]);
  });

  it("fences writes from a superseded generation", async () => {
    const statePath = stateFile();
    await Effect.runPromise(claim(statePath, 0));
    await Effect.runPromise(claim(statePath, 1));

    const stale = await Effect.runPromise(
      Effect.result(
        fencedMutate(statePath, 1, (markdown) =>
          Effect.succeed({ markdown: `${markdown}\nstale write\n`, result: "written" }),
        ),
      ),
    );
    const current = await Effect.runPromise(
      fencedMutate(statePath, 2, (markdown) => Effect.succeed({ markdown, result: "written" })),
    );

    expect(failureCode(stale)).toBe("engine.lease_lost");
    expect(current).toBe("written");
  });

  it("fences every state mutation in scope of the Engine guard", async () => {
    const statePath = stateFile();
    await Effect.runPromise(claim(statePath, 0));
    await Effect.runPromise(claim(statePath, 1));
    const before = readFileSync(statePath, "utf8");
    const write = (generation: number) =>
      Effect.runPromiseExit(
        mutateStateFile(statePath, (markdown) =>
          Effect.succeed({ markdown: `${markdown}\nwrite ${generation}\n`, result: generation }),
        ).pipe(Effect.provideService(StateMutationGuard, leaseFence(generation))),
      );

    const stale = await write(1);

    const defect = Exit.isFailure(stale) ? Cause.squash(stale.cause) : null;
    expect(defect instanceof StateGuardRejected ? defect.issue.code : "none").toBe(
      "engine.lease_lost",
    );
    expect(readFileSync(statePath, "utf8")).toBe(before);
    expect(await write(2)).toEqual(Exit.succeed(2));
  });

  it("refuses fenced writes after release", async () => {
    const statePath = stateFile();
    await Effect.runPromise(claim(statePath, 0));
    const released = await Effect.runPromise(releaseEngineLease(statePath, 1, now));

    const outcome = await Effect.runPromise(
      Effect.result(
        fencedMutate(statePath, 1, (markdown) => Effect.succeed({ markdown, result: "x" })),
      ),
    );

    expect(released.released_at).toBe("2026-09-25T12:00:00Z");
    expect(failureCode(outcome)).toBe("engine.lease_lost");
  });

  it("classifies liveness from the lease and heartbeat", async () => {
    const statePath = stateFile();
    const lease = await Effect.runPromise(claim(statePath, 0));
    await Effect.runPromise(
      writeEngineHeartbeat(statePath, { generation: 1, pid: 101, at: "2026-09-25T12:00:00Z" }),
    );
    const heartbeat = await Effect.runPromise(readEngineHeartbeat(statePath));

    expect([
      engineLiveness(null, null, now, 60_000),
      engineLiveness(lease, heartbeat, new Date("2026-09-25T12:00:30Z"), 60_000),
      engineLiveness(lease, heartbeat, new Date("2026-09-25T12:05:00Z"), 60_000),
      engineLiveness(lease, { ...heartbeat!, generation: 0 }, now, 60_000),
      engineLiveness(lease, null, new Date("2026-09-25T12:05:00Z"), 60_000),
      engineLiveness({ ...lease, released_at: "2026-09-25T12:01:00Z" }, heartbeat, now, 60_000),
    ]).toEqual(["none", "alive", "stale", "alive", "stale", "released"]);
  });
});
