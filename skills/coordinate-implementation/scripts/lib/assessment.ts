import { Data, Effect, Layer, Schema } from "effect";
import { Decision, DecisionModel } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe";

export const ASSESSMENT_SCHEMA_VERSION = 1 as const;
export const STALL_POLICY_VERSION = "stall-v2" as const;
export const TYPESAFE_MODEL = "jev-1.13.0" as const;
export const STALL_REPROMPT_THRESHOLD = 0.75 as const;
export const STALL_WAIT_THRESHOLD = 0.8 as const;
export const STALL_PAUSE_THRESHOLD = 0.5 as const;
export const STALL_CONTRADICTION_MAX = 0.2 as const;
export const TYPESAFE_SECRET = {
  service: "com.wyattjoh.coordinate-implementation",
  name: "typesafe-api-key",
} as const;

const Observation = Schema.Struct({
  observed_at: Schema.String,
  pane_tail: Schema.Array(Schema.String),
  head: Schema.String,
  git_status: Schema.String,
  recent_commits: Schema.Array(Schema.String),
});

export const StallState = Schema.Struct({
  schema_version: Schema.Literal(ASSESSMENT_SCHEMA_VERSION),
  assessment_id: Schema.String,
  ticket: Schema.Struct({
    number: Schema.String,
    title: Schema.String,
    acceptance_criteria: Schema.Array(Schema.String),
  }),
  worker: Schema.Struct({
    session: Schema.String,
    harness: Schema.Literals(["claude", "pi"]),
    model: Schema.String,
    effort: Schema.String,
    status: Schema.Literals(["working", "idle", "blocked"]),
    phase: Schema.String,
  }),
  previous_observation: Schema.NullOr(Observation),
  current_observation: Observation,
});

export type StallState = typeof StallState.Type;

export const StallDecision = Decision.make({
  input: StallState,
  decisions: {
    meaningful_progress: Decision.probability({
      instructions:
        "The worker is making meaningful forward progress on the accepted ticket rather than waiting, repeating itself, or remaining unchanged.",
      criteria: {
        false:
          "The observations do not demonstrate meaningful forward progress toward the ticket acceptance criteria.",
        true: "The observations demonstrate concrete forward progress toward the ticket acceptance criteria.",
      },
    }),
    mechanical_input_wait: Decision.probability({
      instructions:
        "The worker is waiting for input whose answer is already mechanically determined by accepted instructions, ticket criteria, or routine tool continuation.",
      criteria: {
        false:
          "The worker is not waiting, or the requested input requires a new human judgment not fixed by accepted instructions.",
        true: "The worker is waiting for input that accepted instructions or routine continuation already determine.",
      },
    }),
    human_decision_required: Decision.probability({
      instructions:
        "Continuing requires a new human product, scope, risk, or authority decision that the accepted ticket does not already determine.",
      criteria: {
        false:
          "The accepted ticket and instructions determine how to continue without a new human decision.",
        true: "A human must choose among materially different valid outcomes or grant authority not already provided.",
      },
    }),
    transient_service_failure: Decision.probability({
      instructions:
        "The worker stopped because of a plausibly transient provider, network, rate-limit, or external service failure that can be retried in the same session.",
      criteria: {
        false: "No transient external service failure explains the worker state.",
        true: "A transient external service failure explains the worker state.",
      },
    }),
    crash_or_loop: Decision.probability({
      instructions:
        "The evidence indicates a genuine crash, unrecoverable tool failure, or repeated loop rather than a one-time wait or transient failure.",
      criteria: {
        false: "The worker has not genuinely crashed and is not repeating a failed loop.",
        true: "The worker genuinely crashed, cannot continue, or is repeating a failed loop.",
      },
    }),
  },
});

export type StallProbabilities = {
  meaningful_progress: number;
  mechanical_input_wait: number;
  human_decision_required: number;
  transient_service_failure: number;
  crash_or_loop: number;
};

export type StallAssessment = {
  answers: StallProbabilities;
  usage: {
    input_tokens: number | null;
    output_tokens: number | null;
  };
};

export type StallDisposition =
  | {
      disposition: "wait";
      reason: "progressing";
      prompt: null;
    }
  | {
      disposition: "reprompt";
      reason: "mechanical_input" | "transient_failure";
      prompt: string;
    }
  | {
      disposition: "pause";
      reason: "blocked_ui" | "idle_cannot_wait" | "human_decision" | "crash_or_loop" | "uncertain";
      prompt: null;
    };

export const STALL_REPROMPTS = {
  mechanical_input:
    "Continue the current ticket using the accepted instructions and acceptance criteria. Do not wait for confirmation when those sources already determine the answer. If continuing requires new user authority or a materially different product decision, report the exact blocker instead.",
  transient_failure:
    "Retry the interrupted operation once in this same session while preserving current work. If the same external failure persists, report the exact error and stop rather than looping.",
} as const;

