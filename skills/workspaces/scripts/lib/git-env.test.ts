import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanGitEnv, spawnGit } from "./git-env.ts";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

const commitCount = (repo: string): string =>
  spawnGit(["-C", repo, "rev-list", "--count", "HEAD"]).stdout.trim();

const treePaths = (repo: string): string =>
  spawnGit(["-C", repo, "ls-tree", "-r", "--name-only", "HEAD"]).stdout.trim();

describe("cleanGitEnv", () => {
  it("drops every repository-location variable and keeps the rest", () => {
    const env = {
      PATH: "/usr/bin",
      HOME: "/home/test",
      GIT_AUTHOR_NAME: "Test",
      GIT_DIR: "/decoy/.git",
      GIT_WORK_TREE: "/decoy",
      GIT_INDEX_FILE: "/decoy/.git/index",
      GIT_COMMON_DIR: "/decoy/.git",
      GIT_OBJECT_DIRECTORY: "/decoy/.git/objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/decoy/.git/objects",
      GIT_CEILING_DIRECTORIES: "/",
    };

    expect(cleanGitEnv(env)).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/test",
      GIT_AUTHOR_NAME: "Test",
    });
  });

  it("omits keys whose value is undefined", () => {
    expect(cleanGitEnv({ PATH: "/usr/bin", EMPTY: undefined })).toEqual({ PATH: "/usr/bin" });
  });
});

describe("spawnGit under an inherited GIT_DIR", () => {
  it("initializes and commits into the named directory, leaving the decoy untouched", () => {
    const scratch = mkdtempSync(join(tmpdir(), "workspaces-git-env-"));
    created.push(scratch);
    const decoy = join(scratch, "decoy");
    const fixture = join(scratch, "fixture");
    mkdirSync(decoy);
    mkdirSync(fixture);

    expect(spawnGit(["init", "-q", "-b", "main", decoy]).exitCode).toBe(0);
    expect(
      spawnGit(["-C", decoy, ...identity, "commit", "-q", "--allow-empty", "-m", "init"]).exitCode,
    ).toBe(0);

    // Exactly what lefthook's pre-push hook hands to `bun test`.
    const poisoned = {
      ...process.env,
      GIT_DIR: join(decoy, ".git"),
      GIT_INDEX_FILE: join(decoy, ".git", "index"),
    };

    expect(spawnGit(["-C", fixture, "init", "-q", "-b", "main"], { env: poisoned }).exitCode).toBe(
      0,
    );
    writeFileSync(join(fixture, "a.txt"), "hello\n");
    expect(spawnGit(["-C", fixture, "add", "-A"], { env: poisoned }).exitCode).toBe(0);
    expect(
      spawnGit(["-C", fixture, ...identity, "commit", "-q", "-m", "seed"], { env: poisoned })
        .exitCode,
    ).toBe(0);

    expect(existsSync(join(fixture, ".git"))).toBe(true);
    expect(commitCount(fixture)).toBe("1");
    expect(treePaths(fixture)).toBe("a.txt");

    expect(commitCount(decoy)).toBe("1");
    expect(treePaths(decoy)).toBe("");
    expect(spawnGit(["-C", decoy, "status", "--porcelain"]).stdout).toBe("");
    expect(spawnGit(["-C", decoy, "config", "--get", "core.bare"]).stdout.trim()).toBe("false");
  });
});
