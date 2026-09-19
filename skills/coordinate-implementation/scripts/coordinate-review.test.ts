import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnGit } from "./lib/git.ts";
import { createFakeHerdrEnv } from "./test-herdr.ts";

const CLI = join(import.meta.dir, "coordinate.ts");
const decoder = new TextDecoder();
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
  return {
    exitCode: child.exitCode,
    stdout: JSON.parse(decoder.decode(child.stdout).trim()) as Record<string, unknown>,
    stderr: decoder.decode(child.stderr),
  };
};

const stateText = (implementor: "claude" | "pi", active: boolean): string => `# review run

Schema version: 1

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

const preparePolicy = (fixture: ReviewFixture): void => {
  expect(runCli(policyRequest(fixture)).exitCode).toBe(0);
};

const recordPassingGates = (fixture: ReviewFixture, round: number): void => {
  for (const [name, argv] of [
    ["format", ["bun", "run", "format:check"]],
    ["test", ["bun", "test"]],
  ] as const) {
    const result = runCli({
      schema_version: 1,
      operation: "gate.record",
      input: {
        state_path: fixture.statePath,
        evidence_path: join(fixture.runPath, "reviews", `06-round-${round}-${name}-gate.json`),
        worktree_path: fixture.worktreePath,
        ticket: "06",
        round,
        name,
        attempt: 1,
        status: "passed",
        exit_code: 0,
        stdout: `${argv.join(" ")} passed\n`,
        stderr: "",
        completed_at: "2026-09-19T00:59:00Z",
      },
    });
    expect(result.exitCode).toBe(0);
  }
};

const activateFixture = (fixture: ReviewFixture, implementor: "claude" | "pi"): void => {
  const policy = readFileSync(fixture.statePath, "utf8").match(
    /^## Review policy\s*\n\n```json\n[\s\S]*?\n```\s*$/mu,
  )?.[0];
  expect(typeof policy).toBe("string");
  const active = stateText(implementor, true)
    .replaceAll("WORKTREE", fixture.worktreePath)
    .replace("## Decisions", `${policy}\n\n## Decisions`);
  writeFileSync(fixture.statePath, active);
  recordPassingGates(fixture, 0);
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
  });
});