export const decideStallDisposition = (
  status: StallState["worker"]["status"],
  answers: StallProbabilities,
): StallDisposition => {
  if (status === "blocked") {
    return { disposition: "pause", reason: "blocked_ui", prompt: null };
  }
  if (answers.human_decision_required >= STALL_PAUSE_THRESHOLD) {
    return { disposition: "pause", reason: "human_decision", prompt: null };
  }
  if (answers.crash_or_loop >= STALL_PAUSE_THRESHOLD) {
    return { disposition: "pause", reason: "crash_or_loop", prompt: null };
  }

  const safeToReprompt =
    answers.human_decision_required <= STALL_CONTRADICTION_MAX &&
    answers.crash_or_loop <= STALL_CONTRADICTION_MAX;
  if (safeToReprompt && answers.mechanical_input_wait >= STALL_REPROMPT_THRESHOLD) {
    return {
      disposition: "reprompt",
      reason: "mechanical_input",
      prompt: STALL_REPROMPTS.mechanical_input,
    };
  }
  if (safeToReprompt && answers.transient_service_failure >= STALL_REPROMPT_THRESHOLD) {
    return {
      disposition: "reprompt",
      reason: "transient_failure",
      prompt: STALL_REPROMPTS.transient_failure,
    };
  }

  const safeToWait =
    answers.mechanical_input_wait <= STALL_CONTRADICTION_MAX &&
    answers.human_decision_required <= STALL_CONTRADICTION_MAX &&
    answers.transient_service_failure <= STALL_CONTRADICTION_MAX &&
    answers.crash_or_loop <= STALL_CONTRADICTION_MAX;
  if (answers.meaningful_progress >= STALL_WAIT_THRESHOLD && safeToWait) {
    return status === "working"
      ? { disposition: "wait", reason: "progressing", prompt: null }
      : { disposition: "pause", reason: "idle_cannot_wait", prompt: null };
  }

  return { disposition: "pause", reason: "uncertain", prompt: null };
};

export const evaluateStall = (
  state: StallState,
): Effect.Effect<StallAssessment, unknown, DecisionModel.DecisionModel> =>
  DecisionModel.decide(StallDecision, { input: state }).pipe(
    Effect.map(({ answers, usage }) => ({
      answers: {
        meaningful_progress: answers.meaningful_progress.probability,
        mechanical_input_wait: answers.mechanical_input_wait.probability,
        human_decision_required: answers.human_decision_required.probability,
        transient_service_failure: answers.transient_service_failure.probability,
        crash_or_loop: answers.crash_or_loop.probability,
      },
      usage: {
        input_tokens: usage.inputTokens ?? null,
        output_tokens: usage.outputTokens ?? null,
      },
    })),
  );

export class AssessmentCredentialError extends Data.TaggedError("AssessmentCredentialError")<{
  message: string;
}> {}

const liveDecisionLayer = (): Layer.Layer<DecisionModel.DecisionModel, unknown> => {
  const client = TypeSafeClient.layerConfig().pipe(Layer.provide(FetchHttpClient.layer));
  return TypeSafeDecisionModel.layer({ model: TYPESAFE_MODEL }).pipe(Layer.provide(client));
};

const withLiveDecisionModel = <A>(
  effect: Effect.Effect<A, unknown, DecisionModel.DecisionModel>,
): Effect.Effect<A, unknown> =>
  Effect.tryPromise({
    try: () => Bun.secrets.get(TYPESAFE_SECRET),
    catch: (error) =>
      new AssessmentCredentialError({
        message: `Could not read the TypeSafe credential from Bun.secrets: ${(error as Error).message}`,
      }),
  }).pipe(
    Effect.flatMap((apiKey) =>
      apiKey === null
        ? Effect.fail(
            new AssessmentCredentialError({
              message: `Bun.secrets has no ${TYPESAFE_SECRET.service}/${TYPESAFE_SECRET.name} credential.`,
            }),
          )
        : Effect.acquireUseRelease(
            Effect.sync(() => {
              const previous = process.env.TYPESAFE_API_KEY;
              process.env.TYPESAFE_API_KEY = apiKey;
              return previous;
            }),
            () => effect.pipe(Effect.provide(liveDecisionLayer())),
            (previous) =>
              Effect.sync(() => {
                if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
                else process.env.TYPESAFE_API_KEY = previous;
              }),
          ),
    ),
  );

export const evaluateStallLive = (state: StallState): Effect.Effect<StallAssessment, unknown> =>
  withLiveDecisionModel(evaluateStall(state));

const AcceptanceCriterion = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
});

