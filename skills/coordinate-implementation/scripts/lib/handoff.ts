import { Data, Effect, Either } from "effect";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  CliIssue,
  CoordinatorHandoffPrepareInput,
  CoordinatorHandoffReadyInput,
  CoordinatorHandoffRetryInput,
  CoordinatorHandoffVerifyInput,
  HerdrWorkerInput,
  RoleRecord,
} from "./contract.ts";
import { parseActiveRuntimeFields } from "./active-runtime.ts";
import {
  claimReadyCoordinator,
  readCoordinatorBinding,
  verifyCoordinator,
  type CoordinatorOwnership,
} from "./coordinator.ts";
import { buildHarnessLaunch, type HarnessLaunchPlan } from "./harness-launch.ts";
import { waitAnyWorker } from "./herdr.ts";
import { planInfrastructureRetry } from "./retry.ts";
import { checkSnapshot } from "./snapshot.ts";

const HANDOFF_THRESHOLD_PERCENT = 80;
const SAFE_PHASES = new Set(["waiting", "scheduling"]);

/**
 * Immutable predecessor binding stored in a coordinator launch artifact.
 */
export type HandoffPredecessor = {
  generation: number;
  pane: string;
  role: RoleRecord;
};

/**
 * Successful shell-free coordinator handoff preparation.
 */
export type CoordinatorHandoffPrepareResult = {
  recovered: boolean;
  artifact_path: string;
  attempt: number;
  max_retries: number;
  predecessor: HandoffPredecessor;
  successor_role: RoleRecord;
  launch: HarnessLaunchPlan;
};

/**
 * Retry decision for a failed coordinator successor launch.
 */
export type CoordinatorHandoffRetryResult = {
  attempt: number;
  retries_completed: number;
  max_retries: number;
  action: "retry" | "block";
  delay_ms: number;
  diagnostic: string;
  evidence_path: string;
  evidence_recovered: boolean;
  binding: {
    run_path: string;
    state_path: string;
    predecessor: HandoffPredecessor;
    successor_role: RoleRecord;
  };
};

/**
 * Successful successor readiness after snapshot validation and an armed wait cycle.
 */
export type CoordinatorHandoffReadyResult = {
  ownership: CoordinatorOwnership;
  snapshot_revision: string;
  wait_reason: "status" | "timeout";
  workers: Array<{
    runtime_id: string;
    ticket: string;
    session: string;
    pane_id: string;
    previous_pane_id: string;
    status: string;
  }>;
  marker: string;
};

/**
 * Exact predecessor close authorization after verified takeover.
 */
export type CoordinatorHandoffVerifyResult = {
  verified: true;
  ownership: CoordinatorOwnership;
  close_predecessor: true;
  close: HarnessLaunchPlan["start"];
};

type HandoffRetryEvidence = {
  schema_version: 1;
  kind: "coordinator-handoff-retry";
  artifact_path: string;
  artifact_sha256: string;
  diagnostic: string;
  decision: {
    attempt: number;
    retries_completed: number;
    max_retries: number;
    action: "retry" | "block";
    delay_ms: number;
  };
};

type HandoffArtifact = {
  schema_version: 1;
  kind: "coordinator-handoff";
  attempt: number;
  max_retries: number;
  run_path: string;
  state_path: string;
  predecessor: HandoffPredecessor;
  successor: {
    session: string;
    pane: string;
    role: RoleRecord;
  };
  context: {
    used: number;
    limit: number;
    threshold_percent: typeof HANDOFF_THRESHOLD_PERCENT;
  };
  launch: HarnessLaunchPlan;
};

/**
 * Typed automatic handoff preparation failure returned through the CLI.
 */
export class CoordinatorHandoffError extends Data.TaggedError("CoordinatorHandoffError")<{
  issue: CliIssue;
}> {}

const handoffError = (
  code: string,
  message: string,
  remediation: string,
): CoordinatorHandoffError =>
  new CoordinatorHandoffError({ issue: { code, message, remediation } });

