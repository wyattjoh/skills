import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitFile, g, initRepo, runWith, tempDir } from "./fixture.ts";
import {
  branchCreationBase,
  excludeScratch,
  hasCommitsSince,
  landedOn,
  mainCheckout,
  neverCommitted,
  parseWorktrees,
  unsavedCommits,
} from "./git.ts";

const made: string[] = [];
const repo = (): string => {
  const path = initRepo();
  made.push(path);
  return path;
};
afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true });
});

describe("parseWorktrees", () => {
  it("reads branches and detached heads", () => {
    expect(
      parseWorktrees(
        "worktree /r\nHEAD aaa\nbranch refs/heads/main\n\nworktree /r/.claude/worktrees/x\nHEAD bbb\ndetached\n",
      ),
    ).toEqual([
      { path: "/r", branch: "main", head: "aaa" },
      { path: "/r/.claude/worktrees/x", branch: undefined, head: "bbb" },
    ]);
  });
});

describe("landedOn", () => {
  it("sees a fast-forwarded branch as an ancestor", async () => {
    const r = repo();
    g(r, "checkout", "-q", "-b", "ff");
    commitFile(r, "a.txt", "a\n");
    g(r, "checkout", "-q", "main");
    g(r, "merge", "-q", "--ff-only", "ff");
    expect(await runWith(landedOn(r, "ff", ["main"]))).toBe("ancestor");
  });

  it("sees a rebase merge through git cherry", async () => {
    const r = repo();
    g(r, "checkout", "-q", "-b", "rb");
    commitFile(r, "a.txt", "a\n");
    g(r, "checkout", "-q", "main");
    commitFile(r, "other.txt", "o\n");
    g(r, "cherry-pick", "rb");
    expect(await runWith(landedOn(r, "rb", ["main"]))).toBe("rebase");
  });

  it("sees a squash merge", async () => {
    const r = repo();
    g(r, "checkout", "-q", "-b", "sq");
    commitFile(r, "a.txt", "a\n");
    commitFile(r, "b.txt", "b\n");
    g(r, "checkout", "-q", "main");
    commitFile(r, "other.txt", "o\n");
    g(r, "merge", "-q", "--squash", "sq");
    g(r, "-c", "user.name=T", "-c", "user.email=t@e", "commit", "-q", "-m", "squash sq");
    expect(await runWith(landedOn(r, "sq", ["main"]))).toBe("squash");
  });

  it("does not call an empty branch landed", async () => {
    const r = repo();
    g(r, "branch", "fresh", "main");
    expect(await runWith(branchCreationBase(r, "fresh"))).toBe(g(r, "rev-parse", "main"));
    expect(await runWith(hasCommitsSince(r, "fresh", undefined))).toBe(false);
    expect(await runWith(landedOn(r, "fresh", ["main"]))).toBe(undefined);
  });

  it("reports unlanded work as undefined", async () => {
    const r = repo();
    g(r, "checkout", "-q", "-b", "wip");
    commitFile(r, "a.txt", "a\n");
    expect(await runWith(landedOn(r, "wip", ["main"]))).toBe(undefined);
    expect(await runWith(neverCommitted(r, "wip"))).toBe(false);
    g(r, "branch", "fresh", "main");
    expect(await runWith(neverCommitted(r, "fresh"))).toBe(true);
  });
});

describe("unsavedCommits", () => {
  it("counts commits on no remote or base", async () => {
    const r = repo();
    g(r, "checkout", "-q", "-b", "wip");
    commitFile(r, "a.txt", "a\n");
    expect(await runWith(unsavedCommits(r, ["main"]))).toBe(1);
  });
});

describe("excludeScratch", () => {
  it("adds .scratch/ to info/exclude once, from a linked worktree", async () => {
    const r = repo();
    const wt = join(r, ".claude", "worktrees", "x");
    g(r, "worktree", "add", "-q", wt, "-b", "x");
    expect(await runWith(excludeScratch(wt))).toBe(true);
    expect(await runWith(excludeScratch(wt))).toBe(false);
    expect(readFileSync(join(r, ".git", "info", "exclude"), "utf8").endsWith(".scratch/\n")).toBe(
      true,
    );
    expect(await runWith(mainCheckout(wt))).toBe(r);
  });
});

describe("GIT_DIR decoy", () => {
  it("leaves a repository named by GIT_DIR untouched", async () => {
    const decoy = repo();
    const target = repo();
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = join(decoy, ".git");
    try {
      g(target, "checkout", "-q", "-b", "wip");
      writeFileSync(join(target, "x.txt"), "x\n");
      g(target, "add", "x.txt");
      g(target, "commit", "-q", "-m", "x");
      expect(await runWith(unsavedCommits(target, ["main"]))).toBe(1);
      expect(await runWith(excludeScratch(target))).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
    expect(g(decoy, "rev-list", "--count", "HEAD")).toBe("1");
    expect(g(decoy, "branch", "--list")).toBe("* main");
    expect(readFileSync(join(decoy, ".git", "info", "exclude"), "utf8").includes(".scratch/")).toBe(
      false,
    );
  });
});

describe("tempDir", () => {
  it("is a real path", () => {
    const dir = tempDir();
    made.push(dir);
    expect(dir.startsWith("/")).toBe(true);
  });
});
