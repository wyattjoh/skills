import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnGit } from "./lib/git.ts";
import { createFakeHerdrEnv } from "./test-herdr.ts";

const CLI = join(import.meta.dir, "coordinate.ts");
const decoder = new TextDecoder();
const HERDR_ENV = createFakeHerdrEnv();
const OLD_ROLE = { harness: "claude", model: "opus", effort: "medium" } as const;
const OLD_REVIEW_ROLE = { harness: "claude", model: "sonnet", effort: "medium" } as const;
const PI_IMPLEMENTOR = { harness: "pi", model: "openai/test", effort: "high" } as const;
const PI_REVIEWER = { harness: "pi", model: "openai/reviewer-test", effort: "medium" } as const;

type CliResult = {
  exitCode: number;
  stdout: Record<string, unknown>;
  stderr: string;
};

type Fixture = {
  root: string;
  runPath: string;
  statePath: string;
  worktreePath: string;
  branch: string;
  ticket: string;
  artifactPath: string;
  piSkillPath?: string;
};

const runCli = (
  request: unknown,
  env: Record<string, string | undefined> = HERDR_ENV,
): CliResult => {
  const child = Bun.spawnSync([process.execPath, CLI], {
    env,
    stdin: Buffer.from(JSON.stringify(request)),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = JSON.parse(decoder.decode(child.stdout).trim()) as Record<string, unknown>;
  return {
    exitCode: child.exitCode,
    stdout,
    stderr: decoder.decode(child.stderr),
  };
};

const request = (operation: string, input: Record<string, unknown>) => ({
  schema_version: 1,
  operation,
  input,
});

const makeWorktree = (root: string, branch: string, extraCommit = false): string => {
  const worktreePath = join(root, "worktree");
  mkdirSync(worktreePath, { recursive: true });
  expect(spawnGit(["init", "-q", "-b", branch], { cwd: worktreePath }).exitCode).toBe(0);
  expect(spawnGit(["config", "user.name", "Test User"], { cwd: worktreePath }).exitCode).toBe(0);
  expect(
    spawnGit(["config", "user.email", "test@example.com"], { cwd: worktreePath }).exitCode,
  ).toBe(0);
  writeFileSync(join(worktreePath, "tracked.txt"), "base\n");
  expect(spawnGit(["add", "tracked.txt"], { cwd: worktreePath }).exitCode).toBe(0);
  expect(spawnGit(["commit", "-q", "-m", "base"], { cwd: worktreePath }).exitCode).toBe(0);
  if (extraCommit) {
    writeFileSync(join(worktreePath, "tracked.txt"), "ticket implementation\n");
    expect(spawnGit(["add", "tracked.txt"], { cwd: worktreePath }).exitCode).toBe(0);
    expect(
      spawnGit(["commit", "-q", "-m", "ticket implementation"], { cwd: worktreePath }).exitCode,
    ).toBe(0);
  }
  return worktreePath;
};

const finalizationBlock = (ticket: string, baseSha: string, head: string): string =>
  `## Serialized finalization\n\n\`\`\`json\n${JSON.stringify(
    {
      ticket,
      cycle: 0,
      phase: "gates",
      base_branch: "main",
      base_sha: baseSha,
      ticket_sha: head,
      review_range: `${baseSha}..${head}`,
      commit_count: 1,
      commit_policy: { commits: "multiple", fixes: "append" },
      remote_sync_argv: null,
      conflicts: [],
      previous_ticket_sha: null,
      standards_evidence_path: null,
      spec_evidence_path: null,
      self_review_path: null,
      completed_at: "2026-09-23T11:53:27Z",
    },
    null,
    2,
  )}\n\`\`\`\n`;

const makeImplementorFixture = (
  ticket: string,
  phase: "working" | "gates",
  options: { dirtyFiles?: number; extraCommit?: boolean } = {},
): Fixture & { finalization: string | undefined } => {
  const root = mkdtempSync(join(tmpdir(), "coordinate-migration-"));
  const runPath = join(root, "run");
  mkdirSync(join(runPath, "briefs"), { recursive: true });
  const branch = `ticket-${ticket}`;
  const worktreePath = makeWorktree(root, branch, options.extraCommit ?? phase === "gates");
  for (let index = 0; index < (options.dirtyFiles ?? 0); index += 1) {
    writeFileSync(join(worktreePath, `uncommitted-${index + 1}.txt`), `preserve ${index + 1}\n`);
  }
  const statePath = join(runPath, "RESUME.md");
  const artifactPath = join(runPath, "briefs", `launch-${ticket}.json`);
  const head = spawnGit(["rev-parse", "HEAD"], { cwd: worktreePath }).stdout.trim();
  const baseSha =
    (options.extraCommit ?? phase === "gates")
      ? spawnGit(["rev-parse", "HEAD^"], { cwd: worktreePath }).stdout.trim()
      : head;
  expect(spawnGit(["branch", "main", baseSha], { cwd: worktreePath }).exitCode).toBe(0);
  const piSkillPath = join(root, "pi-implement", "SKILL.md");
  mkdirSync(join(root, "pi-implement"), { recursive: true });
  writeFileSync(piSkillPath, "# Test implement skill\n");
  const finalization = phase === "gates" ? finalizationBlock(ticket, baseSha, head) : undefined;
  const state = `# migration run\n\nSchema version: 1\n\nPrefix: migration\n\nBase: main\n\nImplementor:\n  harness: pi\n  model: openai/test\n  effort: high\n\nReviewer:\n  harness: pi\n  model: openai/reviewer-test\n  effort: medium\n\n## Tickets\n| NN | harness | model | effort | rounds | esc | status | sha |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| ${ticket} | claude | opus | medium | 0 | - | working | - |\n\n## Active tickets\n\n### ${ticket}\n\nWorktree: ${worktreePath}\nBranch: ${branch}\nImplementor: ${JSON.stringify(OLD_ROLE)}\nImplement skill: /implement\nSession: claude-${ticket}\nTab: implement ${ticket}\nPane: workspace:pold${ticket}\nArtifact: ${artifactPath}\nAttempt: 1\nRetry: 0 of 3\nLast diagnostic: none\nPhase: ${phase}\n\n${finalization ?? ""}## Repository policy\n\n\`\`\`json\n${JSON.stringify({ remote: "local-only", remote_sync_argv: null, cleanup: "native-safe", commit: { commits: "multiple", fixes: "append" } }, null, 2)}\n\`\`\`\n\n## Review policy\n\n\`\`\`json\n${JSON.stringify(
    {
      instruction_files: ["CLAUDE.md"],
      ci_files: [".github/workflows/ci.yml"],
      gates: [
        { name: "format", argv: ["bun", "run", "format:check"] },
        { name: "test", argv: ["bun", "test"] },
      ],
      no_executable_gates: false,
      safety_constraints: ["Do not push."],
      no_additional_safety_constraints: false,
      gate_execution: { claude: "background-allowed", pi: "synchronous" },
      self_review: "standards-spec-single-session",
      max_infrastructure_attempts: 4,
      retry_delays_seconds: [1, 2, 4],
    },
    null,
    2,
  )}\n\`\`\`\n\n## Decisions\n\n- Preserve existing run history.\n`;
  writeFileSync(statePath, state);
  writeFileSync(
    artifactPath,
    `${JSON.stringify(
      {
        schema_version: 1,
        ticket,
        cwd: worktreePath,
        branch,
        role: OLD_ROLE,
        implement_skill_path: null,
        session: `claude-${ticket}`,
        tab: `implement ${ticket}`,
        pane: `workspace:pold${ticket}`,
        attempt: 1,
        max_attempts: 3,
      },
      null,
      2,
    )}\n`,
  );
  return {
    root,
    runPath,
    statePath,
    worktreePath,
    branch,
    ticket,
    artifactPath,
    piSkillPath,
    finalization,
  };
};

const implementorMigrationRequest = (
  fixture: Fixture & { finalization: string | undefined },
  overrides: Record<string, unknown> = {},
) =>
  request("implementor.runtime.migrate", {
    state_path: fixture.statePath,
    ticket: fixture.ticket,
    expected_binding: {
      worktree_path: fixture.worktreePath,
      branch: fixture.branch,
      role: OLD_ROLE,
      implement_skill_path: "/implement",
      session: `claude-${fixture.ticket}`,
      tab: `implement ${fixture.ticket}`,
      pane: `workspace:pold${fixture.ticket}`,
      artifact_path: fixture.artifactPath,
      attempt: 1,
      retry: "0 of 3",
      phase: fixture.finalization === undefined ? "working" : "gates",
    },
    replacement_role: PI_IMPLEMENTOR,
    user_authorized: true,
    completed_at: "2026-09-23T12:00:00Z",
    ...overrides,
  });

const migrationRecoveryRequest = (fixture: Fixture) => {
  const evidencePath = join(
    fixture.runPath,
    "briefs",
    `implementor-runtime-migration-${fixture.ticket}.json`,
  );
  return request("implementor.runtime.migration.recover", {
    state_path: fixture.statePath,
    ticket: fixture.ticket,
    migration_evidence_sha256: createHash("sha256")
      .update(readFileSync(evidencePath, "utf8"))
      .digest("hex"),
    user_authorized: true,
    completed_at: "2026-09-23T12:05:00Z",
  });
};

const implementorLaunchRequest = (fixture: Fixture) =>
  request("implementor.launch.prepare", {
    state_path: fixture.statePath,
    artifact_path: join(fixture.runPath, "briefs", `pi-launch-${fixture.ticket}.json`),
    ticket: fixture.ticket,
    worktree_path: fixture.worktreePath,
    branch: fixture.branch,
    session: `pi-${fixture.ticket}`,
    tab: `implement ${fixture.ticket}`,
    pane: `workspace:pi${fixture.ticket}`,
    role: PI_IMPLEMENTOR,
    implement_skill_path: fixture.piSkillPath,
    prompt: `Continue ticket ${fixture.ticket} in the preserved worktree.`,
    attempt: 1,
    max_attempts: 3,
  });

const getFinalization = (state: string): string | null =>
  state.match(/^## Serialized finalization\s*\r?\n\r?\n```json\r?\n[\s\S]*?\r?\n```/mu)?.[0] ??
  null;

const recordPassingGates = (
  fixture: Fixture,
  attempt: number,
  fileSuffix: string,
  completedAt = `2026-09-23T12:${String(attempt).padStart(2, "0")}:00Z`,
): string[] => {
  const paths: string[] = [];
  for (const [name, argv] of [
    ["format", ["bun", "run", "format:check"]],
    ["test", ["bun", "test"]],
  ] as const) {
    const evidencePath = join(
      fixture.runPath,
      "reviews",
      `${fixture.ticket}-round-0-${name}-gate-attempt-${fileSuffix}.json`,
    );
    const result = runCli(
      request("gate.record", {
        state_path: fixture.statePath,
        evidence_path: evidencePath,
        worktree_path: fixture.worktreePath,
        ticket: fixture.ticket,
        round: 0,
        name,
        attempt,
        status: "passed",
        exit_code: 0,
        stdout: `${argv.join(" ")} passed\n`,
        stderr: "",
        completed_at: completedAt,
      }),
    );
    expect(result.exitCode).toBe(0);
    paths.push(evidencePath);
  }
  return paths;
};

type ReviewFixture = Fixture & {
  baseSha: string;
  firstGatePaths: string[];
  specArtifactPath: string;
};

const makeReviewFixture = (includeHistoricalTickets = false): ReviewFixture => {
  const root = mkdtempSync(join(tmpdir(), "coordinate-review-supersession-"));
  const runPath = join(root, "run");
  mkdirSync(join(runPath, "briefs"), { recursive: true });
  mkdirSync(join(runPath, "reviews"), { recursive: true });
  const ticket = "13";
  const branch = "ticket-13";
  const worktreePath = makeWorktree(root, branch, true);
  const baseSha = spawnGit(["rev-parse", "HEAD^"], { cwd: worktreePath }).stdout.trim();
  const head = spawnGit(["rev-parse", "HEAD"], { cwd: worktreePath }).stdout.trim();
  const statePath = join(runPath, "RESUME.md");
  const artifactPath = join(runPath, "reviews", "13-round-0-standards-attempt-1.json");
  const specArtifactPath = join(runPath, "reviews", "13-round-0-spec-attempt-1.json");
  const initialState = `# review migration run\n\nSchema version: 1\n\nPrefix: test\n\nImplementor:\n  harness: pi\n  model: openai/test\n  effort: high\n\nReviewer:\n  harness: claude\n  model: sonnet\n  effort: medium\n\n## Tickets\n| NN | harness | model | effort | rounds | esc | status | sha |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| 13 | pi | openai/test | high | 0 | - | queued | - |\n\n## Active tickets\n\n## Decisions\n\n- Preserve review provenance.\n`;
  writeFileSync(statePath, initialState);
  const policy = runCli(
    request("review.policy.prepare", {
      state_path: statePath,
      instruction_files: ["CLAUDE.md"],
      ci_files: [".github/workflows/ci.yml"],
      gates: [
        { name: "format", argv: ["bun", "run", "format:check"] },
        { name: "test", argv: ["bun", "test"] },
      ],
      no_executable_gates: false,
      safety_constraints: ["Do not push."],
      no_additional_safety_constraints: false,
    }),
  );
  expect(policy.exitCode).toBe(0);
  const preparedState = readFileSync(statePath, "utf8");
  const policyBlock = preparedState.match(/^## Review policy\s*\n\n```json\n[\s\S]*?\n```/mu)?.[0];
  expect(typeof policyBlock).toBe("string");
  const activeState = `# review migration run\n\nSchema version: 1\n\nPrefix: test\n\nImplementor:\n  harness: pi\n  model: openai/test\n  effort: high\n\nReviewer:\n  harness: claude\n  model: sonnet\n  effort: medium\n\n## Tickets\n| NN | harness | model | effort | rounds | esc | status | sha |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| 13 | pi | openai/test | high | 0 | - | review | ${head} |\n\n## Active tickets\n\n### 13\n\nWorktree: ${worktreePath}\nBranch: ${branch}\nImplementor: ${JSON.stringify(PI_IMPLEMENTOR)}\nSession: pi-13\nTab: implement 13\nPane: workspace:implementor-13\nArtifact: ${join(runPath, "briefs", "launch-13.json")}\nAttempt: 1\nRetry: 0 of 3\nLast diagnostic: none\nPhase: committed, awaiting review\n\n${finalizationBlock(ticket, baseSha, head)}\n${policyBlock}\n\n## Decisions\n\n- Preserve review provenance.\n`;
  writeFileSync(statePath, activeState);
  const fixture = {
    root,
    runPath,
    statePath,
    worktreePath,
    branch,
    ticket,
    artifactPath,
    baseSha,
    firstGatePaths: [] as string[],
    specArtifactPath,
  };
  fixture.firstGatePaths = recordPassingGates(fixture, 1, "1");
  if (includeHistoricalTickets) {
    for (let ticketNumber = 1; ticketNumber <= 62; ticketNumber += 1) {
      const historicalTicket = String(ticketNumber).padStart(2, "0");
      if (historicalTicket === ticket) continue;
      const historicalArtifactPath = join(
        runPath,
        "reviews",
        `historical-ticket-${historicalTicket}.json`,
      );
      writeFileSync(
        historicalArtifactPath,
        `${JSON.stringify(
          {
            schema_version: 1,
            kind: "coordinate-review-launch",
            state_path: statePath,
            artifact_path: historicalArtifactPath,
            report_path: historicalArtifactPath.replace(/\\.json$/u, ".md"),
            ticket: historicalTicket,
            round: 0,
            axis: "standards",
            worktree_path: worktreePath,
            branch,
            base_ref: baseSha,
            pane: `workspace:historical-${historicalTicket}`,
            reviewer: OLD_REVIEW_ROLE,
            context_paths: [],
            landed_tickets: [],
            gate_evidence_paths: [],
            attempt: 1,
            session: `historical-${historicalTicket}`,
            tab: `historical ${historicalTicket}`,
            status_before: "",
            reviewed_head: head,
            prompt: "Historical landed ticket review artifact.",
            launch: {
              start: { command: "herdr", args: [] },
              prompt: { command: "herdr", args: [] },
            },
          },
          null,
          2,
        )}\n`,
      );
    }
  }
  const launch = runCli(
    request("review.launch.prepare", {
      state_path: statePath,
      previous_artifact_path: null,
      artifact_path: artifactPath,
      report_path: join(runPath, "reviews", "13-round-0-standards-attempt-1.md"),
      ticket,
      round: 0,
      axis: "standards",
      worktree_path: worktreePath,
      branch,
      base_ref: baseSha,
      pane: "workspace:prev13standardsa1",
      role: OLD_REVIEW_ROLE,
      context_paths: ["CLAUDE.md", ".claude/rules/testing.md"],
      landed_tickets: ["01", "02", "03"],
      gate_evidence_paths: fixture.firstGatePaths,
      attempt: 1,
    }),
  );
  expect(launch.exitCode).toBe(0);
  const specLaunch = runCli(
    request("review.launch.prepare", {
      state_path: statePath,
      previous_artifact_path: null,
      artifact_path: specArtifactPath,
      report_path: join(runPath, "reviews", "13-round-0-spec-attempt-1.md"),
      ticket,
      round: 0,
      axis: "spec",
      worktree_path: worktreePath,
      branch,
      base_ref: baseSha,
      pane: "workspace:prev13speca1",
      role: OLD_REVIEW_ROLE,
      context_paths: [".scratch/run/spec.md", ".scratch/run/issues/13-review.md"],
      landed_tickets: ["01", "02", "03"],
      gate_evidence_paths: fixture.firstGatePaths,
      attempt: 1,
    }),
  );
  expect(specLaunch.exitCode).toBe(0);
  const stateWithOldReview = readFileSync(statePath, "utf8").replace(
    "Reviewer:\n  harness: claude\n  model: sonnet\n  effort: medium",
    `Reviewer:\n  harness: pi\n  model: ${PI_REVIEWER.model}\n  effort: ${PI_REVIEWER.effort}`,
  );
  writeFileSync(statePath, stateWithOldReview);
  return fixture;
};

const supersedeReviewerRequest = (
  fixture: ReviewFixture,
  axis: "standards" | "spec" = "standards",
) => {
  const artifactPath = axis === "standards" ? fixture.artifactPath : fixture.specArtifactPath;
  const artifactRaw = readFileSync(artifactPath, "utf8");
  const artifact = JSON.parse(artifactRaw) as Record<string, unknown>;
  return request("review.attempt.supersede", {
    state_path: fixture.statePath,
    artifact_path: artifactPath,
    expected_binding: {
      ticket: artifact.ticket,
      round: artifact.round,
      axis: artifact.axis,
      attempt: artifact.attempt,
      reviewer: artifact.reviewer,
      worktree_path: artifact.worktree_path,
      branch: artifact.branch,
      base_ref: artifact.base_ref,
      pane: artifact.pane,
      session: artifact.session,
      tab: artifact.tab,
      reviewed_head: artifact.reviewed_head,
      status_before: artifact.status_before,
      context_paths: artifact.context_paths,
      landed_tickets: artifact.landed_tickets,
      gate_evidence_paths: artifact.gate_evidence_paths,
      artifact_sha256: createHash("sha256").update(artifactRaw).digest("hex"),
    },
    user_authorized: true,
    reason: "The reviewer pane exited before producing a report.",
    completed_at: "2026-09-23T12:10:00Z",
  });
};

const retryReviewer = (
  fixture: ReviewFixture,
  gateEvidencePaths: string[],
  axis: "standards" | "spec" = "standards",
) => {
  const previousArtifactPath =
    axis === "standards" ? fixture.artifactPath : fixture.specArtifactPath;
  return request("review.launch.prepare", {
    state_path: fixture.statePath,
    previous_artifact_path: previousArtifactPath,
    artifact_path: join(fixture.runPath, "reviews", `13-round-0-${axis}-attempt-2.json`),
    report_path: join(fixture.runPath, "reviews", `13-round-0-${axis}-attempt-2.md`),
    ticket: fixture.ticket,
    round: 0,
    axis,
    worktree_path: fixture.worktreePath,
    branch: fixture.branch,
    base_ref: fixture.baseSha,
    pane: "workspace:prev13standardsa2",
    role: PI_REVIEWER,
    context_paths: ["CLAUDE.md", ".claude/rules/testing.md"],
    landed_tickets: ["01", "02", "03"],
    gate_evidence_paths: gateEvidencePaths,
    attempt: 2,
  });
};

describe("closed runtime migration", () => {
  it("migrates tickets 12, 13, and 16 in place while preserving artifacts and worktrees", () => {
    const cases = [
      { ticket: "12", phase: "working" as const, dirtyFiles: 12 },
      { ticket: "13", phase: "gates" as const, extraCommit: true },
      { ticket: "16", phase: "working" as const },
    ];
    for (const scenario of cases) {
      const fixture = makeImplementorFixture(scenario.ticket, scenario.phase, scenario);
      const originalState = readFileSync(fixture.statePath, "utf8");
      const originalArtifact = readFileSync(fixture.artifactPath, "utf8");
      const originalStatus = spawnGit(["status", "--porcelain=v1", "--untracked-files=all"], {
        cwd: fixture.worktreePath,
      }).stdout;
      const beforeFinalization = getFinalization(originalState);

      const result = runCli(implementorMigrationRequest(fixture));

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatchObject({
        ok: true,
        result: {
          ticket: scenario.ticket,
          action: "prepare-replacement",
          runtime_closed: true,
          worktree_path: fixture.worktreePath,
          branch: fixture.branch,
          old_role: OLD_ROLE,
          replacement_role: PI_IMPLEMENTOR,
          dirty_worktree_preserved: originalStatus.trim().length > 0,
          serialized_finalization_preserved: true,
        },
      });
      const migratedState = readFileSync(fixture.statePath, "utf8");
      expect(migratedState.includes(`### ${scenario.ticket}\n`)).toBe(false);
      expect(migratedState.includes(`| ${scenario.ticket} | pi | openai/test | high |`)).toBe(true);
      expect(migratedState.includes("Closed ticket runtimes")).toBe(true);
      expect(getFinalization(migratedState)).toBe(beforeFinalization);
      expect(readFileSync(fixture.artifactPath, "utf8")).toBe(originalArtifact);
      expect(
        spawnGit(["status", "--porcelain=v1", "--untracked-files=all"], {
          cwd: fixture.worktreePath,
        }).stdout,
      ).toBe(originalStatus);
      expect(
        existsSync(
          join(fixture.runPath, "briefs", `implementor-runtime-migration-${scenario.ticket}.json`),
        ),
      ).toBe(true);
    }
  });

  it("refuses a live pane and leaves state, artifact, and evidence untouched", () => {
    const fixture = makeImplementorFixture("12", "working", { dirtyFiles: 12 });
    const before = readFileSync(fixture.statePath, "utf8");
    const artifact = readFileSync(fixture.artifactPath, "utf8");
    const env = { ...HERDR_ENV, HERDR_TEST_LIVE_PANES: JSON.stringify(["workspace:pold12"]) };

    const result = runCli(implementorMigrationRequest(fixture), env);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "implementor.migration_runtime_live" }],
    });
    expect(readFileSync(fixture.statePath, "utf8")).toBe(before);
    expect(readFileSync(fixture.artifactPath, "utf8")).toBe(artifact);
    expect(
      existsSync(join(fixture.runPath, "briefs", "implementor-runtime-migration-12.json")),
    ).toBe(false);
  });

  it("rejects an old runtime binding that differs from the active ticket", () => {
    const fixture = makeImplementorFixture("16", "working");
    const before = readFileSync(fixture.statePath, "utf8");
    const input = implementorMigrationRequest(fixture);
    (input.input.expected_binding as Record<string, unknown>).pane = "workspace:pwrong";

    const result = runCli(input);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "implementor.migration_binding_mismatch" }],
    });
    expect(readFileSync(fixture.statePath, "utf8")).toBe(before);
    expect(
      existsSync(join(fixture.runPath, "briefs", "implementor-runtime-migration-16.json")),
    ).toBe(false);
  });

  it("rejects a replacement role that differs from the persisted Pi default", () => {
    const fixture = makeImplementorFixture("16", "working");
    const before = readFileSync(fixture.statePath, "utf8");

    const result = runCli(
      implementorMigrationRequest(fixture, {
        replacement_role: { harness: "pi", model: "openai/substitute", effort: "high" },
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "implementor.migration_role_mismatch" }],
    });
    expect(readFileSync(fixture.statePath, "utf8")).toBe(before);
    expect(
      existsSync(join(fixture.runPath, "briefs", "implementor-runtime-migration-16.json")),
    ).toBe(false);
  });

  it("rejects a dirty gates-phase worktree without changing serialized finalization", () => {
    const fixture = makeImplementorFixture("13", "gates", { dirtyFiles: 1, extraCommit: true });
    const before = readFileSync(fixture.statePath, "utf8");

    const result = runCli(implementorMigrationRequest(fixture));

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "implementor.migration_worktree_dirty" }],
    });
    expect(readFileSync(fixture.statePath, "utf8")).toBe(before);
    expect(getFinalization(readFileSync(fixture.statePath, "utf8"))).toBe(
      fixture.finalization?.trimEnd() ?? null,
    );
  });

  it("recovers a byte-identical authorized retry idempotently", () => {
    const fixture = makeImplementorFixture("16", "working");
    const input = implementorMigrationRequest(fixture);
    const first = runCli(input);
    expect(first.exitCode).toBe(0);
    const stateAfterFirst = readFileSync(fixture.statePath, "utf8");
    const evidencePath = join(fixture.runPath, "briefs", "implementor-runtime-migration-16.json");
    const evidenceAfterFirst = readFileSync(evidencePath, "utf8");

    const retry = runCli(input);

    expect(retry.exitCode).toBe(0);
    expect(retry.stdout).toMatchObject({ result: { recovered: true, runtime_closed: true } });
    expect(readFileSync(fixture.statePath, "utf8")).toBe(stateAfterFirst);
    expect(readFileSync(evidencePath, "utf8")).toBe(evidenceAfterFirst);
  });

  it("fails closed on an uncommitted migration sidecar and recovers it byte-identically", () => {
    const fixture = makeImplementorFixture("16", "working");
    const input = implementorMigrationRequest(fixture);
    expect(runCli(input).exitCode).toBe(0);
    const evidencePath = join(fixture.runPath, "briefs", "implementor-runtime-migration-16.json");
    const commitPath = `${evidencePath}.commit.json`;
    const heldCommitPath = `${commitPath}.pending`;
    renameSync(commitPath, heldCommitPath);

    const pendingLaunch = runCli(implementorLaunchRequest(fixture));
    expect(pendingLaunch.exitCode).toBe(1);
    expect(pendingLaunch.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "implementor.migration_pending" }],
    });

    const recovered = runCli(input);
    expect(recovered.exitCode).toBe(0);
    expect(recovered.stdout).toMatchObject({ result: { recovered: true } });
    expect(existsSync(commitPath)).toBe(true);
    expect(runCli(implementorLaunchRequest(fixture)).exitCode).toBe(0);

    const interrupted = makeImplementorFixture("12", "working", { dirtyFiles: 12 });
    const originalState = readFileSync(interrupted.statePath, "utf8");
    const interruptedRequest = implementorMigrationRequest(interrupted);
    expect(runCli(interruptedRequest).exitCode).toBe(0);
    const interruptedEvidence = join(
      interrupted.runPath,
      "briefs",
      "implementor-runtime-migration-12.json",
    );
    const interruptedCommit = `${interruptedEvidence}.commit.json`;
    renameSync(interruptedCommit, `${interruptedCommit}.pending`);
    writeFileSync(interrupted.statePath, originalState);
    expect(runCli(implementorLaunchRequest(interrupted)).exitCode).toBe(1);
    const stateRecovery = runCli(interruptedRequest);
    expect(stateRecovery.exitCode).toBe(0);
    expect(stateRecovery.stdout).toMatchObject({ result: { recovered: true } });
    expect(existsSync(interruptedCommit)).toBe(true);
    expect(runCli(implementorLaunchRequest(interrupted)).exitCode).toBe(0);
  });

  it("binds replacement launches to the exact migrated worktree and branch", () => {
    const fixture = makeImplementorFixture("12", "working", { dirtyFiles: 12 });
    expect(runCli(implementorMigrationRequest(fixture)).exitCode).toBe(0);
    writeFileSync(join(fixture.worktreePath, "uncommitted-1.txt"), "changed after migration\n");
    const changedSnapshot = runCli(implementorLaunchRequest(fixture));
    expect(changedSnapshot.exitCode).toBe(1);
    expect(changedSnapshot.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "implementor.migration_worktree_changed" }],
    });

    const alternateRoot = join(fixture.root, "alternate-root");
    const alternateWorktree = makeWorktree(alternateRoot, fixture.branch);
    const wrongWorktreeRequest = implementorLaunchRequest(fixture);
    (wrongWorktreeRequest.input as Record<string, unknown>).worktree_path = alternateWorktree;
    const wrongWorktree = runCli(wrongWorktreeRequest);
    expect(wrongWorktree.exitCode).toBe(1);
    expect(wrongWorktree.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "implementor.migration_launch_binding_mismatch" }],
    });

    expect(
      spawnGit(["checkout", "-q", "-b", "ticket-12-rebound"], { cwd: fixture.worktreePath })
        .exitCode,
    ).toBe(0);
    const wrongBranchRequest = implementorLaunchRequest(fixture);
    (wrongBranchRequest.input as Record<string, unknown>).branch = "ticket-12-rebound";
    const wrongBranch = runCli(wrongBranchRequest);
    expect(wrongBranch.exitCode).toBe(1);
    expect(wrongBranch.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "implementor.migration_launch_binding_mismatch" }],
    });
  });

  it("requires explicit recovery and landing synchronization before further gates or reviews", () => {
    const fixture = makeImplementorFixture("13", "gates", { extraCommit: true });
    const preMigrationGates = recordPassingGates(
      fixture,
      1,
      "pre-migration",
      "2099-09-23T12:01:00Z",
    );
    expect(runCli(implementorMigrationRequest(fixture)).exitCode).toBe(0);

    const unrecoveredLaunch = runCli(implementorLaunchRequest(fixture));
    expect(unrecoveredLaunch.exitCode).toBe(1);
    expect(unrecoveredLaunch.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "implementor.migration_recovery_required" }],
    });

    const recovery = runCli(migrationRecoveryRequest(fixture));
    expect(recovery.exitCode).toBe(0);
    expect(recovery.stdout).toMatchObject({
      ok: true,
      result: { phase: "resynchronize", recovered: false },
    });
    const finalization = JSON.parse(
      getFinalization(readFileSync(fixture.statePath, "utf8"))!.match(
        /```json\n([\s\S]*?)\n```/u,
      )![1]!,
    ) as Record<string, unknown>;
    expect(finalization.phase).toBe("resynchronize");

    expect(runCli(implementorLaunchRequest(fixture)).exitCode).toBe(0);
    const staleGate = runCli(
      request("gate.record", {
        state_path: fixture.statePath,
        evidence_path: join(fixture.runPath, "reviews", "premature-gate.json"),
        worktree_path: fixture.worktreePath,
        ticket: "13",
        round: 0,
        name: "format",
        attempt: 1,
        status: "passed",
        exit_code: 0,
        stdout: "format passed\n",
        stderr: "",
        completed_at: "2026-09-23T12:06:00Z",
      }),
    );
    expect(staleGate.exitCode).toBe(1);
    expect(staleGate.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.finalization_stale" }],
    });

    const baseSha = spawnGit(["rev-parse", "HEAD^"], { cwd: fixture.worktreePath }).stdout.trim();
    const prematureReview = runCli(
      request("review.launch.prepare", {
        state_path: fixture.statePath,
        previous_artifact_path: null,
        artifact_path: join(fixture.runPath, "reviews", "13-premature-review.json"),
        report_path: join(fixture.runPath, "reviews", "13-premature-review.md"),
        ticket: "13",
        round: 0,
        axis: "standards",
        worktree_path: fixture.worktreePath,
        branch: fixture.branch,
        base_ref: baseSha,
        pane: "workspace:premature13",
        role: PI_REVIEWER,
        context_paths: ["CLAUDE.md"],
        landed_tickets: [],
        gate_evidence_paths: [],
        attempt: 1,
      }),
    );
    expect(prematureReview.exitCode).toBe(1);
    expect(prematureReview.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.finalization_stale" }],
    });

    expect(JSON.parse(readFileSync(preMigrationGates[0]!, "utf8")).finalization_cycle).toBe(0);
    const synchronized = runCli(
      request("landing.synchronize", {
        state_path: fixture.statePath,
        repository_path: fixture.worktreePath,
        worktree_path: fixture.worktreePath,
        ticket: "13",
        remote_sync_argv: null,
        completed_at: "2026-09-23T12:07:00Z",
      }),
    );
    expect(synchronized.exitCode).toBe(0);
    expect(synchronized.stdout).toMatchObject({
      ok: true,
      result: { phase: "gates", cycle: 1 },
    });
    const stalePreMigrationGates = runCli(
      request("review.launch.prepare", {
        state_path: fixture.statePath,
        previous_artifact_path: null,
        artifact_path: join(fixture.runPath, "reviews", "13-stale-pre-migration.json"),
        report_path: join(fixture.runPath, "reviews", "13-stale-pre-migration.md"),
        ticket: "13",
        round: 0,
        axis: "standards",
        worktree_path: fixture.worktreePath,
        branch: fixture.branch,
        base_ref: baseSha,
        pane: "workspace:ppremigrate13",
        role: PI_REVIEWER,
        context_paths: ["CLAUDE.md"],
        landed_tickets: [],
        gate_evidence_paths: preMigrationGates,
        attempt: 1,
      }),
    );
    expect(stalePreMigrationGates.exitCode).toBe(1);
    expect(stalePreMigrationGates.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.migration_gates_stale" }],
    });
    const freshGates = recordPassingGates(fixture, 1, "post-recovery", "2000-09-23T12:08:00Z");
    expect(JSON.parse(readFileSync(freshGates[0]!, "utf8")).finalization_cycle).toBe(1);
    const freshReview = runCli(
      request("review.launch.prepare", {
        state_path: fixture.statePath,
        previous_artifact_path: null,
        artifact_path: join(fixture.runPath, "reviews", "13-round-0-standards-attempt-1.json"),
        report_path: join(fixture.runPath, "reviews", "13-round-0-standards-attempt-1.md"),
        ticket: "13",
        round: 0,
        axis: "standards",
        worktree_path: fixture.worktreePath,
        branch: fixture.branch,
        base_ref: baseSha,
        pane: "workspace:pfresh13",
        role: PI_REVIEWER,
        context_paths: ["CLAUDE.md"],
        landed_tickets: [],
        gate_evidence_paths: freshGates,
        attempt: 1,
      }),
    );
    expect(freshReview.exitCode).toBe(0);
  });
});

