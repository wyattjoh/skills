import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STALL_REPROMPTS, type StallAssessment } from "./lib/assessment.ts";
import { spawnGit } from "./lib/git.ts";
import type { HerdrActuator } from "./lib/herdr-actuator.ts";
import { runStallCheck, type StallTarget } from "./lib/stall-loop.ts";

const assessment = (answers: Partial<StallAssessment["answers"]>): StallAssessment => ({
  answers: {
    meaningful_progress: 0.05,
    mechanical_input_wait: 0.01,
    human_decision_required: 0.01,
    transient_service_failure: 0.01,
    crash_or_loop: 0.01,
    ...answers,
  },
  usage: { input_tokens: 10, output_tokens: 2 },
});

const fixture = (): { runPath: string; worktree: string } => {
  const root = mkdtempSync(join(tmpdir(), "coordinate-stall-loop-"));
  const worktree = join(root, "repo");
  mkdirSync(worktree);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  expect(spawnGit(["-C", worktree, "init", "-q", "-b", "main"], { env }).exitCode).toBe(0);
  writeFileSync(join(worktree, "a.txt"), "a\n");
  expect(spawnGit(["-C", worktree, "add", "a.txt"], { env }).exitCode).toBe(0);
  expect(spawnGit(["-C", worktree, "commit", "-q", "-m", "base"], { env }).exitCode).toBe(0);
  const runPath = join(root, "run");
  mkdirSync(runPath);
  return { runPath, worktree };
};

const target = (runPath: string, worktree: string): StallTarget => ({
  runPath,
  ticket: { number: "02", title: "Outbox queue store", acceptanceCriteria: ["Queue persists"] },
  worker: {
    session: "ex-02",
    paneId: "w1:p2",
    harness: "pi",
    model: "openai-codex/gpt-6-luna",
    effort: "max",
    status: "idle",
    phase: "working",
  },
  worktree,
  base: "main",
  sequence: 1,
  previous: null,
});

const actuator = (prompts: string[]): HerdrActuator =>
  ({
    readPane: () => Effect.succeed("Waiting for confirmation (y/n)?"),
    deliverPrompt: (_session: string, text: string) =>
      Effect.sync(() => {
        prompts.push(text);
      }),
  }) as unknown as HerdrActuator;

const deps = (result: StallAssessment) => ({
  evaluate: async () => result,
  now: () => new Date("2026-09-25T12:00:00.000Z"),
  monotonicNow: () => 1,
});

describe("engine stall check", () => {
  it("delivers the code-owned reprompt for a mechanical input wait", async () => {
    const { runPath, worktree } = fixture();
    const prompts: string[] = [];

    const check = await Effect.runPromise(
      runStallCheck(
        target(runPath, worktree),
        actuator(prompts),
        deps(assessment({ mechanical_input_wait: 0.9 })),
      ),
    );

    expect(check.action).toBe("reprompt");
    expect(prompts).toEqual([STALL_REPROMPTS.mechanical_input]);
    expect(check.observation.pane_tail).toEqual(["Waiting for confirmation (y/n)?"]);
  });

  it("returns pause without prompting when a human decision is needed", async () => {
    const { runPath, worktree } = fixture();
    const prompts: string[] = [];

    const check = await Effect.runPromise(
      runStallCheck(
        target(runPath, worktree),
        actuator(prompts),
        deps(assessment({ human_decision_required: 0.9 })),
      ),
    );

    expect(check.action).toBe("pause");
    expect(prompts).toEqual([]);
  });
});
