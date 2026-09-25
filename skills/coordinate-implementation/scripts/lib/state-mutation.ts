import { Context, Data, Effect } from "effect";
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { CliIssue } from "./contract.ts";
import { ensureRunId, publishRun, recordGlobalWarning } from "./global-state.ts";

/**
 * Controlled lifecycle hooks used to coordinate deterministic mutation tests.
 */
export type StateMutationHooks = {
  afterRead: ((markdown: string) => Promise<void>) | undefined;
  onLockContended: (() => Promise<void>) | undefined;
};

/**
 * One state transformation result and its caller-visible value.
 */
export type StateMutationUpdate<Result> = {
  markdown: string | undefined;
  result: Result;
};

/**
 * Typed lock, read, or atomic replacement failure for run-state mutation.
 */
export class StateMutationError extends Data.TaggedError("StateMutationError")<{
  kind: "lock_busy" | "io_failed";
  message: string;
}> {}

class StateLockBusyError extends Error {}

/**
 * Raised as a defect when {@link StateMutationGuard} rejects a mutation, so operation-specific
 * error mappers cannot rename it. The Engine converts it back into a typed failure.
 */
export class StateGuardRejected extends Data.TaggedError("StateGuardRejected")<{
  issue: CliIssue;
}> {}

/**
 * Check run against the latest RESUME.md text under the state lock before every mutation in
 * scope. It returns null to allow the write, or the issue that refuses it. The Engine provides
 * its lease fence here so a superseded generation can never write.
 */
export const StateMutationGuard = Context.Reference<(markdown: string) => CliIssue | null>(
  "coordinate-implementation/StateMutationGuard",
  { defaultValue: () => () => null },
);

type LockRecord = {
  pid: number;
  token: string;
  created_at: string;
};

type LockHandle = {
  path: string;
  token: string;
};

const isAlreadyExists = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "EEXIST";

const parseLockRecord = (raw: string): LockRecord | null => {
  try {
    const value = JSON.parse(raw) as Partial<LockRecord>;
    if (
      typeof value.pid !== "number" ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.token !== "string" ||
      value.token.length === 0 ||
      typeof value.created_at !== "string"
    ) {
      return null;
    }
    return { pid: value.pid, token: value.token, created_at: value.created_at };
  } catch {
    return null;
  }
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
};

const recoverDeadLockOwner = async (lockPath: string): Promise<void> => {
  const recoveryPath = `${lockPath}.recovery`;
  try {
    await mkdir(recoveryPath);
  } catch (error) {
    if (isAlreadyExists(error)) return;
    throw error;
  }

  try {
    const details = await stat(lockPath).catch(() => null);
    if (details === null || Date.now() - details.mtimeMs <= 30_000) return;
    const record = await readFile(lockPath, "utf8")
      .then(parseLockRecord)
      .catch(() => null);
    if (record === null || processIsAlive(record.pid)) return;
    await rm(lockPath, { force: true });
  } finally {
    await rm(recoveryPath, { recursive: true, force: true });
  }
};

