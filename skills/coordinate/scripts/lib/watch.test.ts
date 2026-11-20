import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { createDocument, itemAdd, itemClose, itemUpdate } from "./backlog-doc.ts";
import { emptyBacklog, type ItemUpdate } from "./backlog-store/ops.ts";
import { resolveConfig } from "./config.ts";
import { cliEnv, runWith, tempDir } from "./fixture.ts";
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
        follow: false,
        emit: () => undefined,
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

const quietHc = (argv: readonly string[]): RunOutput => {
  if (argv[0] === "hc" && argv[1] === "ls") return ok('{"terminals":[]}');
  throw new Error(`unexpected command: ${argv.join(" ")}`);
};

const NOW = "2026-11-10T09:00:00.000Z";
const update = (id: string, change: Partial<ItemUpdate>): ItemUpdate & { json: boolean } => ({
  id,
  status: undefined,
  outcome: undefined,
  decided: [],
  touch: [],
  untouch: [],
  due: undefined,
  ask: undefined,
  context: undefined,
  options: [],
  rec: undefined,
  why: undefined,
  answer: undefined,
  now: NOW,
  json: false,
  ...change,
});

const dueDomain = async () => {
  const state = tempDir();
  made.push(state);
  const config = await Effect.runPromise(
    resolveConfig({ state_dir: state, backlog_dir: join(state, "md") }, "/c"),
  );
  await runWith(createDocument(config, "app"));
  for (const title of ["Fix login", "Ship later", "Old reminder"])
    await runWith(itemAdd(config, "app", { title, json: false, now: NOW }));
  await runWith(itemUpdate(config, "app", update("i1", { due: "2026-11-12" })));
  await runWith(itemUpdate(config, "app", update("i2", { due: "2026-12-01" })));
  await runWith(itemUpdate(config, "app", update("i3", { due: "2026-11-11" })));
  await runWith(
    itemClose(config, "app", {
      id: "i3",
      outcome: "no longer needed",
      dismissed: true,
      json: false,
      now: NOW,
    }),
  );
  const arm = (today: string) =>
    runWith(
      watch(config, {
        domain: "app",
        intervalMs: 5,
        forgeIntervalMs: 60_000,
        maxMs: 20,
        owner: undefined,
        replace: false,
        today: () => today,
        follow: false,
        emit: () => undefined,
      }),
      fakeProc(quietHc).layer,
    );
  const documentFile = join(state, "backlogs", "app.json");
  const stateFile = join(state, "watch", "app.json");
  return { config, arm, documentFile, stateFile };
};
const alive = ["alive: no events in 0m; re-arm the watcher"];

describe("watch due events", () => {
  it("fires a due open item once per id and date across re-arms, never a closed one", async () => {
    const { config, arm, stateFile } = await dueDomain();
    expect(await arm("2026-11-11")).toEqual(alive);
    expect(await arm("2026-11-12")).toEqual(["due 2026-11-12: i1 Fix login"]);
    expect(await arm("2026-11-13")).toEqual(alive);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).due).toEqual(["i1 2026-11-12"]);
    await runWith(itemUpdate(config, "app", update("i1", { due: "2026-11-14" })));
    expect(await arm("2026-11-14")).toEqual(["due 2026-11-14: i1 Fix login"]);
    await runWith(itemUpdate(config, "app", update("i1", { due: null })));
    await runWith(itemUpdate(config, "app", update("i1", { due: "2026-11-12" })));
    expect(await arm("2026-11-15")).toEqual(alive);
    expect(await arm("2026-12-01")).toEqual(["due 2026-12-01: i2 Ship later"]);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).due).toEqual([
      "i1 2026-11-12",
      "i1 2026-11-14",
      "i2 2026-12-01",
    ]);
  });

  it("does not fire again when an item's title is edited", async () => {
    const { arm, documentFile } = await dueDomain();
    expect(await arm("2026-11-12")).toEqual(["due 2026-11-12: i1 Fix login"]);
    const document = JSON.parse(readFileSync(documentFile, "utf8"));
    document.items[0].title = "Fix login on Safari";
    writeFileSync(documentFile, JSON.stringify(document));
    expect(await arm("2026-11-13")).toEqual(alive);
  });

  it("re-arms on a state file written by the Markdown watcher", async () => {
    const { arm, stateFile } = await dueDomain();
    mkdirSync(join(stateFile, ".."), { recursive: true });
    writeFileSync(
      stateFile,
      JSON.stringify({ delegates: {}, prs: {}, due: ["2026-11-01 **Fix** due: 2026-11-01"] }),
    );
    expect(await arm("2026-11-12")).toEqual(["due 2026-11-12: i1 Fix login"]);
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toEqual({
      delegates: {},
      prs: {},
      due: ["2026-11-01 **Fix** due: 2026-11-01", "i1 2026-11-12"],
      answered: [],
      discussed: [],
    });
    writeFileSync(stateFile, JSON.stringify({ delegates: {}, prs: {} }));
    expect(await arm("2026-11-12")).toEqual(["due 2026-11-12: i1 Fix login"]);
    expect(await arm("2026-11-12")).toEqual(alive);
  });
});

