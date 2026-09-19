import { Data, Effect } from "effect";

/**
 * JSON schema version supported by the coordinate helper request and result envelopes.
 */
export const CONTRACT_SCHEMA_VERSION = 1 as const;

/**
 * Operations currently exposed through the coordinate helper CLI.
 */
export type CoordinateOperation =
  | "preflight"
  | "state.validate"
  | "roles.discover"
  | "role.validate"
  | "coordinator.claim"
  | "coordinator.ready"
  | "coordinator.verify"
  | "coordinator.handoff.prepare"
  | "coordinator.handoff.retry"
  | "coordinator.handoff.ready"
  | "coordinator.handoff.verify"
  | "snapshot.check"
  | "snapshot.accept"
  | "worktree.preflight"
  | "worktree.prepare"
  | "implementor.launch.prepare"
  | "implementor.launch.record"
  | "scheduler.plan"
  | "herdr.wait_any"
  | "infrastructure.retry.record"
  | "review.policy.prepare"
  | "review.launch.prepare"
  | "review.launch.record"
  | "gate.record"
  | "review.round.finalize"
  | "landing.synchronize"
  | "landing.conflict.record"
  | "landing.complete"
  | "run.finalize";

/**
 * Harnesses supported for coordinator, implementor, and reviewer sessions.
 */
export type HarnessName = "claude" | "pi";

/**
 * Durable role names configured for an implementation run.
 */
export type RoleName = "coordinator" | "implementor" | "reviewer";

/**
 * Fully resolved harness configuration persisted for one run role.
 */
export type RoleRecord = {
  harness: HarnessName;
  model: string;
  effort: string;
};

/**
 * Normalized input for a capability preflight request.
 */
export type PreflightInput = {
  statePath: string | undefined;
  skillRoots: string[] | undefined;
};

/**
 * Normalized input for a run-state validation request.
 */
export type StateValidateInput = {
  statePath: string;
};

/**
 * Tracker writeback modes persisted with an accepted snapshot.
 */
export type WritebackMode = "none" | "final" | "live";

/**
 * Project authority governing whether the coordinator may write remotely.
 */
export type ProjectRemoteWrites = "allowed" | "forbidden";

/**
 * Normalized input shared by snapshot integrity operations.
 */
export type SnapshotInput = {
  runPath: string;
  statePath: string;
  writeback: WritebackMode | undefined;
  projectRemoteWrites: ProjectRemoteWrites;
  acceptedAt: string | undefined;
};

/**
 * Input for discovering installed role configuration choices.
 */
export type RolesDiscoverInput = Record<string, unknown>;

/**
 * Input for validating one explicit or interactively assembled role record.
 */
export type RoleValidateInput = {
  role: RoleName;
  triple: string | undefined;
  record: RoleRecord | undefined;
};

/**
 * Input for atomically claiming coordinator ownership from a predecessor.
 */
export type CoordinatorClaimInput = {
  statePath: string;
  expectedGeneration: number;
  expectedPredecessorPane: string;
  expectedPredecessorRole: RoleRecord;
  successorPane: string;
  successorRole: RoleRecord;
};

/**
 * Input for marking a claimed coordinator generation ready.
 */
export type CoordinatorReadyInput = {
  statePath: string;
  generation: number;
  pane: string;
  marker: string;
};

/**
 * Input for verifying state readiness against a marker observed in Herdr.
 */
export type CoordinatorVerifyInput = {
  statePath: string;
  generation: number;
  pane: string;
  observedMarker: string;
};

/**
 * Input for safely preparing one automatic coordinator handoff attempt.
 */
export type CoordinatorHandoffPrepareInput = {
  statePath: string;
  runPath: string;
  artifactPath: string;
  session: string;
  successorPane: string;
  predecessorSession: string;
  socketPath: string;
  timeoutMs: number;
  phase: CoordinatorPhase;
  attempt: number;
  maxRetries: number;
  previousArtifactPath: string | undefined;
};

/**
 * Input for applying the shared retry policy to a failed coordinator successor.
 */
export type CoordinatorHandoffRetryInput = {
  artifactPath: string;
  diagnostic: string;
};

/**
 * Input for validating and arming a claimed successor before readiness.
 */
export type CoordinatorHandoffReadyInput = {
  artifactPath: string;
  socketPath: string;
  timeoutMs: number;
  projectRemoteWrites: ProjectRemoteWrites;
};

/**
 * Input for authorizing the predecessor close after observed readiness.
 */
export type CoordinatorHandoffVerifyInput = {
  artifactPath: string;
  observedMarker: string;
};

/**
 * Commit-shape defaults resolved from repository instructions.
 */
export type CommitPolicy = {
  commits: "multiple" | "single" | "squash";
  fixes: "append" | "amend" | "squash";
};

/**
 * Repository-directed worktree and Git policy persisted before creation.
 */
export type RepositoryPolicy = {
  instructionFiles: string[];
  worktree: {
    kind: "native" | "repository";
    tool: string;
    root: string | undefined;
    createArgv: string[] | undefined;
  };
  branchNaming: string;
  setupArgvs: string[][];
  cleanup: "native-safe" | "repository";
  remote: "local-only" | "repository";
  remoteSyncArgv: string[] | undefined;
  commit: CommitPolicy;
};

/**
 * Input for checking repository worktree policy before creating state.
 */
export type WorktreePreflightInput = {
  policy: RepositoryPolicy;
};

/**
 * Input for preparing one policy-compliant ticket worktree.
 */
export type WorktreePrepareInput = {
  statePath: string;
  repositoryPath: string;
  baseBranch: string;
  branch: string;
  worktreeName: string;
  expectedWorktreePath: string | undefined;
  policy: RepositoryPolicy;
};

/**
 * Input for constructing and persisting one implementor launch plan.
 */
export type ImplementorLaunchPrepareInput = {
  statePath: string;
  artifactPath: string;
  ticket: string;
  worktreePath: string;
  branch: string;
  session: string;
  tab: string;
  pane: string;
  role: RoleRecord;
  implementSkillPath: string | undefined;
  prompt: string;
  attempt: number;
  maxAttempts: number;
};

/**
 * Exact diagnostic captured from one failed launch stage.
 */
export type LaunchDiagnostic = {
  stage: string;
  exitCode: number;
  stderr: string;
};

/**
 * Input for persisting the observed outcome of a prepared implementor launch.
 */
export type ImplementorLaunchRecordInput = {
  statePath: string;
  ticket: string;
  attempt: number;
  status: "started" | "failed";
  diagnostic: LaunchDiagnostic | undefined;
};

/**
 * Durable ticket lifecycle states used by the bounded scheduler.
 */
export type SchedulerTicketStatus =
  | "queued"
  | "working"
  | "review"
  | "fixing"
  | "blocked"
  | "landed"
  | "closed";

/**
 * One normalized ticket supplied to a deterministic scheduling pass.
 */
export type SchedulerTicket = {
  number: string;
  dependencies: string[];
  status: SchedulerTicketStatus;
};

/**
 * One runtime considered by a deterministic scheduling pass.
 */
export type SchedulerRuntime = {
  runtimeId: string;
  ticket: string;
  role: "implementor" | "reviewer";
  state: "active" | "terminal";
};

/**
 * Input for selecting dependency-ready tickets within the implementation cap.
 */
export type SchedulerPlanInput = {
  mode: "parallel" | "serial";
  maxImplementors: number;
  tickets: SchedulerTicket[];
  runtimes: SchedulerRuntime[];
};

