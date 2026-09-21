import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Data, Effect, Schema } from "effect";
import type {
  CliIssue,
  StallAssessmentApplyInput,
  StallAssessmentEvaluateInput,
  StallAssessmentPrepareInput,
} from "./contract.ts";
import {
  ASSESSMENT_SCHEMA_VERSION,
  decideStallDisposition,
  evaluateStallLive,
  StallDecision,
  StallState,
  STALL_POLICY_VERSION,
  TYPESAFE_MODEL,
  type StallAssessment,
  type StallDisposition,
} from "./assessment.ts";

export type AssessmentFailure = {
  tag: string;
  message: string;
  module: string | null;
  method: string | null;
  reason: string | null;
  retryable: boolean;
  retry_after: string | null;
};

export type StallRequestArtifact = {
  schema_version: typeof ASSESSMENT_SCHEMA_VERSION;
  kind: "assessment-request";
  assessment_kind: "stall";
  assessment_id: string;
  attempt: number;
  previous_attempt: {
    evidence_path: string;
    evidence_sha256: string;
  } | null;
  question_schema_version: 1;
  authority_policy_version: typeof STALL_POLICY_VERSION;
  model_requested: typeof TYPESAFE_MODEL;
  created_at: string;
  state_sha256: string;
  state: StallState;
  questions: Record<
    string,
    {
      type: "noul";
      instructions: string;
      criteria: { false: string; true: string };
    }
  >;
};

export type StallEvidenceArtifact = {
  schema_version: typeof ASSESSMENT_SCHEMA_VERSION;
  kind: "assessment-evidence";
  assessment_kind: "stall";
  assessment_id: string;
  attempt: number;
  request_path: string;
  request_sha256: string;
  state_sha256: string;
  model_requested: typeof TYPESAFE_MODEL;
  model_returned: null;
  started_at: string;
  completed_at: string;
  latency_ms: number;
  status: "succeeded" | "failed";
  response: StallAssessment | null;
  error: AssessmentFailure | null;
  disposition: StallDisposition;
};

export type StallAssessmentPrepareResult = {
  request_path: string;
  assessment_id: string;
  attempt: number;
  state_sha256: string;
};

export type StallAssessmentEvaluateResult = {
  evidence_path: string;
  assessment_id: string;
  attempt: number;
  disposition: StallDisposition;
  usage: StallAssessment["usage"];
  latency_ms: number;
};

export type StallAssessmentApplyResult = {
  assessment_id: string;
  attempt: number;
  request_path: string;
  evidence_path: string;
  action: "wait" | "reprompt" | "pause" | "retry-worker";
  reason: StallDisposition["reason"];
  prompt_argv: string[] | null;
};

export type StallAssessmentDependencies = {
  evaluate: (state: StallState) => Promise<StallAssessment>;
  now: () => Date;
  monotonicNow: () => number;
};

export class StallAssessmentError extends Data.TaggedError("StallAssessmentError")<{
  issue: CliIssue;
}> {}

const defaultDependencies: StallAssessmentDependencies = {
  evaluate: (state) => Effect.runPromise(evaluateStallLive(state)),
  now: () => new Date(),
  monotonicNow: () => performance.now(),
};

const assessmentError = (
  code: string,
  message: string,
  remediation: string,
): StallAssessmentError => new StallAssessmentError({ issue: { code, message, remediation } });

const fromUnknown = (error: unknown): StallAssessmentError => {
  if (error instanceof StallAssessmentError) return error;
  return assessmentError(
    "stall.assessment_io_failed",
    `Could not process the stall assessment: ${(error as Error).message}`,
    "Keep the worker unchanged, verify the run-local paths and credential, then create a linked retry attempt if appropriate.",
  );
};

const sha256 = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const stateBindingSha256 = (state: StallState): string =>
  sha256(
    JSON.stringify({
      ...state,
      current_observation: { ...state.current_observation, observed_at: null },
    }),
  );

const timestamp = (dependencies: StallAssessmentDependencies): string =>
  dependencies.now().toISOString();

const inside = (parent: string, child: string): boolean => {
  const relation = relative(parent, child);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
};

