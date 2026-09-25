import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_ENV_KEYS, spawnGit } from "./lib/git.ts";
import {
  commitPatchIds,
  type IntegrationRecord,
  parseIntegration,
  rebasePrompt,
  ticketPatchId,
} from "./lib/integration.ts";
import { type CliResult, request, runJson } from "./test-cli.ts";
import { createFakeHerdrEnv } from "./test-herdr.ts";

const HERDR_ENV = createFakeHerdrEnv();

const runCli = (
  operation: string,
  input: Record<string, unknown>,
  env: Record<string, string | undefined> = HERDR_ENV,
) => runJson(request(operation, input), env);

type LandingFixture = {
  root: string;
  repositoryPath: string;
  worktreePath: string;
  statePath: string;
  branch: string;
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

Schema version: 2

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
    max_infrastructure_attempts: 4,
    retry_delays_seconds: [1, 2, 4],
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

const integrationOf = (fixture: LandingFixture, ticket = "07"): IntegrationRecord | undefined =>
  parseIntegration(readFileSync(fixture.statePath, "utf8"), ticket);

type TicketBinding = { ticket: string; worktreePath: string; branch: string };

const primary = (fixture: LandingFixture): TicketBinding => ({
  ticket: "07",
  worktreePath: fixture.worktreePath,
  branch: fixture.branch,
});

const addTicket = (fixture: LandingFixture, ticket: string): TicketBinding => {
  const branch = `ticket-${ticket}`;
  const worktreePath = join(fixture.root, "worktrees", branch);
  expect(
    spawnGit(["worktree", "add", "-q", "-b", branch, worktreePath, "main"], {
      cwd: fixture.repositoryPath,
    }).exitCode,
  ).toBe(0);
  writeFileSync(
    fixture.statePath,
    readFileSync(fixture.statePath, "utf8").replace(
      "## Review evidence",
      `### ${ticket}

Worktree: ${worktreePath}
Branch: ${branch}
Implementor: {"harness":"pi","model":"openai/test","effort":"high"}
Implement skill: /implement
Session: landing-${ticket}
Tab: implement landing ${ticket}
Pane: work:p${Number(ticket)}
Artifact: ${join(fixture.root, "run", "briefs", `launch-${ticket}.json`)}
Attempt: 1
Retry: 0 of 3
Phase: committed, awaiting review
Last diagnostic: none

## Review evidence`,
    ),
  );
  return { ticket, worktreePath, branch };
};

const rebaseCheck = (
  fixture: LandingFixture,
  binding: TicketBinding = primary(fixture),
  completedAt = "2026-09-19T02:00:00Z",
): Promise<CliResult> =>
  runCli("landing.rebase.check", {
    state_path: fixture.statePath,
    repository_path: fixture.repositoryPath,
    worktree_path: binding.worktreePath,
    ticket: binding.ticket,
    completed_at: completedAt,
  });

const landingInput = (
  fixture: LandingFixture,
  binding: TicketBinding = primary(fixture),
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  state_path: fixture.statePath,
  repository_path: fixture.repositoryPath,
  worktree_path: binding.worktreePath,
  evidence_path: join(fixture.root, "run", "reviews", `${binding.ticket}-landed.json`),
  ticket: binding.ticket,
  cleanup_argv: null,
  completed_at: "2026-09-19T02:40:00Z",
  ...overrides,
});

const recordGate = (
  fixture: LandingFixture,
  binding: TicketBinding,
  round: number,
  status: "passed" | "failed",
  suffix: string,
): Promise<CliResult> =>
  runCli("gate.record", {
    state_path: fixture.statePath,
    evidence_path: join(
      fixture.root,
      "run",
      "reviews",
      `${binding.ticket}-round-${round}-test-gate-${suffix}.json`,
    ),
    worktree_path: binding.worktreePath,
    ticket: binding.ticket,
    round,
    name: "test",
    attempt: 1,
    status,
    exit_code: status === "passed" ? 0 : 1,
    stdout: `test ${status}\n`,
    stderr: "",
    completed_at: "2026-09-19T02:10:00Z",
  });