const ask = (question: string) => update("i1", { ask: question, options: ["A", "B"] });

describe("watch answered events", () => {
  it("fires each answer once across re-arms, carrying the item id and the answer", async () => {
    const { config, arm, stateFile } = await dueDomain();
    await runWith(itemUpdate(config, "app", ask("Which login provider?")));
    expect(await arm("2026-11-10")).toEqual(alive);
    await runWith(itemUpdate(config, "app", update("i1", { answer: "B" })));
    expect(await arm("2026-11-10")).toEqual([
      'answered i1 Fix login: Re "Which login provider?": B',
    ]);
    expect(await arm("2026-11-10")).toEqual(alive);
    await runWith(itemUpdate(config, "app", ask("Ship it behind a flag?")));
    await runWith(itemUpdate(config, "app", update("i1", { answer: "yes, flag it" })));
    expect(await arm("2026-11-10")).toEqual([
      'answered i1 Fix login: Re "Ship it behind a flag?": yes, flag it',
    ]);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).answered).toEqual([
      'i1 2026-11-10 #1 Re "Which login provider?": B',
      'i1 2026-11-10 #1 Re "Ship it behind a flag?": yes, flag it',
    ]);
  });

  it("stays quiet when an ask is replaced or its item closes", async () => {
    const { config, arm } = await dueDomain();
    await runWith(itemUpdate(config, "app", ask("Which login provider?")));
    expect(await arm("2026-11-10")).toEqual(alive);
    await runWith(itemUpdate(config, "app", ask("Which session store?")));
    expect(await arm("2026-11-10")).toEqual(alive);
    await runWith(
      itemClose(config, "app", {
        id: "i1",
        outcome: "moot",
        dismissed: true,
        json: false,
        now: NOW,
      }),
    );
    expect(await arm("2026-11-10")).toEqual(alive);
  });

  it("seeds without firing on a first arm or a state file from before answers fired", async () => {
    const { config, arm, stateFile } = await dueDomain();
    await runWith(itemUpdate(config, "app", ask("Which login provider?")));
    await runWith(itemUpdate(config, "app", update("i1", { answer: "A" })));
    expect(await arm("2026-11-10")).toEqual(alive);
    writeFileSync(stateFile, JSON.stringify({ delegates: {}, prs: {}, due: [] }));
    expect(await arm("2026-11-10")).toEqual(alive);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).answered).toEqual([
      'i1 2026-11-10 #1 Re "Which login provider?": A',
    ]);
    await runWith(itemUpdate(config, "app", update("i2", { ask: "Now or later?" })));
    await runWith(itemUpdate(config, "app", update("i2", { answer: "later" })));
    expect(await arm("2026-11-10")).toEqual(['answered i2 Ship later: Re "Now or later?": later']);
  });

  it("fires a repeated answer on the same day, and one recorded while the watch runs", async () => {
    const { config, arm } = await dueDomain();
    await runWith(itemUpdate(config, "app", ask("Retry now?")));
    expect(await arm("2026-11-10")).toEqual(alive);
    const watching = runWith(
      watch(config, {
        domain: "app",
        intervalMs: 5,
        forgeIntervalMs: 60_000,
        maxMs: 5_000,
        owner: undefined,
        replace: false,
        today: () => "2026-11-10",
        follow: false,
        emit: () => undefined,
      }),
      fakeProc(quietHc).layer,
    );
    await Bun.sleep(50);
    await runWith(itemUpdate(config, "app", update("i1", { answer: "yes" })));
    expect(await watching).toEqual(['answered i1 Fix login: Re "Retry now?": yes']);
    await runWith(itemUpdate(config, "app", ask("Retry now?")));
    await runWith(itemUpdate(config, "app", update("i1", { answer: "yes" })));
    expect(await arm("2026-11-10")).toEqual(['answered i1 Fix login: Re "Retry now?": yes']);
  });
});

describe("watch discussion events", () => {
  it("fires each discussion request once and seeds old watcher state", async () => {
    const { config, arm, stateFile } = await dueDomain();
    await runWith(itemUpdate(config, "app", ask("Which login provider?")));
    expect(await arm("2026-11-10")).toEqual(alive);

    await runWith(itemUpdate(config, "app", update("i1", { answer: "Discuss: compare SSO" })));
    expect(await arm("2026-11-10")).toEqual([
      'discuss i1 Fix login: "Which login provider?": compare SSO',
    ]);
    expect(await arm("2026-11-10")).toEqual(alive);
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(state.discussed).toEqual([
      'i1 2026-11-10 #1 Discuss "Which login provider?": compare SSO',
    ]);

    writeFileSync(
      stateFile,
      JSON.stringify({
        delegates: state.delegates,
        prs: state.prs,
        due: state.due,
        answered: state.answered,
      }),
    );
    expect(await arm("2026-11-10")).toEqual(alive);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).discussed).toEqual([
      'i1 2026-11-10 #1 Discuss "Which login provider?": compare SSO',
    ]);

    await runWith(itemUpdate(config, "app", ask("Which session store?")));
    await runWith(itemUpdate(config, "app", update("i1", { answer: "Discuss" })));
    expect(await arm("2026-11-10")).toEqual(['discuss i1 Fix login: "Which session store?"']);
  });
});

