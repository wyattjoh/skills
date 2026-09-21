import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnGit } from "./lib/git.ts";

const CLI = join(import.meta.dir, "coordinate.ts");
const decoder = new TextDecoder();
const servers: Server[] = [];

type CliResult = {
  exitCode: number;
  stdout: Record<string, unknown>;
  stderr: string;
};

const writeCommand = (directory: string, name: string, body: string): string => {
  const path = join(directory, name);
  writeFileSync(path, `#!${process.execPath}\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};

const makeHarnessEnvironment = (root: string): Record<string, string> => {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeCommand(
    bin,
    "pi",
    `
const args = process.argv.slice(2);
if (args[0] === "--version") console.log("pi 0.80.3");
else if (args[0] === "--help") console.log("--thinking <level>  Set thinking level: off, minimal, low, medium, high, xhigh, max");
else if (args[0] === "--list-models") console.log("provider      model       context\\nopenai-codex  gpt-5.6-sol 272K");
else process.exit(1);
`,
  );
  writeCommand(
    bin,
    "claude",
    `
const args = process.argv.slice(2);
if (args[0] === "--version") console.log("Claude Code 2.1.80");
else if (args[0] === "--help") console.log("--effort <level>  Effort level (low, medium, high, xhigh, max)");
else process.exit(1);
`,
  );
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    HOME: join(root, "home"),
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
};

const runCli = (request: unknown, env: Record<string, string>): CliResult => {
  const child = Bun.spawnSync([process.execPath, CLI], {
    env,
    stdin: Buffer.from(JSON.stringify(request)),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = decoder.decode(child.stdout);
  const stderr = decoder.decode(child.stderr);
  return {
    exitCode: child.exitCode,
    stdout: JSON.parse(stdout) as Record<string, unknown>,
    stderr,
  };
};

const runCliAsync = async (request: unknown, env: Record<string, string>): Promise<CliResult> => {
  const child = Bun.spawn([process.execPath, CLI], {
    env,
    stdin: Buffer.from(JSON.stringify(request)),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return {
    exitCode,
    stdout: JSON.parse(stdout) as Record<string, unknown>,
    stderr,
  };
};

const request = (operation: string, input: Record<string, unknown>) => ({
  schema_version: 1,
  operation,
  input,
});

const initializeRepository = (root: string): string => {
  const repository = join(root, "repository");
  mkdirSync(repository, { recursive: true });
  expect(spawnGit(["init", "-q", "-b", "main"], { cwd: repository }).exitCode).toBe(0);
  expect(spawnGit(["config", "user.name", "Test User"], { cwd: repository }).exitCode).toBe(0);
  expect(spawnGit(["config", "user.email", "test@example.com"], { cwd: repository }).exitCode).toBe(
    0,
  );
  writeFileSync(join(repository, "README.md"), "fixture\n");
  expect(spawnGit(["add", "README.md"], { cwd: repository }).exitCode).toBe(0);
  expect(spawnGit(["commit", "-q", "-m", "fixture"], { cwd: repository }).exitCode).toBe(0);
  return repository;
};

const state = (): string => `# sample implementation run

Schema version: 1

Implementor:
  harness: pi
  model: openai-codex/gpt-5.6-sol
  effort: high

## Tickets

| NN | harness | model | effort | rounds | esc | status | sha |
| -- | ------- | ----- | ------ | ------ | --- | ------ | --- |
| 04 | - | - | - | 0 | - | queued | - |

## Active tickets

## Decisions

- Existing decision remains intact.
`;

const fallbackPolicy = (worktreeRoot: string) => ({
  instruction_files: ["CLAUDE.md", ".claude/rules/worktrees.md"],
  worktree: {
    kind: "native",
    tool: null,
    root: worktreeRoot,
    create_argv: null,
  },
  branch_naming: "wyattjoh/<slug>",
  setup_argvs: [],
  cleanup: "native-safe",
  remote: "local-only",
  remote_sync_argv: null,
  commit: null,
});

const prepareWorktree = (
  fixture: {
    env: Record<string, string>;
    repository: string;
    statePath: string;
    worktreeRoot: string;
  },
  branch = "wyattjoh/ticket-04",
  name = "ticket 04",
): CliResult =>
  runCli(
    request("worktree.prepare", {
      state_path: fixture.statePath,
      repository_path: fixture.repository,
      base_branch: "main",
      branch,
      worktree_name: name,
      policy: fallbackPolicy(fixture.worktreeRoot),
    }),
    fixture.env,
  );

const listen = async (server: Server, path: string): Promise<void> => {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
};

const closeServer = async (server: Server): Promise<void> => {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

const writeLine = (socket: Socket, value: unknown): void => {
  socket.write(`${JSON.stringify(value)}\n`);
};

const recoverySnapshot = (
  session: string,
  pane: string,
  status: string,
): Record<string, unknown> => ({
  id: "snapshot",
  result: {
    type: "session_snapshot",
    snapshot: {
      panes: [{ pane_id: pane, agent_status: status }],
      agents: [{ name: session, pane_id: pane, agent_status: status }],
    },
  },
});

const makeFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "coordinate-launch-"));
  const repository = initializeRepository(root);
  const statePath = join(root, "RESUME.md");
  const worktreeRoot = join(root, "worktrees with spaces");
  writeFileSync(statePath, state());
  return {
    root,
    repository,
    statePath,
    worktreeRoot,
    env: makeHarnessEnvironment(root),
  };
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

describe("worktree and launch documentation contract", () => {
  it("documents policy-driven worktrees without an optional product dependency", () => {
    const skill = readFileSync(join(import.meta.dir, "..", "SKILL.md"), "utf8");
    const launch = readFileSync(
      join(import.meta.dir, "..", "references", "session-launch.md"),
      "utf8",
    );
    const helper = readFileSync(join(import.meta.dir, "..", "references", "helper-cli.md"), "utf8");
    const resume = readFileSync(
      join(import.meta.dir, "..", "references", "resume-format.md"),
      "utf8",
    );
    const published = `${skill}\n${launch}\n${helper}\n${resume}`;

    expect(launch.includes("Repository instructions are authoritative")).toBe(true);
    expect(helper.includes("## `worktree.preflight`")).toBe(true);
    expect(helper.includes("## `worktree.prepare`")).toBe(true);
    expect(helper.includes("## `implementor.launch.prepare`")).toBe(true);
    expect(helper.includes("## `implementor.launch.recover`")).toBe(true);
    expect(helper.includes("## `implementor.launch.record`")).toBe(true);
    expect(helper.includes("## `review.escalation.authorize`")).toBe(true);
    expect(resume.includes('"commits": "multiple"')).toBe(true);
    expect(resume.includes('"fixes": "append"')).toBe(true);
    expect(published.includes("Pando")).toBe(false);
    expect(published.includes("EnterWorktree")).toBe(false);
  });
});

describe("policy-driven worktree preparation", () => {
  it("uses native Git fallback, persists defaults, and strips inherited Git locations", () => {
    const fixture = makeFixture();
    const decoy = join(fixture.root, "decoy");
    mkdirSync(decoy);
    expect(spawnGit(["init", "-q", "-b", "decoy"], { cwd: decoy }).exitCode).toBe(0);
    expect(spawnGit(["config", "user.name", "Test User"], { cwd: decoy }).exitCode).toBe(0);
    expect(spawnGit(["config", "user.email", "test@example.com"], { cwd: decoy }).exitCode).toBe(0);
    writeFileSync(join(decoy, "guard.txt"), "guard\n");
    expect(spawnGit(["add", "guard.txt"], { cwd: decoy }).exitCode).toBe(0);
    expect(spawnGit(["commit", "-q", "-m", "guard"], { cwd: decoy }).exitCode).toBe(0);
    const decoyGitDir = spawnGit(["rev-parse", "--git-dir"], { cwd: decoy }).stdout.trim();
    fixture.env.GIT_DIR = join(decoy, decoyGitDir);

    const result = prepareWorktree(fixture, "wyattjoh/ticket-04", "ticket 04's ünicode");

    const worktree = join(fixture.worktreeRoot, "ticket 04's ünicode");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.result).toEqual({
      policy: {
        instruction_files: ["CLAUDE.md", ".claude/rules/worktrees.md"],
        worktree: {
          kind: "native",
          tool: "git",
          root: fixture.worktreeRoot,
          create_argv: null,
        },
        branch_naming: "wyattjoh/<slug>",
        setup_argvs: [],
        cleanup: "native-safe",
        remote: "local-only",
        remote_sync_argv: null,
        commit: { commits: "multiple", fixes: "append" },
      },
      worktree: {
        path: worktree,
        branch: "wyattjoh/ticket-04",
        base: "main",
        created: true,
        recovered: false,
      },
    });
    expect(spawnGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktree }).stdout.trim()).toBe(
      "wyattjoh/ticket-04",
    );
    expect(
      spawnGit(["rev-list", "--count", "main"], { cwd: fixture.repository }).stdout.trim(),
    ).toBe("1");
    expect(
      spawnGit(["show-ref", "--verify", "--hash", "refs/heads/wyattjoh/ticket-04"], {
        cwd: fixture.repository,
      }).exitCode,
    ).toBe(0);
    expect(
      spawnGit(["rev-list", "--count", "wyattjoh/ticket-04"], {
        cwd: fixture.repository,
      }).stdout.trim(),
    ).toBe("1");
    expect(
      spawnGit(["for-each-ref", "--format=%(refname)", "refs/heads"], {
        cwd: fixture.repository,
      })
        .stdout.trim()
        .split("\n")
        .toSorted(),
    ).toEqual(["refs/heads/main", "refs/heads/wyattjoh/ticket-04"]);
    expect(
      spawnGit(["worktree", "list", "--porcelain"], { cwd: fixture.repository })
        .stdout.split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => realpathSync(line.slice("worktree ".length))),
    ).toEqual([realpathSync(fixture.repository), realpathSync(worktree)]);
    const recovered = prepareWorktree(fixture, "wyattjoh/ticket-04", "ticket 04's ünicode");
    expect((recovered.stdout.result as { worktree: unknown }).worktree).toEqual({
      path: worktree,
      branch: "wyattjoh/ticket-04",
      base: "main",
      created: false,
      recovered: true,
    });
    expect(spawnGit(["rev-list", "--count", "decoy"], { cwd: decoy }).stdout.trim()).toBe("1");
    expect(spawnGit(["ls-tree", "--name-only", "decoy"], { cwd: decoy }).stdout.trim()).toBe(
      "guard.txt",
    );
    const persisted = readFileSync(fixture.statePath, "utf8");
    expect(
      persisted.includes('"root": "' + fixture.worktreeRoot.replaceAll("\\", "\\\\") + '"'),
    ).toBe(true);
    expect(persisted.includes('"commits": "multiple"')).toBe(true);
    expect(persisted.includes('"fixes": "append"')).toBe(true);
  });

  it("preflights a repository-required tool before state or worktree creation", () => {
    const root = mkdtempSync(join(tmpdir(), "coordinate-worktree-preflight-"));
    const statePath = join(root, "RESUME.md");
    const worktreePath = join(root, "worktree");
    const result = runCli(
      request("worktree.preflight", {
        policy: {
          instruction_files: ["CLAUDE.md"],
          worktree: {
            kind: "repository",
            tool: "required-worktree-tool",
            root: null,
            create_argv: ["required-worktree-tool", "create", worktreePath],
          },
          branch_naming: "feature/<slug>",
          setup_argvs: [],
          cleanup: "repository",
          remote: "local-only",
          remote_sync_argv: null,
          commit: null,
        },
      }),
      makeHarnessEnvironment(root),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout.errors).toEqual([
      {
        code: "worktree.tool_unavailable",
        message: "Repository-required worktree tool `required-worktree-tool` is unavailable.",
        remediation:
          "Install the prescribed tool or revise the repository policy; native Git fallback was not used.",
      },
    ]);
    expect(existsSync(statePath)).toBe(false);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("runs a repository-prescribed worktree tool and fails closed when it is unavailable", () => {
    const fixture = makeFixture();
    const tool = writeCommand(
      join(fixture.root, "bin"),
      "repo-worktrees",
      `
const [repository, path, branch, base] = process.argv.slice(2);
const gitEnvKeys = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
]);
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key, value]) => value !== undefined && !gitEnvKeys.has(key)),
);
const result = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "worktree", "add", "-b", branch, path, base], {
  cwd: repository,
  env,
  stdout: "pipe",
  stderr: "pipe",
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.exitCode);
`,
    );
    const decoy = join(fixture.root, "repository-tool-decoy");
    mkdirSync(decoy);
    expect(spawnGit(["init", "-q", "-b", "decoy"], { cwd: decoy }).exitCode).toBe(0);
    expect(spawnGit(["config", "user.name", "Test User"], { cwd: decoy }).exitCode).toBe(0);
    expect(spawnGit(["config", "user.email", "test@example.com"], { cwd: decoy }).exitCode).toBe(0);
    writeFileSync(join(decoy, "guard.txt"), "guard\n");
    expect(spawnGit(["add", "guard.txt"], { cwd: decoy }).exitCode).toBe(0);
    expect(spawnGit(["commit", "-q", "-m", "guard"], { cwd: decoy }).exitCode).toBe(0);
    fixture.env.GIT_DIR = join(
      decoy,
      spawnGit(["rev-parse", "--git-dir"], { cwd: decoy }).stdout.trim(),
    );

    const externalPath = join(fixture.root, "external ' ünicode");
    const policy = {
      instruction_files: ["CLAUDE.md"],
      worktree: {
        kind: "repository",
        tool: "repo-worktrees",
        root: null,
        create_argv: [tool, fixture.repository, externalPath, "wyattjoh/external", "main"],
      },
      branch_naming: "wyattjoh/<slug>",
      setup_argvs: [],
      cleanup: "repository",
      remote: "repository",
      remote_sync_argv: ["git", "fetch", "upstream"],
      commit: { commits: "single", fixes: "amend" },
    };

    const preflight = runCli(request("worktree.preflight", { policy }), fixture.env);
    expect(preflight.exitCode).toBe(0);
    expect(preflight.stdout.result).toEqual({
      policy: {
        instruction_files: ["CLAUDE.md"],
        worktree: {
          kind: "repository",
          tool: "repo-worktrees",
          root: null,
          create_argv: [tool, fixture.repository, externalPath, "wyattjoh/external", "main"],
        },
        branch_naming: "wyattjoh/<slug>",
        setup_argvs: [],
        cleanup: "repository",
        remote: "repository",
        remote_sync_argv: ["git", "fetch", "upstream"],
        commit: { commits: "single", fixes: "amend" },
      },
      required_tool: { name: "repo-worktrees", available: true },
    });

    const created = runCli(
      request("worktree.prepare", {
        state_path: fixture.statePath,
        repository_path: fixture.repository,
        base_branch: "main",
        branch: "wyattjoh/external",
        worktree_name: "ignored-for-repository-policy",
        expected_worktree_path: externalPath,
        policy,
      }),
      fixture.env,
    );

    expect(created.exitCode).toBe(0);
    expect((created.stdout.result as { worktree: { path: string } }).worktree.path).toBe(
      externalPath,
    );
    expect(
      spawnGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: externalPath }).stdout.trim(),
    ).toBe("wyattjoh/external");
    expect(spawnGit(["rev-list", "--count", "decoy"], { cwd: decoy }).stdout.trim()).toBe("1");
    expect(spawnGit(["ls-tree", "--name-only", "decoy"], { cwd: decoy }).stdout.trim()).toBe(
      "guard.txt",
    );

    const missingState = join(fixture.root, "MISSING-RESUME.md");
    writeFileSync(missingState, state());
    const missing = runCli(
      request("worktree.prepare", {
        state_path: missingState,
        repository_path: fixture.repository,
        base_branch: "main",
        branch: "wyattjoh/missing",
        worktree_name: "missing",
        expected_worktree_path: join(fixture.root, "missing"),
        policy: {
          ...policy,
          worktree: {
            ...policy.worktree,
            tool: "required-worktree-tool",
            create_argv: ["required-worktree-tool", "create"],
          },
        },
      }),
      fixture.env,
    );

    expect(missing.exitCode).toBe(1);
    expect(missing.stdout.errors).toEqual([
      {
        code: "worktree.tool_unavailable",
        message: "Repository-required worktree tool `required-worktree-tool` is unavailable.",
        remediation:
          "Install the prescribed tool or revise the repository policy; native Git fallback was not used.",
      },
    ]);
    expect(
      spawnGit(["for-each-ref", "--format=%(refname)", "refs/heads"], {
        cwd: fixture.repository,
      })
        .stdout.trim()
        .split("\n"),
    ).toEqual(["refs/heads/main", "refs/heads/wyattjoh/external"]);
  });
});

describe("safe implementor launch", () => {
  it("constructs exact Pi argument arrays and records durable runtime provenance", () => {
    const fixture = makeFixture();
    const prepared = prepareWorktree(fixture);
    expect(prepared.exitCode).toBe(0);
    const worktree = (prepared.stdout.result as { worktree: { path: string } }).worktree.path;
    const implementSkill = join(fixture.root, "skills with spaces", "implement", "SKILL.md");
    mkdirSync(join(fixture.root, "skills with spaces", "implement"), { recursive: true });
    writeFileSync(implementSkill, "---\nname: implement\n---\n");
    const artifactPath = join(fixture.root, "briefs", "launch-04.json");
    const prompt = "- leading prompt with apostrophe ' and ünicode";

    const result = runCli(
      request("implementor.launch.prepare", {
        state_path: fixture.statePath,
        artifact_path: artifactPath,
        ticket: "04",
        worktree_path: worktree,
        branch: "wyattjoh/ticket-04",
        session: "pci-04",
        tab: "implement ticket 04",
        pane: "workspace:p4",
        role: { harness: "pi", model: "openai-codex/gpt-5.6-sol", effort: "high" },
        implement_skill_path: implementSkill,
        prompt,
        attempt: 1,
        max_attempts: 3,
      }),
      fixture.env,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.result).toEqual({
      recovered: false,
      artifact_path: artifactPath,
      launch: {
        start: {
          command: "herdr",
          args: [
            "agent",
            "start",
            "pci-04",
            "--kind",
            "pi",
            "--pane",
            "workspace:p4",
            "--timeout",
            "300000",
            "--",
            "--approve",
            "--model",
            "openai-codex/gpt-5.6-sol",
            "--thinking",
            "high",
            "--skill",
            implementSkill,
          ],
        },
        prompt: {
          command: "herdr",
          args: [
            "agent",
            "prompt",
            "pci-04",
            `/skill:implement ${prompt}`,
            "--wait",
            "--timeout",
            "300000",
          ],
        },
      },
    });
    expect(JSON.parse(readFileSync(artifactPath, "utf8"))).toEqual({
      schema_version: 1,
      ticket: "04",
      cwd: worktree,
      branch: "wyattjoh/ticket-04",
      role: { harness: "pi", model: "openai-codex/gpt-5.6-sol", effort: "high" },
      implement_skill_path: implementSkill,
      session: "pci-04",
      tab: "implement ticket 04",
      pane: "workspace:p4",
      attempt: 1,
      max_attempts: 3,
      launch: (result.stdout.result as { launch: unknown }).launch,
    });
    const persisted = readFileSync(fixture.statePath, "utf8");
    expect(
      persisted.includes("| 04 | pi | openai-codex/gpt-5.6-sol | high | 0 | - | working | - |"),
    ).toBe(true);
    expect(persisted.includes(`Worktree: ${worktree}`)).toBe(true);
    expect(
      persisted.includes(
        'Implementor: {"harness":"pi","model":"openai-codex/gpt-5.6-sol","effort":"high"}',
      ),
    ).toBe(true);
    expect(persisted.includes(`Implement skill: ${implementSkill}`)).toBe(true);
    expect(persisted.includes("Session: pci-04")).toBe(true);
    expect(persisted.includes("Tab: implement ticket 04")).toBe(true);
    expect(persisted.includes("Pane: workspace:p4")).toBe(true);
    expect(persisted.includes(`Artifact: ${artifactPath}`)).toBe(true);
    expect(persisted.includes("Phase: launch prepared")).toBe(true);
    expect(persisted.includes("Retry: 0 of 3")).toBe(true);
  });

  it("rejects artifact symlink escapes without changing state", () => {
    const fixture = makeFixture();
    const prepared = prepareWorktree(fixture);
    expect(prepared.exitCode).toBe(0);
    const worktree = (prepared.stdout.result as { worktree: { path: string } }).worktree.path;
    const implementSkill = join(fixture.root, "implement-symlink", "SKILL.md");
    mkdirSync(join(fixture.root, "implement-symlink"));
    writeFileSync(implementSkill, "---\nname: implement\n---\n");
    const outside = mkdtempSync(join(tmpdir(), "coordinate-outside-artifacts-"));
    symlinkSync(outside, join(fixture.root, "briefs"));
    const artifactPath = join(fixture.root, "briefs", "launch-04.json");
    const before = readFileSync(fixture.statePath, "utf8");

    const result = runCli(
      request("implementor.launch.prepare", {
        state_path: fixture.statePath,
        artifact_path: artifactPath,
        ticket: "04",
        worktree_path: worktree,
        branch: "wyattjoh/ticket-04",
        session: "pci-04",
        tab: "implement ticket 04",
        pane: "workspace:p4",
        role: { harness: "pi", model: "openai-codex/gpt-5.6-sol", effort: "high" },
        implement_skill_path: implementSkill,
        prompt: "implement ticket 04",
        attempt: 1,
        max_attempts: 3,
      }),
      fixture.env,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout.errors).toEqual([
      {
        code: "implementor.artifact_outside_run",
        message: "Launch artifact_path must resolve inside the run directory containing RESUME.md.",
        remediation: "Choose a run-local artifact path such as briefs/launch-NN.json.",
      },
    ]);
    expect(readFileSync(fixture.statePath, "utf8")).toBe(before);
    expect(existsSync(join(outside, "launch-04.json"))).toBe(false);
  });

  it("rejects a role that differs from the persisted Implementor without artifacts or state changes", () => {
    const fixture = makeFixture();
    const prepared = prepareWorktree(fixture, "wyattjoh/role-mismatch", "role-mismatch");
    expect(prepared.exitCode).toBe(0);
    const worktree = (prepared.stdout.result as { worktree: { path: string } }).worktree.path;
    const artifactPath = join(fixture.root, "briefs", "role-mismatch.json");
    const before = readFileSync(fixture.statePath, "utf8");

    const result = runCli(
      request("implementor.launch.prepare", {
        state_path: fixture.statePath,
        artifact_path: artifactPath,
        ticket: "04",
        worktree_path: worktree,
        branch: "wyattjoh/role-mismatch",
        session: "pci-role-mismatch",
        tab: "implement ticket 04",
        pane: "workspace:p6",
        role: { harness: "claude", model: "sonnet", effort: "medium" },
        implement_skill_path: null,
        prompt: "implement ticket 04",
        attempt: 1,
        max_attempts: 3,
      }),
      fixture.env,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout.errors).toEqual([
      {
        code: "implementor.role_mismatch",
        message:
          "Requested implementor role does not match the ticket-bound or run-default Implementor role.",
        remediation:
          "Launch an already bound ticket with its exact row role. Only a helper-recorded review escalation may replace that per-ticket binding.",
      },
    ]);
    expect(readFileSync(fixture.statePath, "utf8")).toBe(before);
    expect(existsSync(artifactPath)).toBe(false);
  });

  it("launches an explicitly rebound ticket role without changing the run default", () => {
    const fixture = makeFixture();
    const prepared = prepareWorktree(fixture, "wyattjoh/rebound", "rebound");
    expect(prepared.exitCode).toBe(0);
    const worktree = (prepared.stdout.result as { worktree: { path: string } }).worktree.path;
    writeFileSync(
      fixture.statePath,
      readFileSync(fixture.statePath, "utf8").replace(
        "| 04 | - | - | - | 0 | - | queued | - |",
        "| 04 | claude | opus | high | 3 | yes | blocked | - |",
      ),
    );
    const artifactPath = join(fixture.root, "briefs", "launch-rebound.json");

    const result = runCli(
      request("implementor.launch.prepare", {
        state_path: fixture.statePath,
        artifact_path: artifactPath,
        ticket: "04",
        worktree_path: worktree,
        branch: "wyattjoh/rebound",
        session: "pci-rebound",
        tab: "implement ticket 04 replacement",
        pane: "workspace:p8",
        role: { harness: "claude", model: "opus", effort: "high" },
        implement_skill_path: null,
        prompt: "apply authorized escalation fixes",
        attempt: 1,
        max_attempts: 3,
      }),
      fixture.env,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatchObject({
      result: { launch: { start: { command: "herdr" } } },
    });
    const persisted = readFileSync(fixture.statePath, "utf8");
    expect(persisted).toContain("| 04 | claude | opus | high | 3 | yes | working | - |");
    expect(persisted).toContain("Implementor:\n  harness: pi");
    expect(persisted).toContain('Implementor: {"harness":"claude","model":"opus","effort":"high"}');
  });

  it("preserves an identical artifact when malformed state rejects recovery", () => {
    const fixture = makeFixture();
    const prepared = prepareWorktree(fixture);
    expect(prepared.exitCode).toBe(0);
    const worktree = (prepared.stdout.result as { worktree: { path: string } }).worktree.path;
    const implementSkill = join(fixture.root, "implement-malformed", "SKILL.md");
    mkdirSync(join(fixture.root, "implement-malformed"));
    writeFileSync(implementSkill, "---\nname: implement\n---\n");
    const artifactPath = join(fixture.root, "briefs", "launch-malformed.json");
    const input = {
      state_path: fixture.statePath,
      artifact_path: artifactPath,
      ticket: "04",
      worktree_path: worktree,
      branch: "wyattjoh/ticket-04",
      session: "pci-malformed",
      tab: "implement ticket 04",
      pane: "workspace:p7",
      role: { harness: "pi", model: "openai-codex/gpt-5.6-sol", effort: "high" },
      implement_skill_path: implementSkill,
      prompt: "implement ticket 04",
      attempt: 1,
      max_attempts: 3,
    };
    expect(runCli(request("implementor.launch.prepare", input), fixture.env).exitCode).toBe(0);
    const artifact = readFileSync(artifactPath, "utf8");
    const malformed = readFileSync(fixture.statePath, "utf8").replace(
      "| 04 | pi | openai-codex/gpt-5.6-sol | high | 0 | - | working | - |",
      "| 04 | malformed |",
    );
    writeFileSync(fixture.statePath, malformed);

    const result = runCli(request("implementor.launch.prepare", input), fixture.env);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.errors).toEqual([
      {
        code: "state.ticket_table_malformed",
        message: "Ticket `04` does not match the ticket table columns.",
        remediation: "Repair the schema-1 ticket row before launching an implementor.",
      },
    ]);
    expect(readFileSync(fixture.statePath, "utf8")).toBe(malformed);
    expect(readFileSync(artifactPath, "utf8")).toBe(artifact);
  });

  it("recovers a structured Claude model containing spaces without changing its role", () => {
    const fixture = makeFixture();
    const prepared = prepareWorktree(fixture, "wyattjoh/claude", "-leading-name");
    expect(prepared.exitCode).toBe(0);
    const worktree = (prepared.stdout.result as { worktree: { path: string } }).worktree.path;
    const artifactPath = join(fixture.root, "briefs", "launch-04-claude.json");
    const model = "Claude Custom Model With Spaces";
    writeFileSync(
      fixture.statePath,
      readFileSync(fixture.statePath, "utf8").replace(
        "Implementor:\n  harness: pi\n  model: openai-codex/gpt-5.6-sol\n  effort: high",
        `Implementor:\n  harness: claude\n  model: ${model}\n  effort: medium`,
      ),
    );
    const input = {
      state_path: fixture.statePath,
      artifact_path: artifactPath,
      ticket: "04",
      worktree_path: worktree,
      branch: "wyattjoh/claude",
      session: "pci-claude",
      tab: "claude tab",
      pane: "workspace:p5",
      role: { harness: "claude", model, effort: "medium" },
      implement_skill_path: null,
      prompt: "path /tmp/a b and apostrophe '",
      attempt: 1,
      max_attempts: 3,
    };

    const result = runCli(request("implementor.launch.prepare", input), fixture.env);

    expect(result.exitCode).toBe(0);
    expect((result.stdout.result as { launch: unknown }).launch).toEqual({
      start: {
        command: "herdr",
        args: [
          "agent",
          "start",
          "pci-claude",
          "--kind",
          "claude",
          "--pane",
          "workspace:p5",
          "--timeout",
          "300000",
          "--",
          "--model",
          "Claude Custom Model With Spaces",
          "--effort",
          "medium",
          "--permission-mode",
          "auto",
        ],
      },
      prompt: {
        command: "herdr",
        args: [
          "agent",
          "prompt",
          "pci-claude",
          "/implement path /tmp/a b and apostrophe '",
          "--wait",
          "--timeout",
          "300000",
        ],
      },
    });
    const persisted = readFileSync(fixture.statePath, "utf8");
    expect(
      persisted.includes(
        'Implementor: {"harness":"claude","model":"Claude Custom Model With Spaces","effort":"medium"}',
      ),
    ).toBe(true);

    const recovered = runCli(request("implementor.launch.prepare", input), fixture.env);
    expect(recovered.exitCode).toBe(0);
    expect((recovered.stdout.result as { recovered: boolean }).recovered).toBe(true);
    expect(readFileSync(fixture.statePath, "utf8")).toBe(persisted);

    const differentArtifact = join(fixture.root, "briefs", "launch-04-different-role.json");
    const artifactBeforeMismatch = readFileSync(artifactPath, "utf8");
    const mismatch = runCli(
      request("implementor.launch.prepare", {
        ...input,
        artifact_path: differentArtifact,
        role: { harness: "claude", model: "Different Custom Model", effort: "medium" },
      }),
      fixture.env,
    );
    expect(mismatch.exitCode).toBe(1);
    expect(mismatch.stdout.errors).toEqual([
      {
        code: "implementor.role_mismatch",
        message:
          "Requested implementor role does not match the ticket-bound or run-default Implementor role.",
        remediation:
          "Launch an already bound ticket with its exact row role. Only a helper-recorded review escalation may replace that per-ticket binding.",
      },
    ]);
    expect(readFileSync(fixture.statePath, "utf8")).toBe(persisted);
    expect(readFileSync(artifactPath, "utf8")).toBe(artifactBeforeMismatch);
    expect(existsSync(differentArtifact)).toBe(false);
  });

  it("recovers a prepared launch and records an exact failure without changing its binding", () => {
    const fixture = makeFixture();
    const prepared = prepareWorktree(fixture);
    expect(prepared.exitCode).toBe(0);
    const worktree = (prepared.stdout.result as { worktree: { path: string } }).worktree.path;
    const implementSkill = join(fixture.root, "implement", "SKILL.md");
    mkdirSync(join(fixture.root, "implement"));
    writeFileSync(implementSkill, "---\nname: implement\n---\n");
    const artifactPath = join(fixture.root, "briefs", "launch-04.json");
    const input = {
      state_path: fixture.statePath,
      artifact_path: artifactPath,
      ticket: "04",
      worktree_path: worktree,
      branch: "wyattjoh/ticket-04",
      session: "pci-04",
      tab: "implement ticket 04",
      pane: "workspace:p4",
      role: { harness: "pi", model: "openai-codex/gpt-5.6-sol", effort: "high" },
      implement_skill_path: implementSkill,
      prompt: "implement ticket 04",
      attempt: 1,
      max_attempts: 3,
    };
    expect(runCli(request("implementor.launch.prepare", input), fixture.env).exitCode).toBe(0);

    const recovered = runCli(request("implementor.launch.prepare", input), fixture.env);
    const failed = runCli(
      request("implementor.launch.record", {
        state_path: fixture.statePath,
        ticket: "04",
        attempt: 1,
        status: "failed",
        diagnostic: {
          stage: "prompt",
          exit_code: 17,
          stderr: "agent refused exact model; no substitution",
        },
      }),
      fixture.env,
    );

    expect(recovered.exitCode).toBe(0);
    expect((recovered.stdout.result as { recovered: boolean }).recovered).toBe(true);
    expect(failed.exitCode).toBe(0);
    expect(failed.stdout.result).toEqual({
      ticket: "04",
      attempt: 1,
      status: "failed",
      phase: "launch failed",
      diagnostic: {
        stage: "prompt",
        exit_code: 17,
        stderr: "agent refused exact model; no substitution",
      },
    });
    const persisted = readFileSync(fixture.statePath, "utf8");
    expect(
      persisted.includes("| 04 | pi | openai-codex/gpt-5.6-sol | high | 0 | - | working | - |"),
    ).toBe(true);
    expect(persisted.includes("Phase: launch failed")).toBe(true);
    expect(persisted.includes("Retry: 0 of 3")).toBe(true);
    expect(
      persisted.includes(
        "Last diagnostic: prompt exited 17: agent refused exact model; no substitution",
      ),
    ).toBe(true);
    expect(
      persisted.includes(
        'Implementor: {"harness":"pi","model":"openai-codex/gpt-5.6-sol","effort":"high"}',
      ),
    ).toBe(true);

    const alternateSkill = join(fixture.root, "alternate-implement", "SKILL.md");
    mkdirSync(join(fixture.root, "alternate-implement"));
    writeFileSync(alternateSkill, "---\nname: implement\n---\n");
    const substitutedArtifact = join(fixture.root, "briefs", "launch-04-substituted.json");
    const beforeSubstitution = readFileSync(fixture.statePath, "utf8");
    const substituted = runCli(
      request("implementor.launch.prepare", {
        ...input,
        artifact_path: substitutedArtifact,
        implement_skill_path: alternateSkill,
        attempt: 2,
      }),
      fixture.env,
    );
    expect(substituted.exitCode).toBe(1);
    expect(substituted.stdout.errors).toEqual([
      {
        code: "implementor.runtime_conflict",
        message: "Ticket `04` already has a different or completed active launch attempt.",
        remediation:
          "Recover the recorded runtime or start the next retry without changing its bound role, worktree, or required skill.",
      },
    ]);
    expect(readFileSync(fixture.statePath, "utf8")).toBe(beforeSubstitution);
    expect(existsSync(substitutedArtifact)).toBe(false);

    const retry = runCli(
      request("implementor.launch.prepare", {
        ...input,
        artifact_path: join(fixture.root, "briefs", "launch-04-attempt-2.json"),
        attempt: 2,
      }),
      fixture.env,
    );
    expect(retry.exitCode).toBe(0);
    expect((retry.stdout.result as { recovered: boolean }).recovered).toBe(false);
    expect(readFileSync(fixture.statePath, "utf8").includes("Retry: 1 of 3")).toBe(true);
    expect(
      readFileSync(fixture.statePath, "utf8").includes(
        'Implementor: {"harness":"pi","model":"openai-codex/gpt-5.6-sol","effort":"high"}',
      ),
    ).toBe(true);
  });

  it("recovers only an authorized exhausted launch with its exact idle Herdr worker", async () => {
    const fixture = makeFixture();
    const prepared = prepareWorktree(fixture);
    expect(prepared.exitCode).toBe(0);
    const worktree = (prepared.stdout.result as { worktree: { path: string } }).worktree.path;
    const implementSkill = join(fixture.root, "implement-recovery", "SKILL.md");
    mkdirSync(join(fixture.root, "implement-recovery"));
    writeFileSync(implementSkill, "---\nname: implement\n---\n");
    const baseInput = {
      state_path: fixture.statePath,
      ticket: "04",
      worktree_path: worktree,
      branch: "wyattjoh/ticket-04",
      session: "pci-04",
      tab: "implement ticket 04",
      pane: "workspace:p4",
      role: { harness: "pi", model: "openai-codex/gpt-5.6-sol", effort: "high" },
      implement_skill_path: implementSkill,
      prompt: "implement ticket 04",
      max_attempts: 3,
    };

    const exhaustedArtifactPath = join(fixture.root, "briefs", "launch-04-attempt-4.json");
    expect(
      runCli(
        request("implementor.launch.prepare", {
          ...baseInput,
          artifact_path: exhaustedArtifactPath,
          attempt: 4,
        }),
        fixture.env,
      ).exitCode,
    ).toBe(0);
    expect(
      runCli(
        request("implementor.launch.record", {
          state_path: fixture.statePath,
          ticket: "04",
          attempt: 4,
          status: "failed",
          diagnostic: { stage: "start", exit_code: 2, stderr: "agent_name_taken" },
        }),
        fixture.env,
      ).exitCode,
    ).toBe(0);
    expect(
      runCli(
        request("infrastructure.retry.record", {
          state_path: fixture.statePath,
          ticket: "04",
          attempt: 4,
          failure: "launch",
          diagnostic: "agent_name_taken",
        }),
        fixture.env,
      ).exitCode,
    ).toBe(0);

    const exhaustedArtifact = JSON.parse(readFileSync(exhaustedArtifactPath, "utf8")) as {
      launch: { prompt: { args: string[] } };
    };
    const promptText = exhaustedArtifact.launch.prompt.args[3]!;
    exhaustedArtifact.launch.prompt.args = [
      "agent",
      "prompt",
      "--wait",
      "--until",
      "working",
      "--timeout",
      "300000",
      "--",
      "pci-04",
      promptText,
    ];
    writeFileSync(exhaustedArtifactPath, `${JSON.stringify(exhaustedArtifact, null, 2)}\n`);

    const socket = join(fixture.root, "herdr.sock");
    let observedPane = "workspace:p9";
    const server = createServer((connection) => {
      let buffered = "";
      connection.on("data", (chunk) => {
        buffered += chunk.toString();
        for (const line of buffered.split("\n").slice(0, -1)) {
          const message = JSON.parse(line) as { method: string };
          if (message.method === "session.snapshot") {
            writeLine(connection, recoverySnapshot("pci-04", observedPane, "idle"));
          }
        }
        buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
      });
    });
    await listen(server, socket);
    const recoveryInput = {
      state_path: fixture.statePath,
      ticket: "04",
      socket_path: socket,
      timeout_ms: 500,
      user_authorized: true,
      diagnostic: "Herdr 0.9.1 prompt argv compatibility defect",
      recovered_at: "2026-09-19T20:00:00Z",
    };
    const exhausted = readFileSync(fixture.statePath, "utf8");

    const terminalRecord = runCli(
      request("implementor.launch.record", {
        state_path: fixture.statePath,
        ticket: "04",
        attempt: 4,
        status: "started",
        diagnostic: null,
      }),
      fixture.env,
    );
    expect(terminalRecord.exitCode).toBe(1);
    expect(terminalRecord.stdout.errors).toEqual([
      {
        code: "implementor.outcome_not_recordable",
        message: "Launch attempt 4 is in terminal or retry phase `retry exhausted`.",
        remediation:
          "Use the explicit compatibility recovery operation before recording an exhausted launch.",
      },
    ]);
    expect(readFileSync(fixture.statePath, "utf8")).toBe(exhausted);

    const unauthorized = runCli(
      request("implementor.launch.recover", { ...recoveryInput, user_authorized: false }),
      fixture.env,
    );
    expect(unauthorized.exitCode).toBe(2);
    expect(readFileSync(fixture.statePath, "utf8")).toBe(exhausted);

    const mismatched = await runCliAsync(
      request("implementor.launch.recover", recoveryInput),
      fixture.env,
    );
    expect(mismatched.exitCode).toBe(1);
    expect(mismatched.stdout.errors).toEqual([
      {
        code: "herdr.worker_pane_mismatch",
        message: "Worker `pci-04` is in pane `workspace:p9`, not recorded pane `workspace:p4`.",
        remediation:
          "Refresh run state only through an explicit pane-migration operation before recovery.",
      },
    ]);
    expect(readFileSync(fixture.statePath, "utf8")).toBe(exhausted);

    observedPane = "workspace:p4";
    const recovered = await runCliAsync(
      request("implementor.launch.recover", recoveryInput),
      fixture.env,
    );
    expect(recovered.exitCode).toBe(0);
    expect(recovered.stderr).toBe("");
    expect(recovered.stdout.result).toEqual({
      ticket: "04",
      attempt: 4,
      recovered: false,
      status: "working",
      phase: "working",
      prompt: {
        command: "herdr",
        args: [
          "agent",
          "prompt",
          "pci-04",
          "/skill:implement implement ticket 04",
          "--wait",
          "--timeout",
          "300000",
        ],
      },
      worker: { session: "pci-04", pane_id: "workspace:p4", status: "idle" },
      recovery: {
        user_authorized: true,
        cause: "coordinator compatibility defect",
        diagnostic: "Herdr 0.9.1 prompt argv compatibility defect",
        recovered_at: "2026-09-19T20:00:00Z",
      },
    });
    const persisted = readFileSync(fixture.statePath, "utf8");
    expect(
      persisted.includes("| 04 | pi | openai-codex/gpt-5.6-sol | high | 0 | - | working | - |"),
    ).toBe(true);
    expect(persisted.includes("Attempt: 4")).toBe(true);
    expect(persisted.includes("Retry: 3 of 3")).toBe(true);
    expect(persisted.includes("Phase: working")).toBe(true);
    expect(persisted.includes("Last diagnostic: launch attempt 4: agent_name_taken")).toBe(true);
    expect(persisted.includes("Recovery authorization: user")).toBe(true);
    expect(persisted.includes("Recovery cause: coordinator compatibility defect")).toBe(true);
    expect(
      persisted.includes("Recovery diagnostic: Herdr 0.9.1 prompt argv compatibility defect"),
    ).toBe(true);
    expect(persisted.includes("Recovered at: 2026-09-19T20:00:00Z")).toBe(true);

    const idempotent = await runCliAsync(
      request("implementor.launch.recover", recoveryInput),
      fixture.env,
    );
    expect(idempotent.exitCode).toBe(0);
    expect((idempotent.stdout.result as { recovered: boolean }).recovered).toBe(true);
    expect(readFileSync(fixture.statePath, "utf8")).toBe(persisted);
  });
});
