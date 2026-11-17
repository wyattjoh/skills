import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { emptyBacklog } from "./backlog-store/ops.ts";
import { resolveConfig } from "./config.ts";
import { runWith, tempDir } from "./fixture.ts";
import { fakeProc, ok, type RunOutput } from "./proc.ts";
import { delegateEvents, prEvents, statusBeat, watch } from "./watch.ts";
import { acquireLock, lockPath, releaseLock } from "./watch-lock.ts";

const made: string[] = [];
afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true });
});

describe("delegateEvents", () => {
  it("fires on settle, a new settled turn, blocked, error and gone", () => {
    expect(
      delegateEvents(
        {
          t1: { name: "a", status: "working", turn: 3 },
          t2: { name: "b", status: "idle", turn: 1 },
          t3: { name: "c", status: "working", turn: 1 },
          t4: { name: "d", status: "working", turn: 1 },
          t5: { name: "e", status: "idle", turn: 1 },
        },
        {
          t1: { name: "a", status: "idle", turn: 4 },
          t2: { name: "b", status: "idle", turn: 2 },
          t3: { name: "c", status: "blocked", turn: 1 },
          t4: { name: "d", status: "error", turn: 1 },
        },
      ),
    ).toEqual([
      "settled a (t1): read its REPORT.md, verify, then report",
      "settled b (t2): read its REPORT.md, verify, then report",
      "blocked c (t3): a dialog or question; read it with hc read t3",
      "error d (t4): read its terminal",
      "gone e (t5): resume with coordinate resume e, or record it ended",
    ]);
  });

  it("stays quiet when nothing changed or a delegate starts working", () => {
    const seen = { t1: { name: "a", status: "idle", turn: 3 } };
    expect(delegateEvents(seen, seen)).toEqual([]);
    expect(delegateEvents(seen, { t1: { name: "a", status: "working", turn: 3 } })).toEqual([]);
    expect(delegateEvents({}, seen)).toEqual([]);
  });
});

const seenPr = (state: string, checks = "pass", review = "none") => ({
  state,
  checks,
  review,
  url: "u",
});

describe("prEvents", () => {
  it("fires on merge, close, failed checks and reviews of PRs seen before", () => {
    expect(
      prEvents(
        {
          "h/o/r#1": seenPr("open"),
          "h/o/r#2": seenPr("open"),
          "h/o/r#3": seenPr("open"),
          "h/o/r#4": seenPr("open"),
        },
        {
          "h/o/r#1": seenPr("merged"),
          "h/o/r#2": seenPr("closed"),
          "h/o/r#3": seenPr("open", "fail", "changes_requested"),
          "h/o/r#4": seenPr("open", "pass", "approved"),
          "h/o/r#5": seenPr("open", "fail"),
        },
      ),
    ).toEqual([
      "pr h/o/r#1 merged: sweep its worktree u",
      "pr h/o/r#2 closed unmerged u",
      "pr h/o/r#3 checks failed u",
      "pr h/o/r#3 changes requested u",
      "pr h/o/r#4 approved u",
    ]);
  });
});

describe("statusBeat", () => {
  it("counts delegates by status", () => {
    expect(
      statusBeat({
        t1: { name: "a", status: "idle", turn: 1 },
        t2: { name: "b", status: "working", turn: 1 },
        t3: { name: "c", status: "working", turn: 1 },
      }),
    ).toBe("status: 1 idle, 2 working; give the user a short status in your next reply");
  });
});

describe("watch lock", () => {
  it("takes the lock once and frees it on release", async () => {
    const state = tempDir();
    made.push(state);
    expect(await Effect.runPromise(acquireLock(state, "app", process.pid))).toEqual({ ok: true });
    expect(readFileSync(lockPath(state, "app"), "utf8")).toBe(`${process.pid}\n`);
    await Effect.runPromise(releaseLock(state, "app", process.pid));
    expect(existsSync(lockPath(state, "app"))).toBe(false);
  });

  it("replaces a stale lock whose pid is dead", async () => {
    const state = tempDir();
    made.push(state);
    mkdirSync(join(state, "watch"), { recursive: true });
    writeFileSync(lockPath(state, "app"), "999999\n");
    expect(await Effect.runPromise(acquireLock(state, "app", process.pid))).toEqual({ ok: true });
  });
});

const watchAnswer = (argv: readonly string[]): RunOutput => {
  if (argv[1] === "ls" && argv.includes("fleet.role=coordinator")) return ok('{"terminals":[]}');
  if (argv[1] === "ls")
    return ok(
      JSON.stringify({
        terminals: [
          {
            address: "t2",
            name: "fix-a",
            agent: "pi",
            status: "idle",
            turn: 5,
            state: "live",
            cwd: "/nonexistent",
          },
        ],
      }),
    );
  if (argv[1] === "get")
    return ok(
      JSON.stringify({
        address: "t2",
        name: "fix-a",
        state: "live",
        labels: { "fleet.domain": "app" },
        cwd: "/nonexistent",
      }),
    );
  return ok("");
};

describe("watch", () => {
  it("exits with a settle event and a status beat against its saved state", async () => {
    const state = tempDir();
    made.push(state);
    const config = await Effect.runPromise(
      resolveConfig({ state_dir: state, backlog_dir: join(state, "backlogs") }, "/c"),
    );
    mkdirSync(join(state, "backlogs"), { recursive: true });
    writeFileSync(join(state, "backlogs", "app.json"), JSON.stringify(emptyBacklog("app", null)));
    mkdirSync(join(state, "watch"), { recursive: true });
    writeFileSync(
      join(state, "watch", "app.json"),
      JSON.stringify({
        delegates: { t2: { name: "fix-a", status: "working", turn: 4 } },
        prs: {},
        due: [],
      }),
    );
    const fake = fakeProc(watchAnswer);
    const lines = await runWith(
      watch(config, {
        domain: "app",
        intervalMs: 10,
        forgeIntervalMs: 60_000,
        maxMs: 60_000,
        owner: undefined,
        replace: false,
        today: () => "2026-11-16",
      }),
      fake.layer,
    );
    expect(lines).toEqual([
      "settled fix-a (t2): read its REPORT.md, verify, then report",
      "status: 1 idle; give the user a short status in your next reply",
    ]);
    expect(
      JSON.parse(readFileSync(join(state, "watch", "app.json"), "utf8")).delegates.t2.turn,
    ).toBe(5);
    expect(existsSync(lockPath(state, "app"))).toBe(false);
  });
});