describe("review policy", () => {
  it("persists explicit repository gates and derives the Pi fallback self-review", () => {
    const fixture = makeFixture("pi");
    const result = runCli(policyRequest(fixture));

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

  it("retains Matt self-review for Claude implementors", () => {
    const fixture = makeFixture("claude");
    const result = runCli(policyRequest(fixture));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatchObject({
      ok: true,
      result: { self_review: "matt-implement" },
    });
  });

  it("rejects unresolved or inferred gate configuration", () => {
    const fixture = makeFixture("pi");
    const request = policyRequest(fixture);
    request.input.gates = [];

    const result = runCli(request);

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

const recordReview = (
  fixture: ReviewFixture,
  request: ReturnType<typeof reviewLaunchRequest>,
  report: string,
  completedAt = "2026-09-19T01:00:00Z",
): CliResult =>
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
  it("builds a fresh shell-free Herdr reviewer launch with a strict prompt", () => {
    const fixture = makeFixture("pi");
    preparePolicy(fixture);
    activateFixture(fixture, "pi");

    const result = runCli(reviewLaunchRequest(fixture, "standards"));

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

  it("requires the synchronized full-SHA base while finalization is serialized", () => {
    const fixture = makeFixture("pi");
    preparePolicy(fixture);
    activateFixture(fixture, "pi");
    const head = spawnGit(["rev-parse", "HEAD"], { cwd: fixture.worktreePath }).stdout.trim();
    writeFileSync(
      fixture.statePath,
      readFileSync(fixture.statePath, "utf8").replace(
        "## Decisions",
        `## Serialized finalization

\`\`\`json
${JSON.stringify(
  {
    ticket: "06",
    cycle: 1,
    phase: "gates",
    base_branch: "main",
    base_sha: head,
    ticket_sha: head,
    review_range: `${head}..${head}`,
    commit_count: 1,
    commit_policy: { commits: "multiple", fixes: "append" },
    remote_sync_argv: null,
    conflicts: [],
    previous_ticket_sha: null,
    standards_evidence_path: null,
    spec_evidence_path: null,
    self_review_path: null,
    completed_at: "2026-09-19T00:59:00Z",
  },
  null,
  2,
)}
\`\`\`

## Decisions`,
      ),
    );
    const wrongBase = reviewLaunchRequest(fixture, "standards");
    const rejected = runCli(wrongBase);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.range_mismatch" }],
    });

    const exactBase = reviewLaunchRequest(fixture, "standards");
    exactBase.input.base_ref = head;
    const accepted = runCli(exactBase);
    expect(accepted.exitCode).toBe(0);
    expect((accepted.stdout.result as { reviewed_head: string }).reviewed_head).toBe(head);
    expect(readFileSync(exactBase.input.artifact_path, "utf8")).toContain(
      "refused-fast-forward recovery review",
    );
  }, 15_000);

  it("refuses external review until every configured gate has passed", () => {
    const fixture = makeFixture("pi");
    preparePolicy(fixture);
    activateFixture(fixture, "pi");
    const request = reviewLaunchRequest(fixture, "standards");
    request.input.gate_evidence_paths = request.input.gate_evidence_paths.slice(0, 1);

    const result = runCli(request);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.gates_incomplete" }],
    });
  });

  it("rejects stale gate evidence after the reviewed HEAD changes", () => {
    const fixture = makeFixture("pi");
    preparePolicy(fixture);
    activateFixture(fixture, "pi");
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

    const result = runCli(reviewLaunchRequest(fixture, "standards"));

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.gates_incomplete" }],
    });
  });

  it("rejects gate evidence whose persisted worktree differs from the active runtime", () => {
    const fixture = makeFixture("pi");
    preparePolicy(fixture);
    activateFixture(fixture, "pi");
    const secondCheckout = join(fixture.root, "second-checkout");
    expect(
      spawnGit(["clone", "-q", fixture.worktreePath, secondCheckout], { cwd: fixture.root })
        .exitCode,
    ).toBe(0);
    const evidencePath = join(fixture.runPath, "reviews", "06-round-0-format-gate.json");
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as Record<string, unknown>;
    evidence.worktree_path = secondCheckout;
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

    const result = runCli(reviewLaunchRequest(fixture, "standards"));

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.gates_incomplete" }],
    });
  });

  it("persists clean PASS and actionable FAIL reports", () => {
    const fixture = makeFixture("pi");
    preparePolicy(fixture);
    activateFixture(fixture, "pi");
    const standards = reviewLaunchRequest(fixture, "standards");
    const spec = reviewLaunchRequest(fixture, "spec");
    expect(runCli(standards).exitCode).toBe(0);
    expect(runCli(spec).exitCode).toBe(0);

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
    const standardsClose = runCli(standardsRecord, {
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
    const standardsResult = runCli(standardsRecord);
    const specResult = runCli({
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

  it("refuses to overwrite a durable report with different content", () => {
    const fixture = makeFixture("pi");
    preparePolicy(fixture);
    activateFixture(fixture, "pi");
    const launch = reviewLaunchRequest(fixture, "standards");
    expect(runCli(launch).exitCode).toBe(0);
    expect(recordReview(fixture, launch, passingReport("Standards")).exitCode).toBe(0);

    const conflicting = recordReview(
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

  it("rejects launch recording from an artifact outside the run directory", () => {
    const fixture = makeFixture("pi");
    preparePolicy(fixture);
    activateFixture(fixture, "pi");
    const launch = reviewLaunchRequest(fixture, "standards");
    expect(runCli(launch).exitCode).toBe(0);
    const artifact = JSON.parse(readFileSync(launch.input.artifact_path, "utf8")) as Record<
      string,
      unknown
    >;
    const outsideArtifact = join(fixture.root, "outside-review.json");
    const outsideReport = join(fixture.root, "outside-review.md");
    artifact.artifact_path = outsideArtifact;
    artifact.report_path = outsideReport;
    writeFileSync(outsideArtifact, `${JSON.stringify(artifact, null, 2)}\n`);

    const result = runCli({
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

  it("rejects a report path that escapes the run through a symlink", () => {
    const fixture = makeFixture("pi");
    preparePolicy(fixture);
    activateFixture(fixture, "pi");
    const launch = reviewLaunchRequest(fixture, "standards");
    expect(runCli(launch).exitCode).toBe(0);
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

    const result = recordReview(fixture, launch, passingReport("Standards"));

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.evidence_outside_run" }],
    });
  });

  it("rejects an artifact whose declared path differs from the supplied path", () => {
    const fixture = makeFixture("pi");
    preparePolicy(fixture);
    activateFixture(fixture, "pi");
    const launch = reviewLaunchRequest(fixture, "standards");
    expect(runCli(launch).exitCode).toBe(0);
    const artifact = JSON.parse(readFileSync(launch.input.artifact_path, "utf8")) as Record<
      string,
      unknown
    >;
    artifact.artifact_path = join(fixture.runPath, "reviews", "different.json");
    writeFileSync(launch.input.artifact_path, `${JSON.stringify(artifact, null, 2)}\n`);

    const result = recordReview(fixture, launch, passingReport("Standards"));

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.artifact_mismatch" }],
    });
  });

  it("retries malformed verdicts with the same reviewer configuration", () => {
    const fixture = makeFixture("pi");
    preparePolicy(fixture);
    activateFixture(fixture, "pi");
    const launch = reviewLaunchRequest(fixture, "standards");
    expect(runCli(launch).exitCode).toBe(0);

    const malformed = recordReview(
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
    const retry = runCli(reviewLaunchRequest(fixture, "standards", 2));
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

  it("rejects retry attempts that change the reviewed base ref", () => {
    const fixture = makeFixture("pi");
    preparePolicy(fixture);
    activateFixture(fixture, "pi");
    const first = reviewLaunchRequest(fixture, "standards");
    expect(runCli(first).exitCode).toBe(0);
    expect(
      recordReview(fixture, first, failingReport("Standards").replace(/FAIL\n$/u, "PASS\n"))
        .exitCode,
    ).toBe(0);
    const retry = reviewLaunchRequest(fixture, "standards", 2);
    retry.input.base_ref = "release";

    const result = runCli(retry);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.retry_mismatch" }],
    });
  });

  it("rejects retry attempts that change the review source list", () => {
    const fixture = makeFixture("pi");
    preparePolicy(fixture);
    activateFixture(fixture, "pi");
    const first = reviewLaunchRequest(fixture, "spec");
    expect(runCli(first).exitCode).toBe(0);
    expect(
      recordReview(fixture, first, failingReport("Spec").replace(/FAIL\n$/u, "PASS\n")).exitCode,
    ).toBe(0);
    const retry = reviewLaunchRequest(fixture, "spec", 2);
    retry.input.context_paths = [...retry.input.context_paths, "unexpected.md"];

    const result = runCli(retry);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "review.retry_mismatch" }],
    });
  });

  it("retries a report with a placeholder source location as malformed", () => {
    const fixture = makeFixture("pi");
    preparePolicy(fixture);
    activateFixture(fixture, "pi");
    const launch = reviewLaunchRequest(fixture, "standards");
    expect(runCli(launch).exitCode).toBe(0);

    const result = recordReview(
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

  it("rejects and preserves reviewer worktree mutations", () => {
    const fixture = makeFixture("pi");
    preparePolicy(fixture);
    activateFixture(fixture, "pi");
    const launch = reviewLaunchRequest(fixture, "spec");
    expect(runCli(launch).exitCode).toBe(0);
    writeFileSync(join(fixture.worktreePath, "reviewer-created.txt"), "do not discard\n");

    const result = recordReview(fixture, launch, failingReport("Spec"));

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

  it("retries reviewer infrastructure failures three times without changing role", () => {
    const fixture = makeFixture("pi");
    preparePolicy(fixture);
    activateFixture(fixture, "pi");
    const first = reviewLaunchRequest(fixture, "spec", 1);
    expect(runCli(first).exitCode).toBe(0);

    const recordFailure = (request: ReturnType<typeof reviewLaunchRequest>): CliResult =>
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

    expect(recordFailure(first).stdout).toMatchObject({
      result: { action: "retry", retry_delay_seconds: 1, next_attempt: 2 },
    });
    const second = reviewLaunchRequest(fixture, "spec", 2);
    expect(runCli(second).exitCode).toBe(0);
    expect(recordFailure(second).stdout).toMatchObject({
      result: { action: "retry", retry_delay_seconds: 2, next_attempt: 3 },
    });
    const third = reviewLaunchRequest(fixture, "spec", 3);
    expect(runCli(third).exitCode).toBe(0);
    expect(recordFailure(third).stdout).toMatchObject({
      result: { action: "retry", retry_delay_seconds: 4, next_attempt: 4 },
    });
    const fourth = reviewLaunchRequest(fixture, "spec", 4);
    expect(runCli(fourth).exitCode).toBe(0);
    expect(recordFailure(fourth).stdout).toMatchObject({
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

const failedGateFixture = (): {
  fixture: ReviewFixture;
  base: string;
  head: string;
  previousEvidencePath: string;
} => {
  const fixture = makeFixture("pi");
  preparePolicy(fixture);
  activateFixture(fixture, "pi");
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
  const finalization = {
    ticket: "06",
    cycle: 0,
    phase: "gates",
    base_branch: "main",
    base_sha: base,
    ticket_sha: head,
    review_range: `${base}..${head}`,
    commit_count: 1,
    commit_policy: { commits: "multiple", fixes: "append" },
    remote_sync_argv: null,
    conflicts: [],
    previous_ticket_sha: null,
    standards_evidence_path: null,
    spec_evidence_path: null,
    self_review_path: null,
    completed_at: "2026-09-19T00:58:00Z",
  };
  writeFileSync(
    fixture.statePath,
    readFileSync(fixture.statePath, "utf8").replace(
      "## Decisions",
      `## Serialized finalization\n\n\`\`\`json\n${JSON.stringify(finalization, null, 2)}\n\`\`\`\n\n## Decisions`,
    ),
  );
  const failed = runCli(gateRecordRequest(fixture, "failed"));
  expect(failed.exitCode).toBe(0);
  return {
    fixture,
    base,
    head,
    previousEvidencePath: join(fixture.runPath, "reviews", "06-round-0-test-gate-attempt-1.json"),
  };
};

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
  it("rejects gate evidence from a second checkout at the same HEAD", () => {
    const fixture = makeFixture("pi");
    preparePolicy(fixture);
    activateFixture(fixture, "pi");
    const secondCheckout = join(fixture.root, "second-checkout");
    expect(
      spawnGit(["clone", "-q", fixture.worktreePath, secondCheckout], { cwd: fixture.root })
        .exitCode,
    ).toBe(0);
    const request = gateRecordRequest(fixture, "passed");
    request.input.worktree_path = secondCheckout;

    const result = runCli(request);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatchObject({
      ok: false,
      errors: [{ code: "gate.worktree_mismatch" }],
    });
  });

  it("records a red gate as a fix without treating it as infrastructure", () => {
    const fixture = makeFixture("pi");
    preparePolicy(fixture);
    activateFixture(fixture, "pi");

    const result = runCli(gateRecordRequest(fixture, "failed"));

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

  it("records an authorized passing same-HEAD rerun without fabricating a fix commit", () => {
    const { fixture, base, head, previousEvidencePath } = failedGateFixture();
    writeFileSync(
      fixture.statePath,
      readFileSync(fixture.statePath, "utf8").replace(
        '"phase": "fixing"',
        '"phase": "synchronizing"',
      ),
    );
    const before = readFileSync(fixture.statePath, "utf8");
    const unauthorized = runCli(
      gateRerunRequest(fixture, previousEvidencePath, { user_authorized: false }),
    );
    expect(unauthorized.exitCode).toBe(2);
    expect(readFileSync(fixture.statePath, "utf8")).toBe(before);

    const result = runCli(gateRerunRequest(fixture, previousEvidencePath));

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
    expect(state.includes('"phase": "gates"')).toBe(true);
    expect(state.includes(`"review_range": "${base}..${head}"`)).toBe(true);
    expect(state.includes('"commit_count": 1')).toBe(true);
    expect(state.includes('"previous_ticket_sha": null')).toBe(true);
    expect(state.includes("Phase: gates after authorized no-change rerun")).toBe(true);
    expect(state.includes("user-authorized no-change rerun of gate test")).toBe(true);

    const recovered = runCli(gateRerunRequest(fixture, previousEvidencePath));
    expect(recovered.exitCode).toBe(0);
    expect((recovered.stdout.result as { recovered: boolean }).recovered).toBe(true);
    expect(readFileSync(fixture.statePath, "utf8")).toBe(state);
  });

  it("rejects a no-change gate rerun from a dirty worktree", () => {
    const dirty = failedGateFixture();
    writeFileSync(join(dirty.fixture.worktreePath, "untracked.txt"), "dirty\n");

    const result = runCli(gateRerunRequest(dirty.fixture, dirty.previousEvidencePath));

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatchObject({
      errors: [{ code: "gate.rerun_worktree_dirty" }],
    });
  });

  it("rejects a no-change gate rerun after HEAD changes", () => {
    const changed = failedGateFixture();
    writeFileSync(join(changed.fixture.worktreePath, "later.txt"), "later\n");
    expect(spawnGit(["add", "later.txt"], { cwd: changed.fixture.worktreePath }).exitCode).toBe(0);
    expect(
      spawnGit(
        ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "later"],
        { cwd: changed.fixture.worktreePath },
      ).exitCode,
    ).toBe(0);

    const result = runCli(gateRerunRequest(changed.fixture, changed.previousEvidencePath));

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatchObject({
      errors: [{ code: "gate.rerun_state_invalid" }],
    });
  });

  it("rejects a no-change gate rerun with mismatched prior evidence", () => {
    const mismatched = failedGateFixture();

    const result = runCli(
      gateRerunRequest(mismatched.fixture, mismatched.previousEvidencePath, { name: "format" }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatchObject({
      errors: [{ code: "gate.rerun_previous_evidence_invalid" }],
    });
  });

  it("applies bounded retries only to gate infrastructure failures", () => {
    const fixture = makeFixture("pi");
    preparePolicy(fixture);
    activateFixture(fixture, "pi");

    expect(runCli(gateRecordRequest(fixture, "infrastructure_failed", 1)).stdout).toMatchObject({
      result: { action: "retry", retry_delay_seconds: 1, next_attempt: 2 },
    });
    expect(runCli(gateRecordRequest(fixture, "infrastructure_failed", 3)).stdout).toMatchObject({
      result: { action: "retry", retry_delay_seconds: 4, next_attempt: 4 },
    });
    expect(runCli(gateRecordRequest(fixture, "infrastructure_failed", 4)).stdout).toMatchObject({
      result: { action: "blocked", retry_delay_seconds: null, next_attempt: null },
    });
  });

  it("consolidates every actionable finding into one Pi fallback fix request", () => {
    const fixture = makeFixture("pi");
    preparePolicy(fixture);
    activateFixture(fixture, "pi");
    const standards = reviewLaunchRequest(fixture, "standards");
    const spec = reviewLaunchRequest(fixture, "spec");
    expect(runCli(standards).exitCode).toBe(0);
    expect(runCli(spec).exitCode).toBe(0);
    expect(recordReview(fixture, standards, failingReport("Standards")).exitCode).toBe(0);
    expect(
      recordReview(fixture, spec, failingReport("Spec"), "2026-09-19T01:01:00Z").exitCode,
    ).toBe(0);
    const selfReviewPath = join(fixture.runPath, "reviews", "06-round-0-self-review.md");
    const fixRequestPath = join(fixture.runPath, "briefs", "fixes-06-round-0.md");

    const result = runCli({
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
    expect(request).toContain("rerun every recorded gate");
    expect(readFileSync(selfReviewPath, "utf8")).toContain("## Standards");
  });

  it("accepts a clean Claude self-review round and retains both reports", () => {
    const fixture = makeFixture("claude");
    preparePolicy(fixture);
    activateFixture(fixture, "claude");
    const standards = reviewLaunchRequest(fixture, "standards");
    const spec = reviewLaunchRequest(fixture, "spec");
    expect(runCli(standards).exitCode).toBe(0);
    expect(runCli(spec).exitCode).toBe(0);
    expect(recordReview(fixture, standards, passingReport("Standards")).exitCode).toBe(0);
    expect(
      recordReview(fixture, spec, passingReport("Spec"), "2026-09-19T01:01:00Z").exitCode,
    ).toBe(0);
    const selfReviewPath = join(fixture.runPath, "reviews", "06-round-0-self-review.md");

    const result = runCli({
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

  it("rejects accepted review evidence after a failed gate changes finalization phase", () => {
    const fixture = makeFixture("pi");
    preparePolicy(fixture);
    activateFixture(fixture, "pi");
    const head = spawnGit(["rev-parse", "HEAD"], { cwd: fixture.worktreePath }).stdout.trim();
    const finalization = {
      ticket: "06",
      cycle: 0,
      phase: "gates",
      base_branch: "main",
      base_sha: "main",
      ticket_sha: head,
      review_range: `main..${head}`,
      commit_count: 1,
      commit_policy: { commits: "multiple", fixes: "append" },
      remote_sync_argv: null,
      conflicts: [],
      previous_ticket_sha: null,
      standards_evidence_path: null,
      spec_evidence_path: null,
      self_review_path: null,
      completed_at: "2026-09-19T00:59:00Z",
    };
    writeFileSync(
      fixture.statePath,
      readFileSync(fixture.statePath, "utf8").replace(
        "## Decisions",
        `## Serialized finalization\n\n\`\`\`json\n${JSON.stringify(finalization, null, 2)}\n\`\`\`\n\n## Decisions`,
      ),
    );
    const standards = reviewLaunchRequest(fixture, "standards");
    const spec = reviewLaunchRequest(fixture, "spec");
    expect(runCli(standards).exitCode).toBe(0);
    expect(runCli(spec).exitCode).toBe(0);
    expect(recordReview(fixture, standards, passingReport("Standards")).exitCode).toBe(0);
    expect(recordReview(fixture, spec, passingReport("Spec")).exitCode).toBe(0);
    expect(runCli(gateRecordRequest(fixture, "failed", 2)).exitCode).toBe(0);

    const result = runCli({
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
        message: "Final review requires serialized finalization to remain in the gates phase.",
        remediation:
          "Rerun every configured gate and both review axes against the current synchronized ticket tip.",
      },
    ]);
    expect(readFileSync(fixture.statePath, "utf8")).toContain('"phase": "fixing"');
  });

  it("requires explicit escalation after the third failed fix round", () => {
    const fixture = makeFixture("pi");
    preparePolicy(fixture);
    activateFixture(fixture, "pi");
    recordPassingGates(fixture, 3);
    const standards = reviewLaunchRequest(fixture, "standards", 1, 3);
    const spec = reviewLaunchRequest(fixture, "spec", 1, 3);
    expect(runCli(standards).exitCode).toBe(0);
    expect(runCli(spec).exitCode).toBe(0);
    expect(recordReview(fixture, standards, failingReport("Standards")).exitCode).toBe(0);
    expect(recordReview(fixture, spec, passingReport("Spec")).exitCode).toBe(0);

    const result = runCli({
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
        action: "escalate",
        next_round: null,
      },
    });
    const state = readFileSync(fixture.statePath, "utf8");
    expect(state).toContain("| 06 | pi | openai/test | high | 3 | yes | blocked | - |");
    expect(state).toContain("Phase: blocked, awaiting escalation role");
    expect(state.includes("## Serialized finalization")).toBe(false);
  });
});
