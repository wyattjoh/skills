import { Data, Effect } from "effect";
import { readFile } from "node:fs/promises";
import { activeRuntimeBlockPattern, parseActiveRuntimeFields } from "./active-runtime.ts";
import type {
  CliIssue,
  CoordinatorClaimInput,
  CoordinatorReadyInput,
  CoordinatorVerifyInput,
  HarnessName,
  RoleRecord,
} from "./contract.ts";
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
  predecessor_pane: string | undefined;
  handoff_artifact_sha256: string | undefined;
};

/**
 * Persisted selected role and current ownership read from one valid run state.
 */
export type CoordinatorBinding = {
  role: RoleRecord;
  ownership: CoordinatorOwnership;
  handoff: "yes";
  thresholdPercent: 80;
};

/**
 * Refreshed active runtime pane applied atomically with successor readiness.
 */
export type CoordinatorRuntimeRefresh = {
  ticket: string;
  session: string;
  attempt: number;
  previousPane: string;
  pane: string;
};

/**
 * Automatic handoff claim values committed with worker refresh and readiness.
 */
export type CoordinatorHandoffClaimReadyInput = CoordinatorClaimInput & {
  artifactSha256: string;
};

/**
 * Typed coordinator ownership failure returned through the CLI envelope.
 */
export class CoordinatorError extends Data.TaggedError("CoordinatorError")<{
  issue: CliIssue;
}> {}

const coordinatorError = (code: string, message: string, remediation: string): CoordinatorError =>
  new CoordinatorError({ issue: { code, message, remediation } });

const blockPattern = (label: string): RegExp =>
  new RegExp(`^${label}:\\r?\\n((?:  [^\\r\\n]*(?:\\r?\\n|$))+)`, "gmu");

const parseFields = (markdown: string, label: string): Record<string, string> => {
  const matches = [...markdown.matchAll(blockPattern(label))];
  if (matches.length !== 1) {
    throw coordinatorError(
      "state.coordinator_fields_malformed",
      `RESUME.md must contain exactly one \`${label}:\` block.`,
      "Repair the schema-1 role and ownership blocks manually, then retry.",
    );
  }
  const fields: Record<string, string> = {};
  for (const line of matches[0]![1]!.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    const field = line.match(/^  ([a-z][a-z ]*):\s*(.*)$/u);
    if (field === null || field[2]!.length === 0 || fields[field[1]!] !== undefined) {
      throw coordinatorError(
        "state.coordinator_fields_malformed",
        `RESUME.md has malformed or duplicate fields in \`${label}:\`.`,
        "Repair the schema-1 role and ownership blocks manually, then retry.",
      );
    }
    fields[field[1]!] = field[2]!;
  }
  return fields;
};

const parseCoordinatorRole = (markdown: string): RoleRecord => {
  const fields = parseFields(markdown, "Coordinator");
  const harness = fields.harness;
  const model = fields.model;
  const effort = fields.effort;
  if ((harness !== "claude" && harness !== "pi") || model === undefined || effort === undefined) {
    throw coordinatorError(
      "state.coordinator_role_malformed",
      "RESUME.md has an incomplete or malformed Coordinator role record.",
      "Persist harness, model, and effort under `Coordinator:` before takeover.",
    );
  }
  return { harness, model, effort };
};

const parseHandoffPolicy = (markdown: string): { handoff: "yes"; thresholdPercent: 80 } => {
  const fields = parseFields(markdown, "Coordinator");
  if (fields.handoff !== "yes" || fields.threshold !== "80 percent") {
    throw coordinatorError(
      "state.coordinator_handoff_policy_malformed",
      "RESUME.md must record `handoff: yes` and `threshold: 80 percent` for every coordinator.",
      "Repair the schema-1 Coordinator handoff policy before automatic takeover.",
    );
  }
  return { handoff: "yes", thresholdPercent: 80 };
};

