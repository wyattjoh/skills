import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { BacklogError, itemAdd, itemClose } from "./backlog-doc.ts";
import { resolveConfig, type Config } from "./config.ts";
import { failureOf, g, gitAndFake, initRepo, runWith, tempDir } from "./fixture.ts";
import { writeEnded } from "./fleet.ts";
import {
  delegate as startDelegate,
  type DelegateOptions,
  resumeDelegate,
  start,
} from "./lifecycle.ts";
import { fakeProc, ok, type RunOutput } from "./proc.ts";
import { domainStatus } from "./status.ts";

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
const config = (state: string) =>
  Effect.runPromise(resolveConfig({ backlog_dir: join(state, "md"), state_dir: state }, "/c"));
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

const messageOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error);

const tagOf = (error: unknown): [string, string] =>
  typeof error === "object" && error !== null
    ? [error.constructor.name, messageOf(error)]
    : ["none", String(error)];

const COORDINATOR = { "fleet.role": "coordinator", "fleet.domain": "app" };
const DELEGATE = { "fleet.domain": "app", "fleet.session": "s-parent" };

/**
 * Answers for hc and herdr-app: the caller t1 with the given labels, and a launched t7 that works.
 */
const herdrAnswers =
  (callerLabels: Record<string, string>) =>
  (argv: readonly string[]): RunOutput => {
    if (argv[0] === "hc") {
      if (argv[1] === "ls") return ok('{"terminals":[]}');
      if (argv[1] === "label") return ok("{}");
      if (argv[1] === "run") return ok('{"address":"t7"}');
      if (argv[1] === "get" && argv[2] === "t1")
        return ok(JSON.stringify({ address: "t1", state: "live", labels: callerLabels }));
      if (argv[1] === "get" && argv[2] === "t7")
        return ok(
          JSON.stringify({
            address: "t7",
            name: "fix-a",
            state: "live",
            status: { state: "working" },
          }),
        );
    }
    if (argv[0] === "herdr-app" && argv[2] === "tab.rename") return ok("{}");
    throw new Error(`unexpected command: ${argv.join(" ")}`);
  };

const started = async () => {
  const state = dir();
  const cfg = await config(state);
  await runWith(
    start(cfg, "app", { HC_TERMINAL_ID: "t1" }),
    fakeProc(herdrAnswers(COORDINATOR)).layer,
  );
  await runWith(itemAdd(cfg, "app", { title: "fix login", json: false, now: NOW }));
  return { state, cfg, path: join(state, "backlogs", "app.json") };
};

const delegate = (settings: Config, options: DelegateOptions) =>
  startDelegate(settings, options, () => 0);

const options = (fields: Partial<DelegateOptions>): DelegateOptions => ({
  name: "fix-a",
  task: "fix a",
  repo: undefined,
  cwd: undefined,
  base: undefined,
  harness: "pi",
  model: undefined,
  effort: undefined,
  message: { kind: "skill", skill: "implement", args: ".scratch/spec.md" },
  space: false,
  domain: undefined,
  item: undefined,
  overBudget: false,
  ...fields,
});

const sessionOfRun = (calls: readonly (readonly string[])[]): string =>
  calls
    .find((argv) => argv[1] === "run")
    ?.find((arg) => arg.startsWith("fleet.session="))
    ?.slice("fleet.session=".length) ?? "";

let originalTerminal: string | undefined;
beforeEach(() => {
  originalTerminal = process.env.HC_TERMINAL_ID;
  process.env.HC_TERMINAL_ID = "t1";
});
afterEach(() => {
  if (originalTerminal === undefined) delete process.env.HC_TERMINAL_ID;
  else process.env.HC_TERMINAL_ID = originalTerminal;
});