describe("interrupted reviewer supersession", () => {
  it("indexes only the active ticket among 62 live-like ticket artifacts", () => {
    const fixture = makeReviewFixture(true);
    const historicalArtifacts = readdirSync(join(fixture.runPath, "reviews")).filter((name) =>
      name.startsWith("historical-ticket-"),
    );

    expect(historicalArtifacts).toHaveLength(61);
    expect(existsSync(fixture.artifactPath)).toBe(true);
    expect(existsSync(fixture.specArtifactPath)).toBe(true);
  });

  it("binds a round-zero interrupted artifact to HEAD and base across finalization cycle one", () => {
    const fixture = makeReviewFixture();
    const state = readFileSync(fixture.statePath, "utf8");
    const finalizationBlockText = getFinalization(state);
    if (finalizationBlockText === null)
      throw new Error("Serialized finalization block is missing.");
    const jsonStart = finalizationBlockText.indexOf("```json\n") + "```json\n".length;
    const jsonEnd = finalizationBlockText.lastIndexOf("\n```");
    const finalization = JSON.parse(finalizationBlockText.slice(jsonStart, jsonEnd)) as Record<
      string,
      unknown
    >;
    finalization.cycle = 1;
    const replaceFinalization = (value: Record<string, unknown>): string =>
      state.replace(
        finalizationBlockText,
        `${finalizationBlockText.slice(0, jsonStart)}${JSON.stringify(value, null, 2)}${finalizationBlockText.slice(jsonEnd)}`,
      );
    const cycleOneState = replaceFinalization(finalization);
    const staleBase = {
      ...finalization,
      base_sha: "other-base",
      review_range: `other-base..${String(finalization.ticket_sha)}`,
    };
    writeFileSync(fixture.statePath, replaceFinalization(staleBase));
    const staleBaseResult = runCli(supersedeReviewerRequest(fixture, "standards"));
    expect(staleBaseResult.exitCode).toBe(1);
    expect(staleBaseResult.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.supersession_finalization_stale" }],
    });

    const staleHead = {
      ...finalization,
      ticket_sha: "other-head",
      review_range: `${fixture.baseSha}..other-head`,
    };
    writeFileSync(fixture.statePath, replaceFinalization(staleHead));
    const staleHeadResult = runCli(supersedeReviewerRequest(fixture, "standards"));
    expect(staleHeadResult.exitCode).toBe(1);
    expect(staleHeadResult.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.supersession_finalization_stale" }],
    });

    writeFileSync(fixture.statePath, cycleOneState);
    const result = runCli(supersedeReviewerRequest(fixture, "standards"));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatchObject({
      ok: true,
      result: { ticket: "13", round: 0, status: "superseded", next_attempt: 2 },
    });
    const artifact = JSON.parse(readFileSync(fixture.artifactPath, "utf8")) as Record<
      string,
      unknown
    >;
    const evidence = JSON.parse(
      readFileSync(
        `${join(fixture.runPath, "reviews", "13-round-0-standards-attempt-1.md")}.json`,
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(artifact).toMatchObject({
      ticket: "13",
      round: 0,
      base_ref: fixture.baseSha,
      reviewed_head: spawnGit(["rev-parse", "HEAD"], { cwd: fixture.worktreePath }).stdout.trim(),
    });
    expect(evidence).toMatchObject({
      head_before: artifact.reviewed_head,
      head_after: artifact.reviewed_head,
      supersession_generation: 1,
    });
    const finalizationAfterSupersession = readFileSync(fixture.statePath, "utf8");
    expect(finalizationAfterSupersession).toContain('"cycle": 1');
    expect(finalizationAfterSupersession).toContain(`"base_sha": "${fixture.baseSha}"`);
    expect(finalizationAfterSupersession).toContain(
      `"ticket_sha": "${artifact.reviewed_head as string}"`,
    );
    expect(finalizationAfterSupersession).toContain(
      `"review_range": "${fixture.baseSha}..${artifact.reviewed_head as string}"`,
    );
  });

  it("requires a machine-observed closed pane and preserves prior artifacts", () => {
    const fixture = makeReviewFixture();
    const input = supersedeReviewerRequest(fixture);
    const beforeState = readFileSync(fixture.statePath, "utf8");
    const oldArtifact = readFileSync(fixture.artifactPath, "utf8");
    const reportPath = join(fixture.runPath, "reviews", "13-round-0-standards-attempt-1.md");
    const evidencePath = `${reportPath}.json`;

    const live = runCli(input, {
      ...HERDR_ENV,
      HERDR_TEST_LIVE_PANES: JSON.stringify(["workspace:prev13standardsa1"]),
    });

    expect(live.exitCode).toBe(1);
    expect(live.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.supersession_runtime_live" }],
    });
    expect(readFileSync(fixture.statePath, "utf8")).toBe(beforeState);
    expect(readFileSync(fixture.artifactPath, "utf8")).toBe(oldArtifact);
    expect(existsSync(reportPath)).toBe(false);
    expect(existsSync(evidencePath)).toBe(false);

    const closed = runCli(input);

    expect(closed.exitCode).toBe(0);
    expect(closed.stdout).toMatchObject({
      ok: true,
      result: {
        ticket: "13",
        status: "superseded",
        action: "retry",
        next_attempt: 2,
        old_reviewer: OLD_REVIEW_ROLE,
        replacement_reviewer: PI_REVIEWER,
        user_authorized: true,
        runtime_closed: true,
        pane_id: "workspace:prev13standardsa1",
        gate_rerun_required: true,
        recovered: false,
      },
    });
    expect(readFileSync(fixture.artifactPath, "utf8")).toBe(oldArtifact);
    expect(existsSync(reportPath)).toBe(false);
    expect(JSON.parse(readFileSync(evidencePath, "utf8"))).toMatchObject({
      status: "superseded",
      verdict: null,
      action: "retry",
      supersession: {
        user_authorized: true,
        artifact_sha256: createHash("sha256").update(oldArtifact).digest("hex"),
        pane_id: "workspace:prev13standardsa1",
        pane_closed: true,
        replacement_reviewer: PI_REVIEWER,
      },
    });
    expect(readFileSync(fixture.statePath, "utf8").includes("attempt 1: superseded;")).toBe(true);

    const lateReport = runCli(
      request("review.launch.record", {
        state_path: fixture.statePath,
        artifact_path: fixture.artifactPath,
        status: "completed",
        report: "# Standards review\n\nPASS\n",
        diagnostic: null,
        completed_at: "2026-09-23T12:11:00Z",
      }),
    );
    expect(lateReport.exitCode).toBe(1);
    expect(lateReport.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.attempt_superseded" }],
    });
    expect(existsSync(reportPath)).toBe(false);
  });

  it("hash-binds four legacy passing gates at baseline generation zero only for supersession", () => {
    const fixture = makeReviewFixture();
    const legacyGates = [
      { name: "format", argv: ["bun", "run", "format:check"] },
      { name: "test", argv: ["bun", "test"] },
      { name: "lint", argv: ["bun", "run", "lint"] },
      { name: "typecheck", argv: ["bun", "run", "check"] },
    ];
    const state = readFileSync(fixture.statePath, "utf8");
    const policyMatch = state.match(/^## Review policy\s*\n\n```json\n([\s\S]*?)\n```/mu);
    if (policyMatch === null) throw new Error("Review policy block is missing.");
    const policy = JSON.parse(policyMatch[1]!) as Record<string, unknown>;
    policy.gates = legacyGates;
    writeFileSync(
      fixture.statePath,
      state.replace(
        policyMatch[0],
        `## Review policy\n\n\`\`\`json\n${JSON.stringify(policy, null, 2)}\n\`\`\``,
      ),
    );

    const legacyGatePaths = [...fixture.firstGatePaths];
    for (const gate of legacyGates.slice(2)) {
      const evidencePath = join(
        fixture.runPath,
        "reviews",
        `13-round-0-${gate.name}-gate-attempt-1.json`,
      );
      const result = runCli(
        request("gate.record", {
          state_path: fixture.statePath,
          evidence_path: evidencePath,
          worktree_path: fixture.worktreePath,
          ticket: fixture.ticket,
          round: 0,
          name: gate.name,
          attempt: 1,
          status: "passed",
          exit_code: 0,
          stdout: `${gate.argv.join(" ")} passed\n`,
          stderr: "",
          completed_at: "2026-09-23T12:04:00Z",
        }),
      );
      expect(result.exitCode).toBe(0);
      legacyGatePaths.push(evidencePath);
    }
    fixture.firstGatePaths = legacyGatePaths;

    for (const evidencePath of legacyGatePaths) {
      const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as Record<string, unknown>;
      delete evidence.supersession_generation;
      writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
      expect(
        (JSON.parse(readFileSync(evidencePath, "utf8")) as Record<string, unknown>)
          .supersession_generation,
      ).toBeUndefined();
    }
    for (const artifactPath of [fixture.artifactPath, fixture.specArtifactPath]) {
      const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
      artifact.gate_evidence_paths = legacyGatePaths;
      writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
    }

    expect(runCli(supersedeReviewerRequest(fixture, "standards")).exitCode).toBe(0);
    expect(runCli(supersedeReviewerRequest(fixture, "spec")).exitCode).toBe(0);
    const expectedGateEvidence = legacyGatePaths.map((evidencePath) => {
      const raw = readFileSync(evidencePath, "utf8");
      const record = JSON.parse(raw) as {
        gate: { name: string };
        attempt: number;
      };
      return {
        name: record.gate.name,
        attempt: record.attempt,
        evidence_path: evidencePath,
        sha256: createHash("sha256").update(raw).digest("hex"),
        supersession_generation: 0,
      };
    });
    for (const axis of ["standards", "spec"] as const) {
      const reportPath = join(fixture.runPath, "reviews", `13-round-0-${axis}-attempt-1.md`);
      const sidecar = JSON.parse(readFileSync(`${reportPath}.json`, "utf8")) as {
        supersession: { gate_evidence: unknown };
      };
      expect(sidecar.supersession.gate_evidence).toEqual(expectedGateEvidence);
    }

    const legacyRetry = runCli(retryReviewer(fixture, legacyGatePaths));
    expect(legacyRetry.exitCode).toBe(1);
    expect(legacyRetry.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.superseded_gates_stale" }],
    });

    const freshGatePaths = legacyGates.map((gate) => {
      const evidencePath = join(
        fixture.runPath,
        "reviews",
        `13-round-0-${gate.name}-gate-attempt-2.json`,
      );
      const result = runCli(
        request("gate.record", {
          state_path: fixture.statePath,
          evidence_path: evidencePath,
          worktree_path: fixture.worktreePath,
          ticket: fixture.ticket,
          round: 0,
          name: gate.name,
          attempt: 2,
          status: "passed",
          exit_code: 0,
          stdout: `${gate.argv.join(" ")} passed\n`,
          stderr: "",
          completed_at: "2000-09-23T12:04:00Z",
        }),
      );
      expect(result.exitCode).toBe(0);
      return evidencePath;
    });
    expect(
      freshGatePaths.map(
        (path) =>
          (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
            .supersession_generation,
      ),
    ).toEqual([2, 2, 2, 2]);
    const retry = runCli(retryReviewer(fixture, freshGatePaths));
    expect(retry.stdout).toMatchObject({ ok: true });
    expect(retry.exitCode).toBe(0);
  });

  it("requires every old reviewer axis to be superseded before the Pi retry", () => {
    const fixture = makeReviewFixture();
    const staleGatePaths = recordPassingGates(fixture, 2, "2", "2026-09-23T12:12:00Z");
    expect(runCli(supersedeReviewerRequest(fixture, "standards")).exitCode).toBe(0);

    const incomplete = runCli(retryReviewer(fixture, staleGatePaths));
    expect(incomplete.exitCode).toBe(1);
    expect(incomplete.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.supersession_axes_incomplete" }],
    });

    expect(runCli(supersedeReviewerRequest(fixture, "spec")).exitCode).toBe(0);
    expect(
      existsSync(
        `${join(fixture.runPath, "reviews", "13-round-0-standards-attempt-1.md")}.json.commit.json`,
      ),
    ).toBe(true);
    expect(
      existsSync(
        `${join(fixture.runPath, "reviews", "13-round-0-spec-attempt-1.md")}.json.commit.json`,
      ),
    ).toBe(true);
    const standardsEvidence = JSON.parse(
      readFileSync(
        `${join(fixture.runPath, "reviews", "13-round-0-standards-attempt-1.md")}.json`,
        "utf8",
      ),
    ) as Record<string, unknown>;
    const specEvidence = JSON.parse(
      readFileSync(
        `${join(fixture.runPath, "reviews", "13-round-0-spec-attempt-1.md")}.json`,
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(standardsEvidence.supersession_generation).toBe(1);
    expect(specEvidence.supersession_generation).toBe(2);

    const freshGatePaths = recordPassingGates(fixture, 3, "3", "2026-09-23T12:12:00Z");
    expect(JSON.parse(readFileSync(freshGatePaths[0]!, "utf8")).supersession_generation).toBe(2);
    const retry = runCli(retryReviewer(fixture, freshGatePaths));
    expect(retry.exitCode).toBe(0);
    expect(retry.stdout).toMatchObject({
      ok: true,
      result: {
        recovered: false,
        reviewed_head: spawnGit(["rev-parse", "HEAD"], { cwd: fixture.worktreePath }).stdout.trim(),
      },
    });
    const freshArtifactPath = join(
      fixture.runPath,
      "reviews",
      "13-round-0-standards-attempt-2.json",
    );
    expect(JSON.parse(readFileSync(freshArtifactPath, "utf8"))).toMatchObject({
      reviewer: PI_REVIEWER,
      attempt: 2,
      gate_evidence_paths: freshGatePaths,
    });
  });

  it("uses durable generations instead of caller timestamps for gate freshness", () => {
    const fixture = makeReviewFixture();
    const staleGatePaths = recordPassingGates(fixture, 2, "2", "2099-09-23T12:05:00Z");
    expect(runCli(supersedeReviewerRequest(fixture, "standards")).exitCode).toBe(0);
    expect(runCli(supersedeReviewerRequest(fixture, "spec")).exitCode).toBe(0);

    const stale = runCli(retryReviewer(fixture, staleGatePaths));
    expect(stale.exitCode).toBe(1);
    expect(stale.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.superseded_gates_stale" }],
    });

    const freshGatePaths = recordPassingGates(fixture, 3, "3", "2000-09-23T12:11:00Z");
    const retry = runCli(retryReviewer(fixture, freshGatePaths));
    expect(retry.exitCode).toBe(0);
  });

  it("keeps two-axis generations ordered across an interrupted first commit write", () => {
    const fixture = makeReviewFixture();
    const standardsInput = supersedeReviewerRequest(fixture, "standards");
    const specInput = supersedeReviewerRequest(fixture, "spec");
    const standardsEvidencePath = join(
      fixture.runPath,
      "reviews",
      "13-round-0-standards-attempt-1.md.json",
    );
    const specEvidencePath = join(fixture.runPath, "reviews", "13-round-0-spec-attempt-1.md.json");
    const standardsCommitPath = `${standardsEvidencePath}.commit.json`;
    const specCommitPath = `${specEvidencePath}.commit.json`;
    mkdirSync(standardsCommitPath);

    const interrupted = runCli(standardsInput);
    expect(interrupted.exitCode).toBe(1);
    expect(interrupted.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.supersession_commit_write_failed" }],
    });
    rmdirSync(standardsCommitPath);
    const stateAfterInterruptedWrite = readFileSync(fixture.statePath, "utf8");
    const standardsEvidenceAfterInterruptedWrite = readFileSync(standardsEvidencePath, "utf8");
    expect(JSON.parse(standardsEvidenceAfterInterruptedWrite)).toMatchObject({
      status: "superseded",
      supersession_generation: 1,
    });

    const blockedSecondAxis = runCli(specInput);
    expect(blockedSecondAxis.exitCode).toBe(1);
    expect(blockedSecondAxis.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.supersession_pending" }],
    });
    expect(readFileSync(fixture.statePath, "utf8")).toBe(stateAfterInterruptedWrite);
    expect(existsSync(specEvidencePath)).toBe(false);

    const retryStandards = runCli(standardsInput);
    expect(retryStandards.exitCode).toBe(0);
    expect(retryStandards.stdout).toMatchObject({
      result: { recovered: true, next_attempt: 2 },
    });
    expect(existsSync(standardsCommitPath)).toBe(true);

    const retrySpec = runCli(specInput);
    expect(retrySpec.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(specEvidencePath, "utf8"))).toMatchObject({
      supersession_generation: 2,
    });
    expect(existsSync(specCommitPath)).toBe(true);

    const freshGatePaths = recordPassingGates(fixture, 2, "2", "2026-09-23T12:11:00Z");
    expect(runCli(retryReviewer(fixture, freshGatePaths)).exitCode).toBe(0);
  });
});