const parseOwnership = (markdown: string): CoordinatorOwnership => {
  const fields = parseFields(markdown, "Coordinator ownership");
  const generation = Number(fields.generation);
  const readiness = fields.readiness;
  const harness = fields.harness;
  const predecessorPane = fields["predecessor pane"];
  const handoffArtifactSha256 = fields["handoff artifact hash"];
  if (
    !Number.isInteger(generation) ||
    generation < 0 ||
    fields.pane === undefined ||
    (harness !== "claude" && harness !== "pi") ||
    fields.model === undefined ||
    fields.effort === undefined ||
    (readiness !== "claiming" && readiness !== "ready") ||
    fields.marker === undefined ||
    (predecessorPane === undefined) !== (handoffArtifactSha256 === undefined) ||
    (handoffArtifactSha256 !== undefined && !/^sha256:[a-f0-9]{64}$/u.test(handoffArtifactSha256))
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
    predecessor_pane: predecessorPane,
    handoff_artifact_sha256: handoffArtifactSha256,
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
    ...(ownership.predecessor_pane === undefined
      ? []
      : [
          `  predecessor pane: ${ownership.predecessor_pane}`,
          `  handoff artifact hash: ${ownership.handoff_artifact_sha256}`,
        ]),
    "",
  ].join("\n");

const replaceOwnership = (markdown: string, ownership: CoordinatorOwnership): string =>
  markdown.replace(blockPattern("Coordinator ownership"), renderOwnership(ownership));

const sameRole = (left: RoleRecord, right: RoleRecord): boolean =>
  left.harness === right.harness && left.model === right.model && left.effort === right.effort;

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
 * Reads the selected coordinator role and current ownership from valid state.
 *
 * @param path - Path to the run's RESUME.md document.
 * @returns An Effect containing the persisted coordinator binding.
 */
export const readCoordinatorBinding = (
  path: string,
): Effect.Effect<CoordinatorBinding, CoordinatorError> =>
  Effect.gen(function* () {
    const markdown = yield* readState(path);
    return yield* Effect.try({
      try: () => ({
        role: parseCoordinatorRole(markdown),
        ownership: parseOwnership(markdown),
        ...parseHandoffPolicy(markdown),
      }),
      catch: fromUnknown,
    });
  });

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
        predecessor_pane: undefined,
        handoff_artifact_sha256: undefined,
      };
      return { markdown: replaceOwnership(markdown, claimed), result: claimed };
    },
    hooks,
  );

