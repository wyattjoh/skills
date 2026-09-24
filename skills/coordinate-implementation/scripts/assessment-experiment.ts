#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Effect, Result, Schema } from "effect";
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
} from "./lib/assessment.ts";

type StallRequestArtifact = {
  schema_version: typeof ASSESSMENT_SCHEMA_VERSION;
  kind: "assessment-request";
  assessment_kind: "stall";
  assessment_id: string;
  attempt: 1;
  previous_attempt: null;
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
      criteria?: { false: string; true: string };
    }
  >;
};

type AssessmentFailure = {
  tag: string;
  message: string;
  module: string | null;
  method: string | null;
  reason: string | null;
  retryable: boolean;
  retry_after: string | null;
};

type StallEvidenceArtifact = {
  schema_version: typeof ASSESSMENT_SCHEMA_VERSION;
  kind: "assessment-evidence";
  assessment_kind: "stall";
  assessment_id: string;
  attempt: 1;
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

type InputEnvelope = {
  schema_version: number;
  operation: string;
  input: Record<string, unknown>;
};

const sha256 = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const timestamp = (): string => new Date().toISOString();

const writeNewJson = async (path: string, value: unknown): Promise<void> => {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
};

const requireString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
};

const parseEnvelope = (raw: string): InputEnvelope => {
  const value = JSON.parse(raw) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("request must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (record.schema_version !== ASSESSMENT_SCHEMA_VERSION) {
    throw new Error("request schema_version must be 1");
  }
  if (typeof record.operation !== "string") {
    throw new Error("request operation must be a string");
  }
  if (typeof record.input !== "object" || record.input === null || Array.isArray(record.input)) {
    throw new Error("request input must be an object");
  }
  return {
    schema_version: ASSESSMENT_SCHEMA_VERSION,
    operation: record.operation,
    input: record.input as Record<string, unknown>,
  };
};

const questions = (): StallRequestArtifact["questions"] =>
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

const parseStallRequest = (serialized: string): StallRequestArtifact => {
  const value = JSON.parse(serialized) as StallRequestArtifact;
  if (
    value.schema_version !== ASSESSMENT_SCHEMA_VERSION ||
    value.kind !== "assessment-request" ||
    value.assessment_kind !== "stall" ||
    value.attempt !== 1 ||
    value.question_schema_version !== 1 ||
    value.authority_policy_version !== STALL_POLICY_VERSION ||
    value.model_requested !== TYPESAFE_MODEL
  ) {
    throw new Error("assessment request metadata is malformed");
  }
  return value;
};

