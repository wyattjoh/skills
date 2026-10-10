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
    forceTranscript: false,
    forceIncludes: false,
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
  // Stray files beside the project folders (macOS drops .DS_Store) must not break lookup;
  // "!" sorts before "-" so readdir visits it first.
  write(join(srcHome, ".claude", "projects", "!stray"), "");
  write(join(srcHome, ".claude", "projects", ".DS_Store"), "");
  write(
    join(projects, `${SESSION}.jsonl`),
    [
      // Like a real session that started in the repository and moved into the worktree.
      JSON.stringify({ type: "user", cwd: repo, gitBranch: "main" }),
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

  it("re-syncs a session that kept going on the source without --force", async () => {
    const source = join(projects, `${SESSION}.jsonl`);
    writeFileSync(source, `${readFileSync(source, "utf8")}{"cwd":"${worktree}","more":1}\n`);
    const result = await run();
    expect(result).toMatchObject({ actions: { session: "copy", transcript: "behind" } });
    expect(readFileSync(join(dstProjects(), `${SESSION}.jsonl`), "utf8")).toBe(
      readFileSync(source, "utf8"),
    );
  });

  it("refuses to overwrite a transcript that gained turns on the target unless forced", async () => {
    const transcript = join(dstProjects(), `${SESSION}.jsonl`);
    writeFileSync(transcript, `${readFileSync(transcript, "utf8")}{"cwd":"resumed"}\n`);
    await expect(run()).rejects.toThrow("has turns this machine does not");

    const forced = await run({ forceTranscript: true });
    expect(forced).toMatchObject({ actions: { session: "copy" } });
    expect(readFileSync(transcript, "utf8")).toBe(
      readFileSync(join(projects, `${SESSION}.jsonl`), "utf8"),
    );
  });

  it("re-copies an included file edited only on the source", async () => {
    write(join(worktree, ".scratch", "notes.md"), "keep me\nedited here\n");
    const result = await run();
    expect(result).toMatchObject({ actions: { includeConflicts: [] } });
    expect(readFileSync(join(dst(worktree), ".scratch", "notes.md"), "utf8")).toBe(
      "keep me\nedited here\n",
    );
  });

  it("refuses to clobber included files edited or created on the target unless forced", async () => {
    write(join(dst(worktree), ".scratch", "notes.md"), "edited on target\n");
    write(join(dst(worktree), ".scratch", "new.md"), "created on target\n");
    await expect(run()).rejects.toThrow(
      "changed on local since the last move: .scratch/new.md, .scratch/notes.md",
    );

    await run({ forceIncludes: true });
    expect(readFileSync(join(dst(worktree), ".scratch", "notes.md"), "utf8")).toBe(
      "keep me\nedited here\n",
    );
    // Moves never delete; the target-only file stays and is recorded as target-only.
    expect(readFileSync(join(dst(worktree), ".scratch", "new.md"), "utf8")).toBe(
      "created on target\n",
    );
    expect(await run()).toMatchObject({ actions: { includeConflicts: [] } });

    // It is still protected once the source would overwrite it.
    write(join(worktree, ".scratch", "new.md"), "created on source\n");
    await expect(run()).rejects.toThrow("since the last move: .scratch/new.md");
    rmSync(join(worktree, ".scratch", "new.md"));
  });

  it("refuses a target worktree with different uncommitted changes", async () => {
    write(join(dst(worktree), "a.txt"), "diverged\n");
    await expect(run()).rejects.toThrow("has different uncommitted changes");
  });
});

describe("beam from a main checkout on a clean branch at its base", () => {
  const MAIN_SESSION = "2f0e0d0c-0b0a-4908-8706-050403020100";

  it("clones, checks out the session branch, and sends no bundle", async () => {
    const origin = join(root, "main-origin.git");
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    const repo = join(srcHome, "Code", "main-checkout");
    git(root, "clone", "-q", origin, repo);
    write(join(repo, "readme.md"), "hi\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    git(repo, "push", "-q", "origin", "HEAD:main");
    git(repo, "remote", "set-head", "origin", "main");
    // The session's branch has no commits of its own: HEAD equals the bundle base.
    git(repo, "checkout", "-q", "-b", "topic");
    write(
      join(srcHome, ".claude", "projects", encodeProjectDir(repo), `${MAIN_SESSION}.jsonl`),
      `${JSON.stringify({ cwd: repo, gitBranch: "topic" })}\n`,
    );

    const result = await run({ sessionId: MAIN_SESSION, includes: [] });
    expect(result).toMatchObject({
      actions: { repo: "clone", code: "create" },
      moved: { code: "branch" },
    });
    const target = dst(repo);
    expect(git(target, "symbolic-ref", "--short", "HEAD")).toBe("topic");
    expect(git(target, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "HEAD"));
    expect(git(target, "for-each-ref", "refs/beam-me-up")).toBe("");
    expect(await run({ sessionId: MAIN_SESSION, includes: [] })).toMatchObject({
      actions: { code: "in-sync", session: "in-sync" },
    });
  });
});

describe("beam from a repository with no remote", () => {
  const LOCAL_SESSION = "1f0e0d0c-0b0a-4908-8706-050403020100";

  it("seeds the target with every local branch and no remote", async () => {
    const repo = join(srcHome, "Code", "local-only");
    git(root, "init", "-q", "-b", "main", repo);
    write(join(repo, "readme.md"), "local\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    git(repo, "branch", "side");
    const wt = join(repo, ".claude", "worktrees", "feat");
    git(repo, "worktree", "add", "-q", "-b", "wyattjoh/feat", wt);
    write(join(wt, "feature.md"), "wip\n");
    git(wt, "add", ".");
    git(wt, "commit", "-q", "-m", "feature");
    write(
      join(srcHome, ".claude", "projects", encodeProjectDir(wt), `${LOCAL_SESSION}.jsonl`),
      `${JSON.stringify({ cwd: wt, gitBranch: "wyattjoh/feat" })}\n`,
    );

    const result = await run({ sessionId: LOCAL_SESSION, includes: [] });
    expect(result).toMatchObject({ actions: { repo: "seed", code: "create" } });

    const target = dst(repo);
    expect(git(target, "remote")).toBe("");
    expect(git(target, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(readFileSync(join(target, "readme.md"), "utf8")).toBe("local\n");
    expect(git(target, "branch", "--format=%(refname:short)")).toBe("main\nside\nwyattjoh/feat");
    expect(git(dst(wt), "rev-parse", "HEAD")).toBe(git(wt, "rev-parse", "HEAD"));
    expect(git(dst(wt), "status", "--porcelain")).toBe("");
  });
});