const activeRuntimeIdentities = (
  markdown: string,
): Array<{ ticket: string; session: string; attempt: number; pane: string }> => {
  const heading = /^## Active tickets\s*$/mu.exec(markdown);
  if (heading === null) return [];
  const start = heading.index + heading[0].length;
  const nextSection = /^## /gmu;
  nextSection.lastIndex = start;
  const end = nextSection.exec(markdown)?.index ?? markdown.length;
  const section = markdown.slice(start, end);
  const headings = [...section.matchAll(/^### (\d+)\s*$/gmu)];
  const tickets = new Set<string>();
  return headings.map((match, index) => {
    const ticket = match[1]!;
    const absoluteStart = start + match.index;
    const absoluteEnd = index + 1 < headings.length ? start + headings[index + 1]!.index : end;
    const fields = parseActiveRuntimeFields(markdown.slice(absoluteStart, absoluteEnd));
    const attempt = Number(fields.Attempt);
    if (
      tickets.has(ticket) ||
      fields.Session === undefined ||
      fields.Pane === undefined ||
      !Number.isInteger(attempt) ||
      attempt < 1
    ) {
      throw coordinatorError(
        "coordinator.worker_state_changed",
        "The complete active-runtime identity set became malformed before successor readiness.",
        "Keep the predecessor open and restart handoff from a fresh active-worker snapshot.",
      );
    }
    tickets.add(ticket);
    return { ticket, session: fields.Session, attempt, pane: fields.Pane };
  });
};

const assertCompleteWorkerSet = (markdown: string, workers: CoordinatorRuntimeRefresh[]): void => {
  const current = activeRuntimeIdentities(markdown).toSorted((left, right) =>
    left.ticket.localeCompare(right.ticket),
  );
  const expected = workers
    .map((worker) => ({
      ticket: worker.ticket,
      session: worker.session,
      attempt: worker.attempt,
      pane: worker.previousPane,
    }))
    .toSorted((left, right) => left.ticket.localeCompare(right.ticket));
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw coordinatorError(
      "coordinator.worker_state_changed",
      "The complete active-runtime identity set changed before successor readiness.",
      "Keep the predecessor open and restart handoff from a fresh active-worker snapshot.",
    );
  }
};

const refreshWorkerPanes = (markdown: string, workers: CoordinatorRuntimeRefresh[]): string => {
  let refreshed = markdown;
  for (const worker of workers) {
    const pattern = activeRuntimeBlockPattern(worker.ticket);
    const block = refreshed.match(pattern)?.[0];
    if (block === undefined) {
      throw coordinatorError(
        "coordinator.worker_state_changed",
        `Active runtime \`${worker.ticket}\` disappeared before successor readiness.`,
        "Keep the predecessor open and restart handoff from a fresh active-worker snapshot.",
      );
    }
    const fields = parseActiveRuntimeFields(block);
    if (
      fields.Session !== worker.session ||
      Number(fields.Attempt) !== worker.attempt ||
      fields.Pane !== worker.previousPane
    ) {
      throw coordinatorError(
        "coordinator.worker_state_changed",
        `Active runtime \`${worker.ticket}\` changed before successor readiness.`,
        "Keep the predecessor open and restart handoff from a fresh active-worker snapshot.",
      );
    }
    refreshed = refreshed.replace(pattern, block.replace(/^Pane: .*$/mu, `Pane: ${worker.pane}`));
  }
  return refreshed;
};

/**
 * Atomically claims automatic handoff ownership, refreshes workers, and records readiness.
 *
 * @param input - Expected predecessor, selected successor, and prepared artifact digest.
 * @param workers - Complete active runtime pane refreshes observed after wait subscription.
 * @param hooks - Optional deterministic state-mutation hooks for tests.
 * @returns An Effect containing the single ready successor ownership record.
 */
export const claimReadyCoordinator = (
  input: CoordinatorHandoffClaimReadyInput,
  workers: CoordinatorRuntimeRefresh[],
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
        ownership.readiness !== "ready" ||
        !sameRole(ownership, input.expectedPredecessorRole)
      ) {
        throw coordinatorError(
          "coordinator.claim_stale",
          `Coordinator ownership changed before this claim; expected generation ${input.expectedGeneration}, predecessor pane \`${input.expectedPredecessorPane}\`, and role ${input.expectedPredecessorRole.harness}/${input.expectedPredecessorRole.model}/${input.expectedPredecessorRole.effort}.`,
          "Keep the predecessor open, re-read state, and restart automatic handoff.",
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
      const ready: CoordinatorOwnership = {
        generation,
        pane: input.successorPane,
        harness: input.successorRole.harness,
        model: input.successorRole.model,
        effort: input.successorRole.effort,
        readiness: "ready",
        marker: `coordinator-ready-${generation}-${input.successorPane}`,
        predecessor_pane: ownership.pane,
        handoff_artifact_sha256: input.artifactSha256,
      };
      assertCompleteWorkerSet(markdown, workers);
      const refreshed = refreshWorkerPanes(markdown, workers);
      return { markdown: replaceOwnership(refreshed, ready), result: ready };
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
  markCoordinatorReadyWithWorkers(input, [], hooks);

/**
 * Atomically persists refreshed worker panes and marks the claimed coordinator ready.
 *
 * @param input - Claimed generation, successor pane, and marker.
 * @param workers - Complete active runtime pane refreshes observed after wait subscription.
 * @param hooks - Optional deterministic state-mutation hooks for tests.
 * @returns An Effect containing the ready ownership record.
 */
export const markCoordinatorReadyWithWorkers = (
  input: CoordinatorReadyInput,
  workers: CoordinatorRuntimeRefresh[],
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
      const refreshed = refreshWorkerPanes(markdown, workers);
      const ready: CoordinatorOwnership = { ...ownership, readiness: "ready" };
      return { markdown: replaceOwnership(refreshed, ready), result: ready };
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
