import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createDocument, itemAdd } from "./backlog-doc.ts";
import { resolveConfig } from "./config.ts";
import { Effect } from "effect";
import { failureOf, g, gitAndFake, initRepo, runWith, tempDir } from "./fixture.ts";
import { writeEnded } from "./fleet.ts";
import { delegate, endDelegate, listIdle, resumeDelegate, sendTo, start } from "./lifecycle.ts";
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
const config = (state: string) =>
  Effect.runPromise(
    resolveConfig({ backlog_dir: join(state, "backlogs"), state_dir: state, quiet_hours: 1 }, "/c"),
  );

const terminal = (fields: Record<string, unknown>) =>
  JSON.stringify({ address: "t2", name: "fix-a", state: "live", labels: {}, ...fields });

const messageOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error);

describe("sendTo", () => {
  it("refuses a terminal blocked on a dialog", async () => {
    const fake = fakeProc(() =>
      ok(terminal({ status: { state: "blocked" }, labels: { where: "app / fix a" } })),
    );
    const error = await failureOf(sendTo("fix-a", "hi"), fake.layer);
    expect(
      messageOf(error).startsWith(
        'fix-a is blocked on a dialog, which is the user\'s to answer in "app / fix a"',
      ),
    ).toBe(true);
    expect(fake.calls.length).toBe(1);
  });

  it("sends to an idle terminal by address", async () => {
    const fake = fakeProc((argv) =>
      argv[1] === "get" ? ok(terminal({ status: { state: "idle" } })) : ok("{}"),
    );
    expect(await runWith(sendTo("fix-a", "hi"), fake.layer)).toEqual(["sent to fix-a (t2, idle)"]);
    expect(fake.calls[1]?.argv).toEqual(["hc", "send", "t2", "hi", "--json"]);
  });
});

describe("start", () => {
  it("labels the terminal and creates the backlog document", async () => {
    const state = dir();
    const fake = fakeProc((argv) => (argv[1] === "ls" ? ok('{"terminals":[]}') : ok("{}")));
    const lines = await runWith(
      start(await config(state), "app", { HC_TERMINAL_ID: "t9" }),
      fake.layer,
    );
    const path = join(state, "backlogs", "app.json");
    expect(lines).toEqual([
      "labelled t9: fleet.role=coordinator fleet.domain=app",
      `created backlog ${path}`,
    ]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      schemaVersion: 1,
      domain: "app",
      focus: null,
      legacy: null,
      boundary: { owned: [], adjacent: [] },
      standingYes: [],
      items: [],
      findings: [],
      nextId: 1,
    });
    expect(existsSync(join(state, "backlogs", "app-backlog.md"))).toBe(false);
    expect(fake.calls[1]?.argv).toEqual([
      "hc",
      "label",
      "t9",
      "fleet.role=coordinator",
      "fleet.domain=app",
      "--json",
    ]);
  });

  it("warns about a second coordinator of the same domain", async () => {
    const state = dir();
    const fake = fakeProc((argv) =>
      argv[1] === "ls" ? ok('{"terminals":[{"address":"t3","state":"live"}]}') : ok("{}"),
    );
    const lines = await runWith(
      start(await config(state), "app", { HC_TERMINAL_ID: "t9" }),
      fake.layer,
    );
    expect(lines[0]).toBe(
      "warning: t3 also coordinates app; end or unlabel it (hc label <t> fleet.role= fleet.domain=)",
    );
  });
});