/**
 * One durable worker identity observed through Herdr.
 */
export type HerdrWorkerInput = {
  runtimeId: string;
  ticket: string;
  session: string;
  paneId: string;
};

/**
 * Coordinator phases used to defer context handoff during one atomic workflow action.
 */
export type CoordinatorPhase =
  | "waiting"
  | "scheduling"
  | "synchronizing"
  | "reviewing"
  | "fixing"
  | "landing";

/**
 * Current coordinator identity and phase observed by an event-driven wait.
 */
export type HerdrCoordinatorInput = {
  session: string;
  paneId: string;
  phase: CoordinatorPhase;
};

/**
 * Input for an event-driven wait over every active worker.
 */
export type HerdrWaitAnyInput = {
  socketPath: string;
  timeoutMs: number;
  workers: HerdrWorkerInput[];
  coordinator: HerdrCoordinatorInput | undefined;
};

/**
 * Infrastructure failure classes sharing the bounded retry policy.
 */
export type InfrastructureFailure = "worker" | "herdr" | "launch";

/**
 * Input for recording one infrastructure failure and planning its retry.
 */
export type InfrastructureRetryRecordInput = {
  statePath: string;
  ticket: string;
  attempt: number;
  failure: InfrastructureFailure;
  diagnostic: string;
};

/**
 * One exact repository gate command resolved from authoritative sources.
 */
export type GateCommand = {
  name: string;
  argv: string[];
};

/**
 * Input for persisting repository-derived gates and safety constraints.
 */
export type ReviewPolicyPrepareInput = {
  statePath: string;
  instructionFiles: string[];
  ciFiles: string[];
  gates: GateCommand[];
  noExecutableGates: boolean;
  safetyConstraints: string[];
  noAdditionalSafetyConstraints: boolean;
};

/**
 * Independent external review axes.
 */
export type ReviewAxis = "standards" | "spec";

/**
 * Input for constructing one fresh reviewer launch and mutation baseline.
 */
export type ReviewLaunchPrepareInput = {
  statePath: string;
  previousArtifactPath: string | undefined;
  artifactPath: string;
  reportPath: string;
  ticket: string;
  round: number;
  axis: ReviewAxis;
  worktreePath: string;
  branch: string;
  baseRef: string;
  pane: string;
  role: RoleRecord;
  contextPaths: string[];
  landedTickets: string[];
  gateEvidencePaths: string[];
  attempt: number;
};

/**
 * Input for persisting one completed or failed reviewer attempt.
 */
export type ReviewLaunchRecordInput = {
  statePath: string;
  artifactPath: string;
  status: "completed" | "infrastructure_failed";
  report: string | undefined;
  diagnostic: LaunchDiagnostic | undefined;
  completedAt: string;
};

/**
 * Input for persisting one repository gate attempt.
 */
export type GateRecordInput = {
  statePath: string;
  evidencePath: string;
  worktreePath: string;
  ticket: string;
  round: number;
  name: string;
  attempt: number;
  status: "passed" | "failed" | "infrastructure_failed";
  exitCode: number;
  stdout: string;
  stderr: string;
  completedAt: string;
};

/**
 * Input for combining two accepted review axes into one round outcome.
 */
export type ReviewRoundFinalizeInput = {
  statePath: string;
  ticket: string;
  round: number;
  standardsEvidencePath: string;
  specEvidencePath: string;
  selfReviewPath: string;
  selfReviewMethod: "matt-implement" | "standards-spec-single-session";
  selfReviewReport: string;
  fixRequestPath: string;
  completedAt: string;
};

/**
 * Input for claiming the serialized finalization slot and synchronizing one ticket.
 */
export type LandingSynchronizeInput = {
  statePath: string;
  repositoryPath: string;
  worktreePath: string;
  ticket: string;
  remoteSyncArgv: string[] | undefined;
  completedAt: string;
};

/**
 * Coordinator classification recorded after a conflicted synchronization is resolved.
 */
export type ConflictClassification = "textual" | "substantive" | "scope";

/**
 * Input for recording how a resolved synchronization conflict should continue.
 */
export type LandingConflictRecordInput = {
  statePath: string;
  ticket: string;
  classification: ConflictClassification;
  decision: string | undefined;
  userAuthorized: boolean;
  completedAt: string;
};

/**
 * Input for fast-forward landing, cleanup, and durable completion evidence.
 */
export type LandingCompleteInput = {
  statePath: string;
  repositoryPath: string;
  worktreePath: string;
  evidencePath: string;
  ticket: string;
  cleanupArgv: string[] | undefined;
  runtimeClosed: boolean;
  completedAt: string;
};

/**
 * One user-authorized blocked or dependency-blocked closure applied at run finalization.
 */
export type RunClosure = {
  ticket: string;
  reason: string;
};

/**
 * Input for evaluating terminal run state and writing its local summary.
 */
export type RunFinalizeInput = {
  runPath: string;
  statePath: string;
  summaryPath: string;
  closures: RunClosure[];
  userAuthorized: boolean;
  projectRemoteWrites: ProjectRemoteWrites;
  completedAt: string;
};

/**
 * A validated schema-version-1 request accepted by the helper.
 */
export type CoordinateRequest =
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "preflight";
      input: PreflightInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "state.validate";
      input: StateValidateInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "snapshot.check";
      input: SnapshotInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "snapshot.accept";
      input: SnapshotInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "roles.discover";
      input: RolesDiscoverInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "role.validate";
      input: RoleValidateInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "coordinator.claim";
      input: CoordinatorClaimInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "coordinator.ready";
      input: CoordinatorReadyInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "coordinator.verify";
      input: CoordinatorVerifyInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "coordinator.handoff.prepare";
      input: CoordinatorHandoffPrepareInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "coordinator.handoff.retry";
      input: CoordinatorHandoffRetryInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "coordinator.handoff.ready";
      input: CoordinatorHandoffReadyInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "coordinator.handoff.verify";
      input: CoordinatorHandoffVerifyInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "worktree.preflight";
      input: WorktreePreflightInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "worktree.prepare";
      input: WorktreePrepareInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "implementor.launch.prepare";
      input: ImplementorLaunchPrepareInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "implementor.launch.record";
      input: ImplementorLaunchRecordInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "scheduler.plan";
      input: SchedulerPlanInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "herdr.wait_any";
      input: HerdrWaitAnyInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "infrastructure.retry.record";
      input: InfrastructureRetryRecordInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "review.policy.prepare";
      input: ReviewPolicyPrepareInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "review.launch.prepare";
      input: ReviewLaunchPrepareInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "review.launch.record";
      input: ReviewLaunchRecordInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "gate.record";
      input: GateRecordInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "review.round.finalize";
      input: ReviewRoundFinalizeInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "landing.synchronize";
      input: LandingSynchronizeInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "landing.conflict.record";
      input: LandingConflictRecordInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "landing.complete";
      input: LandingCompleteInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "run.finalize";
      input: RunFinalizeInput;
    };

/**
 * One actionable problem returned in a CLI result envelope.
 */
export type CliIssue = {
  code: string;
  message: string;
  remediation: string;
};

/**
 * Stable JSON result envelope emitted by every helper operation.
 */
