import { Data, Effect } from "effect";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CliIssue } from "./contract.ts";
import { replaceFileAtomically } from "./fs-atomic.ts";
import { mutateStateFile, StateMutationError } from "./state-mutation.ts";
import { utcSeconds } from "./values.ts";

/**
 * Durable identity of the engine allowed to mutate one run.
 */
export type EngineLease = {
  generation: number;
  pid: number;
  host: string;
  pane: string | null;
  script_sha256: string;
  claimed_at: string;
  released_at: string | null;
};

/**
 * Liveness proof the engine rewrites on a fixed interval.
 */
export type EngineHeartbeat = {
  generation: number;
  pid: number;
  at: string;
};

/**
 * Observed engine state derived from the lease and heartbeat.
 */
export type EngineLiveness = "none" | "released" | "alive" | "stale";

/**
 * Inputs for claiming the next engine generation.
 */
export type EngineClaimInput = {
  statePath: string;
  expectedGeneration: number;
  pid: number;
  host: string;
  pane: string | null;
  scriptSha256: string;
  now: Date;
};

/**
 * Typed lease, fencing, or heartbeat failure.
 */
export class EngineLeaseError extends Data.TaggedError("EngineLeaseError")<{
  issue: CliIssue;
}> {}

const leaseError = (code: string, message: string, remediation: string): EngineLeaseError =>
  new EngineLeaseError({ issue: { code, message, remediation } });

/**
 * Normalizes lease and state-lock failures into one CLI issue.
 *
 * @param error - Lease or state mutation failure.
 * @returns A stable issue with remediation.
 */
export const leaseIssue = (error: EngineLeaseError | StateMutationError): CliIssue =>
  error instanceof EngineLeaseError
    ? error.issue
    : {
        code: `state.${error.kind}`,
        message: error.message,
        remediation: "Retry after the current RESUME.md writer releases the state lock.",
      };

const SECTION = /^## Engine lease\s*\n+```json\n([\s\S]*?)\n```\s*$/mu;

/**
 * Parses the engine lease section, returning null when no engine ever claimed the run.
 *
 * @param markdown - Current RESUME.md text.
 * @returns The lease, or null when the section is absent.
 */
export const parseEngineLease = (markdown: string): EngineLease | null => {
  const match = SECTION.exec(markdown);
  if (match === null) return null;
  let value: Partial<EngineLease>;
  try {
    value = JSON.parse(match[1]!) as Partial<EngineLease>;
  } catch {
    throw leaseError(
      "engine.lease_malformed",
      "The `## Engine lease` section is not valid JSON.",
      "Stop every engine for this run and restore the section from the last event log entry.",
    );
  }
  if (
    typeof value.generation !== "number" ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    typeof value.pid !== "number" ||
    typeof value.host !== "string" ||
    typeof value.script_sha256 !== "string" ||
    typeof value.claimed_at !== "string"
  ) {
    throw leaseError(
      "engine.lease_malformed",
      "The `## Engine lease` section is missing required fields.",
      "Stop every engine for this run and restore the section from the last event log entry.",
    );
  }
  return {
    generation: value.generation,
    pid: value.pid,
    host: value.host,
    pane: typeof value.pane === "string" ? value.pane : null,
    script_sha256: value.script_sha256,
    claimed_at: value.claimed_at,
    released_at: typeof value.released_at === "string" ? value.released_at : null,
  };
};

const renderLease = (lease: EngineLease): string =>
  `## Engine lease\n\n\`\`\`json\n${JSON.stringify(lease, null, 2)}\n\`\`\`\n`;

const replaceLease = (markdown: string, lease: EngineLease): string => {
  const rendered = renderLease(lease);
  if (SECTION.test(markdown)) return markdown.replace(SECTION, rendered.trimEnd());
  return `${markdown.trimEnd()}\n\n${rendered}`;
};

const fromUnknown = (error: unknown): EngineLeaseError | StateMutationError =>
  error instanceof EngineLeaseError || error instanceof StateMutationError
    ? error
    : leaseError(
        "engine.lease_io_failed",
        `Engine lease operation failed: ${(error as Error).message}`,
        "Verify RESUME.md is readable and writable, then retry.",
      );

const parseEffect = (markdown: string): Effect.Effect<EngineLease | null, EngineLeaseError> =>
  Effect.try({
    try: () => parseEngineLease(markdown),
    catch: (error) =>
      error instanceof EngineLeaseError
        ? error
        : leaseError("engine.lease_malformed", String(error), "Repair the engine lease section."),
  });

/**
 * Reads the current engine lease without taking the state lock.
 *
 * @param statePath - Run RESUME.md path.
 * @returns An Effect containing the lease or null.
 */
export const readEngineLease = (
  statePath: string,
): Effect.Effect<EngineLease | null, EngineLeaseError> =>
  Effect.tryPromise({
    try: () => readFile(statePath, "utf8"),
    catch: (error) => fromUnknown(error) as EngineLeaseError,
  }).pipe(Effect.flatMap(parseEffect));

/**
 * Claims the next engine generation when the caller observed the current one.
 *
 * @param input - Expected generation and the claimant's identity.
 * @returns An Effect containing the new lease.
 */
export const claimEngineLease = (
  input: EngineClaimInput,
): Effect.Effect<EngineLease, EngineLeaseError | StateMutationError> =>
  mutateStateFile(input.statePath, (markdown) =>
    Effect.gen(function* () {
      const current = yield* parseEffect(markdown);
      const observed = current?.generation ?? 0;
      if (observed !== input.expectedGeneration) {
        return yield* leaseError(
          "engine.claim_stale",
          `Engine generation changed before this claim; expected ${input.expectedGeneration}, found ${observed}.`,
          "Re-read the lease and decide again whether an engine is already running.",
        );
      }
      const lease: EngineLease = {
        generation: observed + 1,
        pid: input.pid,
        host: input.host,
        pane: input.pane,
        script_sha256: input.scriptSha256,
        claimed_at: utcSeconds(input.now),
        released_at: null,
      };
      return { markdown: replaceLease(markdown, lease), result: lease };
    }),
  );

