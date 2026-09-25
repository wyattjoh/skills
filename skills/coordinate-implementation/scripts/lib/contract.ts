import { Data, Effect } from "effect";
import { isRecord } from "./values.ts";

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
  | "snapshot.check"
  | "snapshot.accept"
  | "worktree.preflight"
  | "worktree.prepare"
  | "implementor.runtime.migrate"
  | "implementor.runtime.migration.recover"
  | "implementor.launch.prepare"
  | "implementor.launch.recover"
  | "implementor.launch.record"
  | "scheduler.plan"
  | "stall.assessment.prepare"
  | "stall.assessment.evaluate"
  | "stall.assessment.apply"
  | "infrastructure.retry.record"
  | "review.policy.prepare"
  | "review.attempt.supersede"
  | "review.launch.prepare"
  | "review.launch.record"
  | "gate.record"
  | "gate.rerun.record"
  | "review.round.finalize"
  | "landing.rebase.check"
  | "landing.complete"
  | "run.finalize"
  | "agreements.update";

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
  statePath: string | undefined;
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
export type ImplementorRuntimeBinding = {
  worktreePath: string;
  branch: string;
  role: RoleRecord;
  implementSkillPath: string;
  session: string;
  tab: string;
  pane: string;
  artifactPath: string;
  attempt: number;
  retry: string;
  phase: "working" | "gates";
};

/**
 * Input for explicitly migrating one closed Claude implementor to the persisted Pi default.
 */
export type ImplementorRuntimeMigrateInput = {
  statePath: string;
  ticket: string;
  expectedBinding: ImplementorRuntimeBinding;
  replacementRole: RoleRecord;
  userAuthorized: true;
  completedAt: string;
};

/**
 * Input for explicitly revalidating a gates-phase implementor migration.
 */
export type ImplementorRuntimeMigrationRecoverInput = {
  statePath: string;
  ticket: string;
  migrationEvidenceSha256: string;
  userAuthorized: true;
  completedAt: string;
};

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
 * Input for an operator-authorized recovery of an exhausted compatible launch.
 */
