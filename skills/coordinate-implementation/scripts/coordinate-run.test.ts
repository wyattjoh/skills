import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { acceptSnapshot } from "./lib/snapshot.ts";
import { finalizeRun } from "./lib/run.ts";

const CLI = join(import.meta.dir, "coordinate.ts");
const decoder = new TextDecoder();

type Harness = "claude" | "pi";
type Writeback = "none" | "final" | "live";

type RunFixture = {
  runPath: string;
  statePath: string;
  summaryPath: string;
};

const runCli = (operation: string, input: Record<string, unknown>) => {
  const child = Bun.spawnSync([process.execPath, CLI], {
    stdin: Buffer.from(JSON.stringify({ schema_version: 1, operation, input })),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: child.exitCode,
    stdout: JSON.parse(decoder.decode(child.stdout)) as Record<string, unknown>,
    stderr: decoder.decode(child.stderr),
  };
};

const role = (harness: Harness, purpose: "coordinator" | "implementor" | "reviewer") => {
  if (harness === "pi") {
    return {
      harness,
      model: `local/${purpose}`,
      effort: purpose === "coordinator" ? "low" : "high",
    };
  }
  return {
    harness,
    model: purpose === "coordinator" ? "fable" : purpose === "implementor" ? "opus" : "sonnet",
    effort: purpose === "coordinator" ? "low" : purpose === "implementor" ? "high" : "medium",
  };
};

const roleBlock = (name: string, value: ReturnType<typeof role>): string =>
  `${name}:\n  harness: ${value.harness}\n  model: ${value.model}\n  effort: ${value.effort}`;

const makeRun = (
  harnesses: { coordinator: Harness; implementor: Harness; reviewer: Harness },
  status: "landed" | "blocked",
  source: "local" | "remote" = "local",
  writeback: Writeback = "none",
  withDependent = false,
): RunFixture => {
  const root = mkdtempSync(join(tmpdir(), "coordinate-run-"));
  const runPath = join(root, "portable-run");
  const issuesPath = join(runPath, "issues");
  const reviewsPath = join(runPath, "reviews");
  mkdirSync(issuesPath, { recursive: true });
  mkdirSync(reviewsPath, { recursive: true });

  writeFileSync(join(runPath, "spec.md"), "# Portable run\n\nComplete the integration.\n");
  writeFileSync(
    join(issuesPath, "01-integration.md"),
    "# 01: Integration\n\n**Blocked by:** none\n\n**Status:** ready-for-agent\n\n- [ ] Integrated.\n",
  );
  if (withDependent) {
    writeFileSync(
      join(issuesPath, "02-dependent.md"),
      "# 02: Dependent\n\n**Blocked by:** 01: Integration\n\n**Status:** ready-for-agent\n\n- [ ] Dependent work is complete.\n",
    );
  }
  const remote = source === "remote";
  writeFileSync(
    join(runPath, "snapshot.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        source: {
          kind: source,
          tracker: remote ? "example-tracker" : "local-files",
          reference: remote ? "tracker:project:portable" : "file:portable-run",
          tracker_workflow: remote ? "matt-tracker-publish" : null,
        },
        specification: {
          path: "spec.md",
          source_reference: remote ? "tracker:spec:portable" : "file:spec.md",
          agreed: true,
        },
        tickets: [
          {
            number: "01",
            path: "issues/01-integration.md",
            source_reference: remote ? "tracker:ticket:1" : "file:issues/01-integration.md",
            blocked_by: [],
          },
          ...(withDependent
            ? [
                {
                  number: "02",
                  path: "issues/02-dependent.md",
                  source_reference: remote ? "tracker:ticket:2" : "file:issues/02-dependent.md",
                  blocked_by: ["01"],
                },
              ]
            : []),
        ],
      },
      null,
      2,
    )}\n`,
  );

  const coordinator = role(harnesses.coordinator, "coordinator");
  const implementor = role(harnesses.implementor, "implementor");
  const reviewer = role(harnesses.reviewer, "reviewer");
  const statePath = join(runPath, "RESUME.md");
  const active =
    status === "blocked"
      ? `\n## Active tickets\n\n### 01\n\nWorktree: ${join(root, "worktrees", "ticket-01")}\nBranch: portable-01-integration\nImplementor: ${JSON.stringify(implementor)}\nImplement skill: /skills/implement/SKILL.md\nSession: portable-01\nTab: implement portable 01\nPane: w1:p1\nArtifact: ${join(runPath, "briefs", "launch-01.json")}\nAttempt: 4\nRetry: 3 of 3\nPhase: retry exhausted\nLast diagnostic: worker exited\n`
      : "\n## Active tickets\n";
  writeFileSync(
    statePath,
    `# portable implementation run\n\nSchema version: 1\n\nPrefix: portable\nBase: main\nBase sha: 0123456789abcdef0123456789abcdef01234567\nMode: parallel\nParallel cap: 2\nBranch template: portable-NN-<slug>\n\n${roleBlock("Coordinator", coordinator)}\n  handoff: yes\n  threshold: 80 percent\n  unattended: block\n\n${roleBlock("Implementor", implementor)}\n\n${roleBlock("Reviewer", reviewer)}\n\n## Tickets\n\n| NN | harness | model | effort | rounds | esc | status | sha |\n| -- | ------- | ----- | ------ | ------ | --- | ------ | --- |\n| 01 | ${implementor.harness} | ${implementor.model} | ${implementor.effort} | 3 | ${status === "blocked" ? "yes" : "-"} | ${status} | ${status === "landed" ? "89abcdef0123456789abcdef0123456789abcdef" : "-"} |\n${withDependent ? "| 02 | - | - | - | 0 | - | queued | - |\n" : ""}${active}\n## Review evidence\n\n- Ticket 01 round 3 standards attempt 1: accepted; reviewer ${JSON.stringify(reviewer)}; report ${join(reviewsPath, "01-standards.md")}\n- Ticket 01 round 3 spec attempt 1: accepted; reviewer ${JSON.stringify(reviewer)}; report ${join(reviewsPath, "01-spec.md")}\n\n## Landed evidence\n\n${status === "landed" ? `- Ticket 01: ${join(reviewsPath, "01-landed.json")}; tip 89abcdef0123456789abcdef0123456789abcdef; branch portable-01-integration; cleanup native-safe` : ""}\n\n## Decisions\n\n- 2026-09-19 setup recorded\n\n## Retained landed branches\n\n${status === "landed" ? "- portable-01-integration (89abcdef0123456789abcdef0123456789abcdef) (retained by repository cleanup policy)" : ""}\n`,
  );

  const accepted = runCli("snapshot.accept", {
    run_path: runPath,
    state_path: statePath,
    writeback,
    project_remote_writes: "allowed",
    accepted_at: "2026-09-19T10:00:00Z",
  });
  expect(accepted.exitCode).toBe(0);

  return { runPath, statePath, summaryPath: join(runPath, "SUMMARY.md") };
};