const canonicalRunPath = async (runPath: string): Promise<string> => realpath(resolve(runPath));

const existingRunPath = async (runPath: string, targetPath: string): Promise<string> => {
  const run = await canonicalRunPath(runPath);
  const target = await realpath(resolve(targetPath));
  if (!inside(run, target)) {
    throw assessmentError(
      "stall.assessment_path_outside_run",
      `Assessment path \`${targetPath}\` resolves outside run \`${runPath}\`.`,
      "Place stall state, requests, and evidence under the current run directory.",
    );
  }
  return target;
};

const newRunPath = async (runPath: string, targetPath: string): Promise<string> => {
  const run = await canonicalRunPath(runPath);
  const lexicalRun = resolve(runPath);
  const resolved = resolve(targetPath);
  if (!inside(lexicalRun, resolved)) {
    throw assessmentError(
      "stall.assessment_path_outside_run",
      `Assessment path \`${targetPath}\` resolves outside run \`${runPath}\`.`,
      "Place stall state, requests, and evidence under the current run directory.",
    );
  }
  await mkdir(dirname(resolved), { recursive: true });
  const parent = await realpath(dirname(resolved));
  if (!inside(run, parent)) {
    throw assessmentError(
      "stall.assessment_path_outside_run",
      `Assessment path \`${targetPath}\` traverses outside run \`${runPath}\`.`,
      "Replace the run-local artifact directory symlink with a directory inside the run.",
    );
  }
  return join(parent, basename(resolved));
};

const writeNewJson = async (path: string, value: unknown): Promise<void> => {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
};

const validateBoundedState = (state: StallState): void => {
  const observations = [state.current_observation, state.previous_observation].filter(
    (observation): observation is NonNullable<StallState["previous_observation"]> =>
      observation !== null,
  );
  const unbounded =
    JSON.stringify(state).length > 128_000 ||
    state.ticket.acceptance_criteria.length > 100 ||
    observations.some(
      (observation) =>
        observation.pane_tail.length > 40 ||
        observation.recent_commits.length > 40 ||
        observation.git_status.length > 32_000 ||
        observation.pane_tail.some((line) => line.length > 4_000) ||
        observation.recent_commits.some((line) => line.length > 2_000) ||
        !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(observation.head) ||
        !Number.isFinite(Date.parse(observation.observed_at)),
    );
  if (unbounded) {
    throw assessmentError(
      "stall.assessment_state_unbounded",
      "Stall assessment state exceeds its bounded evidence contract or contains invalid observation metadata.",
      "Limit each pane tail and recent commit list to 40 entries, keep summaries bounded, and supply UTC observation times and full Git object ids.",
    );
  }
};

const decodeState = async (serialized: string): Promise<StallState> => {
  try {
    const state = await Effect.runPromise(
      Schema.decodeUnknownEffect(StallState)(JSON.parse(serialized) as unknown),
    );
    validateBoundedState(state);
    return state;
  } catch (error) {
    if (error instanceof StallAssessmentError) throw error;
    throw assessmentError(
      "stall.assessment_state_invalid",
      `Stall assessment state is malformed: ${(error as Error).message}`,
      "Write a schema-1 bounded StallState from the current worker and Git observations.",
    );
  }
};

export const stallAssessmentQuestions = (): StallRequestArtifact["questions"] =>
  Object.fromEntries(
    Object.entries(StallDecision.decisions).map(([key, decision]) => [
      key,
      {
        type: "noul" as const,
        instructions: decision.instructions,
        criteria: decision.criteria,
      },
    ]),
  );