describe("delegate", () => {
  it("refuses a bad name before touching anything", async () => {
    const fake = fakeProc(() => ok());
    const error = await failureOf(
      delegate(await config(dir()), {
        name: "Bad Name",
        task: "t",
        repo: "/x",
        cwd: undefined,
        base: undefined,
        harness: "pi",
        model: undefined,
        effort: undefined,
        message: { kind: "brief", path: "/b" },
        space: true,
        domain: "app",
        item: undefined,
        overBudget: false,
      }),
      fake.layer,
    );
    expect(messageOf(error)).toBe("Bad Name is not a terminal name: 1 to 32 of a-z, 0-9, - and _");
    expect(fake.calls.length).toBe(0);
  });

  it("records the resolved creation base on a new worktree delegate", async () => {
    const repo = initRepo();
    dirs.push(repo);
    const baseSha = g(repo, "rev-parse", "HEAD");
    const fake = gitAndFake((argv) => {
      if (argv[0] !== "hc") return ok("{}");
      if (argv[1] === "ls") return ok('{"terminals":[]}');
      if (argv[1] === "run") return ok('{"address":"t2"}');
      if (argv[1] === "get" && argv[2] === "t1")
        return ok(terminal({ address: "t1", labels: { "fleet.domain": "app" } }));
      if (argv[1] === "get" && argv[2] === "t2")
        return ok(terminal({ status: { state: "working" } }));
      return ok("{}");
    });
    const saved = process.env.HC_TERMINAL_ID;
    process.env.HC_TERMINAL_ID = "t1";
    try {
      await runWith(
        delegate(await config(dir()), {
          name: "fix-a",
          task: "fix a",
          repo,
          cwd: undefined,
          base: undefined,
          harness: "pi",
          model: undefined,
          effort: undefined,
          message: { kind: "skill", skill: "implement", args: "" },
          space: false,
          domain: "app",
          item: undefined,
          overBudget: false,
        }),
        fake.layer,
      );
    } finally {
      if (saved === undefined) delete process.env.HC_TERMINAL_ID;
      else process.env.HC_TERMINAL_ID = saved;
    }
    const run = fake.calls.find((call) => call[0] === "hc" && call[1] === "run");
    expect(run?.includes(`fleet.base=${baseSha}`)).toBe(true);
  });

  it("refuses an unknown effort for the harness", async () => {
    const fake = fakeProc(() => ok());
    const error = await failureOf(
      delegate(await config(dir()), {
        name: "fix-a",
        task: "t",
        repo: "/x",
        cwd: undefined,
        base: undefined,
        harness: "claude",
        model: undefined,
        effort: "minimal",
        message: { kind: "brief", path: "/b" },
        space: true,
        domain: "app",
        item: undefined,
        overBudget: false,
      }),
      fake.layer,
    );
    expect(messageOf(error)).toBe("minimal is not a claude effort: low, medium, high, xhigh, max");
  });
});

describe("launch parent", () => {
  let originalTerminal: string | undefined;
  beforeEach(() => {
    originalTerminal = process.env.HC_TERMINAL_ID;
  });
  afterEach(() => {
    if (originalTerminal === undefined) delete process.env.HC_TERMINAL_ID;
    else process.env.HC_TERMINAL_ID = originalTerminal;
  });

  const callers = [
    { role: "coordinator", address: "t1", labels: { "fleet.role": "coordinator" } },
    { role: "delegate", address: "t2", labels: { "fleet.role": "delegate" } },
    { role: "no terminal", address: undefined, labels: {} },
  ];

  for (const command of ["delegate", "resume"] as const) {
    for (const ownSpace of [false, true]) {
      // A delegate needs the caller's role, so only resume runs with no terminal.
      it.each(command === "delegate" ? callers.slice(0, 2) : callers)(
        `${command} from $role uses the caller as parent (own space: ${ownSpace})`,
        async (caller) => {
          if (caller.address === undefined) delete process.env.HC_TERMINAL_ID;
          else process.env.HC_TERMINAL_ID = caller.address;
          const state = dir();
          const fake = fakeProc((argv) => {
            if (argv[0] === "hc") {
              if (argv[1] === "ls") return ok('{"terminals":[]}');
              if (argv[1] === "run") return ok('{"address":"t7"}');
              if (argv[1] === "kill" || argv[1] === "rm") return ok("{}");
              if (argv[1] === "get" && argv[2] === caller.address)
                return ok(
                  terminal({
                    address: caller.address,
                    labels: {
                      ...caller.labels,
                      "fleet.domain": "app",
                      "herdr.space": "caller-space",
                    },
                  }),
                );
              if (argv[1] === "get" && argv[2] === "t7")
                return ok(terminal({ address: "t7", status: { state: "working" } }));
            }
            if (argv[0] === "herdr-app") {
              if (argv[1] === "ls") return ok('{"spaces":[]}');
              if (argv[2] === "space.new")
                return ok('{"space":"child-space","tab":"child-tab","terminal":"t6"}');
              if (argv[2] === "tab.rename") return ok("{}");
            }
            throw new Error(`unexpected command: ${argv.join(" ")}`);
          });
          const cfg = await config(state);
          let endedPath: string | undefined;
          if (command === "resume") {
            endedPath = await Effect.runPromise(
              writeEnded(state, {
                name: "fix-a",
                domain: "app",
                session: "s-1",
                program: "pi",
                cwd: state,
                ended_at: "2026-11-17T00:00:00.000Z",
              }),
            );
            await runWith(resumeDelegate(cfg, "fix-a", ownSpace), fake.layer);
          } else {
            if (caller.role === "coordinator") {
              await Effect.runPromise(createDocument(cfg, "app"));
              await runWith(itemAdd(cfg, "app", { title: "fix a", json: false, now: "x" }));
            }
            await runWith(
              delegate(cfg, {
                name: "fix-a",
                task: "fix a",
                repo: undefined,
                cwd: state,
                base: undefined,
                harness: "pi",
                model: undefined,
                effort: undefined,
                message: { kind: "skill", skill: "implement", args: ".scratch/spec.md" },
                space: ownSpace,
                domain: caller.role === "coordinator" ? undefined : "app",
                item: caller.role === "coordinator" ? "i1" : undefined,
                overBudget: false,
              }),
              fake.layer,
            );
          }
          const runs = fake.calls.filter((call) => call.argv[1] === "run");
          expect(runs.length).toBe(1);
          const argv = runs[0]?.argv ?? [];
          expect(argv.slice(8, argv.indexOf("--label"))).toEqual(
            caller.address === undefined
              ? ["--no-parent"]
              : ["--parent", caller.address, "--outlive-parent", "--no-notify"],
          );
          const spaceLabels = argv.filter((arg) => arg.startsWith("herdr.space="));
          expect(spaceLabels).toEqual(
            ownSpace
              ? ["herdr.space=child-space"]
              : caller.role === "coordinator"
                ? ["herdr.space=caller-space"]
                : [],
          );
          if (endedPath !== undefined) expect(existsSync(endedPath)).toBe(false);
        },
      );
    }
  }
});