const finalize = (
  fixture: RunFixture,
  closures: Array<{ ticket: string; reason: string }> = [],
  userAuthorized = false,
  projectRemoteWrites: "allowed" | "forbidden" = "allowed",
  summaryPath = fixture.summaryPath,
) =>
  runCli("run.finalize", {
    run_path: fixture.runPath,
    state_path: fixture.statePath,
    summary_path: summaryPath,
    closures,
    user_authorized: userAuthorized,
    project_remote_writes: projectRemoteWrites,
    completed_at: "2026-09-19T12:00:00Z",
  });

describe("terminal run integration", () => {
  it("completes a Claude-only run with a deterministic local summary", () => {
    const fixture = makeRun(
      { coordinator: "claude", implementor: "claude", reviewer: "claude" },
      "landed",
    );

    const result = finalize(fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.result).toEqual({
      status: "completed",
      landed_tickets: ["01"],
      blocked_tickets: [],
      closed_tickets: [],
      runnable_tickets: [],
      summary_path: fixture.summaryPath,
      tracker_action: { mode: "none", status: "not-applicable", workflow: null },
    });
    const summary = readFileSync(fixture.summaryPath, "utf8");
    expect(summary.includes("Status: completed")).toBe(true);
    expect(summary.includes("Coordinator: claude / fable / low")).toBe(true);
    expect(summary.includes("Review evidence")).toBe(true);
    expect(summary.includes("portable-01-integration")).toBe(true);
  });

  it("reports a Pi-only blocked empty frontier as waiting rather than success", () => {
    const fixture = makeRun({ coordinator: "pi", implementor: "pi", reviewer: "pi" }, "blocked");

    const result = finalize(fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.result).toEqual({
      status: "waiting",
      landed_tickets: [],
      blocked_tickets: ["01"],
      closed_tickets: [],
      runnable_tickets: [],
      summary_path: null,
      tracker_action: { mode: "none", status: "not-applicable", workflow: null },
    });
    expect(existsSync(fixture.summaryPath)).toBe(false);
    expect(readFileSync(fixture.statePath, "utf8").includes('"status": "waiting"')).toBe(true);
  });

  it("closes an explicitly authorized dependency-blocked remainder", () => {
    const fixture = makeRun(
      { coordinator: "pi", implementor: "pi", reviewer: "pi" },
      "blocked",
      "local",
      "none",
      true,
    );

    const result = finalize(
      fixture,
      [
        { ticket: "01", reason: "User closed the blocked root" },
        { ticket: "02", reason: "User closed the dependent remainder" },
      ],
      true,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.result).toEqual({
      status: "completed",
      landed_tickets: [],
      blocked_tickets: [],
      closed_tickets: ["01", "02"],
      runnable_tickets: [],
      summary_path: fixture.summaryPath,
      tracker_action: { mode: "none", status: "not-applicable", workflow: null },
    });
    expect(
      readFileSync(fixture.statePath, "utf8").includes("| 02 | - | - | - | 0 | - | closed | - |"),
    ).toBe(true);
  });

  it("closes blocked work only with explicit authority and reports mixed-role tracker provenance", () => {
    const fixture = makeRun(
      { coordinator: "pi", implementor: "claude", reviewer: "pi" },
      "blocked",
      "remote",
      "final",
    );

    const result = finalize(
      fixture,
      [{ ticket: "01", reason: "User accepted deferred scope" }],
      true,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.result).toEqual({
      status: "completed",
      landed_tickets: [],
      blocked_tickets: [],
      closed_tickets: ["01"],
      runnable_tickets: [],
      summary_path: fixture.summaryPath,
      tracker_action: {
        mode: "final",
        status: "pending",
        workflow: "matt-tracker-publish",
      },
    });
    const state = readFileSync(fixture.statePath, "utf8");
    const summary = readFileSync(fixture.summaryPath, "utf8");
    expect(state.includes("| 01 | claude | opus | high | 3 | yes | closed | - |")).toBe(true);
    expect(state.includes("## Closed ticket runtimes")).toBe(true);
    expect(summary.includes("Coordinator: pi / local/coordinator / low")).toBe(true);
    expect(summary.includes("Implementor default: claude / opus / high")).toBe(true);
    expect(summary.includes("Reviewer: pi / local/reviewer / high")).toBe(true);
    expect(summary.includes("Pending tracker action: final via matt-tracker-publish")).toBe(true);
  });

  it("preserves local completion when live tracker writeback is forbidden by current policy", () => {
    const fixture = makeRun(
      { coordinator: "claude", implementor: "pi", reviewer: "claude" },
      "landed",
      "remote",
      "live",
    );

    const result = finalize(fixture, [], false, "forbidden");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.result).toEqual({
      status: "completed",
      landed_tickets: ["01"],
      blocked_tickets: [],
      closed_tickets: [],
      runnable_tickets: [],
      summary_path: fixture.summaryPath,
      tracker_action: {
        mode: "live",
        status: "forbidden",
        workflow: "matt-tracker-publish",
      },
    });
    expect(
      readFileSync(fixture.summaryPath, "utf8").includes(
        "Pending tracker action: live blocked by current project authority",
      ),
    ).toBe(true);
  });

  it("requires the canonical SUMMARY.md path", () => {
    const fixture = makeRun(
      { coordinator: "claude", implementor: "claude", reviewer: "claude" },
      "landed",
    );
    const before = readFileSync(fixture.statePath, "utf8");

    const result = finalize(fixture, [], false, "allowed", join(fixture.runPath, "other.md"));

    expect(result.exitCode).toBe(1);
    expect(result.stdout.errors).toEqual([
      {
        code: "run.summary_path_invalid",
        message: "Run finalization requires the canonical <run>/SUMMARY.md output.",
        remediation: "Pass the SUMMARY.md path inside the normalized run directory.",
      },
    ]);
    expect(readFileSync(fixture.statePath, "utf8")).toBe(before);
    expect(existsSync(join(fixture.runPath, "other.md"))).toBe(false);
  });

  it("does not publish completed state before the immutable summary is durable", () => {
    const fixture = makeRun(
      { coordinator: "claude", implementor: "claude", reviewer: "claude" },
      "landed",
    );
    writeFileSync(fixture.summaryPath, "conflicting summary\n");
    const before = readFileSync(fixture.statePath, "utf8");

    const result = finalize(fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.errors).toEqual([
      {
        code: "run.summary_conflict",
        message: "The final summary path already contains different content.",
        remediation:
          "Preserve the existing summary and resolve the run-state conflict before retrying.",
      },
    ]);
    expect(readFileSync(fixture.statePath, "utf8")).toBe(before);
    expect(readFileSync(fixture.summaryPath, "utf8")).toBe("conflicting summary\n");
  });

  it("rejects an unauthorized blocked-ticket closure without changing state", () => {
    const fixture = makeRun(
      { coordinator: "pi", implementor: "claude", reviewer: "pi" },
      "blocked",
    );
    const before = readFileSync(fixture.statePath, "utf8");

    const result = finalize(fixture, [{ ticket: "01", reason: "Close it" }], false);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.errors).toEqual([
      {
        code: "run.closure_authority_required",
        message: "Closing blocked tickets requires explicit user authority.",
        remediation: "Confirm the exact blocked tickets and reasons with the user, then retry.",
      },
    ]);
    expect(readFileSync(fixture.statePath, "utf8")).toBe(before);
    expect(existsSync(fixture.summaryPath)).toBe(false);
  });

  it("rejects duplicate closure of an already-closed ticket without appending evidence", () => {
    const fixture = makeRun({ coordinator: "pi", implementor: "pi", reviewer: "pi" }, "blocked");
    const closure = [{ ticket: "01", reason: "User accepted deferred scope" }];
    expect(finalize(fixture, closure, true).exitCode).toBe(0);
    const before = readFileSync(fixture.statePath, "utf8");

    const result = finalize(fixture, closure, true);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.errors).toEqual([
      {
        code: "run.closure_not_blocked",
        message: "Ticket `01` is not blocked and cannot be closed at finalization.",
        remediation:
          "Close only blocked or dependency-blocked queued tickets, or continue runnable work.",
      },
    ]);
    expect(readFileSync(fixture.statePath, "utf8")).toBe(before);
    expect(before.match(/ticket 01 explicitly closed by user/gu)?.length).toBe(1);
  });

  it("rejects finalization when snapshot acceptance changes before the state lock", async () => {
    const fixture = makeRun(
      { coordinator: "claude", implementor: "claude", reviewer: "claude" },
      "landed",
    );
    const ticketPath = join(fixture.runPath, "issues", "01-integration.md");

    const error = await Effect.runPromise(
      Effect.flip(
        finalizeRun(
          {
            runPath: fixture.runPath,
            statePath: fixture.statePath,
            summaryPath: fixture.summaryPath,
            closures: [],
            userAuthorized: false,
            projectRemoteWrites: "allowed",
            completedAt: "2026-09-19T12:00:00Z",
          },
          {
            afterSnapshotCheck: async () => {
              writeFileSync(
                ticketPath,
                "# 01: Integration\n\n**Blocked by:** none\n\n**Status:** ready-for-agent\n\n- [x] Integrated after snapshot change.\n",
              );
              await Effect.runPromise(
                acceptSnapshot({
                  runPath: fixture.runPath,
                  statePath: fixture.statePath,
                  writeback: "none",
                  projectRemoteWrites: "allowed",
                  acceptedAt: "2026-09-19T11:00:00Z",
                }),
              );
            },
          },
        ),
      ),
    );

    expect(error.issue.code).toBe("run.snapshot_changed");
    expect(readFileSync(fixture.statePath, "utf8").includes("## Run outcome")).toBe(false);
    expect(existsSync(fixture.summaryPath)).toBe(false);
  });
});

