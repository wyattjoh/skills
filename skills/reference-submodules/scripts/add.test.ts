import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanGitEnv, spawnGit } from "./git-env.ts";

const script = fileURLToPath(new URL("./add.ts", import.meta.url));
let sandbox: string;
let host: string;
let upstream: string;
let env: NodeJS.ProcessEnv;
let pin: string;
let head: string;

const git = async (cwd: string, ...args: string[]) => {
  const result = await spawnGit(
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgsign=false",
      "-c",
      `core.hooksPath=${join(sandbox, "no-hooks")}`,
      ...args,
    ],
    cwd,
    env,
  );
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
const run = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
  new Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    execFile(
      process.execPath,
      [script, ...args],
      {
        cwd: host,
        env: { ...env, ...extraEnv },
        timeout: 20_000,
      },
      (error, stdout, stderr) =>
        resolve({
          exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout,
          stderr,
        }),
    );
  });
const add = (options: string[] = [], extraEnv: NodeJS.ProcessEnv = {}) =>
  run(
    [
      pathToFileURL(upstream).href,
      "--repo",
      host,
      "--name",
      "source",
      "--tag",
      "v1.0.0",
      "--yes",
      ...options,
    ],
    extraEnv,
  );

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "reference-submodules-"));
  host = join(sandbox, "host repo");
  upstream = join(sandbox, "upstream");
  env = {
    ...cleanGitEnv(),
    GIT_ALLOW_PROTOCOL: "file",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  for (const dir of [host, upstream]) {
    await mkdir(dir);
    await git(dir, "init", "-q", "-b", "main");
    await writeFile(join(dir, "README.md"), "initial\n");
    await git(dir, "add", "README.md");
    await git(dir, "commit", "-qm", "initial");
  }
  pin = await git(upstream, "rev-parse", "HEAD");
  await git(upstream, "tag", "-a", "v1.0.0", "-m", "release");
  await git(upstream, "tag", "@scope/pkg@1.0.0");
  await writeFile(join(upstream, "README.md"), "newer\n");
  await git(upstream, "add", "README.md");
  await git(upstream, "commit", "-qm", "newer");
  head = await git(upstream, "rev-parse", "HEAD");
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe("add reference CLI", () => {
  it("pins an annotated tag as one shallow detached gitlink and stages the table", async () => {
    await writeFile(join(host, "README.md"), "unrelated edit\n");
    const result = await add(["--dependency", "example"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Pin: ${pin}`);
    const checkout = join(host, ".claude/references/source");
    expect(await git(checkout, "rev-parse", "HEAD")).toBe(pin);
    expect(await git(checkout, "rev-parse", "--is-shallow-repository")).toBe("true");
    expect((await spawnGit(["symbolic-ref", "-q", "HEAD"], checkout, env)).exitCode).toBe(1);
    expect(
      (
        await spawnGit(
          [
            "config",
            "--file",
            ".gitmodules",
            "--get",
            "submodule..claude/references/source.branch",
          ],
          host,
          env,
        )
      ).exitCode,
    ).toBe(1);
    expect(await git(host, "ls-files", "--stage", ".claude/references/source")).toBe(
      `160000 ${pin} 0\t.claude/references/source`,
    );
    expect(await git(host, "diff", "--cached", "--name-only")).toBe(
      ".claude/references/source\n.gitmodules\nCLAUDE.md",
    );
    expect(await git(host, "diff", "--", "README.md")).toContain("+unrelated edit");
    expect(await readFile(join(host, "CLAUDE.md"), "utf8")).toBe(
      "## Dependency References\n\n| Dependency | Version | Path |\n| ---------- | ------- | ---- |\n| example | 1.0.0 | `.claude/references/source` |\n",
    );
  });

  it("handles a scoped monorepo tag and explicit version", async () => {
    const result = await run([
      pathToFileURL(upstream).href,
      "--tag",
      "@scope/pkg@1.0.0",
      "--yes",
      "--version",
      "custom",
    ]);
    expect(result.exitCode).toBe(0);
    expect(await git(join(host, ".claude/references/upstream"), "rev-parse", "HEAD")).toBe(pin);
    expect(await readFile(join(host, "CLAUDE.md"), "utf8")).toContain(
      "| upstream | custom | `.claude/references/upstream` |",
    );
  });

  it("pins default branch HEAD and records branch@sha", async () => {
    const result = await run([pathToFileURL(upstream).href, "--default-branch", "--yes"]);
    expect(result.exitCode).toBe(0);
    expect(await git(join(host, ".claude/references/upstream"), "rev-parse", "HEAD")).toBe(head);
    expect(await readFile(join(host, "CLAUDE.md"), "utf8")).toContain(
      `| upstream | main@${head.slice(0, 7)} |`,
    );
  });

  it("dry-runs without modifying host files or the index", async () => {
    const result = await add(["--dry-run"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Dry run: nothing changed.");
    expect(await git(host, "status", "--porcelain")).toBe("");
  });

  it("requires confirmation outside a terminal", async () => {
    const result = await run([pathToFileURL(upstream).href, "--tag", "v1.0.0"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Confirmation requires a terminal");
    expect(await git(host, "status", "--porcelain")).toBe("");
  });

  it("rejects a nonexistent tag before mutation", async () => {
    const result = await run([pathToFileURL(upstream).href, "--tag", "v9.9.9", "--yes"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Tag v9.9.9 does not exist");
    expect(await git(host, "status", "--porcelain")).toBe("");
  });

  it("refuses existing submodules rather than retrying", async () => {
    expect((await add()).exitCode).toBe(0);
    const before = await git(host, "status", "--porcelain");
    const result = await add();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("already registered");
    expect(await git(host, "status", "--porcelain")).toBe(before);
  });

  it("rejects occupied paths and path traversal", async () => {
    await mkdir(join(host, ".claude/references/source"), { recursive: true });
    const result = await add();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("already exists");
    const traversal = await add(["--name", "../escape"]);
    expect(traversal.exitCode).toBe(1);
    expect(traversal.stderr).toContain("single directory name");
    expect(await git(host, "status", "--porcelain")).toBe("");
  });

  it("refuses staged or untracked host metadata rather than staging unrelated work", async () => {
    await writeFile(join(host, "CLAUDE.md"), "# Existing work\n");
    expect((await add()).exitCode).toBe(1);
    await git(host, "add", "CLAUDE.md");
    const result = await add();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Commit or stash existing changes");
    expect(await git(host, "diff", "--cached", "--name-only")).toBe("CLAUDE.md");
    expect(await readFile(join(host, "CLAUDE.md"), "utf8")).toBe("# Existing work\n");
  });

  it("supports in-repo CLAUDE.md symlinks and stages their target", async () => {
    await writeFile(join(host, "AGENTS.md"), "# Project\n");
    await symlink("AGENTS.md", join(host, "CLAUDE.md"));
    await git(host, "add", "AGENTS.md", "CLAUDE.md");
    await git(host, "commit", "-qm", "instructions");
    const result = await add();
    expect(result.exitCode).toBe(0);
    expect(await git(host, "diff", "--cached", "--name-only")).toBe(
      ".claude/references/source\n.gitmodules\nAGENTS.md",
    );
    expect(await readFile(join(host, "AGENTS.md"), "utf8")).toContain("## Dependency References");
  });

  it("rejects malformed documentation before adding", async () => {
    const document = "## Dependency References\n\n| Name | Path |\n| ---- | ---- |\n";
    await writeFile(join(host, "CLAUDE.md"), document);
    await git(host, "add", "CLAUDE.md");
    await git(host, "commit", "-qm", "instructions");
    const result = await add();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("needs Dependency, Version, and Path columns");
    expect(await git(host, "status", "--porcelain")).toBe("");
  });

  it("isolates the host from inherited repository selectors and injected config", async () => {
    const before = await git(upstream, "rev-parse", "HEAD");
    const result = await add([], {
      GIT_DIR: join(upstream, ".git"),
      GIT_WORK_TREE: upstream,
      GIT_INDEX_FILE: join(upstream, ".git/index"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.bare",
      GIT_CONFIG_VALUE_0: "true",
    });
    expect(result.exitCode).toBe(0);
    expect(await git(upstream, "rev-parse", "HEAD")).toBe(before);
    expect(await git(upstream, "config", "--get", "core.bare")).toBe("false");
    expect(await git(upstream, "status", "--porcelain")).toBe("");
  });

  it("guards a previously confirmed pin", async () => {
    const rejected = await add(["--expected-commit", head]);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toContain("differs from --expected-commit");
    expect(await git(host, "status", "--porcelain")).toBe("");
    expect((await add(["--expected-commit", pin])).exitCode).toBe(0);
  });

  it("rejects ignored documentation before any mutation", async () => {
    await writeFile(join(host, ".gitignore"), "CLAUDE.md\n");
    const result = await add();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("CLAUDE.md is ignored");
    expect(await git(host, "status", "--porcelain")).toBe("?? .gitignore");
  });

  it("refuses stored module state from an earlier failed add", async () => {
    await mkdir(join(host, ".git/modules/.claude/references/source"), { recursive: true });
    const result = await add();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Stored module");
    expect(await git(host, "status", "--porcelain")).toBe("");
  });

  it("rejects reference-directory symlinks instead of writing outside the host", async () => {
    await symlink(upstream, join(host, ".claude"));
    const result = await add();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(".claude must be a directory");
    expect(await git(upstream, "status", "--porcelain")).toBe("");
  });

  it("rejects an external CLAUDE.md symlink", async () => {
    await symlink(join(upstream, "README.md"), join(host, "CLAUDE.md"));
    const result = await add();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("points outside the repository");
    expect(await readFile(join(upstream, "README.md"), "utf8")).toBe("newer\n");
  });

  it("retains and reports partial state when a tag does not point to a commit", async () => {
    await git(upstream, "tag", "blob", "HEAD:README.md");
    const result = await run([pathToFileURL(upstream).href, "--tag", "blob", "--yes"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("The add may have left partial state");
    expect(await git(host, "diff", "--cached", "--name-only")).toBe(
      ".claude/references/upstream\n.gitmodules",
    );
    const retry = await run([pathToFileURL(upstream).href, "--tag", "blob", "--yes"]);
    expect(retry.exitCode).toBe(1);
    expect(retry.stderr).toContain("already registered");
  });

  it("supports relative local URLs and selecting a host from outside its root", async () => {
    await mkdir(join(host, "nested"));
    const result = await run([
      "../upstream",
      "--tag",
      "v1.0.0",
      "--repo",
      join(host, "nested"),
      "--yes",
    ]);
    expect(result.exitCode).toBe(0);
    expect(await git(join(host, ".claude/references/upstream"), "rev-parse", "HEAD")).toBe(pin);
  });

  it("adds safely inside a linked worktree without changing the main index", async () => {
    const worktree = join(sandbox, "worktree");
    await git(host, "worktree", "add", "-q", "-b", "feature", worktree);
    const result = await add(["--repo", worktree]);
    expect(result.exitCode).toBe(0);
    expect(await git(worktree, "ls-files", "--stage", ".claude/references/source")).toBe(
      `160000 ${pin} 0\t.claude/references/source`,
    );
    expect(await git(host, "status", "--porcelain")).toBe("");
  });

  it("preserves existing references when adding a second one", async () => {
    expect((await add()).exitCode).toBe(0);
    await git(host, "commit", "-qm", "first reference");
    expect((await add(["--name", "second"])).exitCode).toBe(0);
    expect(
      await git(host, "config", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"),
    ).toBe(
      "submodule..claude/references/source.path .claude/references/source\nsubmodule..claude/references/second.path .claude/references/second",
    );
    expect(await readFile(join(host, "CLAUDE.md"), "utf8")).toBe(
      "## Dependency References\n\n| Dependency | Version | Path |\n| ---------- | ------- | ---- |\n| second | 1.0.0 | `.claude/references/second` |\n| source | 1.0.0 | `.claude/references/source` |\n",
    );
  });

  it("rejects a host with no commits", async () => {
    const empty = join(sandbox, "empty");
    await mkdir(empty);
    await git(empty, "init", "-q", "-b", "main");
    const result = await add(["--repo", empty]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("needs at least one commit");
    expect(await git(empty, "status", "--porcelain")).toBe("");
  });

  it("provides help and rejects ambiguous pin selection", async () => {
    expect((await run(["--help"])).exitCode).toBe(0);
    const missing = await run([pathToFileURL(upstream).href, "--yes"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("Choose exactly one");
    expect((await add(["--default-branch"])).exitCode).toBe(1);
  });
});
