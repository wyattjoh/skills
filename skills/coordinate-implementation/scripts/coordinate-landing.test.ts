import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_ENV_KEYS, spawnGit } from "./lib/git.ts";

const CLI = join(import.meta.dir, "coordinate.ts");
const decoder = new TextDecoder();

type CliResult = {
  exitCode: number;
  stdout: Record<string, unknown>;
  stderr: string;
};

type LandingFixture = {
  root: string;
  repositoryPath: string;
  worktreePath: string;
  statePath: string;
  branch: string;
};

const runCli = (
  operation: string,
  input: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): CliResult => {
  const child = Bun.spawnSync([process.execPath, CLI], {
    env,
    stdin: Buffer.from(JSON.stringify({ schema_version: 1, operation, input })),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: child.exitCode,
    stdout: JSON.parse(decoder.decode(child.stdout).trim()) as Record<string, unknown>,
    stderr: decoder.decode(child.stderr),
  };
};

const commit = (
  directory: string,
  path: string,
  contents: string,
  message: string,
  env: Record<string, string | undefined> = process.env,
): string => {
  writeFileSync(join(directory, path), contents);
  expect(spawnGit(["add", path], { cwd: directory, env }).exitCode).toBe(0);
  expect(spawnGit(["commit", "-q", "-m", message], { cwd: directory, env }).exitCode).toBe(0);
  return spawnGit(["rev-parse", "HEAD"], { cwd: directory, env }).stdout.trim();
};

const stateText = (
  fixture: Omit<LandingFixture, "statePath">,
  env: Record<string, string | undefined> = process.env,
): string => `# landing run

Schema version: 1

Prefix:          landing
Base:            main
Base sha:        ${spawnGit(["rev-parse", "main"], { cwd: fixture.repositoryPath, env }).stdout.trim()}
Mode:            parallel
Parallel cap:    2
Branch template: ticket-NN

Implementor:
  harness: pi
  model: openai/test
  effort: high

Reviewer:
  harness: claude
  model: sonnet
  effort: medium

## Repository policy

\`\`\`json
${JSON.stringify(
  {
    instruction_files: ["CLAUDE.md"],
    worktree: {
      kind: "native",
      tool: "git",
      root: join(fixture.root, "worktrees"),
      create_argv: null,
    },
    branch_naming: "ticket-NN",
    setup_argvs: [],
    cleanup: "native-safe",
    remote: "local-only",
    remote_sync_argv: null,
    commit: { commits: "multiple", fixes: "append" },
  },
  null,
  2,
)}
\`\`\`

## Review policy

\`\`\`json
${JSON.stringify(
  {
    instruction_files: ["CLAUDE.md"],
    ci_files: [],
    gates: [{ name: "test", argv: [process.execPath, "-e", "process.exit(0)"] }],
    no_executable_gates: false,
    safety_constraints: ["Do not push."],
    no_additional_safety_constraints: false,
    gate_execution: { claude: "background-allowed", pi: "synchronous" },
    self_review: "standards-spec-single-session",
    max_infrastructure_attempts: 3,
    retry_delays_seconds: [1, 2],
  },
  null,
  2,
)}
\`\`\`

## Tickets

| NN | harness | model | effort | rounds | esc | status | sha |
| -- | ------- | ----- | ------ | ------ | --- | ------ | --- |
| 07 | pi | openai/test | high | 0 | - | review | - |
| 08 | pi | openai/test | high | 0 | - | review | - |

## Active tickets

### 07

Worktree: ${fixture.worktreePath}
Branch: ${fixture.branch}
Implementor: {"harness":"pi","model":"openai/test","effort":"high"}
Implement skill: /implement
Session: landing-07
Tab: implement landing 07
Pane: work:p7
Artifact: ${join(fixture.root, "run", "briefs", "launch-07.json")}
Attempt: 1
Retry: 0 of 3
Phase: committed, awaiting review
Last diagnostic: none

## Review evidence

## Decisions

- setup

## Retained landed branches
`;

const makeFixture = (env: Record<string, string | undefined> = process.env): LandingFixture => {
  const root = mkdtempSync(join(tmpdir(), "coordinate-landing-"));
  const repositoryPath = join(root, "repository");
  const worktreePath = join(root, "worktrees", "ticket-07");
  const branch = "ticket-07";
  mkdirSync(repositoryPath, { recursive: true });
  expect(spawnGit(["init", "-q", "-b", "main"], { cwd: repositoryPath, env }).exitCode).toBe(0);
  expect(
    spawnGit(["config", "user.name", "Test User"], { cwd: repositoryPath, env }).exitCode,
  ).toBe(0);
  expect(
    spawnGit(["config", "user.email", "test@example.com"], { cwd: repositoryPath, env }).exitCode,
  ).toBe(0);
  commit(repositoryPath, "base.txt", "base\n", "base", env);
  mkdirSync(join(root, "worktrees"), { recursive: true });
  expect(
    spawnGit(["worktree", "add", "-q", "-b", branch, worktreePath, "main"], {
      cwd: repositoryPath,
      env,
    }).exitCode,
  ).toBe(0);
  const statePath = join(root, "run", "RESUME.md");
  mkdirSync(join(root, "run", "briefs"), { recursive: true });
  writeFileSync(statePath, stateText({ root, repositoryPath, worktreePath, branch }, env));
  return { root, repositoryPath, worktreePath, statePath, branch };
};

const markReadyToLand = (
  fixture: LandingFixture,
  cycle = 0,
): {
  standards: string;
  spec: string;
  selfReview: string;
} => {
  const reviews = join(fixture.root, "run", "reviews");
  mkdirSync(reviews, { recursive: true });
  const gateEvidence = join(reviews, `07-cycle-${cycle}-test-gate.json`);
  const gate = runCli("gate.record", {
    state_path: fixture.statePath,
    evidence_path: gateEvidence,
    worktree_path: fixture.worktreePath,
    ticket: "07",
    round: cycle,
    name: "test",
    attempt: 1,
    status: "passed",
    exit_code: 0,
    stdout: "test passed\n",
    stderr: "",
    completed_at: `2026-09-19T02:${String(10 + cycle).padStart(2, "0")}:00Z`,
  });
  expect(gate.exitCode).toBe(0);
  const baseSha = spawnGit(["rev-parse", "main"], { cwd: fixture.repositoryPath }).stdout.trim();
  const evidence: Partial<Record<"standards" | "spec", string>> = {};
  for (const axis of ["standards", "spec"] as const) {
    const artifactPath = join(reviews, `07-cycle-${cycle}-${axis}-attempt-1.json`);
    const reportPath = join(reviews, `07-cycle-${cycle}-${axis}-attempt-1.md`);
    const launched = runCli("review.launch.prepare", {
      state_path: fixture.statePath,
      previous_artifact_path: null,
      artifact_path: artifactPath,
      report_path: reportPath,
      ticket: "07",
      round: cycle,
      axis,
      worktree_path: fixture.worktreePath,
      branch: fixture.branch,
      base_ref: baseSha,
      pane: `workspace:${axis === "standards" ? "p1" : "p2"}`,
      role: { harness: "claude", model: "sonnet", effort: "medium" },
      context_paths: axis === "standards" ? ["CLAUDE.md"] : ["spec.md", "ticket-07.md"],
      landed_tickets: [],
      gate_evidence_paths: [gateEvidence],
      attempt: 1,
    });
    expect(launched.exitCode).toBe(0);
    const recorded = runCli("review.launch.record", {
      state_path: fixture.statePath,
      artifact_path: artifactPath,
      status: "completed",
      report: `# ${axis}\n\nPASS\n`,
      diagnostic: null,
      completed_at: `2026-09-19T02:${String(15 + cycle).padStart(2, "0")}:00Z`,
    });
    expect(recorded.exitCode).toBe(0);
    evidence[axis] = `${reportPath}.json`;
  }
  const standards = evidence.standards!;
  const spec = evidence.spec!;
  const selfReview = join(reviews, `07-cycle-${cycle}-self-review.md`);
  const finalized = runCli("review.round.finalize", {
    state_path: fixture.statePath,
    ticket: "07",
    round: cycle,
    standards_evidence_path: standards,
    spec_evidence_path: spec,
    self_review_path: selfReview,
    self_review_method: "standards-spec-single-session",
    self_review_report: "## Standards\n\nPASS\n\n## Spec\n\nPASS\n",
    fix_request_path: join(fixture.root, "run", "briefs", `fixes-07-cycle-${cycle}.md`),
    completed_at: `2026-09-19T02:${String(20 + cycle).padStart(2, "0")}:00Z`,
  });
  expect(finalized.exitCode).toBe(0);
  expect((finalized.stdout.result as { action: string }).action).toBe("land");
  return { standards, spec, selfReview };
};

describe("portable synchronization and landing", () => {
  it("documents the landed helper interfaces and serialized state", () => {
    const skill = readFileSync(join(import.meta.dir, "..", "SKILL.md"), "utf8");
    const helper = readFileSync(join(import.meta.dir, "..", "references", "helper-cli.md"), "utf8");
    const procedure = readFileSync(
      join(import.meta.dir, "..", "references", "review-and-land.md"),
      "utf8",
    );
    const resume = readFileSync(
      join(import.meta.dir, "..", "references", "resume-format.md"),
      "utf8",
    );

    expect(skill).toContain("`landing.synchronize`");
    expect(skill).toContain("`landing.conflict.record`");
    expect(skill).toContain("`landing.complete`");
    expect(helper).toContain("## `landing.synchronize`");
    expect(helper).toContain("## `landing.conflict.record`");
    expect(helper).toContain("## `landing.complete`");
    expect(procedure).toContain("latest local integration branch");
    expect(procedure).toContain("`--force`");
    expect(resume).toContain("## Serialized finalization");
    expect(resume).toContain("## Landed evidence");
  });

  it("synchronizes multiple commits against the local integration branch without a remote", () => {
    const fixture = makeFixture();
    commit(fixture.worktreePath, "one.txt", "one\n", "one");
    const ticketTip = commit(fixture.worktreePath, "two.txt", "two\n", "two");

    const result = runCli("landing.synchronize", {
      state_path: fixture.statePath,
      repository_path: fixture.repositoryPath,
      worktree_path: fixture.worktreePath,
      ticket: "07",
      remote_sync_argv: null,
      completed_at: "2026-09-19T02:00:00Z",
    });

    const base = spawnGit(["rev-parse", "main"], { cwd: fixture.repositoryPath }).stdout.trim();
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.result).toEqual({
      ticket: "07",
      action: "run-gates",
      phase: "gates",
      base_branch: "main",
      base_sha: base,
      ticket_sha: ticketTip,
      review_range: `${base}..${ticketTip}`,
      commit_count: 2,
      commit_policy: { commits: "multiple", fixes: "append" },
      remote_sync_argv: null,
      conflicts: [],
      cycle: 0,
    });
    expect(spawnGit(["remote"], { cwd: fixture.repositoryPath }).stdout).toBe("");
    expect(readFileSync(fixture.statePath, "utf8")).toContain("## Serialized finalization");
    expect(existsSync(fixture.worktreePath)).toBe(true);
  });

  it("serializes finalization while other implementors remain active", () => {
    const fixture = makeFixture();
    commit(fixture.worktreePath, "ticket.txt", "ticket\n", "ticket");
    const markdown = readFileSync(fixture.statePath, "utf8");
    writeFileSync(
      fixture.statePath,
      markdown.replace(
        "## Review evidence",
        `## Serialized finalization

\`\`\`json
${JSON.stringify(
  {
    ticket: "08",
    cycle: 0,
    phase: "gates",
    base_branch: "main",
    base_sha: null,
    ticket_sha: null,
    review_range: null,
    commit_count: null,
    commit_policy: { commits: "multiple", fixes: "append" },
    remote_sync_argv: null,
    conflicts: [],
    previous_ticket_sha: null,
    standards_evidence_path: null,
    spec_evidence_path: null,
    self_review_path: null,
    completed_at: "2026-09-19T02:00:00Z",
  },
  null,
  2,
)}
\`\`\`

## Review evidence`,
      ),
    );

    const result = runCli("landing.synchronize", {
      state_path: fixture.statePath,
      repository_path: fixture.repositoryPath,
      worktree_path: fixture.worktreePath,
      ticket: "07",
      remote_sync_argv: null,
      completed_at: "2026-09-19T02:01:00Z",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.errors).toEqual([
      {
        code: "landing.serialized",
        message: "Ticket `08` already owns serialized finalization in phase `gates`.",
        remediation:
          "Keep other implementors running, but wait for that ticket to leave synchronization, gates, review, and landing.",
      },
    ]);
    expect(spawnGit(["rev-parse", "HEAD"], { cwd: fixture.worktreePath }).exitCode).toBe(0);
  });

  it("rejects repository and worktree paths that do not match the active runtime", () => {
    const fixture = makeFixture();
    commit(fixture.worktreePath, "ticket.txt", "ticket\n", "ticket");

    const result = runCli("landing.synchronize", {
      state_path: fixture.statePath,
      repository_path: fixture.repositoryPath,
      worktree_path: fixture.repositoryPath,
      ticket: "07",
      remote_sync_argv: null,
      completed_at: "2026-09-19T02:01:00Z",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.errors).toEqual([
      {
        code: "landing.runtime_mismatch",
        message: "Supplied repository or worktree does not match the active ticket runtime.",
        remediation: "Use the recorded integration checkout, worktree, and branch for this ticket.",
      },
    ]);
  });

  it("fails closed when serialized state is locked by a live caller", () => {
    const fixture = makeFixture();
    writeFileSync(
      `${fixture.statePath}.state-lock`,
      `${JSON.stringify({
        pid: process.pid,
        token: "live-owner",
        created_at: "2026-09-19T02:01:00Z",
      })}\n`,
    );

    const result = runCli("landing.synchronize", {
      state_path: fixture.statePath,
      repository_path: fixture.repositoryPath,
      worktree_path: fixture.worktreePath,
      ticket: "07",
      remote_sync_argv: null,
      completed_at: "2026-09-19T02:01:00Z",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.errors).toEqual([
      {
        code: "landing.state_busy",
        message:
          "Could not update serialized finalization state: Run state is being updated by another process.",
        remediation: "Verify RESUME.md is writable, then retry the same operation.",
      },
    ]);
  });

  it("sanitizes inherited Git location variables for fixtures and landing CLI operations", () => {
    expect(GIT_ENV_KEYS).toEqual([
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_COMMON_DIR",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_CEILING_DIRECTORIES",
    ]);
    const root = mkdtempSync(join(tmpdir(), "coordinate-landing-decoy-"));
    const decoy = join(root, "decoy");
    mkdirSync(decoy);
    expect(spawnGit(["init", "-q", "-b", "decoy"], { cwd: decoy }).exitCode).toBe(0);
    expect(spawnGit(["config", "user.name", "Test User"], { cwd: decoy }).exitCode).toBe(0);
    expect(spawnGit(["config", "user.email", "test@example.com"], { cwd: decoy }).exitCode).toBe(0);
    commit(decoy, "guard.txt", "guard\n", "guard");
    const decoyGitDir = join(decoy, ".git");
    const contaminated = {
      ...process.env,
      GIT_DIR: decoyGitDir,
      GIT_WORK_TREE: decoy,
      GIT_INDEX_FILE: join(decoyGitDir, "index"),
      GIT_COMMON_DIR: decoyGitDir,
      GIT_OBJECT_DIRECTORY: join(decoyGitDir, "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(decoyGitDir, "objects"),
      GIT_CEILING_DIRECTORIES: root,
    };

    const fixture = makeFixture(contaminated);
    commit(fixture.worktreePath, "ticket.txt", "ticket\n", "ticket", contaminated);
    const result = runCli(
      "landing.synchronize",
      {
        state_path: fixture.statePath,
        repository_path: fixture.repositoryPath,
        worktree_path: fixture.worktreePath,
        ticket: "07",
        remote_sync_argv: null,
        completed_at: "2026-09-19T02:02:00Z",
      },
      contaminated,
    );

    expect(result.exitCode).toBe(0);
    expect(
      spawnGit(["rev-list", "--count", fixture.branch], {
        cwd: fixture.repositoryPath,
      }).stdout.trim(),
    ).toBe("2");
    expect(spawnGit(["rev-list", "--count", "decoy"], { cwd: decoy }).stdout.trim()).toBe("1");
    expect(spawnGit(["ls-tree", "--name-only", "decoy"], { cwd: decoy }).stdout.trim()).toBe(
      "guard.txt",
    );
  });

  it("runs only the remote synchronization command required by repository policy", () => {
    const fixture = makeFixture();
    commit(fixture.worktreePath, "ticket.txt", "ticket\n", "ticket");
    const marker = join(fixture.root, "remote-command-ran");
    const authorizedCommand = [
      process.execPath,
      "-e",
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ok')`,
    ];
    writeFileSync(
      fixture.statePath,
      readFileSync(fixture.statePath, "utf8").replace(
        '"remote": "local-only",\n  "remote_sync_argv": null',
        `"remote": "repository",\n  "remote_sync_argv": ${JSON.stringify(authorizedCommand)}`,
      ),
    );

    const missing = runCli("landing.synchronize", {
      state_path: fixture.statePath,
      repository_path: fixture.repositoryPath,
      worktree_path: fixture.worktreePath,
      ticket: "07",
      remote_sync_argv: null,
      completed_at: "2026-09-19T02:02:00Z",
    });
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout.errors).toEqual([
      {
        code: "landing.remote_policy_mismatch",
        message: "Repository synchronization policy requires an exact remote command.",
        remediation:
          "Pass the argument array authorized by repository instructions or explicit run policy.",
      },
    ]);

    const arbitrary = runCli("landing.synchronize", {
      state_path: fixture.statePath,
      repository_path: fixture.repositoryPath,
      worktree_path: fixture.worktreePath,
      ticket: "07",
      remote_sync_argv: [process.execPath, "-e", "process.exit(0)"],
      completed_at: "2026-09-19T02:03:00Z",
    });
    expect(arbitrary.exitCode).toBe(1);
    expect(arbitrary.stdout.errors).toEqual([
      {
        code: "landing.remote_policy_mismatch",
        message: "Remote synchronization command does not match persisted repository policy.",
        remediation: "Pass the exact remote_sync_argv persisted in Repository policy.",
      },
    ]);
    expect(existsSync(marker)).toBe(false);

    const synchronized = runCli("landing.synchronize", {
      state_path: fixture.statePath,
      repository_path: fixture.repositoryPath,
      worktree_path: fixture.worktreePath,
      ticket: "07",
      remote_sync_argv: authorizedCommand,
      completed_at: "2026-09-19T02:04:00Z",
    });
    expect(synchronized.exitCode).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("ok");
    expect((synchronized.stdout.result as { remote_sync_argv: string[] }).remote_sync_argv).toEqual(
      authorizedCommand,
    );
  });

  it("records textual conflict resolution as coordinator work", () => {
    const fixture = makeFixture();
    commit(fixture.worktreePath, "base.txt", "ticket change\n", "ticket change");
    commit(fixture.repositoryPath, "base.txt", "base change\n", "base change");

    const synchronized = runCli("landing.synchronize", {
      state_path: fixture.statePath,
      repository_path: fixture.repositoryPath,
      worktree_path: fixture.worktreePath,
      ticket: "07",
      remote_sync_argv: null,
      completed_at: "2026-09-19T02:04:00Z",
    });
    expect((synchronized.stdout.result as { action: string }).action).toBe("resolve-conflicts");
    expect((synchronized.stdout.result as { conflicts: string[] }).conflicts).toEqual(["base.txt"]);

    writeFileSync(join(fixture.worktreePath, "base.txt"), "base and ticket\n");
    expect(spawnGit(["add", "base.txt"], { cwd: fixture.worktreePath }).exitCode).toBe(0);
    expect(
      spawnGit(["-c", "core.editor=true", "rebase", "--continue"], {
        cwd: fixture.worktreePath,
      }).exitCode,
    ).toBe(0);

    const recorded = runCli("landing.conflict.record", {
      state_path: fixture.statePath,
      ticket: "07",
      classification: "textual",
      decision: null,
      user_authorized: false,
      completed_at: "2026-09-19T02:05:00Z",
    });
    const base = spawnGit(["rev-parse", "main"], { cwd: fixture.repositoryPath }).stdout.trim();
    const tip = spawnGit(["rev-parse", "HEAD"], { cwd: fixture.worktreePath }).stdout.trim();
    expect(recorded.exitCode).toBe(0);
    expect(recorded.stdout.result).toEqual({
      ticket: "07",
      classification: "textual",
      action: "run-gates",
      phase: "gates",
      base_sha: base,
      ticket_sha: tip,
      review_range: `${base}..${tip}`,
      commit_count: 1,
      decision: null,
      user_authorized: false,
    });
    const settledState = readFileSync(fixture.statePath, "utf8");
    expect(settledState).toContain("Phase: gates");

    const stale = runCli("landing.conflict.record", {
      state_path: fixture.statePath,
      ticket: "07",
      classification: "substantive",
      decision: null,
      user_authorized: false,
      completed_at: "2026-09-19T02:06:00Z",
    });
    expect(stale.exitCode).toBe(1);
    expect(stale.stdout.errors).toEqual([
      {
        code: "landing.conflict_not_pending",
        message: "Ticket `07` has no pending serialized conflict to classify.",
        remediation:
          "Synchronize the ticket and resolve its recorded conflict before classifying it.",
      },
    ]);
    expect(readFileSync(fixture.statePath, "utf8")).toBe(settledState);
  });

  it("does not classify a resolved conflict while another caller owns the state lock", () => {
    const fixture = makeFixture();
    commit(fixture.worktreePath, "base.txt", "ticket change\n", "ticket change");
    commit(fixture.repositoryPath, "base.txt", "base change\n", "base change");
    expect(
      runCli("landing.synchronize", {
        state_path: fixture.statePath,
        repository_path: fixture.repositoryPath,
        worktree_path: fixture.worktreePath,
        ticket: "07",
        remote_sync_argv: null,
        completed_at: "2026-09-19T02:05:00Z",
      }).exitCode,
    ).toBe(0);
    writeFileSync(join(fixture.worktreePath, "base.txt"), "resolved\n");
    expect(spawnGit(["add", "base.txt"], { cwd: fixture.worktreePath }).exitCode).toBe(0);
    expect(
      spawnGit(["-c", "core.editor=true", "rebase", "--continue"], {
        cwd: fixture.worktreePath,
      }).exitCode,
    ).toBe(0);
    const stateBefore = readFileSync(fixture.statePath, "utf8");
    writeFileSync(
      `${fixture.statePath}.state-lock`,
      `${JSON.stringify({
        pid: process.pid,
        token: "conflict-owner",
        created_at: "2026-09-19T02:05:00Z",
      })}\n`,
    );

    const result = runCli("landing.conflict.record", {
      state_path: fixture.statePath,
      ticket: "07",
      classification: "textual",
      decision: null,
      user_authorized: false,
      completed_at: "2026-09-19T02:06:00Z",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.errors).toEqual([
      {
        code: "landing.state_busy",
        message:
          "Could not update serialized finalization state: Run state is being updated by another process.",
        remediation: "Verify RESUME.md is writable, then retry the same operation.",
      },
    ]);
    expect(readFileSync(fixture.statePath, "utf8")).toBe(stateBefore);
  });

  it("waits for and records user authority on scope decisions", () => {
    const fixture = makeFixture();
    commit(fixture.worktreePath, "base.txt", "ticket change\n", "ticket change");
    commit(fixture.repositoryPath, "base.txt", "base change\n", "base change");
    expect(
      runCli("landing.synchronize", {
        state_path: fixture.statePath,
        repository_path: fixture.repositoryPath,
        worktree_path: fixture.worktreePath,
        ticket: "07",
        remote_sync_argv: null,
        completed_at: "2026-09-19T02:05:00Z",
      }).exitCode,
    ).toBe(0);
    writeFileSync(join(fixture.worktreePath, "base.txt"), "authorized scope\n");
    expect(spawnGit(["add", "base.txt"], { cwd: fixture.worktreePath }).exitCode).toBe(0);
    expect(
      spawnGit(["-c", "core.editor=true", "rebase", "--continue"], {
        cwd: fixture.worktreePath,
      }).exitCode,
    ).toBe(0);

    const waiting = runCli("landing.conflict.record", {
      state_path: fixture.statePath,
      ticket: "07",
      classification: "scope",
      decision: null,
      user_authorized: false,
      completed_at: "2026-09-19T02:06:00Z",
    });
    expect(waiting.exitCode).toBe(0);
    expect((waiting.stdout.result as { action: string }).action).toBe("await-user");
    expect(
      readFileSync(fixture.statePath, "utf8").includes("scope decision (user authorized)"),
    ).toBe(false);

    const authorized = runCli("landing.conflict.record", {
      state_path: fixture.statePath,
      ticket: "07",
      classification: "scope",
      decision: "Keep the combined behavior and narrow ticket 08 to verification.",
      user_authorized: true,
      completed_at: "2026-09-19T02:07:00Z",
    });
    expect(authorized.exitCode).toBe(0);
    expect((authorized.stdout.result as { action: string }).action).toBe("run-gates");
    expect(readFileSync(fixture.statePath, "utf8")).toContain(
      "ticket 07 scope decision (user authorized): Keep the combined behavior and narrow ticket 08 to verification.",
    );
  });

  it("returns substantive conflict adaptation to the bound implementor", () => {
    const fixture = makeFixture();
    commit(fixture.worktreePath, "base.txt", "ticket change\n", "ticket change");
    commit(fixture.repositoryPath, "base.txt", "base change\n", "base change");
    expect(
      runCli("landing.synchronize", {
        state_path: fixture.statePath,
        repository_path: fixture.repositoryPath,
        worktree_path: fixture.worktreePath,
        ticket: "07",
        remote_sync_argv: null,
        completed_at: "2026-09-19T02:06:00Z",
      }).exitCode,
    ).toBe(0);
    writeFileSync(join(fixture.worktreePath, "base.txt"), "adapted behavior\n");
    expect(spawnGit(["add", "base.txt"], { cwd: fixture.worktreePath }).exitCode).toBe(0);
    expect(
      spawnGit(["-c", "core.editor=true", "rebase", "--continue"], {
        cwd: fixture.worktreePath,
      }).exitCode,
    ).toBe(0);

    const recorded = runCli("landing.conflict.record", {
      state_path: fixture.statePath,
      ticket: "07",
      classification: "substantive",
      decision: null,
      user_authorized: false,
      completed_at: "2026-09-19T02:07:00Z",
    });

    expect(recorded.exitCode).toBe(0);
    expect((recorded.stdout.result as { action: string }).action).toBe("fix");
    expect((recorded.stdout.result as { phase: string }).phase).toBe("fixing");
    expect(readFileSync(fixture.statePath, "utf8")).toContain(
      "Phase: substantive conflict adaptation requires implementor fix",
    );
  });

  it("recovers a refused fast-forward through synchronization, re-review, and safe cleanup", () => {
    const fixture = makeFixture();
    commit(fixture.worktreePath, "ticket.txt", "ticket\n", "ticket");
    expect(
      runCli("landing.synchronize", {
        state_path: fixture.statePath,
        repository_path: fixture.repositoryPath,
        worktree_path: fixture.worktreePath,
        ticket: "07",
        remote_sync_argv: null,
        completed_at: "2026-09-19T02:08:00Z",
      }).exitCode,
    ).toBe(0);
    markReadyToLand(fixture);
    commit(fixture.repositoryPath, "concurrent.txt", "concurrent\n", "concurrent landing");

    const refused = runCli("landing.complete", {
      state_path: fixture.statePath,
      repository_path: fixture.repositoryPath,
      worktree_path: fixture.worktreePath,
      evidence_path: join(fixture.root, "run", "reviews", "07-landed.json"),
      ticket: "07",
      cleanup_argv: null,
      runtime_closed: true,
      completed_at: "2026-09-19T02:09:00Z",
    });
    expect(refused.exitCode).toBe(0);
    expect((refused.stdout.result as { action: string }).action).toBe("resynchronize");
    expect(existsSync(fixture.worktreePath)).toBe(true);
    expect(readFileSync(fixture.statePath, "utf8")).toContain('"phase": "resynchronize"');

    const synchronized = runCli("landing.synchronize", {
      state_path: fixture.statePath,
      repository_path: fixture.repositoryPath,
      worktree_path: fixture.worktreePath,
      ticket: "07",
      remote_sync_argv: null,
      completed_at: "2026-09-19T02:10:00Z",
    });
    expect(synchronized.exitCode).toBe(0);
    expect((synchronized.stdout.result as { cycle: number }).cycle).toBe(1);
    const reviews = markReadyToLand(fixture, 1);
    const landedTip = spawnGit(["rev-parse", "HEAD"], { cwd: fixture.worktreePath }).stdout.trim();

    const closeRuntime = runCli("landing.complete", {
      state_path: fixture.statePath,
      repository_path: fixture.repositoryPath,
      worktree_path: fixture.worktreePath,
      evidence_path: join(fixture.root, "run", "reviews", "07-landed.json"),
      ticket: "07",
      cleanup_argv: null,
      runtime_closed: false,
      completed_at: "2026-09-19T02:11:00Z",
    });
    expect(closeRuntime.exitCode).toBe(0);
    expect(closeRuntime.stdout.result).toEqual({
      ticket: "07",
      action: "close-runtime",
      phase: "ready-to-land",
      base_sha: landedTip,
      ticket_sha: landedTip,
      cycle: 1,
    });
    expect(existsSync(fixture.worktreePath)).toBe(true);
    expect(existsSync(join(fixture.root, "run", "reviews", "07-landed.json"))).toBe(false);

    const landed = runCli("landing.complete", {
      state_path: fixture.statePath,
      repository_path: fixture.repositoryPath,
      worktree_path: fixture.worktreePath,
      evidence_path: join(fixture.root, "run", "reviews", "07-landed.json"),
      ticket: "07",
      cleanup_argv: null,
      runtime_closed: true,
      completed_at: "2026-09-19T02:12:00Z",
    });

    expect(landed.exitCode).toBe(0);
    expect(landed.stdout.result).toEqual({
      ticket: "07",
      action: "schedule",
      phase: "landed",
      landed_tip: landedTip,
      base_sha: landedTip,
      review_evidence: {
        standards: reviews.standards,
        spec: reviews.spec,
        self_review: reviews.selfReview,
      },
      cleanup: {
        kind: "native-safe",
        argv: ["git", "worktree", "remove", fixture.worktreePath],
        runtime_closed: true,
        worktree_removed: true,
        branch_retained: true,
      },
      evidence_path: join(fixture.root, "run", "reviews", "07-landed.json"),
    });
    expect(existsSync(fixture.worktreePath)).toBe(false);
    expect(
      spawnGit(["show-ref", "--verify", `refs/heads/${fixture.branch}`], {
        cwd: fixture.repositoryPath,
      }).exitCode,
    ).toBe(0);
    const state = readFileSync(fixture.statePath, "utf8");
    expect(state).toContain(`| 07 | pi | openai/test | high | 0 | - | landed | ${landedTip} |`);
    expect(state).toContain(`- ${fixture.branch} (${landedTip})`);
    expect(state.includes("## Serialized finalization")).toBe(false);
    expect(state.includes("### 07")).toBe(false);
    expect(
      JSON.parse(readFileSync(join(fixture.root, "run", "reviews", "07-landed.json"), "utf8")),
    ).toEqual({
      schema_version: 1,
      ticket: "07",
      landed_tip: landedTip,
      base_sha: landedTip,
      branch: fixture.branch,
      review_evidence: {
        standards: reviews.standards,
        spec: reviews.spec,
        self_review: reviews.selfReview,
      },
      cleanup: {
        kind: "native-safe",
        argv: ["git", "worktree", "remove", fixture.worktreePath],
        runtime_closed: true,
        worktree_removed: true,
        branch_retained: true,
      },
      completed_at: "2026-09-19T02:12:00Z",
    });
  });

  it("recovers when the base advances between the ancestry check and fast-forward", () => {
    const fixture = makeFixture();
    commit(fixture.worktreePath, "ticket.txt", "ticket\n", "ticket");
    expect(
      runCli("landing.synchronize", {
        state_path: fixture.statePath,
        repository_path: fixture.repositoryPath,
        worktree_path: fixture.worktreePath,
        ticket: "07",
        remote_sync_argv: null,
        completed_at: "2026-09-19T02:11:00Z",
      }).exitCode,
    ).toBe(0);
    markReadyToLand(fixture);

    const bin = join(fixture.root, "race-bin");
    const marker = join(fixture.root, "race-injected");
    const realGit = Bun.which("git");
    expect(typeof realGit).toBe("string");
    mkdirSync(bin);
    const wrapper = join(bin, "git");
    writeFileSync(
      wrapper,
      `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const { existsSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const env = { ...process.env };
for (const key of ${JSON.stringify(GIT_ENV_KEYS)}) delete env[key];
if (args[0] === "merge" && args[1] === "--ff-only" && !existsSync(env.RACE_MARKER)) {
  writeFileSync(env.RACE_MARKER, "injected\\n");
  writeFileSync("race.txt", "race\\n");
  spawnSync(env.REAL_GIT, ["add", "race.txt"], { env, stdio: "inherit" });
  spawnSync(env.REAL_GIT, ["commit", "-q", "-m", "race landing"], { env, stdio: "inherit" });
}
const result = spawnSync(env.REAL_GIT, args, { env, stdio: "inherit" });
process.exit(result.status ?? 1);
`,
    );
    chmodSync(wrapper, 0o755);

    const result = runCli(
      "landing.complete",
      {
        state_path: fixture.statePath,
        repository_path: fixture.repositoryPath,
        worktree_path: fixture.worktreePath,
        evidence_path: join(fixture.root, "run", "reviews", "07-landed.json"),
        ticket: "07",
        cleanup_argv: null,
        runtime_closed: true,
        completed_at: "2026-09-19T02:12:00Z",
      },
      {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        REAL_GIT: realGit!,
        RACE_MARKER: marker,
      },
    );

    expect(result.exitCode).toBe(0);
    expect((result.stdout.result as { action: string }).action).toBe("resynchronize");
    expect(existsSync(fixture.worktreePath)).toBe(true);
    expect(readFileSync(fixture.statePath, "utf8")).toContain('"phase": "resynchronize"');
  });

  it("rejects landed evidence paths outside the run directory", () => {
    const fixture = makeFixture();
    commit(fixture.worktreePath, "ticket.txt", "ticket\n", "ticket");
    expect(
      runCli("landing.synchronize", {
        state_path: fixture.statePath,
        repository_path: fixture.repositoryPath,
        worktree_path: fixture.worktreePath,
        ticket: "07",
        remote_sync_argv: null,
        completed_at: "2026-09-19T02:12:00Z",
      }).exitCode,
    ).toBe(0);
    markReadyToLand(fixture);

    const result = runCli("landing.complete", {
      state_path: fixture.statePath,
      repository_path: fixture.repositoryPath,
      worktree_path: fixture.worktreePath,
      evidence_path: join(fixture.root, "outside-landed.json"),
      ticket: "07",
      cleanup_argv: null,
      runtime_closed: false,
      completed_at: "2026-09-19T02:13:00Z",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.errors).toEqual([
      {
        code: "landing.evidence_outside_run",
        message: "Landed evidence path must resolve inside the run directory.",
        remediation: "Choose a run-local path under reviews/.",
      },
    ]);
    expect(existsSync(join(fixture.root, "outside-landed.json"))).toBe(false);
  });

  it("refuses cleanup while the landed worktree is dirty", () => {
    const fixture = makeFixture();
    commit(fixture.worktreePath, "ticket.txt", "ticket\n", "ticket");
    expect(
      runCli("landing.synchronize", {
        state_path: fixture.statePath,
        repository_path: fixture.repositoryPath,
        worktree_path: fixture.worktreePath,
        ticket: "07",
        remote_sync_argv: null,
        completed_at: "2026-09-19T02:12:00Z",
      }).exitCode,
    ).toBe(0);
    markReadyToLand(fixture);
    expect(
      runCli("landing.complete", {
        state_path: fixture.statePath,
        repository_path: fixture.repositoryPath,
        worktree_path: fixture.worktreePath,
        evidence_path: join(fixture.root, "run", "reviews", "07-landed.json"),
        ticket: "07",
        cleanup_argv: null,
        runtime_closed: false,
        completed_at: "2026-09-19T02:13:00Z",
      }).exitCode,
    ).toBe(0);
    writeFileSync(join(fixture.worktreePath, "dirty.txt"), "dirty\n");

    const result = runCli("landing.complete", {
      state_path: fixture.statePath,
      repository_path: fixture.repositoryPath,
      worktree_path: fixture.worktreePath,
      evidence_path: join(fixture.root, "run", "reviews", "07-landed.json"),
      ticket: "07",
      cleanup_argv: null,
      runtime_closed: true,
      completed_at: "2026-09-19T02:14:00Z",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.errors).toEqual([
      {
        code: "landing.cleanup_dirty",
        message: "Landed worktree is not clean, so cleanup was refused.",
        remediation: "Inspect and clean the worktree without force, then retry completion.",
      },
    ]);
    expect(existsSync(fixture.worktreePath)).toBe(true);
  });

  it("uses an exact repository cleanup command instead of native fallback", () => {
    const fixture = makeFixture();
    commit(fixture.worktreePath, "ticket.txt", "ticket\n", "ticket");
    writeFileSync(
      fixture.statePath,
      readFileSync(fixture.statePath, "utf8").replace(
        '"cleanup": "native-safe"',
        '"cleanup": "repository"',
      ),
    );
    expect(
      runCli("landing.synchronize", {
        state_path: fixture.statePath,
        repository_path: fixture.repositoryPath,
        worktree_path: fixture.worktreePath,
        ticket: "07",
        remote_sync_argv: null,
        completed_at: "2026-09-19T02:12:00Z",
      }).exitCode,
    ).toBe(0);
    markReadyToLand(fixture);

    const result = runCli("landing.complete", {
      state_path: fixture.statePath,
      repository_path: fixture.repositoryPath,
      worktree_path: fixture.worktreePath,
      evidence_path: join(fixture.root, "run", "reviews", "07-landed.json"),
      ticket: "07",
      cleanup_argv: ["git", "worktree", "remove", fixture.worktreePath],
      runtime_closed: true,
      completed_at: "2026-09-19T02:13:00Z",
    });

    expect(result.exitCode).toBe(0);
    expect(
      (
        result.stdout.result as {
          cleanup: {
            kind: string;
            argv: string[];
            runtime_closed: boolean;
            worktree_removed: boolean;
            branch_retained: boolean;
          };
        }
      ).cleanup,
    ).toEqual({
      kind: "repository",
      argv: ["git", "worktree", "remove", fixture.worktreePath],
      runtime_closed: true,
      worktree_removed: true,
      branch_retained: true,
    });
    expect(existsSync(fixture.worktreePath)).toBe(false);
    expect(
      spawnGit(["show-ref", "--verify", `refs/heads/${fixture.branch}`], {
        cwd: fixture.repositoryPath,
      }).exitCode,
    ).toBe(0);
  });

  it("enforces append-only fix commits when repository policy is silent", () => {
    const appended = makeFixture();
    const reviewedTip = commit(appended.worktreePath, "ticket.txt", "ticket\n", "ticket");
    expect(
      runCli("landing.synchronize", {
        state_path: appended.statePath,
        repository_path: appended.repositoryPath,
        worktree_path: appended.worktreePath,
        ticket: "07",
        remote_sync_argv: null,
        completed_at: "2026-09-19T02:12:00Z",
      }).exitCode,
    ).toBe(0);
    writeFileSync(
      appended.statePath,
      readFileSync(appended.statePath, "utf8")
        .replace('"phase": "gates"', '"phase": "fixing"')
        .replace('"previous_ticket_sha": null', `"previous_ticket_sha": "${reviewedTip}"`),
    );
    commit(appended.worktreePath, "fix.txt", "fix\n", "append fix");
    const appendResult = runCli("landing.synchronize", {
      state_path: appended.statePath,
      repository_path: appended.repositoryPath,
      worktree_path: appended.worktreePath,
      ticket: "07",
      remote_sync_argv: null,
      completed_at: "2026-09-19T02:13:00Z",
    });
    expect(appendResult.exitCode).toBe(0);
    expect((appendResult.stdout.result as { commit_count: number }).commit_count).toBe(2);

    const amended = makeFixture();
    const originalTip = commit(amended.worktreePath, "ticket.txt", "ticket\n", "ticket");
    expect(
      runCli("landing.synchronize", {
        state_path: amended.statePath,
        repository_path: amended.repositoryPath,
        worktree_path: amended.worktreePath,
        ticket: "07",
        remote_sync_argv: null,
        completed_at: "2026-09-19T02:14:00Z",
      }).exitCode,
    ).toBe(0);
    writeFileSync(
      amended.statePath,
      readFileSync(amended.statePath, "utf8")
        .replace('"phase": "gates"', '"phase": "fixing"')
        .replace('"previous_ticket_sha": null', `"previous_ticket_sha": "${originalTip}"`),
    );
    writeFileSync(join(amended.worktreePath, "ticket.txt"), "amended\n");
    expect(spawnGit(["add", "ticket.txt"], { cwd: amended.worktreePath }).exitCode).toBe(0);
    expect(
      spawnGit(["commit", "-q", "--amend", "--no-edit"], {
        cwd: amended.worktreePath,
      }).exitCode,
    ).toBe(0);
    const amendResult = runCli("landing.synchronize", {
      state_path: amended.statePath,
      repository_path: amended.repositoryPath,
      worktree_path: amended.worktreePath,
      ticket: "07",
      remote_sync_argv: null,
      completed_at: "2026-09-19T02:15:00Z",
    });
    expect(amendResult.exitCode).toBe(1);
    expect(amendResult.stdout.errors).toEqual([
      {
        code: "landing.fix_policy_violated",
        message: "The fix round did not append a commit to the previously reviewed ticket tip.",
        remediation:
          "Return the ticket to its bound implementor and apply the persisted append fix policy.",
      },
    ]);
  });

  it("accepts explicit amend and squash fix policy overrides", () => {
    const amended = makeFixture();
    writeFileSync(
      amended.statePath,
      readFileSync(amended.statePath, "utf8").replace('"fixes": "append"', '"fixes": "amend"'),
    );
    const reviewedTip = commit(amended.worktreePath, "ticket.txt", "ticket\n", "ticket");
    expect(
      runCli("landing.synchronize", {
        state_path: amended.statePath,
        repository_path: amended.repositoryPath,
        worktree_path: amended.worktreePath,
        ticket: "07",
        remote_sync_argv: null,
        completed_at: "2026-09-19T02:16:00Z",
      }).exitCode,
    ).toBe(0);
    writeFileSync(
      amended.statePath,
      readFileSync(amended.statePath, "utf8")
        .replace('"phase": "gates"', '"phase": "fixing"')
        .replace('"previous_ticket_sha": null', `"previous_ticket_sha": "${reviewedTip}"`),
    );
    writeFileSync(join(amended.worktreePath, "ticket.txt"), "amended\n");
    expect(spawnGit(["add", "ticket.txt"], { cwd: amended.worktreePath }).exitCode).toBe(0);
    expect(
      spawnGit(["commit", "-q", "--amend", "--no-edit"], { cwd: amended.worktreePath }).exitCode,
    ).toBe(0);
    const amendResult = runCli("landing.synchronize", {
      state_path: amended.statePath,
      repository_path: amended.repositoryPath,
      worktree_path: amended.worktreePath,
      ticket: "07",
      remote_sync_argv: null,
      completed_at: "2026-09-19T02:17:00Z",
    });
    expect(amendResult.exitCode).toBe(0);
    expect(amendResult.stdout.result).toMatchObject({
      action: "run-gates",
      commit_count: 1,
      commit_policy: { commits: "multiple", fixes: "amend" },
    });

    const squashed = makeFixture();
    writeFileSync(
      squashed.statePath,
      readFileSync(squashed.statePath, "utf8")
        .replace('"commits": "multiple"', '"commits": "single"')
        .replace('"fixes": "append"', '"fixes": "squash"'),
    );
    commit(squashed.worktreePath, "one.txt", "one\n", "one");
    commit(squashed.worktreePath, "two.txt", "two\n", "two");
    const shapeFix = runCli("landing.synchronize", {
      state_path: squashed.statePath,
      repository_path: squashed.repositoryPath,
      worktree_path: squashed.worktreePath,
      ticket: "07",
      remote_sync_argv: null,
      completed_at: "2026-09-19T02:18:00Z",
    });
    expect(shapeFix.exitCode).toBe(0);
    expect((shapeFix.stdout.result as { action: string }).action).toBe("fix-commits");
    expect(spawnGit(["reset", "--soft", "main"], { cwd: squashed.worktreePath }).exitCode).toBe(0);
    expect(
      spawnGit(["commit", "-q", "-m", "squashed fix"], { cwd: squashed.worktreePath }).exitCode,
    ).toBe(0);
    const squashResult = runCli("landing.synchronize", {
      state_path: squashed.statePath,
      repository_path: squashed.repositoryPath,
      worktree_path: squashed.worktreePath,
      ticket: "07",
      remote_sync_argv: null,
      completed_at: "2026-09-19T02:19:00Z",
    });
    expect(squashResult.exitCode).toBe(0);
    expect(squashResult.stdout.result).toMatchObject({
      action: "run-gates",
      commit_count: 1,
      commit_policy: { commits: "single", fixes: "squash" },
    });
  });

  it("returns a fix action when repository commit shape requires one commit", () => {
    const fixture = makeFixture();
    commit(fixture.worktreePath, "one.txt", "one\n", "one");
    const ticketTip = commit(fixture.worktreePath, "two.txt", "two\n", "two");
    writeFileSync(
      fixture.statePath,
      readFileSync(fixture.statePath, "utf8").replace(
        '"commits": "multiple"',
        '"commits": "single"',
      ),
    );

    const result = runCli("landing.synchronize", {
      state_path: fixture.statePath,
      repository_path: fixture.repositoryPath,
      worktree_path: fixture.worktreePath,
      ticket: "07",
      remote_sync_argv: null,
      completed_at: "2026-09-19T02:04:00Z",
    });

    const base = spawnGit(["rev-parse", "main"], { cwd: fixture.repositoryPath }).stdout.trim();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.result).toEqual({
      ticket: "07",
      action: "fix-commits",
      phase: "fixing",
      base_branch: "main",
      base_sha: base,
      ticket_sha: ticketTip,
      review_range: `${base}..${ticketTip}`,
      commit_count: 2,
      commit_policy: { commits: "single", fixes: "append" },
      remote_sync_argv: null,
      conflicts: [],
      cycle: 0,
    });
    expect(readFileSync(fixture.statePath, "utf8")).toContain("Phase: commit policy fix required");
  });
});
