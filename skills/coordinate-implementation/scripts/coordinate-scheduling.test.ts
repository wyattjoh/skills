import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCliInProcess } from "./test-cli.ts";

const request = (operation: string, input: Record<string, unknown>) => ({
  schema_version: 1,
  operation,
  input,
});

const runCli = async (body: unknown) => {
  const child = await runCliInProcess(body);
  return {
    exitCode: child.exitCode,
    stdout: JSON.parse(child.stdout) as Record<string, unknown>,
    stderr: child.stderr,
  };
};

const ticket = (number: string, dependencies: string[], status = "queued") => ({
  number,
  dependencies,
  status,
});

const runtime = (runtimeId: string, ticketNumber: string, role = "implementor") => ({
  runtime_id: runtimeId,
  ticket: ticketNumber,
  role,
  state: "active",
});

const retryState = (
  attempt: number,
  completedRetries: number,
): string => `# sample implementation run

Schema version: 2

## Tickets

| NN | harness | model | effort | rounds | esc | status | sha |
| -- | ------- | ----- | ------ | ------ | --- | ------ | --- |
| 04 | pi | openai-codex/gpt-5.6-sol | high | 0 | - | working | - |

## Active tickets

### 04

Worktree: /worktrees/ticket-04
Branch: feature/ticket-04
Implementor: {"harness":"pi","model":"openai-codex/gpt-5.6-sol","effort":"high"}
Implement skill: /skills/implement/SKILL.md
Session: run-04
Tab: implement 04
Pane: w1:p4
Artifact: /run/briefs/launch-04-${attempt}.json
Attempt: ${attempt}
Retry: ${completedRetries} of 3
Phase: working
Last diagnostic: none

## Decisions
`;

