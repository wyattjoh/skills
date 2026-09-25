import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnGit } from "./lib/git.ts";
import { parseIntegration, writeIntegration, type IntegrationRecord } from "./lib/integration.ts";
import { applyEscalationBlock } from "./lib/landing.ts";
import { runCliInProcess } from "./test-cli.ts";
import { createFakeHerdrEnv } from "./test-herdr.ts";

const CLI = join(import.meta.dir, "coordinate.ts");

const integrationRecord = (
  base: string,
  head: string,
  overrides: Partial<IntegrationRecord> = {},
): IntegrationRecord => ({
  cycle: 0,
  phase: "gates",
  base_sha: base,
  ticket_sha: head,
  review_range: `${base}..${head}`,
  commit_count: 1,
  patch_id: "a".repeat(40),
  commit_patch_ids: ["b".repeat(40)],
  passed_gates: [],
  reviewed_head: null,
  reviewed_patch_id: null,
  reviewed_commit_patch_ids: null,
  standards_evidence_path: null,
  spec_evidence_path: null,
  self_review_path: null,
  completed_at: "2026-09-19T00:59:00Z",
  ...overrides,
});

const injectIntegration = (statePath: string, record: IntegrationRecord): void => {
  writeFileSync(
    statePath,
    writeIntegration(readFileSync(statePath, "utf8"), "06", record, undefined),
  );
};

const readIntegration = (statePath: string): IntegrationRecord | undefined =>
  parseIntegration(readFileSync(statePath, "utf8"), "06");
const HERDR_ENV = createFakeHerdrEnv();

type CliResult = {
  exitCode: number;
  stdout: Record<string, unknown>;
  stderr: string;
};

type ReviewFixture = {
  root: string;
  runPath: string;
  statePath: string;
  worktreePath: string;
};

const runCli = async (
  request: unknown,
  env: Record<string, string | undefined> = HERDR_ENV,
): Promise<CliResult> => {
  const child = await runCliInProcess(request, env);
  return {
    exitCode: child.exitCode,
    stdout: JSON.parse(child.stdout.trim()) as Record<string, unknown>,
    stderr: child.stderr,
  };
};

/**
 * Spawns the CLI as a separate process. Only for tests that exercise real
 * cross-process serialization, which the in-process queue would hide.
 */
const runCliProcess = async (
  request: unknown,
  env: Record<string, string | undefined> = HERDR_ENV,
): Promise<CliResult> => {
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
  return { exitCode, stdout: JSON.parse(stdout) as Record<string, unknown>, stderr };
};

const stateText = (implementor: "claude" | "pi", active: boolean): string => `# review run

Schema version: 2

Prefix: review

Coordinator:
  harness:    pi
  model:      openai/test
  effort:     high
  handoff:    no
  threshold:  1000
  unattended: block

Implementor:
  harness: ${implementor}
  model:   ${implementor === "pi" ? "openai/test" : "opus"}
  effort:  high

Reviewer:
  harness: claude
  model:   sonnet
  effort:  medium

## Tickets

| NN | harness | model | effort | rounds | esc | status | sha |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 06 | ${implementor} | ${implementor === "pi" ? "openai/test" : "opus"} | high | 0 | - | ${active ? "review" : "queued"} | - |

## Active tickets
${
  active
    ? `
### 06

Worktree: WORKTREE
Branch: ticket-06
Implementor: {"harness":"${implementor}","model":"${implementor === "pi" ? "openai/test" : "opus"}","effort":"high"}
Session: review-06
Tab: implement 06
Pane: workspace:p6
Artifact: WORKTREE/launch-06.json
Attempt: 1
Retry: 0 of 3
Last diagnostic: none
Phase: committed, awaiting review
`
    : ""
}
## Decisions

- setup
`;

const makeFixture = (implementor: "claude" | "pi", active = false): ReviewFixture => {
  const root = mkdtempSync(join(tmpdir(), "coordinate-review-"));
  const runPath = join(root, "run");
  const worktreePath = join(root, "worktree");
  mkdirSync(join(runPath, "briefs"), { recursive: true });
  mkdirSync(worktreePath, { recursive: true });
  expect(spawnGit(["init", "-q", "-b", "main"], { cwd: worktreePath }).exitCode).toBe(0);
  writeFileSync(join(worktreePath, "tracked.txt"), "clean\n");
  expect(spawnGit(["add", "tracked.txt"], { cwd: worktreePath }).exitCode).toBe(0);
  expect(
    spawnGit(
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"],
      {
        cwd: worktreePath,
      },
    ).exitCode,
  ).toBe(0);
  const statePath = join(runPath, "RESUME.md");
  writeFileSync(statePath, stateText(implementor, active).replaceAll("WORKTREE", worktreePath));
  return { root, runPath, statePath, worktreePath };
};

const policyRequest = (fixture: ReviewFixture) => ({
  schema_version: 1,
  operation: "review.policy.prepare",
  input: {
    state_path: fixture.statePath,
    instruction_files: ["CLAUDE.md"],
    ci_files: [".github/workflows/ci.yml"],
    gates: [
      { name: "format", argv: ["bun", "run", "format:check"] },
      { name: "test", argv: ["bun", "test"] },
    ],
    no_executable_gates: false,
    safety_constraints: ["Do not push."],
    no_additional_safety_constraints: false,
  },
});

const preparePolicy = async (fixture: ReviewFixture): Promise<void> => {
  expect((await runCli(policyRequest(fixture))).exitCode).toBe(0);
};

const recordPassingGates = async (
  fixture: ReviewFixture,
  round: number,
  attempt = 1,
  suffix = "",
): Promise<string[]> => {
  const paths: string[] = [];
  for (const [name, argv] of [
    ["format", ["bun", "run", "format:check"]],
    ["test", ["bun", "test"]],
  ] as const) {
    const result = await runCli({
      schema_version: 1,
      operation: "gate.record",
      input: {
        state_path: fixture.statePath,
        evidence_path: join(
          fixture.runPath,
          "reviews",
          `06-round-${round}-${name}-gate${suffix}.json`,
        ),
        worktree_path: fixture.worktreePath,
        ticket: "06",
        round,
        name,
        attempt,
        status: "passed",
        exit_code: 0,
        stdout: `${argv.join(" ")} passed\n`,
        stderr: "",
        completed_at: "2026-09-19T00:59:00Z",
      },
    });
    expect(result.exitCode).toBe(0);
    paths.push(join(fixture.runPath, "reviews", `06-round-${round}-${name}-gate${suffix}.json`));
  }
  return paths;
};

const activateFixture = async (
  fixture: ReviewFixture,
  implementor: "claude" | "pi",
): Promise<void> => {
  const policy = readFileSync(fixture.statePath, "utf8").match(
    /^## Review policy\s*\n\n```json\n[\s\S]*?\n```\s*$/mu,
  )?.[0];
  expect(typeof policy).toBe("string");
  const active = stateText(implementor, true)
    .replaceAll("WORKTREE", fixture.worktreePath)
    .replace("## Decisions", `${policy}\n\n## Decisions`);
  writeFileSync(fixture.statePath, active);
  await recordPassingGates(fixture, 0);
};