describe("delegate --item", () => {
  it("refuses a coordinator delegate without --item before creating a worktree", async () => {
    const { cfg } = await started();
    const repo = initRepo();
    dirs.push(repo);
    const fake = gitAndFake(herdrAnswers(COORDINATOR));
    const error = await failureOf(delegate(cfg, options({ repo })), fake.layer);
    expect(messageOf(error)).toBe(
      "a coordinator files every delegate under an item: pass --item <id> (coordinate item add prints one)",
    );
    expect(existsSync(join(repo, ".claude", "worktrees", "fix-a"))).toBe(false);
    expect(g(repo, "branch", "--format=%(refname:short)")).toBe("main");
    expect(fake.calls.filter((argv) => argv[1] === "run").length).toBe(0);
  });

  it.each([
    ["i9", "no item i9 in app"],
    ["i1", "i1 is already done; a delegate needs an open item"],
  ])("refuses --item %s before creating a worktree", async (item, message) => {
    const { cfg } = await started();
    await runWith(
      itemClose(cfg, "app", {
        id: "i1",
        outcome: "shipped",
        dismissed: false,
        json: false,
        now: NOW,
      }),
    );
    const repo = initRepo();
    dirs.push(repo);
    const fake = gitAndFake(herdrAnswers(COORDINATOR));
    const error = await failureOf(delegate(cfg, options({ repo, item })), fake.layer);
    expect(messageOf(error)).toBe(message);
    expect(existsSync(join(repo, ".claude", "worktrees", "fix-a"))).toBe(false);
  });

  it("records the delegate ref on the item and sets it to delegated", async () => {
    const { state, cfg, path } = await started();
    const repo = initRepo();
    dirs.push(repo);
    const brief = join(state, "brief.md");
    writeFileSync(brief, "# brief\n");
    const fake = gitAndFake(herdrAnswers(COORDINATOR));
    const lines = await runWith(
      delegate(cfg, options({ repo, item: "i1", message: { kind: "brief", path: brief } })),
      fake.layer,
    );
    const worktree = join(repo, ".claude", "worktrees", "fix-a");
    const session = sessionOfRun(fake.calls);
    expect(session.length).toBe(36);
    expect(lines.slice(-2)).toEqual(["started fix-a (t7)", "filed fix-a under i1 [delegated]"]);
    const item = read(path).items[0];
    expect(item.status).toBe("delegated");
    expect(item.delegates).toEqual([
      {
        name: "fix-a",
        session,
        branch: "wyattjoh/fix-a",
        worktree,
        brief: join(worktree, ".scratch", "BRIEF.md"),
        report: join(worktree, ".scratch", "REPORT.md"),
      },
    ]);
  });

  it("records a --cwd skill delegate with no branch, brief or report", async () => {
    const { state, cfg, path } = await started();
    const fake = fakeProc(herdrAnswers(COORDINATOR));
    await runWith(delegate(cfg, options({ cwd: state, item: "i1" })), fake.layer);
    expect(read(path).items[0].delegates).toEqual([
      {
        name: "fix-a",
        session: sessionOfRun(fake.calls.map((call) => call.argv)),
        branch: null,
        worktree: state,
        brief: "",
        report: "",
      },
    ]);
  });

  it("refuses --item when a delegate starts a child", async () => {
    const { state, cfg, path } = await started();
    const before = readFileSync(path, "utf8");
    const fake = fakeProc(herdrAnswers(DELEGATE));
    const error = await failureOf(
      delegate(cfg, options({ cwd: state, domain: "app", item: "i1" })),
      fake.layer,
    );
    expect(messageOf(error)).toBe(
      "--item is for the coordinator; a delegate starting a child review passes no --item",
    );
    expect(fake.calls.filter((call) => call.argv[1] === "run").length).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("starts a child from a delegate unchanged and records nothing", async () => {
    const { state, cfg, path } = await started();
    const before = readFileSync(path, "utf8");
    const brief = join(state, "child-brief.md");
    writeFileSync(brief, "# review\n");
    const fake = fakeProc(herdrAnswers(DELEGATE));
    const lines = await runWith(
      delegate(
        cfg,
        options({ cwd: state, domain: "app", message: { kind: "brief", path: brief } }),
      ),
      fake.layer,
    );
    expect(lines).toEqual([
      "started fix-a (t7)",
      `session ${sessionOfRun(fake.calls.map((call) => call.argv))} report ${join(state, ".scratch", "REPORT.md")}`,
    ]);
    expect(fake.calls.filter((call) => call.argv[1] === "run").length).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("exits 2 naming the started delegate when the document breaks after launch", async () => {
    const { state, cfg, path } = await started();
    const answer = herdrAnswers(COORDINATOR);
    const fake = fakeProc((argv) => {
      if (argv[1] === "run") writeFileSync(path, "not json");
      return answer(argv);
    });
    const error = await failureOf(delegate(cfg, options({ cwd: state, item: "i1" })), fake.layer);
    const session = sessionOfRun(fake.calls.map((call) => call.argv));
    expect(error instanceof BacklogError).toBe(true);
    expect(
      messageOf(error).startsWith(
        `started fix-a (t7, session ${session}) but could not file it under i1: ${path} is not JSON`,
      ),
    ).toBe(true);
  });

  it.each([
    ["with --item", "i1", undefined],
    ["without --item", undefined, "app"],
  ])(
    "exits 2, starting nothing, when hc get cannot answer for the caller (%s)",
    async (_name, item, domain) => {
      const { state, cfg, path } = await started();
      const before = readFileSync(path, "utf8");
      const answer = herdrAnswers(COORDINATOR);
      const fake = fakeProc((argv) =>
        argv[1] === "get" && argv[2] === "t1"
          ? {
              exitCode: 1,
              stdout: "",
              stderr: '{"error":{"kind":"unavailable","message":"herdr-core is not answering"}}',
            }
          : answer(argv),
      );
      const error = await failureOf(
        delegate(cfg, options({ cwd: state, item, domain })),
        fake.layer,
      );
      expect(tagOf(error)).toEqual(["HerdrError", "herdr-core is not answering"]);
      expect(fake.calls.filter((call) => call.argv[1] === "run").length).toBe(0);
      expect(readFileSync(path, "utf8")).toBe(before);
    },
  );

  it("exits 2, starting nothing, when HC_TERMINAL_ID is unset", async () => {
    const { state, cfg } = await started();
    delete process.env.HC_TERMINAL_ID;
    const fake = fakeProc(herdrAnswers(COORDINATOR));
    const error = await failureOf(
      delegate(cfg, options({ cwd: state, domain: "app" })),
      fake.layer,
    );
    expect(tagOf(error)).toEqual([
      "Unchecked",
      "HC_TERMINAL_ID is unset, so this terminal's role cannot be checked: run this inside a Herdr terminal",
    ]);
    expect(fake.calls.filter((call) => call.argv[1] === "run").length).toBe(0);
  });

  it("resumes without touching the backlog", async () => {
    const { state, cfg, path } = await started();
    await runWith(
      delegate(cfg, options({ cwd: state, item: "i1" })),
      fakeProc(herdrAnswers(COORDINATOR)).layer,
    );
    const before = readFileSync(path, "utf8");
    await Effect.runPromise(
      writeEnded(state, {
        name: "fix-a",
        domain: "app",
        session: read(path).items[0].delegates[0].session,
        program: "pi",
        cwd: state,
        ended_at: NOW,
      }),
    );
    const lines = await runWith(
      resumeDelegate(cfg, "fix-a", false),
      fakeProc(herdrAnswers(COORDINATOR)).layer,
    );
    expect(lines).toEqual([
      "resumed fix-a in t7",
      'send it what arrived: coordinate send fix-a "<message>"',
    ]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("status finds delegates through refs and labels", () => {
  it("adopts an unlabelled agent by item ref session, never by Markdown text", async () => {
    const { state, cfg } = await started();
    const fake = fakeProc(herdrAnswers(COORDINATOR));
    await runWith(delegate(cfg, options({ cwd: state, item: "i1" })), fake.layer);
    const session = sessionOfRun(fake.calls.map((call) => call.argv));
    mkdirSync(join(state, "md"));
    writeFileSync(join(state, "md", "app-backlog.md"), "## Open\n- old s-md-0000-named here\n");
    const status = fakeProc((argv) => {
      if (argv[1] === "ls" && argv.includes("--label")) return ok('{"terminals":[]}');
      if (argv[1] === "ls")
        return ok(
          JSON.stringify({
            terminals: [
              { address: "t4", state: "live", status: "idle" },
              { address: "t5", state: "live", status: "idle" },
            ],
          }),
        );
      if (argv[1] === "get")
        return ok(
          JSON.stringify({
            address: argv[2],
            name: argv[2] === "t4" ? "ref-a" : "md-a",
            state: "live",
            status: { state: "idle" },
            labels: {
              "fleet.session": argv[2] === "t4" ? session : "s-md-0000-named",
              "fleet.branch": "wyattjoh/x",
            },
          }),
        );
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    });
    expect(await runWith(domainStatus(cfg, "app", false, Date.parse(NOW)), status.layer)).toEqual([
      "app: 1 live delegates, 0 ended",
      "  ref-a t4 idle ? (by item ref) · no repo · next: coordinator: read its REPORT.md",
    ]);
  });
});