/**
 * Tests whether `generation` still holds an unreleased lease.
 *
 * @param lease - Lease parsed from RESUME.md, or null when absent.
 * @param generation - Generation the caller claimed.
 * @returns True while that generation owns the run.
 */
export const leaseHeld = (lease: EngineLease | null, generation: number): boolean =>
  lease !== null && lease.generation === generation && lease.released_at === null;

/**
 * Runs a state mutation only while the caller still holds the given generation.
 *
 * @param statePath - Run RESUME.md path.
 * @param generation - Generation the calling engine claimed.
 * @param transform - Mutation applied under the same state lock as the fence check.
 * @returns An Effect containing the transform result.
 */
export const fencedMutate = <Result, DomainError>(
  statePath: string,
  generation: number,
  transform: (
    markdown: string,
  ) => Effect.Effect<{ markdown: string | undefined; result: Result }, DomainError>,
): Effect.Effect<Result, EngineLeaseError | StateMutationError | DomainError> =>
  mutateStateFile(statePath, (markdown) =>
    Effect.gen(function* () {
      const lease = yield* parseEffect(markdown);
      if (!leaseHeld(lease, generation)) {
        return yield* leaseError(
          "engine.lease_lost",
          `Engine generation ${generation} no longer holds this run.`,
          "Exit this engine; the current lease holder owns every further mutation.",
        );
      }
      return yield* transform(markdown);
    }),
  );

/**
 * Marks the caller's generation released so the next start can claim without waiting.
 *
 * @param statePath - Run RESUME.md path.
 * @param generation - Generation being released.
 * @param now - Release time.
 * @returns An Effect containing the released lease.
 */
export const releaseEngineLease = (
  statePath: string,
  generation: number,
  now: Date,
): Effect.Effect<EngineLease, EngineLeaseError | StateMutationError> =>
  fencedMutate(statePath, generation, (markdown) =>
    Effect.gen(function* () {
      const lease = (yield* parseEffect(markdown))!;
      const released = { ...lease, released_at: utcSeconds(now) };
      return { markdown: replaceLease(markdown, released), result: released };
    }),
  );

/**
 * Heartbeat file path beside RESUME.md.
 *
 * @param statePath - Run RESUME.md path.
 * @returns The heartbeat JSON path.
 */
export const heartbeatPath = (statePath: string): string =>
  join(dirname(statePath), "engine-heartbeat.json");

/**
 * Atomically rewrites the engine heartbeat.
 *
 * @param statePath - Run RESUME.md path.
 * @param heartbeat - Current generation, pid, and time.
 * @returns An Effect that completes after the rename.
 */
export const writeEngineHeartbeat = (
  statePath: string,
  heartbeat: EngineHeartbeat,
): Effect.Effect<void, EngineLeaseError> =>
  Effect.tryPromise({
    try: () => replaceFileAtomically(heartbeatPath(statePath), `${JSON.stringify(heartbeat)}\n`),
    catch: (error) => fromUnknown(error) as EngineLeaseError,
  });

/**
 * Reads the heartbeat, returning null when it is absent or unreadable.
 *
 * @param statePath - Run RESUME.md path.
 * @returns An Effect containing the heartbeat or null.
 */
export const readEngineHeartbeat = (statePath: string): Effect.Effect<EngineHeartbeat | null> =>
  Effect.promise(async () => {
    try {
      const value = JSON.parse(await readFile(heartbeatPath(statePath), "utf8")) as EngineHeartbeat;
      return typeof value.generation === "number" && typeof value.at === "string" ? value : null;
    } catch {
      return null;
    }
  });

/**
 * Classifies whether the leased engine is alive. A fresh claim counts as a
 * heartbeat, so the gap before the first heartbeat write is not stale.
 *
 * @param lease - Current lease or null.
 * @param heartbeat - Latest heartbeat or null.
 * @param now - Observation time.
 * @param staleAfterMs - Heartbeat age after which the engine is stale.
 * @returns The observed liveness.
 */
export const engineLiveness = (
  lease: EngineLease | null,
  heartbeat: EngineHeartbeat | null,
  now: Date,
  staleAfterMs: number,
): EngineLiveness => {
  if (lease === null) return "none";
  if (lease.released_at !== null) return "released";
  const lastSign =
    heartbeat !== null && heartbeat.generation === lease.generation
      ? Date.parse(heartbeat.at)
      : Date.parse(lease.claimed_at);
  return now.getTime() - lastSign <= staleAfterMs ? "alive" : "stale";
};

/**
 * Heartbeat age after which an engine is considered stale.
 */
export const STALE_AFTER_MS = 45_000;

/**
 * Returns the live engine lease that currently owns the run, or null.
 *
 * @param statePath - Run RESUME.md path.
 * @param now - Observation time.
 * @returns An Effect containing the live lease or null; unreadable leases count as live.
 */
export const liveEngineLease = (
  statePath: string,
  now: Date,
): Effect.Effect<EngineLease | null, EngineLeaseError> =>
  Effect.gen(function* () {
    const lease = yield* readEngineLease(statePath);
    const heartbeat = yield* readEngineHeartbeat(statePath);
    return engineLiveness(lease, heartbeat, now, STALE_AFTER_MS) === "alive" ? lease : null;
  });

/**
 * Reports whether a process id is alive on this host.
 *
 * @param pid - Process id to probe.
 * @returns True when signal 0 succeeds or is denied by permissions.
 */
export const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
