import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { resolveConfig } from "./config.ts";
import {
  commitFile,
  g,
  gitAndFake,
  initRepo,
  processMachine,
  runWith,
  tempDir,
} from "./fixture.ts";
import { ok, type RunOutput } from "./proc.ts";
import { real } from "./git.ts";
import { herdrCorePids, parseLsof, parsePs, type StopOptions } from "./processes.ts";
import {
  context,
  pruneBranches,
  pruneEnded,
  removeMany,
  report,
  stopDeletedFolders,
} from "./sweep.ts";

const STOP: StopOptions = { graceMs: 0, pollMs: 0, selfPid: "999999" };
const STARTED = "Mon Nov 23 04:50:09 2026";
const ps = (lines: ReadonlyArray<readonly [number, number, string]>): string =>
  lines.map(([pid, ppid, args]) => `${pid} ${ppid} ${STARTED} ${args}\n`).join("");

const made: string[] = [];
const track = (path: string): string => {
  made.push(path);
  return path;
};
afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true });
});

const config = (state: string) =>
  Effect.runPromise(resolveConfig({ state_dir: state, backlog_dir: join(state, "b") }, "/c"));

const fakes =
  (
    sessions: Array<{ address: string; cwd: string }> = [],
    processPath: string | undefined = undefined,
  ) =>
  (argv: readonly string[]): RunOutput => {
    if (argv[0] === "hc")
      return ok(
        JSON.stringify({
          terminals: sessions.map((session) => ({
            ...session,
            agent: "pi",
            status: "idle",
            state: "live",
          })),
        }),
      );
    if (argv[0] === "lsof")
      return ok(processPath ? `p1\ncnode\nn${processPath}\n` : "p1\ncbash\nn/\n");
    if (argv[0] === "herdr-app") return ok('{"spaces":[]}');
    return ok("");
  };

/**
 * A repo whose main ignores .devenv/ and .scratch/, with a worktree x on branch x holding one commit.
 */
const repoWithWorktree = (): { repo: string; wt: string } => {
  const repo = track(initRepo());
  commitFile(repo, ".gitignore", ".devenv/\n.scratch/\n");
  const wt = join(repo, ".claude", "worktrees", "x");
  g(repo, "worktree", "add", "-q", wt, "-b", "x");
  commitFile(wt, "feature.txt", "feature\n");
  return { repo, wt };
};

const repoWithEmptyWorktree = (): { repo: string; wt: string } => {
  const repo = track(initRepo());
  commitFile(repo, ".gitignore", ".devenv/\n.scratch/\n");
  const wt = join(repo, ".claude", "worktrees", "x");
  g(repo, "worktree", "add", "-q", wt, "-b", "x");
  return { repo, wt };
};

const squashIntoMain = (repo: string): void => {
  commitFile(repo, "other.txt", "o\n");
  g(repo, "merge", "-q", "--squash", "x");
  g(repo, "commit", "-q", "-m", "squash x");
};

const worktreeRows = async (
  repo: string,
  sessions: Array<{ address: string; cwd: string }> = [],
  ended: { cwd: string; branch: string } | undefined = undefined,
  processPath: string | undefined = undefined,
) => {
  const state = track(tempDir());
  if (ended) {
    mkdirSync(join(state, "ended"), { recursive: true });
    writeFileSync(
      join(state, "ended", "session.json"),
      JSON.stringify({
        name: "ended",
        domain: "app",
        session: "session",
        cwd: ended.cwd,
        branch: ended.branch,
        ended_at: "2026-11-18T00:00:00Z",
      }),
    );
  }
  const fake = gitAndFake(fakes(sessions, processPath));
  const rows = await runWith(
    report(await config(state), [repo], {
      bases: [],
      keep: [],
      sizes: false,
      nowMs: Date.now(),
    }),
    fake.layer,
  );
  return rows.filter((row) => row.text.startsWith("worktree "));
};

const verdicts = async (repo: string, sessions: Array<{ address: string; cwd: string }> = []) =>
  (await worktreeRows(repo, sessions)).map((row) => row.verdict);

