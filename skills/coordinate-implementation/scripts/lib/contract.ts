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
  | "snapshot.check"
  | "snapshot.accept"
  | "worktree.preflight"
  | "worktree.prepare"
  | "implementor.launch.prepare"
  | "implementor.launch.record";

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
      operation: "implementor.launch.prepare";
      input: ImplementorLaunchPrepareInput;
    }
  | {
      schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
      operation: "implementor.launch.record";
      input: ImplementorLaunchRecordInput;
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
  if (
    instructionFiles === undefined ||
    instructionFiles.length === 0 ||
    branchNaming === undefined ||
    setupArgvs === undefined ||
    (kind !== "native" && kind !== "repository") ||
    (value.cleanup !== "native-safe" && value.cleanup !== "repository") ||
    (value.remote !== "local-only" && value.remote !== "repository")
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
      "snapshot.check",
      "snapshot.accept",
      "worktree.preflight",
      "worktree.prepare",
      "implementor.launch.prepare",
      "implementor.launch.record",
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
        attempt > maxAttempts ||
        (role.harness === "pi" && implementSkillPath === undefined) ||
        (role.harness === "claude" && skillValue !== null && skillValue !== undefined)
      ) {
        return yield* invalidRequest(
          "`implementor.launch.prepare` requires a two-digit ticket, runtime identifiers, role, prompt, valid attempt bounds, and an explicit implement_skill_path only for Pi.",
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