const reviewLaunchRequest = (
  fixture: ReviewFixture,
  axis: "standards" | "spec",
  attempt = 1,
  round = 0,
) => ({
  schema_version: 1,
  operation: "review.launch.prepare",
  input: {
    state_path: fixture.statePath,
    previous_artifact_path:
      attempt === 1
        ? null
        : join(fixture.runPath, "reviews", `06-round-${round}-${axis}-attempt-${attempt - 1}.json`),
    artifact_path: join(
      fixture.runPath,
      "reviews",
      `06-round-${round}-${axis}-attempt-${attempt}.json`,
    ),
    report_path: join(
      fixture.runPath,
      "reviews",
      `06-round-${round}-${axis}-attempt-${attempt}.md`,
    ),
    ticket: "06",
    round,
    axis,
    worktree_path: fixture.worktreePath,
    branch: "ticket-06",
    base_ref: "main",
    pane: `workspace:p${axis === "standards" ? "1" : "2"}`,
    role: { harness: "claude", model: "sonnet", effort: "medium" },
    context_paths:
      axis === "standards"
        ? ["CLAUDE.md", ".claude/rules/testing.md"]
        : [".scratch/run/spec.md", ".scratch/run/issues/06-review.md"],
    landed_tickets: ["01", "02", "03", "04"],
    gate_evidence_paths: [
      join(fixture.runPath, "reviews", `06-round-${round}-format-gate.json`),
      join(fixture.runPath, "reviews", `06-round-${round}-test-gate.json`),
    ],
    attempt,
  },
});

const passingReport = (axis: "Standards" | "Spec"): string => `# ${axis} review\n\nPASS\n`;

const failingReport = (axis: "Standards" | "Spec"): string => `# ${axis} review

## Finding
Severity: high
Location: src/example.ts:12
Rationale: The implementation violates a required behavior.
Suggested fix: Restore the required behavior and add coverage.

FAIL
`;

describe("review documentation contract", () => {
  it("documents harness self-review, fresh Herdr axes, mutation stops, and gate execution", () => {
    const skill = readFileSync(join(import.meta.dir, "..", "SKILL.md"), "utf8");
    const procedure = readFileSync(
      join(import.meta.dir, "..", "references", "review-and-land.md"),
      "utf8",
    );

    expect(skill).toContain("`review.policy.prepare`");
    expect(skill).toContain("fresh independent Herdr");
    expect(procedure).toContain("Pi coordinators run gates synchronously");
    expect(procedure).toContain("Claude implementors complete Matt's `implement` self-review");
    expect(procedure).toContain("subagent extension.");
    expect(procedure).toContain("before closing the pane");
    expect(procedure).toContain(
      "Never reset, stash, commit, or discard reviewer changes automatically",
    );
    expect(skill).toContain("Review fixes are\n  pre-authorized regardless of round");
    expect(procedure).toContain("terminal remediation result");
    expect(procedure).toContain("result returned directly by the blocking Herdr prompt");
    expect(procedure).toContain("do not summarize, end the turn, or wait for another");
  });
});

describe("review policy", () => {
  it("persists explicit repository gates and derives the Pi fallback self-review", async () => {
    const fixture = makeFixture("pi");
    const result = await runCli(policyRequest(fixture));

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatchObject({
      operation: "review.policy.prepare",
      ok: true,
      result: {
        gate_execution: { claude: "background-allowed", pi: "synchronous" },
        self_review: "standards-spec-single-session",
        max_infrastructure_attempts: 4,
        retry_delays_seconds: [1, 2, 4],
      },
      errors: [],
    });
    expect(readFileSync(fixture.statePath, "utf8")).toContain("## Review policy");
    expect(readFileSync(fixture.statePath, "utf8")).toContain('"argv": [');
  });

  it("retains Matt self-review for Claude implementors", async () => {
    const fixture = makeFixture("claude");
    const result = await runCli(policyRequest(fixture));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatchObject({
      ok: true,
      result: { self_review: "matt-implement" },
    });
  });

  it("rejects unresolved or inferred gate configuration", async () => {
    const fixture = makeFixture("pi");
    const request = policyRequest(fixture);
    request.input.gates = [];

    const result = await runCli(request);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "request.invalid" }],
    });
    expect(readFileSync(fixture.statePath, "utf8")).toBe(
      stateText("pi", false).replaceAll("WORKTREE", fixture.worktreePath),
    );
  });
});

const recordReview = async (
  fixture: ReviewFixture,
  request: ReturnType<typeof reviewLaunchRequest>,
  report: string,
  completedAt = "2026-09-19T01:00:00Z",
): Promise<CliResult> =>
  runCli({
    schema_version: 1,
    operation: "review.launch.record",
    input: {
      state_path: fixture.statePath,
      artifact_path: request.input.artifact_path,
      status: "completed",
      report,
      diagnostic: null,
      completed_at: completedAt,
    },
  });

const gateRecordRequest = (
  fixture: ReviewFixture,
  status: "passed" | "failed" | "infrastructure_failed",
  attempt = 1,
) => ({
  schema_version: 1,
  operation: "gate.record",
  input: {
    state_path: fixture.statePath,
    evidence_path: join(fixture.runPath, "reviews", `06-round-0-test-gate-attempt-${attempt}.json`),
    worktree_path: fixture.worktreePath,
    ticket: "06",
    round: 0,
    name: "test",
    attempt,
    status,
    exit_code: status === "passed" ? 0 : 1,
    stdout: "gate stdout\n",
    stderr: status === "passed" ? "" : "gate stderr\n",
    completed_at: "2026-09-19T00:59:00Z",
  },
});