const fromUnknown = (error: unknown, code: string, action: string): CoordinatorHandoffError => {
  if (error instanceof CoordinatorHandoffError) return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "issue" in error &&
    typeof error.issue === "object" &&
    error.issue !== null &&
    "code" in error.issue &&
    "message" in error.issue &&
    "remediation" in error.issue
  ) {
    return new CoordinatorHandoffError({ issue: error.issue as CliIssue });
  }
  return handoffError(
    code,
    `${action}: ${(error as Error).message}`,
    "Keep the predecessor open, inspect durable state and Herdr, then retry from a safe point.",
  );
};

const runIssueEffect = async <Result>(
  effect: Effect.Effect<Result, { issue: CliIssue }>,
): Promise<Result> => {
  const outcome = await Effect.runPromise(Effect.either(effect));
  if (Either.isLeft(outcome)) throw new CoordinatorHandoffError({ issue: outcome.left.issue });
  return outcome.right;
};

const sameRole = (left: RoleRecord, right: RoleRecord): boolean =>
  left.harness === right.harness && left.model === right.model && left.effort === right.effort;

const predecessorFromOwnership = (ownership: CoordinatorOwnership): HandoffPredecessor => ({
  generation: ownership.generation,
  pane: ownership.pane,
  role: {
    harness: ownership.harness,
    model: ownership.model,
    effort: ownership.effort,
  },
});

const canonicalPathAllowingMissing = async (path: string): Promise<string> => {
  let cursor = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      const existing = await realpath(cursor);
      return resolve(existing, ...missing);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(cursor.slice(parent.length + 1));
      cursor = parent;
    }
  }
};