const markReadyToLand = async (
  fixture: LandingFixture,
  binding: TicketBinding = primary(fixture),
  round = 0,
): Promise<{ standards: string; spec: string; selfReview: string }> => {
  const reviews = join(fixture.root, "run", "reviews");
  mkdirSync(reviews, { recursive: true });
  const gate = await recordGate(fixture, binding, round, "passed", "ready");
  expect(gate.exitCode).toBe(0);
  const baseSha = integrationOf(fixture, binding.ticket)!.base_sha;
  const evidence: Partial<Record<"standards" | "spec", string>> = {};
  for (const axis of ["standards", "spec"] as const) {
    const artifactPath = join(reviews, `${binding.ticket}-round-${round}-${axis}-attempt-1.json`);
    const reportPath = join(reviews, `${binding.ticket}-round-${round}-${axis}-attempt-1.md`);
    const launched = await runCli("review.launch.prepare", {
      state_path: fixture.statePath,
      previous_artifact_path: null,
      artifact_path: artifactPath,
      report_path: reportPath,
      ticket: binding.ticket,
      round,
      axis,
      worktree_path: binding.worktreePath,
      branch: binding.branch,
      base_ref: baseSha,
      pane: `workspace:p${Number(binding.ticket) * 10 + (axis === "standards" ? 1 : 2)}`,
      role: { harness: "claude", model: "sonnet", effort: "medium" },
      context_paths: axis === "standards" ? ["CLAUDE.md"] : ["spec.md", "ticket.md"],
      landed_tickets: [],
      gate_evidence_paths: [join(reviews, `${binding.ticket}-round-${round}-test-gate-ready.json`)],
      attempt: 1,
    });
    expect(launched.exitCode).toBe(0);
    const recorded = await runCli("review.launch.record", {
      state_path: fixture.statePath,
      artifact_path: artifactPath,
      status: "completed",
      report: `# ${axis}\n\nPASS\n`,
      diagnostic: null,
      completed_at: "2026-09-19T02:15:00Z",
    });
    expect(recorded.exitCode).toBe(0);
    evidence[axis] = `${reportPath}.json`;
  }
  const selfReview = join(reviews, `${binding.ticket}-round-${round}-self-review.md`);
  const finalized = await runCli("review.round.finalize", {
    state_path: fixture.statePath,
    ticket: binding.ticket,
    round,
    standards_evidence_path: evidence.standards!,
    spec_evidence_path: evidence.spec!,
    self_review_path: selfReview,
    self_review_method: "standards-spec-single-session",
    self_review_report: "## Standards\n\nPASS\n\n## Spec\n\nPASS\n",
    fix_request_path: join(
      fixture.root,
      "run",
      "briefs",
      `fixes-${binding.ticket}-round-${round}.md`,
    ),
    completed_at: "2026-09-19T02:20:00Z",
  });
  expect(finalized.exitCode).toBe(0);
  expect((finalized.stdout.result as { action: string }).action).toBe("land");
  expect(integrationOf(fixture, binding.ticket)?.phase).toBe("ready-to-land");
  return { standards: evidence.standards!, spec: evidence.spec!, selfReview };
};

const gitCommonLock = (fixture: LandingFixture): string =>
  join(
    spawnGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: fixture.repositoryPath,
    }).stdout.trim(),
    "land-local.lock",
  );

const holdLandLock = async (lockPath: string): Promise<Bun.Subprocess> => {
  const holder = Bun.spawn(
    ["flock", lockPath, process.execPath, "-e", "setTimeout(() => {}, 20000)"],
    { env: process.env, stdout: "ignore", stderr: "ignore" },
  );
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const probe = Bun.spawnSync(["flock", "-n", lockPath, "true"], { env: process.env });
    if (probe.exitCode === 1) return holder;
    await Bun.sleep(25);
  }
  holder.kill();
  throw new Error("Timed out waiting for the external land lock holder.");
};

const spawnCli = async (
  operation: string,
  input: Record<string, unknown>,
): Promise<{ exitCode: number; stdout: Record<string, unknown> }> => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "coordinate.ts")], {
    env: HERDR_ENV,
    stdin: Buffer.from(JSON.stringify({ schema_version: 1, operation, input })),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { exitCode, stdout: JSON.parse(stdout.trim()) as Record<string, unknown> };
};

const conflictingBaseAndTicket = (fixture: LandingFixture): void => {
  commit(fixture.worktreePath, "base.txt", "ticket\n", "ticket edits base");
};

const resolveRebase = (worktreePath: string, contents: string): void => {
  writeFileSync(join(worktreePath, "base.txt"), contents);
  expect(spawnGit(["add", "base.txt"], { cwd: worktreePath }).exitCode).toBe(0);
  expect(
    spawnGit(["-c", "core.editor=true", "rebase", "--continue"], { cwd: worktreePath }).exitCode,
  ).toBe(0);
};

const runLocked = (
  checkout: string,
  base: string,
  branch: string,
): { exitCode: number; stdout: string } => {
  const child = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "land-locked.ts"), checkout, base, branch],
    { env: process.env, stdout: "pipe", stderr: "pipe" },
  );
  return { exitCode: child.exitCode, stdout: child.stdout.toString() };
};