export type CoordinateResponse<Result> = {
  schema_version: typeof CONTRACT_SCHEMA_VERSION;
  operation: string | null;
  ok: boolean;
  result: Result | null;
  errors: CliIssue[];
};

/**
 * Typed failure raised when stdin does not contain a supported request.
 */
export class RequestError extends Data.TaggedError("RequestError")<{
  issue: CliIssue;
  operation: string | null;
}> {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Tests whether a value is a real UTC timestamp in whole-second ISO-8601 form.
 *
 * @param value - Candidate timestamp.
 * @returns True only when every calendar and clock component is valid.
 */
export const isUtcIsoTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value)) {
    return false;
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;
  return new Date(milliseconds).toISOString() === `${value.slice(0, -1)}.000Z`;
};

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const singleLineString = (value: unknown): string | undefined => {
  const string = nonEmptyString(value);
  return string !== undefined && !/[\r\n]/u.test(string) ? string : undefined;
};

const paneId = (value: unknown): string | undefined => {
  const string = singleLineString(value);
  return string !== undefined && /^[A-Za-z0-9_-]+:p[A-Za-z0-9_-]+$/u.test(string)
    ? string
    : undefined;
};

const nonNegativeInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

const stringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) &&
  value.every((item) => typeof item === "string" && item.length > 0 && !/[\r\n]/u.test(item))
    ? value
    : undefined;

const commandArrays = (value: unknown): string[][] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const commands = value.map(stringArray);
  return commands.every((command) => command !== undefined) ? (commands as string[][]) : undefined;
};

const parseRepositoryPolicy = (value: unknown): RepositoryPolicy | undefined => {
  if (!isRecord(value) || !isRecord(value.worktree)) return undefined;
  const instructionFiles = stringArray(value.instruction_files);
  const branchNaming = singleLineString(value.branch_naming);
  const setupArgvs = commandArrays(value.setup_argvs);
  const kind = value.worktree.kind;
  const rootValue = value.worktree.root;
  const createValue = value.worktree.create_argv;
  const remoteSyncValue = value.remote_sync_argv;
  const remoteSyncArgv = stringArray(remoteSyncValue);
  if (
    instructionFiles === undefined ||
    instructionFiles.length === 0 ||
    branchNaming === undefined ||
    setupArgvs === undefined ||
    (kind !== "native" && kind !== "repository") ||
    (value.cleanup !== "native-safe" && value.cleanup !== "repository") ||
    (value.remote !== "local-only" && value.remote !== "repository") ||
    (value.remote === "local-only" && remoteSyncValue !== null) ||
    (value.remote === "repository" && (remoteSyncArgv === undefined || remoteSyncArgv.length === 0))
  ) {
    return undefined;
  }

  const root = typeof rootValue === "string" && rootValue.length > 0 ? rootValue : undefined;
  const createArgv = stringArray(createValue);
  const toolValue = value.worktree.tool;
  if (kind === "native") {
    if (toolValue !== null || root === undefined || createValue !== null) return undefined;
  } else if (
    typeof toolValue !== "string" ||
    toolValue.length === 0 ||
    createArgv === undefined ||
    createArgv.length === 0
  ) {
    return undefined;
  }

  let commit: CommitPolicy;
  if (value.commit === null || value.commit === undefined) {
    commit = { commits: "multiple", fixes: "append" };
  } else {
    if (!isRecord(value.commit)) return undefined;
    const commits = value.commit.commits;
    const fixes = value.commit.fixes;
    if (
      (commits !== "multiple" && commits !== "single" && commits !== "squash") ||
      (fixes !== "append" && fixes !== "amend" && fixes !== "squash")
    ) {
      return undefined;
    }
    commit = { commits, fixes };
  }

  return {
    instructionFiles,
    worktree: {
      kind,
      tool: kind === "native" ? "git" : (toolValue as string),
      root,
      createArgv: kind === "native" ? undefined : createArgv,
    },
    branchNaming,
    setupArgvs,
    cleanup: value.cleanup,
    remote: value.remote,
    remoteSyncArgv: value.remote === "repository" ? remoteSyncArgv : undefined,
    commit,
  };
};

const parseRoleRecord = (value: unknown): RoleRecord | undefined => {
  if (!isRecord(value)) return undefined;
  if (value.harness !== "claude" && value.harness !== "pi") return undefined;
  const model = singleLineString(value.model);
  const effort = singleLineString(value.effort);
  if (model === undefined || effort === undefined) return undefined;
  return { harness: value.harness, model, effort };
};

const ticketNumber = (value: unknown): string | undefined => {
  const number = singleLineString(value);
  return number !== undefined && /^\d+$/u.test(number) ? number : undefined;
};

const parseSchedulerTickets = (value: unknown): SchedulerTicket[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const tickets: SchedulerTicket[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) return undefined;
    const number = ticketNumber(candidate.number);
    const dependencies = stringArray(candidate.dependencies);
    const status = candidate.status;
    if (
      number === undefined ||
      dependencies === undefined ||
      !dependencies.every((dependency) => /^\d+$/u.test(dependency)) ||
      (status !== "queued" &&
        status !== "working" &&
        status !== "review" &&
        status !== "fixing" &&
        status !== "blocked" &&
        status !== "landed" &&
        status !== "closed")
    ) {
      return undefined;
    }
    tickets.push({ number, dependencies, status });
  }
  return tickets;
};

const parseSchedulerRuntimes = (value: unknown): SchedulerRuntime[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const runtimes: SchedulerRuntime[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) return undefined;
    const runtimeId = singleLineString(candidate.runtime_id);
    const ticket = ticketNumber(candidate.ticket);
    if (
      runtimeId === undefined ||
      ticket === undefined ||
      (candidate.role !== "implementor" && candidate.role !== "reviewer") ||
      (candidate.state !== "active" && candidate.state !== "terminal")
    ) {
      return undefined;
    }
    runtimes.push({ runtimeId, ticket, role: candidate.role, state: candidate.state });
  }
  return runtimes;
};

const parseHerdrWorkers = (value: unknown): HerdrWorkerInput[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const workers: HerdrWorkerInput[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) return undefined;
    const runtimeId = singleLineString(candidate.runtime_id);
    const ticket = ticketNumber(candidate.ticket);
    const session = singleLineString(candidate.session);
    const workerPane = paneId(candidate.pane_id);
    if (
      runtimeId === undefined ||
      ticket === undefined ||
      session === undefined ||
      workerPane === undefined
    ) {
      return undefined;
    }
    workers.push({ runtimeId, ticket, session, paneId: workerPane });
  }
  return workers;
};

const parseHerdrCoordinator = (value: unknown): HerdrCoordinatorInput | undefined => {
  if (!isRecord(value)) return undefined;
  const session = singleLineString(value.session);
  const coordinatorPane = paneId(value.pane_id);
  const phase = value.phase;
  if (
    session === undefined ||
    coordinatorPane === undefined ||
    (phase !== "waiting" &&
      phase !== "scheduling" &&
      phase !== "synchronizing" &&
      phase !== "reviewing" &&
      phase !== "fixing" &&
      phase !== "landing")
  ) {
    return undefined;
  }
  return { session, paneId: coordinatorPane, phase };
};

const firstDuplicate = (values: string[]): string | undefined => {
  const observed = new Set<string>();
  for (const value of values) {
    if (observed.has(value)) return value;
    observed.add(value);
  }
  return undefined;
};