describe("portable downstream documentation", () => {
  it("documents the smoke matrix and keeps downstream coordination event-driven and run-owned", () => {
    const skill = readFileSync(join(import.meta.dir, "..", "SKILL.md"), "utf8");
    const smoke = readFileSync(
      join(import.meta.dir, "..", "references", "manual-smoke.md"),
      "utf8",
    );
    const packageMetadata = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
    ) as Record<string, unknown>;
    const downstream = readFileSync(
      join(import.meta.dir, "..", "..", "core-coordinator", "SKILL.md"),
      "utf8",
    );
    const loop = readFileSync(
      join(import.meta.dir, "..", "..", "core-coordinator", "references", "loop.md"),
      "utf8",
    );

    for (const scenario of [
      "Claude-only",
      "Pi-only",
      "Mixed roles",
      "Parallel frontier",
      "Conflict adaptation",
      "Reviewer failure",
      "Coordinator handoff",
    ]) {
      expect(smoke.includes(scenario)).toBe(true);
    }
    expect(skill.includes("`run.finalize`")).toBe(true);
    expect(packageMetadata.os).toEqual(["darwin", "linux"]);
    expect(packageMetadata.engines).toEqual({ bun: ">=1.1.0" });
    expect(packageMetadata.dependencies).toEqual({ effect: "3.22.1" });
    expect(downstream.includes("Never edit a run's `RESUME.md` or its registry row.")).toBe(true);
    expect(loop.includes("event-driven")).toBe(true);
    for (const legacy of ["CronCreate", "CronDelete", "python3", "ListAgents", "SendMessage"]) {
      expect(`${downstream}\n${loop}`.includes(legacy)).toBe(false);
    }
  });
});
