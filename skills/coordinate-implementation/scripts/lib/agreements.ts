import { Data, Effect } from "effect";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgreementsUpdateInput, CliIssue } from "./contract.ts";
import {
  agreementsFilePath,
  GLOBAL_AGREEMENTS_SCHEMA_VERSION,
  globalStateRoot,
  parseRunId,
  readAgreements,
  resolveRepository,
  writeJsonAtomically,
  type GlobalAgreementsFile,
} from "./global-state.ts";
import { withStateLock, type StateMutationError } from "./state-mutation.ts";

/**
 * Result of one accepted cross-run agreements replacement.
 */
export type AgreementsUpdateResult = {
  path: string;
  agreements: GlobalAgreementsFile;
  previous_owner_run_id: string | null;
};

/**
 * Typed failure raised when cross-run agreements cannot be replaced.
 */
export class AgreementsError extends Data.TaggedError("AgreementsError")<{
  issue: CliIssue;
}> {}

const agreementsError = (code: string, message: string, remediation: string): AgreementsError =>
  new AgreementsError({ issue: { code, message, remediation } });

const fromMutationError = (error: StateMutationError | AgreementsError): AgreementsError =>
  error instanceof AgreementsError
    ? error
    : agreementsError(
        error.kind === "lock_busy" ? "agreements.busy" : "agreements.io_failed",
        `Could not update cross-run agreements: ${error.message}`,
        "Retry the same request after the competing writer finishes.",
      );

const io = <Result>(action: () => Promise<Result>): Effect.Effect<Result, AgreementsError> =>
  Effect.tryPromise({
    try: action,
    catch: (error) =>
      agreementsError(
        "agreements.io_failed",
        `Could not update cross-run agreements: ${(error as Error).message}`,
        "Verify the global state directory is writable, then retry the same request.",
      ),
  });

/**
 * Replaces the repository's cross-run agreements. Only the recorded owner run
 * may write; a transfer requires explicit user authority.
 *
 * @param input - Calling run, replacement agreements, and transfer authority.
 * @param env - Environment used to resolve the global state root.
 * @returns An Effect containing the written agreements and prior owner.
 */
export const updateAgreements = (
  input: AgreementsUpdateInput,
  env: Record<string, string | undefined> = process.env,
): Effect.Effect<AgreementsUpdateResult, AgreementsError> =>
  Effect.gen(function* () {
    const runId = parseRunId(yield* io(() => readFile(input.statePath, "utf8")));
    if (runId === null) {
      return yield* agreementsError(
        "agreements.run_id_missing",
        "The caller's RESUME.md has no valid `Run id:` line.",
        "Record one lowercase UUID as `Run id: <uuid>` in the caller's RESUME.md, then retry.",
      );
    }
    const runFolder = yield* io(() => realpath(dirname(input.statePath)));
    const repo = yield* io(() => resolveRepository(runFolder));
    if (repo.common_dir === null) {
      return yield* agreementsError(
        "agreements.repository_unresolved",
        "The run folder is not inside a Git repository.",
        "Run the coordinator from the repository's integration checkout.",
      );
    }
    const commonDir = repo.common_dir;
    const root = yield* io(async () => globalStateRoot(env));
    const path = agreementsFilePath(root, commonDir);
    yield* io(() => mkdir(dirname(path), { recursive: true, mode: 0o700 }));

    return yield* withStateLock(
      path,
      Effect.gen(function* () {
        const existing = yield* io(() => readAgreements(path));
        const previousOwner = existing?.owner_run_id ?? null;
        if (previousOwner !== null && previousOwner !== runId && !input.transferOwnership) {
          return yield* agreementsError(
            "agreements.not_owner",
            `Cross-run agreements are owned by run ${previousOwner}.`,
            "Ask the owning coordinator to update them, or obtain explicit user authority and retry with transfer_ownership and user_authorized.",
          );
        }
        const agreements: GlobalAgreementsFile = {
          kind: "agreements",
          schema_version: GLOBAL_AGREEMENTS_SCHEMA_VERSION,
          common_dir: commonDir,
          owner_run_id: runId,
          merge_order: input.mergeOrder,
          shared_files: input.sharedFiles.map((entry) => ({
            path: entry.path,
            owner_prefix: entry.ownerPrefix,
          })),
          updated_at: new Date().toISOString(),
        };
        yield* io(() => writeJsonAtomically(path, agreements));
        return { path, agreements, previous_owner_run_id: previousOwner };
      }),
    ).pipe(Effect.mapError(fromMutationError));
  });