const parseRequest = (serialized: string): StallRequestArtifact => {
  const value = JSON.parse(serialized) as StallRequestArtifact;
  const previousAttemptValid =
    value.attempt === 1
      ? value.previous_attempt === null
      : typeof value.previous_attempt === "object" &&
        value.previous_attempt !== null &&
        typeof value.previous_attempt.evidence_path === "string" &&
        /^sha256:[a-f0-9]{64}$/u.test(value.previous_attempt.evidence_sha256);
  if (
    value.schema_version !== ASSESSMENT_SCHEMA_VERSION ||
    value.kind !== "assessment-request" ||
    value.assessment_kind !== "stall" ||
    !Number.isInteger(value.attempt) ||
    value.attempt < 1 ||
    !previousAttemptValid ||
    value.question_schema_version !== 1 ||
    value.authority_policy_version !== STALL_POLICY_VERSION ||
    value.model_requested !== TYPESAFE_MODEL ||
    value.state_sha256 !== sha256(JSON.stringify(value.state)) ||
    JSON.stringify(value.questions) !== JSON.stringify(stallAssessmentQuestions())
  ) {
    throw assessmentError(
      "stall.assessment_request_malformed",
      "The immutable stall assessment request is malformed or internally inconsistent.",
      "Prepare a new request from the current bounded stall state; do not edit an existing artifact.",
    );
  }
  return value;
};

const validProbability = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

const validTokenCount = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);

const validateAssessment = (assessment: StallAssessment): void => {
  const answers = assessment.answers;
  if (
    !validProbability(answers.meaningful_progress) ||
    !validProbability(answers.mechanical_input_wait) ||
    !validProbability(answers.human_decision_required) ||
    !validProbability(answers.transient_service_failure) ||
    !validProbability(answers.crash_or_loop) ||
    !validTokenCount(assessment.usage.input_tokens) ||
    !validTokenCount(assessment.usage.output_tokens)
  ) {
    throw new Error("TypeSafe returned an invalid stall probability distribution or usage record");
  }
};

const parseEvidence = (serialized: string): StallEvidenceArtifact => {
  const value = JSON.parse(serialized) as StallEvidenceArtifact;
  const succeeded = value.status === "succeeded" && value.response !== null && value.error === null;
  const failed = value.status === "failed" && value.response === null && value.error !== null;
  if (
    value.schema_version !== ASSESSMENT_SCHEMA_VERSION ||
    value.kind !== "assessment-evidence" ||
    value.assessment_kind !== "stall" ||
    !Number.isInteger(value.attempt) ||
    value.attempt < 1 ||
    value.model_requested !== TYPESAFE_MODEL ||
    (!succeeded && !failed)
  ) {
    throw assessmentError(
      "stall.assessment_evidence_malformed",
      "The immutable stall assessment evidence is malformed.",
      "Keep the worker unchanged and prepare a new linked assessment attempt.",
    );
  }
  return value;
};

const failureDetails = (error: unknown): AssessmentFailure => {
  if (typeof error !== "object" || error === null) {
    return {
      tag: "UnknownError",
      message: String(error),
      module: null,
      method: null,
      reason: null,
      retryable: false,
      retry_after: null,
    };
  }
  const record = error as Record<string, unknown>;
  const reason =
    typeof record.reason === "object" && record.reason !== null
      ? (record.reason as Record<string, unknown>)
      : null;
  const tag = Reflect.get(record, "_tag");
  const reasonTag = reason === null ? undefined : Reflect.get(reason, "_tag");
  return {
    tag: typeof tag === "string" ? tag : error.constructor.name,
    message: error instanceof Error ? error.message : String(error),
    module: typeof record.module === "string" ? record.module : null,
    method: typeof record.method === "string" ? record.method : null,
    reason: typeof reasonTag === "string" ? reasonTag : null,
    retryable: record.isRetryable === true,
    retry_after: record.retryAfter === undefined ? null : String(record.retryAfter),
  };
};

