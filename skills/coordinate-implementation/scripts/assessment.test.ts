import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { DecisionModel } from "effect/unstable/ai";
import {
  decideStallDisposition,
  evaluateStall,
  STALL_REPROMPTS,
  STALL_REPROMPT_THRESHOLD,
  type StallProbabilities,
  type StallState,
} from "./lib/assessment.ts";

const state = (status: StallState["worker"]["status"] = "working"): StallState => ({
  schema_version: 1,
  assessment_id: "stall-mechanical-input-001",
  ticket: {
    number: "1",
    title: "Create the accepted greeting file",
    acceptance_criteria: ["Create greeting.txt containing exactly hello."],
  },
  worker: {
    session: "typesafe-stall-worker",
    harness: "pi",
    model: "openai-codex/gpt-5.6-luna",
    effort: "max",
    status,
    phase: "implementation",
  },
  previous_observation: null,
  current_observation: {
    observed_at: "2026-09-21T04:30:00Z",
    pane_tail: [
      "The accepted ticket says to create greeting.txt containing exactly hello.",
      "Should I proceed with that filename?",
    ],
    head: "0123456789abcdef0123456789abcdef01234567",
    git_status: "",
    recent_commits: [],
  },
});

const answers = (overrides: Partial<StallProbabilities> = {}): StallProbabilities => ({
  meaningful_progress: 0.1,
  mechanical_input_wait: 0.1,
  human_decision_required: 0.1,
  transient_service_failure: 0.1,
  crash_or_loop: 0.1,
  ...overrides,
});

const modelWith = (probabilities: StallProbabilities) =>
  Effect.runSync(
    DecisionModel.make({
      decide: () =>
        Effect.succeed({
          answers: {
            meaningful_progress: {
              _tag: "Probability" as const,
              probability: probabilities.meaningful_progress,
            },
            mechanical_input_wait: {
              _tag: "Probability" as const,
              probability: probabilities.mechanical_input_wait,
            },
            human_decision_required: {
              _tag: "Probability" as const,
              probability: probabilities.human_decision_required,
            },
            transient_service_failure: {
              _tag: "Probability" as const,
              probability: probabilities.transient_service_failure,
            },
            crash_or_loop: {
              _tag: "Probability" as const,
              probability: probabilities.crash_or_loop,
            },
          },
          usage: { inputTokens: 42, outputTokens: 0 },
        }),
    }),
  );

describe("stall assessment policy", () => {
  it("re-prompts a mechanically determined input wait", () => {
    expect(
      decideStallDisposition(
        "idle",
        answers({ mechanical_input_wait: 0.91, human_decision_required: 0.08 }),
      ),
    ).toEqual({
      disposition: "reprompt",
      reason: "mechanical_input",
      prompt: STALL_REPROMPTS.mechanical_input,
    });
  });

  it("uses the calibrated re-prompt boundary without weakening contradictory safety gates", () => {
    expect(
      decideStallDisposition("idle", answers({ mechanical_input_wait: STALL_REPROMPT_THRESHOLD })),
    ).toEqual({
      disposition: "reprompt",
      reason: "mechanical_input",
      prompt: STALL_REPROMPTS.mechanical_input,
    });
    expect(
      decideStallDisposition(
        "idle",
        answers({ mechanical_input_wait: STALL_REPROMPT_THRESHOLD - 0.01 }),
      ),
    ).toEqual({ disposition: "pause", reason: "uncertain", prompt: null });
    expect(
      decideStallDisposition(
        "idle",
        answers({ mechanical_input_wait: 0.9, human_decision_required: 0.51 }),
      ),
    ).toEqual({ disposition: "pause", reason: "human_decision", prompt: null });
  });

  it("waits only when a working worker is progressing without a contradictory signal", () => {
    const probabilities = answers({ meaningful_progress: 0.9 });
    expect(decideStallDisposition("working", probabilities)).toEqual({
      disposition: "wait",
      reason: "progressing",
      prompt: null,
    });
    expect(decideStallDisposition("idle", probabilities)).toEqual({
      disposition: "pause",
      reason: "idle_cannot_wait",
      prompt: null,
    });
  });

  it("always pauses a blocked Herdr UI", () => {
    expect(decideStallDisposition("blocked", answers({ mechanical_input_wait: 0.99 }))).toEqual({
      disposition: "pause",
      reason: "blocked_ui",
      prompt: null,
    });
  });

  it("pauses uncertain assessments", () => {
    expect(decideStallDisposition("working", answers())).toEqual({
      disposition: "pause",
      reason: "uncertain",
      prompt: null,
    });
  });
});

describe("provider-neutral stall evaluation", () => {
  it("maps validated DecisionModel answers and usage", async () => {
    const probabilities = answers({ mechanical_input_wait: 0.92 });
    const result = await Effect.runPromise(
      evaluateStall(state("idle")).pipe(
        Effect.provideService(DecisionModel.DecisionModel, modelWith(probabilities)),
      ),
    );

    expect(result).toEqual({
      answers: probabilities,
      usage: { input_tokens: 42, output_tokens: 0 },
    });
  });
});