const ensureArtifactInsideRun = async (
  runPath: string,
  statePath: string,
  artifactPath: string,
): Promise<void> => {
  const runRoot = await realpath(runPath);
  const state = await realpath(statePath);
  let canonicalState: string;
  try {
    canonicalState = await realpath(join(runRoot, "RESUME.md"));
  } catch {
    throw handoffError(
      "coordinator.run_mismatch",
      "Coordinator handoff requires the canonical RESUME.md inside run_path.",
      "Restore the accepted run's RESUME.md before preparing or resuming handoff.",
    );
  }
  if (state !== canonicalState || dirname(canonicalState) !== runRoot) {
    throw handoffError(
      "coordinator.run_mismatch",
      "Coordinator handoff state_path must be RESUME.md inside run_path.",
      "Use the accepted run directory and its canonical RESUME.md path.",
    );
  }
  const artifact = await canonicalPathAllowingMissing(artifactPath);
  const relation = relative(runRoot, artifact);
  if (
    relation === "" ||
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  ) {
    throw handoffError(
      "coordinator.artifact_outside_run",
      "Coordinator handoff artifact_path must resolve inside run_path.",
      "Choose a run-local path such as briefs/handoff-G-attempt-N.json.",
    );
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRole = (value: unknown): value is RoleRecord =>
  isRecord(value) &&
  (value.harness === "claude" || value.harness === "pi") &&
  typeof value.model === "string" &&
  value.model.length > 0 &&
  typeof value.effort === "string" &&
  value.effort.length > 0;

const isLaunchCommand = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.command === "string" &&
  Array.isArray(value.args) &&
  value.args.every((argument) => typeof argument === "string");

const isHandoffArtifact = (value: unknown): value is HandoffArtifact => {
  if (!isRecord(value) || !isRecord(value.predecessor) || !isRecord(value.successor)) {
    return false;
  }
  if (!isRecord(value.context) || !isRecord(value.launch)) return false;
  return (
    value.schema_version === 1 &&
    value.kind === "coordinator-handoff" &&
    Number.isInteger(value.attempt) &&
    (value.attempt as number) >= 1 &&
    (value.attempt as number) <= 4 &&
    value.max_retries === 3 &&
    typeof value.run_path === "string" &&
    typeof value.state_path === "string" &&
    Number.isInteger(value.predecessor.generation) &&
    (value.predecessor.generation as number) >= 0 &&
    typeof value.predecessor.pane === "string" &&
    isRole(value.predecessor.role) &&
    typeof value.successor.session === "string" &&
    typeof value.successor.pane === "string" &&
    isRole(value.successor.role) &&
    Number.isSafeInteger(value.context.used) &&
    Number.isSafeInteger(value.context.limit) &&
    (value.context.used as number) >= 0 &&
    (value.context.limit as number) > 0 &&
    value.context.threshold_percent === HANDOFF_THRESHOLD_PERCENT &&
    isLaunchCommand(value.launch.start) &&
    isLaunchCommand(value.launch.prompt)
  );
};

type LoadedHandoffArtifact = {
  artifact: HandoffArtifact;
  digest: string;
};

const readHandoffArtifact = async (path: string): Promise<LoadedHandoffArtifact> => {
  try {
    const serialized = await readFile(path, "utf8");
    const parsed = JSON.parse(serialized) as unknown;
    if (!isHandoffArtifact(parsed)) throw new Error("artifact fields are malformed");
    await ensureArtifactInsideRun(parsed.run_path, parsed.state_path, path);
    return {
      artifact: parsed,
      digest: `sha256:${createHash("sha256").update(serialized).digest("hex")}`,
    };
  } catch (error) {
    if (error instanceof CoordinatorHandoffError) throw error;
    throw handoffError(
      "coordinator.retry_artifact_invalid",
      `Could not validate the handoff artifact: ${(error as Error).message}`,
      "Keep the predecessor open and use only the run-local artifact emitted by handoff preparation.",
    );
  }
};

const validateRetryBinding = (
  previous: HandoffArtifact,
  input: CoordinatorHandoffPrepareInput,
  predecessor: HandoffPredecessor,
  successorRole: RoleRecord,
): void => {
  if (
    previous.attempt !== input.attempt - 1 ||
    previous.max_retries !== input.maxRetries ||
    previous.run_path !== input.runPath ||
    previous.state_path !== input.statePath ||
    previous.predecessor.generation !== predecessor.generation ||
    previous.predecessor.pane !== predecessor.pane ||
    !sameRole(previous.predecessor.role, predecessor.role) ||
    !sameRole(previous.successor.role, successorRole)
  ) {
    throw handoffError(
      "coordinator.retry_binding_changed",
      "The coordinator handoff retry does not match the preceding bound configuration.",
      "Retry with the same run, predecessor generation, and persisted Coordinator role.",
    );
  }
};

const immutableConflict = (
  code: string,
  subject: string,
  remediation: string,
): CoordinatorHandoffError =>
  handoffError(code, `Different ${subject} already exists at the immutable path.`, remediation);

const writeImmutableJson = async (
  path: string,
  value: unknown,
  conflict: CoordinatorHandoffError,
): Promise<boolean> => {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, serialized, { flag: "wx" });
  try {
    await link(temporary, path);
    return false;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    try {
      if ((await readFile(path, "utf8")) === serialized) return true;
    } catch (readError) {
      if (!(readError instanceof Error && "code" in readError && readError.code === "ENOENT")) {
        throw readError;
      }
    }
    throw conflict;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
};

const writeArtifact = (artifactPath: string, artifact: HandoffArtifact): Promise<boolean> =>
  writeImmutableJson(
    artifactPath,
    artifact,
    immutableConflict(
      "coordinator.artifact_conflict",
      "coordinator handoff artifact",
      "Inspect the existing artifact and continue the recorded attempt instead of overwriting it.",
    ),
  );

const workerStateError = (message: string): CoordinatorHandoffError =>
  handoffError(
    "coordinator.worker_state_malformed",
    message,
    "Repair the ticket table and active runtime blocks before attempting coordinator handoff.",
  );

const ticketStatuses = (markdown: string): Map<string, string> => {
  const heading = /^## Tickets\s*$/mu.exec(markdown);
  if (heading === null) throw workerStateError("RESUME.md has no `## Tickets` section.");
  const start = heading.index + heading[0].length;
  const nextSection = /^## /gmu;
  nextSection.lastIndex = start;
  const section = markdown.slice(start, nextSection.exec(markdown)?.index ?? markdown.length);
  const lines = section.split(/\r?\n/u);
  const headerIndex = lines.findIndex((line) => line.trimStart().startsWith("| NN"));
  if (headerIndex < 0) throw workerStateError("RESUME.md ticket table has no `NN` header row.");
  const columns = lines[headerIndex]!.split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
  const numberIndex = columns.indexOf("NN");
  const statusIndex = columns.indexOf("status");
  if (numberIndex < 0 || statusIndex < 0) {
    throw workerStateError("RESUME.md ticket table is missing its `NN` or `status` column.");
  }
  const statuses = new Map<string, string>();
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.trimStart().startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length !== columns.length) {
      throw workerStateError("RESUME.md contains a malformed ticket table row.");
    }
    const ticket = cells[numberIndex]!;
    const status = cells[statusIndex]!;
    if (!/^\d+$/u.test(ticket) || statuses.has(ticket)) {
      throw workerStateError(`Ticket row \`${ticket}\` is malformed or duplicated.`);
    }
    if (!new Set(["queued", "working", "review", "fixing", "blocked", "landed"]).has(status)) {
      throw workerStateError(`Ticket \`${ticket}\` has unsupported status \`${status}\`.`);
    }
    statuses.set(ticket, status);
  }
  return statuses;
};