describe("review launches and reports", () => {
  it("builds a fresh shell-free Herdr reviewer launch with a strict prompt", async () => {
    const fixture = makeFixture("pi");
    await preparePolicy(fixture);
    await activateFixture(fixture, "pi");

    const result = await runCli(reviewLaunchRequest(fixture, "standards"));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatchObject({
      ok: true,
      result: {
        recovered: false,
        status_before: "",
        launch: {
          start: {
            command: "herdr",
            args: [
              "agent",
              "start",
              "review-review-06-r0-standards-a1",
              "--kind",
              "claude",
              "--pane",
              "workspace:p1",
              "--timeout",
              "300000",
              "--",
              "--model",
              "sonnet",
              "--effort",
              "medium",
              "--permission-mode",
              "auto",
            ],
          },
        },
      },
    });
    const reviewerPrompt = (
      result.stdout.result as {
        launch: { prompt: { command: string; args: string[] } };
      }
    ).launch.prompt;
    expect(reviewerPrompt.command).toBe("herdr");
    expect(reviewerPrompt.args).toEqual([
      "agent",
      "prompt",
      "review-review-06-r0-standards-a1",
      expect.stringContaining("Perform an independent Standards review."),
      "--wait",
      "--timeout",
      "300000",
    ]);
    const artifact = readFileSync(
      join(fixture.runPath, "reviews", "06-round-0-standards-attempt-1.json"),
      "utf8",
    );
    expect(artifact).toContain("Every actionable finding requires FAIL");
    expect(artifact).toContain("Do not modify the worktree");
    expect(artifact).toContain('"reviewer"');
  });

  it("prevents caller-chosen paths from reusing a reviewer attempt identity", async () => {
    const fixture = makeFixture("pi");
    await preparePolicy(fixture);
    await activateFixture(fixture, "pi");
    expect((await runCli(reviewLaunchRequest(fixture, "standards"))).exitCode).toBe(0);

    const reusedIdentity = reviewLaunchRequest(fixture, "standards");
    reusedIdentity.input.artifact_path = join(
      fixture.runPath,
      "reviews",
      "caller-selected-attempt-1.json",
    );
    reusedIdentity.input.report_path = join(
      fixture.runPath,
      "reviews",
      "caller-selected-attempt-1.md",
    );
    const rejected = await runCli(reusedIdentity);

    expect(rejected.exitCode).toBe(1);
    expect(rejected.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.attempt_identity_conflict" }],
    });
  });

  it("canonicalizes relative and absolute state paths for reviewer attempt identity", async () => {
    const fixture = makeFixture("pi");
    await preparePolicy(fixture);
    await activateFixture(fixture, "pi");
    const first = reviewLaunchRequest(fixture, "standards");
    first.input.state_path = relative(process.cwd(), fixture.statePath);
    expect((await runCli(first)).exitCode).toBe(0);

    const alias = reviewLaunchRequest(fixture, "standards");
    alias.input.artifact_path = join(fixture.runPath, "reviews", "absolute-alias.json");
    alias.input.report_path = join(fixture.runPath, "reviews", "absolute-alias.md");
    const rejected = await runCli(alias);

    expect(rejected.exitCode).toBe(1);
    expect(rejected.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.attempt_identity_conflict" }],
    });
  });

  it("serializes scan and artifact creation across different paths", async () => {
    const fixture = makeFixture("pi");
    await preparePolicy(fixture);
    await activateFixture(fixture, "pi");
    for (let index = 0; index < 200; index += 1) {
      writeFileSync(
        join(fixture.runPath, "reviews", `unrelated-${index}.json`),
        '{"kind":"unrelated"}\n',
      );
    }
    const first = reviewLaunchRequest(fixture, "standards");
    first.input.artifact_path = join(fixture.runPath, "reviews", "parallel-first.json");
    first.input.report_path = join(fixture.runPath, "reviews", "parallel-first.md");
    first.input.pane = "workspace:parallel-first";
    const second = reviewLaunchRequest(fixture, "standards");
    second.input.artifact_path = join(fixture.runPath, "reviews", "parallel-second.json");
    second.input.report_path = join(fixture.runPath, "reviews", "parallel-second.md");
    second.input.pane = "workspace:parallel-second";

    const results = await Promise.all([runCliProcess(first), runCliProcess(second)]);
    const successes = results.filter((result) => result.exitCode === 0);
    const rejections = results.filter((result) => result.exitCode === 1);

    expect(successes).toHaveLength(1);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.attempt_identity_conflict" }],
    });
  });

  it("requires the integrated full-SHA base and current integration cycle", async () => {
    const fixture = makeFixture("pi");
    await preparePolicy(fixture);
    await activateFixture(fixture, "pi");
    const head = spawnGit(["rev-parse", "HEAD"], { cwd: fixture.worktreePath }).stdout.trim();
    injectIntegration(fixture.statePath, integrationRecord(head, head, { cycle: 1 }));
    const cycleOneGates = await recordPassingGates(fixture, 0, 2, "-cycle-one");
    const wrongBase = reviewLaunchRequest(fixture, "standards");
    const rejected = await runCli(wrongBase);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.range_mismatch" }],
    });
    const staleCycle = reviewLaunchRequest(fixture, "standards");
    staleCycle.input.base_ref = head;
    const staleCycleResult = await runCli(staleCycle);
    expect(staleCycleResult.exitCode).toBe(1);
    expect(staleCycleResult.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.gates_cycle_stale" }],
    });

    const exactBase = reviewLaunchRequest(fixture, "standards");
    exactBase.input.base_ref = head;
    exactBase.input.gate_evidence_paths = cycleOneGates;
    const accepted = await runCli(exactBase);
    expect(accepted.exitCode).toBe(0);
    expect((accepted.stdout.result as { reviewed_head: string }).reviewed_head).toBe(head);
    expect(JSON.parse(readFileSync(cycleOneGates[0]!, "utf8")).integration_cycle).toBe(1);
  }, 15_000);

  it("refuses external review until every configured gate has passed", async () => {
    const fixture = makeFixture("pi");
    await preparePolicy(fixture);
    await activateFixture(fixture, "pi");
    const request = reviewLaunchRequest(fixture, "standards");
    request.input.gate_evidence_paths = request.input.gate_evidence_paths.slice(0, 1);

    const result = await runCli(request);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.gates_incomplete" }],
    });
  });

  it("rejects stale gate evidence after the reviewed HEAD changes", async () => {
    const fixture = makeFixture("pi");
    await preparePolicy(fixture);
    await activateFixture(fixture, "pi");
    writeFileSync(join(fixture.worktreePath, "tracked.txt"), "new commit\n");
    expect(spawnGit(["add", "tracked.txt"], { cwd: fixture.worktreePath }).exitCode).toBe(0);
    expect(
      spawnGit(
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-qm",
          "after gates",
        ],
        { cwd: fixture.worktreePath },
      ).exitCode,
    ).toBe(0);

    const result = await runCli(reviewLaunchRequest(fixture, "standards"));

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.gates_incomplete" }],
    });
  });

  it("rejects gate evidence whose persisted worktree differs from the active runtime", async () => {
    const fixture = makeFixture("pi");
    await preparePolicy(fixture);
    await activateFixture(fixture, "pi");
    const secondCheckout = join(fixture.root, "second-checkout");
    expect(
      spawnGit(["clone", "-q", fixture.worktreePath, secondCheckout], { cwd: fixture.root })
        .exitCode,
    ).toBe(0);
    const evidencePath = join(fixture.runPath, "reviews", "06-round-0-format-gate.json");
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as Record<string, unknown>;
    evidence.worktree_path = secondCheckout;
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

    const result = await runCli(reviewLaunchRequest(fixture, "standards"));

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.gates_incomplete" }],
    });
  });

  it("persists clean PASS and actionable FAIL reports", async () => {
    const fixture = makeFixture("pi");
    await preparePolicy(fixture);
    await activateFixture(fixture, "pi");
    const standards = reviewLaunchRequest(fixture, "standards");
    const spec = reviewLaunchRequest(fixture, "spec");
    expect((await runCli(standards)).exitCode).toBe(0);
    expect((await runCli(spec)).exitCode).toBe(0);

    const standardsRecord = {
      schema_version: 1,
      operation: "review.launch.record",
      input: {
        state_path: fixture.statePath,
        artifact_path: standards.input.artifact_path,
        status: "completed",
        report: passingReport("Standards"),
        diagnostic: null,
        completed_at: "2026-09-19T01:00:00Z",
      },
    };
    const standardsClose = await runCli(standardsRecord, {
      ...HERDR_ENV,
      HERDR_TEST_LIVE_PANES: JSON.stringify(["workspace:p1"]),
    });
    expect(standardsClose.exitCode).toBe(0);
    expect(standardsClose.stdout).toMatchObject({
      result: {
        status: "accepted",
        verdict: "PASS",
        action: "close-runtime",
        after_close_action: "continue",
        runtime_closed: false,
        pane_id: "workspace:p1",
        close: { command: "herdr", args: ["pane", "close", "workspace:p1"] },
      },
    });
    const standardsResult = await runCli(standardsRecord);
    const specResult = await runCli({
      schema_version: 1,
      operation: "review.launch.record",
      input: {
        state_path: fixture.statePath,
        artifact_path: spec.input.artifact_path,
        status: "completed",
        report: failingReport("Spec"),
        diagnostic: null,
        completed_at: "2026-09-19T01:01:00Z",
      },
    });

    expect(standardsResult.exitCode).toBe(0);
    expect(standardsResult.stdout).toMatchObject({
      result: {
        status: "accepted",
        verdict: "PASS",
        action: "continue",
        after_close_action: "continue",
        runtime_closed: true,
        pane_id: "workspace:p1",
        close: null,
        findings: [],
      },
    });
    expect(specResult.exitCode).toBe(0);
    expect(specResult.stdout).toMatchObject({
      result: {
        status: "accepted",
        verdict: "FAIL",
        action: "fix",
        findings: [
          {
            severity: "high",
            location: "src/example.ts:12",
            rationale: "The implementation violates a required behavior.",
            suggested_fix: "Restore the required behavior and add coverage.",
          },
        ],
      },
    });
    expect(readFileSync(spec.input.report_path, "utf8")).toContain(failingReport("Spec"));
  });

  it("refuses to overwrite a durable report with different content", async () => {
    const fixture = makeFixture("pi");
    await preparePolicy(fixture);
    await activateFixture(fixture, "pi");
    const launch = reviewLaunchRequest(fixture, "standards");
    expect((await runCli(launch)).exitCode).toBe(0);
    expect((await recordReview(fixture, launch, passingReport("Standards"))).exitCode).toBe(0);

    const conflicting = await recordReview(
      fixture,
      launch,
      failingReport("Standards"),
      "2026-09-19T01:01:00Z",
    );

    expect(conflicting.exitCode).toBe(1);
    expect(conflicting.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.evidence_conflict" }],
    });
    expect(readFileSync(launch.input.report_path, "utf8")).toContain("PASS");
  });

  it("rejects launch recording from an artifact outside the run directory", async () => {
    const fixture = makeFixture("pi");
    await preparePolicy(fixture);
    await activateFixture(fixture, "pi");
    const launch = reviewLaunchRequest(fixture, "standards");
    expect((await runCli(launch)).exitCode).toBe(0);
    const artifact = JSON.parse(readFileSync(launch.input.artifact_path, "utf8")) as Record<
      string,
      unknown
    >;
    const outsideArtifact = join(fixture.root, "outside-review.json");
    const outsideReport = join(fixture.root, "outside-review.md");
    artifact.artifact_path = outsideArtifact;
    artifact.report_path = outsideReport;
    writeFileSync(outsideArtifact, `${JSON.stringify(artifact, null, 2)}\n`);

    const result = await runCli({
      schema_version: 1,
      operation: "review.launch.record",
      input: {
        state_path: fixture.statePath,
        artifact_path: outsideArtifact,
        status: "completed",
        report: passingReport("Standards"),
        diagnostic: null,
        completed_at: "2026-09-19T01:00:00Z",
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.evidence_outside_run" }],
    });
  });

  it("rejects a report path that escapes the run through a symlink", async () => {
    const fixture = makeFixture("pi");
    await preparePolicy(fixture);
    await activateFixture(fixture, "pi");
    const launch = reviewLaunchRequest(fixture, "standards");
    expect((await runCli(launch)).exitCode).toBe(0);
    const outside = join(fixture.root, "outside");
    mkdirSync(outside);
    const link = join(fixture.runPath, "review-link");
    symlinkSync(outside, link);
    const artifact = JSON.parse(readFileSync(launch.input.artifact_path, "utf8")) as Record<
      string,
      unknown
    >;
    artifact.report_path = join(link, "escaped.md");
    writeFileSync(launch.input.artifact_path, `${JSON.stringify(artifact, null, 2)}\n`);

    const result = await recordReview(fixture, launch, passingReport("Standards"));

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.evidence_outside_run" }],
    });
  });

  it("rejects an artifact whose declared path differs from the supplied path", async () => {
    const fixture = makeFixture("pi");
    await preparePolicy(fixture);
    await activateFixture(fixture, "pi");
    const launch = reviewLaunchRequest(fixture, "standards");
    expect((await runCli(launch)).exitCode).toBe(0);
    const artifact = JSON.parse(readFileSync(launch.input.artifact_path, "utf8")) as Record<
      string,
      unknown
    >;
    artifact.artifact_path = join(fixture.runPath, "reviews", "different.json");
    writeFileSync(launch.input.artifact_path, `${JSON.stringify(artifact, null, 2)}\n`);

    const result = await recordReview(fixture, launch, passingReport("Standards"));

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.artifact_mismatch" }],
    });
  });

  it("retries malformed verdicts with the same reviewer configuration", async () => {
    const fixture = makeFixture("pi");
    await preparePolicy(fixture);
    await activateFixture(fixture, "pi");
    const launch = reviewLaunchRequest(fixture, "standards");
    expect((await runCli(launch)).exitCode).toBe(0);

    const malformed = await recordReview(
      fixture,
      launch,
      failingReport("Standards").replace(/FAIL\n$/u, "PASS\n"),
    );

    expect(malformed.exitCode).toBe(0);
    expect(malformed.stdout).toMatchObject({
      result: {
        status: "malformed",
        verdict: null,
        action: "retry",
        findings: [],
        retry_delay_seconds: 1,
        next_attempt: 2,
      },
    });
    const retry = await runCli(reviewLaunchRequest(fixture, "standards", 2));
    expect(retry.exitCode).toBe(0);
    expect(retry.stdout).toMatchObject({
      result: {
        launch: {
          start: {
            args: [
              "agent",
              "start",
              "review-review-06-r0-standards-a2",
              "--kind",
              "claude",
              "--pane",
              "workspace:p1",
              "--timeout",
              "300000",
              "--",
              "--model",
              "sonnet",
              "--effort",
              "medium",
              "--permission-mode",
              "auto",
            ],
          },
        },
      },
    });
  });

  it("rejects retry attempts that change the reviewed base ref", async () => {
    const fixture = makeFixture("pi");
    await preparePolicy(fixture);
    await activateFixture(fixture, "pi");
    const first = reviewLaunchRequest(fixture, "standards");
    expect((await runCli(first)).exitCode).toBe(0);
    expect(
      (await recordReview(fixture, first, failingReport("Standards").replace(/FAIL\n$/u, "PASS\n")))
        .exitCode,
    ).toBe(0);
    const retry = reviewLaunchRequest(fixture, "standards", 2);
    retry.input.base_ref = "release";

    const result = await runCli(retry);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.retry_mismatch" }],
    });
  });

  it("rejects retry attempts that change the review source list", async () => {
    const fixture = makeFixture("pi");
    await preparePolicy(fixture);
    await activateFixture(fixture, "pi");
    const first = reviewLaunchRequest(fixture, "spec");
    expect((await runCli(first)).exitCode).toBe(0);
    expect(
      (await recordReview(fixture, first, failingReport("Spec").replace(/FAIL\n$/u, "PASS\n")))
        .exitCode,
    ).toBe(0);
    const retry = reviewLaunchRequest(fixture, "spec", 2);
    retry.input.context_paths = [...retry.input.context_paths, "unexpected.md"];

    const result = await runCli(retry);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.retry_mismatch" }],
    });
  });

  it("retries a report with a placeholder source location as malformed", async () => {
    const fixture = makeFixture("pi");
    await preparePolicy(fixture);
    await activateFixture(fixture, "pi");
    const launch = reviewLaunchRequest(fixture, "standards");
    expect((await runCli(launch)).exitCode).toBe(0);

    const result = await recordReview(
      fixture,
      launch,
      failingReport("Standards").replace("src/example.ts:12", "unknown"),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatchObject({
      result: {
        status: "malformed",
        verdict: null,
        action: "retry",
        findings: [],
        retry_delay_seconds: 1,
        next_attempt: 2,
      },
    });
  });

  it("rejects and preserves reviewer worktree mutations", async () => {
    const fixture = makeFixture("pi");
    await preparePolicy(fixture);
    await activateFixture(fixture, "pi");
    const launch = reviewLaunchRequest(fixture, "spec");
    expect((await runCli(launch)).exitCode).toBe(0);
    writeFileSync(join(fixture.worktreePath, "reviewer-created.txt"), "do not discard\n");

    const result = await recordReview(fixture, launch, failingReport("Spec"));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatchObject({
      result: {
        status: "contaminated",
        verdict: null,
        action: "manual_cleanup",
        findings: [],
      },
    });
    expect(readFileSync(join(fixture.worktreePath, "reviewer-created.txt"), "utf8")).toBe(
      "do not discard\n",
    );
    expect(readFileSync(launch.input.report_path, "utf8")).toContain(failingReport("Spec"));
  });

  it("retries reviewer infrastructure failures three times without changing role", async () => {
    const fixture = makeFixture("pi");
    await preparePolicy(fixture);
    await activateFixture(fixture, "pi");
    const first = reviewLaunchRequest(fixture, "spec", 1);
    expect((await runCli(first)).exitCode).toBe(0);

    const recordFailure = async (
      request: ReturnType<typeof reviewLaunchRequest>,
    ): Promise<CliResult> =>
      runCli({
        schema_version: 1,
        operation: "review.launch.record",
        input: {
          state_path: fixture.statePath,
          artifact_path: request.input.artifact_path,
          status: "infrastructure_failed",
          report: null,
          diagnostic: { stage: "prompt", exit_code: 17, stderr: "provider unavailable" },
          completed_at: "2026-09-19T01:02:00Z",
        },
      });

    expect((await recordFailure(first)).stdout).toMatchObject({
      result: { action: "retry", retry_delay_seconds: 1, next_attempt: 2 },
    });
    const second = reviewLaunchRequest(fixture, "spec", 2);
    expect((await runCli(second)).exitCode).toBe(0);
    expect((await recordFailure(second)).stdout).toMatchObject({
      result: { action: "retry", retry_delay_seconds: 2, next_attempt: 3 },
    });
    const third = reviewLaunchRequest(fixture, "spec", 3);
    expect((await runCli(third)).exitCode).toBe(0);
    expect((await recordFailure(third)).stdout).toMatchObject({
      result: { action: "retry", retry_delay_seconds: 4, next_attempt: 4 },
    });
    const fourth = reviewLaunchRequest(fixture, "spec", 4);
    expect((await runCli(fourth)).exitCode).toBe(0);
    expect((await recordFailure(fourth)).stdout).toMatchObject({
      result: { action: "blocked", retry_delay_seconds: null, next_attempt: null },
    });
    const firstArtifact = JSON.parse(readFileSync(first.input.artifact_path, "utf8")) as {
      reviewer: unknown;
    };
    const fourthArtifact = JSON.parse(readFileSync(fourth.input.artifact_path, "utf8")) as {
      reviewer: unknown;
    };
    expect(fourthArtifact.reviewer).toEqual(firstArtifact.reviewer);
  });
});