describe("parseLsof", () => {
  it("reads pid, command, fd and name fields", () => {
    expect(parseLsof("p12\ncnode\nfcwd\nn/a\nftxt\nn/b\np13\ncsh\nn/c\n")).toEqual([
      { pid: "12", command: "node", fd: "cwd", path: "/a" },
      { pid: "12", command: "node", fd: "txt", path: "/b" },
      { pid: "13", command: "sh", fd: "", path: "/c" },
    ]);
  });
});

const LAUNCHD = "/Users/u/.local/bin/hc --hc-launchd /tmp/hc-launchd-54939-17954-72c8/ready";
const HOLD =
  "/Users/u/.local/share/herdr-core/active/Herdr Core.app/Contents/MacOS/herdr-core hold --socket /Users/u/.local/state/herdr-core/default/default.holder.21004f95.sock";

describe("herdrCorePids", () => {
  it("names the launchd server, its ssh children, hold and connect, and leaves the rest", () => {
    const held = [
      { pid: "10", command: "hc", fd: "cwd", path: "/gone" },
      { pid: "11", command: "ssh", fd: "cwd", path: "/gone" },
      { pid: "12", command: "herdr-core", fd: "cwd", path: "/gone" },
      { pid: "13", command: "herdr-core", fd: "cwd", path: "/gone" },
      { pid: "14", command: "zsh", fd: "cwd", path: "/gone" },
      { pid: "15", command: "hc", fd: "cwd", path: "/gone" },
      { pid: "16", command: "node", fd: "cwd", path: "/gone" },
    ];
    const rows = parsePs(
      ps([
        [10, 1, LAUNCHD],
        [11, 10, "ssh -T strix sh -c 'exec herdr-core connect'"],
        [12, 10, HOLD],
        [13, 9, "/Users/u/.local/bin/herdr-core connect"],
        [14, 12, "/bin/zsh"],
        [15, 14, "hc wait t1 --timeout 60"],
        [16, 14, "node server.js --hc-launchd"],
      ]),
    );
    expect([...herdrCorePids(held, rows)].toSorted()).toEqual(["10", "11", "12", "13"]);
  });
});

const deletedFolderRows = async (lsof: string, psText: string, endedName?: string) => {
  const repo = track(initRepo());
  const root = join(repo, ".claude", "worktrees");
  mkdirSync(root, { recursive: true });
  const gone = join(real(root), "gone");
  const state = track(tempDir());
  if (endedName) {
    mkdirSync(join(state, "ended"), { recursive: true });
    writeFileSync(
      join(state, "ended", `${endedName}.json`),
      endedRecord(endedName, gone, "0123456789abcdef0123456789abcdef01234567"),
    );
  }
  const fake = gitAndFake((argv) => {
    if (argv[0] === "lsof") return ok(lsof.replaceAll("<gone>", gone));
    if (argv[0] === "ps") return ok(psText);
    return fakes()(argv);
  });
  const all = await runWith(
    report(await config(state), [repo], {
      bases: [],
      keep: [],
      sizes: false,
      nowMs: Date.now(),
    }),
    fake.layer,
  );
  const rows = all.filter((row) => row.text.startsWith("processes in deleted folder"));
  return {
    gone,
    fake,
    found: rows,
    rows: rows.map((row) => [row.verdict, row.text]),
  };
};

describe("report processes in deleted folders", () => {
  it("offers to kill a stray dev server but never Herdr core", async () => {
    const { gone, rows } = await deletedFolderRows(
      "p10\nchc\nn<gone>\np11\ncssh\nn<gone>\np12\ncherdr-core\nn<gone>\np16\ncnode\nn<gone>/web\n",
      ps([
        [10, 1, LAUNCHD],
        [11, 10, "ssh -T strix"],
        [12, 10, HOLD],
        [16, 12, "node server.js"],
      ]),
    );
    expect(rows).toEqual([
      ["SAFE", `processes in deleted folder ${gone}: 16 node · stop them: kill 16`],
    ]);
  });

  it("lists no row when only Herdr core holds the deleted folder", async () => {
    const { rows } = await deletedFolderRows(
      "p10\nchc\nn<gone>\np12\ncherdr-core\nn<gone>\n",
      ps([
        [10, 1, LAUNCHD],
        [12, 10, HOLD],
      ]),
    );
    expect(rows).toEqual([]);
  });
});

