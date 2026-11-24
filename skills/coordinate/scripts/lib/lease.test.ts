import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { emptyBacklog } from "./backlog-store/ops.ts";
import { resolveConfig } from "./config.ts";
import { runWith, tempDir } from "./fixture.ts";
import { renewWatchedLease } from "./lease.ts";
import { FAKE_CORE, fakeProc, ok } from "./proc.ts";

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