describe("bounded dependency scheduling", () => {
  it("fills a wide ready frontier deterministically while reviewers use no capacity", async () => {
    const result = await runCli(
      request("scheduler.plan", {
        mode: "parallel",
        max_implementors: 2,
        tickets: [ticket("04", []), ticket("02", []), ticket("01", []), ticket("03", ["01"])],
        runtimes: [runtime("review-09", "09", "reviewer")],
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.result).toEqual({
      mode: "parallel",
      capacity: 2,
      active_implementors: 0,
      available_slots: 2,
      launch_tickets: ["01", "02"],
    });
  });

  it("refills newly available capacity after a landing without duplicate launches", async () => {
    const result = await runCli(
      request("scheduler.plan", {
        mode: "parallel",
        max_implementors: 2,
        tickets: [
          ticket("01", [], "landed"),
          ticket("02", [], "working"),
          ticket("03", ["01"]),
          ticket("04", []),
        ],
        runtimes: [runtime("worker-02", "02")],
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.result).toEqual({
      mode: "parallel",
      capacity: 2,
      active_implementors: 1,
      available_slots: 1,
      launch_tickets: ["03"],
    });
  });

  it("drains after a capacity reduction and refills after an increase", async () => {
    const tickets = [ticket("01", [], "working"), ticket("02", [], "working"), ticket("03", [])];
    const runtimes = [runtime("worker-01", "01"), runtime("worker-02", "02")];

    const reduced = await runCli(
      request("scheduler.plan", {
        mode: "parallel",
        max_implementors: 1,
        tickets,
        runtimes,
      }),
    );
    const increased = await runCli(
      request("scheduler.plan", {
        mode: "parallel",
        max_implementors: 3,
        tickets,
        runtimes,
      }),
    );

    expect(reduced.exitCode).toBe(0);
    expect(reduced.stdout.result).toEqual({
      mode: "parallel",
      capacity: 1,
      active_implementors: 2,
      available_slots: 0,
      launch_tickets: [],
    });
    expect(increased.exitCode).toBe(0);
    expect(increased.stdout.result).toEqual({
      mode: "parallel",
      capacity: 3,
      active_implementors: 2,
      available_slots: 1,
      launch_tickets: ["03"],
    });
  });

  it("keeps closed work terminal without treating it as a landed dependency", async () => {
    const result = await runCli(
      request("scheduler.plan", {
        mode: "parallel",
        max_implementors: 2,
        tickets: [ticket("01", [], "closed"), ticket("02", ["01"]), ticket("03", [])],
        runtimes: [],
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.result).toEqual({
      mode: "parallel",
      capacity: 2,
      active_implementors: 0,
      available_slots: 2,
      launch_tickets: ["03"],
    });
  });

  it("treats serial mode as one implementor and requires a positive parallel cap", async () => {
    const serial = await runCli(
      request("scheduler.plan", {
        mode: "serial",
        max_implementors: 1,
        tickets: [ticket("02", []), ticket("01", [])],
        runtimes: [],
      }),
    );
    const missingCap = await runCli(
      request("scheduler.plan", {
        mode: "parallel",
        max_implementors: null,
        tickets: [ticket("01", [])],
        runtimes: [],
      }),
    );

    expect(serial.exitCode).toBe(0);
    expect(serial.stdout.result).toEqual({
      mode: "serial",
      capacity: 1,
      active_implementors: 0,
      available_slots: 1,
      launch_tickets: ["01"],
    });
    expect(missingCap.exitCode).toBe(2);
    expect(missingCap.stdout.errors).toEqual([
      {
        code: "request.invalid",
        message:
          "`scheduler.plan` parallel mode requires a positive input.max_implementors; serial mode requires exactly 1.",
        remediation: "Send one JSON request matching the documented schema-version-1 contract.",
      },
    ]);
  });
});

describe("launch request validation", () => {
  it("requires exactly three implementor launch retries", async () => {
    for (const maxAttempts of [2, 4]) {
      const result = await runCli(
        request("implementor.launch.prepare", {
          state_path: "/run/RESUME.md",
          artifact_path: "/run/briefs/launch-04.json",
          ticket: "04",
          worktree_path: "/worktrees/ticket-04",
          branch: "feature/ticket-04",
          session: "run-04",
          tab: "implement 04",
          pane: "w1:p4",
          role: { harness: "claude", model: "sonnet", effort: "medium" },
          implement_skill_path: null,
          prompt: "implement ticket 04",
          attempt: 1,
          max_attempts: maxAttempts,
        }),
      );
      expect(result.exitCode).toBe(2);
      expect(result.stdout.errors).toEqual([
        {
          code: "request.invalid",
          message: "`implementor.launch.prepare` requires input.max_attempts to equal 3.",
          remediation: "Send one JSON request matching the documented schema-version-1 contract.",
        },
      ]);
    }
  });
});

describe("shared infrastructure retries", () => {
  it("returns increasing bounded delays with the exact persisted binding", async () => {
    const root = mkdtempSync(join(tmpdir(), "coordinate-retry-"));
    const statePath = join(root, "RESUME.md");
    const delays: number[] = [];

    for (const attempt of [1, 2, 3]) {
      writeFileSync(statePath, retryState(attempt, attempt - 1));
      const result = await runCli(
        request("infrastructure.retry.record", {
          state_path: statePath,
          ticket: "04",
          attempt,
          failure: "launch",
          diagnostic: `temporary failure ${attempt}`,
        }),
      );
      expect(result.exitCode).toBe(0);
      const outcome = result.stdout.result as {
        action: string;
        delay_ms: number;
        binding: unknown;
      };
      expect(outcome.action).toBe("retry");
      delays.push(outcome.delay_ms);
      expect(outcome.binding).toEqual({
        role: { harness: "pi", model: "openai-codex/gpt-5.6-sol", effort: "high" },
        worktree_path: "/worktrees/ticket-04",
        branch: "feature/ticket-04",
        implement_skill_path: "/skills/implement/SKILL.md",
        session: "run-04",
        tab: "implement 04",
      });
      expect(readFileSync(statePath, "utf8").includes("Phase: retry waiting")).toBe(true);
    }

    expect(delays).toEqual([1000, 2000, 4000]);
  });

  it("blocks only the affected ticket after three retries are exhausted", async () => {
    const root = mkdtempSync(join(tmpdir(), "coordinate-retry-"));
    const statePath = join(root, "RESUME.md");
    writeFileSync(
      statePath,
      retryState(4, 3).replace(
        "| 04 | pi | openai-codex/gpt-5.6-sol | high | 0 | - | working | - |",
        "| 04 | pi | openai-codex/gpt-5.6-sol | high | 0 | - | working | - |\n| 05 | - | - | - | 0 | - | queued | - |",
      ),
    );

    const result = await runCli(
      request("infrastructure.retry.record", {
        state_path: statePath,
        ticket: "04",
        attempt: 4,
        failure: "herdr",
        diagnostic: "socket disconnected",
      }),
    );

    expect(result.exitCode).toBe(0);
    expect((result.stdout.result as { action: string }).action).toBe("block");
    const persisted = readFileSync(statePath, "utf8");
    expect(
      persisted.includes("| 04 | pi | openai-codex/gpt-5.6-sol | high | 0 | - | blocked | - |"),
    ).toBe(true);
    expect(persisted.includes("| 05 | - | - | - | 0 | - | queued | - |")).toBe(true);
    expect(persisted.includes("Phase: retry exhausted")).toBe(true);
  });
});
