import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result } from "effect";
import type { StallAssessment, StallState } from "./lib/assessment.ts";
import { parseRequest, type CoordinateRequest } from "./lib/contract.ts";
import {
  applyStallAssessment,
  evaluateStallAssessment,
  prepareStallAssessment,
  StallAssessmentError,
  type StallAssessmentDependencies,
  type StallEvidenceArtifact,
  type StallRequestArtifact,
} from "./lib/stall-assessment.ts";

const roots: string[] = [];
const coordinateCli = join(import.meta.dir, "coordinate.ts");

const fixture = async (): Promise<{
  root: string;
  runPath: string;
  statePath: string;
  requestPath: string;
  evidencePath: string;
}> => {
  const root = await mkdtemp(join(tmpdir(), "stall-assessment-"));
  roots.push(root);
  const runPath = join(root, "run");
  const artifacts = join(runPath, "artifacts", "stall");
  await mkdir(artifacts, { recursive: true });
  const statePath = join(artifacts, "state.json");
  await writeFile(statePath, `${JSON.stringify(stallState(), null, 2)}\n`);
  return {
    root,
    runPath,
    statePath,
    requestPath: join(artifacts, "request-1.json"),
    evidencePath: join(artifacts, "evidence-1.json"),
  };
};

const stallState = (): StallState => ({
  schema_version: 1,
  assessment_id: "stall-ticket-01-timeout-02",
  ticket: {
    number: "01",
    title: "Create greeting",
    acceptance_criteria: ["Create greeting.txt containing hello and one newline."],
  },
  worker: {
    session: "run-01",
    harness: "pi",
    model: "openai-codex/gpt-5.6-luna",
    effort: "max",
    status: "idle",
    phase: "implementation",
  },
  previous_observation: null,
  current_observation: {
    observed_at: "2026-09-21T14:00:00.000Z",
    pane_tail: ["Should I use greeting.txt?"],
    head: "1111111111111111111111111111111111111111",
    git_status: "",
    recent_commits: ["1111111 test: initialize fixture"],
  },
});

const mechanicalAssessment = (): StallAssessment => ({
  answers: {
    meaningful_progress: 0.05,
    mechanical_input_wait: 0.79,
    human_decision_required: 0.01,
    transient_service_failure: 0.01,
    crash_or_loop: 0.01,
  },
  usage: { input_tokens: 100, output_tokens: 20 },
});