describe("watch --follow", () => {
  it("emits each tick's events without exiting, then stops once its owner is gone", async () => {
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
    // One tick per members listing: settle, then block, then no change while the owner goes.
    const ticks = [
      { status: "idle", turn: 5 },
      { status: "blocked", turn: 5 },
      { status: "blocked", turn: 5 },
    ];
    let tick = 0;
    const fake = fakeProc((argv) => {
      if (argv[1] === "ls" && argv.includes("fleet.role=coordinator"))
        return ok('{"terminals":[]}');
      if (argv[1] === "ls") {
        const now = ticks[Math.min(tick, ticks.length - 1)];
        tick += 1;
        return ok(
          JSON.stringify({
            terminals: [
              { address: "t2", name: "fix-a", state: "live", cwd: "/nonexistent", ...now },
            ],
          }),
        );
      }
      if (argv[1] === "get" && argv[2] === "t1")
        return tick < 3
          ? ok(JSON.stringify({ address: "t1", state: "live" }))
          : { exitCode: 1, stdout: "", stderr: '{"error":{"kind":"not_found","message":"gone"}}' };
      return ok("");
    });
    const emitted: string[] = [];
    const returned = await runWith(
      watch(config, {
        domain: "app",
        intervalMs: 5,
        forgeIntervalMs: 60_000,
        maxMs: 0,
        owner: "t1",
        replace: false,
        today: () => "2026-11-16",
        follow: true,
        emit: (line) => emitted.push(line),
      }),
      fake.layer,
    );
    expect(returned).toEqual([]);
    expect(emitted).toEqual([
      "settled fix-a (t2): read its REPORT.md, verify, then report",
      "status: 1 idle; give the user a short status in your next reply",
      "blocked fix-a (t2): a dialog or question; read it with hc read t2",
      "owner gone: t1 no longer runs; nothing will read these events",
    ]);
    expect(JSON.parse(readFileSync(join(state, "watch", "app.json"), "utf8")).delegates).toEqual({
      t2: { name: "fix-a", status: "blocked", turn: 5 },
    });
    expect(existsSync(lockPath(state, "app"))).toBe(false);
  });

  it("emits blind once herdr-core fails three times, and returns", async () => {
    const { config } = await dueDomain();
    const emitted: string[] = [];
    const fake = fakeProc(() => ({ exitCode: 1, stdout: "", stderr: "down" }));
    expect(
      await runWith(
        watch(config, {
          domain: "app",
          intervalMs: 5,
          forgeIntervalMs: 60_000,
          maxMs: 0,
          owner: undefined,
          replace: false,
          today: () => "2026-11-10",
          follow: true,
          emit: (line) => emitted.push(line),
        }),
        fake.layer,
      ),
    ).toEqual([]);
    expect(emitted).toEqual(["blind: herdr-core unreadable 3 times: down; re-arm the watcher"]);
  });

  it("prints a line to stdout while the CLI keeps running", async () => {
    const { config } = await dueDomain();
    const state = config.stateDir;
    await runWith(itemUpdate(config, "app", ask("Which login provider?")));
    const env = cliEnv(state, { "fleet.role": "coordinator", "fleet.domain": "app" });
    const cli = join(import.meta.dir, "..", "coordinate.ts");
    const child = Bun.spawn(
      ["bun", cli, "watch", "--follow", "--domain", "app", "--interval", "0.05"],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    try {
      const stateFile = join(state, "watch", "app.json");
      for (let waited = 0; !existsSync(stateFile) && waited < 10_000; waited += 20)
        await Bun.sleep(20);
      await runWith(itemUpdate(config, "app", update("i1", { answer: "B" })));
      const reader = child.stdout.getReader();
      let text = "";
      const deadline = Date.now() + 10_000;
      while (text.split("\n").length < 3 && Date.now() < deadline) {
        const chunk = await Promise.race([
          reader.read(),
          Bun.sleep(Math.max(0, deadline - Date.now())).then(() => ({
            done: true as const,
            value: undefined,
          })),
        ]);
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
      }
      reader.releaseLock();
      expect(text).toBe(
        'due 2026-11-12: i1 Fix login\nanswered i1 Fix login: Re "Which login provider?": B\n',
      );
      expect(child.exitCode).toBe(null);
    } finally {
      child.kill("SIGTERM");
      await child.exited;
    }
    expect(existsSync(lockPath(state, "app"))).toBe(false);
  });
});
