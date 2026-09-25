import { Data, Effect } from "effect";
import { activeRuntimeBlockPattern, parseActiveRuntimeFields } from "./active-runtime.ts";
import type { CliIssue, InfrastructureRetryRecordInput, RoleRecord } from "./contract.ts";
import { updateTicketCells } from "./resume-sections.ts";
import { mutateStateFile, StateMutationError } from "./state-mutation.ts";
import { validateStateText } from "./state.ts";

/**
 * Exact persisted launch binding reused by an infrastructure retry.
 */
export type RetryBinding = {
  role: RoleRecord;
  worktree_path: string;
  branch: string;
  implement_skill_path: string;
  session: string;
  tab: string;
};

/**
 * Result of recording one infrastructure failure.
 */
export type InfrastructureRetryResult = {
  ticket: string;
  failure: "worker" | "herdr" | "launch";
  attempt: number;
  retries_completed: number;
  max_retries: number;
  action: "retry" | "block";
  delay_ms: number;
  binding: RetryBinding;
};

/**
 * Typed retry-state failure returned through the CLI.
 */
export class InfrastructureRetryError extends Data.TaggedError("InfrastructureRetryError")<{
  issue: CliIssue;
}> {}

/**
 * Shared maximum number of infrastructure retries after an initial attempt.
 */
export const MAX_INFRASTRUCTURE_RETRIES = 3;

/**
 * Returns the shared bounded retry action and exponential delay.
 *
 * @param retriesCompleted - Retries completed before the current failed attempt.
 * @returns The next retry action and delay without changing a bound configuration.
 */
export const planInfrastructureRetry = (
  retriesCompleted: number,
): { action: "retry" | "block"; delay_ms: number } => {
  const action = retriesCompleted < MAX_INFRASTRUCTURE_RETRIES ? "retry" : "block";
  return {
    action,
    delay_ms: action === "retry" ? Math.min(8_000, 1_000 * 2 ** retriesCompleted) : 0,
  };
};

const retryError = (code: string, message: string, remediation: string): InfrastructureRetryError =>
  new InfrastructureRetryError({ issue: { code, message, remediation } });

const fromMutationError = (error: unknown): InfrastructureRetryError => {
  if (error instanceof InfrastructureRetryError) return error;
  const detail = error instanceof StateMutationError ? error.message : (error as Error).message;
  return retryError(
    error instanceof StateMutationError && error.kind === "lock_busy"
      ? "retry.state_busy"
      : "retry.state_io_failed",
    `Could not update infrastructure retry state: ${detail}`,
    "Verify RESUME.md and its directory are writable, then retry with the recorded binding.",
  );
};

const parseRole = (serialized: string | undefined): RoleRecord | undefined => {
  if (serialized === undefined) return undefined;
  try {
    const value = JSON.parse(serialized) as Record<string, unknown>;
    if (
      Object.keys(value).toSorted().join(",") !== "effort,harness,model" ||
      (value.harness !== "claude" && value.harness !== "pi") ||
      typeof value.model !== "string" ||
      typeof value.effort !== "string"
    ) {
      return undefined;
    }
    return { harness: value.harness, model: value.model, effort: value.effort };
  } catch {
    return undefined;
  }
};

const parseBinding = (fields: Record<string, string>): RetryBinding | undefined => {
  const role = parseRole(fields.Implementor);
  const worktreePath = fields.Worktree;
  const branch = fields.Branch;
  const implementSkillPath = fields["Implement skill"];
  const session = fields.Session;
  const tab = fields.Tab;
  if (
    role === undefined ||
    worktreePath === undefined ||
    branch === undefined ||
    implementSkillPath === undefined ||
    session === undefined ||
    tab === undefined
  ) {
    return undefined;
  }
  return {
    role,
    worktree_path: worktreePath,
    branch,
    implement_skill_path: implementSkillPath,
    session,
    tab,
  };
};

const updateTicketStatus = (markdown: string, ticket: string, status: string): string => {
  const updated = updateTicketCells(markdown, ticket, { status });
  if (typeof updated !== "string") throw new Error(`ticket table ${updated.kind}`);
  return updated;
};

/**
 * Records one failure, preserves the active binding, and returns the bounded retry decision.
 *
 * @param input - Ticket attempt, infrastructure class, and exact diagnostic.
 * @returns An Effect containing either the next delay or ticket-local exhaustion.
 */
export const recordInfrastructureRetry = (
  input: InfrastructureRetryRecordInput,
): Effect.Effect<InfrastructureRetryResult, InfrastructureRetryError> =>
  mutateStateFile(input.statePath, (markdown) =>
    Effect.gen(function* () {
      yield* validateStateText(input.statePath, markdown).pipe(
        Effect.mapError((error) => new InfrastructureRetryError({ issue: error.issue })),
        Effect.asVoid,
      );
      const pattern = activeRuntimeBlockPattern(input.ticket);
      const block = markdown.match(pattern)?.[0];
      if (block === undefined) {
        return yield* retryError(
          "retry.runtime_missing",
          `Ticket \`${input.ticket}\` has no active runtime to retry.`,
          "Refresh run state before recording the infrastructure failure.",
        );
      }

      const fields = parseActiveRuntimeFields(block);
      const retry = fields.Retry?.match(/^(\d+) of (\d+)$/u);
      const binding = parseBinding(fields);
      if (
        fields.Attempt !== String(input.attempt) ||
        retry === undefined ||
        retry === null ||
        binding === undefined
      ) {
        return yield* retryError(
          "retry.runtime_malformed",
          `Ticket \`${input.ticket}\` has malformed or stale retry state.`,
          "Repair the active runtime binding and retry counters before continuing.",
        );
      }

      const completed = Number(retry[1]);
      const maximum = Number(retry[2]);
      if (maximum !== 3 || completed !== input.attempt - 1) {
        return yield* retryError(
          "retry.bound_invalid",
          "Infrastructure retries must record exactly three retries and match the current attempt.",
          "Restore the durable `Retry: <completed> of 3` record before retrying.",
        );
      }

      const decision = planInfrastructureRetry(completed);
      const action: InfrastructureRetryResult["action"] = decision.action;
      const delay = decision.delay_ms;
      const diagnostic = input.diagnostic.replace(/\s+/gu, " ").trim();
      const updatedBlock = block
        .replace(
          /^Phase: .*$/mu,
          `Phase: ${action === "retry" ? "retry waiting" : "retry exhausted"}`,
        )
        .replace(
          /^Last diagnostic: .*$/mu,
          `Last diagnostic: ${input.failure} attempt ${input.attempt}: ${diagnostic}`,
        );
      const withBlock = markdown.replace(pattern, updatedBlock);
      const next =
        action === "block" ? updateTicketStatus(withBlock, input.ticket, "blocked") : withBlock;

      return {
        markdown: next,
        result: {
          ticket: input.ticket,
          failure: input.failure,
          attempt: input.attempt,
          retries_completed: completed,
          max_retries: maximum,
          action,
          delay_ms: delay,
          binding,
        },
      };
    }),
  ).pipe(Effect.mapError(fromMutationError));
