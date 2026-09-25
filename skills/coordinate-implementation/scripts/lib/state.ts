import { Data, Effect } from "effect";
import { readFile } from "node:fs/promises";
import type { CliIssue } from "./contract.ts";

/**
 * Markdown run-state schema version supported by this helper.
 */
export const RUN_STATE_SCHEMA_VERSION = 2 as const;

/**
 * Validated identity of a Markdown run-state document.
 */
export type StateSummary = {
  path: string;
  schema_version: typeof RUN_STATE_SCHEMA_VERSION;
};

/**
 * Typed read or validation failure for a Markdown run-state document.
 */
export class StateError extends Data.TaggedError("StateError")<{
  issue: CliIssue;
}> {}

const repairRemediation = "Repair the state manually. Automatic state migration is not supported.";

/**
 * Validates the explicit schema marker in a Markdown run-state document.
 *
 * @param path - Display path included in the returned state summary.
 * @param markdown - Complete Markdown state document.
 * @returns An Effect containing the schema-2 state summary or a typed validation error.
 */
export const validateStateText = (
  path: string,
  markdown: string,
): Effect.Effect<StateSummary, StateError> =>
  Effect.gen(function* () {
    const schemaLines = markdown
      .split(/\r?\n/u)
      .filter((line) => line.trimStart().startsWith("Schema version:"));

    if (schemaLines.length === 0) {
      return yield* new StateError({
        issue: {
          code: "state.schema_missing",
          message: "RESUME.md is missing the required `Schema version:` field.",
          remediation: repairRemediation,
        },
      });
    }
    if (schemaLines.length > 1) {
      return yield* new StateError({
        issue: {
          code: "state.schema_malformed",
          message: "RESUME.md contains more than one `Schema version:` field.",
          remediation: repairRemediation,
        },
      });
    }

    const value = schemaLines[0]!.slice(schemaLines[0]!.indexOf(":") + 1).trim();
    if (!/^\d+$/u.test(value)) {
      return yield* new StateError({
        issue: {
          code: "state.schema_malformed",
          message: "RESUME.md has a malformed `Schema version:` value; expected an integer.",
          remediation: repairRemediation,
        },
      });
    }

    const version = Number(value);
    if (version === 1) {
      return yield* new StateError({
        issue: {
          code: "state.schema_unsupported",
          message:
            "RESUME.md uses schema version 1, whose serialized finalization slot this helper no longer supports; it supports version 2.",
          remediation:
            "Finish this run with the previous skill version or start a new run. Schema-1 state is never migrated.",
        },
      });
    }
    if (version !== RUN_STATE_SCHEMA_VERSION) {
      return yield* new StateError({
        issue: {
          code: "state.schema_unsupported",
          message: `RESUME.md uses unsupported schema version ${version}; this helper supports version 2.`,
          remediation:
            "Use a helper that supports this state schema or recover the run manually. Automatic state migration is not supported.",
        },
      });
    }

    return { path, schema_version: RUN_STATE_SCHEMA_VERSION };
  });

/**
 * Reads and validates a schema-version-2 Markdown run-state document without modifying it.
 *
 * @param path - Path to the run's RESUME.md file.
 * @returns An Effect containing the validated state summary or a typed read or validation error.
 */
export const validateStateFile = (path: string): Effect.Effect<StateSummary, StateError> =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (error) =>
      new StateError({
        issue: {
          code: "state.read_failed",
          message: `Could not read run state at ${path}: ${(error as Error).message}`,
          remediation: "Verify the state path exists and is readable, then retry.",
        },
      }),
  }).pipe(Effect.flatMap((markdown) => validateStateText(path, markdown)));