const dependencies = (
  evaluate: StallAssessmentDependencies["evaluate"] = async () => mechanicalAssessment(),
): StallAssessmentDependencies => {
  let monotonic = 100;
  return {
    evaluate,
    now: () => new Date("2026-09-21T14:05:00.000Z"),
    monotonicNow: () => {
      monotonic += 25;
      return monotonic;
    },
  };
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("stall assessment helper contract", () => {
  it("normalizes prepare, evaluate, and apply requests", async () => {
    const prepare = await Effect.runPromise(
      parseRequest(
        JSON.stringify({
          schema_version: 1,
          operation: "stall.assessment.prepare",
          input: {
            run_path: "/run",
            state_path: "/run/state.json",
            request_path: "/run/request.json",
            previous_evidence_path: null,
          },
        }),
      ),
    );
    expect(prepare).toEqual({
      schemaVersion: 1,
      operation: "stall.assessment.prepare",
      input: {
        runPath: "/run",
        statePath: "/run/state.json",
        requestPath: "/run/request.json",
        previousEvidencePath: undefined,
      },
    });

    for (const operation of ["stall.assessment.evaluate", "stall.assessment.apply"] as const) {
      const request = await Effect.runPromise(
        parseRequest(
          JSON.stringify({
            schema_version: 1,
            operation,
            input: {
              run_path: "/run",
              ...(operation === "stall.assessment.apply"
                ? { state_path: "/run/current-state.json" }
                : {}),
              request_path: "/run/request.json",
              evidence_path: "/run/evidence.json",
            },
          }),
        ),
      );
      const expected: CoordinateRequest =
        operation === "stall.assessment.apply"
          ? {
              schemaVersion: 1,
              operation,
              input: {
                runPath: "/run",
                statePath: "/run/current-state.json",
                requestPath: "/run/request.json",
                evidencePath: "/run/evidence.json",
              },
            }
          : {
              schemaVersion: 1,
              operation,
              input: {
                runPath: "/run",
                requestPath: "/run/request.json",
                evidencePath: "/run/evidence.json",
              },
            };
      expect(request).toEqual(expected);
    }
  });

  it("dispatches prepare through the production coordinate CLI", async () => {
    const paths = await fixture();
    const child = Bun.spawnSync([process.execPath, coordinateCli], {
      env: process.env,
      stdin: Buffer.from(
        JSON.stringify({
          schema_version: 1,
          operation: "stall.assessment.prepare",
          input: {
            run_path: paths.runPath,
            state_path: paths.statePath,
            request_path: paths.requestPath,
            previous_evidence_path: null,
          },
        }),
      ),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);
    const response = JSON.parse(child.stdout.toString()) as {
      schema_version: number;
      ok: boolean;
      operation: string;
      result: {
        request_path: string;
        assessment_id: string;
        attempt: number;
        state_sha256: string;
      };
      errors: unknown[];
    };
    expect(response).toEqual({
      schema_version: 1,
      operation: "stall.assessment.prepare",
      ok: true,
      result: {
        request_path: await realpath(paths.requestPath),
        assessment_id: "stall-ticket-01-timeout-02",
        attempt: 1,
        state_sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      },
      errors: [],
    });
  });

  it("rejects an incomplete prepare request", async () => {
    const outcome = await Effect.runPromise(
      Effect.result(
        parseRequest(
          JSON.stringify({
            schema_version: 1,
            operation: "stall.assessment.prepare",
            input: { run_path: "/run" },
          }),
        ),
      ),
    );
    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isSuccess(outcome)) throw new Error("expected invalid request");
    expect(outcome.failure.issue.code).toBe("request.invalid");
  });
});

describe("production stall assessment lifecycle", () => {
  it("prepares, evaluates, and applies a bound mechanical-input re-prompt", async () => {
    const paths = await fixture();
    const prepared = await Effect.runPromise(
      prepareStallAssessment(
        {
          runPath: paths.runPath,
          statePath: paths.statePath,
          requestPath: paths.requestPath,
          previousEvidencePath: undefined,
        },
        dependencies(),
      ),
    );
    const canonicalRequestPath = await realpath(paths.requestPath);
    expect(prepared).toEqual({
      request_path: canonicalRequestPath,
      assessment_id: "stall-ticket-01-timeout-02",
      attempt: 1,
      state_sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });

    const evaluated = await Effect.runPromise(
      evaluateStallAssessment(
        {
          runPath: paths.runPath,
          requestPath: paths.requestPath,
          evidencePath: paths.evidencePath,
        },
        dependencies(),
      ),
    );
    const expectedPrompt =
      "Continue the current ticket using the accepted instructions and acceptance criteria. Do not wait for confirmation when those sources already determine the answer. If continuing requires new user authority or a materially different product decision, report the exact blocker instead.";
    expect(evaluated.disposition).toEqual({
      disposition: "reprompt",
      reason: "mechanical_input",
      prompt: expectedPrompt,
    });
    expect(evaluated.usage).toEqual({ input_tokens: 100, output_tokens: 20 });

    const initialApplyState = stallState();
    const applyState: StallState = {
      ...initialApplyState,
      current_observation: {
        ...initialApplyState.current_observation,
        observed_at: "2026-09-21T14:05:01.000Z",
      },
    };
    const applyStatePath = join(paths.runPath, "artifacts", "stall", "apply-state.json");
    await writeFile(applyStatePath, `${JSON.stringify(applyState, null, 2)}\n`);
    const applied = await Effect.runPromise(
      applyStallAssessment({
        runPath: paths.runPath,
        statePath: applyStatePath,
        requestPath: paths.requestPath,
        evidencePath: paths.evidencePath,
      }),
    );
    const canonicalEvidencePath = await realpath(paths.evidencePath);
    expect(applied).toEqual({
      assessment_id: "stall-ticket-01-timeout-02",
      attempt: 1,
      request_path: canonicalRequestPath,
      evidence_path: canonicalEvidencePath,
      action: "reprompt",
      reason: "mechanical_input",
      prompt_argv: ["herdr", "agent", "prompt", "run-01", expectedPrompt],
    });
  });

  it("persists provider failure and requires a linked immutable retry", async () => {
    const paths = await fixture();
    await Effect.runPromise(
      prepareStallAssessment(
        {
          runPath: paths.runPath,
          statePath: paths.statePath,
          requestPath: paths.requestPath,
          previousEvidencePath: undefined,
        },
        dependencies(),
      ),
    );
    const outcome = await Effect.runPromise(
      Effect.result(
        evaluateStallAssessment(
          {
            runPath: paths.runPath,
            requestPath: paths.requestPath,
            evidencePath: paths.evidencePath,
          },
          dependencies(async () => {
            throw new Error("HTTP 429 rate limited");
          }),
        ),
      ),
    );
    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isSuccess(outcome)) throw new Error("expected provider failure");
    expect(outcome.failure).toBeInstanceOf(StallAssessmentError);
    expect(outcome.failure.issue.code).toBe("stall.assessment_provider_failed");
    const evidence = JSON.parse(
      await readFile(paths.evidencePath, "utf8"),
    ) as StallEvidenceArtifact;
    expect(evidence.status).toBe("failed");
    expect(evidence.error?.message).toBe("HTTP 429 rate limited");

    const retryPath = join(paths.runPath, "artifacts", "stall", "request-2.json");
    const retried = await Effect.runPromise(
      prepareStallAssessment(
        {
          runPath: paths.runPath,
          statePath: paths.statePath,
          requestPath: retryPath,
          previousEvidencePath: paths.evidencePath,
        },
        dependencies(),
      ),
    );
    expect(retried.attempt).toBe(2);
    const request = JSON.parse(await readFile(retryPath, "utf8")) as StallRequestArtifact;
    expect(request.previous_attempt).toEqual({
      evidence_path: await realpath(paths.evidencePath),
      evidence_sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
  });

  it("persists and rejects an invalid probability distribution without normalization", async () => {
    const paths = await fixture();
    await Effect.runPromise(
      prepareStallAssessment(
        {
          runPath: paths.runPath,
          statePath: paths.statePath,
          requestPath: paths.requestPath,
          previousEvidencePath: undefined,
        },
        dependencies(),
      ),
    );
    const outcome = await Effect.runPromise(
      Effect.result(
        evaluateStallAssessment(
          {
            runPath: paths.runPath,
            requestPath: paths.requestPath,
            evidencePath: paths.evidencePath,
          },
          dependencies(async () => ({
            ...mechanicalAssessment(),
            answers: { ...mechanicalAssessment().answers, mechanical_input_wait: 1.2 },
          })),
        ),
      ),
    );
    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isSuccess(outcome)) throw new Error("expected malformed provider response");
    expect(outcome.failure.issue.code).toBe("stall.assessment_provider_failed");
    const evidence = JSON.parse(
      await readFile(paths.evidencePath, "utf8"),
    ) as StallEvidenceArtifact;
    expect(evidence.status).toBe("failed");
    expect(evidence.response).toBe(null);
    expect(evidence.error?.message).toBe(
      "TypeSafe returned an invalid stall probability distribution or usage record",
    );
  });

  it("rejects evidence after its immutable request is changed", async () => {
    const paths = await fixture();
    await Effect.runPromise(
      prepareStallAssessment(
        {
          runPath: paths.runPath,
          statePath: paths.statePath,
          requestPath: paths.requestPath,
          previousEvidencePath: undefined,
        },
        dependencies(),
      ),
    );
    await Effect.runPromise(
      evaluateStallAssessment(
        {
          runPath: paths.runPath,
          requestPath: paths.requestPath,
          evidencePath: paths.evidencePath,
        },
        dependencies(),
      ),
    );
    const request = JSON.parse(await readFile(paths.requestPath, "utf8")) as Record<
      string,
      unknown
    >;
    request.tampered = true;
    await writeFile(paths.requestPath, `${JSON.stringify(request, null, 2)}\n`);

    const outcome = await Effect.runPromise(
      Effect.result(
        applyStallAssessment({
          runPath: paths.runPath,
          statePath: paths.statePath,
          requestPath: paths.requestPath,
          evidencePath: paths.evidencePath,
        }),
      ),
    );
    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isSuccess(outcome)) throw new Error("expected binding failure");
    expect(outcome.failure.issue.code).toBe("stall.assessment_binding_mismatch");
  });

  it("rejects stale evidence when the bounded worker state changes before apply", async () => {
    const paths = await fixture();
    await Effect.runPromise(
      prepareStallAssessment(
        {
          runPath: paths.runPath,
          statePath: paths.statePath,
          requestPath: paths.requestPath,
          previousEvidencePath: undefined,
        },
        dependencies(),
      ),
    );
    await Effect.runPromise(
      evaluateStallAssessment(
        {
          runPath: paths.runPath,
          requestPath: paths.requestPath,
          evidencePath: paths.evidencePath,
        },
        dependencies(),
      ),
    );
    const initialStaleState = stallState();
    const staleState: StallState = {
      ...initialStaleState,
      current_observation: {
        ...initialStaleState.current_observation,
        head: "2222222222222222222222222222222222222222",
      },
    };
    const applyStatePath = join(paths.runPath, "artifacts", "stall", "apply-state.json");
    await writeFile(applyStatePath, `${JSON.stringify(staleState, null, 2)}\n`);

    const outcome = await Effect.runPromise(
      Effect.result(
        applyStallAssessment({
          runPath: paths.runPath,
          statePath: applyStatePath,
          requestPath: paths.requestPath,
          evidencePath: paths.evidencePath,
        }),
      ),
    );
    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isSuccess(outcome)) throw new Error("expected stale evidence failure");
    expect(outcome.failure.issue.code).toBe("stall.assessment_binding_mismatch");
  });

  it("rejects state and artifacts outside the run", async () => {
    const paths = await fixture();
    const outside = join(paths.root, "outside-request.json");
    const outcome = await Effect.runPromise(
      Effect.result(
        prepareStallAssessment(
          {
            runPath: paths.runPath,
            statePath: paths.statePath,
            requestPath: outside,
            previousEvidencePath: undefined,
          },
          dependencies(),
        ),
      ),
    );
    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isSuccess(outcome)) throw new Error("expected path failure");
    expect(outcome.failure.issue.code).toBe("stall.assessment_path_outside_run");
  });
});
