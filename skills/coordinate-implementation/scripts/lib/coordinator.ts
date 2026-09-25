import { Data, Effect } from "effect";
import { readFile } from "node:fs/promises";
import type {
  CliIssue,
  CoordinatorClaimInput,
  CoordinatorReadyInput,
  CoordinatorVerifyInput,
  HarnessName,
  RoleRecord,
} from "./contract.ts";
import { fieldBlockPattern, readFieldBlock, roleFromFields, sameRole } from "./resume-sections.ts";
import {
  mutateStateFile,
  StateMutationError,
  type StateMutationHooks,
  type StateMutationUpdate,
} from "./state-mutation.ts";
import { validateStateText } from "./state.ts";

/**
 * Readiness states in the durable coordinator ownership record.
 */
export type CoordinatorReadiness = "claiming" | "ready";

/**
 * Durable coordinator owner protected by generation compare-and-swap.
 */
export type CoordinatorOwnership = {
  generation: number;
  pane: string;
  harness: HarnessName;
  model: string;
  effort: string;
  readiness: CoordinatorReadiness;
  marker: string;
};

/**
 * Typed coordinator ownership failure returned through the CLI envelope.
 */
export class CoordinatorError extends Data.TaggedError("CoordinatorError")<{
  issue: CliIssue;
}> {}

const coordinatorError = (code: string, message: string, remediation: string): CoordinatorError =>
  new CoordinatorError({ issue: { code, message, remediation } });

const parseFields = (markdown: string, label: string): Record<string, string> => {
  const fields = readFieldBlock(markdown, label);
  if (typeof fields !== "string") return fields;
  throw coordinatorError(
    "state.coordinator_fields_malformed",
    fields === "block_count"
      ? `RESUME.md must contain exactly one \`${label}:\` block.`
      : `RESUME.md has malformed or duplicate fields in \`${label}:\`.`,
    "Repair the schema-2 role and ownership blocks manually, then retry.",
  );
};

const parseCoordinatorRole = (markdown: string): RoleRecord => {
  const role = roleFromFields(parseFields(markdown, "Coordinator"));
  if (role !== null) return role;
  throw coordinatorError(
    "state.coordinator_role_malformed",
    "RESUME.md has an incomplete or malformed Coordinator role record.",
    "Persist harness, model, and effort under `Coordinator:` before takeover.",
  );
};

const parseOwnership = (markdown: string): CoordinatorOwnership => {
  const fields = parseFields(markdown, "Coordinator ownership");
  const generation = Number(fields.generation);
  const readiness = fields.readiness;
  const harness = fields.harness;
  if (
    !Number.isInteger(generation) ||
    generation < 0 ||
    fields.pane === undefined ||
    (harness !== "claude" && harness !== "pi") ||
    fields.model === undefined ||
    fields.effort === undefined ||
    (readiness !== "claiming" && readiness !== "ready") ||
    fields.marker === undefined
  ) {
    throw coordinatorError(
      "state.coordinator_ownership_malformed",
      "RESUME.md has an incomplete or malformed Coordinator ownership record.",
      "Persist generation, pane, harness, model, effort, readiness, and marker under `Coordinator ownership:`.",
    );
  }
  return {
    generation,
    pane: fields.pane,
    harness,
    model: fields.model,
    effort: fields.effort,
    readiness,
    marker: fields.marker,
  };
};

const renderOwnership = (ownership: CoordinatorOwnership): string =>
  [
    "Coordinator ownership:",
    `  generation: ${ownership.generation}`,
    `  pane: ${ownership.pane}`,
    `  harness: ${ownership.harness}`,
    `  model: ${ownership.model}`,
    `  effort: ${ownership.effort}`,
    `  readiness: ${ownership.readiness}`,
    `  marker: ${ownership.marker}`,
    "",
  ].join("\n");

const replaceOwnership = (markdown: string, ownership: CoordinatorOwnership): string =>
  markdown.replace(fieldBlockPattern("Coordinator ownership"), renderOwnership(ownership));

const fromUnknown = (error: unknown): CoordinatorError => {
  if (error instanceof CoordinatorError) return error;
  if (error instanceof StateMutationError && error.kind === "lock_busy") {
    return coordinatorError(
      "coordinator.lock_busy",
      "Coordinator ownership is being updated by another process.",
      "Wait briefly, re-read RESUME.md, and retry with its current generation and pane.",
    );
  }
  const detail = error instanceof StateMutationError ? error.message : (error as Error).message;
  return coordinatorError(
    "coordinator.state_io_failed",
    `Could not update coordinator state: ${detail}`,
    "Verify RESUME.md and its directory are readable and writable, then retry.",
  );
};

const validateMarkdown = (path: string, markdown: string): Effect.Effect<void, CoordinatorError> =>
  validateStateText(path, markdown).pipe(
    Effect.mapError(
      (error) =>
        new CoordinatorError({
          issue: error.issue,
        }),
    ),
    Effect.asVoid,
  );

const ownershipUpdate = <Result>(
  statePath: string,
  update: (markdown: string) => StateMutationUpdate<Result>,
  hooks: StateMutationHooks | undefined,
): Effect.Effect<Result, CoordinatorError> =>
  mutateStateFile(
    statePath,
    (markdown) =>
      Effect.gen(function* () {
        yield* validateMarkdown(statePath, markdown);
        return yield* Effect.try({
          try: () => update(markdown),
          catch: fromUnknown,
        });
      }),
    hooks,
  ).pipe(Effect.mapError(fromUnknown));