const verifiedPreviousAttempt = async (
  runPath: string,
  evidencePath: string,
  state: StallState,
): Promise<{ attempt: number; evidence_path: string; evidence_sha256: string }> => {
  const canonicalEvidencePath = await existingRunPath(runPath, evidencePath);
  const serializedEvidence = await readFile(canonicalEvidencePath, "utf8");
  const evidence = parseEvidence(serializedEvidence);
  const canonicalRequestPath = await existingRunPath(runPath, evidence.request_path);
  const serializedRequest = await readFile(canonicalRequestPath, "utf8");
  const request = parseRequest(serializedRequest);
  if (
    evidence.status !== "failed" ||
    evidence.request_path !== canonicalRequestPath ||
    evidence.request_sha256 !== sha256(serializedRequest) ||
    evidence.state_sha256 !== request.state_sha256 ||
    evidence.assessment_id !== state.assessment_id ||
    evidence.attempt !== request.attempt ||
    request.state_sha256 !== sha256(JSON.stringify(state))
  ) {
    throw assessmentError(
      "stall.assessment_retry_invalid",
      "The previous attempt is not a failed, immutable assessment of the exact same bounded state.",
      "Do not retry stale or successful evidence. Prepare attempt 1 for a new observation, or link the unchanged failed attempt.",
    );
  }
  return {
    attempt: evidence.attempt,
    evidence_path: canonicalEvidencePath,
    evidence_sha256: sha256(serializedEvidence),
  };
};

export const prepareStallAssessment = (
  input: StallAssessmentPrepareInput,
  dependencies: StallAssessmentDependencies = defaultDependencies,
): Effect.Effect<StallAssessmentPrepareResult, StallAssessmentError> =>
  Effect.tryPromise({
    try: async () => {
      const statePath = await existingRunPath(input.runPath, input.statePath);
      const requestPath = await newRunPath(input.runPath, input.requestPath);
      const state = await decodeState(await readFile(statePath, "utf8"));
      const previous =
        input.previousEvidencePath === undefined
          ? null
          : await verifiedPreviousAttempt(input.runPath, input.previousEvidencePath, state);
      const artifact: StallRequestArtifact = {
        schema_version: ASSESSMENT_SCHEMA_VERSION,
        kind: "assessment-request",
        assessment_kind: "stall",
        assessment_id: state.assessment_id,
        attempt: (previous?.attempt ?? 0) + 1,
        previous_attempt:
          previous === null
            ? null
            : {
                evidence_path: previous.evidence_path,
                evidence_sha256: previous.evidence_sha256,
              },
        question_schema_version: 1,
        authority_policy_version: STALL_POLICY_VERSION,
        model_requested: TYPESAFE_MODEL,
        created_at: timestamp(dependencies),
        state_sha256: sha256(JSON.stringify(state)),
        state,
        questions: stallAssessmentQuestions(),
      };
      await writeNewJson(requestPath, artifact);
      return {
        request_path: requestPath,
        assessment_id: artifact.assessment_id,
        attempt: artifact.attempt,
        state_sha256: artifact.state_sha256,
      };
    },
    catch: fromUnknown,
  });

export const evaluateStallAssessment = (
  input: StallAssessmentEvaluateInput,
  dependencies: StallAssessmentDependencies = defaultDependencies,
): Effect.Effect<StallAssessmentEvaluateResult, StallAssessmentError> =>
  Effect.tryPromise({
    try: async () => {
      const requestPath = await existingRunPath(input.runPath, input.requestPath);
      const evidencePath = await newRunPath(input.runPath, input.evidencePath);
      const serializedRequest = await readFile(requestPath, "utf8");
      const request = parseRequest(serializedRequest);
      const started = dependencies.monotonicNow();
      const startedAt = timestamp(dependencies);
      try {
        const response = await dependencies.evaluate(request.state);
        validateAssessment(response);
        const evidence: StallEvidenceArtifact = {
          schema_version: ASSESSMENT_SCHEMA_VERSION,
          kind: "assessment-evidence",
          assessment_kind: "stall",
          assessment_id: request.assessment_id,
          attempt: request.attempt,
          request_path: requestPath,
          request_sha256: sha256(serializedRequest),
          state_sha256: request.state_sha256,
          model_requested: TYPESAFE_MODEL,
          model_returned: null,
          started_at: startedAt,
          completed_at: timestamp(dependencies),
          latency_ms: Math.round((dependencies.monotonicNow() - started) * 100) / 100,
          status: "succeeded",
          response,
          error: null,
          disposition: decideStallDisposition(request.state.worker.status, response.answers),
        };
        await writeNewJson(evidencePath, evidence);
        return {
          evidence_path: evidencePath,
          assessment_id: evidence.assessment_id,
          attempt: evidence.attempt,
          disposition: evidence.disposition,
          usage: response.usage,
          latency_ms: evidence.latency_ms,
        };
      } catch (error) {
        const evidence: StallEvidenceArtifact = {
          schema_version: ASSESSMENT_SCHEMA_VERSION,
          kind: "assessment-evidence",
          assessment_kind: "stall",
          assessment_id: request.assessment_id,
          attempt: request.attempt,
          request_path: requestPath,
          request_sha256: sha256(serializedRequest),
          state_sha256: request.state_sha256,
          model_requested: TYPESAFE_MODEL,
          model_returned: null,
          started_at: startedAt,
          completed_at: timestamp(dependencies),
          latency_ms: Math.round((dependencies.monotonicNow() - started) * 100) / 100,
          status: "failed",
          response: null,
          error: failureDetails(error),
          disposition: { disposition: "pause", reason: "uncertain", prompt: null },
        };
        await writeNewJson(evidencePath, evidence);
        throw assessmentError(
          "stall.assessment_provider_failed",
          `TypeSafe stall assessment failed and the seam is paused; evidence: ${evidencePath}; ${evidence.error?.message}`,
          "Do not fall back or act on the worker. Resolve the provider or credential failure, then prepare a linked retry attempt.",
        );
      }
    },
    catch: fromUnknown,
  });

