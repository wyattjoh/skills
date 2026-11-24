import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { emptyBacklog } from "./backlog-store/ops.ts";
import { resolveConfig } from "./config.ts";
import { runWith, tempDir } from "./fixture.ts";
import { fakeDocCores, memoryDocTransport } from "./herdr-docs-fake.ts";
import { domainLeases, renewWatchedLease, takeLease } from "./lease.ts";
import { FAKE_CORE, fakeProc, ok } from "./proc.ts";
import { herdrStore } from "./state-herdr.ts";
import { keys, runCommand } from "./state-store.ts";

const made: string[] = [];
afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true });
});

const T0 = Date.parse("2026-11-23T12:00:00.000Z");

describe("renewWatchedLease", () => {
  it("renews once a minute has passed since the last try, and not before", async () => {
    const state = tempDir();
    made.push(state);
    const config = await Effect.runPromise(
      resolveConfig({ state_dir: state, backlog_dir: join(state, "md") }, "/c"),
    );
    const path = join(state, "backlogs", "app.json");
    mkdirSync(join(state, "backlogs"), { recursive: true });
    const lease = { machine: FAKE_CORE, address: "t9", expiry: "2026-11-23T12:03:00.000Z" };
    writeFileSync(path, JSON.stringify({ ...emptyBacklog("app", null), lease }));
    const fake = fakeProc(() => ok("{}"));
    const early = await runWith(
      renewWatchedLease(config, "app", "t9", T0 + 59_999, T0),
      fake.layer,
    );
    expect([early, JSON.parse(readFileSync(path, "utf8")).lease, fake.calls.length]).toEqual([
      T0,
      lease,
      0,
    ]);
    const due = await runWith(renewWatchedLease(config, "app", "t9", T0 + 60_000, T0), fake.layer);
    expect([due, JSON.parse(readFileSync(path, "utf8")).lease]).toEqual([
      T0 + 60_000,
      { machine: FAKE_CORE, address: "t9", expiry: "2026-11-23T12:04:00.000Z" },
    ]);
  });

  it("gives up quietly when this core cannot be named, trying again a minute later", async () => {
    const state = tempDir();
    made.push(state);
    const config = await Effect.runPromise(
      resolveConfig({ state_dir: state, backlog_dir: join(state, "md") }, "/c"),
    );
    const down = fakeProc(
      () => ({ exitCode: 1, stdout: "", stderr: "herdr-core is not answering" }),
      {
        core: undefined,
      },
    );
    expect(
      await runWith(
        renewWatchedLease(config, "app", "t9", T0, Number.NEGATIVE_INFINITY),
        down.layer,
      ),
    ).toBe(T0);
  });
});

const noRemote = () => Effect.die(new Error("no archive in this test"));

describe("domainLeases", () => {
  it("lists every domain's lease on the home, naming each coordinator as the reader's machine does", async () => {
    // The manager runs on strix; the home is homebase; coordinators run on three machines.
    const cores = fakeDocCores("strix", { homebase: "up" });
    const stateDir = tempDir("coordinate-leases-");
    made.push(stateDir);
    const store = herdrStore({
      home: "homebase",
      prefix: "ct.",
      appendRemote: noRemote,
      readRemote: noRemote,
      transport: memoryDocTransport(cores),
      self: Effect.succeed("strix"),
      stateDir,
    });
    const seed = (domain: string) =>
      Effect.runPromise(
        runCommand(store, keys.backlog(domain), () =>
          Effect.succeed({ write: true as const, next: emptyBacklog(domain, null), value: domain }),
        ),
      );
    for (const domain of ["app", "web", "ops", "lab", "docs"]) await seed(domain);
    const take = (domain: string, machine: string, address: string, at: number) =>
      Effect.runPromise(takeLease(store, domain, { machine, address }, at));
    await take("app", "strix", "t1", T0);
    await take("web", "homebase", "t7", T0);
    await take("ops", "nigelsheldon", "t4", T0);
    await take("lab", "homebase", "t2", T0 - 600_000);
    expect(await Effect.runPromise(domainLeases(store, "strix", T0 + 60_000))).toEqual([
      {
        domain: "app",
        lease: { machine: "strix", address: "t1", expiry: "2026-11-23T12:03:00.000Z" },
        live: true,
        coordinator: "t1",
      },
      { domain: "docs", lease: null, live: false, coordinator: null },
      {
        domain: "lab",
        lease: { machine: "homebase", address: "t2", expiry: "2026-11-23T11:53:00.000Z" },
        live: false,
        coordinator: null,
      },
      {
        domain: "ops",
        lease: { machine: "nigelsheldon", address: "t4", expiry: "2026-11-23T12:03:00.000Z" },
        live: true,
        coordinator: "nigelsheldon/t4",
      },
      {
        domain: "web",
        lease: { machine: "homebase", address: "t7", expiry: "2026-11-23T12:03:00.000Z" },
        live: true,
        coordinator: "homebase/t7",
      },
    ]);
  });
});