const readState = (path: string): Effect.Effect<string, CoordinatorError> =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: fromUnknown,
  }).pipe(Effect.tap((markdown) => validateMarkdown(path, markdown)));

/**
 * Atomically claims the next coordinator generation from an expected predecessor.
 *
 * @param input - Expected owner, selected successor pane, and persisted successor role.
 * @param hooks - Optional deterministic state-mutation hooks for tests.
 * @returns An Effect containing the claimed ownership in the `claiming` state.
 */
export const claimCoordinator = (
  input: CoordinatorClaimInput,
  hooks: StateMutationHooks | undefined = undefined,
): Effect.Effect<CoordinatorOwnership, CoordinatorError> =>
  ownershipUpdate(
    input.statePath,
    (markdown) => {
      const ownership = parseOwnership(markdown);
      if (input.successorPane === ownership.pane) {
        throw coordinatorError(
          "coordinator.same_pane",
          `Pane \`${input.successorPane}\` already owns this run; takeover is unnecessary.`,
          "Continue in the current pane without changing the ownership generation.",
        );
      }
      if (
        ownership.generation !== input.expectedGeneration ||
        ownership.pane !== input.expectedPredecessorPane ||
        !sameRole(ownership, input.expectedPredecessorRole)
      ) {
        throw coordinatorError(
          "coordinator.claim_stale",
          `Coordinator ownership changed before this claim; expected generation ${input.expectedGeneration}, predecessor pane \`${input.expectedPredecessorPane}\`, and role ${input.expectedPredecessorRole.harness}/${input.expectedPredecessorRole.model}/${input.expectedPredecessorRole.effort}.`,
          "Re-read RESUME.md and restart takeover from the current owner; do not retry with stale values.",
        );
      }
      const persistedRole = parseCoordinatorRole(markdown);
      if (!sameRole(persistedRole, input.successorRole)) {
        throw coordinatorError(
          "coordinator.role_mismatch",
          "The successor role does not match the persisted Coordinator role.",
          "Persist and validate the selected Coordinator role before launching or claiming.",
        );
      }
      const generation = ownership.generation + 1;
      const claimed: CoordinatorOwnership = {
        generation,
        pane: input.successorPane,
        harness: input.successorRole.harness,
        model: input.successorRole.model,
        effort: input.successorRole.effort,
        readiness: "claiming",
        marker: `coordinator-ready-${generation}-${input.successorPane}`,
      };
      return { markdown: replaceOwnership(markdown, claimed), result: claimed };
    },
    hooks,
  );

/**
 * Atomically marks the currently claimed coordinator generation ready.
 *
 * @param input - Claimed generation, pane, and exact marker returned by the claim.
 * @param hooks - Optional deterministic state-mutation hooks for tests.
 * @returns An Effect containing the ready ownership record.
 */
export const markCoordinatorReady = (
  input: CoordinatorReadyInput,
  hooks: StateMutationHooks | undefined = undefined,
): Effect.Effect<CoordinatorOwnership, CoordinatorError> =>
  ownershipUpdate(
    input.statePath,
    (markdown) => {
      const ownership = parseOwnership(markdown);
      if (
        ownership.generation !== input.generation ||
        ownership.pane !== input.pane ||
        ownership.marker !== input.marker ||
        ownership.readiness !== "claiming"
      ) {
        throw coordinatorError(
          "coordinator.ready_stale",
          "Coordinator ownership no longer matches this readiness update.",
          "Re-read RESUME.md. Only the current claiming successor may mark itself ready.",
        );
      }
      const ready: CoordinatorOwnership = { ...ownership, readiness: "ready" };
      return { markdown: replaceOwnership(markdown, ready), result: ready };
    },
    hooks,
  );

/**
 * Verifies that state is ready and matches a marker independently observed in Herdr.
 *
 * @param input - Expected generation, pane, and marker read from successor output.
 * @returns An Effect containing the verified current owner.
 */
export const verifyCoordinator = (
  input: CoordinatorVerifyInput,
): Effect.Effect<{ verified: true; ownership: CoordinatorOwnership }, CoordinatorError> =>
  Effect.gen(function* () {
    const markdown = yield* readState(input.statePath);
    const ownership = yield* Effect.try({
      try: () => parseOwnership(markdown),
      catch: fromUnknown,
    });
    if (ownership.generation !== input.generation || ownership.pane !== input.pane) {
      return yield* coordinatorError(
        "coordinator.verify_stale",
        "Coordinator ownership no longer matches the successor being verified.",
        "Keep the predecessor pane open and inspect the current owner before continuing.",
      );
    }
    if (ownership.readiness !== "ready") {
      return yield* coordinatorError(
        "coordinator.not_ready",
        `Successor \`${input.pane}\` has not recorded readiness for generation ${input.generation}.`,
        "Keep the predecessor pane open. Recover or replace the successor before attempting verification again.",
      );
    }
    if (ownership.marker !== input.observedMarker) {
      return yield* coordinatorError(
        "coordinator.marker_mismatch",
        "The readiness marker observed in Herdr does not match the current ownership record.",
        "Keep the predecessor pane open and verify the marker from the recorded successor pane.",
      );
    }
    return { verified: true, ownership };
  });