type ActiveWorker = HerdrWorkerInput & { attempt: number };

const activeWorkers = (markdown: string): ActiveWorker[] => {
  const statuses = ticketStatuses(markdown);
  const heading = /^## Active tickets\s*$/mu.exec(markdown);
  const workers: ActiveWorker[] = [];
  const tickets = new Set<string>();
  const runtimeIds = new Set<string>();
  const sessions = new Set<string>();
  const panes = new Set<string>();
  if (heading !== null) {
    const start = heading.index + heading[0].length;
    const nextSection = /^## /gmu;
    nextSection.lastIndex = start;
    const end = nextSection.exec(markdown)?.index ?? markdown.length;
    const section = markdown.slice(start, end);
    const headings = [...section.matchAll(/^### (\d+)\s*$/gmu)];
    for (const [index, match] of headings.entries()) {
      const ticket = match[1]!;
      const absoluteStart = start + match.index;
      const absoluteEnd = index + 1 < headings.length ? start + headings[index + 1]!.index : end;
      const fields = parseActiveRuntimeFields(markdown.slice(absoluteStart, absoluteEnd));
      const attempt = Number(fields.Attempt);
      if (
        fields.Session === undefined ||
        fields.Pane === undefined ||
        !/^[A-Za-z0-9_-]+:p[A-Za-z0-9_-]+$/u.test(fields.Pane) ||
        !Number.isInteger(attempt) ||
        attempt < 1 ||
        attempt > 4
      ) {
        throw workerStateError(
          `Active runtime \`${ticket}\` lacks a valid Session, Pane, or one-based Attempt binding.`,
        );
      }
      const status = statuses.get(ticket);
      if (
        status === undefined ||
        !new Set(["working", "review", "fixing", "blocked"]).has(status)
      ) {
        throw workerStateError(
          `Active runtime \`${ticket}\` does not match an active ticket-table status.`,
        );
      }
      const runtimeId = `${fields.Session}-attempt-${attempt}`;
      if (
        tickets.has(ticket) ||
        runtimeIds.has(runtimeId) ||
        sessions.has(fields.Session) ||
        panes.has(fields.Pane)
      ) {
        throw workerStateError(
          `Active runtime \`${ticket}\` duplicates a durable worker identity.`,
        );
      }
      tickets.add(ticket);
      runtimeIds.add(runtimeId);
      sessions.add(fields.Session);
      panes.add(fields.Pane);
      workers.push({
        runtimeId,
        ticket,
        session: fields.Session,
        paneId: fields.Pane,
        attempt,
      });
    }
  }
  for (const [ticket, status] of statuses) {
    if (new Set(["working", "review", "fixing"]).has(status) && !tickets.has(ticket)) {
      throw workerStateError(`Active ticket \`${ticket}\` has no matching runtime block.`);
    }
  }
  return workers;
};

const buildSuccessorLaunch = (
  runPath: string,
  role: RoleRecord,
  predecessor: HandoffPredecessor,
  session: string,
  pane: string,
): HarnessLaunchPlan => {
  const promptPrefix =
    role.harness === "pi" ? "/skill:coordinate-implementation" : "/coordinate-implementation";
  const prompt = `${promptPrefix} resume ${runPath}. Refresh active runtime bindings, validate schema and snapshot hashes, then claim coordinator generation ${predecessor.generation + 1} from pane ${predecessor.pane} for successor pane ${pane}. Arm herdr.wait_any before declaring readiness.`;
  return buildHarnessLaunch({ role, session, pane, prompt, skillPath: undefined });
};

const validatePreparedBinding = (
  artifact: HandoffArtifact,
  role: RoleRecord,
  ownership: CoordinatorOwnership,
): void => {
  const predecessor = predecessorFromOwnership(ownership);
  const expectedLaunch = buildSuccessorLaunch(
    artifact.run_path,
    role,
    predecessor,
    artifact.successor.session,
    artifact.successor.pane,
  );
  if (
    ownership.readiness !== "ready" ||
    artifact.predecessor.generation !== predecessor.generation ||
    artifact.predecessor.pane !== predecessor.pane ||
    !sameRole(artifact.predecessor.role, predecessor.role) ||
    !sameRole(artifact.successor.role, role) ||
    BigInt(artifact.context.used) * 5n < BigInt(artifact.context.limit) * 4n ||
    JSON.stringify(artifact.launch) !== JSON.stringify(expectedLaunch)
  ) {
    throw handoffError(
      "coordinator.artifact_binding_changed",
      "The handoff artifact does not match the ready predecessor and persisted Coordinator role.",
      "Keep the predecessor open and prepare a new run-local artifact from current state.",
    );
  }
};

/**
 * Prepares one safe coordinator successor without changing durable ownership.
 *
 * @param input - Run paths, predecessor observation, successor identity, and retry attempt.
 * @returns An Effect containing an inspectable artifact and shell-free launch arrays.
 */
export const prepareCoordinatorHandoff = (
  input: CoordinatorHandoffPrepareInput,
): Effect.Effect<CoordinatorHandoffPrepareResult, CoordinatorHandoffError> =>
  Effect.tryPromise({
    try: async () => {
      if (!SAFE_PHASES.has(input.phase)) {
        throw handoffError(
          "coordinator.handoff_unsafe",
          `Coordinator handoff is deferred while phase is \`${input.phase}\`.`,
          "Finish synchronization, review, fixing, or landing, then retry at the next safe point.",
        );
      }
      await ensureArtifactInsideRun(input.runPath, input.statePath, input.artifactPath);
      if (input.previousArtifactPath !== undefined) {
        await ensureArtifactInsideRun(input.runPath, input.statePath, input.previousArtifactPath);
      }
      const binding = await runIssueEffect(readCoordinatorBinding(input.statePath));
      if (binding.ownership.readiness !== "ready") {
        throw handoffError(
          "coordinator.predecessor_not_ready",
          "The current coordinator ownership record is not ready for a successor launch.",
          "Keep the current pane open and recover the existing ownership transition first.",
        );
      }
      if (binding.ownership.pane === input.successorPane) {
        throw handoffError(
          "coordinator.same_pane",
          `Pane \`${input.successorPane}\` already owns this run; handoff is unnecessary.`,
          "Continue in the current pane without launching a successor.",
        );
      }
      const predecessor = predecessorFromOwnership(binding.ownership);
      const observed = await runIssueEffect(
        waitAnyWorker({
          socketPath: input.socketPath,
          timeoutMs: input.timeoutMs,
          workers: [],
          coordinator: {
            session: input.predecessorSession,
            paneId: predecessor.pane,
            phase: input.phase,
          },
        }),
      );
      if (
        observed.reason !== "handoff" ||
        observed.coordinator === null ||
        observed.coordinator === undefined ||
        observed.coordinator.handoff !== "required"
      ) {
        throw handoffError(
          "coordinator.handoff_below_threshold",
          `Coordinator context utilization is below the exact ${HANDOFF_THRESHOLD_PERCENT} percent threshold.`,
          "Continue the event wait cycle until normalized Herdr context reaches 80 percent.",
        );
      }
      if (observed.coordinator.pane_id !== predecessor.pane) {
        throw handoffError(
          "coordinator.predecessor_pane_changed",
          "The predecessor pane changed before handoff preparation could bind it.",
          "Refresh durable coordinator ownership from Herdr before preparing the successor.",
        );
      }
      const currentBinding = await runIssueEffect(readCoordinatorBinding(input.statePath));
      if (
        currentBinding.ownership.readiness !== "ready" ||
        currentBinding.ownership.generation !== predecessor.generation ||
        currentBinding.ownership.pane !== predecessor.pane ||
        !sameRole(currentBinding.ownership, predecessor.role) ||
        !sameRole(currentBinding.role, binding.role)
      ) {
        throw handoffError(
          "coordinator.predecessor_changed",
          "Coordinator ownership or the selected successor role changed during preparation.",
          "Discard this attempt and prepare again from the current ready predecessor.",
        );
      }
      if (input.previousArtifactPath !== undefined) {
        validateRetryBinding(
          (await readHandoffArtifact(input.previousArtifactPath)).artifact,
          input,
          predecessor,
          binding.role,
        );
      }
      const launch = buildSuccessorLaunch(
        input.runPath,
        binding.role,
        predecessor,
        input.session,
        input.successorPane,
      );
      const artifact: HandoffArtifact = {
        schema_version: 1,
        kind: "coordinator-handoff",
        attempt: input.attempt,
        max_retries: input.maxRetries,
        run_path: input.runPath,
        state_path: input.statePath,
        predecessor,
        successor: {
          session: input.session,
          pane: input.successorPane,
          role: binding.role,
        },
        context: {
          used: observed.coordinator.context_used,
          limit: observed.coordinator.context_limit,
          threshold_percent: HANDOFF_THRESHOLD_PERCENT,
        },
        launch,
      };
      const recovered = await writeArtifact(input.artifactPath, artifact);
      return {
        recovered,
        artifact_path: input.artifactPath,
        attempt: input.attempt,
        max_retries: input.maxRetries,
        predecessor,
        successor_role: binding.role,
        launch,
      };
    },
    catch: (error) =>
      error instanceof CoordinatorHandoffError
        ? error
        : handoffError(
            "coordinator.handoff_prepare_failed",
            `Could not prepare coordinator handoff: ${(error as Error).message}`,
            "Keep the predecessor open, inspect the run state and artifact path, then retry.",
          ),
  });

/**
 * Applies the shared bounded retry policy while preserving predecessor ownership.
 *
 * @param input - Failed launch artifact and exact observed diagnostic.
 * @returns An Effect containing the delay or exhausted action and immutable binding.
 */
export const retryCoordinatorHandoff = (
  input: CoordinatorHandoffRetryInput,
): Effect.Effect<CoordinatorHandoffRetryResult, CoordinatorHandoffError> =>
  Effect.tryPromise({
    try: async () => {
      const { artifact, digest } = await readHandoffArtifact(input.artifactPath);
      const binding = await runIssueEffect(readCoordinatorBinding(artifact.state_path));
      validatePreparedBinding(artifact, binding.role, binding.ownership);
      const retriesCompleted = artifact.attempt - 1;
      const decision = planInfrastructureRetry(retriesCompleted);
      const evidencePath = `${input.artifactPath}.retry.json`;
      await ensureArtifactInsideRun(artifact.run_path, artifact.state_path, evidencePath);
      const evidence: HandoffRetryEvidence = {
        schema_version: 1,
        kind: "coordinator-handoff-retry",
        artifact_path: input.artifactPath,
        artifact_sha256: digest,
        diagnostic: input.diagnostic,
        decision: {
          attempt: artifact.attempt,
          retries_completed: retriesCompleted,
          max_retries: artifact.max_retries,
          action: decision.action,
          delay_ms: decision.delay_ms,
        },
      };
      const evidenceRecovered = await writeImmutableJson(
        evidencePath,
        evidence,
        immutableConflict(
          "coordinator.retry_evidence_conflict",
          "coordinator retry evidence",
          "Keep the existing evidence and investigate the changed diagnostic or retry decision.",
        ),
      );
      return {
        attempt: artifact.attempt,
        retries_completed: retriesCompleted,
        max_retries: artifact.max_retries,
        action: decision.action,
        delay_ms: decision.delay_ms,
        diagnostic: input.diagnostic,
        evidence_path: evidencePath,
        evidence_recovered: evidenceRecovered,
        binding: {
          run_path: artifact.run_path,
          state_path: artifact.state_path,
          predecessor: artifact.predecessor,
          successor_role: artifact.successor.role,
        },
      };
    },
    catch: (error) =>
      error instanceof CoordinatorHandoffError
        ? error
        : handoffError(
            "coordinator.handoff_retry_failed",
            `Could not plan the coordinator handoff retry: ${(error as Error).message}`,
            "Keep the predecessor open and retry only from a valid launch artifact.",
          ),
  });

/**
 * Validates recovery, arms wait-any, refreshes workers, and marks the claimant ready.
 *
 * @param input - Successful launch artifact, Herdr socket, timeout, and project authority.
 * @returns An Effect containing durable readiness and the complete refreshed worker snapshot.
 */
export const readyCoordinatorHandoff = (
  input: CoordinatorHandoffReadyInput,
): Effect.Effect<CoordinatorHandoffReadyResult, CoordinatorHandoffError> =>
  Effect.tryPromise({
    try: async () => {
      const { artifact, digest } = await readHandoffArtifact(input.artifactPath);
      const binding = await runIssueEffect(readCoordinatorBinding(artifact.state_path));
      validatePreparedBinding(artifact, binding.role, binding.ownership);
      const snapshot = await runIssueEffect(
        checkSnapshot({
          runPath: artifact.run_path,
          statePath: artifact.state_path,
          writeback: undefined,
          projectRemoteWrites: input.projectRemoteWrites,
          acceptedAt: undefined,
        }),
      );
      if (snapshot.status !== "unchanged" || !snapshot.scheduling_allowed) {
        throw handoffError(
          "coordinator.snapshot_changed",
          `Successor readiness is blocked because snapshot status is \`${snapshot.status}\`.`,
          "Keep the predecessor open and explicitly accept the changed snapshot before a new handoff.",
        );
      }
      const markdown = await readFile(artifact.state_path, "utf8");
      const workers = activeWorkers(markdown);
      const wait = await runIssueEffect(
        waitAnyWorker({
          socketPath: input.socketPath,
          timeoutMs: input.timeoutMs,
          workers,
          coordinator: {
            session: artifact.successor.session,
            paneId: artifact.successor.pane,
            phase: "waiting",
          },
        }),
      );
      const missing = wait.workers.find((worker) => worker.status === "exited");
      if (missing !== undefined) {
        throw handoffError(
          "coordinator.worker_missing",
          `Active runtime \`${missing.runtime_id}\` is missing from the Herdr snapshot.`,
          "Keep the predecessor open, repair the worker binding, and restart handoff.",
        );
      }
      if (wait.reason === "pane_exited") {
        throw handoffError(
          "coordinator.worker_missing",
          "An active runtime pane exited while the successor armed its wait cycle.",
          "Keep the predecessor open, repair the worker binding, and restart handoff.",
        );
      }
      if (wait.reason === "handoff") {
        throw handoffError(
          "coordinator.successor_context_exhausted",
          "The successor already meets the 80 percent handoff threshold.",
          "Keep the predecessor open and launch a fresh successor with the same bound role.",
        );
      }
      if (wait.coordinator?.pane_id !== artifact.successor.pane) {
        throw handoffError(
          "coordinator.successor_pane_changed",
          "The successor pane identity changed before readiness could be recorded.",
          "Keep the predecessor open and restart the claim with the refreshed successor pane.",
        );
      }
      const initialWorkers = new Map(workers.map((worker) => [worker.runtimeId, worker]));
      const refreshedWorkers = wait.workers.map((worker) => {
        const initial = initialWorkers.get(worker.runtime_id);
        if (initial === undefined) {
          throw handoffError(
            "coordinator.worker_state_changed",
            `Active runtime \`${worker.runtime_id}\` was not present before the wait cycle.`,
            "Keep the predecessor open and restart handoff from a fresh active-worker snapshot.",
          );
        }
        return {
          ticket: worker.ticket,
          session: worker.session,
          attempt: initial.attempt,
          previousPane: worker.previous_pane_id,
          pane: worker.pane_id,
        };
      });
      const ownership = await runIssueEffect(
        claimReadyCoordinator(
          {
            statePath: artifact.state_path,
            expectedGeneration: artifact.predecessor.generation,
            expectedPredecessorPane: artifact.predecessor.pane,
            expectedPredecessorRole: artifact.predecessor.role,
            successorPane: artifact.successor.pane,
            successorRole: artifact.successor.role,
            artifactSha256: digest,
          },
          refreshedWorkers,
        ),
      );
      return {
        ownership,
        snapshot_revision: snapshot.revision,
        wait_reason: wait.reason,
        workers: wait.workers,
        marker: ownership.marker,
      };
    },
    catch: (error) =>
      fromUnknown(
        error,
        "coordinator.handoff_ready_failed",
        "Could not establish successor readiness",
      ),
  });

/**
 * Verifies observed readiness and returns the only permitted predecessor close command.
 *
 * @param input - Launch artifact and marker independently observed in the successor pane.
 * @returns An Effect containing verified ownership and exact close arguments.
 */
export const verifyCoordinatorHandoff = (
  input: CoordinatorHandoffVerifyInput,
): Effect.Effect<CoordinatorHandoffVerifyResult, CoordinatorHandoffError> =>
  Effect.tryPromise({
    try: async () => {
      const { artifact, digest } = await readHandoffArtifact(input.artifactPath);
      const verified = await runIssueEffect(
        verifyCoordinator({
          statePath: artifact.state_path,
          generation: artifact.predecessor.generation + 1,
          pane: artifact.successor.pane,
          observedMarker: input.observedMarker,
        }),
      );
      if (
        !sameRole(verified.ownership, artifact.successor.role) ||
        verified.ownership.predecessor_pane !== artifact.predecessor.pane ||
        verified.ownership.handoff_artifact_sha256 !== digest
      ) {
        throw handoffError(
          "coordinator.verify_artifact_mismatch",
          "Verified ownership does not match the prepared handoff artifact.",
          "Keep the predecessor open and inspect the durable artifact binding before continuing.",
        );
      }
      return {
        verified: true,
        ownership: verified.ownership,
        close_predecessor: true,
        close: {
          command: "herdr",
          args: ["pane", "close", artifact.predecessor.pane],
        },
      };
    },
    catch: (error) =>
      fromUnknown(
        error,
        "coordinator.handoff_verify_failed",
        "Could not verify coordinator takeover",
      ),
  });
