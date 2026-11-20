import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { createDocument, itemAdd, itemClose, itemUpdate } from "./backlog-doc.ts";
import { emptyBacklog, type ItemUpdate } from "./backlog-store/ops.ts";
import type { Item } from "./backlog-store/schema.ts";
import { resolveConfig } from "./config.ts";
import { cliEnv, runWith, tempDir } from "./fixture.ts";
import { fakeProc, ok, type RunOutput } from "./proc.ts";
import {
  delegateEvents,
  emptyState,
  idleEvents,
  prEvents,
  statusBeat,
  watch,
  type IdleReminder,
} from "./watch.ts";
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

describe("idleEvents", () => {
  const start = 1_000_000;
  const delegates = { t1: { name: "fix-a", status: "idle", turn: 1 } };
  const details = { t1: { session: "s1", statusMs: start - 20 * 60_000 } };
  const tracked = (status: Item["status"], ask: Item["ask"] = null, session = "s1"): Item => ({
    id: "i1",
    title: "Fix login",
    status,
    touches: [],
    decided: [],
    ask,
    answered: [],
    due: null,
    delegates: [{ name: "fix-a", session, branch: null, worktree: null, brief: "", report: "" }],
    createdAt: "2026-11-20T00:00:00.000Z",
    closedAt: null,
    outcome: null,
  });

  it("fires immediately and backs off 15, 30, then 60 minutes per unchanged delegate", () => {
    const reminders: Record<string, IdleReminder> = {};
    expect(idleEvents(delegates, details, [], reminders, start)).toEqual([
      "idle fix-a (t1) 20m: read its REPORT.md and give it a next step or end it",
    ]);
    expect(idleEvents(delegates, details, [], reminders, start + 14 * 60_000)).toEqual([]);
    expect(idleEvents(delegates, details, [], reminders, start + 15 * 60_000)).toEqual([
      "idle fix-a (t1) 35m: read its REPORT.md and give it a next step or end it",
    ]);
    expect(idleEvents(delegates, details, [], reminders, start + 44 * 60_000)).toEqual([]);
    expect(idleEvents(delegates, details, [], reminders, start + 45 * 60_000)).toEqual([
      "idle fix-a (t1) 1h: read its REPORT.md and give it a next step or end it",
    ]);
    expect(idleEvents(delegates, details, [], reminders, start + 104 * 60_000)).toEqual([]);
    expect(idleEvents(delegates, details, [], reminders, start + 105 * 60_000)).toEqual([
      "idle fix-a (t1) 2h: read its REPORT.md and give it a next step or end it",
    ]);
  });

  it("resets on status or turn changes and honors the saved deadline after re-arming", () => {
    const reminders: Record<string, IdleReminder> = {};
    idleEvents(delegates, details, [], reminders, start);
    const changed = { t1: { ...delegates.t1, status: "blocked" } };
    const changedDetails = { t1: { session: "s1", statusMs: start + 60_000 } };
    expect(idleEvents(changed, changedDetails, [], reminders, start + 60_000)).toEqual([
      "idle fix-a (t1) 0m: read its terminal with hc read t1",
    ]);
    const newTurnDetails = { t1: { session: "s1", statusMs: start + 120_000 } };
    expect(
      idleEvents(
        { t1: { ...changed.t1, turn: 2 } },
        newTurnDetails,
        [],
        reminders,
        start + 120_000,
      ),
    ).toEqual(["idle fix-a (t1) 0m: read its terminal with hc read t1"]);

    const saved = {
      t1: {
        status: "idle",
        turn: 1,
        since: start,
        next: start + 15 * 60_000,
        interval: 30,
      },
    };
    expect(idleEvents(delegates, details, [], saved, start + 60_000)).toEqual([]);
    expect(idleEvents(delegates, details, [], saved, start + 15 * 60_000)).toEqual([
      "idle fix-a (t1) 15m: read its REPORT.md and give it a next step or end it",
    ]);
    expect(saved.t1?.interval).toBe(60);
    expect(saved.t1?.next).toBe(start + 45 * 60_000);
  });

  it("suppresses parked and asked waiting-user items, but not waiting-user without an ask", () => {
    const current = {
      t1: { name: "parked", status: "idle", turn: 1 },
      t2: { name: "asked", status: "done", turn: 1 },
      t3: { name: "unasked", status: "idle", turn: 1 },
    };
    const refs = {
      t1: { session: "s1", statusMs: start },
      t2: { session: "s2", statusMs: start },
      t3: { session: "s3", statusMs: start },
    };
    const ask = {
      question: "Which option?",
      context: null,
      options: [],
      rec: null,
      recReason: null,
      discuss: null,
    };
    expect(
      idleEvents(
        current,
        refs,
        [
          tracked("parked", null, "s1"),
          tracked("waiting-user", ask, "s2"),
          tracked("waiting-user", null, "s3"),
        ],
        {},
        start,
      ),
    ).toEqual(["idle unasked (t3) 0m: read its REPORT.md and give it a next step or end it"]);
  });
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

const eventText = (line: string): string => line.replace(/ \[e[0-9a-z]+\]$/u, "");

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
    const emitted: string[] = [];
    const lines = await runWith(
      watch(config, {
        domain: "app",
        intervalMs: 10,
        forgeIntervalMs: 60_000,
        maxMs: 60_000,
        owner: undefined,
        replace: false,
        deliver: false,
        today: () => "2026-11-16",
        follow: false,
        emit: (line) => {
          emitted.push(line);
        },
      }),
      fake.layer,
    );
    expect(lines).toEqual([]);
    expect(emitted.map(eventText)).toEqual([
      "settled fix-a (t2): read its REPORT.md, verify, then report",
      "status: 1 idle; give the user a short status in your next reply",
      "idle fix-a (t2) 0m: read its REPORT.md and give it a next step or end it",
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
  const arm = async (today: string) => {
    const emitted: string[] = [];
    const returned = await runWith(
      watch(config, {
        domain: "app",
        intervalMs: 5,
        forgeIntervalMs: 60_000,
        maxMs: 20,
        owner: undefined,
        replace: false,
        deliver: false,
        today: () => today,
        follow: false,
        emit: (line) => {
          emitted.push(line);
        },
      }),
      fakeProc(quietHc).layer,
    );
    return [...returned, ...emitted.map(eventText)];
  };
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
      idle: {},
      outbox: [],
      nextEventId: 2,
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

  it("fires a repeated answer on the same day and sees one recorded during its poll", async () => {
    const { config, arm, documentFile } = await dueDomain();
    await runWith(itemUpdate(config, "app", ask("Retry now?")));
    expect(await arm("2026-11-10")).toEqual(alive);
    const waiting = readFileSync(documentFile, "utf8");
    await runWith(itemUpdate(config, "app", update("i1", { answer: "yes" })));
    const answered = readFileSync(documentFile, "utf8");
    writeFileSync(documentFile, waiting);

    let recordedDuringPoll = false;
    const fake = fakeProc((argv) => {
      if (argv[1] === "ls" && !recordedDuringPoll) {
        recordedDuringPoll = true;
        writeFileSync(documentFile, answered);
      }
      return quietHc(argv);
    });
    const emitted: string[] = [];
    const returned = await runWith(
      watch(config, {
        domain: "app",
        intervalMs: 0,
        forgeIntervalMs: 60_000,
        maxMs: 0,
        owner: undefined,
        replace: false,
        deliver: false,
        today: () => "2026-11-10",
        now: () => 1_000_000,
        follow: false,
        emit: (line) => {
          emitted.push(line);
        },
      }),
      fake.layer,
    );
    expect(returned).toEqual([]);
    expect(emitted.map(eventText)).toEqual(['answered i1 Fix login: Re "Retry now?": yes']);
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

describe("watch --deliver outbox", () => {
  const liveCoordinator = JSON.stringify({
    address: "t1",
    name: "coordinator",
    state: "live",
    labels: { "fleet.role": "coordinator", "fleet.domain": "app" },
  });
  const goneCoordinator = {
    exitCode: 3,
    stdout: "",
    stderr: '{"error":{"kind":"not_found","message":"gone"}}',
  };
  const options = {
    domain: "app",
    intervalMs: 0,
    forgeIntervalMs: 60_000,
    maxMs: 0,
    owner: "t1",
    replace: false,
    deliver: true,
    today: () => "2026-11-12",
    now: () => 1_000_000,
    follow: true,
    emit: () => undefined,
  };

  it("retries a refused tick with the same event id and sends one batch per tick", async () => {
    const { config, stateFile } = await dueDomain();
    let ownerReads = 0;
    let sends = 0;
    const fake = fakeProc((argv) => {
      if (argv[1] === "ls") return ok('{"terminals":[]}');
      if (argv[1] === "get" && argv[2] === "t1") {
        ownerReads += 1;
        return ownerReads <= 3 ? ok(liveCoordinator) : goneCoordinator;
      }
      if (argv[1] === "send") {
        sends += 1;
        return sends === 1
          ? {
              exitCode: 1,
              stdout: "",
              stderr: '{"error":{"kind":"blocked","message":"dialog"}}',
            }
          : ok();
      }
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    });

    expect(await runWith(watch(config, options), fake.layer)).toEqual([]);
    const messages = fake.calls
      .filter((call) => call.argv[1] === "send")
      .map((call) => call.argv[3]);
    expect(messages).toEqual([
      "due 2026-11-12: i1 Fix login [e1]",
      "due 2026-11-12: i1 Fix login [e1]",
    ]);
    const saved = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(saved.due).toEqual(["i1 2026-11-12"]);
    expect(saved.nextEventId).toBe(2);
    expect(saved.outbox).toEqual([]);
  });

  it("keeps stdout events pending when the writer rejects, then removes them after a successful write", async () => {
    const { config, stateFile } = await dueDomain();
    const failedWrite: string[] = [];
    const failed = {
      ...options,
      deliver: false,
      owner: undefined,
      follow: false,
      emit: (line: string) => {
        failedWrite.push(line);
        throw new Error("stdout unavailable");
      },
    };
    const fake = fakeProc((argv) => {
      if (argv[1] === "ls") return ok('{"terminals":[]}');
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    });

    await expect(runWith(watch(config, failed), fake.layer)).rejects.toThrow("stdout unavailable");
    expect(failedWrite).toEqual(["due 2026-11-12: i1 Fix login [e1]"]);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).outbox).toEqual([
      { id: "1", line: "due 2026-11-12: i1 Fix login" },
    ]);

    const delivered: string[] = [];
    const recovered = {
      ...failed,
      emit: (line: string) => {
        delivered.push(line);
      },
    };
    expect(await runWith(watch(config, recovered), fake.layer)).toEqual([]);
    expect(delivered).toEqual(["due 2026-11-12: i1 Fix login [e1]"]);
    const saved = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(saved.due).toEqual(["i1 2026-11-12"]);
    expect(saved.outbox).toEqual([]);
    expect(saved.nextEventId).toBe(2);
  });

  it("recovers a staged outbox on the next start without creating another event", async () => {
    const { config, stateFile } = await dueDomain();
    const initial = emptyState();
    mkdirSync(join(stateFile, ".."), { recursive: true });
    writeFileSync(
      stateFile,
      JSON.stringify({
        ...initial,
        outbox: [{ id: "1", line: "due 2026-11-12: i1 Fix login" }],
        nextEventId: 2,
        staged: {
          delegates: {},
          prs: {},
          due: ["i1 2026-11-12"],
          answered: null,
          discussed: null,
          idle: {},
        },
      }),
    );
    let ownerReads = 0;
    const fake = fakeProc((argv) => {
      if (argv[1] === "ls") return ok('{"terminals":[]}');
      if (argv[1] === "get" && argv[2] === "t1") {
        ownerReads += 1;
        return ownerReads <= 2 ? ok(liveCoordinator) : goneCoordinator;
      }
      if (argv[1] === "send") return ok();
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    });

    expect(await runWith(watch(config, options), fake.layer)).toEqual([]);
    expect(
      fake.calls.filter((call) => call.argv[1] === "send").map((call) => call.argv[3]),
    ).toEqual(["due 2026-11-12: i1 Fix login [e1]"]);
    const saved = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(saved.due).toEqual(["i1 2026-11-12"]);
    expect(saved.outbox).toEqual([]);
    expect(saved.nextEventId).toBe(2);
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
        deliver: false,
        today: () => "2026-11-16",
        follow: true,
        emit: (line) => {
          emitted.push(line);
        },
      }),
      fake.layer,
    );
    expect(returned).toEqual([]);
    expect(emitted.map(eventText)).toEqual([
      "settled fix-a (t2): read its REPORT.md, verify, then report",
      "status: 1 idle; give the user a short status in your next reply",
      "idle fix-a (t2) 0m: read its REPORT.md and give it a next step or end it",
      "blocked fix-a (t2): a dialog or question; read it with hc read t2",
      "idle fix-a (t2) 0m: read its terminal with hc read t2",
      "status: 1 blocked; give the user a short status in your next reply",
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
          deliver: false,
          today: () => "2026-11-10",
          follow: true,
          emit: (line) => {
            emitted.push(line);
          },
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
        'due 2026-11-12: i1 Fix login [e1]\nanswered i1 Fix login: Re "Which login provider?": B [e2]\n',
      );
      expect(child.exitCode).toBe(null);
    } finally {
      child.kill("SIGTERM");
      await child.exited;
    }
    expect(existsSync(lockPath(state, "app"))).toBe(false);
  });
});