const endLabels = {
  "fleet.domain": "app",
  "fleet.session": "s-1",
  "fleet.task": "fix a",
  "fleet.harness": "pi",
  "fleet.worktree": "/nonexistent/wt",
  "fleet.branch": "wyattjoh/fix-a",
  "fleet.base": "0123456789abcdef0123456789abcdef01234567",
  "fleet.space": "sp1",
};

const endAnswers = (argv: readonly string[]): RunOutput =>
  argv[1] === "get"
    ? ok(
        terminal({
          status: { state: "idle" },
          status_ms: 0,
          labels: endLabels,
          cwd: "/nonexistent/wt",
        }),
      )
    : ok("{}");

describe("endDelegate", () => {
  it("refuses a working delegate without --now", async () => {
    const fake = fakeProc(() => ok(terminal({ status: { state: "working" }, labels: endLabels })));
    const error = await failureOf(endDelegate(await config(dir()), "fix-a", false), fake.layer);
    expect(messageOf(error)).toBe("fix-a is working; wait for it to settle, or pass --now");
  });

  it("writes the ended record, ends the terminal and closes its space", async () => {
    const state = dir();
    const fake = fakeProc(endAnswers);
    const lines = await runWith(endDelegate(await config(state), "fix-a", false), fake.layer);
    expect(lines[1]).toBe(
      "worktree, branch and session stay; resume with: coordinate resume fix-a",
    );
    const files = readdirSync(join(state, "ended"));
    expect(files).toEqual(["s-1.json"]);
    const record = JSON.parse(readFileSync(join(state, "ended", "s-1.json"), "utf8"));
    expect([record.program, record.cwd, record.branch, record.base_sha, record.space]).toEqual([
      "pi",
      "/nonexistent/wt",
      "wyattjoh/fix-a",
      endLabels["fleet.base"],
      true,
    ]);
    expect(fake.calls.map((call) => call.argv.slice(0, 3).join(" "))).toEqual([
      "hc get fix-a",
      "git -c commit.gpgsign=false",
      "hc kill t2",
      "hc rm t2",
      "herdr-app do space.close",
    ]);
  });
});

describe("listIdle", () => {
  it("lists settled delegates quiet past quiet_hours", async () => {
    const fake = fakeProc((argv) =>
      argv[1] === "ls"
        ? ok('{"terminals":[{"address":"t2","state":"live"},{"address":"t3","state":"live"}]}')
        : argv[2] === "t2"
          ? ok(
              terminal({
                status: { state: "idle" },
                status_ms: 0,
                labels: { "fleet.domain": "app" },
              }),
            )
          : ok(
              terminal({
                address: "t3",
                name: "busy",
                status: { state: "working" },
                status_ms: 0,
                labels: { "fleet.domain": "app" },
              }),
            ),
    );
    expect(await runWith(listIdle(await config(dir()), "app", 2 * 3_600_000), fake.layer)).toEqual([
      "fix-a (t2) idle for 2h: coordinate end fix-a",
    ]);
  });
});
