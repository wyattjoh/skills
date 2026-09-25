import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Fiber } from "effect";
import { makeHerdrHub, type HerdrHub } from "./lib/herdr-hub.ts";
import { startFakeHerdr, type FakeHerdrServer } from "./test-herdr-server.ts";

const servers: FakeHerdrServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const serve = async (agents: Parameters<typeof startFakeHerdr>[0]) => {
  const server = await startFakeHerdr(agents);
  servers.push(server);
  return server;
};

const withHub = <A>(
  path: string,
  body: (hub: HerdrHub) => Effect.Effect<A, unknown>,
  options: Parameters<typeof makeHerdrHub>[1] = {},
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(Effect.flatMap(makeHerdrHub(path, options), body)) as Effect.Effect<A>,
  );

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Herdr event hub", () => {
  it("resolves immediately from the snapshot when the status already matches", async () => {
    const server = await serve([{ session: "ex-01", pane: "w1:p1", status: "idle" }]);

    const result = await withHub(server.path, (hub) =>
      hub.awaitStatus({ session: "ex-01", paneId: "w1:p1" }, ["idle", "done"]),
    );

    expect(result).toEqual({ session: "ex-01", pane_id: "w1:p1", status: "idle" });
  });

  it("wakes each waiter on its own pane's event", async () => {
    const server = await serve([
      { session: "ex-01", pane: "w1:p1", status: "working" },
      { session: "ex-02", pane: "w1:p2", status: "working" },
    ]);

    const results = await withHub(server.path, (hub) =>
      Effect.gen(function* () {
        const first = yield* Effect.forkChild(
          hub.awaitStatus({ session: "ex-01", paneId: "w1:p1" }, ["idle"]),
        );
        const second = yield* Effect.forkChild(
          hub.awaitStatus({ session: "ex-02", paneId: "w1:p2" }, ["done"]),
        );
        yield* Effect.promise(() => tick(100));
        server.setStatus("ex-02", "done", true);
        server.setStatus("ex-01", "idle", true);
        return [yield* Fiber.join(first), yield* Fiber.join(second)];
      }),
    );

    expect(results.map((result) => `${result.session}:${result.status}`)).toEqual([
      "ex-01:idle",
      "ex-02:done",
    ]);
  });

  it("reports an exited pane", async () => {
    const server = await serve([{ session: "ex-03", pane: "w1:p3", status: "working" }]);

    const result = await withHub(server.path, (hub) =>
      Effect.gen(function* () {
        const waiting = yield* Effect.forkChild(
          hub.awaitStatus({ session: "ex-03", paneId: "w1:p3" }, ["idle", "exited"]),
        );
        yield* Effect.promise(() => tick(100));
        server.exitPane("w1:p3");
        return yield* Fiber.join(waiting);
      }),
    );

    expect(result.status).toBe("exited");
  });

  it("recovers a missed event through the periodic snapshot reconcile", async () => {
    const server = await serve([{ session: "ex-04", pane: "w1:p4", status: "working" }]);

    const result = await withHub(
      server.path,
      (hub) =>
        Effect.gen(function* () {
          const waiting = yield* Effect.forkChild(
            hub.awaitStatus({ session: "ex-04", paneId: "w1:p4" }, ["idle"]),
          );
          yield* Effect.promise(() => tick(100));
          server.setStatus("ex-04", "idle", false);
          return yield* Fiber.join(waiting);
        }),
      { reconcileMs: 200 },
    );

    expect(result.status).toBe("idle");
  });

  it("reconnects after the subscription drops", async () => {
    const server = await serve([{ session: "ex-05", pane: "w1:p5", status: "working" }]);

    const result = await withHub(
      server.path,
      (hub) =>
        Effect.gen(function* () {
          const waiting = yield* Effect.forkChild(
            hub.awaitStatus({ session: "ex-05", paneId: "w1:p5" }, ["done"]),
          );
          yield* Effect.promise(() => tick(100));
          server.dropSubscribers();
          yield* Effect.promise(() => tick(100));
          server.setStatus("ex-05", "done", true);
          return yield* Fiber.join(waiting);
        }),
      { reconnectDelaysMs: [10, 10, 10] },
    );

    expect(result.status).toBe("done");
    expect(server.subscriptions).toBe(2);
  });

  it("follows a compacted pane id through the session name", async () => {
    const server = await serve([{ session: "ex-06", pane: "w1:p60", status: "working" }]);

    const result = await withHub(server.path, (hub) =>
      Effect.gen(function* () {
        const waiting = yield* Effect.forkChild(
          hub.awaitStatus({ session: "ex-06", paneId: "w1:p6" }, ["idle"]),
        );
        yield* Effect.promise(() => tick(150));
        server.setStatus("ex-06", "idle", true);
        return yield* Fiber.join(waiting);
      }),
    );

    expect(result).toEqual({ session: "ex-06", pane_id: "w1:p60", status: "idle" });
  });
});
