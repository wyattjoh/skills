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
  | "snapshot.check"
  | "snapshot.accept";

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
    if (
      operation !== "preflight" &&
      operation !== "state.validate" &&
      operation !== "snapshot.check" &&
      operation !== "snapshot.accept"
    ) {
      return yield* invalidRequest(
        "Request `operation` must be `preflight`, `state.validate`, `snapshot.check`, or `snapshot.accept`.",
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
      operation,
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