describe("report", () => {
  it("sees a squash-merged worktree under .claude/worktrees as SAFE", async () => {
    const { repo } = repoWithWorktree();
    squashIntoMain(repo);
    expect(await verdicts(repo)).toEqual(["SAFE"]);
  });

  it("keeps a live worktree with no commits and labels it no commits yet", async () => {
    const { repo, wt } = repoWithEmptyWorktree();
    expect((await worktreeRows(repo)).map((row) => [row.verdict, row.text])).toEqual([
      ["KEEP", `worktree ${wt} [x] PRs unknown: no remote · no commits yet`],
    ]);
  });

  it("asks about a worktree whose folder is gone, naming it gone", async () => {
    const { repo, wt } = repoWithEmptyWorktree();
    rmSync(wt, { recursive: true, force: true });
    expect((await worktreeRows(repo)).map((row) => [row.verdict, row.text])).toEqual([
      ["ASK", `worktree ${wt} [x] PRs unknown: no remote · no commits yet · folder gone here`],
    ]);
  });

  it("asks about an unpushed, unlanded commit", async () => {
    const { repo } = repoWithWorktree();
    expect(await verdicts(repo)).toEqual(["ASK"]);
  });

  it("asks about a dirty worktree, and keeps one a session runs in", async () => {
    const { repo, wt } = repoWithWorktree();
    squashIntoMain(repo);
    writeFileSync(join(wt, "feature.txt"), "edited\n");
    expect(await verdicts(repo)).toEqual(["ASK"]);
    expect(await verdicts(repo, [{ address: "t2", cwd: wt }])).toEqual(["KEEP"]);
  });

  it("closes a finished worktree whose session still runs", async () => {
    const { repo, wt } = repoWithWorktree();
    squashIntoMain(repo);
    expect(await verdicts(repo, [{ address: "t2", cwd: wt }])).toEqual(["CLOSE"]);
  });

  it("marks an ended clean worktree with no commits SAFE", async () => {
    const { repo, wt } = repoWithEmptyWorktree();
    expect(
      (await worktreeRows(repo, [], { cwd: wt, branch: "x" })).map((row) => [
        row.verdict,
        row.text,
      ]),
    ).toEqual([
      [
        "SAFE",
        `worktree ${wt} [x] PRs unknown: no remote · no commits (nothing to land) · ended delegate record`,
      ],
    ]);
  });

  it("asks before sweeping an ended worktree with uncommitted files", async () => {
    const { repo, wt } = repoWithEmptyWorktree();
    writeFileSync(join(wt, "unfinished.txt"), "unfinished\n");
    expect(
      (await worktreeRows(repo, [], { cwd: wt, branch: "x" })).map((row) => [
        row.verdict,
        row.text,
      ]),
    ).toEqual([
      [
        "ASK",
        `worktree ${wt} [x] PRs unknown: no remote · no commits (nothing to land) · 1 uncommitted · ended delegate record`,
      ],
    ]);
  });

  it("keeps an ended empty worktree while a session still runs there", async () => {
    const { repo, wt } = repoWithEmptyWorktree();
    expect(
      (await worktreeRows(repo, [{ address: "t2", cwd: wt }], { cwd: wt, branch: "x" })).map(
        (row) => [row.verdict, row.text],
      ),
    ).toEqual([
      [
        "KEEP",
        `worktree ${wt} [x] PRs unknown: no remote · no commits (nothing to land) · session t2 in "no tab" · ended delegate record`,
      ],
    ]);
  });

  it("keeps an ended empty worktree while a process still runs there", async () => {
    const { repo, wt } = repoWithEmptyWorktree();
    expect(
      (await worktreeRows(repo, [], { cwd: wt, branch: "x" }, wt)).map((row) => [
        row.verdict,
        row.text,
      ]),
    ).toEqual([
      [
        "KEEP",
        `worktree ${wt} [x] PRs unknown: no remote · no commits (nothing to land) · processes: 1 node · ended delegate record`,
      ],
    ]);
  });
});

