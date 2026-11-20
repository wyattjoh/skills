import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { type AttachOptions, attachDelegate, detachDelegate } from "./attach.ts";
import { itemAdd, itemClose, recordDelegate } from "./backlog-doc.ts";
import { fileDelegate } from "./backlog-store/ops.ts";
import { resolveConfig } from "./config.ts";
import { cliEnv, failureOf, g, gitAndFake, initRepo, runWith, tempDir } from "./fixture.ts";
import { HerdrError } from "./herdr.ts";
import { endDelegate, start } from "./lifecycle.ts";
import { fakeProc, ok, type RunOutput } from "./proc.ts";

const dirs: string[] = [];
const dir = () => {
  const made = tempDir();
  dirs.push(made);
  return made;
};
afterAll(() => {
  for (const made of dirs) rmSync(made, { recursive: true, force: true });
});
const NOW = "2026-11-17T10:00:00.000Z";
const SESSION = "0b9c2a51-0000-4000-8000-000000000001";
const config = (state: string) =>
  Effect.runPromise(resolveConfig({ backlog_dir: join(state, "md"), state_dir: state }, "/c"));
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const messageOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error);

const COORDINATOR = { "fleet.role": "coordinator", "fleet.domain": "app" };
const ENV = { HC_TERMINAL_ID: "t1" };

/**
 * A hand-started Claude Code terminal t4 in `cwd`, unless `fields` override it.
 */
const handStarted = (cwd: string, fields: Record<string, unknown> = {}) => ({
  address: "t4",
  name: "manual",
  state: "live",
  cwd,
  status: { app: "claude", state: "idle" },
  labels: {},
  foreground: { argv: ["claude", "--session-id", SESSION], cwd },
  ...fields,
});

/**
 * Answers for hc: the caller t1 as coordinator, and t4 as `target` (absent when undefined).
 */
const answers =
  (target: Record<string, unknown> | undefined) =>
  (argv: readonly string[]): RunOutput => {
    if (argv[0] !== "hc") throw new Error(`unexpected command: ${argv.join(" ")}`);
    if (argv[1] === "ls") return ok('{"terminals":[]}');
    if (argv[1] === "label") return ok("{}");
    if (argv[1] === "run") return ok('{"address":"t-watch","state":"live"}');
    if (argv[1] === "get" && argv[2] === "t1")
      return ok(JSON.stringify({ address: "t1", state: "live", labels: COORDINATOR }));
    if (argv[1] === "get" && target && (argv[2] === "t4" || argv[2] === target.name))
      return ok(JSON.stringify(target));
    if (argv[1] === "get")
      return { exitCode: 3, stdout: "", stderr: '{"error":{"kind":"not_found","message":"no"}}' };
    throw new Error(`unexpected command: ${argv.join(" ")}`);
  };

const started = async () => {
  const state = dir();
  const cfg = await config(state);
  await runWith(start(cfg, "app", ENV), fakeProc(answers(undefined)).layer);
  await runWith(itemAdd(cfg, "app", { title: "fix login", json: false, now: NOW }));
  await runWith(itemAdd(cfg, "app", { title: "fix signup", json: false, now: NOW }));
  return { state, cfg, path: join(state, "backlogs", "app.json") };
};

const options = (fields: Partial<AttachOptions>): AttachOptions => ({
  id: "i1",
  target: "t4",
  domain: undefined,
  json: false,
  session: undefined,
  ...fields,
});

const labelCalls = (calls: readonly (readonly string[])[]) =>
  calls.filter((argv) => argv[1] === "label");