const invalidRequest = (message: string, operation: string | null): RequestError =>
  new RequestError({
    operation,
    issue: {
      code: "request.invalid",
      message,
      remediation: "Send one JSON request matching the documented schema-version-1 contract.",
    },
  });

/**
 * Parses and validates one JSON request read from stdin.
 *
 * @param raw - Complete stdin text for a single invocation.
 * @returns An Effect containing a normalized request or a typed request error.
 */
export const parseRequest = (raw: string): Effect.Effect<CoordinateRequest, RequestError> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: () => invalidRequest("Request stdin is not valid JSON.", null),
    });
    if (!isRecord(parsed)) {
      return yield* invalidRequest("Request JSON must be an object.", null);
    }

    const operation = typeof parsed.operation === "string" ? parsed.operation : null;
    if (parsed.schema_version !== CONTRACT_SCHEMA_VERSION) {
      const received =
        typeof parsed.schema_version === "number"
          ? String(parsed.schema_version)
          : JSON.stringify(parsed.schema_version);
      return yield* new RequestError({
        operation,
        issue: {
          code: "request.schema_unsupported",
          message: `Unsupported request schema version ${received}; this helper supports version 1.`,
          remediation: "Invoke the helper with a schema-version-1 request.",
        },
      });
    }
    const operations: CoordinateOperation[] = [
      "preflight",
      "state.validate",
      "roles.discover",
      "role.validate",
      "coordinator.claim",
      "coordinator.ready",
      "coordinator.verify",
      "coordinator.handoff.prepare",
      "coordinator.handoff.retry",
      "coordinator.handoff.ready",
      "coordinator.handoff.verify",
      "snapshot.check",
      "snapshot.accept",
      "worktree.preflight",
      "worktree.prepare",
      "implementor.launch.prepare",
      "implementor.launch.record",
      "scheduler.plan",
      "herdr.wait_any",
      "infrastructure.retry.record",
      "review.policy.prepare",
      "review.launch.prepare",
      "review.launch.record",
      "gate.record",
      "review.round.finalize",
      "landing.synchronize",
      "landing.conflict.record",
      "landing.complete",
      "run.finalize",
    ];
    if (operation === null || !operations.includes(operation as CoordinateOperation)) {
      return yield* invalidRequest(
        `Request \`operation\` must be one of: ${operations.join(", ")}.`,
        operation,
      );
    }
    if (!isRecord(parsed.input)) {
      return yield* invalidRequest("Request `input` must be an object.", operation);
    }

    if (operation === "run.finalize") {
      const runPath = nonEmptyString(parsed.input.run_path);
      const statePath = nonEmptyString(parsed.input.state_path);
      const summaryPath = nonEmptyString(parsed.input.summary_path);
      const closuresValue = parsed.input.closures;
      const closureCount = Array.isArray(closuresValue) ? closuresValue.length : -1;
      const closures = Array.isArray(closuresValue)
        ? closuresValue.flatMap((closure) => {
            if (!isRecord(closure)) return [];
            const ticket = ticketNumber(closure.ticket);
            const reason = singleLineString(closure.reason);
            return ticket === undefined || reason === undefined ? [] : [{ ticket, reason }];
          })
        : undefined;
      const userAuthorized = parsed.input.user_authorized;
      const projectRemoteWrites = parsed.input.project_remote_writes;
      const completedAt = parsed.input.completed_at;
      if (
        runPath === undefined ||
        statePath === undefined ||
        summaryPath === undefined ||
        closures === undefined ||
        closures.length !== closureCount ||
        typeof userAuthorized !== "boolean" ||
        (projectRemoteWrites !== "allowed" && projectRemoteWrites !== "forbidden") ||
        !isUtcIsoTimestamp(completedAt)
      ) {
        return yield* invalidRequest(
          "`run.finalize` requires run_path, state_path, summary_path, valid closures, boolean user_authorized, project_remote_writes, and completed_at.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: {
          runPath,
          statePath,
          summaryPath,
          closures,
          userAuthorized,
          projectRemoteWrites,
          completedAt,
        },
      };
    }

    if (operation === "state.validate") {
      if (typeof parsed.input.state_path !== "string" || parsed.input.state_path.length === 0) {
        return yield* invalidRequest(
          "`state.validate` requires a non-empty `input.state_path` string.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: { statePath: parsed.input.state_path },
      };
    }

    if (operation === "snapshot.check" || operation === "snapshot.accept") {
      if (typeof parsed.input.run_path !== "string" || parsed.input.run_path.length === 0) {
        return yield* invalidRequest(
          `\`${operation}\` requires a non-empty \`input.run_path\` string.`,
          operation,
        );
      }
      if (typeof parsed.input.state_path !== "string" || parsed.input.state_path.length === 0) {
        return yield* invalidRequest(
          `\`${operation}\` requires a non-empty \`input.state_path\` string.`,
          operation,
        );
      }
      const writeback = parsed.input.writeback;
      if (
        writeback !== undefined &&
        writeback !== null &&
        writeback !== "none" &&
        writeback !== "final" &&
        writeback !== "live"
      ) {
        return yield* invalidRequest(
          "Snapshot input.writeback must be `none`, `final`, `live`, or null.",
          operation,
        );
      }
      if (
        parsed.input.project_remote_writes !== "allowed" &&
        parsed.input.project_remote_writes !== "forbidden"
      ) {
        return yield* invalidRequest(
          "Snapshot input.project_remote_writes must be `allowed` or `forbidden`.",
          operation,
        );
      }
      if (operation === "snapshot.check" && writeback !== undefined && writeback !== null) {
        return yield* invalidRequest(
          "`snapshot.check` does not accept a writeback change; use `snapshot.accept`.",
          operation,
        );
      }
      const acceptedAt = parsed.input.accepted_at;
      if (operation === "snapshot.accept" && !isUtcIsoTimestamp(acceptedAt)) {
        return yield* invalidRequest(
          "`snapshot.accept` requires input.accepted_at as a valid UTC ISO-8601 timestamp.",
          operation,
        );
      }
      if (operation === "snapshot.check" && acceptedAt !== undefined && acceptedAt !== null) {
        return yield* invalidRequest(
          "`snapshot.check` input.accepted_at must be null when provided.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: {
          runPath: parsed.input.run_path,
          statePath: parsed.input.state_path,
          writeback:
            writeback === "none" || writeback === "final" || writeback === "live"
              ? writeback
              : undefined,
          projectRemoteWrites: parsed.input.project_remote_writes,
          acceptedAt: typeof acceptedAt === "string" ? acceptedAt : undefined,
        },
      };
    }

    if (operation === "roles.discover") {
      if (Object.keys(parsed.input).length > 0) {
        return yield* invalidRequest("`roles.discover` input must be empty.", operation);
      }
      return { schemaVersion: CONTRACT_SCHEMA_VERSION, operation, input: {} };
    }

    if (operation === "role.validate") {
      const roles: RoleName[] = ["coordinator", "implementor", "reviewer"];
      if (!roles.includes(parsed.input.role as RoleName)) {
        return yield* invalidRequest(
          "`role.validate` input.role must be `coordinator`, `implementor`, or `reviewer`.",
          operation,
        );
      }
      const triple = typeof parsed.input.triple === "string" ? parsed.input.triple : undefined;
      const record = parseRoleRecord(parsed.input.record);
      if ((triple === undefined) === (record === undefined)) {
        return yield* invalidRequest(
          "`role.validate` requires exactly one of input.triple or input.record.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: { role: parsed.input.role as RoleName, triple, record },
      };
    }

    if (operation === "scheduler.plan") {
      const mode = parsed.input.mode;
      const maxImplementors = positiveInteger(parsed.input.max_implementors);
      const tickets = parseSchedulerTickets(parsed.input.tickets);
      const runtimes = parseSchedulerRuntimes(parsed.input.runtimes);
      if (
        (mode !== "parallel" && mode !== "serial") ||
        maxImplementors === undefined ||
        (mode === "serial" && maxImplementors !== 1) ||
        tickets === undefined ||
        runtimes === undefined
      ) {
        return yield* invalidRequest(
          "`scheduler.plan` parallel mode requires a positive input.max_implementors; serial mode requires exactly 1.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: { mode, maxImplementors, tickets, runtimes },
      };
    }

    if (operation === "herdr.wait_any") {
      const socketPath = nonEmptyString(parsed.input.socket_path);
      const timeoutMs = positiveInteger(parsed.input.timeout_ms);
      const workers = parseHerdrWorkers(parsed.input.workers);
      const coordinatorValue = parsed.input.coordinator;
      const coordinator =
        coordinatorValue === undefined || coordinatorValue === null
          ? undefined
          : parseHerdrCoordinator(coordinatorValue);
      if (
        socketPath === undefined ||
        timeoutMs === undefined ||
        timeoutMs > 600_000 ||
        workers === undefined ||
        (workers.length === 0 && coordinator === undefined) ||
        (coordinatorValue !== undefined && coordinatorValue !== null && coordinator === undefined)
      ) {
        return yield* invalidRequest(
          "`herdr.wait_any` requires socket_path, a 1..600000 timeout_ms, workers, and an optional complete coordinator identity and phase; at least one worker or coordinator is required.",
          operation,
        );
      }
      const duplicateRuntime = firstDuplicate(workers.map((worker) => worker.runtimeId));
      if (duplicateRuntime !== undefined) {
        return yield* invalidRequest(
          `\`herdr.wait_any\` workers contain duplicate runtime_id \`${duplicateRuntime}\`.`,
          operation,
        );
      }
      const duplicateSession = firstDuplicate(workers.map((worker) => worker.session));
      if (duplicateSession !== undefined) {
        return yield* invalidRequest(
          `\`herdr.wait_any\` workers contain duplicate session \`${duplicateSession}\`.`,
          operation,
        );
      }
      const duplicatePane = firstDuplicate(workers.map((worker) => worker.paneId));
      if (duplicatePane !== undefined) {
        return yield* invalidRequest(
          `\`herdr.wait_any\` workers contain duplicate pane_id \`${duplicatePane}\`.`,
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: { socketPath, timeoutMs, workers, coordinator },
      };
    }

    if (operation === "infrastructure.retry.record") {
      const statePath = nonEmptyString(parsed.input.state_path);
      const ticket = ticketNumber(parsed.input.ticket);
      const attempt = positiveInteger(parsed.input.attempt);
      const failure = parsed.input.failure;
      const diagnostic = nonEmptyString(parsed.input.diagnostic);
      if (
        statePath === undefined ||
        ticket === undefined ||
        attempt === undefined ||
        (failure !== "worker" && failure !== "herdr" && failure !== "launch") ||
        diagnostic === undefined
      ) {
        return yield* invalidRequest(
          "`infrastructure.retry.record` requires state_path, ticket, positive attempt, failure `worker`, `herdr`, or `launch`, and a diagnostic.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: { statePath, ticket, attempt, failure, diagnostic },
      };
    }

    if (operation === "worktree.preflight") {
      const policy = parseRepositoryPolicy(parsed.input.policy);
      if (policy === undefined) {
        return yield* invalidRequest(
          "`worktree.preflight` requires a complete repository policy.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: { policy },
      };
    }

    if (operation === "worktree.prepare") {
      const statePath = nonEmptyString(parsed.input.state_path);
      const repositoryPath = nonEmptyString(parsed.input.repository_path);
      const baseBranch = singleLineString(parsed.input.base_branch);
      const branch = singleLineString(parsed.input.branch);
      const worktreeName = singleLineString(parsed.input.worktree_name);
      const expectedPathValue = parsed.input.expected_worktree_path;
      const expectedWorktreePath =
        typeof expectedPathValue === "string" && expectedPathValue.length > 0
          ? expectedPathValue
          : undefined;
      const policy = parseRepositoryPolicy(parsed.input.policy);
      if (
        statePath === undefined ||
        repositoryPath === undefined ||
        baseBranch === undefined ||
        branch === undefined ||
        worktreeName === undefined ||
        policy === undefined ||
        (policy.worktree.kind === "repository" && expectedWorktreePath === undefined)
      ) {
        return yield* invalidRequest(
          "`worktree.prepare` requires state_path, repository_path, base_branch, branch, worktree_name, and a complete repository policy; repository tools also require expected_worktree_path.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: {
          statePath,
          repositoryPath,
          baseBranch,
          branch,
          worktreeName,
          expectedWorktreePath,
          policy,
        },
      };
    }

    if (operation === "landing.synchronize") {
      const statePath = nonEmptyString(parsed.input.state_path);
      const repositoryPath = nonEmptyString(parsed.input.repository_path);
      const worktreePath = nonEmptyString(parsed.input.worktree_path);
      const ticket = singleLineString(parsed.input.ticket);
      const remoteSyncArgv = stringArray(parsed.input.remote_sync_argv);
      const completedAt = parsed.input.completed_at;
      if (
        statePath === undefined ||
        repositoryPath === undefined ||
        worktreePath === undefined ||
        ticket === undefined ||
        !/^\d{2}$/u.test(ticket) ||
        (parsed.input.remote_sync_argv !== null && remoteSyncArgv === undefined) ||
        !isUtcIsoTimestamp(completedAt)
      ) {
        return yield* invalidRequest(
          "`landing.synchronize` requires state_path, repository_path, worktree_path, a two-digit ticket, remote_sync_argv as an argument array or null, and completed_at.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: {
          statePath,
          repositoryPath,
          worktreePath,
          ticket,
          remoteSyncArgv,
          completedAt,
        },
      };
    }

    if (operation === "landing.conflict.record") {
      const statePath = nonEmptyString(parsed.input.state_path);
      const ticket = singleLineString(parsed.input.ticket);
      const classification = parsed.input.classification;
      const decision = singleLineString(parsed.input.decision);
      const userAuthorized = parsed.input.user_authorized;
      const completedAt = parsed.input.completed_at;
      if (
        statePath === undefined ||
        ticket === undefined ||
        !/^\d{2}$/u.test(ticket) ||
        (classification !== "textual" &&
          classification !== "substantive" &&
          classification !== "scope") ||
        typeof userAuthorized !== "boolean" ||
        (classification === "scope" && userAuthorized && decision === undefined) ||
        (classification === "scope" && !userAuthorized && parsed.input.decision !== null) ||
        (classification !== "scope" && userAuthorized) ||
        (classification !== "scope" && parsed.input.decision !== null) ||
        !isUtcIsoTimestamp(completedAt)
      ) {
        return yield* invalidRequest(
          "`landing.conflict.record` requires state_path, a two-digit ticket, classification, explicit user_authorized, decision only for an authorized scope choice, and completed_at.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: { statePath, ticket, classification, decision, userAuthorized, completedAt },
      };
    }

    if (operation === "landing.complete") {
      const statePath = nonEmptyString(parsed.input.state_path);
      const repositoryPath = nonEmptyString(parsed.input.repository_path);
      const worktreePath = nonEmptyString(parsed.input.worktree_path);
      const evidencePath = nonEmptyString(parsed.input.evidence_path);
      const ticket = singleLineString(parsed.input.ticket);
      const cleanupArgv = stringArray(parsed.input.cleanup_argv);
      const runtimeClosed = parsed.input.runtime_closed;
      const completedAt = parsed.input.completed_at;
      if (
        statePath === undefined ||
        repositoryPath === undefined ||
        worktreePath === undefined ||
        evidencePath === undefined ||
        ticket === undefined ||
        !/^\d{2}$/u.test(ticket) ||
        (parsed.input.cleanup_argv !== null && cleanupArgv === undefined) ||
        typeof runtimeClosed !== "boolean" ||
        !isUtcIsoTimestamp(completedAt)
      ) {
        return yield* invalidRequest(
          "`landing.complete` requires state_path, repository_path, worktree_path, evidence_path, a two-digit ticket, cleanup_argv as an argument array or null, boolean runtime_closed, and completed_at.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: {
          statePath,
          repositoryPath,
          worktreePath,
          evidencePath,
          ticket,
          cleanupArgv,
          runtimeClosed,
          completedAt,
        },
      };
    }

    if (operation === "gate.record") {
      const statePath = nonEmptyString(parsed.input.state_path);
      const evidencePath = nonEmptyString(parsed.input.evidence_path);
      const worktreePath = nonEmptyString(parsed.input.worktree_path);
      const ticket = singleLineString(parsed.input.ticket);
      const round = nonNegativeInteger(parsed.input.round);
      const name = singleLineString(parsed.input.name);
      const attempt = positiveInteger(parsed.input.attempt);
      const status = parsed.input.status;
      const exitCode = nonNegativeInteger(parsed.input.exit_code);
      const stdout = typeof parsed.input.stdout === "string" ? parsed.input.stdout : undefined;
      const stderr = typeof parsed.input.stderr === "string" ? parsed.input.stderr : undefined;
      const completedAt = parsed.input.completed_at;
      if (
        statePath === undefined ||
        evidencePath === undefined ||
        worktreePath === undefined ||
        ticket === undefined ||
        !/^\d{2}$/u.test(ticket) ||
        round === undefined ||
        name === undefined ||
        attempt === undefined ||
        attempt > 4 ||
        (status !== "passed" && status !== "failed" && status !== "infrastructure_failed") ||
        exitCode === undefined ||
        stdout === undefined ||
        stderr === undefined ||
        !isUtcIsoTimestamp(completedAt) ||
        (status === "passed" && exitCode !== 0) ||
        (status === "failed" && exitCode === 0)
      ) {
        return yield* invalidRequest(
          "`gate.record` requires a configured gate, worktree_path, ticket, round, attempt from 1 through 4, exact output, valid status and exit code, and completed_at.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: {
          statePath,
          evidencePath,
          worktreePath,
          ticket,
          round,
          name,
          attempt,
          status,
          exitCode,
          stdout,
          stderr,
          completedAt,
        },
      };
    }

    if (operation === "review.round.finalize") {
      const statePath = nonEmptyString(parsed.input.state_path);
      const ticket = singleLineString(parsed.input.ticket);
      const round = nonNegativeInteger(parsed.input.round);
      const standardsEvidencePath = nonEmptyString(parsed.input.standards_evidence_path);
      const specEvidencePath = nonEmptyString(parsed.input.spec_evidence_path);
      const selfReviewPath = nonEmptyString(parsed.input.self_review_path);
      const selfReviewMethod = parsed.input.self_review_method;
      const selfReviewReport =
        typeof parsed.input.self_review_report === "string"
          ? parsed.input.self_review_report
          : undefined;
      const fixRequestPath = nonEmptyString(parsed.input.fix_request_path);
      const completedAt = parsed.input.completed_at;
      if (
        statePath === undefined ||
        ticket === undefined ||
        !/^\d{2}$/u.test(ticket) ||
        round === undefined ||
        standardsEvidencePath === undefined ||
        specEvidencePath === undefined ||
        selfReviewPath === undefined ||
        (selfReviewMethod !== "matt-implement" &&
          selfReviewMethod !== "standards-spec-single-session") ||
        selfReviewReport === undefined ||
        selfReviewReport.trim().length === 0 ||
        fixRequestPath === undefined ||
        !isUtcIsoTimestamp(completedAt)
      ) {
        return yield* invalidRequest(
          "`review.round.finalize` requires both accepted axis evidence paths, a harness-appropriate self-review report, fix request path, and completed_at.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: {
          statePath,
          ticket,
          round,
          standardsEvidencePath,
          specEvidencePath,
          selfReviewPath,
          selfReviewMethod,
          selfReviewReport,
          fixRequestPath,
          completedAt,
        },
      };
    }

    if (operation === "review.launch.prepare") {
      const statePath = nonEmptyString(parsed.input.state_path);
      const previousArtifactPath = nonEmptyString(parsed.input.previous_artifact_path);
      const artifactPath = nonEmptyString(parsed.input.artifact_path);
      const reportPath = nonEmptyString(parsed.input.report_path);
      const ticket = singleLineString(parsed.input.ticket);
      const round = nonNegativeInteger(parsed.input.round);
      const axis = parsed.input.axis;
      const worktreePath = nonEmptyString(parsed.input.worktree_path);
      const branch = singleLineString(parsed.input.branch);
      const baseRef = singleLineString(parsed.input.base_ref);
      const pane = paneId(parsed.input.pane);
      const role = parseRoleRecord(parsed.input.role);
      const contextPaths = stringArray(parsed.input.context_paths);
      const landedTickets = stringArray(parsed.input.landed_tickets);
      const gateEvidencePaths = stringArray(parsed.input.gate_evidence_paths);
      const attempt = positiveInteger(parsed.input.attempt);
      if (
        statePath === undefined ||
        artifactPath === undefined ||
        reportPath === undefined ||
        ticket === undefined ||
        !/^\d{2}$/u.test(ticket) ||
        round === undefined ||
        (axis !== "standards" && axis !== "spec") ||
        worktreePath === undefined ||
        branch === undefined ||
        baseRef === undefined ||
        pane === undefined ||
        role === undefined ||
        contextPaths === undefined ||
        contextPaths.length === 0 ||
        landedTickets === undefined ||
        gateEvidencePaths === undefined ||
        attempt === undefined ||
        attempt > 4 ||
        (attempt === 1 && previousArtifactPath !== undefined) ||
        (attempt > 1 && previousArtifactPath === undefined)
      ) {
        return yield* invalidRequest(
          "`review.launch.prepare` requires a two-digit ticket, round, axis, runtime paths, base and branch, pane, Reviewer role, context paths, landed tickets, attempt from 1 through 4, and the preceding artifact path for retries only.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: {
          statePath,
          previousArtifactPath,
          artifactPath,
          reportPath,
          ticket,
          round,
          axis,
          worktreePath,
          branch,
          baseRef,
          pane,
          role,
          contextPaths,
          landedTickets,
          gateEvidencePaths,
          attempt,
        },
      };
    }

    if (operation === "review.launch.record") {
      const statePath = nonEmptyString(parsed.input.state_path);
      const artifactPath = nonEmptyString(parsed.input.artifact_path);
      const status = parsed.input.status;
      const report = typeof parsed.input.report === "string" ? parsed.input.report : undefined;
      const completedAt = parsed.input.completed_at;
      const diagnosticValue = parsed.input.diagnostic;
      let diagnostic: LaunchDiagnostic | undefined;
      if (isRecord(diagnosticValue)) {
        const stage = singleLineString(diagnosticValue.stage);
        const exitCode = nonNegativeInteger(diagnosticValue.exit_code);
        const stderr =
          typeof diagnosticValue.stderr === "string" ? diagnosticValue.stderr : undefined;
        if (stage !== undefined && exitCode !== undefined && stderr !== undefined) {
          diagnostic = { stage, exitCode, stderr };
        }
      }
      if (
        statePath === undefined ||
        artifactPath === undefined ||
        (status !== "completed" && status !== "infrastructure_failed") ||
        !isUtcIsoTimestamp(completedAt) ||
        (status === "completed" && (report === undefined || report.trim().length === 0)) ||
        (status === "completed" && diagnosticValue !== null && diagnosticValue !== undefined) ||
        (status === "infrastructure_failed" && diagnostic === undefined) ||
        (status === "infrastructure_failed" && report !== undefined)
      ) {
        return yield* invalidRequest(
          "`review.launch.record` requires state_path, artifact_path, completed_at, and either a complete report or an infrastructure diagnostic.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: { statePath, artifactPath, status, report, diagnostic, completedAt },
      };
    }

    if (operation === "review.policy.prepare") {
      const statePath = nonEmptyString(parsed.input.state_path);
      const instructionFiles = stringArray(parsed.input.instruction_files);
      const ciFiles = stringArray(parsed.input.ci_files);
      const safetyConstraints = stringArray(parsed.input.safety_constraints);
      const gatesValue = parsed.input.gates;
      const gates = Array.isArray(gatesValue)
        ? gatesValue.flatMap((value) => {
            if (!isRecord(value)) return [];
            const name = singleLineString(value.name);
            const argv = stringArray(value.argv);
            return name === undefined || argv === undefined || argv.length === 0
              ? []
              : [{ name, argv }];
          })
        : undefined;
      const noExecutableGates = parsed.input.no_executable_gates === true;
      const noAdditionalSafetyConstraints = parsed.input.no_additional_safety_constraints === true;
      const gateNames = gates?.map((gate) => gate.name) ?? [];
      if (
        statePath === undefined ||
        instructionFiles === undefined ||
        instructionFiles.length === 0 ||
        ciFiles === undefined ||
        safetyConstraints === undefined ||
        gates === undefined ||
        gates.length !== (Array.isArray(gatesValue) ? gatesValue.length : -1) ||
        new Set(gateNames).size !== gateNames.length ||
        (gates.length === 0) === !noExecutableGates ||
        (safetyConstraints.length === 0) === !noAdditionalSafetyConstraints
      ) {
        return yield* invalidRequest(
          "`review.policy.prepare` requires authoritative instruction files, explicit CI files, unique exact gate argv arrays or no_executable_gates, and explicit safety constraints or no_additional_safety_constraints.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: {
          statePath,
          instructionFiles,
          ciFiles,
          gates,
          noExecutableGates,
          safetyConstraints,
          noAdditionalSafetyConstraints,
        },
      };
    }

    if (operation === "implementor.launch.prepare") {
      const statePath = nonEmptyString(parsed.input.state_path);
      const artifactPath = nonEmptyString(parsed.input.artifact_path);
      const ticket = singleLineString(parsed.input.ticket);
      const worktreePath = nonEmptyString(parsed.input.worktree_path);
      const branch = singleLineString(parsed.input.branch);
      const session = singleLineString(parsed.input.session);
      const tab = singleLineString(parsed.input.tab);
      const pane = paneId(parsed.input.pane);
      const role = parseRoleRecord(parsed.input.role);
      const skillValue = parsed.input.implement_skill_path;
      const implementSkillPath =
        typeof skillValue === "string" && skillValue.length > 0 ? skillValue : undefined;
      const prompt = typeof parsed.input.prompt === "string" ? parsed.input.prompt : undefined;
      const attempt = positiveInteger(parsed.input.attempt);
      const maxAttempts = positiveInteger(parsed.input.max_attempts);
      if (
        statePath === undefined ||
        artifactPath === undefined ||
        ticket === undefined ||
        !/^\d{2}$/u.test(ticket) ||
        worktreePath === undefined ||
        branch === undefined ||
        session === undefined ||
        tab === undefined ||
        pane === undefined ||
        role === undefined ||
        prompt === undefined ||
        prompt.length === 0 ||
        attempt === undefined ||
        maxAttempts === undefined ||
        attempt > maxAttempts + 1 ||
        (role.harness === "pi" && implementSkillPath === undefined) ||
        (role.harness === "claude" && skillValue !== null && skillValue !== undefined)
      ) {
        return yield* invalidRequest(
          "`implementor.launch.prepare` requires a two-digit ticket, runtime identifiers, role, prompt, valid attempt bounds, and an explicit implement_skill_path only for Pi.",
          operation,
        );
      }
      if (maxAttempts !== 3) {
        return yield* invalidRequest(
          "`implementor.launch.prepare` requires input.max_attempts to equal 3.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: {
          statePath,
          artifactPath,
          ticket,
          worktreePath,
          branch,
          session,
          tab,
          pane,
          role,
          implementSkillPath,
          prompt,
          attempt,
          maxAttempts,
        },
      };
    }

    if (operation === "implementor.launch.record") {
      const statePath = nonEmptyString(parsed.input.state_path);
      const ticket = singleLineString(parsed.input.ticket);
      const attempt = positiveInteger(parsed.input.attempt);
      const status = parsed.input.status;
      const diagnosticValue = parsed.input.diagnostic;
      let diagnostic: LaunchDiagnostic | undefined;
      if (isRecord(diagnosticValue)) {
        const stage = singleLineString(diagnosticValue.stage);
        const exitCode = nonNegativeInteger(diagnosticValue.exit_code);
        const stderr =
          typeof diagnosticValue.stderr === "string" ? diagnosticValue.stderr : undefined;
        if (stage !== undefined && exitCode !== undefined && stderr !== undefined) {
          diagnostic = { stage, exitCode, stderr };
        }
      }
      if (
        statePath === undefined ||
        ticket === undefined ||
        !/^\d{2}$/u.test(ticket) ||
        attempt === undefined ||
        (status !== "started" && status !== "failed") ||
        (status === "failed" && diagnostic === undefined) ||
        (status === "started" && diagnosticValue !== null && diagnosticValue !== undefined)
      ) {
        return yield* invalidRequest(
          "`implementor.launch.record` requires state_path, a two-digit ticket, a positive attempt, status `started` or `failed`, and a diagnostic only for failure.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: { statePath, ticket, attempt, status, diagnostic },
      };
    }

    if (operation === "coordinator.handoff.ready") {
      const artifactPath = nonEmptyString(parsed.input.artifact_path);
      const socketPath = nonEmptyString(parsed.input.socket_path);
      const timeoutMs = positiveInteger(parsed.input.timeout_ms);
      const projectRemoteWrites = parsed.input.project_remote_writes;
      if (
        artifactPath === undefined ||
        socketPath === undefined ||
        timeoutMs === undefined ||
        timeoutMs > 600_000 ||
        (projectRemoteWrites !== "allowed" && projectRemoteWrites !== "forbidden")
      ) {
        return yield* invalidRequest(
          "`coordinator.handoff.ready` requires artifact_path, socket_path, a 1..600000 timeout_ms, and project_remote_writes.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: { artifactPath, socketPath, timeoutMs, projectRemoteWrites },
      };
    }

    if (operation === "coordinator.handoff.verify") {
      const artifactPath = nonEmptyString(parsed.input.artifact_path);
      const observedMarker = singleLineString(parsed.input.observed_marker);
      if (artifactPath === undefined || observedMarker === undefined) {
        return yield* invalidRequest(
          "`coordinator.handoff.verify` requires artifact_path and observed_marker.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: { artifactPath, observedMarker },
      };
    }

    if (operation === "coordinator.handoff.retry") {
      const artifactPath = nonEmptyString(parsed.input.artifact_path);
      const diagnostic = nonEmptyString(parsed.input.diagnostic);
      if (artifactPath === undefined || diagnostic === undefined) {
        return yield* invalidRequest(
          "`coordinator.handoff.retry` requires artifact_path and a non-empty diagnostic.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: { artifactPath, diagnostic },
      };
    }

    if (operation === "coordinator.handoff.prepare") {
      const statePath = nonEmptyString(parsed.input.state_path);
      const runPath = nonEmptyString(parsed.input.run_path);
      const artifactPath = nonEmptyString(parsed.input.artifact_path);
      const session = singleLineString(parsed.input.session);
      const successorPane = paneId(parsed.input.successor_pane);
      const predecessorSession = singleLineString(parsed.input.predecessor_session);
      const socketPath = nonEmptyString(parsed.input.socket_path);
      const timeoutMs = positiveInteger(parsed.input.timeout_ms);
      const phase = parsed.input.phase;
      const attempt = positiveInteger(parsed.input.attempt);
      const maxRetries = positiveInteger(parsed.input.max_retries);
      const previousValue = parsed.input.previous_artifact_path;
      const previousArtifactPath =
        typeof previousValue === "string" && previousValue.length > 0 ? previousValue : undefined;
      if (
        statePath === undefined ||
        runPath === undefined ||
        artifactPath === undefined ||
        session === undefined ||
        successorPane === undefined ||
        predecessorSession === undefined ||
        socketPath === undefined ||
        timeoutMs === undefined ||
        (phase !== "waiting" &&
          phase !== "scheduling" &&
          phase !== "synchronizing" &&
          phase !== "reviewing" &&
          phase !== "fixing" &&
          phase !== "landing") ||
        attempt === undefined ||
        maxRetries !== 3 ||
        attempt > maxRetries + 1 ||
        (attempt === 1 && previousValue !== null && previousValue !== undefined) ||
        (attempt > 1 && previousArtifactPath === undefined)
      ) {
        return yield* invalidRequest(
          "`coordinator.handoff.prepare` requires state_path, run_path, artifact_path, successor session and pane, predecessor_session, Herdr socket_path and timeout_ms, phase, attempt 1..4, max_retries 3, and the previous artifact after attempt 1.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: {
          statePath,
          runPath,
          artifactPath,
          session,
          successorPane,
          predecessorSession,
          socketPath,
          timeoutMs,
          phase,
          attempt,
          maxRetries,
          previousArtifactPath,
        },
      };
    }

    if (operation === "coordinator.claim") {
      const statePath = nonEmptyString(parsed.input.state_path);
      const predecessorPane = paneId(parsed.input.expected_predecessor_pane);
      const predecessorRole = parseRoleRecord(parsed.input.expected_predecessor_role);
      const successorPane = paneId(parsed.input.successor_pane);
      const successorRole = parseRoleRecord(parsed.input.successor_role);
      const generation = nonNegativeInteger(parsed.input.expected_generation);
      if (
        statePath === undefined ||
        predecessorPane === undefined ||
        predecessorRole === undefined ||
        successorPane === undefined ||
        successorRole === undefined ||
        generation === undefined
      ) {
        return yield* invalidRequest(
          "`coordinator.claim` requires state_path, a non-negative expected_generation, expected_predecessor_pane, expected_predecessor_role, successor_pane, and successor_role.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: {
          statePath,
          expectedGeneration: generation,
          expectedPredecessorPane: predecessorPane,
          expectedPredecessorRole: predecessorRole,
          successorPane,
          successorRole,
        },
      };
    }

    if (operation === "coordinator.ready") {
      const statePath = nonEmptyString(parsed.input.state_path);
      const pane = paneId(parsed.input.pane);
      const marker = singleLineString(parsed.input.marker);
      const generation = nonNegativeInteger(parsed.input.generation);
      if (
        statePath === undefined ||
        pane === undefined ||
        marker === undefined ||
        generation === undefined
      ) {
        return yield* invalidRequest(
          "`coordinator.ready` requires state_path, a non-negative generation, pane, and marker.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: { statePath, generation, pane, marker },
      };
    }

    if (operation === "coordinator.verify") {
      const statePath = nonEmptyString(parsed.input.state_path);
      const pane = paneId(parsed.input.pane);
      const observedMarker = singleLineString(parsed.input.observed_marker);
      const generation = nonNegativeInteger(parsed.input.generation);
      if (
        statePath === undefined ||
        pane === undefined ||
        observedMarker === undefined ||
        generation === undefined
      ) {
        return yield* invalidRequest(
          "`coordinator.verify` requires state_path, a non-negative generation, pane, and observed_marker.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: { statePath, generation, pane, observedMarker },
      };
    }

    const statePathValue = parsed.input.state_path;
    if (
      statePathValue !== undefined &&
      statePathValue !== null &&
      (typeof statePathValue !== "string" || statePathValue.length === 0)
    ) {
      return yield* invalidRequest(
        "`preflight` input.state_path must be a non-empty string or null.",
        operation,
      );
    }
    const rootsValue = parsed.input.skill_roots;
    if (
      rootsValue !== undefined &&
      rootsValue !== null &&
      (!Array.isArray(rootsValue) || rootsValue.some((root) => typeof root !== "string"))
    ) {
      return yield* invalidRequest(
        "`preflight` input.skill_roots must be an array of strings or null.",
        operation,
      );
    }

    return {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      operation: "preflight",
      input: {
        statePath: typeof statePathValue === "string" ? statePathValue : undefined,
        skillRoots: Array.isArray(rootsValue) ? (rootsValue as string[]) : undefined,
      },
    };
  });

/**
 * Builds a stable success response for one helper operation.
 *
 * @param operation - Operation represented by the response.
 * @param result - Operation-specific JSON result.
 * @returns A schema-version-1 success envelope.
 */
export const successResponse = <Result>(
  operation: CoordinateOperation,
  result: Result,
): CoordinateResponse<Result> => ({
  schema_version: CONTRACT_SCHEMA_VERSION,
  operation,
  ok: true,
  result,
  errors: [],
});

/**
 * Builds a stable failure response for request or operation errors.
 *
 * @param operation - Operation represented by the response, when known.
 * @param errors - Actionable problems that prevented success.
 * @param result - Optional partial operation result containing completed checks.
 * @returns A schema-version-1 failure envelope.
 */
export const failureResponse = <Result>(
  operation: string | null,
  errors: CliIssue[],
  result: Result | null,
): CoordinateResponse<Result> => ({
  schema_version: CONTRACT_SCHEMA_VERSION,
  operation,
  ok: false,
  result,
  errors,
});
