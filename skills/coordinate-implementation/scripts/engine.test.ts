import { describe, expect, it } from "bun:test";
import { Effect, Fiber, Result } from "effect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claimEngineLease, readEngineLease } from "./lib/engine-lease.ts";
import { runEngine, stopRequestPath, type EngineWorkflow } from "./lib/engine.ts";
import { readEventsSince } from "./lib/event-log.ts";

const stateFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "coordinate-engine-"));
  const path = join(dir, "RESUME.md");
  writeFileSync(path, "# Run\n\nSchema version: 2\n");
  return path;
};

const options = (statePath: string, workflow: EngineWorkflow) => ({
  statePath,
  expectedGeneration: 0,
  scriptSha256: "sha",
  pid: process.pid,
  host: "host-a",
  pane: "w1:p9",
  heartbeatMs: 20,
  now: () => new Date("2026-09-25T12:00:00.000Z"),
  workflow,
});

const eventTypes = async (statePath: string): Promise<string[]> =>
  (await Effect.runPromise(readEventsSince(dirname(statePath), 0))).events.map(
    (event) => event.type,
  );

describe("engine lifecycle", () => {
  it("runs the workflow, records events, and releases the lease on completion", async () => {
    const statePath = stateFile();

    const exit = await Effect.runPromise(
      runEngine(
        options(statePath, (context) =>
          context.emit("ticket.phase", "01", { to: "implementing" }).pipe(Effect.asVoid),
        ),
      ),
    );
    const lease = await Effect.runPromise(readEngineLease(statePath));

    expect(exit).toEqual({ reason: "completed", generation: 1 });
    expect(await eventTypes(statePath)).toEqual([
      "engine.started",
      "ticket.phase",
      "engine.completed",
    ]);
    expect(lease?.released_at).toBe("2026-09-25T12:00:00Z");
  });

  it("stops gracefully when a stop request names its generation", async () => {
    const statePath = stateFile();

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(runEngine(options(statePath, () => Effect.never)));
        yield* Effect.sleep(50);
        writeFileSync(stopRequestPath(statePath), JSON.stringify({ generation: 1 }));
        return yield* Fiber.join(fiber);
      }),
    );

    expect(exit).toEqual({ reason: "stopped", generation: 1 });
    expect(await eventTypes(statePath)).toEqual(["engine.started", "engine.stopped"]);
  });

  it("exits without writing when a newer generation claims the run", async () => {
    const statePath = stateFile();

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(runEngine(options(statePath, () => Effect.never)));
        yield* Effect.sleep(50);
        yield* claimEngineLease({
          statePath,
          expectedGeneration: 1,
          pid: 2,
          host: "host-b",
          pane: null,
          scriptSha256: "sha",
          now: new Date(),
        });
        return yield* Fiber.join(fiber);
      }),
    );
    const lease = await Effect.runPromise(readEngineLease(statePath));

    expect(exit).toEqual({ reason: "lease_lost", generation: 1 });
    expect(lease?.generation).toBe(2);
    expect(lease?.released_at).toBe(null);
  });

  it("reports a workflow failure as an attention event", async () => {
    const statePath = stateFile();

    const exit = await Effect.runPromise(
      runEngine(options(statePath, () => Effect.fail(new Error("boom")))),
    );
    const page = await Effect.runPromise(readEventsSince(dirname(statePath), 0));

    expect(exit.reason).toBe("failed");
    expect(page.events.at(-1)?.type).toBe("engine.failed");
    expect(page.events.at(-1)?.attention).toBe(true);
  });

  it("refuses to start when the expected generation is stale", async () => {
    const statePath = stateFile();
    await Effect.runPromise(runEngine(options(statePath, () => Effect.void)));

    const outcome = await Effect.runPromise(
      Effect.result(runEngine(options(statePath, () => Effect.void))),
    );

    expect(Result.isFailure(outcome) ? outcome.failure.issue.code : "ok").toBe(
      "engine.claim_stale",
    );
  });
});
