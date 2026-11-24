import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { boundaryAdd, createDocument, itemAdd, itemClose } from "./backlog-doc.ts";
import { resolveConfig } from "./config.ts";
import { Effect } from "effect";
import { failureOf, g, gitAndFake, initRepo, processMachine, runWith, tempDir } from "./fixture.ts";
import { writeEnded } from "./fleet.ts";
import { setHarnessPolicy } from "./harness-policy.ts";
import {
  delegate,
  endDelegate,
  launchInOwnSpace,
  listIdle,
  resumeDelegate,
  sendTo,
  spawn,
  type SpawnOptions,
  spawnOutput,
  start,
} from "./lifecycle.ts";
import { FAKE_CORE, fakeProc, ok, type RunOutput } from "./proc.ts";

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

const START_NOW = Date.parse("2026-11-23T12:00:00.000Z");

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
    const fake = fakeProc((argv) => {
      if (argv[1] === "ls") return ok('{"terminals":[]}');
      if (argv[1] === "get" && argv[2] === "t9")
        return ok(
          terminal({
            address: "t9",
            name: "coordinator",
            labels: { "fleet.role": "coordinator", "fleet.domain": "app" },
          }),
        );
      if (argv[1] === "run") return ok('{"address":"t10"}');
      return ok("{}");
    });
    const lines = await runWith(
      start(await config(state), "app", { HC_TERMINAL_ID: "t9" }, START_NOW),
      fake.layer,
    );
    const path = join(state, "backlogs", "app.json");
    expect(lines).toEqual([
      "labelled t9: fleet.role=coordinator fleet.domain=app",
      `created backlog ${path}`,
      "watcher starting (t10)",
      `harness policy revision 0 (${join(state, "delegate-harness-policy.json")})`,
      "global (legacy): enabled pi, claude; default none",
      "domain app (inherit): enabled pi, claude; default none",
    ]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      schemaVersion: 1,
      domain: "app",
      focus: null,
      legacy: null,
      boundary: { owned: [], adjacent: [] },
      policies: [],
      items: [],
      findings: [],
      nextId: 1,
      nextPolicyId: 1,
      lease: { machine: "fake-core", address: "t9", expiry: "2026-11-23T12:03:00.000Z" },
    });
    expect(existsSync(join(state, "backlogs", "app-backlog.md"))).toBe(false);
    expect(fake.calls.slice(0, 3).map((call) => call.argv)).toEqual([
      ["hc", "server", "status", "--json"],
      ["hc", "ls", "--json", "--label", "fleet.role=coordinator", "--label", "fleet.domain=app"],
      ["hc", "label", "t9", "fleet.role=coordinator", "fleet.domain=app", "--json"],
    ]);
  });

  const leasedBy = async (state: string, lease: Record<string, string>) => {
    const cfg = await config(state);
    await Effect.runPromise(createDocument(cfg, "app"));
    const path = join(state, "backlogs", "app.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), lease }));
    return { cfg, path };
  };
  const startFake = () =>
    fakeProc((argv) => {
      if (argv[1] === "ls") return ok('{"terminals":[]}');
      if (argv[1] === "get" && argv[2] === "t9")
        return ok(
          terminal({
            address: "t9",
            labels: { "fleet.role": "coordinator", "fleet.domain": "app" },
          }),
        );
      if (argv[1] === "run") return ok('{"address":"t10"}');
      return ok("{}");
    });

  it("refuses while another machine holds a live lease, naming it, and labels nothing", async () => {
    const state = dir();
    const { cfg, path } = await leasedBy(state, {
      machine: "strix",
      address: "t1fn",
      expiry: "2026-11-23T12:00:00.001Z",
    });
    const fake = startFake();
    const error = await failureOf(
      start(cfg, "app", { HC_TERMINAL_ID: "t9" }, START_NOW),
      fake.layer,
    );
    expect(messageOf(error)).toBe(
      "app already has a coordinator: strix/t1fn holds its lease until 2026-11-23T12:00:00.001Z; go to it, or wait for that lease to expire (3 minutes after its watcher last renewed it)",
    );
    expect(fake.calls.map((call) => call.argv)).toEqual([["hc", "server", "status", "--json"]]);
    expect(JSON.parse(readFileSync(path, "utf8")).lease).toEqual({
      machine: "strix",
      address: "t1fn",
      expiry: "2026-11-23T12:00:00.001Z",
    });
  });

  const handoffFake = (holder: Record<string, unknown> | undefined) =>
    fakeProc((argv) => {
      if (argv[1] === "ls") return ok('{"terminals":[]}');
      if (argv[1] === "get" && argv[2] === "t9")
        return ok(
          terminal({
            address: "t9",
            labels: { "fleet.role": "coordinator", "fleet.domain": "app" },
          }),
        );
      if (argv[1] === "get" && argv[2] === "t3")
        return holder === undefined
          ? {
              exitCode: 1,
              stdout: "",
              stderr: JSON.stringify({ error: { kind: "not_found", message: "no terminal t3" } }),
            }
          : ok(terminal({ address: "t3", ...holder }));
      if (argv[1] === "run") return ok('{"address":"t10"}');
      return ok("{}");
    });
  const sameCore = { machine: "fake-core", address: "t3", expiry: "2026-11-23T12:02:00.000Z" };

  it.each([
    { holder: "gone from Herdr", terminal: undefined },
    { holder: "exited", terminal: { state: "exited" } },
  ])(
    "takes over a live lease on this machine whose terminal is $holder",
    async ({ terminal: t3 }) => {
      const state = dir();
      const { cfg, path } = await leasedBy(state, sameCore);
      const fake = handoffFake(t3);
      const lines = await runWith(
        start(cfg, "app", { HC_TERMINAL_ID: "t9" }, START_NOW),
        fake.layer,
      );
      expect(lines[0]).toBe("labelled t9: fleet.role=coordinator fleet.domain=app");
      expect(JSON.parse(readFileSync(path, "utf8")).lease).toEqual({
        machine: "fake-core",
        address: "t9",
        expiry: "2026-11-23T12:03:00.000Z",
      });
    },
  );

  it("refuses a live lease on this machine whose terminal still runs", async () => {
    const state = dir();
    const { cfg } = await leasedBy(state, sameCore);
    const error = await failureOf(
      start(cfg, "app", { HC_TERMINAL_ID: "t9" }, START_NOW),
      handoffFake({ state: "live" }).layer,
    );
    expect(messageOf(error)).toBe(
      "app already has a coordinator: fake-core/t3 holds its lease until 2026-11-23T12:02:00.000Z; go to it, or wait for that lease to expire (3 minutes after its watcher last renewed it)",
    );
  });

  it("never asks Herdr about a holder on another machine, which stays authoritative until expiry", async () => {
    const state = dir();
    const { cfg } = await leasedBy(state, { ...sameCore, machine: "strix" });
    const fake = handoffFake(undefined);
    await failureOf(start(cfg, "app", { HC_TERMINAL_ID: "t9" }, START_NOW), fake.layer);
    expect(fake.calls.map((call) => call.argv)).toEqual([["hc", "server", "status", "--json"]]);
  });

  it("takes over a lease its holder has not renewed for three minutes", async () => {
    const state = dir();
    const { cfg, path } = await leasedBy(state, {
      machine: "strix",
      address: "t1fn",
      expiry: "2026-11-23T12:00:00.000Z",
    });
    const lines = await runWith(
      start(cfg, "app", { HC_TERMINAL_ID: "t9" }, START_NOW),
      startFake().layer,
    );
    expect(lines[0]).toBe("labelled t9: fleet.role=coordinator fleet.domain=app");
    expect(JSON.parse(readFileSync(path, "utf8")).lease).toEqual({
      machine: "fake-core",
      address: "t9",
      expiry: "2026-11-23T12:03:00.000Z",
    });
  });

  it("warns about a second coordinator of the same domain", async () => {
    const state = dir();
    const fake = fakeProc((argv) => {
      if (argv[1] === "ls" && argv.includes("fleet.role=coordinator"))
        return ok('{"terminals":[{"address":"t3","state":"live"}]}');
      if (argv[1] === "ls") return ok('{"terminals":[]}');
      if (argv[1] === "get" && argv[2] === "t9")
        return ok(
          terminal({
            address: "t9",
            name: "coordinator",
            labels: { "fleet.role": "coordinator", "fleet.domain": "app" },
          }),
        );
      if (argv[1] === "run") return ok('{"address":"t10"}');
      return ok("{}");
    });
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
        queueIfFull: false,
        retryQueued: false,
        machine: undefined,
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
          queueIfFull: false,
          retryQueued: false,
          machine: undefined,
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

  it("starts a skill delegate with its brief copied and named after the skill arguments", async () => {
    const work = dir();
    const source = join(dir(), "brief.md");
    writeFileSync(source, "# Brief: spec\n");
    const fake = fakeProc((argv) => {
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
          name: "spec-a",
          task: "spec a",
          repo: undefined,
          cwd: work,
          base: undefined,
          harness: "claude",
          model: undefined,
          effort: undefined,
          message: {
            kind: "skill",
            skill: "implement-spec",
            args: "3f2a via Tasks MCP. Keep one integration branch.",
            brief: source,
          },
          space: false,
          domain: "app",
          item: undefined,
          overBudget: false,
          queueIfFull: false,
          retryQueued: false,
          machine: undefined,
        }),
        fake.layer,
      );
    } finally {
      if (saved === undefined) delete process.env.HC_TERMINAL_ID;
      else process.env.HC_TERMINAL_ID = saved;
    }
    const copied = join(work, ".scratch", "spec-a", "BRIEF.md");
    expect(readFileSync(copied, "utf8")).toBe("# Brief: spec\n");
    const run = fake.calls.find((call) => call.argv[1] === "run");
    expect(run?.argv.at(-1)).toBe(
      `/implement-spec 3f2a via Tasks MCP. Keep one integration branch. Also read ${copied} and follow its Boundary, Stop points and Report sections.`,
    );
  });

  it("starts a retro delegate in the wiki folder with the retro skill and the session arguments", async () => {
    const wiki = dir();
    const fake = fakeProc((argv) => {
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
          name: "retro-fix-a",
          task: "retro fix-a",
          repo: undefined,
          cwd: wiki,
          base: undefined,
          harness: "pi",
          model: undefined,
          effort: undefined,
          message: { kind: "skill", skill: "retro", args: "session s-1 cwd /w/fix-a" },
          space: false,
          domain: "app",
          item: undefined,
          overBudget: false,
          queueIfFull: false,
          retryQueued: false,
          machine: undefined,
        }),
        fake.layer,
      );
    } finally {
      if (saved === undefined) delete process.env.HC_TERMINAL_ID;
      else process.env.HC_TERMINAL_ID = saved;
    }
    const run = fake.calls.find((call) => call.argv[1] === "run");
    expect(run?.argv.at(-1)).toBe("/skill:retro session s-1 cwd /w/fix-a");
    expect(run?.argv.includes(wiki)).toBe(true);
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
        queueIfFull: false,
        retryQueued: false,
        machine: undefined,
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
                queueIfFull: false,
                retryQueued: false,
                machine: undefined,
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
          expect(argv.filter((arg) => arg.startsWith("fleet.space="))).toEqual(
            ownSpace ? ["fleet.space=child-space"] : [],
          );
          expect(argv.filter((arg) => arg.startsWith("fleet.machine="))).toEqual([
            `fleet.machine=${FAKE_CORE}`,
          ]);
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

describe("launchInOwnSpace", () => {
  it("starts a terminal in its own unfocused space with only the caller's labels and no parent", async () => {
    const fake = fakeProc((argv) => {
      if (argv[0] === "hc" && argv[1] === "run") return ok('{"address":"t7"}');
      if (argv[0] === "hc") return ok("{}");
      if (argv[1] === "ls")
        return ok(
          JSON.stringify({
            spaces: [
              { id: "sp9", tabs: [{ id: "tab9", terminals: [{ terminal: "t6", pane: "p6" }] }] },
            ],
          }),
        );
      if (argv[2] === "space.new") return ok('{"space":"sp9","tab":"tab9","terminal":"t6"}');
      return ok("{}");
    });
    const launched = await runWith(
      launchInOwnSpace({
        name: "tasks-coordinator",
        cwd: "/w/tasks",
        tabLabel: "Tasks · No active focus",
        spaceName: "tasks",
        labels: { "fleet.role": "coordinator", "fleet.domain": "tasks" },
        parent: undefined,
        argv: ["claude", "/coordinate tasks"],
        recordSpace: false,
        machine: undefined,
        shell: undefined,
      }),
      fake.layer,
    );
    expect(launched).toEqual({ address: "t7", space: "sp9" });
    const calls = fake.calls.map((call) => call.argv);
    const run = calls[1] ?? [];
    expect(calls[0]).toEqual([
      "herdr-app",
      "do",
      "space.new",
      '{"name":"tasks","folder":"/w/tasks","focus":false}',
    ]);
    expect(run.slice(0, run.indexOf("--"))).toEqual([
      "hc",
      "run",
      "--bg",
      "--json",
      "--name",
      "tasks-coordinator",
      "--cwd",
      "/w/tasks",
      "--no-parent",
      "--label",
      "herdr.space=sp9",
      "--label",
      "herdr.tab=tab9",
      "--label",
      "fleet.role=coordinator",
      "--label",
      "fleet.domain=tasks",
    ]);
    expect(run.slice(-2)).toEqual(["claude", "/coordinate tasks"]);
    expect(calls.slice(2)).toEqual([
      ["herdr-app", "ls"],
      ["herdr-app", "do", "pane.close", '{"pane":"p6"}'],
      ["hc", "kill", "t6"],
      ["hc", "rm", "t6"],
      ["herdr-app", "do", "tab.rename", '{"id":"tab9","name":"Tasks · No active focus"}'],
    ]);
  });
});

const spawnCaller = (labels: Record<string, string>) =>
  terminal({ address: "t1", name: "manager", labels });
const MANAGER = { "fleet.role": "coordinator", "fleet.domain": "manager" };

/**
 * A fake Herdr: `hc get t1` answers the caller, `hc ls` filtered on the coordinator role answers
 * `coordinatorsLive`, the domain's watcher query answers `watchers` (by default one started by
 * t7), any other `hc ls` answers `live`, a launch goes into space sp9 as t7 (or answers
 * `launch`), and `hc get t7` answers `launched`.
 */
const spawnFake = (
  callerLabels: Record<string, string>,
  coordinatorsLive: readonly Record<string, unknown>[] = [],
  live: readonly Record<string, unknown>[] = [],
  watchers: readonly Record<string, unknown>[] = [{ address: "t-w", state: "live", parent: "t7" }],
  launched: Record<string, unknown> = { address: "t7", state: "live" },
  domain = "tasks",
  launch: RunOutput | (() => RunOutput) = ok('{"address":"t7"}'),
) =>
  fakeProc((argv) => {
    if (argv[0] === "hc") {
      if (argv[1] === "get" && argv[2] === "t1") return ok(spawnCaller(callerLabels));
      if (argv[1] === "get" && argv[2] === "t7") return ok(JSON.stringify(launched));
      // t4: a coordinator that has left Herdr, whose lease may still be live.
      if (argv[1] === "get" && argv[2] === "t4")
        return {
          exitCode: 1,
          stdout: "",
          stderr: JSON.stringify({ error: { kind: "not_found", message: "no terminal t4" } }),
        };
      if (argv[1] === "ls" && argv.includes(`coordinate.watch-domain=${domain}`))
        return ok(JSON.stringify({ terminals: watchers }));
      if (argv[1] === "ls" && argv.includes("fleet.role=coordinator"))
        return ok(JSON.stringify({ terminals: coordinatorsLive }));
      if (argv[1] === "ls") return ok(JSON.stringify({ terminals: live }));
      if (argv[1] === "run") return typeof launch === "function" ? launch() : launch;
      if (argv[1] === "kill" || argv[1] === "rm") return ok("{}");
    }
    if (argv[0] === "herdr-app") {
      if (argv[1] === "ls")
        return ok(
          JSON.stringify({
            spaces: [
              { id: "sp9", tabs: [{ id: "tab9", terminals: [{ terminal: "t6", pane: "p6" }] }] },
            ],
          }),
        );
      if (argv[2] === "space.new") return ok('{"space":"sp9","tab":"tab9","terminal":"t6"}');
      if (argv[2] === "pane.close" || argv[2] === "tab.rename" || argv[2] === "space.close")
        return ok("{}");
    }
    throw new Error(`unexpected command: ${argv.join(" ")}`);
  });

const spawnOptions = (fields: Partial<SpawnOptions> = {}): SpawnOptions => ({
  domain: "tasks",
  cwd: undefined,
  harness: undefined,
  model: undefined,
  effort: undefined,
  items: [],
  now: SPAWN_NOW,
  ...fields,
});

const SPAWN_NOW = "2026-11-23T00:00:00.000Z";
const tasksDocument = (state: string) => join(state, "backlogs", "tasks.json");
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const openItem = (id: string, title: string) => ({
  id,
  title,
  status: "open",
  touches: [],
  decided: [],
  ask: null,
  answered: [],
  due: null,
  delegates: [],
  createdAt: SPAWN_NOW,
  closedAt: null,
  outcome: null,
});
const ownedBy = async (
  cfg: Awaited<ReturnType<typeof config>>,
  domain: string,
  paths: string[],
) => {
  await Effect.runPromise(createDocument(cfg, domain));
  for (const path of paths)
    await Effect.runPromise(
      boundaryAdd(cfg, domain, { path, adjacent: false, json: false, outsideTerminal: false }),
    );
};

const withDefaultHarness = async (state: string, harness: "pi" | "claude") => {
  const cfg = await config(state);
  await Effect.runPromise(
    setHarnessPolicy(cfg, {
      scope: "global",
      domain: undefined,
      selection: { enabled: ["pi", "claude"], default: harness },
      expectedRevision: 0,
      json: true,
    }),
  );
  return cfg;
};

const ENV = { HC_TERMINAL_ID: "t1" };
/** The calls after the launch's tab rename and the lease's core-name read: the readiness wait. */
const tailAfterRename = (calls: readonly (readonly string[])[]) => {
  const renamed = calls.findIndex((argv) => argv[2] === "tab.rename");
  expect(calls[renamed + 1]).toEqual(coreRead);
  return calls.slice(renamed + 2);
};
const coreRead = ["hc", "server", "status", "--json"];
/** A readiness wait of three polls that records each sleep instead of sleeping. */
const fastWait = (sleeps: number[]) => ({
  timeoutMs: 3,
  intervalMs: 1,
  sleep: (ms: number) => Effect.sync(() => void sleeps.push(ms)),
});
const t7Get = ["hc", "get", "t7", "--json"];
const watcherList = ["hc", "ls", "--json", "--label", "coordinate.watch-domain=tasks"];
const coordinatorList = [
  "hc",
  "ls",
  "--json",
  "--label",
  "fleet.role=coordinator",
  "--label",
  "fleet.domain=tasks",
];

describe("spawn", () => {
  it.each<{ role: string; labels: Record<string, string> }>([
    { role: "a delegate", labels: { "fleet.domain": "manager", "fleet.task": "fix a" } },
    { role: "an unlabelled terminal", labels: {} },
  ])("refuses from $role before touching anything else", async ({ labels }) => {
    const state = dir();
    const fake = spawnFake(labels);
    const error = await failureOf(
      spawn(await config(state), spawnOptions({ cwd: state }), ENV),
      fake.layer,
    );
    expect(messageOf(error)).toBe(
      "spawn runs from a coordinator terminal, and t1 is not labelled as one (fleet.role=coordinator)",
    );
    expect(fake.calls.map((call) => call.argv)).toEqual([["hc", "get", "t1", "--json"]]);
  });

  it.each([
    {
      state: "a running coordinator",
      listed: { address: "t4", name: "tasks-coordinator", state: "live", status: "working" },
      named: "tasks-coordinator (t4)",
    },
    {
      state: "a coordinator launched seconds ago, labelled but with no status yet",
      listed: { address: "t5", state: "live" },
      named: "t5 (t5)",
    },
  ])("refuses a domain that already has $state, naming it", async ({ listed, named }) => {
    const state = dir();
    const cfg = await withDefaultHarness(state, "claude");
    const fake = spawnFake(MANAGER, [listed]);
    const error = await failureOf(spawn(cfg, spawnOptions({ cwd: state }), ENV), fake.layer);
    expect(messageOf(error)).toBe(
      `tasks already has a live coordinator: ${named}; go to it instead of spawning another`,
    );
    expect(fake.calls.map((call) => call.argv)).toEqual([
      ["hc", "get", "t1", "--json"],
      coordinatorList,
    ]);
  });

  it("refuses an explicitly requested harness the domain's policy disables", async () => {
    const state = dir();
    const cfg = await config(state);
    await Effect.runPromise(
      setHarnessPolicy(cfg, {
        scope: "global",
        domain: undefined,
        selection: { enabled: ["claude"], default: "claude" },
        expectedRevision: 0,
        json: true,
      }),
    );
    const fake = spawnFake(MANAGER);
    const error = await failureOf(
      spawn(cfg, spawnOptions({ cwd: state, harness: "pi" }), ENV),
      fake.layer,
    );
    expect(messageOf(error)).toBe(
      "harness pi is disabled by global policy for tasks; enabled harnesses: claude",
    );
    expect(fake.calls.map((call) => call.argv)).toEqual([["hc", "get", "t1", "--json"]]);
  });

  it("refuses an effort the resolved harness does not have", async () => {
    const state = dir();
    const fake = spawnFake(MANAGER);
    const error = await failureOf(
      spawn(
        await withDefaultHarness(state, "claude"),
        spawnOptions({ cwd: state, effort: "minimal" }),
        ENV,
      ),
      fake.layer,
    );
    expect(messageOf(error)).toBe("minimal is not a claude effort: low, medium, high, xhigh, max");
    expect(fake.calls.map((call) => call.argv)).toEqual([["hc", "get", "t1", "--json"]]);
  });

  it("refuses from a plain shell with no Herdr terminal, touching nothing", async () => {
    const state = dir();
    const fake = spawnFake(MANAGER);
    const error = await failureOf(
      spawn(await withDefaultHarness(state, "claude"), spawnOptions({ cwd: state }), {}),
      fake.layer,
    );
    expect(messageOf(error)).toBe(
      "spawn runs from a coordinator terminal, and HC_TERMINAL_ID is unset: this is not a Herdr terminal",
    );
    expect(fake.calls).toEqual([]);
  });

  it.each([
    { domain: "web.app", name: "web-app-coordinator" },
    { domain: "a-very-long-domain-name", name: "a-very-long-c7b86402-coordinator" },
  ])(
    "names a $domain coordinator $name, keeping the domain elsewhere",
    async ({ domain, name }) => {
      const state = dir();
      const fake = spawnFake(
        MANAGER,
        [],
        [],
        [{ address: "t-w", state: "live", parent: "t7" }],
        { address: "t7", state: "live" },
        domain,
      );
      const result = await runWith(
        spawn(await withDefaultHarness(state, "claude"), spawnOptions({ domain, cwd: state }), ENV),
        fake.layer,
      );
      const run = fake.calls.map((call) => call.argv).find((argv) => argv[1] === "run") ?? [];
      expect([result.name, result.status]).toEqual([name, "ready"]);
      expect(run.slice(4, 6)).toEqual(["--name", name]);
      expect(run.filter((arg) => arg.startsWith("fleet.domain="))).toEqual([
        `fleet.domain=${domain}`,
      ]);
      expect(run.at(-1)).toBe(`/coordinate ${domain}`);
    },
  );

  it("refuses without --cwd, and with a folder that does not exist", async () => {
    const state = dir();
    const cfg = await withDefaultHarness(state, "claude");
    const missing = await failureOf(spawn(cfg, spawnOptions(), ENV), spawnFake(MANAGER).layer);
    expect(messageOf(missing)).toBe(
      "tasks has no backlog yet; pass --cwd <dir>: the folder the tasks coordinator starts in",
    );
    expect(existsSync(tasksDocument(state))).toBe(false);
    const gone = join(state, "gone");
    const absent = await failureOf(
      spawn(cfg, spawnOptions({ cwd: gone }), ENV),
      spawnFake(MANAGER).layer,
    );
    expect(messageOf(absent)).toBe(`${gone} does not exist`);
  });

  it("refuses when a live terminal already has the coordinator's name", async () => {
    const state = dir();
    const fake = spawnFake(
      MANAGER,
      [],
      [{ address: "t8", name: "tasks-coordinator", state: "live" }],
    );
    const error = await failureOf(
      spawn(await withDefaultHarness(state, "claude"), spawnOptions({ cwd: state }), ENV),
      fake.layer,
    );
    expect(messageOf(error)).toBe("a live terminal is already named tasks-coordinator (t8)");
    expect(fake.calls.map((call) => call.argv)).toEqual([
      ["hc", "get", "t1", "--json"],
      coordinatorList,
      ["hc", "ls", "--json"],
    ]);
  });

  it("starts the policy's default harness in its own space with coordinator labels, no parent and /coordinate", async () => {
    const state = dir();
    const fake = spawnFake(MANAGER);
    const result = await runWith(
      spawn(await withDefaultHarness(state, "claude"), spawnOptions({ cwd: state }), ENV),
      fake.layer,
    );
    const calls = fake.calls.map((call) => call.argv);
    const run = calls.find((argv) => argv[1] === "run") ?? [];
    const agent = run.slice(run.indexOf("--") + 5);
    const session = agent[agent.indexOf("--session-id") + 1] ?? "";
    expect(session).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(calls.slice(0, 4)).toEqual([
      ["hc", "get", "t1", "--json"],
      coordinatorList,
      ["hc", "ls", "--json"],
      [
        "herdr-app",
        "do",
        "space.new",
        JSON.stringify({ name: "tasks", folder: state, focus: false }),
      ],
    ]);
    expect(run.slice(0, run.indexOf("--"))).toEqual([
      "hc",
      "run",
      "--bg",
      "--json",
      "--name",
      "tasks-coordinator",
      "--cwd",
      state,
      "--no-parent",
      "--label",
      "herdr.space=sp9",
      "--label",
      "herdr.tab=tab9",
      "--label",
      "fleet.role=coordinator",
      "--label",
      "fleet.domain=tasks",
      "--label",
      `fleet.session=${session}`,
      "--label",
      "fleet.harness=claude",
    ]);
    expect(agent).toEqual([
      "claude",
      "--session-id",
      session,
      "--name",
      "tasks-coordinator",
      "/coordinate tasks",
    ]);
    expect(calls.slice(5)).toEqual([
      ["herdr-app", "ls"],
      ["herdr-app", "do", "pane.close", '{"pane":"p6"}'],
      ["hc", "kill", "t6"],
      ["hc", "rm", "t6"],
      ["herdr-app", "do", "tab.rename", '{"id":"tab9","name":"Tasks · No active focus"}'],
      coreRead,
      watcherList,
    ]);
    expect(spawnOutput(result)).toEqual([
      `created backlog ${tasksDocument(state)}`,
      `owned: added ${state}`,
      `started coordinator tasks-coordinator for tasks (t7) in its own space sp9, claude session ${session}`,
      "ready: tasks-coordinator (t7) armed watcher t-w",
    ]);
    expect(result).toEqual({
      name: "tasks-coordinator",
      domain: "tasks",
      terminal: "t7",
      space: "sp9",
      harness: "claude",
      session,
      backlog: { path: tasksDocument(state), created: true, owned: state, items: [], present: [] },
      watcher: "t-w",
      status: "ready",
      timeoutMs: 120_000,
    });
  });

  it("refuses an existing domain with no owned Boundary path and no --cwd, writing nothing", async () => {
    const state = dir();
    const cfg = await withDefaultHarness(state, "claude");
    await ownedBy(cfg, "tasks", []);
    const before = readFileSync(tasksDocument(state), "utf8");
    const fake = spawnFake(MANAGER);
    const error = await failureOf(spawn(cfg, spawnOptions({ items: ["first"] }), ENV), fake.layer);
    expect(messageOf(error)).toBe(
      "the tasks backlog has no owned Boundary path; pass --cwd <dir>: the folder the tasks coordinator starts in",
    );
    expect(readFileSync(tasksDocument(state), "utf8")).toBe(before);
    expect(fake.calls.map((call) => call.argv)).toEqual([["hc", "get", "t1", "--json"]]);
  });

  it("leaves no backlog document when refused after every other check", async () => {
    const state = dir();
    const cfg = await withDefaultHarness(state, "claude");
    const taken = await failureOf(
      spawn(cfg, spawnOptions({ cwd: state, items: ["first"] }), ENV),
      spawnFake(MANAGER, [], [{ address: "t8", name: "tasks-coordinator", state: "live" }]).layer,
    );
    expect(messageOf(taken)).toBe("a live terminal is already named tasks-coordinator (t8)");
    const blank = await failureOf(
      spawn(cfg, spawnOptions({ cwd: state, items: ["first", " "] }), ENV),
      spawnFake(MANAGER).layer,
    );
    expect(messageOf(blank)).toBe("--item: title is empty");
    expect(existsSync(tasksDocument(state))).toBe(false);
  });

  it("seeds a new domain's backlog with the folder owned and each --item open, leaving the caller's alone", async () => {
    const state = dir();
    const cfg = await withDefaultHarness(state, "claude");
    await Effect.runPromise(createDocument(cfg, "manager"));
    await Effect.runPromise(
      itemAdd(cfg, "manager", { title: "spawn tasks", json: false, now: SPAWN_NOW }),
    );
    const caller = readFileSync(join(state, "backlogs", "manager.json"), "utf8");
    const lines = spawnOutput(
      await runWith(
        spawn(cfg, spawnOptions({ cwd: state, items: ["first", "second"] }), ENV),
        spawnFake(MANAGER).layer,
      ),
    );
    const document = readJson(tasksDocument(state));
    expect(document.boundary).toEqual({ owned: [state], adjacent: [] });
    expect(document.items).toEqual([openItem("i1", "first"), openItem("i2", "second")]);
    expect(document.nextId).toBe(3);
    expect(lines.slice(0, 4)).toEqual([
      `created backlog ${tasksDocument(state)}`,
      `owned: added ${state}`,
      "added i1: first",
      "added i2: second",
    ]);
    expect(readFileSync(join(state, "backlogs", "manager.json"), "utf8")).toBe(caller);
  });

  it("refuses while another machine holds a live lease for the domain, before seeding or launching", async () => {
    const state = dir();
    const cfg = await withDefaultHarness(state, "claude");
    await ownedBy(cfg, "tasks", [state]);
    const lease = { machine: "strix", address: "t1fn", expiry: "2026-11-23T00:02:00.000Z" };
    writeFileSync(
      tasksDocument(state),
      JSON.stringify({ ...readJson(tasksDocument(state)), lease }),
    );
    const before = readFileSync(tasksDocument(state), "utf8");
    const fake = spawnFake(MANAGER);
    const error = await failureOf(spawn(cfg, spawnOptions({ items: ["first"] }), ENV), fake.layer);
    expect(messageOf(error)).toBe(
      "tasks already has a coordinator: strix/t1fn holds its lease until 2026-11-23T00:02:00.000Z; go to it, or wait for that lease to expire (3 minutes after its watcher last renewed it)",
    );
    expect(
      fake.calls.filter((call) => call.argv[1] === "run" || call.argv[0] === "herdr-app"),
    ).toEqual([]);
    expect(readFileSync(tasksDocument(state), "utf8")).toBe(before);
  });

  it("leaves the lease with the new coordinator, whose own start then takes it again", async () => {
    const state = dir();
    const cfg = await withDefaultHarness(state, "claude");
    await runWith(spawn(cfg, spawnOptions({ cwd: state }), ENV), spawnFake(MANAGER).layer);
    expect(readJson(tasksDocument(state)).lease).toEqual({
      machine: "fake-core",
      address: "t7",
      expiry: "2026-11-23T00:03:00.000Z",
    });
    const own = fakeProc((argv) => {
      if (argv[1] === "ls") return ok('{"terminals":[]}');
      if (argv[1] === "get" && argv[2] === "t7")
        return ok(
          terminal({
            address: "t7",
            labels: { "fleet.role": "coordinator", "fleet.domain": "tasks" },
          }),
        );
      if (argv[1] === "run") return ok('{"address":"t10"}');
      return ok("{}");
    });
    const later = Date.parse("2026-11-23T00:01:00.000Z");
    const lines = await runWith(start(cfg, "tasks", { HC_TERMINAL_ID: "t7" }, later), own.layer);
    expect(lines[0]).toBe("labelled t7: fleet.role=coordinator fleet.domain=tasks");
    expect(readJson(tasksDocument(state)).lease).toEqual({
      machine: "fake-core",
      address: "t7",
      expiry: "2026-11-23T00:04:00.000Z",
    });
  });

  it("spawns over a lease on this machine whose terminal is gone, leaving it with the new coordinator", async () => {
    const state = dir();
    const cfg = await withDefaultHarness(state, "claude");
    await ownedBy(cfg, "tasks", [state]);
    const gone = { machine: "fake-core", address: "t4", expiry: "2026-11-23T00:02:00.000Z" };
    writeFileSync(
      tasksDocument(state),
      JSON.stringify({ ...readJson(tasksDocument(state)), lease: gone }),
    );
    const result = await runWith(spawn(cfg, spawnOptions(), ENV), spawnFake(MANAGER).layer);
    expect([result.terminal, result.status]).toEqual(["t7", "ready"]);
    expect(readJson(tasksDocument(state)).lease).toEqual({
      machine: "fake-core",
      address: "t7",
      expiry: "2026-11-23T00:03:00.000Z",
    });
  });

  it("still reports the launch when another coordinator takes the lease while it starts", async () => {
    const state = dir();
    const cfg = await withDefaultHarness(state, "claude");
    const rival = { machine: "strix", address: "t1fn", expiry: "2026-11-23T00:03:00.000Z" };
    const fake = spawnFake(MANAGER, [], [], undefined, undefined, "tasks", () => {
      writeFileSync(
        tasksDocument(state),
        JSON.stringify({ ...readJson(tasksDocument(state)), lease: rival }),
      );
      return ok('{"address":"t7"}');
    });
    const result = await runWith(spawn(cfg, spawnOptions({ cwd: state }), ENV), fake.layer);
    expect([result.terminal, result.status]).toEqual(["t7", "ready"]);
    // The new coordinator's own start refuses itself against the rival's lease.
    expect(readJson(tasksDocument(state)).lease).toEqual(rival);
  });

  it("starts an existing domain without --cwd in its first owned Boundary path, rewriting only the lease", async () => {
    const state = dir();
    const cfg = await withDefaultHarness(state, "claude");
    const first = join(state, "first");
    const second = join(state, "second");
    mkdirSync(first);
    mkdirSync(second);
    await ownedBy(cfg, "tasks", [first, second]);
    const before = readFileSync(tasksDocument(state), "utf8");
    const fake = spawnFake(MANAGER);
    const lines = spawnOutput(await runWith(spawn(cfg, spawnOptions(), ENV), fake.layer));
    const calls = fake.calls.map((call) => call.argv);
    const run = calls.find((argv) => argv[1] === "run") ?? [];
    expect(calls[3]).toEqual([
      "herdr-app",
      "do",
      "space.new",
      JSON.stringify({ name: "tasks", folder: first, focus: false }),
    ]);
    expect(run.slice(6, 8)).toEqual(["--cwd", first]);
    expect(lines[0]).toBe(`backlog ${tasksDocument(state)}`);
    // Only the new coordinator's lease is written.
    const { lease: _lease, ...after } = readJson(tasksDocument(state));
    expect(after).toEqual(JSON.parse(before));
  });

  it("keeps an already owned --cwd once and appends --item after the existing items", async () => {
    const state = dir();
    const cfg = await withDefaultHarness(state, "claude");
    await ownedBy(cfg, "tasks", [state]);
    await Effect.runPromise(itemAdd(cfg, "tasks", { title: "old", json: false, now: SPAWN_NOW }));
    const lines = spawnOutput(
      await runWith(
        spawn(cfg, spawnOptions({ cwd: state, items: ["new"] }), ENV),
        spawnFake(MANAGER).layer,
      ),
    );
    const document = readJson(tasksDocument(state));
    expect(document.boundary).toEqual({ owned: [state], adjacent: [] });
    expect(document.items).toEqual([openItem("i1", "old"), openItem("i2", "new")]);
    expect(lines.slice(0, 2)).toEqual([`backlog ${tasksDocument(state)}`, "added i2: new"]);
  });

  it("does not add an --item again on a retry after a failed launch, reporting it as already present", async () => {
    const state = dir();
    const cfg = await withDefaultHarness(state, "claude");
    // A done item with the same title does not count: "first" is added again.
    await Effect.runPromise(createDocument(cfg, "tasks"));
    await Effect.runPromise(itemAdd(cfg, "tasks", { title: "first", json: false, now: SPAWN_NOW }));
    await Effect.runPromise(
      itemClose(cfg, "tasks", {
        id: "i1",
        outcome: "shipped",
        dismissed: false,
        json: false,
        now: SPAWN_NOW,
      }),
    );
    const failed = await failureOf(
      spawn(cfg, spawnOptions({ cwd: state, items: ["first", "second"] }), ENV),
      spawnFake(MANAGER, [], [], undefined, undefined, "tasks", {
        exitCode: 1,
        stdout: "",
        stderr: "boom",
      }).layer,
    );
    expect(messageOf(failed)).toBe("boom");
    const lines = spawnOutput(
      await runWith(
        spawn(cfg, spawnOptions({ cwd: state, items: ["first", "third"] }), ENV),
        spawnFake(MANAGER).layer,
      ),
    );
    expect(
      readJson(tasksDocument(state)).items.map(
        (item: { id: string; title: string; status: string }) => [item.id, item.title, item.status],
      ),
    ).toEqual([
      ["i1", "first", "done"],
      ["i2", "first", "open"],
      ["i3", "second", "open"],
      ["i4", "third", "open"],
    ]);
    expect(lines.slice(0, 3)).toEqual([
      `backlog ${tasksDocument(state)}`,
      "added i4: third",
      "already present i2: first",
    ]);
  });

  it("stores a symlinked --cwd as backlog boundary add does and starts there", async () => {
    const state = dir();
    const cfg = await withDefaultHarness(state, "claude");
    const target = join(state, "target");
    const link = join(state, "link");
    mkdirSync(target);
    symlinkSync(target, link);
    await ownedBy(cfg, "tasks", [link]);
    const fake = spawnFake(MANAGER);
    const lines = spawnOutput(
      await runWith(spawn(cfg, spawnOptions({ cwd: `${link}/` }), ENV), fake.layer),
    );
    const run = fake.calls.map((call) => call.argv).find((argv) => argv[1] === "run") ?? [];
    expect(readJson(tasksDocument(state)).boundary).toEqual({ owned: [link], adjacent: [] });
    expect(run.slice(6, 8)).toEqual(["--cwd", link]);
    expect(lines[1]?.startsWith("started coordinator")).toBe(true);
  });

  it("starts pi with /skill:coordinate and passes only the model and effort given", async () => {
    const state = dir();
    const fake = spawnFake(MANAGER);
    await runWith(
      spawn(
        await withDefaultHarness(state, "claude"),
        spawnOptions({ cwd: state, harness: "pi", model: "anthropic/opus", effort: "high" }),
        ENV,
      ),
      fake.layer,
    );
    const run = fake.calls.map((call) => call.argv).find((argv) => argv[1] === "run") ?? [];
    const agent = run.slice(run.indexOf("--") + 5);
    expect(agent).toEqual([
      "pi",
      "--session-id",
      agent[2] ?? "",
      "--name",
      "tasks-coordinator",
      "--model",
      "anthropic/opus",
      "--thinking",
      "high",
      "/skill:coordinate tasks",
    ]);
    expect(run.filter((arg) => arg.startsWith("fleet."))).toEqual([
      "fleet.role=coordinator",
      "fleet.domain=tasks",
      `fleet.session=${agent[2] ?? ""}`,
      "fleet.harness=pi",
    ]);
  });

  describe("readiness", () => {
    it.each([
      {
        state: "blocked on a dialog",
        launched: {
          address: "t7",
          state: "live",
          status: { state: "blocked" },
        },
        listed: [{ address: "t7", state: "live", where: "tasks / Tasks · No active focus" }],
        polls: [watcherList, t7Get, ["hc", "ls", "--json"]],
        fields: { status: "blocked", tab: "tasks / Tasks · No active focus" },
        line: 'not ready after 0s: tasks-coordinator (t7) is blocked on a dialog, which is the user\'s to answer in "tasks / Tasks · No active focus" (hc read t7); left running',
      },
      {
        state: "still working",
        launched: { address: "t7", state: "live", status: { state: "working" } },
        listed: [],
        polls: [watcherList, t7Get],
        fields: { status: "working", agentStatus: "working" },
        line: "not ready after 0s: tasks-coordinator (t7) is still working with no watcher armed; left running",
      },
    ])(
      "times out $state, reports the last state and leaves the terminal running",
      async ({ launched, listed, polls, fields, line }) => {
        const state = dir();
        const fake = spawnFake(MANAGER, [], listed, [], launched);
        const sleeps: number[] = [];
        const result = await runWith(
          spawn(
            await withDefaultHarness(state, "claude"),
            spawnOptions({ cwd: state }),
            ENV,
            fastWait(sleeps),
          ),
          fake.layer,
        );
        expect({ ...result, session: "" }).toEqual({
          name: "tasks-coordinator",
          domain: "tasks",
          terminal: "t7",
          space: "sp9",
          harness: "claude",
          session: "",
          backlog: {
            path: tasksDocument(state),
            created: true,
            owned: state,
            items: [],
            present: [],
          },
          watcher: null,
          ...fields,
          timeoutMs: 3,
        });
        expect(spawnOutput(result).at(-1)).toBe(line);
        expect(sleeps).toEqual([1, 1]);
        expect(tailAfterRename(fake.calls.map((call) => call.argv))).toEqual([
          ...polls,
          ...polls,
          ...polls,
        ]);
      },
    );

    it("counts only a watcher the new terminal started, not a stale one of another owner", async () => {
      const state = dir();
      const stale = { address: "t-old", state: "live", parent: "t3" };
      const onlyStale = await runWith(
        spawn(
          await withDefaultHarness(state, "claude"),
          spawnOptions({ cwd: state }),
          ENV,
          fastWait([]),
        ),
        spawnFake(MANAGER, [], [], [stale], {
          address: "t7",
          state: "live",
          status: { state: "working" },
        }).layer,
      );
      expect([onlyStale.status, onlyStale.watcher]).toEqual(["working", null]);
      const both = await runWith(
        spawn(
          await withDefaultHarness(dir(), "claude"),
          spawnOptions({ cwd: state }),
          ENV,
          fastWait([]),
        ),
        spawnFake(MANAGER, [], [], [stale, { address: "t-new", state: "live", parent: "t7" }])
          .layer,
      );
      expect([both.status, both.watcher]).toEqual(["ready", "t-new"]);
    });

    it("stops waiting once the new terminal is gone", async () => {
      const state = dir();
      const fake = spawnFake(MANAGER, [], [], [], { address: "t7", state: "exited" });
      const sleeps: number[] = [];
      const result = await runWith(
        spawn(
          await withDefaultHarness(state, "claude"),
          spawnOptions({ cwd: state }),
          ENV,
          fastWait(sleeps),
        ),
        fake.layer,
      );
      expect([result.status, result.watcher]).toEqual(["gone", null]);
      expect(spawnOutput(result).at(-1)).toBe(
        "not ready: tasks-coordinator (t7) is gone, it ended before arming its watcher",
      );
      expect(sleeps).toEqual([]);
      expect(tailAfterRename(fake.calls.map((call) => call.argv))).toEqual([watcherList, t7Get]);
    });
  });
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

describe("resume policy", () => {
  it("refuses a disabled recorded harness before touching the ended record or live fleet", async () => {
    const state = dir();
    const cfg = await config(state);
    const recordPath = await Effect.runPromise(
      writeEnded(state, {
        name: "fix-a",
        domain: "app",
        session: "s-1",
        program: "pi",
        cwd: state,
        ended_at: "2026-11-17T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(
      setHarnessPolicy(cfg, {
        scope: "global",
        domain: undefined,
        selection: { enabled: ["claude"], default: "claude" },
        expectedRevision: 0,
        json: true,
      }),
    );
    const fake = fakeProc(() => {
      throw new Error("resume must refuse before any Herdr call");
    });
    const error = await failureOf(resumeDelegate(cfg, "fix-a", undefined), fake.layer);
    expect(messageOf(error)).toBe(
      "cannot resume fix-a: its recorded harness pi is disabled by global policy for app; enable it explicitly before resuming",
    );
    expect(fake.calls).toEqual([]);
    expect(existsSync(recordPath)).toBe(true);
  });
});

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
    expect([
      record.program,
      record.cwd,
      record.branch,
      record.base_sha,
      record.space,
      record.machine,
    ]).toEqual([
      "pi",
      "/nonexistent/wt",
      "wyattjoh/fix-a",
      endLabels["fleet.base"],
      true,
      FAKE_CORE,
    ]);
    expect(fake.calls.map((call) => call.argv.slice(0, 3).join(" "))).toEqual([
      "hc get fix-a",
      "hc server status",
      "git -c commit.gpgsign=false",
      "lsof -d cwd,txt",
      "ps -axww -o",
      "hc kill t2",
      "hc rm t2",
      "herdr-app do space.close",
      "lsof -d cwd,txt",
      "ps -axww -o",
    ]);
  });

  it("stops what the delegate left running: its terminal's tree and its worktree's orphans", async () => {
    const state = dir();
    const HOLD = "/Apps/Herdr Core.app/Contents/MacOS/herdr-core hold --socket /s.sock";
    const machine = processMachine(
      [
        { pid: 5, ppid: 1, args: HOLD, cwd: "/" },
        { pid: 10, ppid: 5, args: "pi --session s-1", cwd: "/nonexistent/wt" },
        { pid: 11, ppid: 10, args: "chrome --headless --remote-debugging-port=9333", cwd: "/" },
        { pid: 20, ppid: 1, args: "pnpm dev", cwd: "/nonexistent/wt" },
        { pid: 60, ppid: 5, args: "sh preview", cwd: "/nonexistent/wt" },
      ],
      { TERM: [11] },
      endAnswers,
    );
    const fake = fakeProc((argv) => {
      if (argv[0] === "hc" && argv[1] === "get")
        return ok(
          terminal({
            status: { state: "idle" },
            status_ms: 0,
            labels: endLabels,
            cwd: "/nonexistent/wt",
            pid: 10,
          }),
        );
      const out = machine.answer(argv);
      return argv[0] === "lsof"
        ? { ...out, stdout: out.stdout.replace("c/Apps/Herdr", "cherdr-core") }
        : out;
    });
    const lines = await runWith(
      endDelegate(await config(state), "fix-a", false, undefined, {
        graceMs: 0,
        pollMs: 0,
        selfPid: "999999",
      }),
      fake.layer,
    );
    expect(lines.slice(2)).toEqual([
      "processes of fix-a:",
      "  stopped 10 pi --session s-1",
      "  stopped 11 chrome --headless --remote-debugging-port=9333 (SIGKILL)",
      "  stopped 20 pnpm dev",
    ]);
    expect([...machine.alive].toSorted()).toEqual([5, 60]);
  });

  it("still ends the delegate when the process scan fails", async () => {
    const fake = fakeProc((argv) =>
      argv[0] === "lsof" ? { exitCode: 2, stdout: "", stderr: "lsof: boom" } : endAnswers(argv),
    );
    const lines = await runWith(endDelegate(await config(dir()), "fix-a", false), fake.layer);
    expect(lines.slice(1)).toEqual([
      "worktree, branch and session stay; resume with: coordinate resume fix-a",
      "stopped no processes: the process scan failed (lsof: boom)",
    ]);
  });

  it("leaves the folder's orphans alone for a delegate coordinate made no worktree for", async () => {
    const attached = Object.fromEntries(
      Object.entries(endLabels).filter(([key]) => key !== "fleet.base"),
    );
    const machine = processMachine(
      [{ pid: 20, ppid: 1, args: "pnpm dev", cwd: "/nonexistent/wt" }],
      {},
      endAnswers,
    );
    const fake = fakeProc((argv) =>
      argv[0] === "hc" && argv[1] === "get"
        ? ok(terminal({ status: { state: "idle" }, labels: attached, cwd: "/nonexistent/wt" }))
        : machine.answer(argv),
    );
    const lines = await runWith(endDelegate(await config(dir()), "fix-a", false), fake.layer);
    expect(lines.slice(2)).toEqual(["no processes of fix-a were left running"]);
    expect(machine.kills).toEqual([]);
  });

  it("still ends a remote delegate when its machine's process scan fails, touching no local process", async () => {
    const fake = fakeProc((argv) =>
      argv[0] === "hc" && argv[1] === "get"
        ? ok(
            terminal({
              address: "strix/t2",
              status: { state: "idle" },
              status_ms: 0,
              labels: endLabels,
              cwd: "/nonexistent/wt",
              pid: 10,
            }),
          )
        : ok("{}"),
    );
    const state = dir();
    const lines = await runWith(endDelegate(await config(state), "fix-a", false), fake.layer);
    expect(lines.slice(2)).toEqual([
      "stopped no processes on strix: the process scan failed (no processes read on strix)",
    ]);
    const record = JSON.parse(readFileSync(join(state, "ended", "s-1.json"), "utf8"));
    expect(record.machine).toBe("strix");
    expect(
      fake.calls.filter((call) => ["lsof", "ps", "kill"].includes(call.argv[0] ?? "")),
    ).toEqual([]);
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