describe("remove", () => {
  it("drops .devenv, parks .scratch, and quietly keeps the squash branch", async () => {
    const { repo, wt } = repoWithWorktree();
    squashIntoMain(repo);
    mkdirSync(join(wt, ".devenv", "state"), { recursive: true });
    writeFileSync(join(wt, ".devenv", "state", "x"), "x");
    mkdirSync(join(wt, ".scratch"), { recursive: true });
    writeFileSync(join(wt, ".scratch", "REPORT.md"), "report\n");
    const cfg = await config(track(tempDir()));
    const fake = gitAndFake(fakes());
    const lines = await runWith(
      Effect.flatMap(context(cfg, [repo], [], []), (ctx) => removeMany(cfg, [wt], ctx, STOP)),
      fake.layer,
    );
    expect(lines[0]).toBe(`removed worktree ${wt}`);
    expect(lines[1]).toBe(`  parked .scratch in ${join(repo, ".scratch", "parked", "x")}`);
    expect(lines[2]).toBe("  dropped build output: .devenv");
    expect(lines[3]).toBe(`  kept branch x ${g(repo, "rev-parse", "--short", "x")}`);
    expect(lines.at(-1)).toBe("removed 1 of 1");
    expect(existsSync(wt)).toBe(false);
    expect(
      readFileSync(join(repo, ".scratch", "parked", "x", ".scratch", "REPORT.md"), "utf8"),
    ).toBe("report\n");
    expect(g(repo, "branch", "--list", "x")).toBe("x");
  });

  it("refuses anything but SAFE", async () => {
    const { repo, wt } = repoWithWorktree();
    const cfg = await config(track(tempDir()));
    const fake = gitAndFake(fakes());
    const lines = await runWith(
      Effect.flatMap(context(cfg, [repo], [], []), (ctx) => removeMany(cfg, [wt], ctx, STOP)),
      fake.layer,
    );
    expect(lines[0]?.startsWith(`kept ${wt}: ASK,`)).toBe(true);
    expect(lines.at(-1)?.startsWith("removed 0 of 1; 1 kept because: ")).toBe(true);
    expect(existsSync(wt)).toBe(true);
  });

  it("deletes a fast-forwarded branch with -d and leaves a GIT_DIR decoy untouched", async () => {
    const decoy = track(initRepo());
    const { repo, wt } = repoWithWorktree();
    g(repo, "merge", "-q", "--ff-only", "x");
    const cfg = await config(track(tempDir()));
    const fake = gitAndFake(fakes());
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = join(decoy, ".git");
    let lines: string[] = [];
    try {
      lines = await runWith(
        Effect.flatMap(context(cfg, [repo], [], []), (ctx) => removeMany(cfg, [wt], ctx, STOP)),
        fake.layer,
      );
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
    expect(lines.some((line) => line.startsWith("  deleted branch x "))).toBe(true);
    expect(g(decoy, "rev-list", "--count", "HEAD")).toBe("1");
    expect(g(decoy, "worktree", "list").split("\n").length).toBe(1);
  });
});

describe("pruneBranches", () => {
  it("lists a squash-landed branch and keeps it when -d refuses", async () => {
    const { repo, wt } = repoWithWorktree();
    squashIntoMain(repo);
    g(repo, "worktree", "remove", wt);
    const cfg = await config(track(tempDir()));
    const fake = gitAndFake(fakes());
    const run = (branches: string[], list: boolean) =>
      runWith(
        Effect.flatMap(context(cfg, [repo], [], []), (ctx) =>
          pruneBranches(repo, branches, list, ctx),
        ),
        fake.layer,
      );
    const rows = await runWith(
      report(cfg, [repo], { bases: [], keep: [], sizes: false, nowMs: Date.now() }),
      fake.layer,
    );
    expect(rows.map((row) => [row.verdict, row.text])).toEqual([
      ["INFO", `1 landed branches kept in ${repo}`],
      ["INFO", `PRs for ${repo} unknown: no remote`],
    ]);
    const listed = await run([], true);
    expect(listed.length).toBe(1);
    // One squashed commit carries the same patch as the branch's one commit, so git cherry sees it first.
    expect(listed[0]?.endsWith("on base (rebase)")).toBe(true);
    const deleted = await run(["x"], false);
    const sha = g(repo, "rev-parse", "--short", "x");
    expect(deleted).toEqual([`kept x ${sha}: git branch -d refused (on base (rebase))`]);
  });
});

const endedRecord = (name: string, cwd: string, baseSha: string | null = null) =>
  JSON.stringify({
    name,
    domain: "app",
    session: name,
    cwd,
    ended_at: "2026-11-16T00:00:00Z",
    repo: null,
    branch: null,
    base_sha: baseSha,
  });

const named = (name: string, cwd: string, machine: string) =>
  JSON.stringify({ ...JSON.parse(endedRecord(name, cwd)), machine });

describe("pruneEnded", () => {
  it("prunes records whose folder is gone, PRs or not", async () => {
    const state = track(tempDir());
    mkdirSync(join(state, "ended"), { recursive: true });
    writeFileSync(join(state, "ended", "gone.json"), endedRecord("gone", "/nonexistent/folder"));
    writeFileSync(join(state, "ended", "here.json"), endedRecord("here", state));
    const lines = await runWith(pruneEnded(await config(state)));
    expect(lines).toEqual(["pruned 1 of 2 ended records whose folder is gone", "  gone"]);
    expect(existsSync(join(state, "ended", "here.json"))).toBe(true);
  });

  it("keeps a remote record whose machine does not answer, and judges this core's by its disk", async () => {
    const state = track(tempDir());
    mkdirSync(join(state, "ended"), { recursive: true });
    writeFileSync(
      join(state, "ended", "local.json"),
      named("local", "/nonexistent/a", "fake-core"),
    );
    writeFileSync(join(state, "ended", "r1.json"), named("r1", "/nonexistent/b", "strix"));
    writeFileSync(join(state, "ended", "r2.json"), named("r2", "/nonexistent/c", "strix"));
    const fake = gitAndFake((argv) =>
      argv[1] === "exec"
        ? { exitCode: 1, stdout: "", stderr: "machine strix is not connected" }
        : ok(""),
    );
    const lines = await runWith(pruneEnded(await config(state)), fake.layer);
    expect(lines).toEqual([
      "pruned 1 of 3 ended records whose folder is gone",
      "  local",
      "  folder unknown, left in place: r1 (strix did not answer), r2 (strix did not answer)",
    ]);
    expect(fake.calls.filter((argv) => argv[1] === "exec").length).toBe(1);
    expect(
      ["local", "r1", "r2"].map((name) => existsSync(join(state, "ended", `${name}.json`))),
    ).toEqual([false, true, true]);
  });
});

/**
 * State holding one ended record for `cwd`; with `coordinateMade`, as `delegate --repo` records it (a creation
 * base), otherwise as for a --cwd or attached delegate (none).
 */
const endedState = (cwd: string, coordinateMade = true): string => {
  const state = track(tempDir());
  mkdirSync(join(state, "ended"), { recursive: true });
  writeFileSync(
    join(state, "ended", "fix-a.json"),
    endedRecord("fix-a", cwd, coordinateMade ? g(cwd, "rev-parse", "HEAD~1") : null),
  );
  return state;
};

describe("ended delegate processes", () => {
  it("removes a landed worktree after stopping the processes its ended delegate left", async () => {
    const { repo, wt } = repoWithWorktree();
    squashIntoMain(repo);
    const machine = processMachine(
      [
        { pid: 20, ppid: 1, args: "sh -c pnpm dev", cwd: real(wt) },
        { pid: 21, ppid: 20, args: "node wrangler dev", cwd: join(real(wt), "apps") },
      ],
      {},
      fakes(),
    );
    const cfg = await config(endedState(wt));
    const fake = gitAndFake(machine.answer);
    const rows = await runWith(
      report(cfg, [repo], { bases: [], keep: [], sizes: false, nowMs: Date.now() }),
      fake.layer,
    );
    expect(
      rows.filter((row) => row.path === real(wt)).map((row) => [row.verdict, row.text]),
    ).toEqual([
      [
        "SAFE",
        `worktree ${real(wt)} [x] PRs unknown: no remote · on base (rebase) · ended delegate's processes, sweep remove stops them: 20 sh; 21 node · ended delegate record`,
      ],
    ]);
    const lines = await runWith(
      Effect.flatMap(context(cfg, [repo], [], []), (ctx) => removeMany(cfg, [wt], ctx, STOP)),
      fake.layer,
    );
    expect(lines.slice(0, 3)).toEqual([
      `removed worktree ${real(wt)}`,
      "  stopped 20 sh -c pnpm dev",
      "  stopped 21 node wrangler dev",
    ]);
    expect(machine.kills).toEqual([["kill", "-TERM", "20", "21"]]);
    expect(existsSync(wt)).toBe(false);
  });

  it("still asks about a process a live terminal runs in an ended delegate's worktree", async () => {
    const { repo, wt } = repoWithWorktree();
    squashIntoMain(repo);
    const machine = processMachine(
      [
        { pid: 5, ppid: 1, args: HOLD, cwd: "/" },
        { pid: 60, ppid: 5, args: "sh preview", cwd: real(wt) },
      ],
      {},
      fakes(),
    );
    const cfg = await config(endedState(wt));
    const fake = gitAndFake((argv) => {
      const out = machine.answer(argv);
      return argv[0] === "lsof"
        ? { ...out, stdout: out.stdout.replace(/^c\/Users\/u\/.*$/m, "cherdr-core") }
        : out;
    });
    const lines = await runWith(
      Effect.flatMap(context(cfg, [repo], [], []), (ctx) => removeMany(cfg, [wt], ctx, STOP)),
      fake.layer,
    );
    expect(lines[0]).toBe(
      `kept ${real(wt)}: ASK, [x] PRs unknown: no remote · on base (rebase) · processes: 60 sh · ended delegate record`,
    );
    expect(machine.kills).toEqual([]);
    expect(existsSync(wt)).toBe(true);
  });

  it("still asks about an orphan unless coordinate made the worktree for a delegate that ended", async () => {
    for (const state of [() => track(tempDir()), (wt: string) => endedState(wt, false)]) {
      const { repo, wt } = repoWithWorktree();
      squashIntoMain(repo);
      const machine = processMachine(
        [{ pid: 20, ppid: 1, args: "pnpm dev", cwd: real(wt) }],
        {},
        fakes(),
      );
      const cfg = await config(state(wt));
      const fake = gitAndFake(machine.answer);
      const lines = await runWith(
        Effect.flatMap(context(cfg, [repo], [], []), (ctx) => removeMany(cfg, [wt], ctx, STOP)),
        fake.layer,
      );
      expect(lines[0]?.startsWith(`kept ${real(wt)}: ASK,`)).toBe(true);
      expect(lines[0]?.includes("processes: 20 pnpm")).toBe(true);
      expect(machine.kills).toEqual([]);
      expect(existsSync(wt)).toBe(true);
    }
  });

  it("keeps the worktree when a process outlives SIGKILL", async () => {
    const { repo, wt } = repoWithWorktree();
    squashIntoMain(repo);
    const machine = processMachine(
      [{ pid: 20, ppid: 1, args: "bun stubborn.ts", cwd: real(wt) }],
      { TERM: [20], KILL: [20] },
      fakes(),
    );
    const cfg = await config(endedState(wt));
    const fake = gitAndFake(machine.answer);
    const lines = await runWith(
      Effect.flatMap(context(cfg, [repo], [], []), (ctx) => removeMany(cfg, [wt], ctx, STOP)),
      fake.layer,
    );
    expect(lines.slice(0, 2)).toEqual([
      `kept ${real(wt)}: 1 of its ended delegate's processes still run`,
      "  could not stop 20 bun stubborn.ts: still running after SIGKILL",
    ]);
    expect(existsSync(wt)).toBe(true);
  });

  it("signals only an ended delegate's own processes in its deleted folder", async () => {
    const { gone, found, rows, fake } = await deletedFolderRows(
      "p20\ncnode\nfcwd\nn<gone>\np30\ncnode\nfcwd\nn<gone>\np31\nczsh\nfcwd\nn/\n",
      ps([
        [20, 1, "node dev"],
        [31, 1, "zsh"],
        [30, 31, "node other"],
      ]),
      "fix-a",
    );
    expect(rows).toEqual([
      [
        "SAFE",
        `processes in deleted folder ${gone}: 20 node, 30 node · stop them: kill 20 30 · an ended delegate's: sweep remove --all-safe stops them`,
      ],
    ]);
    const lines = await runWith(stopDeletedFolders(found, STOP), fake.layer);
    expect(lines).toEqual([
      `ended delegate's processes in deleted folder ${gone}:`,
      "  could not stop 20 node dev: still running after SIGKILL",
    ]);
    expect(fake.calls.filter((argv) => argv[0] === "kill")).toEqual([
      ["kill", "-TERM", "20"],
      ["kill", "-KILL", "20"],
    ]);
  });
});