const parseStallEvidence = (serialized: string): StallEvidenceArtifact => {
  const value = JSON.parse(serialized) as StallEvidenceArtifact;
  if (
    value.schema_version !== ASSESSMENT_SCHEMA_VERSION ||
    value.kind !== "assessment-evidence" ||
    value.assessment_kind !== "stall" ||
    value.attempt !== 1
  ) {
    throw new Error("assessment evidence metadata is malformed");
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

const prepareStall = async (input: Record<string, unknown>): Promise<unknown> => {
  const statePath = requireString(input.state_path, "input.state_path");
  const requestPath = requireString(input.request_path, "input.request_path");
  const rawState = JSON.parse(await readFile(statePath, "utf8")) as unknown;
  const state = await Effect.runPromise(Schema.decodeUnknownEffect(StallState)(rawState));
  const canonicalState = JSON.stringify(state);
  const artifact: StallRequestArtifact = {
    schema_version: ASSESSMENT_SCHEMA_VERSION,
    kind: "assessment-request",
    assessment_kind: "stall",
    assessment_id: state.assessment_id,
    attempt: 1,
    previous_attempt: null,
    question_schema_version: 1,
    authority_policy_version: STALL_POLICY_VERSION,
    model_requested: TYPESAFE_MODEL,
    created_at: timestamp(),
    state_sha256: sha256(canonicalState),
    state,
    questions: questions(),
  };
  await writeNewJson(requestPath, artifact);
  return {
    request_path: requestPath,
    assessment_id: state.assessment_id,
    state_sha256: artifact.state_sha256,
  };
};

const evaluateStallRequest = async (input: Record<string, unknown>): Promise<unknown> => {
  const requestPath = requireString(input.request_path, "input.request_path");
  const evidencePath = requireString(input.evidence_path, "input.evidence_path");
  const serializedRequest = await readFile(requestPath, "utf8");
  const request = parseStallRequest(serializedRequest);
  const started = performance.now();
  const startedAt = timestamp();
  const outcome = await Effect.runPromise(Effect.result(evaluateStallLive(request.state)));
  const completedAt = timestamp();
  const latencyMs = Math.round((performance.now() - started) * 100) / 100;

  let evidence: StallEvidenceArtifact;
  if (Result.isSuccess(outcome)) {
    evidence = {
      schema_version: ASSESSMENT_SCHEMA_VERSION,
      kind: "assessment-evidence",
      assessment_kind: "stall",
      assessment_id: request.assessment_id,
      attempt: 1,
      request_path: requestPath,
      request_sha256: sha256(serializedRequest),
      state_sha256: request.state_sha256,
      model_requested: TYPESAFE_MODEL,
      model_returned: null,
      started_at: startedAt,
      completed_at: completedAt,
      latency_ms: latencyMs,
      status: "succeeded",
      response: outcome.success,
      error: null,
      disposition: decideStallDisposition(request.state.worker.status, outcome.success.answers),
    };
  } else {
    evidence = {
      schema_version: ASSESSMENT_SCHEMA_VERSION,
      kind: "assessment-evidence",
      assessment_kind: "stall",
      assessment_id: request.assessment_id,
      attempt: 1,
      request_path: requestPath,
      request_sha256: sha256(serializedRequest),
      state_sha256: request.state_sha256,
      model_requested: TYPESAFE_MODEL,
      model_returned: null,
      started_at: startedAt,
      completed_at: completedAt,
      latency_ms: latencyMs,
      status: "failed",
      response: null,
      error: failureDetails(outcome.failure),
      disposition: { disposition: "pause", reason: "uncertain", prompt: null },
    };
  }

  await writeNewJson(evidencePath, evidence);
  if (evidence.status === "failed") {
    throw new Error(
      `TypeSafe assessment failed and the seam is paused; evidence: ${evidencePath}; ${evidence.error?.message}`,
    );
  }
  return {
    evidence_path: evidencePath,
    assessment_id: evidence.assessment_id,
    disposition: evidence.disposition,
    usage: evidence.response?.usage,
    latency_ms: evidence.latency_ms,
  };
};

const applyStall = async (input: Record<string, unknown>): Promise<unknown> => {
  const requestPath = requireString(input.request_path, "input.request_path");
  const evidencePath = requireString(input.evidence_path, "input.evidence_path");
  const serializedRequest = await readFile(requestPath, "utf8");
  const request = parseStallRequest(serializedRequest);
  const evidence = parseStallEvidence(await readFile(evidencePath, "utf8"));
  if (
    evidence.request_path !== requestPath ||
    evidence.request_sha256 !== sha256(serializedRequest) ||
    evidence.state_sha256 !== request.state_sha256 ||
    evidence.assessment_id !== request.assessment_id
  ) {
    throw new Error("assessment evidence does not match the immutable request");
  }
  return {
    assessment_id: evidence.assessment_id,
    status: evidence.status,
    disposition:
      evidence.status === "succeeded"
        ? evidence.disposition
        : { disposition: "pause", reason: "uncertain", prompt: null },
  };
};

const run = async (): Promise<void> => {
  const request = parseEnvelope(await Bun.stdin.text());
  let result: unknown;
  switch (request.operation) {
    case "stall.prepare":
      result = await prepareStall(request.input);
      break;
    case "stall.evaluate":
      result = await evaluateStallRequest(request.input);
      break;
    case "stall.apply":
      result = await applyStall(request.input);
      break;
    default:
      throw new Error(`unsupported assessment operation: ${request.operation}`);
  }
  console.log(
    JSON.stringify(
      {
        schema_version: ASSESSMENT_SCHEMA_VERSION,
        operation: request.operation,
        ok: true,
        result,
        errors: [],
      },
      null,
      2,
    ),
  );
};

try {
  await run();
} catch (error) {
  console.log(
    JSON.stringify(
      {
        schema_version: ASSESSMENT_SCHEMA_VERSION,
        operation: null,
        ok: false,
        result: null,
        errors: [{ code: "assessment.failed", message: (error as Error).message }],
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}