export const AcceptanceState = Schema.Struct({
  schema_version: Schema.Literal(ASSESSMENT_SCHEMA_VERSION),
  assessment_id: Schema.String,
  ticket: Schema.Struct({
    number: Schema.String,
    title: Schema.String,
    body: Schema.String,
    acceptance_criteria: Schema.Array(AcceptanceCriterion),
  }),
  agreed_spec: Schema.String,
  synchronized_diff: Schema.String,
  changed_files: Schema.Array(Schema.String),
  gates: Schema.Array(
    Schema.Struct({
      command: Schema.String,
      status: Schema.Literals(["passed", "failed"]),
      output: Schema.String,
      truncated: Schema.Boolean,
    }),
  ),
  implementor_self_review: Schema.String,
});

export type AcceptanceState = typeof AcceptanceState.Type;
export type AcceptanceMode = "preflight-only" | "replace-spec-reviewer";

export type CriterionAssessment = {
  id: string;
  text: string;
  satisfaction: number;
  evidence_sufficiency: number;
};

export type AcceptanceAssessment = {
  criteria: CriterionAssessment[];
  usage: {
    input_tokens: number | null;
    output_tokens: number | null;
  };
};

export type AcceptanceDisposition =
  | {
      disposition: "fix";
      failed_criteria: string[];
      prompt: string;
    }
  | {
      disposition: "spec-review";
      failed_criteria: [];
      prompt: null;
    }
  | {
      disposition: "continue-spec-review" | "skip-spec-review";
      failed_criteria: [];
      prompt: null;
    };

export const acceptanceDecisions = (
  state: AcceptanceState,
): Record<string, Decision.Probability> => {
  const decisions: Record<string, Decision.Probability> = {};
  for (const criterion of state.ticket.acceptance_criteria) {
    decisions[`${criterion.id}.satisfied`] = Decision.probability({
      instructions: `The supplied implementation and evidence satisfy acceptance criterion ${criterion.id}: ${criterion.text}`,
      criteria: {
        false: "The implementation evidence demonstrates that this criterion is not satisfied.",
        true: "The implementation evidence demonstrates that this criterion is satisfied.",
      },
    });
    decisions[`${criterion.id}.evidence_sufficient`] = Decision.probability({
      instructions: `The supplied source and evidence are sufficient to judge acceptance criterion ${criterion.id} without inspecting additional repository state: ${criterion.text}`,
      criteria: {
        false:
          "Important evidence is missing, ambiguous, truncated, subjective, or outside the supplied state.",
        true: "The supplied state directly supports a reliable judgment for this criterion.",
      },
    });
  }
  return decisions;
};

export const evaluateAcceptance = (
  state: AcceptanceState,
): Effect.Effect<AcceptanceAssessment, unknown, DecisionModel.DecisionModel> => {
  const definition = Decision.make({
    input: AcceptanceState,
    decisions: acceptanceDecisions(state),
  });
  return DecisionModel.decide(definition, { input: state }).pipe(
    Effect.map(({ answers, usage }) => ({
      criteria: state.ticket.acceptance_criteria.map((criterion) => ({
        id: criterion.id,
        text: criterion.text,
        satisfaction: answers[`${criterion.id}.satisfied`]!.probability,
        evidence_sufficiency: answers[`${criterion.id}.evidence_sufficient`]!.probability,
      })),
      usage: {
        input_tokens: usage.inputTokens ?? null,
        output_tokens: usage.outputTokens ?? null,
      },
    })),
  );
};

export const acceptanceFixPrompt = (failed: CriterionAssessment[]): string =>
  [
    "Return to implementation for the acceptance criteria listed below.",
    "Fix each demonstrated failure or provide stronger direct evidence, then rerun gates and self-review.",
    ...failed.map(
      (criterion) =>
        `- ${criterion.id}: ${criterion.text} (satisfaction=${criterion.satisfaction.toFixed(3)}, evidence_sufficiency=${criterion.evidence_sufficiency.toFixed(3)})`,
    ),
  ].join("\n");

export const decideAcceptanceDisposition = (
  mode: AcceptanceMode,
  assessment: AcceptanceAssessment,
): AcceptanceDisposition => {
  const failed = assessment.criteria.filter(
    (criterion) => criterion.evidence_sufficiency >= 0.8 && criterion.satisfaction <= 0.2,
  );
  if (failed.length > 0) {
    return {
      disposition: "fix",
      failed_criteria: failed.map((criterion) => criterion.id),
      prompt: acceptanceFixPrompt(failed),
    };
  }
  const demonstratedPass = assessment.criteria.every(
    (criterion) => criterion.evidence_sufficiency >= 0.8 && criterion.satisfaction >= 0.8,
  );
  if (!demonstratedPass) {
    return { disposition: "spec-review", failed_criteria: [], prompt: null };
  }
  return mode === "replace-spec-reviewer"
    ? { disposition: "skip-spec-review", failed_criteria: [], prompt: null }
    : { disposition: "continue-spec-review", failed_criteria: [], prompt: null };
};

export const evaluateAcceptanceLive = (
  state: AcceptanceState,
): Effect.Effect<AcceptanceAssessment, unknown> => withLiveDecisionModel(evaluateAcceptance(state));