export type ImplementorLaunchRecoverInput = {
  statePath: string;
  ticket: string;
  socketPath: string;
  timeoutMs: number;
  userAuthorized: true;
  diagnostic: string;
  recoveredAt: string;
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
 * Input for preparing one immutable TypeSafe stall-assessment request.
 */
export type StallAssessmentPrepareInput = {
  runPath: string;
  statePath: string;
  requestPath: string;
  previousEvidencePath: string | undefined;
};

/**
 * Input for evaluating one immutable TypeSafe stall-assessment request.
 */
export type StallAssessmentEvaluateInput = {
  runPath: string;
  requestPath: string;
  evidencePath: string;
};

/**
 * Input for applying one bound TypeSafe stall-assessment disposition.
 */
export type StallAssessmentApplyInput = StallAssessmentEvaluateInput & {
  statePath: string;
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
export type ReviewAttemptBinding = {
  ticket: string;
  round: number;
  axis: ReviewAxis;
  attempt: number;
  reviewer: RoleRecord;
  worktreePath: string;
  branch: string;
  baseRef: string;
  pane: string;
  session: string;
  tab: string;
  reviewedHead: string;
  statusBefore: string;
  contextPaths: string[];
  landedTickets: string[];
  gateEvidencePaths: string[];
  artifactSha256: string;
};

/**
 * Input for user-authorized supersession of one interrupted, closed Claude review attempt.
 */
export type ReviewAttemptSupersedeInput = {
  statePath: string;
  artifactPath: string;
  expectedBinding: ReviewAttemptBinding;
  userAuthorized: true;
  reason: string;
  completedAt: string;
};

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
 * Input for recording an authorized same-HEAD rerun of a failed gate.
 */
export type GateRerunRecordInput = {
  statePath: string;
  previousEvidencePath: string;
  evidencePath: string;
  worktreePath: string;
  ticket: string;
  round: number;
  name: string;
  attempt: number;
  exitCode: 0;
  stdout: string;
  stderr: string;
  userAuthorized: true;
  diagnostic: string;
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
 * Input for checking whether a clean ticket branch contains the local base and binding its integration.
 */
export type LandingRebaseCheckInput = {
  statePath: string;
  repositoryPath: string;
  worktreePath: string;
  ticket: string;
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
  lockWaitSeconds: number | undefined;
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
 * Input for replacing the repository's cross-run agreements.
 */
export type AgreementsUpdateInput = {
  statePath: string;
  mergeOrder: string[];
  sharedFiles: Array<{ path: string; ownerPrefix: string }>;
  transferOwnership: boolean;
  userAuthorized: boolean;
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
      operation: "implementor.runtime.migrate";
      input: ImplementorRuntimeMigrateInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "implementor.runtime.migration.recover";
      input: ImplementorRuntimeMigrationRecoverInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "implementor.launch.prepare";
      input: ImplementorLaunchPrepareInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "implementor.launch.recover";
      input: ImplementorLaunchRecoverInput;
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
      operation: "stall.assessment.prepare";
      input: StallAssessmentPrepareInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "stall.assessment.evaluate";
      input: StallAssessmentEvaluateInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "stall.assessment.apply";
      input: StallAssessmentApplyInput;
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
      operation: "review.attempt.supersede";
      input: ReviewAttemptSupersedeInput;
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
      operation: "gate.rerun.record";
      input: GateRerunRecordInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "review.round.finalize";
      input: ReviewRoundFinalizeInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "landing.rebase.check";
      input: LandingRebaseCheckInput;
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
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "agreements.update";
      input: AgreementsUpdateInput;
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
  /** Non-fatal global-state problems; present only when at least one occurred. */
  warnings?: CliIssue[];
};

/**
 * Typed failure raised when stdin does not contain a supported request.
 */
export class RequestError extends Data.TaggedError("RequestError")<{
  issue: CliIssue;
  operation: string | null;
}> {}

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

const parseImplementorRuntimeBinding = (value: unknown): ImplementorRuntimeBinding | undefined => {
  if (!isRecord(value)) return undefined;
  const worktreePath = nonEmptyString(value.worktree_path);
  const branch = singleLineString(value.branch);
  const role = parseRoleRecord(value.role);
  const implementSkillPath = nonEmptyString(value.implement_skill_path);
  const session = singleLineString(value.session);
  const tab = singleLineString(value.tab);
  const pane = paneId(value.pane);
  const artifactPath = nonEmptyString(value.artifact_path);
  const attempt = positiveInteger(value.attempt);
  const retry = singleLineString(value.retry);
  const phase = value.phase;
  if (
    worktreePath === undefined ||
    branch === undefined ||
    role === undefined ||
    implementSkillPath === undefined ||
    session === undefined ||
    tab === undefined ||
    pane === undefined ||
    artifactPath === undefined ||
    attempt === undefined ||
    retry === undefined ||
    (phase !== "working" && phase !== "gates")
  ) {
    return undefined;
  }
  return {
    worktreePath,
    branch,
    role,
    implementSkillPath,
    session,
    tab,
    pane,
    artifactPath,
    attempt,
    retry,
    phase,
  };
};

const parseReviewAttemptBinding = (value: unknown): ReviewAttemptBinding | undefined => {
  if (!isRecord(value)) return undefined;
  const ticket = singleLineString(value.ticket);
  const round = nonNegativeInteger(value.round);
  const axis = value.axis;
  const attempt = positiveInteger(value.attempt);
  const reviewer = parseRoleRecord(value.reviewer);
  const worktreePath = nonEmptyString(value.worktree_path);
  const branch = singleLineString(value.branch);
  const baseRef = singleLineString(value.base_ref);
  const pane = paneId(value.pane);
  const session = singleLineString(value.session);
  const tab = singleLineString(value.tab);
  const reviewedHead = singleLineString(value.reviewed_head);
  const statusBefore = typeof value.status_before === "string" ? value.status_before : undefined;
  const contextPaths = stringArray(value.context_paths);
  const landedTickets = stringArray(value.landed_tickets);
  const gateEvidencePaths = stringArray(value.gate_evidence_paths);
  const artifactSha256 = singleLineString(value.artifact_sha256);
  if (
    ticket === undefined ||
    !/^\d{2}$/u.test(ticket) ||
    round === undefined ||
    (axis !== "standards" && axis !== "spec") ||
    attempt === undefined ||
    attempt > 4 ||
    reviewer === undefined ||
    worktreePath === undefined ||
    branch === undefined ||
    baseRef === undefined ||
    pane === undefined ||
    session === undefined ||
    tab === undefined ||
    reviewedHead === undefined ||
    statusBefore === undefined ||
    contextPaths === undefined ||
    contextPaths.length === 0 ||
    landedTickets === undefined ||
    gateEvidencePaths === undefined ||
    gateEvidencePaths.length === 0 ||
    artifactSha256 === undefined ||
    !/^[0-9a-f]{64}$/u.test(artifactSha256)
  ) {
    return undefined;
  }
  return {
    ticket,
    round,
    axis,
    attempt,
    reviewer,
    worktreePath,
    branch,
    baseRef,
    pane,
    session,
    tab,
    reviewedHead,
    statusBefore,
    contextPaths,
    landedTickets,
    gateEvidencePaths,
    artifactSha256,
  };
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
 * Every operation the helper CLI accepts, in documentation order.
 */
export const COORDINATE_OPERATIONS: readonly CoordinateOperation[] = [
  "preflight",
  "state.validate",
  "roles.discover",
  "role.validate",
  "coordinator.claim",
  "coordinator.ready",
  "coordinator.verify",
  "snapshot.check",
  "snapshot.accept",
  "worktree.preflight",
  "worktree.prepare",
  "implementor.runtime.migrate",
  "implementor.runtime.migration.recover",
  "implementor.launch.prepare",
  "implementor.launch.recover",
  "implementor.launch.record",
  "scheduler.plan",
  "stall.assessment.prepare",
  "stall.assessment.evaluate",
  "stall.assessment.apply",
  "infrastructure.retry.record",
  "review.policy.prepare",
  "review.attempt.supersede",
  "review.launch.prepare",
  "review.launch.record",
  "gate.record",
  "gate.rerun.record",
  "review.round.finalize",
  "landing.rebase.check",
  "landing.complete",
  "run.finalize",
  "agreements.update",
];

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
    if (operation === null || !COORDINATE_OPERATIONS.includes(operation as CoordinateOperation)) {
      return yield* invalidRequest(
        `Request \`operation\` must be one of: ${COORDINATE_OPERATIONS.join(", ")}.`,
        operation,
      );
    }
    if (!isRecord(parsed.input)) {
      return yield* invalidRequest("Request `input` must be an object.", operation);
    }

    if (operation === "agreements.update") {
      const statePath = nonEmptyString(parsed.input.state_path);
      const mergeOrder = stringArray(parsed.input.merge_order);
      const sharedValue = parsed.input.shared_files;
      const sharedFiles = Array.isArray(sharedValue)
        ? sharedValue.flatMap((entry) => {
            if (!isRecord(entry)) return [];
            const path = singleLineString(entry.path);
            const ownerPrefix = singleLineString(entry.owner_prefix);
            return path === undefined || ownerPrefix === undefined ? [] : [{ path, ownerPrefix }];
          })
        : undefined;
      const transferOwnership = parsed.input.transfer_ownership;
      const userAuthorized = parsed.input.user_authorized;
      if (
        statePath === undefined ||
        mergeOrder === undefined ||
        sharedFiles === undefined ||
        sharedFiles.length !== (sharedValue as unknown[]).length ||
        typeof transferOwnership !== "boolean" ||
        typeof userAuthorized !== "boolean" ||
        (transferOwnership && !userAuthorized)
      ) {
        return yield* invalidRequest(
          "`agreements.update` requires state_path, merge_order, shared_files with path and owner_prefix, boolean transfer_ownership, and boolean user_authorized; an ownership transfer requires user_authorized true.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: { statePath, mergeOrder, sharedFiles, transferOwnership, userAuthorized },
      };
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

    if (operation === "stall.assessment.prepare") {
      const runPath = nonEmptyString(parsed.input.run_path);
      const statePath = nonEmptyString(parsed.input.state_path);
      const requestPath = nonEmptyString(parsed.input.request_path);
      const previousEvidenceValue = parsed.input.previous_evidence_path;
      const previousEvidencePath =
        previousEvidenceValue === undefined || previousEvidenceValue === null
          ? undefined
          : nonEmptyString(previousEvidenceValue);
      if (
        runPath === undefined ||
        statePath === undefined ||
        requestPath === undefined ||
        (previousEvidenceValue !== undefined &&
          previousEvidenceValue !== null &&
          previousEvidencePath === undefined)
      ) {
        return yield* invalidRequest(
          "`stall.assessment.prepare` requires run_path, state_path, request_path, and optional previous_evidence_path.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: { runPath, statePath, requestPath, previousEvidencePath },
      };
    }

    if (operation === "stall.assessment.evaluate") {
      const runPath = nonEmptyString(parsed.input.run_path);
      const requestPath = nonEmptyString(parsed.input.request_path);
      const evidencePath = nonEmptyString(parsed.input.evidence_path);
      if (runPath === undefined || requestPath === undefined || evidencePath === undefined) {
        return yield* invalidRequest(
          "`stall.assessment.evaluate` requires run_path, request_path, and evidence_path.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: { runPath, requestPath, evidencePath },
      };
    }

    if (operation === "stall.assessment.apply") {
      const runPath = nonEmptyString(parsed.input.run_path);
      const statePath = nonEmptyString(parsed.input.state_path);
      const requestPath = nonEmptyString(parsed.input.request_path);
      const evidencePath = nonEmptyString(parsed.input.evidence_path);
      if (
        runPath === undefined ||
        statePath === undefined ||
        requestPath === undefined ||
        evidencePath === undefined
      ) {
        return yield* invalidRequest(
          "`stall.assessment.apply` requires run_path, state_path, request_path, and evidence_path.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: { runPath, statePath, requestPath, evidencePath },
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
      const statePathValue = parsed.input.state_path;
      const statePath =
        statePathValue === undefined || statePathValue === null
          ? undefined
          : nonEmptyString(statePathValue);
      if (statePathValue !== undefined && statePathValue !== null && statePath === undefined) {
        return yield* invalidRequest(
          "`worktree.preflight` `state_path` must be a non-empty path when present.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: { policy, statePath },
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

    if (operation === "landing.rebase.check") {
      const statePath = nonEmptyString(parsed.input.state_path);
      const repositoryPath = nonEmptyString(parsed.input.repository_path);
      const worktreePath = nonEmptyString(parsed.input.worktree_path);
      const ticket = singleLineString(parsed.input.ticket);
      const completedAt = parsed.input.completed_at;
      if (
        statePath === undefined ||
        repositoryPath === undefined ||
        worktreePath === undefined ||
        ticket === undefined ||
        !/^\d{2}$/u.test(ticket) ||
        !isUtcIsoTimestamp(completedAt)
      ) {
        return yield* invalidRequest(
          `\`${operation}\` requires state_path, repository_path, worktree_path, a two-digit ticket, and completed_at.`,
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: { statePath, repositoryPath, worktreePath, ticket, completedAt },
      };
    }

    if (operation === "landing.complete") {
      const statePath = nonEmptyString(parsed.input.state_path);
      const repositoryPath = nonEmptyString(parsed.input.repository_path);
      const worktreePath = nonEmptyString(parsed.input.worktree_path);
      const evidencePath = nonEmptyString(parsed.input.evidence_path);
      const ticket = singleLineString(parsed.input.ticket);
      const cleanupArgv = stringArray(parsed.input.cleanup_argv);
      const lockWait = parsed.input.lock_wait_seconds;
      const lockWaitSeconds = nonNegativeInteger(lockWait);
      const completedAt = parsed.input.completed_at;
      if (
        statePath === undefined ||
        repositoryPath === undefined ||
        worktreePath === undefined ||
        evidencePath === undefined ||
        ticket === undefined ||
        !/^\d{2}$/u.test(ticket) ||
        (parsed.input.cleanup_argv !== null && cleanupArgv === undefined) ||
        (lockWait !== undefined && (lockWaitSeconds === undefined || lockWaitSeconds > 110)) ||
        parsed.input.runtime_closed !== undefined ||
        !isUtcIsoTimestamp(completedAt)
      ) {
        return yield* invalidRequest(
          "`landing.complete` requires state_path, repository_path, worktree_path, evidence_path, a two-digit ticket, cleanup_argv as an argument array or null, completed_at, and an optional lock_wait_seconds from 0 to 110; runtime closure is observed from Herdr and cannot be asserted by the caller.",
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
          lockWaitSeconds,
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

    if (operation === "review.attempt.supersede") {
      const statePath = nonEmptyString(parsed.input.state_path);
      const artifactPath = nonEmptyString(parsed.input.artifact_path);
      const expectedBinding = parseReviewAttemptBinding(parsed.input.expected_binding);
      const userAuthorized = parsed.input.user_authorized;
      const reason = singleLineString(parsed.input.reason);
      const completedAt = parsed.input.completed_at;
      if (
        statePath === undefined ||
        artifactPath === undefined ||
        expectedBinding === undefined ||
        expectedBinding.reviewer.harness !== "claude" ||
        userAuthorized !== true ||
        reason === undefined ||
        !isUtcIsoTimestamp(completedAt)
      ) {
        return yield* invalidRequest(
          "`review.attempt.supersede` requires a run-local attempt path, exact Claude review binding, explicit user_authorized true, a single-line interruption reason, and completed_at.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: { statePath, artifactPath, expectedBinding, userAuthorized, reason, completedAt },
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

    if (operation === "implementor.runtime.migrate") {
      const statePath = nonEmptyString(parsed.input.state_path);
      const ticket = singleLineString(parsed.input.ticket);
      const expectedBinding = parseImplementorRuntimeBinding(parsed.input.expected_binding);
      const replacementRole = parseRoleRecord(parsed.input.replacement_role);
      const userAuthorized = parsed.input.user_authorized;
      const completedAt = parsed.input.completed_at;
      if (
        statePath === undefined ||
        ticket === undefined ||
        !/^\d{2}$/u.test(ticket) ||
        expectedBinding === undefined ||
        expectedBinding.role.harness !== "claude" ||
        replacementRole === undefined ||
        replacementRole.harness !== "pi" ||
        userAuthorized !== true ||
        !isUtcIsoTimestamp(completedAt)
      ) {
        return yield* invalidRequest(
          "`implementor.runtime.migrate` requires a ticket, exact Claude runtime binding, exact Pi replacement role, explicit user_authorized true, and completed_at.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: { statePath, ticket, expectedBinding, replacementRole, userAuthorized, completedAt },
      };
    }

    if (operation === "implementor.runtime.migration.recover") {
      const statePath = nonEmptyString(parsed.input.state_path);
      const ticket = singleLineString(parsed.input.ticket);
      const migrationEvidenceSha256 = singleLineString(parsed.input.migration_evidence_sha256);
      const userAuthorized = parsed.input.user_authorized;
      const completedAt = parsed.input.completed_at;
      if (
        statePath === undefined ||
        ticket === undefined ||
        !/^\d{2}$/u.test(ticket) ||
        migrationEvidenceSha256 === undefined ||
        !/^[0-9a-f]{64}$/u.test(migrationEvidenceSha256) ||
        userAuthorized !== true ||
        !isUtcIsoTimestamp(completedAt)
      ) {
        return yield* invalidRequest(
          "`implementor.runtime.migration.recover` requires a ticket, exact migration evidence SHA-256, explicit user_authorized true, and completed_at.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: { statePath, ticket, migrationEvidenceSha256, userAuthorized, completedAt },
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

    if (operation === "implementor.launch.recover") {
      const statePath = nonEmptyString(parsed.input.state_path);
      const ticket = singleLineString(parsed.input.ticket);
      const socketPath = nonEmptyString(parsed.input.socket_path);
      const timeoutMs = positiveInteger(parsed.input.timeout_ms);
      const userAuthorized = parsed.input.user_authorized;
      const diagnostic = singleLineString(parsed.input.diagnostic);
      const recoveredAt = parsed.input.recovered_at;
      if (
        statePath === undefined ||
        ticket === undefined ||
        !/^\d{2}$/u.test(ticket) ||
        socketPath === undefined ||
        timeoutMs === undefined ||
        timeoutMs > 30_000 ||
        userAuthorized !== true ||
        diagnostic === undefined ||
        !isUtcIsoTimestamp(recoveredAt)
      ) {
        return yield* invalidRequest(
          "`implementor.launch.recover` requires state_path, a two-digit ticket, Herdr socket_path, a 1..30000 timeout_ms, explicit user_authorized true, a single-line compatibility diagnostic, and recovered_at.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: {
          statePath,
          ticket,
          socketPath,
          timeoutMs,
          userAuthorized,
          diagnostic,
          recoveredAt,
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

    if (operation === "gate.rerun.record") {
      const statePath = nonEmptyString(parsed.input.state_path);
      const previousEvidencePath = nonEmptyString(parsed.input.previous_evidence_path);
      const evidencePath = nonEmptyString(parsed.input.evidence_path);
      const worktreePath = nonEmptyString(parsed.input.worktree_path);
      const ticket = singleLineString(parsed.input.ticket);
      const round = nonNegativeInteger(parsed.input.round);
      const name = singleLineString(parsed.input.name);
      const attempt = positiveInteger(parsed.input.attempt);
      const exitCode = nonNegativeInteger(parsed.input.exit_code);
      const stdout = typeof parsed.input.stdout === "string" ? parsed.input.stdout : undefined;
      const stderr = typeof parsed.input.stderr === "string" ? parsed.input.stderr : undefined;
      const userAuthorized = parsed.input.user_authorized;
      const diagnostic = singleLineString(parsed.input.diagnostic);
      const completedAt = parsed.input.completed_at;
      if (
        statePath === undefined ||
        previousEvidencePath === undefined ||
        evidencePath === undefined ||
        previousEvidencePath === evidencePath ||
        worktreePath === undefined ||
        ticket === undefined ||
        !/^\d{2}$/u.test(ticket) ||
        round === undefined ||
        name === undefined ||
        attempt === undefined ||
        attempt < 2 ||
        attempt > 4 ||
        exitCode !== 0 ||
        stdout === undefined ||
        stderr === undefined ||
        userAuthorized !== true ||
        diagnostic === undefined ||
        !isUtcIsoTimestamp(completedAt)
      ) {
        return yield* invalidRequest(
          "`gate.rerun.record` requires distinct prior and new run-local evidence paths, a configured gate, worktree_path, ticket, round, attempt 2 through 4, a passing exit code with exact output, explicit user_authorized true, a single-line diagnostic, and completed_at.",
          operation,
        );
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operation,
        input: {
          statePath,
          previousEvidencePath,
          evidencePath,
          worktreePath,
          ticket,
          round,
          name,
          attempt,
          exitCode,
          stdout,
          stderr,
          userAuthorized,
          diagnostic,
          completedAt,
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