describe("item attach", () => {
  it("files a hand-started session in a worktree and labels it like coordinate delegate", async () => {
    const { cfg, path } = await started();
    const repo = initRepo();
    dirs.push(repo);
    const worktree = join(repo, ".claude", "worktrees", "manual");
    g(repo, "worktree", "add", "-q", worktree, "-b", "wyattjoh/manual");
    mkdirSync(join(worktree, "src"));
    const fake = gitAndFake(answers(handStarted(join(worktree, "src"))));
    const lines = await runWith(attachDelegate(cfg, options({}), ENV), fake.layer);
    const labels = [
      "fleet.domain=app",
      "fleet.task=manual",
      `fleet.session=${SESSION}`,
      "fleet.harness=claude",
      `fleet.worktree=${join(worktree, "src")}`,
      "fleet.branch=wyattjoh/manual",
    ];
    expect(lines).toEqual([
      `filed manual (t4, session ${SESSION}) under i1 [delegated]`,
      `labelled t4: ${labels.join(" ")}`,
    ]);
    expect(labelCalls(fake.calls)).toEqual([["hc", "label", "t4", ...labels, "--json"]]);
    const item = read(path).items[0];
    expect([item.status, item.delegates]).toEqual([
      "delegated",
      [
        {
          name: "manual",
          session: SESSION,
          branch: "wyattjoh/manual",
          worktree,
          brief: join(worktree, ".scratch", "BRIEF.md"),
          report: join(worktree, ".scratch", "REPORT.md"),
        },
      ],
    ]);
  });

  it("files an unfiled coordinate delegate by name from its labels, labelling nothing", async () => {
    const { cfg, path } = await started();
    const labels = {
      "fleet.domain": "app",
      "fleet.task": "fix a",
      "fleet.session": SESSION,
      "fleet.harness": "pi",
      "fleet.worktree": "/r/app/.claude/worktrees/fix-a",
      "fleet.branch": "wyattjoh/fix-a",
    };
    const fake = gitAndFake(
      answers(handStarted("/r/app/.claude/worktrees/fix-a", { name: "fix-a", labels })),
    );
    const lines = await runWith(
      attachDelegate(cfg, options({ target: "fix-a", id: "i2" }), ENV),
      fake.layer,
    );
    expect(lines).toEqual([`filed fix-a (t4, session ${SESSION}) under i2 [delegated]`]);
    expect(labelCalls(fake.calls).length).toBe(0);
    expect(read(path).items[1].delegates).toEqual([
      {
        name: "fix-a",
        session: SESSION,
        branch: "wyattjoh/fix-a",
        worktree: "/r/app/.claude/worktrees/fix-a",
        brief: "/r/app/.claude/worktrees/fix-a/.scratch/BRIEF.md",
        report: "/r/app/.claude/worktrees/fix-a/.scratch/REPORT.md",
      },
    ]);
  });

  it("records no worktree, branch, brief or report outside Git", async () => {
    const { state, cfg, path } = await started();
    const fake = gitAndFake(answers(handStarted(state)));
    const lines = await runWith(attachDelegate(cfg, options({ json: true }), ENV), fake.layer);
    const item = read(path).items[0];
    expect(lines).toEqual([JSON.stringify(item, null, 2)]);
    expect(item.delegates).toEqual([
      { name: "manual", session: SESSION, branch: null, worktree: null, brief: "", report: "" },
    ]);
    expect(labelCalls(fake.calls)[0]?.includes(`fleet.worktree=${state}`)).toBe(true);
  });

  it.each([
    ["no live terminal", undefined, "no live terminal t4"],
    [
      "a coordinator",
      handStarted("/x", { labels: COORDINATOR }),
      "t4 is a coordinator, not a delegate",
    ],
    [
      "another domain's terminal",
      handStarted("/x", { labels: { "fleet.domain": "web" } }),
      "t4 is labelled for web, not app; its coordinator files it",
    ],
    [
      "a terminal with no session id",
      handStarted("/x", { foreground: { argv: ["claude"], cwd: "/x" } }),
      "t4 has no agent session id Herdr can see (no fleet.session label, no --session-id or --resume argument); pass it with --session <id> (in Claude Code, /status shows the session id)",
    ],
    [
      "a terminal running no agent",
      handStarted("/x", { status: { app: "zsh", state: "idle" } }),
      "t4 runs zsh, not pi or Claude Code",
    ],
    [
      "a --resume with no session after it",
      handStarted("/x", { foreground: { argv: ["claude", "--resume", "--verbose"], cwd: "/x" } }),
      "t4 has no agent session id Herdr can see (no fleet.session label, no --session-id or --resume argument); pass it with --session <id> (in Claude Code, /status shows the session id)",
    ],
  ])("refuses %s, writing and labelling nothing", async (_case, target, message) => {
    const { cfg, path } = await started();
    const before = readFileSync(path, "utf8");
    const fake = fakeProc(answers(target));
    const error = await failureOf(attachDelegate(cfg, options({}), ENV), fake.layer);
    expect(messageOf(error)).toBe(message);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(labelCalls(fake.calls.map((call) => call.argv)).length).toBe(0);
  });

  it("files a session Herdr cannot see with --session, and labels it", async () => {
    const { state, cfg, path } = await started();
    const fake = gitAndFake(
      answers(handStarted(state, { foreground: { argv: ["claude"], cwd: state } })),
    );
    const lines = await runWith(
      attachDelegate(cfg, options({ session: "s-typed" }), ENV),
      fake.layer,
    );
    expect(lines[0]).toBe("filed manual (t4, session s-typed) under i1 [delegated]");
    expect(labelCalls(fake.calls)[0]?.includes("fleet.session=s-typed")).toBe(true);
    expect(read(path).items[0].delegates[0].session).toBe("s-typed");
  });

  it.each([
    ["one Herdr sees otherwise", "s-other", `t4 runs session ${SESSION}, not s-other`],
    ["a flag", "--verbose", "--session --verbose is not a session id"],
  ])("refuses --session naming %s", async (_case, session, message) => {
    const { state, cfg, path } = await started();
    const before = readFileSync(path, "utf8");
    const fake = fakeProc(answers(handStarted(state)));
    const error = await failureOf(attachDelegate(cfg, options({ session }), ENV), fake.layer);
    expect(messageOf(error)).toBe(message);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("exits 2 naming the filing and the missing labels when hc label fails", async () => {
    const { state, cfg, path } = await started();
    const answer = answers(handStarted(state));
    const fake = gitAndFake((argv) =>
      argv[1] === "label"
        ? { exitCode: 1, stdout: "", stderr: '{"error":{"kind":"unavailable","message":"down"}}' }
        : answer(argv),
    );
    const error = await failureOf(attachDelegate(cfg, options({}), ENV), fake.layer);
    expect([error instanceof HerdrError, messageOf(error)]).toEqual([
      true,
      `filed manual under i1 but could not label t4 with fleet.domain=app fleet.task=manual fleet.session=${SESSION} fleet.harness=claude fleet.worktree=${state}: down`,
    ]);
    expect(read(path).items[0].delegates.length).toBe(1);
  });

  it("leaves a hand-started session labelled so end records where to resume it", async () => {
    const { cfg } = await started();
    const repo = initRepo();
    dirs.push(repo);
    const sub = join(repo, "src");
    mkdirSync(sub);
    const labels: Record<string, string> = {};
    const answer = answers(handStarted(sub));
    const attach = gitAndFake((argv) => {
      if (argv[1] === "label")
        for (const pair of argv.slice(3, -1)) {
          const at = pair.indexOf("=");
          labels[pair.slice(0, at)] = pair.slice(at + 1);
        }
      return answer(argv);
    });
    await runWith(attachDelegate(cfg, options({}), ENV), attach.layer);
    const ending = gitAndFake((argv) =>
      argv[1] === "get"
        ? ok(JSON.stringify(handStarted(sub, { labels })))
        : argv[1] === "ls"
          ? ok('{"terminals":[]}')
          : ok("{}"),
    );
    await runWith(endDelegate(cfg, "t4", false), ending.layer);
    const record = read(join(cfg.stateDir, "ended", `${SESSION}.json`));
    expect([record.name, record.cwd, record.session, record.program, record.domain]).toEqual([
      "manual",
      sub,
      SESSION,
      "claude",
      "app",
    ]);
  });

  it("refuses a closed or missing item before looking at the terminal", async () => {
    const { cfg } = await started();
    await runWith(
      itemClose(cfg, "app", { id: "i1", outcome: "x", dismissed: false, json: false, now: NOW }),
    );
    const fake = fakeProc(answers(handStarted("/x")));
    expect([
      messageOf(await failureOf(attachDelegate(cfg, options({}), ENV), fake.layer)),
      messageOf(await failureOf(attachDelegate(cfg, options({ id: "i9" }), ENV), fake.layer)),
    ]).toEqual(["i1 is already done; a delegate needs an open item", "no item i9 in app"]);
    expect(fake.calls.filter((call) => call.argv[2] === "t4").length).toBe(0);
  });

  it("refuses a session another item names, with the detach command", async () => {
    const { state, cfg, path } = await started();
    const fake = gitAndFake(answers(handStarted(state)));
    await runWith(attachDelegate(cfg, options({}), ENV), fake.layer);
    const before = readFileSync(path, "utf8");
    expect([
      messageOf(await failureOf(attachDelegate(cfg, options({ id: "i2" }), ENV), fake.layer)),
      messageOf(await failureOf(attachDelegate(cfg, options({}), ENV), fake.layer)),
    ]).toEqual([
      "manual is already filed under i1; detach it first: coordinate item detach i1 manual",
      "manual is already filed under i1",
    ]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("refuses a delegate caller", async () => {
    const { cfg } = await started();
    const fake = fakeProc((argv) =>
      argv[2] === "t1"
        ? ok(JSON.stringify({ address: "t1", state: "live", labels: { "fleet.domain": "app" } }))
        : answers(handStarted("/x"))(argv),
    );
    expect(messageOf(await failureOf(attachDelegate(cfg, options({}), ENV), fake.layer))).toBe(
      "only a coordinator changes the backlog, and terminal t1 is not labelled as one; a delegate records what it notices with coordinate finding add",
    );
  });
});

const ref = (name: string, session: string) => ({
  name,
  session,
  branch: null,
  worktree: null,
  brief: "",
  report: "",
});

describe("item detach", () => {
  it("removes an ended delegate by name without asking Herdr, and reopens the item", async () => {
    const { cfg, path } = await started();
    await runWith(recordDelegate(cfg, "app", { id: "i1", ref: ref("fix-a", SESSION) }));
    const fake = fakeProc(answers(undefined));
    const lines = await runWith(detachDelegate(cfg, options({ target: "fix-a" }), ENV), fake.layer);
    expect(lines).toEqual([`detached fix-a (session ${SESSION}) from i1 [open]`]);
    expect(fake.calls.map((call) => call.argv[2])).toEqual(["t1"]);
    expect([read(path).items[0].status, read(path).items[0].delegates]).toEqual(["open", []]);
  });

  it("resolves a terminal address to its session, and keeps delegated while refs remain", async () => {
    const { cfg, path } = await started();
    await runWith(recordDelegate(cfg, "app", { id: "i1", ref: ref("manual", SESSION) }));
    await runWith(recordDelegate(cfg, "app", { id: "i1", ref: ref("other", "s-2") }));
    const lines = await runWith(
      detachDelegate(cfg, options({}), ENV),
      fakeProc(answers(handStarted("/x"))).layer,
    );
    expect(lines).toEqual([`detached manual (session ${SESSION}) from i1 [delegated]`]);
    expect(read(path).items[0].delegates).toEqual([ref("other", "s-2")]);
  });

  it("detaches from a closed item without reopening it", async () => {
    const { cfg, path } = await started();
    await runWith(recordDelegate(cfg, "app", { id: "i1", ref: ref("fix-a", SESSION) }));
    await runWith(
      itemClose(cfg, "app", { id: "i1", outcome: "x", dismissed: false, json: false, now: NOW }),
    );
    await runWith(
      detachDelegate(cfg, options({ target: SESSION }), ENV),
      fakeProc(answers(undefined)).layer,
    );
    expect([read(path).items[0].status, read(path).items[0].delegates]).toEqual(["done", []]);
  });

  it("refuses a delegate filed elsewhere, or not filed at all", async () => {
    const { cfg, path } = await started();
    await runWith(recordDelegate(cfg, "app", { id: "i2", ref: ref("fix-a", SESSION) }));
    const before = readFileSync(path, "utf8");
    const fake = fakeProc(answers(undefined));
    expect([
      messageOf(
        await failureOf(detachDelegate(cfg, options({ target: "fix-a" }), ENV), fake.layer),
      ),
      messageOf(await failureOf(detachDelegate(cfg, options({ target: "nope" }), ENV), fake.layer)),
    ]).toEqual(["fix-a is filed under i2, not i1", "i1 has no delegate nope"]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("one session, one item", () => {
  it("refuses detaching by a name two refs share, naming their sessions", async () => {
    const { cfg } = await started();
    await runWith(recordDelegate(cfg, "app", { id: "i1", ref: ref("fix-a", "s-1") }));
    await runWith(recordDelegate(cfg, "app", { id: "i1", ref: ref("fix-a", "s-2") }));
    const error = await failureOf(
      detachDelegate(cfg, options({ target: "fix-a" }), ENV),
      fakeProc(answers(undefined)).layer,
    );
    expect(messageOf(error)).toBe("fix-a names 2 delegates on i1; pass a session id: s-1, s-2");
  });

  it("refuses a session already filed, inside the pure op", () => {
    const backlog = {
      schemaVersion: 1 as const,
      domain: "app",
      focus: null,
      legacy: null,
      boundary: { owned: [], adjacent: [] },
      policies: [],
      items: [
        {
          id: "i1",
          title: "a",
          status: "delegated" as const,
          touches: [],
          decided: [],
          ask: null,
          answered: [],
          due: null,
          delegates: [ref("fix-a", "s-1")],
          createdAt: NOW,
          closedAt: null,
          outcome: null,
        },
        {
          id: "i2",
          title: "b",
          status: "open" as const,
          touches: [],
          decided: [],
          ask: null,
          answered: [],
          due: null,
          delegates: [],
          createdAt: NOW,
          closedAt: null,
          outcome: null,
        },
      ],
      findings: [],
      nextId: 3,
      nextPolicyId: 1,
    };
    expect(fileDelegate(backlog, { id: "i2", ref: ref("renamed", "s-1") })).toEqual({
      ok: false,
      reason: "fix-a is already filed under i1; detach it first: coordinate item detach i1 fix-a",
    });
  });
});

describe("coordinate item attach and detach CLI", () => {
  it("exits 0 when filed and 1 when refused", async () => {
    const { state, path } = await started();
    const env = cliEnv(state, COORDINATOR, undefined, {
      t4: handStarted(state, { labels: { "fleet.domain": "app", "fleet.session": SESSION } }),
    });
    const cli = join(import.meta.dir, "..", "coordinate.ts");
    const run = (args: string[]) => {
      const done = Bun.spawnSync(["bun", cli, "item", ...args], {
        env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });
      return [done.exitCode, done.stdout.toString() + done.stderr.toString()];
    };
    expect([
      run(["attach", "i1", "t4"]),
      run(["attach", "i2", "t4"]),
      run(["detach", "i1", "manual"]),
      run(["attach", "i1", "t4", "--session", "s-other"]),
    ]).toEqual([
      [
        0,
        `filed manual (t4, session ${SESSION}) under i1 [delegated]\nlabelled t4: fleet.task=manual fleet.harness=claude fleet.worktree=${state}\n`,
      ],
      [
        1,
        "refused: manual is already filed under i1; detach it first: coordinate item detach i1 manual\n",
      ],
      [0, `detached manual (session ${SESSION}) from i1 [open]\n`],
      [1, `refused: t4 runs session ${SESSION}, not s-other\n`],
    ]);
    expect(read(path).items[0].delegates).toEqual([]);
  });
});
