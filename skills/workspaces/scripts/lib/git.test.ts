import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  currentBranch,
  isDirty,
  isGitRepo,
  listStacks,
  runGitAllowEmpty,
  trackedWorkflowArtifacts,
} from "./git.ts";

const created: string[] = [];

const makeRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "workspaces-git-"));
  created.push(dir);
  const init = Bun.spawnSync(["git", "init", "-q", "-b", "main", dir]);
  expect(init.exitCode).toBe(0);
  const configureUser = Bun.spawnSync([
    "git",
    "-C",
    dir,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-q",
    "-m",
    "init",
  ]);
  expect(configureUser.exitCode).toBe(0);
  return dir;
};

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("repo state helpers", () => {
  it("reports repo membership, branch, and cleanliness", () => {
    const repo = makeRepo();
    expect(isGitRepo(repo)).toBe(true);
    expect(Effect.runSync(currentBranch(repo))).toBe("main");
    expect(Effect.runSync(isDirty(repo))).toBe(false);

    writeFileSync(join(repo, "untracked.txt"), "content\n");
    expect(Effect.runSync(isDirty(repo))).toBe(true);
  });

  it("treats a plain directory as not a repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "workspaces-plain-"));
    created.push(dir);
    expect(isGitRepo(dir)).toBe(false);
  });
});

describe("runGitAllowEmpty", () => {
  it("returns empty output when a config regexp matches nothing", () => {
    const repo = makeRepo();
    expect(Effect.runSync(runGitAllowEmpty(repo, ["config", "--get-regexp", "^stack\\."]))).toBe(
      "",
    );
  });
});

describe("listStacks", () => {
  it("returns an empty list for a repo without stacks", () => {
    const repo = makeRepo();
    expect(Effect.runSync(listStacks(repo))).toEqual([]);
  });

  it("parses stacked-prs git config into stacks", () => {
    const repo = makeRepo();
    const config = (key: string, value: string) => {
      const result = Bun.spawnSync(["git", "-C", repo, "config", key, value]);
      expect(result.exitCode).toBe(0);
    };
    config("stack.cw/feature.base-branch", "main");
    config("stack.cw/feature.merge-strategy", "squash");
    config("stack.other.base-branch", "main");
    config("branch.cw/feature-1.stack-name", "cw/feature");
    config("branch.cw/feature-2.stack-name", "cw/feature");
    config("stack.default-merge-strategy", "squash");

    expect(Effect.runSync(listStacks(repo))).toEqual([
      {
        name: "cw/feature",
        baseBranch: "main",
        mergeStrategy: "squash",
        archived: false,
        branches: ["cw/feature-1", "cw/feature-2"],
      },
      {
        name: "other",
        baseBranch: "main",
        mergeStrategy: undefined,
        archived: false,
        branches: [],
      },
    ]);
  });
});

describe("trackedWorkflowArtifacts", () => {
  it("lists committed workflow runtime files", () => {
    const repo = makeRepo();
    mkdirSync(join(repo, ".claude", "worktrees"), { recursive: true });
    writeFileSync(join(repo, ".claude", "worktrees", "leak.txt"), "leak\n");
    const add = Bun.spawnSync(["git", "-C", repo, "add", "-f", ".claude/worktrees/leak.txt"]);
    expect(add.exitCode).toBe(0);
    const commit = Bun.spawnSync([
      "git",
      "-C",
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-q",
      "-m",
      "leak",
    ]);
    expect(commit.exitCode).toBe(0);

    expect(Effect.runSync(trackedWorkflowArtifacts(repo))).toEqual([".claude/worktrees/leak.txt"]);
  });

  it("returns an empty list for a clean member", () => {
    const repo = makeRepo();
    expect(Effect.runSync(trackedWorkflowArtifacts(repo))).toEqual([]);
  });
});