const actionFor = (
  request: StallRequestArtifact,
  disposition: StallDisposition,
): Pick<StallAssessmentApplyResult, "action" | "reason" | "prompt_argv"> => {
  if (disposition.disposition === "reprompt") {
    return {
      action: "reprompt",
      reason: disposition.reason,
      prompt_argv: ["herdr", "agent", "prompt", request.state.worker.session, disposition.prompt],
    };
  }
  if (disposition.disposition === "wait") {
    return { action: "wait", reason: disposition.reason, prompt_argv: null };
  }
  if (disposition.reason === "crash_or_loop") {
    return { action: "retry-worker", reason: disposition.reason, prompt_argv: null };
  }
  return { action: "pause", reason: disposition.reason, prompt_argv: null };
};

export const applyStallAssessment = (
  input: StallAssessmentApplyInput,
): Effect.Effect<StallAssessmentApplyResult, StallAssessmentError> =>
  Effect.tryPromise({
    try: async () => {
      const requestPath = await existingRunPath(input.runPath, input.requestPath);
      const evidencePath = await existingRunPath(input.runPath, input.evidencePath);
      const statePath = await existingRunPath(input.runPath, input.statePath);
      const serializedRequest = await readFile(requestPath, "utf8");
      const serializedEvidence = await readFile(evidencePath, "utf8");
      const currentState = await decodeState(await readFile(statePath, "utf8"));
      const request = parseRequest(serializedRequest);
      const evidence = parseEvidence(serializedEvidence);
      const expectedDisposition =
        evidence.status === "succeeded" && evidence.response !== null
          ? decideStallDisposition(request.state.worker.status, evidence.response.answers)
          : { disposition: "pause" as const, reason: "uncertain" as const, prompt: null };
      if (
        evidence.request_path !== requestPath ||
        evidence.request_sha256 !== sha256(serializedRequest) ||
        evidence.state_sha256 !== request.state_sha256 ||
        stateBindingSha256(currentState) !== stateBindingSha256(request.state) ||
        Date.parse(currentState.current_observation.observed_at) <
          Date.parse(request.state.current_observation.observed_at) ||
        evidence.assessment_id !== request.assessment_id ||
        evidence.attempt !== request.attempt ||
        JSON.stringify(evidence.disposition) !== JSON.stringify(expectedDisposition)
      ) {
        throw assessmentError(
          "stall.assessment_binding_mismatch",
          "Stall assessment evidence does not match the immutable request.",
          "Do not act on this evidence. Prepare and evaluate a new request from the current bounded state.",
        );
      }
      if (evidence.response !== null) validateAssessment(evidence.response);
      return {
        assessment_id: evidence.assessment_id,
        attempt: evidence.attempt,
        request_path: requestPath,
        evidence_path: evidencePath,
        ...actionFor(request, expectedDisposition),
      };
    },
    catch: fromUnknown,
  });
