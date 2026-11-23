import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { resolveConfig } from "./config.ts";
import { commitFile, g, gitAndFake, initRepo, runWith, tempDir } from "./fixture.ts";
import { ok, type RunOutput } from "./proc.ts";
import { real } from "./git.ts";
import {
  context,
  herdrCorePids,
  parseLsof,
  parsePs,
  pruneBranches,
  pruneEnded,
  removeMany,
  report,
} from "./sweep.ts";

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
  it("reads pid, command and name fields", () => {
    expect(parseLsof("p12\ncnode\nn/a\nn/b\np13\ncsh\nn/c\n")).toEqual([
      { pid: "12", command: "node", path: "/a" },
      { pid: "12", command: "node", path: "/b" },
      { pid: "13", command: "sh", path: "/c" },
    ]);
  });
});

const LAUNCHD = "/Users/u/.local/bin/hc --hc-launchd /tmp/hc-launchd-54939-17954-72c8/ready";
const HOLD =
  "/Users/u/.local/share/herdr-core/active/Herdr Core.app/Contents/MacOS/herdr-core hold --socket /Users/u/.local/state/herdr-core/default/default.holder.21004f95.sock";

describe("herdrCorePids", () => {
  it("names the launchd server, its ssh children, hold and connect, and leaves the rest", () => {
    const held = [
      { pid: "10", command: "hc", path: "/gone" },
      { pid: "11", command: "ssh", path: "/gone" },
      { pid: "12", command: "herdr-core", path: "/gone" },
      { pid: "13", command: "herdr-core", path: "/gone" },
      { pid: "14", command: "zsh", path: "/gone" },
      { pid: "15", command: "hc", path: "/gone" },
      { pid: "16", command: "node", path: "/gone" },
    ];
    const ps = parsePs(
      [
        `   10     1 ${LAUNCHD}`,
        "   11    10 ssh -T strix sh -c 'exec herdr-core connect'",
        `   12    10 ${HOLD}`,
        "   13     9 /Users/u/.local/bin/herdr-core connect",
        "   14    12 /bin/zsh",
        "   15    14 hc wait t1 --timeout 60",
        "   16    14 node server.js --hc-launchd",
        "",
      ].join("\n"),
    );
    expect([...herdrCorePids(held, ps)].toSorted()).toEqual(["10", "11", "12", "13"]);
  });
});

const deletedFolderRows = async (lsof: string, ps: string) => {
  const repo = track(initRepo());
  const root = join(repo, ".claude", "worktrees");
  mkdirSync(root, { recursive: true });
  const gone = join(real(root), "gone");
  const fake = gitAndFake((argv) => {
    if (argv[0] === "lsof") return ok(lsof.replaceAll("<gone>", gone));
    if (argv[0] === "ps") return ok(ps);
    return fakes()(argv);
  });
  const rows = await runWith(
    report(await config(track(tempDir())), [repo], {
      bases: [],
      keep: [],
      sizes: false,
      nowMs: Date.now(),
    }),
    fake.layer,
  );
  return {
    gone,
    rows: rows
      .filter((row) => row.text.startsWith("processes in deleted folder"))
      .map((row) => [row.verdict, row.text]),
  };
};

describe("report processes in deleted folders", () => {
  it("offers to kill a stray dev server but never Herdr core", async () => {
    const { gone, rows } = await deletedFolderRows(
      "p10\nchc\nn<gone>\np11\ncssh\nn<gone>\np12\ncherdr-core\nn<gone>\np16\ncnode\nn<gone>/web\n",
      `10 1 ${LAUNCHD}\n11 10 ssh -T strix\n12 10 ${HOLD}\n16 12 node server.js\n`,
    );
    expect(rows).toEqual([
      ["SAFE", `processes in deleted folder ${gone}: 16 node · stop them: kill 16`],
    ]);
  });

  it("lists no row when only Herdr core holds the deleted folder", async () => {
    const { rows } = await deletedFolderRows(
      "p10\nchc\nn<gone>\np12\ncherdr-core\nn<gone>\n",
      `10 1 ${LAUNCHD}\n12 10 ${HOLD}\n`,
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
  it("drops .devenv, parks .scratch, keeps the squash branch with the -D command for the user", async () => {
    const { repo, wt } = repoWithWorktree();
    squashIntoMain(repo);
    mkdirSync(join(wt, ".devenv", "state"), { recursive: true });
    writeFileSync(join(wt, ".devenv", "state", "x"), "x");
    mkdirSync(join(wt, ".scratch"), { recursive: true });
    writeFileSync(join(wt, ".scratch", "REPORT.md"), "report\n");
    const cfg = await config(track(tempDir()));
    const fake = gitAndFake(fakes());
    const lines = await runWith(
      Effect.flatMap(context(cfg, [repo], [], []), (ctx) => removeMany(cfg, [wt], ctx)),
      fake.layer,
    );
    expect(lines[0]).toBe(`removed worktree ${wt}`);
    expect(lines[1]).toBe(`  parked .scratch in ${join(repo, ".scratch", "parked", "x")}`);
    expect(lines[2]).toBe("  dropped build output: .devenv");
    expect(lines[3]?.endsWith(`the user runs: cd ${repo} && git branch -D x`)).toBe(true);
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
      Effect.flatMap(context(cfg, [repo], [], []), (ctx) => removeMany(cfg, [wt], ctx)),
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
        Effect.flatMap(context(cfg, [repo], [], []), (ctx) => removeMany(cfg, [wt], ctx)),
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
  it("lists a squash-landed branch and prints -D when -d refuses", async () => {
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
    const listed = await run([], true);
    expect(listed.length).toBe(1);
    // One squashed commit carries the same patch as the branch's one commit, so git cherry sees it first.
    expect(listed[0]?.endsWith("on base (rebase)")).toBe(true);
    const deleted = await run(["x"], false);
    expect(deleted[0]?.endsWith(`the user runs: cd ${repo} && git branch -D x`)).toBe(true);
  });
});

const endedRecord = (name: string, cwd: string) =>
  JSON.stringify({
    name,
    domain: "app",
    session: name,
    cwd,
    ended_at: "2026-11-16T00:00:00Z",
    repo: null,
    branch: null,
  });

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
});
