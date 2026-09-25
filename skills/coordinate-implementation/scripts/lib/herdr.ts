import { Effect } from "effect";
import { agentsNamed, HerdrWaitError, herdrError, readSnapshot } from "./herdr-protocol.ts";

export { HerdrWaitError } from "./herdr-protocol.ts";

/**
 * Exact live Herdr identity required by compatibility recovery.
 */
export type HerdrWorkerInspectionInput = {
  socketPath: string;
  timeoutMs: number;
  session: string;
  paneId: string;
};

/**
 * Live Herdr worker identity returned after exact session and pane validation.
 */
export type HerdrWorkerInspection = {
  session: string;
  pane_id: string;
  status: "idle" | "working" | "blocked" | "done" | "unknown";
};

/**
 * Reads one Herdr snapshot and requires an exact live session and pane identity.
 *
 * @param input - Socket, timeout, and exact worker identity to inspect.
 * @returns An Effect containing the current recognized agent status.
 */
export const inspectHerdrWorker = (
  input: HerdrWorkerInspectionInput,
): Effect.Effect<HerdrWorkerInspection, HerdrWaitError> =>
  Effect.tryPromise({
    try: async () => {
      const snapshot = await readSnapshot(input.socketPath, Date.now() + input.timeoutMs, Date.now);
      const named = agentsNamed(snapshot, input.session);
      if (named.length === 0) {
        throw herdrError(
          "herdr.worker_missing",
          `Herdr could not find worker session \`${input.session}\` in its machine-readable snapshot.`,
          "Keep the recorded worker alive and restore its exact session identity before recovery.",
        );
      }
      if (named.length > 1) {
        throw herdrError(
          "herdr.worker_ambiguous",
          `Herdr reported multiple agents named \`${input.session}\`.`,
          "Restore a unique worker session name before recovery.",
        );
      }
      const worker = named[0]!;
      if (worker.paneId !== input.paneId) {
        throw herdrError(
          "herdr.worker_pane_mismatch",
          `Worker \`${input.session}\` is in pane \`${worker.paneId}\`, not recorded pane \`${input.paneId}\`.`,
          "Refresh run state only through an explicit pane-migration operation before recovery.",
        );
      }
      return { session: input.session, pane_id: worker.paneId, status: worker.status };
    },
    catch: (error) =>
      error instanceof HerdrWaitError
        ? error
        : herdrError(
            "herdr.inspect_failed",
            `Could not inspect the existing Herdr worker: ${(error as Error).message}`,
            "Verify the Herdr socket and recorded worker identity before recovery.",
          ),
  });