const acquireLock = async (
  statePath: string,
  onContended: (() => Promise<void>) | undefined,
): Promise<LockHandle> => {
  const lockPath = `${statePath}.state-lock`;
  const token = randomUUID();
  const candidatePath = `${lockPath}.${process.pid}.${token}.candidate`;
  const record: LockRecord = { pid: process.pid, token, created_at: new Date().toISOString() };
  await writeFile(candidatePath, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
  const deadline = Date.now() + 2_000;
  try {
    while (Date.now() < deadline) {
      try {
        await link(candidatePath, lockPath);
        return { path: lockPath, token };
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        if (onContended !== undefined) await onContended();
        await recoverDeadLockOwner(lockPath);
        await Bun.sleep(20);
      }
    }
  } finally {
    await rm(candidatePath, { force: true });
  }
  throw new StateLockBusyError("Run state is being updated by another process.");
};

const releaseLock = async (lock: LockHandle): Promise<void> => {
  const record = await readFile(lock.path, "utf8")
    .then(parseLockRecord)
    .catch(() => null);
  if (record?.token === lock.token) await rm(lock.path, { force: true });
};

const writeStateAtomically = async (path: string, markdown: string): Promise<void> => {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const mode = (await stat(path)).mode;
  try {
    await writeFile(temporary, markdown, { mode });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};

const stateIo = <Result>(
  action: () => Promise<Result>,
): Effect.Effect<Result, StateMutationError> =>
  Effect.tryPromise({
    try: action,
    catch: (error) =>
      new StateMutationError({
        kind: error instanceof StateLockBusyError ? "lock_busy" : "io_failed",
        message: (error as Error).message,
      }),
  });

/**
 * Serializes a read-transform-replace operation against every run-state writer.
 *
 * The lock uses a same-machine process record for stale-owner recovery and a
 * claimant token for ownership-checked release. Replacement occurs atomically
 * in the state file's directory.
 *
 * @param statePath - Path to the mutable RESUME.md document.
 * @param transform - Domain transformation applied to the latest locked text.
 * @param hooks - Optional deterministic lifecycle hooks for tests.
 * @returns An Effect containing the transformation's caller-visible result.
 */
export const mutateStateFile = <Result, DomainError>(
  statePath: string,
  transform: (markdown: string) => Effect.Effect<StateMutationUpdate<Result>, DomainError>,
  hooks: StateMutationHooks | undefined = undefined,
): Effect.Effect<Result, StateMutationError | DomainError> =>
  withStateLock(
    statePath,
    Effect.gen(function* () {
      const markdown = yield* stateIo(() => readFile(statePath, "utf8"));
      const afterRead = hooks?.afterRead;
      if (afterRead !== undefined) {
        yield* stateIo(() => afterRead(markdown));
      }
      const refusal = (yield* StateMutationGuard)(markdown);
      if (refusal !== null) return yield* Effect.die(new StateGuardRejected({ issue: refusal }));
      const identified = ensureRunId(markdown);
      const update = yield* transform(identified);
      const updatedMarkdown = update.markdown ?? identified;
      if (updatedMarkdown !== markdown) {
        yield* stateIo(() => writeStateAtomically(statePath, updatedMarkdown));
        yield* publishRun(statePath, updatedMarkdown, "mutation");
      }
      return update.result;
    }),
    hooks?.onLockContended,
  );

/**
 * Runs one effect while holding the run-state lock shared by every writer.
 *
 * @param statePath - Path to the mutable RESUME.md document.
 * @param effect - Work performed under the lock.
 * @param onContended - Optional deterministic contention hook for tests.
 * @returns The effect's result, with lock failures typed as StateMutationError.
 */
export const withStateLock = <Result, DomainError>(
  statePath: string,
  effect: Effect.Effect<Result, DomainError>,
  onContended: (() => Promise<void>) | undefined = undefined,
): Effect.Effect<Result, StateMutationError | DomainError> =>
  Effect.acquireUseRelease(
    stateIo(() => acquireLock(statePath, onContended)),
    () => effect,
    (lock) => stateIo(() => releaseLock(lock)).pipe(Effect.ignore),
  );

/**
 * Refreshes the global run file's heartbeat under the run-state lock. Backfills
 * a missing `Run id:` first. Every failure becomes a response warning.
 *
 * @param statePath - Path to the mutable RESUME.md document.
 * @returns An Effect that never fails.
 */
export const heartbeatStateFile = (statePath: string): Effect.Effect<void> =>
  withStateLock(
    statePath,
    Effect.gen(function* () {
      const markdown = yield* stateIo(() => readFile(statePath, "utf8"));
      const identified = ensureRunId(markdown);
      if (identified !== markdown) {
        yield* stateIo(() => writeStateAtomically(statePath, identified));
      }
      yield* publishRun(statePath, identified, "heartbeat");
    }),
  ).pipe(
    Effect.catch((error) =>
      Effect.sync(() =>
        recordGlobalWarning({
          code: "global_state.heartbeat_failed",
          message: `Could not refresh the global heartbeat: ${error.message}`,
          remediation: "Verify RESUME.md is readable and not locked, then continue waiting.",
        }),
      ),
    ),
  );