const failedGateFixture = async (): Promise<{
  fixture: ReviewFixture;
  base: string;
  head: string;
  previousEvidencePath: string;
}> => {
  const fixture = makeFixture("pi");
  await preparePolicy(fixture);
  await activateFixture(fixture, "pi");
  const base = spawnGit(["rev-parse", "HEAD"], { cwd: fixture.worktreePath }).stdout.trim();
  writeFileSync(join(fixture.worktreePath, "ticket.txt"), "ticket\n");
  expect(spawnGit(["add", "ticket.txt"], { cwd: fixture.worktreePath }).exitCode).toBe(0);
  expect(
    spawnGit(
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "ticket"],
      { cwd: fixture.worktreePath },
    ).exitCode,
  ).toBe(0);
  const head = spawnGit(["rev-parse", "HEAD"], { cwd: fixture.worktreePath }).stdout.trim();
  injectIntegration(fixture.statePath, integrationRecord(base, head));
  const failed = await runCli(gateRecordRequest(fixture, "failed"));
  expect(failed.exitCode).toBe(0);
  return {
    fixture,
    base,
    head,
    previousEvidencePath: join(fixture.runPath, "reviews", "06-round-0-test-gate-attempt-1.json"),
  };
};

const legacyEscalationFixture = async (
  implementor: "claude" | "pi",
): Promise<{
  fixture: ReviewFixture;
  fixRequestPath: string;
}> => {
  const fixture = makeFixture(implementor);
  await preparePolicy(fixture);
  await activateFixture(fixture, implementor);
  await recordPassingGates(fixture, 3);
  const standards = reviewLaunchRequest(fixture, "standards", 1, 3);
  const spec = reviewLaunchRequest(fixture, "spec", 1, 3);
  expect((await runCli(standards)).exitCode).toBe(0);
  expect((await runCli(spec)).exitCode).toBe(0);
  expect((await recordReview(fixture, standards, failingReport("Standards"))).exitCode).toBe(0);
  expect((await recordReview(fixture, spec, passingReport("Spec"))).exitCode).toBe(0);
  const fixRequestPath = join(fixture.runPath, "briefs", "fixes-06-round-3.md");
  const finalized = await runCli({
    schema_version: 1,
    operation: "review.round.finalize",
    input: {
      state_path: fixture.statePath,
      ticket: "06",
      round: 3,
      standards_evidence_path: `${standards.input.report_path}.json`,
      spec_evidence_path: `${spec.input.report_path}.json`,
      self_review_path: join(fixture.runPath, "reviews", "06-round-3-self-review.md"),
      self_review_method: "standards-spec-single-session",
      self_review_report:
        "# Pi self-review\n\n## Standards\n\nNo findings.\n\n## Spec\n\nNo findings.\n",
      fix_request_path: fixRequestPath,
      completed_at: "2026-09-19T02:00:00Z",
    },
  });
  expect(finalized.exitCode).toBe(0);
  expect(finalized.stdout).toMatchObject({ result: { action: "fix" } });
  writeFileSync(
    fixture.statePath,
    applyEscalationBlock(readFileSync(fixture.statePath, "utf8"), {
      ticket: "06",
      round: 3,
      completedAt: "2026-09-19T02:00:00Z",
    }),
  );
  return { fixture, fixRequestPath };
};

