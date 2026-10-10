import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { type BeamOptions, beam } from "./beam.ts";
import { Remote } from "./remote.ts";
import { encodeProjectDir } from "./session.ts";

const SESSION = "0f0e0d0c-0b0a-4908-8706-050403020100";

let root = "";
let srcHome = "";
let dstHome = "";
let worktree = "";
let projects = "";

const git = (cwd: string, ...args: Array<string>): string => {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
};

const write = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

const run = (overrides: Partial<BeamOptions> = {}) =>
  beam({
    sessionId: SESSION,
    includes: [".scratch"],
    dryRun: false,
    force: false,
    allowLive: false,
    herdr: false,
    home: srcHome,
    ...overrides,
  }).pipe(
    Effect.provide(Layer.provideMerge(Remote.local(dstHome), BunServices.layer)),
    Effect.runPromise,
  );

beforeAll(() => {
  // Isolate from the developer's Git config (signing, hooks, aliases).
  process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  process.env["GIT_CONFIG_NOSYSTEM"] = "1";
  process.env["GIT_AUTHOR_NAME"] = process.env["GIT_COMMITTER_NAME"] = "test";
  process.env["GIT_AUTHOR_EMAIL"] = process.env["GIT_COMMITTER_EMAIL"] = "test@example.com";
  delete process.env["HERDR_ENV"];

  root = realpathSync(mkdtempSync(join(tmpdir(), "beam-me-up-")));
  srcHome = join(root, "src");
  dstHome = join(root, "dst");
  mkdirSync(dstHome, { recursive: true });

  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const repo = join(srcHome, "Code", "repo");
  git(root, "clone", "-q", origin, repo);
  write(join(repo, "a.txt"), "one\n");
  write(join(repo, ".gitignore"), ".scratch/\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "push", "-q", "origin", "HEAD:main");
  git(repo, "remote", "set-head", "origin", "main");

  // A linked worktree with an unpushed commit, staged and unstaged changes, and an ignored file.
  worktree = join(repo, ".claude", "worktrees", "feat+x");
  git(repo, "worktree", "add", "-q", "-b", "feat", worktree);
  write(join(worktree, "b.txt"), "unpushed\n");
  git(worktree, "add", "b.txt");
  git(worktree, "commit", "-q", "-m", "unpushed");
  write(join(worktree, "c.txt"), "staged\n");
  git(worktree, "add", "c.txt");
  write(join(worktree, "a.txt"), "one\ntwo\n");
  write(join(worktree, ".scratch", "notes.md"), "keep me\n");

  projects = join(srcHome, ".claude", "projects", encodeProjectDir(worktree));
  write(
    join(projects, `${SESSION}.jsonl`),
    [
      JSON.stringify({ type: "user", cwd: worktree, gitBranch: "feat" }),
      JSON.stringify({ type: "assistant", cwd: join(worktree, ".scratch"), gitBranch: "feat" }),
    ].join("\n") + "\n",
  );
  write(join(projects, SESSION, "subagents", "agent-1.jsonl"), "{}\n");
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

const dst = (path: string) => path.replace(srcHome, dstHome);
// The target's folder is named after the target's own worktree path.
const dstProjects = () => join(dstHome, ".claude", "projects", encodeProjectDir(dst(worktree)));

describe("beam", () => {
  it("plans without changing anything on --dry-run", async () => {
    const result = await run({ dryRun: true });
    expect(result).toMatchObject({
      dryRun: true,
      actions: { code: "create", includes: [".scratch"], session: "copy" },
    });
    expect(Bun.file(dst(worktree)).size).toBe(0);
  });

  it("recreates the worktree, ignored files and transcript, then verifies them", async () => {
    const result = await run();
    expect(result).toMatchObject({
      actions: { code: "create", session: "copy" },
      moved: { code: "branch and uncommitted changes" },
    });

    const target = dst(worktree);
    expect(git(target, "rev-parse", "HEAD")).toBe(git(worktree, "rev-parse", "HEAD"));
    expect(git(target, "symbolic-ref", "--short", "HEAD")).toBe("feat");
    expect(git(target, "diff", "--cached", "--name-only")).toBe("c.txt");
    expect(git(target, "diff", "--name-only")).toBe("a.txt");
    expect(readFileSync(join(target, ".scratch", "notes.md"), "utf8")).toBe("keep me\n");
    const transcript = join(dstProjects(), `${SESSION}.jsonl`);
    expect(readFileSync(transcript, "utf8")).toBe(
      readFileSync(join(projects, `${SESSION}.jsonl`), "utf8"),
    );
    expect(readFileSync(join(dstProjects(), SESSION, "subagents", "agent-1.jsonl"), "utf8")).toBe(
      "{}\n",
    );
    expect(git(join(srcHome, "Code", "repo"), "for-each-ref", "refs/beam-me-up")).toBe("");
  });

  it("is a no-op when run again", async () => {
    const result = await run();
    expect(result).toMatchObject({
      actions: { code: "in-sync", session: "in-sync" },
      moved: { code: "nothing" },
    });
  });

  it("refuses to overwrite a transcript that changed on the target unless forced", async () => {
    const transcript = join(dstProjects(), `${SESSION}.jsonl`);
    writeFileSync(transcript, `${readFileSync(transcript, "utf8")}{"cwd":"resumed"}\n`);
    await expect(run()).rejects.toThrow("Pass --force to overwrite it");

    const forced = await run({ force: true });
    expect(forced).toMatchObject({ actions: { session: "copy" } });
    expect(readFileSync(transcript, "utf8")).toBe(
      readFileSync(join(projects, `${SESSION}.jsonl`), "utf8"),
    );
  });

  it("refuses a target worktree with different uncommitted changes", async () => {
    write(join(dst(worktree), "a.txt"), "diverged\n");
    await expect(run()).rejects.toThrow("has different uncommitted changes");
  });
});