describe("per-ticket integration and landing", () => {
  it("rejects removed serialized finalization operations as unknown", async () => {
    for (const operation of ["landing.synchronize", "landing.yield", "landing.conflict.record"]) {
      const result = await runCli(operation, {});
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toMatchObject({ ok: false, errors: [{ code: "request.invalid" }] });
    }
  });

  it("rejects caller-asserted runtime closure", async () => {
    const result = await runCli("landing.complete", {
      state_path: "/run/RESUME.md",
      repository_path: "/repo",
      worktree_path: "/worktree",
      evidence_path: "/run/reviews/01-landed.json",
      ticket: "01",
      cleanup_argv: null,
      runtime_closed: true,
      completed_at: "2026-09-19T02:00:00Z",
    });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toMatchObject({ ok: false, errors: [{ code: "request.invalid" }] });
  });

  it("binds multiple commits against the local integration branch without a remote", async () => {
    const fixture = makeFixture();
    commit(fixture.worktreePath, "one.txt", "one\n", "one");
    const ticketTip = commit(fixture.worktreePath, "two.txt", "two\n", "two");

    const result = await rebaseCheck(fixture);

    const base = spawnGit(["rev-parse", "main"], { cwd: fixture.repositoryPath }).stdout.trim();
    const patchId = ticketPatchId(fixture.worktreePath, "main");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.result).toEqual({
      ticket: "07",
      action: "run-gates",
      phase: "gates",
      cycle: 0,
      base_branch: "main",
      base_sha: base,
      ticket_sha: ticketTip,
      review_range: `${base}..${ticketTip}`,
      commit_count: 2,
      commit_policy: { commits: "multiple", fixes: "append" },
      patch_id: patchId,
      reviews_kept: false,
      remote_synchronized: false,
      prompt: null,
    });
    expect(integrationOf(fixture)).toEqual({
      cycle: 0,
      phase: "gates",
      base_sha: base,
      ticket_sha: ticketTip,
      review_range: `${base}..${ticketTip}`,
      commit_count: 2,
      patch_id: patchId,
      commit_patch_ids: commitPatchIds(fixture.worktreePath, "main"),
      passed_gates: [],
      reviewed_head: null,
      reviewed_patch_id: null,
      reviewed_commit_patch_ids: null,
      standards_evidence_path: null,
      spec_evidence_path: null,
      self_review_path: null,
      completed_at: "2026-09-19T02:00:00Z",
    });
    expect(spawnGit(["remote"], { cwd: fixture.repositoryPath }).stdout).toBe("");

    const before = readFileSync(fixture.statePath, "utf8");
    const repeated = await rebaseCheck(fixture, primary(fixture), "2026-09-19T02:05:00Z");
    expect(repeated.exitCode).toBe(0);
    expect(readFileSync(fixture.statePath, "utf8")).toBe(before);
  });

  it("integrates tickets independently while another ticket is gated", async () => {
    const fixture = makeFixture();
    const other = addTicket(fixture, "08");
    commit(fixture.worktreePath, "seven.txt", "seven\n", "seven");
    commit(other.worktreePath, "eight.txt", "eight\n", "eight");

    expect((await rebaseCheck(fixture)).exitCode).toBe(0);
    expect((await rebaseCheck(fixture, other)).exitCode).toBe(0);
    expect((await recordGate(fixture, primary(fixture), 0, "passed", "a")).exitCode).toBe(0);
    expect((await recordGate(fixture, other, 0, "passed", "a")).exitCode).toBe(0);

    expect(integrationOf(fixture, "07")).toMatchObject({ phase: "gates", passed_gates: ["test"] });
    expect(integrationOf(fixture, "08")).toMatchObject({ phase: "gates", passed_gates: ["test"] });
  });

  it("returns an implementor rebase prompt instead of rebasing a ticket behind the base", async () => {
    const fixture = makeFixture();
    const ticketTip = commit(fixture.worktreePath, "ticket.txt", "ticket\n", "ticket");
    const newBase = commit(fixture.repositoryPath, "landed.txt", "landed\n", "landed");

    const result = await rebaseCheck(fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.result).toMatchObject({
      action: "rebase",
      phase: "rebase-required",
      base_sha: newBase,
      ticket_sha: ticketTip,
      cycle: 0,
    });
    expect((result.stdout.result as { prompt: string }).prompt).toBe(
      rebasePrompt({
        ticket: "07",
        baseBranch: "main",
        baseSha: newBase,
        worktreePath: fixture.worktreePath,
      }),
    );
    expect(spawnGit(["rev-parse", "HEAD"], { cwd: fixture.worktreePath }).stdout.trim()).toBe(
      ticketTip,
    );
    expect(readFileSync(fixture.statePath, "utf8")).toContain("Phase: rebase required");

    const incomplete = await rebaseCheck(fixture, primary(fixture), "2026-09-19T02:30:00Z");
    expect(incomplete.exitCode).toBe(0);
    expect(incomplete.stdout.result).toMatchObject({ action: "rebase", cycle: 0 });

    expect(spawnGit(["rebase", "main"], { cwd: fixture.worktreePath }).exitCode).toBe(0);
    const recorded = await rebaseCheck(fixture, primary(fixture), "2026-09-19T02:30:00Z");
    const rebasedTip = spawnGit(["rev-parse", "HEAD"], { cwd: fixture.worktreePath }).stdout.trim();
    expect(recorded.exitCode).toBe(0);
    expect(recorded.stdout.result).toMatchObject({
      action: "run-gates",
      phase: "gates",
      cycle: 1,
      base_sha: newBase,
      ticket_sha: rebasedTip,
      review_range: `${newBase}..${rebasedTip}`,
      reviews_kept: false,
      prompt: null,
    });

    const unchanged = await rebaseCheck(fixture, primary(fixture), "2026-09-19T02:30:00Z");
    expect(unchanged.exitCode).toBe(0);
    expect(unchanged.stdout.result).toMatchObject({ action: "run-gates", cycle: 1 });
  });

  it("refuses a dirty worktree or an unfinished rebase without changing state", async () => {
    const fixture = makeFixture();
    conflictingBaseAndTicket(fixture);
    commit(fixture.repositoryPath, "base.txt", "landed\n", "landed edits base");
    expect((await rebaseCheck(fixture)).exitCode).toBe(0);
    const before = readFileSync(fixture.statePath, "utf8");

    expect(spawnGit(["rebase", "main"], { cwd: fixture.worktreePath }).exitCode).toBe(1);
    const unfinished = await rebaseCheck(fixture, primary(fixture), "2026-09-19T02:30:00Z");
    expect(unfinished.exitCode).toBe(1);
    expect(unfinished.stdout).toMatchObject({
      errors: [{ code: "landing.operation_in_progress" }],
    });
    expect(readFileSync(fixture.statePath, "utf8")).toBe(before);

    resolveRebase(fixture.worktreePath, "landed\nticket\n");
    writeFileSync(join(fixture.worktreePath, "scratch.txt"), "dirty\n");
    const dirty = await rebaseCheck(fixture, primary(fixture), "2026-09-19T02:30:00Z");
    expect(dirty.exitCode).toBe(1);
    expect(dirty.stdout).toMatchObject({ errors: [{ code: "landing.worktree_dirty" }] });
    expect(readFileSync(fixture.statePath, "utf8")).toBe(before);
  });

  it("keeps both reviews and requires gates after a rebase with an identical patch id", async () => {
    const fixture = makeFixture();
    commit(fixture.worktreePath, "ticket.txt", "ticket\n", "ticket");
    expect((await rebaseCheck(fixture)).exitCode).toBe(0);
    const reviews = await markReadyToLand(fixture);
    const reviewed = integrationOf(fixture)!;
    const newBase = commit(fixture.repositoryPath, "landed.txt", "landed\n", "landed");

    const bounced = await runCli("landing.complete", landingInput(fixture));
    expect(bounced.exitCode).toBe(0);
    expect(bounced.stdout.result).toMatchObject({
      ticket: "07",
      action: "rebase",
      phase: "rebase-required",
      base_sha: newBase,
      ticket_sha: reviewed.ticket_sha,
      cycle: 0,
    });
    expect(spawnGit(["rev-parse", "main"], { cwd: fixture.repositoryPath }).stdout.trim()).toBe(
      newBase,
    );

    expect(spawnGit(["rebase", "main"], { cwd: fixture.worktreePath }).exitCode).toBe(0);
    const recorded = await rebaseCheck(fixture, primary(fixture), "2026-09-19T02:30:00Z");
    expect(recorded.exitCode).toBe(0);
    expect(recorded.stdout.result).toMatchObject({
      action: "run-gates",
      phase: "gates",
      cycle: 1,
      patch_id: reviewed.patch_id,
      reviews_kept: true,
    });
    expect(integrationOf(fixture)).toMatchObject({
      phase: "gates",
      passed_gates: [],
      reviewed_head: reviewed.ticket_sha,
      reviewed_patch_id: reviewed.patch_id,
      standards_evidence_path: reviews.standards,
      spec_evidence_path: reviews.spec,
      self_review_path: reviews.selfReview,
    });

    const gatesPending = await runCli("landing.complete", landingInput(fixture));
    expect(gatesPending.exitCode).toBe(1);
    expect(gatesPending.stdout).toMatchObject({ errors: [{ code: "landing.review_incomplete" }] });

    expect((await recordGate(fixture, primary(fixture), 0, "passed", "cycle-1")).exitCode).toBe(0);
    expect(integrationOf(fixture)?.phase).toBe("ready-to-land");
    const landed = await runCli("landing.complete", landingInput(fixture));
    const rebasedTip = spawnGit(["rev-parse", fixture.branch], {
      cwd: fixture.repositoryPath,
    }).stdout.trim();
    expect(landed.exitCode).toBe(0);
    expect(landed.stdout.result).toMatchObject({
      action: "schedule",
      landed_tip: rebasedTip,
      base_sha: rebasedTip,
      review_evidence: {
        standards: reviews.standards,
        spec: reviews.spec,
        self_review: reviews.selfReview,
      },
    });
  }, 20_000);

  it("requires both reviews again when a rebase changes the patch id", async () => {
    const fixture = makeFixture();
    conflictingBaseAndTicket(fixture);
    expect((await rebaseCheck(fixture)).exitCode).toBe(0);
    const reviewed = integrationOf(fixture)!;
    await markReadyToLand(fixture);
    commit(fixture.repositoryPath, "base.txt", "landed\n", "landed edits base");

    const bounced = await runCli("landing.complete", landingInput(fixture));
    expect((bounced.stdout.result as { action: string }).action).toBe("rebase");
    expect(spawnGit(["rebase", "main"], { cwd: fixture.worktreePath }).exitCode).toBe(1);
    resolveRebase(fixture.worktreePath, "landed\nticket\n");

    const recorded = await rebaseCheck(fixture, primary(fixture), "2026-09-19T02:30:00Z");
    expect(recorded.exitCode).toBe(0);
    expect(recorded.stdout.result).toMatchObject({
      action: "run-gates",
      cycle: 1,
      reviews_kept: false,
    });
    const rebased = integrationOf(fixture)!;
    expect(rebased.patch_id === reviewed.patch_id).toBe(false);
    expect(rebased).toMatchObject({
      phase: "gates",
      reviewed_head: null,
      reviewed_patch_id: null,
      standards_evidence_path: null,
      spec_evidence_path: null,
      self_review_path: null,
    });
    expect((await recordGate(fixture, primary(fixture), 1, "passed", "cycle-1")).exitCode).toBe(0);
    expect(integrationOf(fixture)?.phase).toBe("gates");
    const refused = await runCli("landing.complete", landingInput(fixture));
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout).toMatchObject({ errors: [{ code: "landing.review_incomplete" }] });
  }, 20_000);

  it("accepts appended fix commits and refuses rewritten ones under the append policy", async () => {
    const appended = makeFixture();
    commit(appended.worktreePath, "ticket.txt", "ticket\n", "ticket");
    expect((await rebaseCheck(appended)).exitCode).toBe(0);
    expect((await recordGate(appended, primary(appended), 0, "failed", "red")).exitCode).toBe(0);
    const baseline = integrationOf(appended)!;
    expect(baseline).toMatchObject({
      phase: "fixing",
      reviewed_commit_patch_ids: baseline.commit_patch_ids,
    });
    commit(appended.worktreePath, "fix.txt", "fix\n", "append fix");
    const appendResult = await rebaseCheck(appended, primary(appended), "2026-09-19T02:13:00Z");
    expect(appendResult.exitCode).toBe(0);
    expect(appendResult.stdout.result).toMatchObject({ action: "run-gates", commit_count: 2 });
    expect(integrationOf(appended)?.commit_patch_ids.slice(0, 1)).toEqual(
      baseline.commit_patch_ids,
    );

    const rewritten = makeFixture();
    commit(rewritten.worktreePath, "ticket.txt", "ticket\n", "ticket");
    expect((await rebaseCheck(rewritten)).exitCode).toBe(0);
    expect((await recordGate(rewritten, primary(rewritten), 0, "failed", "red")).exitCode).toBe(0);
    writeFileSync(join(rewritten.worktreePath, "ticket.txt"), "amended\n");
    expect(spawnGit(["add", "ticket.txt"], { cwd: rewritten.worktreePath }).exitCode).toBe(0);
    expect(
      spawnGit(["commit", "-q", "--amend", "--no-edit"], { cwd: rewritten.worktreePath }).exitCode,
    ).toBe(0);
    commit(rewritten.worktreePath, "fix.txt", "fix\n", "append after rewrite");
    const before = readFileSync(rewritten.statePath, "utf8");
    const amendResult = await rebaseCheck(rewritten, primary(rewritten), "2026-09-19T02:15:00Z");
    expect(amendResult.exitCode).toBe(1);
    expect(amendResult.stdout.errors).toEqual([
      {
        code: "landing.fix_policy_violated",
        message: "The fix round did not append commits to the commits recorded at the last review.",
        remediation:
          "Return the ticket to its bound implementor and apply the persisted append fix policy.",
      },
    ]);
    expect(readFileSync(rewritten.statePath, "utf8")).toBe(before);
    expect(integrationOf(rewritten)?.phase).toBe("fixing");
  });

  it("accepts explicit amend and squash fix policy overrides", async () => {
    const amended = makeFixture();
    writeFileSync(
      amended.statePath,
      readFileSync(amended.statePath, "utf8").replace('"fixes": "append"', '"fixes": "amend"'),
    );
    commit(amended.worktreePath, "ticket.txt", "ticket\n", "ticket");
    expect((await rebaseCheck(amended)).exitCode).toBe(0);
    expect((await recordGate(amended, primary(amended), 0, "failed", "red")).exitCode).toBe(0);
    writeFileSync(join(amended.worktreePath, "ticket.txt"), "amended\n");
    expect(spawnGit(["add", "ticket.txt"], { cwd: amended.worktreePath }).exitCode).toBe(0);
    expect(
      spawnGit(["commit", "-q", "--amend", "--no-edit"], { cwd: amended.worktreePath }).exitCode,
    ).toBe(0);
    const amendResult = await rebaseCheck(amended, primary(amended), "2026-09-19T02:17:00Z");
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
    const shapeFix = await rebaseCheck(squashed);
    expect(shapeFix.exitCode).toBe(0);
    expect((shapeFix.stdout.result as { action: string }).action).toBe("fix-commits");
    expect(spawnGit(["reset", "--soft", "main"], { cwd: squashed.worktreePath }).exitCode).toBe(0);
    expect(
      spawnGit(["commit", "-q", "-m", "squashed fix"], { cwd: squashed.worktreePath }).exitCode,
    ).toBe(0);
    const squashResult = await rebaseCheck(squashed, primary(squashed), "2026-09-19T02:19:00Z");
    expect(squashResult.exitCode).toBe(0);
    expect(squashResult.stdout.result).toMatchObject({
      action: "run-gates",
      commit_count: 1,
      commit_policy: { commits: "single", fixes: "squash" },
    });
  });

  it("returns a fix action when repository commit shape requires one commit", async () => {
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

    const result = await rebaseCheck(fixture);

    const base = spawnGit(["rev-parse", "main"], { cwd: fixture.repositoryPath }).stdout.trim();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.result).toEqual({
      ticket: "07",
      action: "fix-commits",
      phase: "fixing",
      cycle: 0,
      base_branch: "main",
      base_sha: base,
      ticket_sha: ticketTip,
      review_range: `${base}..${ticketTip}`,
      commit_count: 2,
      commit_policy: { commits: "single", fixes: "append" },
      patch_id: ticketPatchId(fixture.worktreePath, "main"),
      reviews_kept: false,
      remote_synchronized: false,
      prompt: null,
    });
    expect(readFileSync(fixture.statePath, "utf8")).toContain("Phase: commit policy fix required");
  });

  it("rejects repository and worktree paths that do not match the active runtime", async () => {
    const fixture = makeFixture();
    commit(fixture.worktreePath, "ticket.txt", "ticket\n", "ticket");

    const result = await runCli("landing.rebase.check", {
      state_path: fixture.statePath,
      repository_path: fixture.repositoryPath,
      worktree_path: fixture.repositoryPath,
      ticket: "07",
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

  it("fails closed when run state is locked by a live caller", async () => {
    const fixture = makeFixture();
    commit(fixture.worktreePath, "ticket.txt", "ticket\n", "ticket");
    writeFileSync(
      `${fixture.statePath}.state-lock`,
      `${JSON.stringify({
        pid: process.pid,
        token: "live-owner",
        created_at: "2026-09-19T02:01:00Z",
      })}\n`,
    );

    const result = await rebaseCheck(fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.errors).toEqual([
      {
        code: "landing.state_busy",
        message:
          "Could not update ticket integration state: Run state is being updated by another process.",
        remediation: "Verify RESUME.md is writable, then retry the same operation.",
      },
    ]);
  });

  it("sanitizes inherited Git location variables for fixtures and landing CLI operations", async () => {
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
    const result = await runCli(
      "landing.rebase.check",
      {
        state_path: fixture.statePath,
        repository_path: fixture.repositoryPath,
        worktree_path: fixture.worktreePath,
        ticket: "07",
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

  it("runs the persisted repository synchronization command before the ancestor check", async () => {
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

    const result = await rebaseCheck(fixture);

    expect(result.exitCode).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("ok");
    expect(result.stdout.result).toMatchObject({
      action: "run-gates",
      remote_synchronized: true,
    });
  });

  it("lands one of two concurrent ready tickets and bounces the other to a rebase", async () => {
    const fixture = makeFixture();
    const other = addTicket(fixture, "08");
    commit(fixture.worktreePath, "seven.txt", "seven\n", "seven");
    commit(other.worktreePath, "eight.txt", "eight\n", "eight");
    expect((await rebaseCheck(fixture)).exitCode).toBe(0);
    expect((await rebaseCheck(fixture, other)).exitCode).toBe(0);
    await markReadyToLand(fixture);
    await markReadyToLand(fixture, other);

    const outcomes = await Promise.all([
      spawnCli("landing.complete", landingInput(fixture)),
      spawnCli("landing.complete", landingInput(fixture, other)),
    ]);

    expect(outcomes.map((outcome) => outcome.exitCode)).toEqual([0, 0]);
    const actions = outcomes
      .map((outcome) => (outcome.stdout.result as { action: string }).action)
      .toSorted();
    expect(actions).toEqual(["rebase", "schedule"]);
    const landedIndex = outcomes.findIndex(
      (outcome) => (outcome.stdout.result as { action: string }).action === "schedule",
    );
    const bounced = landedIndex === 0 ? "08" : "07";
    const landed = landedIndex === 0 ? "07" : "08";
    const landedTip = (outcomes[landedIndex]!.stdout.result as { landed_tip: string }).landed_tip;
    expect(spawnGit(["rev-parse", "main"], { cwd: fixture.repositoryPath }).stdout.trim()).toBe(
      landedTip,
    );
    expect(integrationOf(fixture, bounced)).toMatchObject({
      phase: "rebase-required",
      base_sha: landedTip,
    });
    expect(integrationOf(fixture, landed)).toBe(undefined);
    expect(readFileSync(fixture.statePath, "utf8")).toContain(
      `| ${landed} | pi | openai/test | high | 0 | - | landed | ${landedTip} |`,
    );
  }, 30_000);

  it("times out while another process holds the shared land lock", async () => {
    const fixture = makeFixture();
    commit(fixture.worktreePath, "ticket.txt", "ticket\n", "ticket");
    expect((await rebaseCheck(fixture)).exitCode).toBe(0);
    await markReadyToLand(fixture);
    const baseBefore = spawnGit(["rev-parse", "main"], {
      cwd: fixture.repositoryPath,
    }).stdout.trim();
    const holder = await holdLandLock(gitCommonLock(fixture));
    try {
      const result = await runCli(
        "landing.complete",
        landingInput(fixture, primary(fixture), { lock_wait_seconds: 1 }),
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout.errors).toEqual([
        {
          code: "landing.lock_timeout",
          message:
            "Timed out waiting for the shared land-local.lock; another landing appears wedged.",
          remediation: "Investigate the process holding the lock before retrying the same landing.",
        },
      ]);
    } finally {
      holder.kill();
      await holder.exited;
    }
    expect(spawnGit(["rev-parse", "main"], { cwd: fixture.repositoryPath }).stdout.trim()).toBe(
      baseBefore,
    );
    expect(integrationOf(fixture)?.phase).toBe("ready-to-land");
  }, 20_000);

  it("resumes an already-landed ticket without taking the land lock", async () => {
    const fixture = makeFixture();
    const ticketTip = commit(fixture.worktreePath, "ticket.txt", "ticket\n", "ticket");
    expect((await rebaseCheck(fixture)).exitCode).toBe(0);
    const reviews = await markReadyToLand(fixture);

    const closeRuntime = await runCli("landing.complete", landingInput(fixture), {
      ...HERDR_ENV,
      HERDR_TEST_LIVE_PANES: JSON.stringify(["work:p7"]),
    });
    expect(closeRuntime.exitCode).toBe(0);
    expect(closeRuntime.stdout.result).toEqual({
      ticket: "07",
      action: "close-runtime",
      phase: "ready-to-land",
      base_sha: ticketTip,
      ticket_sha: ticketTip,
      cycle: 0,
      runtime_closed: false,
      pane_id: "work:p7",
      close: { command: "herdr", args: ["pane", "close", "work:p7"] },
    });
    expect(existsSync(fixture.worktreePath)).toBe(true);
    expect(existsSync(join(fixture.root, "run", "reviews", "07-landed.json"))).toBe(false);

    const holder = await holdLandLock(gitCommonLock(fixture));
    let landed: CliResult;
    try {
      landed = await runCli(
        "landing.complete",
        landingInput(fixture, primary(fixture), { lock_wait_seconds: 0 }),
      );
    } finally {
      holder.kill();
      await holder.exited;
    }

    expect(landed.exitCode).toBe(0);
    expect(landed.stdout.result).toEqual({
      ticket: "07",
      action: "schedule",
      phase: "landed",
      landed_tip: ticketTip,
      base_sha: ticketTip,
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
    expect(state).toContain(`| 07 | pi | openai/test | high | 0 | - | landed | ${ticketTip} |`);
    expect(state).toContain(`- ${fixture.branch} (${ticketTip})`);
    expect(state).toContain(`Base sha:        ${ticketTip}`);
    expect(state.includes("### 07")).toBe(false);
    expect(
      JSON.parse(readFileSync(join(fixture.root, "run", "reviews", "07-landed.json"), "utf8")),
    ).toEqual({
      schema_version: 1,
      ticket: "07",
      landed_tip: ticketTip,
      base_sha: ticketTip,
      integration_cycle: 0,
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
      completed_at: "2026-09-19T02:40:00Z",
    });
  }, 20_000);

  it("refuses to land into a dirty base checkout", async () => {
    const fixture = makeFixture();
    commit(fixture.worktreePath, "ticket.txt", "ticket\n", "ticket");
    expect((await rebaseCheck(fixture)).exitCode).toBe(0);
    await markReadyToLand(fixture);
    writeFileSync(join(fixture.repositoryPath, "local.txt"), "local\n");

    const result = await runCli("landing.complete", landingInput(fixture));

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatchObject({ errors: [{ code: "landing.base_dirty" }] });
    expect(integrationOf(fixture)?.phase).toBe("ready-to-land");
  });

  it("rejects landed evidence paths outside the run directory", async () => {
    const fixture = makeFixture();
    commit(fixture.worktreePath, "ticket.txt", "ticket\n", "ticket");
    expect((await rebaseCheck(fixture)).exitCode).toBe(0);
    await markReadyToLand(fixture);

    const result = await runCli(
      "landing.complete",
      landingInput(fixture, primary(fixture), {
        evidence_path: join(fixture.root, "outside-landed.json"),
      }),
    );

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

  it("refuses cleanup while the landed worktree is dirty", async () => {
    const fixture = makeFixture();
    commit(fixture.worktreePath, "ticket.txt", "ticket\n", "ticket");
    expect((await rebaseCheck(fixture)).exitCode).toBe(0);
    await markReadyToLand(fixture);
    expect(
      (
        await runCli("landing.complete", landingInput(fixture), {
          ...HERDR_ENV,
          HERDR_TEST_LIVE_PANES: JSON.stringify(["work:p7"]),
        })
      ).exitCode,
    ).toBe(0);
    writeFileSync(join(fixture.worktreePath, "dirty.txt"), "dirty\n");

    const result = await runCli("landing.complete", landingInput(fixture));

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

  it("uses an exact repository cleanup command instead of native fallback", async () => {
    const fixture = makeFixture();
    commit(fixture.worktreePath, "ticket.txt", "ticket\n", "ticket");
    writeFileSync(
      fixture.statePath,
      readFileSync(fixture.statePath, "utf8").replace(
        '"cleanup": "native-safe"',
        '"cleanup": "repository"',
      ),
    );
    expect((await rebaseCheck(fixture)).exitCode).toBe(0);
    await markReadyToLand(fixture);

    const result = await runCli(
      "landing.complete",
      landingInput(fixture, primary(fixture), {
        cleanup_argv: ["git", "worktree", "remove", fixture.worktreePath],
      }),
    );

    expect(result.exitCode).toBe(0);
    expect((result.stdout.result as { cleanup: Record<string, unknown> }).cleanup).toEqual({
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
});

describe("land-locked critical section", () => {
  it("lands, rejects a dirty base, and reports a required rebase with land-local exit codes", () => {
    const fixture = makeFixture();
    const ticketTip = commit(fixture.worktreePath, "ticket.txt", "ticket\n", "ticket");

    writeFileSync(join(fixture.repositoryPath, "local.txt"), "local\n");
    const dirty = runLocked(fixture.repositoryPath, "main", ticketTip);
    expect(dirty.exitCode).toBe(4);
    expect(dirty.stdout.split(/\s/u)[0]).toBe("REJECTED:");
    rmSync(join(fixture.repositoryPath, "local.txt"));

    const landed = runLocked(fixture.repositoryPath, "main", ticketTip);
    expect(landed.exitCode).toBe(0);
    expect(landed.stdout.split(/\s/u)[0]).toBe("LANDED:");
    expect(spawnGit(["rev-parse", "main"], { cwd: fixture.repositoryPath }).stdout.trim()).toBe(
      ticketTip,
    );

    commit(fixture.repositoryPath, "landed.txt", "landed\n", "landed");
    const stale = commit(fixture.worktreePath, "later.txt", "later\n", "later");
    const behind = runLocked(fixture.repositoryPath, "main", stale);
    expect(behind.exitCode).toBe(5);
    expect(behind.stdout.split(/\s/u)[0]).toBe("REBASE_REQUIRED:");
  });
});