const escalationRequest = (
  fixture: ReviewFixture,
  fixRequestPath: string,
  strategy: "continue-existing" | "replace-implementor",
  role: { harness: "claude" | "pi"; model: string; effort: string },
) => ({
  schema_version: 1,
  operation: "review.escalation.authorize",
  input: {
    state_path: fixture.statePath,
    ticket: "06",
    round: 3,
    strategy,
    role,
    fix_request_path: fixRequestPath,
    user_authorized: true,
    decision: "User selected one additional bounded remediation round.",
    completed_at: "2026-09-19T02:05:00Z",
  },
});

const gateRerunRequest = (
  fixture: ReviewFixture,
  previousEvidencePath: string,
  overrides: Record<string, unknown> = {},
) => ({
  schema_version: 1,
  operation: "gate.rerun.record",
  input: {
    state_path: fixture.statePath,
    previous_evidence_path: previousEvidencePath,
    evidence_path: join(fixture.runPath, "reviews", "06-round-0-test-gate-attempt-2.json"),
    worktree_path: fixture.worktreePath,
    ticket: "06",
    round: 0,
    name: "test",
    attempt: 2,
    exit_code: 0,
    stdout: "rerun passed\n",
    stderr: "",
    user_authorized: true,
    diagnostic: "unrelated full-suite timeout passed on unchanged rerun",
    completed_at: "2026-09-19T01:00:00Z",
    ...overrides,
  },
});

