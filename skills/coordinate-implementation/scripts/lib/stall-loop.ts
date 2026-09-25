import { Effect } from "effect";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ASSESSMENT_SCHEMA_VERSION, type StallState } from "./assessment.ts";
import type { CliIssue, HarnessName } from "./contract.ts";
import { spawnGit } from "./git.ts";
import type { HerdrActuator } from "./herdr-actuator.ts";
import {
  applyStallAssessment,
  evaluateStallAssessment,
  prepareStallAssessment,
  type StallAssessmentApplyResult,
  type StallAssessmentDependencies,
} from "./stall-assessment.ts";

/**
 * Bounded observation of one worker at one moment.
 */
export type StallObservation = StallState["current_observation"];

/**
 * Worker and ticket identity used to build a stall assessment.
 */
export type StallTarget = {
  runPath: string;
  ticket: { number: string; title: string; acceptanceCriteria: string[] };
  worker: {
    session: string;
    paneId: string;
    harness: HarnessName;
    model: string;
    effort: string;
    status: "working" | "idle" | "blocked";
    phase: string;
  };
  worktree: string;
  base: string;
  sequence: number;
  previous: StallObservation | null;
};

/**
 * Outcome of one bounded stall check.
 */
export type StallCheck = {
  action: StallAssessmentApplyResult["action"];
  reason: string;
  observation: StallObservation;
  evidencePath: string;
};

/**
 * Stall check failure; the caller pauses only the affected ticket.
 */
export class StallLoopError extends Error {
  readonly issue: CliIssue;

  constructor(issue: CliIssue) {
    super(issue.message);
    this.issue = issue;
  }
}

const git = (worktree: string, args: string[]): string => {
  const result = spawnGit(["-C", worktree, ...args]);
  return result.exitCode === 0 ? result.stdout.toString().trimEnd() : "";
};

const utc = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Collects the bounded fields the stall policy allows: 40 pane lines and Git summaries.
 *
 * @param target - Worker and worktree to observe.
 * @param actuator - Herdr actuator used to read the pane tail.
 * @param now - Observation time.
 * @returns An Effect containing the observation.
 */
export const observeWorker = (
  target: StallTarget,
  actuator: HerdrActuator,
  now: Date,
): Effect.Effect<StallObservation, StallLoopError> =>
  actuator.readPane(target.worker.paneId, 40).pipe(
    Effect.orElseSucceed(() => ""),
    Effect.map((tail) => ({
      observed_at: utc(now),
      pane_tail: tail.split("\n").slice(-40),
      head: git(target.worktree, ["rev-parse", "HEAD"]),
      git_status: git(target.worktree, ["status", "--short"]),
      recent_commits: git(target.worktree, ["log", "--oneline", "-20", `${target.base}..HEAD`])
        .split("\n")
        .filter((line) => line.length > 0),
    })),
  );

const stateFor = (target: StallTarget, id: string, observation: StallObservation): StallState => ({
  schema_version: ASSESSMENT_SCHEMA_VERSION,
  assessment_id: id,
  ticket: {
    number: target.ticket.number,
    title: target.ticket.title,
    acceptance_criteria: target.ticket.acceptanceCriteria,
  },
  worker: {
    session: target.worker.session,
    harness: target.worker.harness,
    model: target.worker.model,
    effort: target.worker.effort,
    status: target.worker.status,
    phase: target.worker.phase,
  },
  previous_observation: target.previous,
  current_observation: observation,
});

const toLoopError = (error: { issue: CliIssue }): StallLoopError => new StallLoopError(error.issue);

/**
 * Runs prepare, evaluate, and apply for one observation, then executes a
 * code-owned reprompt itself. `pause` and `retry-worker` are returned to the
 * caller, which parks or retries only this ticket.
 *
 * @param target - Worker, ticket, worktree, and previous observation.
 * @param actuator - Herdr actuator for pane reads and reprompts.
 * @param dependencies - Provider and clock dependencies for the assessment.
 * @returns An Effect containing the applied action and fresh observation.
 */
export const runStallCheck = (
  target: StallTarget,
  actuator: HerdrActuator,
  dependencies: StallAssessmentDependencies,
): Effect.Effect<StallCheck, StallLoopError> =>
  Effect.gen(function* () {
    const id = `${target.ticket.number}-stall-${target.sequence}`;
    const dir = join(target.runPath, "assessments", "stall");
    yield* Effect.promise(() => mkdir(dir, { recursive: true }));
    const paths = {
      state: join(dir, `${id}-state.json`),
      request: join(dir, `${id}-request.json`),
      evidence: join(dir, `${id}-evidence.json`),
      applyState: join(dir, `${id}-apply-state.json`),
    };
    const observation = yield* observeWorker(target, actuator, dependencies.now());
    yield* Effect.promise(() =>
      writeFile(paths.state, `${JSON.stringify(stateFor(target, id, observation), null, 2)}\n`, {
        flag: "wx",
      }),
    );
    yield* prepareStallAssessment(
      {
        runPath: target.runPath,
        statePath: paths.state,
        requestPath: paths.request,
        previousEvidencePath: undefined,
      },
      dependencies,
    ).pipe(Effect.mapError(toLoopError));
    yield* evaluateStallAssessment(
      { runPath: target.runPath, requestPath: paths.request, evidencePath: paths.evidence },
      dependencies,
    ).pipe(Effect.mapError(toLoopError));
    const recheck = yield* observeWorker(target, actuator, dependencies.now());
    yield* Effect.promise(() =>
      writeFile(
        paths.applyState,
        `${JSON.stringify(stateFor(target, id, { ...recheck, observed_at: observation.observed_at }), null, 2)}\n`,
        { flag: "wx" },
      ),
    );
    const applied = yield* applyStallAssessment({
      runPath: target.runPath,
      requestPath: paths.request,
      evidencePath: paths.evidence,
      statePath: paths.applyState,
    }).pipe(Effect.mapError(toLoopError));
    if (applied.action === "reprompt" && applied.prompt_argv !== null) {
      yield* actuator
        .deliverPrompt(target.worker.session, applied.prompt_argv[4]!)
        .pipe(Effect.mapError(toLoopError));
    }
    return {
      action: applied.action,
      reason: applied.reason,
      observation,
      evidencePath: paths.evidence,
    };
  });