describe("gates and review rounds", () => {
  it("rejects gate evidence from a second checkout at the same HEAD", async () => {
    const fixture = makeFixture("pi");
    await preparePolicy(fixture);
    await activateFixture(fixture, "pi");
    const secondCheckout = join(fixture.root, "second-checkout");
    expect(
      spawnGit(["clone", "-q", fixture.worktreePath, secondCheckout], { cwd: fixture.root })
        .exitCode,
    ).toBe(0);
    const request = gateRecordRequest(fixture, "passed");
    request.input.worktree_path = secondCheckout;

    const result = await runCli(request);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "gate.worktree_mismatch" }],
    });
  });

  it("records a red gate as a fix without treating it as infrastructure", async () => {
    const fixture = makeFixture("pi");
    await preparePolicy(fixture);
    await activateFixture(fixture, "pi");

    const result = await runCli(gateRecordRequest(fixture, "failed"));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatchObject({
      result: {
        status: "failed",
        action: "fix",
        retry_delay_seconds: null,
        next_attempt: null,
      },
    });
    expect(
      JSON.parse(
        readFileSync(
          join(fixture.runPath, "reviews", "06-round-0-test-gate-attempt-1.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      gate: { name: "test", argv: ["bun", "test"] },
      stdout: "gate stdout\n",
      stderr: "gate stderr\n",
    });
  });

  it("records an authorized passing same-HEAD rerun without fabricating a fix commit", async () => {
    const { fixture, base, head, previousEvidencePath } = await failedGateFixture();
    expect(readIntegration(fixture.statePath)).toMatchObject({
      phase: "fixing",
      reviewed_commit_patch_ids: ["b".repeat(40)],
    });
    const before = readFileSync(fixture.statePath, "utf8");
    const unauthorized = await runCli(
      gateRerunRequest(fixture, previousEvidencePath, { user_authorized: false }),
    );
    expect(unauthorized.exitCode).toBe(2);
    expect(readFileSync(fixture.statePath, "utf8")).toBe(before);

    const result = await runCli(
      gateRerunRequest(fixture, previousEvidencePath, {
        completed_at: "2000-09-19T01:00:00Z",
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.result).toMatchObject({
      ticket: "06",
      round: 0,
      name: "test",
      attempt: 2,
      status: "passed",
      action: "continue",
      head,
      previous_evidence_path: previousEvidencePath,
      user_authorized: true,
      recovered: false,
    });
    expect(
      JSON.parse(
        readFileSync(
          join(fixture.runPath, "reviews", "06-round-0-test-gate-attempt-2.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      ticket: "06",
      head,
      attempt: 2,
      status: "passed",
      action: "continue",
      rerun_of: previousEvidencePath,
      user_authorized: true,
      recovery_diagnostic: "unrelated full-suite timeout passed on unchanged rerun",
    });
    const state = readFileSync(fixture.statePath, "utf8");
    expect(readIntegration(fixture.statePath)).toMatchObject({
      phase: "gates",
      review_range: `${base}..${head}`,
      commit_count: 1,
      passed_gates: ["test"],
      reviewed_commit_patch_ids: null,
    });
    expect(state.includes("Phase: gates after authorized no-change rerun")).toBe(true);
    expect(state.includes("user-authorized no-change rerun of gate test")).toBe(true);

    const recovered = await runCli(
      gateRerunRequest(fixture, previousEvidencePath, {
        completed_at: "2000-09-19T01:00:00Z",
      }),
    );
    expect(recovered.exitCode).toBe(0);
    expect((recovered.stdout.result as { recovered: boolean }).recovered).toBe(true);
    expect(readFileSync(fixture.statePath, "utf8")).toBe(state);
  });

  it("rejects a no-change gate rerun from a dirty worktree", async () => {
    const dirty = await failedGateFixture();
    writeFileSync(join(dirty.fixture.worktreePath, "untracked.txt"), "dirty\n");

    const result = await runCli(gateRerunRequest(dirty.fixture, dirty.previousEvidencePath));

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatchObject({
      errors: [{ code: "gate.rerun_worktree_dirty" }],
    });
  });

  it("rejects a no-change gate rerun after HEAD changes", async () => {
    const changed = await failedGateFixture();
    writeFileSync(join(changed.fixture.worktreePath, "later.txt"), "later\n");
    expect(spawnGit(["add", "later.txt"], { cwd: changed.fixture.worktreePath }).exitCode).toBe(0);
    expect(
      spawnGit(
        ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "later"],
        { cwd: changed.fixture.worktreePath },
      ).exitCode,
    ).toBe(0);

    const result = await runCli(gateRerunRequest(changed.fixture, changed.previousEvidencePath));

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatchObject({
      errors: [{ code: "gate.rerun_state_invalid" }],
    });
  });

  it("rejects a no-change gate rerun with mismatched prior evidence", async () => {
    const mismatched = await failedGateFixture();

    const result = await runCli(
      gateRerunRequest(mismatched.fixture, mismatched.previousEvidencePath, { name: "format" }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatchObject({
      errors: [{ code: "gate.rerun_previous_evidence_invalid" }],
    });
  });

  it("applies bounded retries only to gate infrastructure failures", async () => {
    const fixture = makeFixture("pi");
    await preparePolicy(fixture);
    await activateFixture(fixture, "pi");

    expect(
      (await runCli(gateRecordRequest(fixture, "infrastructure_failed", 1))).stdout,
    ).toMatchObject({
      result: { action: "retry", retry_delay_seconds: 1, next_attempt: 2 },
    });
    expect(
      (await runCli(gateRecordRequest(fixture, "infrastructure_failed", 3))).stdout,
    ).toMatchObject({
      result: { action: "retry", retry_delay_seconds: 4, next_attempt: 4 },
    });
    expect(
      (await runCli(gateRecordRequest(fixture, "infrastructure_failed", 4))).stdout,
    ).toMatchObject({
      result: { action: "blocked", retry_delay_seconds: null, next_attempt: null },
    });
  });

  it("consolidates every actionable finding into one Pi fallback fix request", async () => {
    const fixture = makeFixture("pi");
    await preparePolicy(fixture);
    await activateFixture(fixture, "pi");
    const standards = reviewLaunchRequest(fixture, "standards");
    const spec = reviewLaunchRequest(fixture, "spec");
    expect((await runCli(standards)).exitCode).toBe(0);
    expect((await runCli(spec)).exitCode).toBe(0);
    expect((await recordReview(fixture, standards, failingReport("Standards"))).exitCode).toBe(0);
    expect(
      (await recordReview(fixture, spec, failingReport("Spec"), "2026-09-19T01:01:00Z")).exitCode,
    ).toBe(0);
    const selfReviewPath = join(fixture.runPath, "reviews", "06-round-0-self-review.md");
    const fixRequestPath = join(fixture.runPath, "briefs", "fixes-06-round-0.md");

    const result = await runCli({
      schema_version: 1,
      operation: "review.round.finalize",
      input: {
        state_path: fixture.statePath,
        ticket: "06",
        round: 0,
        standards_evidence_path: `${standards.input.report_path}.json`,
        spec_evidence_path: `${spec.input.report_path}.json`,
        self_review_path: selfReviewPath,
        self_review_method: "standards-spec-single-session",
        self_review_report:
          "# Pi self-review\n\n## Standards\n\nNo findings.\n\n## Spec\n\nNo findings.\n",
        fix_request_path: fixRequestPath,
        completed_at: "2026-09-19T01:05:00Z",
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatchObject({
      result: {
        verdict: "FAIL",
        action: "fix",
        fix_request_authorized: true,
        next_round: 1,
        fix_commit_policy: "append",
        findings: [
          { axis: "standards", location: "src/example.ts:12" },
          { axis: "spec", location: "src/example.ts:12" },
        ],
      },
    });
    const request = readFileSync(fixRequestPath, "utf8");
    expect(request.match(/Location: src\/example\.ts:12/gu)?.length).toBe(2);
    expect(request).toContain(
      "This ordinary review-remediation request is pre-authorized by the run's standing fix loop.",
    );
    expect(request).toContain("rerun every recorded gate");
    expect(readFileSync(selfReviewPath, "utf8")).toContain("## Standards");
  });

  it("accepts a clean Claude self-review round and retains both reports", async () => {
    const fixture = makeFixture("claude");
    await preparePolicy(fixture);
    await activateFixture(fixture, "claude");
    const standards = reviewLaunchRequest(fixture, "standards");
    const spec = reviewLaunchRequest(fixture, "spec");
    expect((await runCli(standards)).exitCode).toBe(0);
    expect((await runCli(spec)).exitCode).toBe(0);
    expect((await recordReview(fixture, standards, passingReport("Standards"))).exitCode).toBe(0);
    expect(
      (await recordReview(fixture, spec, passingReport("Spec"), "2026-09-19T01:01:00Z")).exitCode,
    ).toBe(0);
    const selfReviewPath = join(fixture.runPath, "reviews", "06-round-0-self-review.md");

    const result = await runCli({
      schema_version: 1,
      operation: "review.round.finalize",
      input: {
        state_path: fixture.statePath,
        ticket: "06",
        round: 0,
        standards_evidence_path: `${standards.input.report_path}.json`,
        spec_evidence_path: `${spec.input.report_path}.json`,
        self_review_path: selfReviewPath,
        self_review_method: "matt-implement",
        self_review_report: "# Matt implement self-review\n\nNo findings.\n",
        fix_request_path: join(fixture.runPath, "briefs", "fixes-06-round-0.md"),
        completed_at: "2026-09-19T01:05:00Z",
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatchObject({
      result: {
        verdict: "PASS",
        action: "land",
        findings: [],
        fix_request_path: null,
        next_round: null,
      },
    });
    expect(readFileSync(standards.input.report_path, "utf8")).toContain("PASS");
    expect(readFileSync(spec.input.report_path, "utf8")).toContain("PASS");
  });

  it("rejects accepted review evidence after a failed gate changes the integration phase", async () => {
    const fixture = makeFixture("pi");
    await preparePolicy(fixture);
    await activateFixture(fixture, "pi");
    const head = spawnGit(["rev-parse", "HEAD"], { cwd: fixture.worktreePath }).stdout.trim();
    injectIntegration(fixture.statePath, integrationRecord(head, head));
    const cycleZeroGates = await recordPassingGates(fixture, 0, 2, "-cycle-zero");
    const standards = reviewLaunchRequest(fixture, "standards");
    standards.input.gate_evidence_paths = cycleZeroGates;
    standards.input.base_ref = head;
    const spec = reviewLaunchRequest(fixture, "spec");
    spec.input.gate_evidence_paths = cycleZeroGates;
    spec.input.base_ref = head;
    expect((await runCli(standards)).exitCode).toBe(0);
    expect((await runCli(spec)).exitCode).toBe(0);
    expect((await recordReview(fixture, standards, passingReport("Standards"))).exitCode).toBe(0);
    expect((await recordReview(fixture, spec, passingReport("Spec"))).exitCode).toBe(0);
    expect((await runCli(gateRecordRequest(fixture, "failed", 2))).exitCode).toBe(0);

    const result = await runCli({
      schema_version: 1,
      operation: "review.round.finalize",
      input: {
        state_path: fixture.statePath,
        ticket: "06",
        round: 0,
        standards_evidence_path: `${standards.input.report_path}.json`,
        spec_evidence_path: `${spec.input.report_path}.json`,
        self_review_path: join(fixture.runPath, "reviews", "06-round-0-self-review.md"),
        self_review_method: "standards-spec-single-session",
        self_review_report: "## Standards\n\nPASS\n\n## Spec\n\nPASS\n",
        fix_request_path: join(fixture.runPath, "briefs", "fixes-06-round-0.md"),
        completed_at: "2026-09-19T01:05:00Z",
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.errors).toEqual([
      {
        code: "landing.review_phase_invalid",
        message: "Final review requires the ticket integration to remain in the gates phase.",
        remediation:
          "Rerun every configured gate and both review axes against the current integrated ticket tip.",
      },
    ]);
    expect(readIntegration(fixture.statePath)?.phase).toBe("fixing");
  });

  it("keeps remediation authorized after the third failed fix round", async () => {
    const fixture = makeFixture("pi");
    await preparePolicy(fixture);
    await activateFixture(fixture, "pi");
    await recordPassingGates(fixture, 3);
    const standards = reviewLaunchRequest(fixture, "standards", 1, 3);
    const spec = reviewLaunchRequest(fixture, "spec", 1, 3);
    expect((await runCli(standards)).exitCode).toBe(0);
    expect((await runCli(spec)).exitCode).toBe(0);
    expect((await recordReview(fixture, standards, failingReport("Standards"))).exitCode).toBe(0);
    expect((await recordReview(fixture, spec, passingReport("Spec"))).exitCode).toBe(0);

    const result = await runCli({
      schema_version: 1,
      operation: "review.round.finalize",
      input: {
        state_path: fixture.statePath,
        ticket: "06",
        round: 3,
        standards_evidence_path: `${standards.input.report_path}.json`,
        spec_evidence_path: `${spec.input.report_path}.json`,
        self_review_path: join(fixture.runPath, "reviews", "06-round-3-self-review.md"),
        self_review_method: "standards-spec-single-session",
        self_review_report:
          "# Pi self-review\n\n## Standards\n\nNo findings.\n\n## Spec\n\nNo findings.\n",
        fix_request_path: join(fixture.runPath, "briefs", "fixes-06-round-3.md"),
        completed_at: "2026-09-19T02:00:00Z",
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatchObject({
      result: {
        verdict: "FAIL",
        action: "fix",
        fix_request_authorized: true,
        next_round: 4,
      },
    });
    const state = readFileSync(fixture.statePath, "utf8");
    expect(state).toContain("Ticket 06 round 3 finalized: FAIL");
    expect(state.includes("blocked, awaiting escalation role")).toBe(false);
  });

  it("authorizes and idempotently recovers continuation with the existing ticket role", async () => {
    const { fixture, fixRequestPath } = await legacyEscalationFixture("pi");
    const request = escalationRequest(fixture, fixRequestPath, "continue-existing", {
      harness: "pi",
      model: "openai/test",
      effort: "high",
    });
    const liveEnv = { ...HERDR_ENV, HERDR_TEST_LIVE_PANES: '["workspace:p6"]' };

    const result = await runCli(request, liveEnv);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatchObject({
      result: {
        ticket: "06",
        exhausted_round: 3,
        next_round: 4,
        strategy: "continue-existing",
        recovered: false,
        action: "prompt-existing",
        runtime_closed: false,
        pane_id: "workspace:p6",
        worker: { pane: "workspace:p6" },
      },
    });
    const state = readFileSync(fixture.statePath, "utf8");
    expect(state).toContain("| 06 | pi | openai/test | high | 3 | yes | working | - |");
    expect(state).toContain("Phase: escalation fixes authorized, round 4");
    expect(state).toContain("user-authorized review escalation after round 3");

    const recovered = await runCli(request, liveEnv);
    expect(recovered.exitCode).toBe(0);
    expect(recovered.stdout).toMatchObject({ result: { recovered: true } });
    expect(readFileSync(fixture.statePath, "utf8")).toBe(state);
  });

  it("closes a superseded runtime before recording an idempotent replacement role", async () => {
    const { fixture, fixRequestPath } = await legacyEscalationFixture("pi");
    const request = escalationRequest(fixture, fixRequestPath, "replace-implementor", {
      harness: "claude",
      model: "opus",
      effort: "high",
    });

    const close = await runCli(request, {
      ...HERDR_ENV,
      HERDR_TEST_LIVE_PANES: '["workspace:p6"]',
    });
    expect(close.exitCode).toBe(0);
    expect(close.stdout).toMatchObject({
      result: {
        action: "close-runtime",
        runtime_closed: false,
        close: { command: "herdr", args: ["pane", "close", "workspace:p6"] },
      },
    });
    const blockedState = readFileSync(fixture.statePath, "utf8");
    expect(blockedState).toContain("Phase: blocked, awaiting escalation role");

    const authorized = await runCli(request);
    expect(authorized.exitCode).toBe(0);
    expect(authorized.stdout).toMatchObject({
      result: {
        strategy: "replace-implementor",
        role: { harness: "claude", model: "opus", effort: "high" },
        recovered: false,
        action: "prepare-replacement",
        worker: null,
        runtime_closed: true,
      },
    });
    const state = readFileSync(fixture.statePath, "utf8");
    expect(state).toContain("| 06 | claude | opus | high | 3 | yes | blocked | - |");
    expect(state.includes("### 06")).toBe(false);
    expect(state).toContain("escalation superseded runtime");
    expect(state).toContain('"artifact":"' + fixture.worktreePath + '/launch-06.json"');

    const recovered = await runCli(request);
    expect(recovered.exitCode).toBe(0);
    expect(recovered.stdout).toMatchObject({
      result: { recovered: true, action: "prepare-replacement" },
    });
    expect(readFileSync(fixture.statePath, "utf8")).toBe(state);
  });

  it("rejects escalation without explicit user authority or exhausted review state", async () => {
    const fixture = makeFixture("pi", true);
    const fixRequestPath = join(fixture.runPath, "briefs", "fixes-06-round-3.md");
    writeFileSync(fixRequestPath, "# Fix request\n");
    const unauthorized = escalationRequest(fixture, fixRequestPath, "continue-existing", {
      harness: "pi",
      model: "openai/test",
      effort: "high",
    });
    unauthorized.input.user_authorized = false;

    const rejectedAuthority = await runCli(unauthorized);
    expect(rejectedAuthority.exitCode).toBe(2);
    expect(rejectedAuthority.stdout).toMatchObject({ errors: [{ code: "request.invalid" }] });

    const rejectedState = await runCli(
      escalationRequest(fixture, fixRequestPath, "continue-existing", {
        harness: "pi",
        model: "openai/test",
        effort: "high",
      }),
      { ...HERDR_ENV, HERDR_TEST_LIVE_PANES: '["workspace:p6"]' },
    );
    expect(rejectedState.exitCode).toBe(1);
    expect(rejectedState.stdout).toMatchObject({
      errors: [{ code: "review.escalation_state_invalid" }],
    });
  });

  it("enforces continuation and replacement role selection", async () => {
    const continuation = await legacyEscalationFixture("pi");
    const wrongContinuation = await runCli(
      escalationRequest(continuation.fixture, continuation.fixRequestPath, "continue-existing", {
        harness: "claude",
        model: "opus",
        effort: "high",
      }),
      { ...HERDR_ENV, HERDR_TEST_LIVE_PANES: '["workspace:p6"]' },
    );
    expect(wrongContinuation.exitCode).toBe(1);
    expect(wrongContinuation.stdout).toMatchObject({
      errors: [{ code: "review.escalation_continue_role_mismatch" }],
    });

    const replacement = await legacyEscalationFixture("pi");
    const unchangedReplacement = await runCli(
      escalationRequest(replacement.fixture, replacement.fixRequestPath, "replace-implementor", {
        harness: "pi",
        model: "openai/test",
        effort: "high",
      }),
      { ...HERDR_ENV, HERDR_TEST_LIVE_PANES: '["workspace:p6"]' },
    );
    expect(unchangedReplacement.exitCode).toBe(1);
    expect(unchangedReplacement.stdout).toMatchObject({
      errors: [{ code: "review.escalation_replacement_role_unchanged" }],
    });
  });
});
