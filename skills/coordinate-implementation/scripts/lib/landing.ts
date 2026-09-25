import { Data, Effect } from "effect";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  CliIssue,
  CommitPolicy,
  LandingCompleteInput,
  LandingRebaseCheckInput,
} from "./contract.ts";
import { activeRuntimeBlockPattern, parseActiveRuntimeFields } from "./active-runtime.ts";
import { cleanGitEnv, spawnGit } from "./git.ts";
import {
  bindIntegration,
  checkIntegration,
  isAppendedFix,
  IntegrationError,
  type IntegrationPhase,
  type IntegrationRecord,
  observeIntegration,
  operationInProgress,
  parseIntegration,
  rebasePrompt,
  recordRebase,
  writeIntegration,
} from "./integration.ts";
import { readJsonSection, readRepositoryPolicy } from "./policy-records.ts";
import { appendSectionLine, updateTicketCells } from "./resume-sections.ts";
import { inspectRuntimeClose } from "./runtime-close.ts";
import { mutateStateFile, StateMutationError } from "./state-mutation.ts";
import { validateStateText } from "./state.ts";

type PersistedRepositoryPolicy = {
  remote: "local-only" | "repository";
  remote_sync_argv: string[] | null;
  cleanup: "native-safe" | "repository";
  commit: CommitPolicy;
};

/**
 * Default seconds to wait for the shared `land-local.lock`, matching the land-local skill.
 */
export const LAND_LOCK_WAIT_SECONDS = 110 as const;

/**
 * Typed rebase, landing, or cleanup failure returned through the CLI.
 */
export class LandingError extends Data.TaggedError("LandingError")<{
  issue: CliIssue;
}> {}

const landingError = (code: string, message: string, remediation: string): LandingError =>
  new LandingError({ issue: { code, message, remediation } });

const toLandingError = (error: unknown): LandingError => {
  if (error instanceof LandingError) return error;
  if (error instanceof IntegrationError) return new LandingError({ issue: error.issue });
  return landingError(
    "landing.unexpected_failure",
    `Landing failed unexpectedly: ${(error as Error).message}`,
    "Inspect the run state and ticket worktree, then retry the same operation.",
  );
};

const attempt = <Value>(evaluate: () => Value): Effect.Effect<Value, LandingError> =>
  Effect.try({ try: evaluate, catch: toLandingError });

const fromMutationError = (error: unknown): LandingError => {
  if (error instanceof LandingError) return error;
  if (error instanceof IntegrationError) return new LandingError({ issue: error.issue });
  const detail = error instanceof StateMutationError ? error.message : (error as Error).message;
  return landingError(
    error instanceof StateMutationError && error.kind === "lock_busy"
      ? "landing.state_busy"
      : "landing.state_io_failed",
    `Could not update ticket integration state: ${detail}`,
    "Verify RESUME.md is writable, then retry the same operation.",
  );
};

const parseRepositoryPolicy = (markdown: string): PersistedRepositoryPolicy => {
  const record = readRepositoryPolicy(markdown);
  if ("policy" in record) return record.policy;
  throw record.problem === "missing"
    ? landingError(
        "landing.repository_policy_missing",
        "RESUME.md has no persisted Repository policy.",
        "Resolve repository synchronization, cleanup, and commit policy before integration.",
      )
    : landingError(
        "landing.repository_policy_malformed",
        "RESUME.md contains an incomplete Repository policy.",
        "Repair the persisted remote, cleanup, and commit records before integration.",
      );
};

const parseBaseBranch = (markdown: string): string => {
  const matches = [...markdown.matchAll(/^Base:\s*(\S[^\r\n]*)$/gmu)];
  if (matches.length !== 1) {
    throw landingError(
      "landing.base_malformed",
      "RESUME.md must contain exactly one non-empty Base field.",
      "Repair the schema-2 run header before integration.",
    );
  }
  return matches[0]![1]!;
};

const parseGateCount = (markdown: string): number => {
  const record = readJsonSection(markdown, "Review policy");
  const gates =
    "value" in record && typeof record.value === "object" && record.value !== null
      ? (record.value as { gates?: unknown }).gates
      : undefined;
  if (Array.isArray(gates)) return gates.length;
  throw landingError(
    "landing.review_policy_malformed",
    "RESUME.md has no single Review policy with a gates list.",
    "Run `review.policy.prepare` before integration.",
  );
};

const parseActiveTicket = (
  markdown: string,
  ticket: string,
): { worktree: string; branch: string; pane: string } => {
  const block = markdown.match(activeRuntimeBlockPattern(ticket))?.[0];
  if (block === undefined) {
    throw landingError(
      "landing.runtime_missing",
      `Ticket \`${ticket}\` has no active runtime block.`,
      "Restore its durable runtime before integration or landing.",
    );
  }
  const fields = parseActiveRuntimeFields(block);
  if (fields.Worktree === undefined || fields.Branch === undefined || fields.Pane === undefined) {
    throw landingError(
      "landing.runtime_malformed",
      `Ticket \`${ticket}\` is missing Worktree, Branch, or Pane provenance.`,
      "Repair the active runtime from its launch artifact before continuing.",
    );
  }
  return { worktree: fields.Worktree, branch: fields.Branch, pane: fields.Pane };
};

const gitFailure = (action: string, stderr: string): LandingError =>
  landingError(
    "landing.git_failed",
    `${action} failed: ${stderr.trim() || "Git returned a nonzero exit code."}`,
    "Inspect the repository and worktree, repair the reported failure, then retry.",
  );

const validateRepositoryAndWorktree = (
  repositoryPath: string,
  worktreePath: string,
  activeWorktree: string,
  branch: string,
  baseBranch: string,
): Effect.Effect<void, LandingError> =>
  Effect.gen(function* () {
    const repositoryRoot = spawnGit(["rev-parse", "--show-toplevel"], { cwd: repositoryPath });
    const worktreeRoot = spawnGit(["rev-parse", "--show-toplevel"], { cwd: worktreePath });
    const currentBranch = spawnGit(["symbolic-ref", "--short", "HEAD"], { cwd: worktreePath });
    const baseExists = spawnGit(["show-ref", "--verify", `refs/heads/${baseBranch}`], {
      cwd: repositoryPath,
    });
    if (repositoryRoot.exitCode !== 0)
      return yield* gitFailure("Repository validation", repositoryRoot.stderr);
    if (worktreeRoot.exitCode !== 0)
      return yield* gitFailure("Worktree validation", worktreeRoot.stderr);
    if (
      realpathSync(repositoryRoot.stdout.trim()) !== realpathSync(repositoryPath) ||
      realpathSync(worktreeRoot.stdout.trim()) !== realpathSync(worktreePath) ||
      realpathSync(activeWorktree) !== realpathSync(worktreePath) ||
      currentBranch.stdout.trim() !== branch
    ) {
      return yield* landingError(
        "landing.runtime_mismatch",
        "Supplied repository or worktree does not match the active ticket runtime.",
        "Use the recorded integration checkout, worktree, and branch for this ticket.",
      );
    }
    if (baseExists.exitCode !== 0) {
      return yield* landingError(
        "landing.base_missing",
        `Local integration branch \`${baseBranch}\` does not exist.`,
        "Restore or select the persisted local integration branch before integration.",
      );
    }
  });

const canonicalPathAllowingMissing = async (path: string): Promise<string> => {
  let cursor = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      const existing = await realpath(cursor);
      return resolve(existing, ...missing);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
};

const runExactCommand = (
  argv: string[],
  cwd: string,
  action: string,
): Effect.Effect<void, LandingError> =>
  Effect.gen(function* () {
    const result = yield* Effect.sync(() => {
      try {
        const child = Bun.spawnSync(argv, {
          cwd,
          env: cleanGitEnv(),
          stdout: "pipe",
          stderr: "pipe",
        });
        return { exitCode: child.exitCode, stderr: child.stderr.toString() };
      } catch (error) {
        return { exitCode: 1, stderr: (error as Error).message };
      }
    });
    if (result.exitCode !== 0) return yield* gitFailure(action, result.stderr);
  });

const readState = (statePath: string): Effect.Effect<string, LandingError> =>
  Effect.tryPromise({
    try: () => readFile(statePath, "utf8"),
    catch: (error) =>
      landingError(
        "landing.state_read_failed",
        `Could not read run state: ${(error as Error).message}`,
        "Verify RESUME.md is readable before integration or landing.",
      ),
  });

const phaseLabels: Record<IntegrationPhase, string> = {
  gates: "gates",
  fixing: "commit policy fix required",
  "rebase-required": "rebase required",
  "ready-to-land": "ready to land",
};

const phaseActions = {
  gates: "run-gates",
  fixing: "fix-commits",
  "rebase-required": "rebase",
  "ready-to-land": "land",
} as const;

/**
 * Integration binding returned by `landing.rebase.check`.
 */
export type LandingRebaseResult = {
  ticket: string;
  action: "run-gates" | "fix-commits" | "rebase" | "land";
  phase: IntegrationPhase;
  cycle: number;
  base_branch: string;
  base_sha: string;
  ticket_sha: string;
  review_range: string;
  commit_count: number;
  commit_policy: CommitPolicy;
  patch_id: string;
  reviews_kept: boolean;
  remote_synchronized: boolean;
  prompt: string | null;
};

const rebaseResult = (
  ticket: string,
  record: IntegrationRecord,
  context: {
    baseBranch: string;
    commitPolicy: CommitPolicy;
    remoteSynchronized: boolean;
    worktreePath: string;
  },
): LandingRebaseResult => ({
  ticket,
  action: phaseActions[record.phase],
  phase: record.phase,
  cycle: record.cycle,
  base_branch: context.baseBranch,
  base_sha: record.base_sha,
  ticket_sha: record.ticket_sha,
  review_range: record.review_range,
  commit_count: record.commit_count,
  commit_policy: context.commitPolicy,
  patch_id: record.patch_id,
  reviews_kept: record.reviewed_patch_id !== null && record.reviewed_patch_id === record.patch_id,
  remote_synchronized: context.remoteSynchronized,
  prompt:
    record.phase === "rebase-required"
      ? rebasePrompt({
          ticket,
          baseBranch: context.baseBranch,
          baseSha: record.base_sha,
          worktreePath: context.worktreePath,
        })
      : null,
});

const commitShapeValid = (policy: CommitPolicy, count: number): boolean =>
  policy.commits === "multiple" ? count > 0 : count === 1;

type IntegrationInput = {
  statePath: string;
  repositoryPath: string;
  worktreePath: string;
  ticket: string;
  completedAt: string;
};

const prepareIntegration = (
  input: IntegrationInput,
): Effect.Effect<
  { policy: PersistedRepositoryPolicy; baseBranch: string; remoteSynchronized: boolean },
  LandingError
> =>
  Effect.gen(function* () {
    const markdown = yield* readState(input.statePath);
    yield* validateStateText(input.statePath, markdown).pipe(
      Effect.mapError((error) => new LandingError({ issue: error.issue })),
    );
    const policy = yield* attempt(() => parseRepositoryPolicy(markdown));
    const baseBranch = yield* attempt(() => parseBaseBranch(markdown));
    const runtime = yield* attempt(() => parseActiveTicket(markdown, input.ticket));
    const boundWorktree = yield* Effect.sync(() => {
      try {
        return realpathSync(runtime.worktree) === realpathSync(input.worktreePath);
      } catch {
        return false;
      }
    });
    if (boundWorktree && (yield* attempt(() => operationInProgress(input.worktreePath)))) {
      return yield* landingError(
        "landing.operation_in_progress",
        "A rebase, merge, or cherry-pick is still in progress in the ticket worktree.",
        "Return the ticket to its implementor to finish the operation in its own worktree.",
      );
    }
    yield* validateRepositoryAndWorktree(
      input.repositoryPath,
      input.worktreePath,
      runtime.worktree,
      runtime.branch,
      baseBranch,
    );
    const status = spawnGit(["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: input.worktreePath,
    });
    if (status.exitCode !== 0) return yield* gitFailure("Worktree status", status.stderr);
    if (status.stdout !== "") {
      return yield* landingError(
        "landing.worktree_dirty",
        "Ticket worktree must be clean before its integration is checked.",
        "Return uncommitted work to the bound implementor to commit under the persisted policy.",
      );
    }
    if (policy.remote_sync_argv !== null) {
      yield* runExactCommand(
        policy.remote_sync_argv,
        input.repositoryPath,
        "Repository synchronization",
      );
    }
    return { policy, baseBranch, remoteSynchronized: policy.remote_sync_argv !== null };
  });

/**
 * Checks whether a clean ticket branch already contains the local base and binds its integration.
 *
 * Runs the repository-authorized `remote_sync_argv` first when the persisted policy has one. An
 * up-to-date tip is bound at its current integration cycle. A tip behind the base is recorded as
 * `rebase-required` and the result carries the prompt for the bound implementor, who rebases in
 * its own worktree. Under the append fix policy, a fixing ticket must preserve every commit patch
 * id recorded at the failed review and add at least one commit.
 *
 * @param input - Run state, integration checkout, ticket worktree, and timestamp.
 * @returns The persisted integration binding and the next coordinator action.
 */
export const checkLandingRebase = (
  input: LandingRebaseCheckInput,
): Effect.Effect<LandingRebaseResult, LandingError> =>
  Effect.gen(function* () {
    const prepared = yield* prepareIntegration(input);
    return yield* mutateStateFile(input.statePath, (markdown) =>
      Effect.gen(function* () {
        const prior = yield* attempt(() => parseIntegration(markdown, input.ticket));
        const observed = yield* attempt(() =>
          observeIntegration(input.worktreePath, prepared.baseBranch),
        );
        const upToDate = yield* attempt(() =>
          checkIntegration(input.worktreePath, prepared.baseBranch),
        );
        if (
          prior?.phase === "fixing" &&
          prepared.policy.commit.fixes === "append" &&
          prior.reviewed_commit_patch_ids !== null &&
          !isAppendedFix(prior.reviewed_commit_patch_ids, observed.commit_patch_ids)
        ) {
          return yield* landingError(
            "landing.fix_policy_violated",
            "The fix round did not append commits to the commits recorded at the last review.",
            "Return the ticket to its bound implementor and apply the persisted append fix policy.",
          );
        }
        const options = {
          minimumCycle: 0,
          commitShapeValid: commitShapeValid(prepared.policy.commit, observed.commit_count),
          gateCount: parseGateCount(markdown),
          completedAt: input.completedAt,
        };
        let record: IntegrationRecord;
        if (!upToDate) {
          record = {
            ...(prior ?? bindIntegration(undefined, observed, options)),
            phase: "rebase-required",
            base_sha: observed.base_sha,
            ticket_sha: observed.ticket_sha,
            review_range: `${observed.base_sha}..${observed.ticket_sha}`,
            commit_count: observed.commit_count,
            patch_id: observed.patch_id,
            commit_patch_ids: observed.commit_patch_ids,
            passed_gates: [],
            completed_at: input.completedAt,
          };
          if (
            prior?.phase === "rebase-required" &&
            prior.base_sha === observed.base_sha &&
            prior.ticket_sha === observed.ticket_sha
          ) {
            record = prior;
          }
        } else if (prior?.phase === "rebase-required") {
          record = recordRebase(prior, observed, options);
        } else {
          record = bindIntegration(prior, observed, options);
        }
        return {
          markdown:
            record === prior
              ? undefined
              : writeIntegration(markdown, input.ticket, record, phaseLabels[record.phase]),
          result: rebaseResult(input.ticket, record, {
            baseBranch: prepared.baseBranch,
            commitPolicy: prepared.policy.commit,
            remoteSynchronized: prepared.remoteSynchronized,
            worktreePath: input.worktreePath,
          }),
        };
      }),
    ).pipe(Effect.mapError(fromMutationError));
  });

const updateTicketAsLanded = (markdown: string, ticket: string, sha: string): string => {
  const updated = updateTicketCells(markdown, ticket, { status: "landed", sha });
  if (typeof updated === "string") return updated;
  switch (updated.kind) {
    case "section_missing":
      throw landingError(
        "landing.tickets_missing",
        "RESUME.md has no Tickets section.",
        "Repair the schema-2 ticket table before recording landing.",
      );
    case "header_missing":
    case "row_missing":
      throw landingError(
        "landing.ticket_missing",
        `Ticket \`${ticket}\` is absent from the state table.`,
        "Restore the normalized ticket row before recording landing.",
      );
    case "row_malformed":
    case "column_missing":
      throw landingError(
        "landing.ticket_table_malformed",
        "Ticket table is missing status or sha columns.",
        "Repair the schema-2 ticket table before recording landing.",
      );
  }
};

const appendRetainedBranch = (markdown: string, branch: string, sha: string): string =>
  appendSectionLine(markdown, "Retained landed branches", `- ${branch} (${sha})`, {
    spacing: "blank",
  });

const appendLandedEvidence = (
  markdown: string,
  ticket: string,
  evidencePath: string,
  ticketSha: string,
  branch: string,
  cleanup: "native-safe" | "repository",
): string =>
  appendSectionLine(
    markdown,
    "Landed evidence",
    `- Ticket ${ticket}: ${evidencePath}; tip ${ticketSha}; branch ${branch}; cleanup ${cleanup}`,
    { spacing: "blank" },
  );

/**
 * Marks an integrated ticket as requiring an implementor fix and records the append baseline.
 *
 * @param markdown - Latest locked run-state Markdown.
 * @param input - Ticket, reviewed tip, completion time, and active phase label.
 * @returns Updated Markdown, or the original text when the ticket has no integration record.
 * @throws LandingError when the fix evidence does not match the integrated tip.
 */
export const applyIntegrationFix = (
  markdown: string,
  input: { ticket: string; reviewedHead: string; completedAt: string; phase: string },
): string => {
  const integration = parseIntegration(markdown, input.ticket);
  if (integration === undefined) return markdown;
  if (integration.ticket_sha !== input.reviewedHead) {
    throw landingError(
      "landing.review_stale",
      "Fix evidence does not match the ticket's integrated tip.",
      "Run landing.rebase.check and rerun gates against the current ticket tip.",
    );
  }
  return writeIntegration(
    markdown,
    input.ticket,
    {
      ...integration,
      phase: "fixing",
      passed_gates: [],
      reviewed_head: null,
      reviewed_patch_id: null,
      reviewed_commit_patch_ids: integration.commit_patch_ids,
      standards_evidence_path: null,
      spec_evidence_path: null,
      self_review_path: null,
      completed_at: input.completedAt,
    },
    input.phase,
  );
};

/**
 * Records one passing gate for the current integration cycle. When reviews were kept across a
 * rebase and every configured gate has now passed, the ticket becomes ready to land.
 *
 * @param markdown - Latest locked run-state Markdown.
 * @param input - Ticket, gate name, gated HEAD, and every configured gate name.
 * @returns Updated Markdown, or the original text when the ticket has no integration record.
 */
export const applyGatePass = (
  markdown: string,
  input: { ticket: string; name: string; head: string; gateNames: string[] },
): string => {
  const integration = parseIntegration(markdown, input.ticket);
  if (
    integration === undefined ||
    integration.phase !== "gates" ||
    integration.ticket_sha !== input.head
  ) {
    return markdown;
  }
  const passed = integration.passed_gates.includes(input.name)
    ? integration.passed_gates
    : [...integration.passed_gates, input.name];
  const reviewsKept =
    integration.reviewed_patch_id !== null &&
    integration.reviewed_patch_id === integration.patch_id &&
    integration.standards_evidence_path !== null &&
    integration.spec_evidence_path !== null &&
    integration.self_review_path !== null;
  const ready = reviewsKept && input.gateNames.every((name) => passed.includes(name));
  return writeIntegration(
    markdown,
    input.ticket,
    { ...integration, passed_gates: passed, phase: ready ? "ready-to-land" : "gates" },
    ready ? "gates passed; reviews kept; ready to land" : undefined,
  );
};

/**
 * Restores gate review after an authorized same-HEAD rerun proves a failed gate was transient.
 *
 * @param markdown - Latest locked run-state Markdown.
 * @param input - Exact gate evidence and unchanged ticket identity.
 * @returns Updated Markdown plus whether the same transition was already durable.
 * @throws LandingError when the ticket is not in an append-only fixing phase at this tip.
 */
export const applyNoChangeGateRerun = (
  markdown: string,
  input: {
    ticket: string;
    name: string;
    reviewedHead: string;
    previousEvidencePath: string;
    evidencePath: string;
    diagnostic: string;
    completedAt: string;
    fixes: CommitPolicy["fixes"];
  },
): { markdown: string; recovered: boolean } => {
  const integration = parseIntegration(markdown, input.ticket);
  if (integration === undefined) {
    throw landingError(
      "landing.integration_missing",
      "No ticket integration exists for the no-change gate rerun.",
      "Run landing.rebase.check and record the failed gate before recovery.",
    );
  }
  const decision = `- ${input.completedAt.slice(0, 10)} ticket ${input.ticket} user-authorized no-change rerun of gate ${input.name}: ${input.diagnostic}; prior ${input.previousEvidencePath}; passing ${input.evidencePath}`;
  const alreadyRecovered =
    integration.phase === "gates" &&
    integration.ticket_sha === input.reviewedHead &&
    integration.reviewed_commit_patch_ids === null &&
    integration.completed_at === input.completedAt &&
    markdown.includes(decision);
  if (alreadyRecovered) return { markdown, recovered: true };
  if (
    integration.phase !== "fixing" ||
    integration.ticket_sha !== input.reviewedHead ||
    input.fixes !== "append" ||
    integration.commit_count <= 0
  ) {
    throw landingError(
      "landing.gate_rerun_state_invalid",
      "No-change gate recovery does not match the append-only fixing integration binding.",
      "Preserve the failed gate, ticket tip, base, and append policy before recording the passing rerun.",
    );
  }
  const updated = writeIntegration(
    markdown,
    input.ticket,
    {
      ...integration,
      phase: "gates",
      passed_gates: [input.name],
      reviewed_commit_patch_ids: null,
      completed_at: input.completedAt,
    },
    "gates after authorized no-change rerun",
  );
  return {
    markdown: appendSectionLine(updated, "Decisions", decision, { spacing: "blank" }),
    recovered: false,
  };
};

/**
 * Advances a ticket's integration record from external review to fixing or landing.
 *
 * Runs with the caller's existing state lock. State without an integration record is preserved
 * for compatibility with review-only workflows that have not bound an integration.
 *
 * @param markdown - Latest locked run-state Markdown.
 * @param input - Final verdict, reviewed tip, and immutable evidence paths.
 * @returns Updated Markdown with durable review provenance in the integration record.
 * @throws LandingError when the review does not cover the integrated tip in the gates phase.
 */
export const applyFinalReviewOutcome = (
  markdown: string,
  input: {
    ticket: string;
    verdict: "PASS" | "FAIL";
    reviewedHead: string;
    standardsEvidencePath: string;
    specEvidencePath: string;
    selfReviewPath: string;
    completedAt: string;
  },
): string => {
  const integration = parseIntegration(markdown, input.ticket);
  if (integration === undefined) return markdown;
  if (integration.phase !== "gates") {
    throw landingError(
      "landing.review_phase_invalid",
      "Final review requires the ticket integration to remain in the gates phase.",
      "Rerun every configured gate and both review axes against the current integrated ticket tip.",
    );
  }
  if (integration.ticket_sha !== input.reviewedHead) {
    throw landingError(
      "landing.review_stale",
      "Final review evidence does not match the integrated ticket tip.",
      "Rerun gates and both review axes against the complete recorded review range.",
    );
  }
  if (input.verdict === "FAIL") {
    return applyIntegrationFix(markdown, {
      ticket: input.ticket,
      reviewedHead: input.reviewedHead,
      completedAt: input.completedAt,
      phase: "review fixes required",
    });
  }
  return writeIntegration(
    markdown,
    input.ticket,
    {
      ...integration,
      phase: "ready-to-land",
      reviewed_head: integration.ticket_sha,
      reviewed_patch_id: integration.patch_id,
      reviewed_commit_patch_ids: integration.commit_patch_ids,
      standards_evidence_path: input.standardsEvidencePath,
      spec_evidence_path: input.specEvidencePath,
      self_review_path: input.selfReviewPath,
      completed_at: input.completedAt,
    },
    "review passed; ready to land",
  );
};

/**
 * Outcome of the locked fast-forward step.
 */
export type LandTicketOutcome = "landed" | "rebase_required" | "dirty" | "timeout";

/**
 * Fast-forwards the base checkout to one ticket tip while holding the shared `land-local.lock`.
 *
 * Runs `flock -w <seconds> <git-common-dir>/land-local.lock bun land-locked.ts` so every
 * coordinator and every `/land-local` caller serializes on the same lock. A tip that is already
 * an ancestor of the base is reported as landed without taking the lock.
 *
 * @param input - Base checkout, base branch, reviewed ticket tip, and lock wait seconds.
 * @returns The landing outcome and the lock script output.
 */
export const landTicket = (input: {
  repositoryPath: string;
  baseBranch: string;
  ticketSha: string;
  waitSeconds: number;
}): Effect.Effect<{ outcome: LandTicketOutcome; output: string }, LandingError> =>
  Effect.gen(function* () {
    const landed = spawnGit(["merge-base", "--is-ancestor", input.ticketSha, input.baseBranch], {
      cwd: input.repositoryPath,
    });
    if (landed.exitCode > 1) return yield* gitFailure("Landed ancestry check", landed.stderr);
    if (landed.exitCode === 0) return { outcome: "landed" as const, output: "" };
    const commonDir = spawnGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: input.repositoryPath,
    });
    if (commonDir.exitCode !== 0) return yield* gitFailure("Git common dir", commonDir.stderr);
    const argv = [
      "flock",
      "-w",
      String(input.waitSeconds),
      join(commonDir.stdout.trim(), "land-local.lock"),
      process.execPath,
      join(import.meta.dir, "..", "land-locked.ts"),
      input.repositoryPath,
      input.baseBranch,
      input.ticketSha,
    ];
    const child = yield* Effect.sync(() => {
      try {
        const result = Bun.spawnSync(argv, {
          cwd: input.repositoryPath,
          env: cleanGitEnv(),
          stdout: "pipe",
          stderr: "pipe",
        });
        return {
          exitCode: result.exitCode,
          output: `${result.stdout.toString()}${result.stderr.toString()}`.trim(),
        };
      } catch (error) {
        return { exitCode: 127, output: (error as Error).message };
      }
    });
    if (child.exitCode === 0) return { outcome: "landed" as const, output: child.output };
    if (child.exitCode === 1) return { outcome: "timeout" as const, output: child.output };
    if (child.exitCode === 4) return { outcome: "dirty" as const, output: child.output };
    if (child.exitCode === 5) return { outcome: "rebase_required" as const, output: child.output };
    return yield* gitFailure(`Locked fast-forward (exit ${child.exitCode})`, child.output);
  });

/**
 * Result of `landing.complete`.
 */
export type LandingCompleteResult =
  | {
      ticket: string;
      action: "rebase";
      phase: "rebase-required";
      base_sha: string;
      ticket_sha: string;
      cycle: number;
      prompt: string;
    }
  | {
      ticket: string;
      action: "close-runtime";
      phase: "ready-to-land";
      base_sha: string;
      ticket_sha: string;
      cycle: number;
      runtime_closed: false;
      pane_id: string;
      close: { command: string; args: string[] };
    }
  | {
      ticket: string;
      action: "schedule";
      phase: "landed";
      landed_tip: string;
      base_sha: string;
      review_evidence: { standards: string; spec: string; self_review: string };
      cleanup: {
        kind: "native-safe" | "repository";
        argv: string[];
        runtime_closed: true;
        worktree_removed: true;
        branch_retained: true;
      };
      evidence_path: string;
    };

type ReadyLanding = {
  policy: PersistedRepositoryPolicy;
  baseBranch: string;
  integration: IntegrationRecord;
  runtime: { worktree: string; branch: string; pane: string };
  reviewEvidence: { standards: string; spec: string; self_review: string };
};

const validateReadyLanding = (
  input: LandingCompleteInput,
): Effect.Effect<ReadyLanding, LandingError> =>
  Effect.gen(function* () {
    const markdown = yield* readState(input.statePath);
    yield* validateStateText(input.statePath, markdown).pipe(
      Effect.mapError((error) => new LandingError({ issue: error.issue })),
    );
    const policy = yield* attempt(() => parseRepositoryPolicy(markdown));
    const baseBranch = yield* attempt(() => parseBaseBranch(markdown));
    const integration = yield* attempt(() => parseIntegration(markdown, input.ticket));
    if (
      integration === undefined ||
      integration.phase !== "ready-to-land" ||
      integration.reviewed_head === null ||
      integration.reviewed_patch_id !== integration.patch_id ||
      integration.standards_evidence_path === null ||
      integration.spec_evidence_path === null ||
      integration.self_review_path === null
    ) {
      return yield* landingError(
        "landing.review_incomplete",
        `Ticket \`${input.ticket}\` has no complete final review ready for landing.`,
        "Finish passing gates, both accepted review axes, and implementor self-review before landing.",
      );
    }
    yield* Effect.tryPromise({
      try: async () => {
        const runRoot = await realpath(dirname(input.statePath));
        const evidence = await canonicalPathAllowingMissing(input.evidencePath);
        const relation = relative(runRoot, evidence);
        if (
          relation === "" ||
          relation === ".." ||
          relation.startsWith(`..${sep}`) ||
          isAbsolute(relation)
        ) {
          throw landingError(
            "landing.evidence_outside_run",
            "Landed evidence path must resolve inside the run directory.",
            "Choose a run-local path under reviews/.",
          );
        }
      },
      catch: (error) =>
        error instanceof LandingError
          ? error
          : landingError(
              "landing.evidence_path_failed",
              `Could not validate landed evidence path: ${(error as Error).message}`,
              "Verify the run directory and evidence parent are readable.",
            ),
    });
    const runtime = yield* attempt(() => parseActiveTicket(markdown, input.ticket));
    if (resolve(runtime.worktree) !== resolve(input.worktreePath)) {
      return yield* landingError(
        "landing.runtime_mismatch",
        "Supplied worktree does not match the active ticket runtime.",
        "Use the recorded worktree for landing and cleanup.",
      );
    }
    const repositoryRoot = spawnGit(["rev-parse", "--show-toplevel"], {
      cwd: input.repositoryPath,
    });
    const repositoryBranch = spawnGit(["symbolic-ref", "--short", "HEAD"], {
      cwd: input.repositoryPath,
    });
    if (repositoryRoot.exitCode !== 0)
      return yield* gitFailure("Integration checkout validation", repositoryRoot.stderr);
    if (
      realpathSync(repositoryRoot.stdout.trim()) !== realpathSync(input.repositoryPath) ||
      repositoryBranch.stdout.trim() !== baseBranch
    ) {
      return yield* landingError(
        "landing.base_checkout_mismatch",
        "Landing must run from the recorded local integration branch checkout.",
        "Use the persisted Base checkout and retry without assuming a remote.",
      );
    }
    const branchTip = spawnGit(["rev-parse", `refs/heads/${runtime.branch}`], {
      cwd: input.repositoryPath,
    });
    if (branchTip.exitCode !== 0)
      return yield* gitFailure("Ticket branch lookup", branchTip.stderr);
    if (branchTip.stdout.trim() !== integration.ticket_sha) {
      return yield* landingError(
        "landing.review_stale",
        "Ticket branch moved after its integration was bound.",
        "Run landing.rebase.check, rerun all gates, and repeat both review axes for the new tip.",
      );
    }
    for (const [axis, path] of [
      ["standards", integration.standards_evidence_path],
      ["spec", integration.spec_evidence_path],
    ] as const) {
      const evidence = yield* Effect.tryPromise({
        try: async () => JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>,
        catch: (error) =>
          landingError(
            "landing.review_evidence_missing",
            `Could not read ${axis} review evidence: ${(error as Error).message}`,
            "Restore the immutable accepted review evidence before landing.",
          ),
      });
      if (
        evidence.schema_version !== 1 ||
        evidence.ticket !== input.ticket ||
        evidence.axis !== axis ||
        evidence.status !== "accepted" ||
        evidence.verdict !== "PASS" ||
        evidence.head_before !== integration.reviewed_head
      ) {
        return yield* landingError(
          "landing.review_evidence_invalid",
          `${axis} review evidence is stale, failed, or belongs to another reviewed tip.`,
          "Repeat the axis against the current complete integration-base-to-ticket-tip range.",
        );
      }
    }
    yield* Effect.tryPromise({
      try: () => readFile(integration.self_review_path!, "utf8"),
      catch: (error) =>
        landingError(
          "landing.self_review_missing",
          `Could not read implementor self-review: ${(error as Error).message}`,
          "Restore the final round self-review before landing.",
        ),
    });
    return {
      policy,
      baseBranch,
      integration,
      runtime,
      reviewEvidence: {
        standards: integration.standards_evidence_path,
        spec: integration.spec_evidence_path,
        self_review: integration.self_review_path,
      },
    };
  });

const recordRebaseRequired = (
  input: LandingCompleteInput,
  ready: ReadyLanding,
): Effect.Effect<LandingCompleteResult, LandingError> =>
  mutateStateFile(input.statePath, (markdown) =>
    Effect.gen(function* () {
      const current = yield* attempt(() => parseIntegration(markdown, input.ticket));
      if (current?.ticket_sha !== ready.integration.ticket_sha) {
        return yield* landingError(
          "landing.integration_changed",
          `Ticket \`${input.ticket}\` integration changed while landing.`,
          "Reload RESUME.md and run landing.rebase.check for the current ticket tip.",
        );
      }
      const baseSha = spawnGit(["rev-parse", ready.baseBranch], { cwd: input.repositoryPath });
      if (baseSha.exitCode !== 0) return yield* gitFailure("Base HEAD lookup", baseSha.stderr);
      const record: IntegrationRecord = {
        ...current,
        phase: "rebase-required",
        base_sha: baseSha.stdout.trim(),
        review_range: `${baseSha.stdout.trim()}..${current.ticket_sha}`,
        passed_gates: [],
        completed_at: input.completedAt,
      };
      return {
        markdown: writeIntegration(markdown, input.ticket, record, phaseLabels["rebase-required"]),
        result: {
          ticket: input.ticket,
          action: "rebase" as const,
          phase: "rebase-required" as const,
          base_sha: record.base_sha,
          ticket_sha: record.ticket_sha,
          cycle: record.cycle,
          prompt: rebasePrompt({
            ticket: input.ticket,
            baseBranch: ready.baseBranch,
            baseSha: record.base_sha,
            worktreePath: ready.runtime.worktree,
          }),
        },
      };
    }),
  ).pipe(Effect.mapError(fromMutationError));

const recordLanding = (
  input: LandingCompleteInput,
  ready: ReadyLanding,
): Effect.Effect<LandingCompleteResult, LandingError> =>
  Effect.gen(function* () {
    const { policy, runtime, reviewEvidence } = ready;
    const ticketSha = ready.integration.ticket_sha;
    const landedBase = spawnGit(["rev-parse", ready.baseBranch], {
      cwd: input.repositoryPath,
    });
    if (landedBase.exitCode !== 0)
      return yield* gitFailure("Landed base lookup", landedBase.stderr);
    const runtimeClosure = yield* inspectRuntimeClose(runtime.pane).pipe(
      Effect.mapError((error) => new LandingError({ issue: error.issue })),
    );
    if (!runtimeClosure.runtime_closed) {
      return {
        ticket: input.ticket,
        action: "close-runtime" as const,
        phase: "ready-to-land" as const,
        base_sha: landedBase.stdout.trim(),
        ticket_sha: ticketSha,
        cycle: ready.integration.cycle,
        runtime_closed: false as const,
        pane_id: runtimeClosure.pane_id,
        close: runtimeClosure.close,
      };
    }

    const worktreeExists = existsSync(input.worktreePath);
    if (worktreeExists) {
      const worktreeStatus = spawnGit(["status", "--porcelain=v1", "--untracked-files=all"], {
        cwd: input.worktreePath,
      });
      if (worktreeStatus.exitCode !== 0)
        return yield* gitFailure("Landed worktree status", worktreeStatus.stderr);
      if (worktreeStatus.stdout !== "") {
        return yield* landingError(
          "landing.cleanup_dirty",
          "Landed worktree is not clean, so cleanup was refused.",
          "Inspect and clean the worktree without force, then retry completion.",
        );
      }
    }
    const landedAncestor = spawnGit(["merge-base", "--is-ancestor", ticketSha, ready.baseBranch], {
      cwd: input.repositoryPath,
    });
    if (landedAncestor.exitCode !== 0) {
      return yield* landingError(
        "landing.cleanup_unlanded",
        "Worktree cleanup was refused because the ticket tip is not landed.",
        "Restore the reviewed fast-forward before removing the worktree.",
      );
    }

    let cleanupArgv: string[];
    if (policy.cleanup === "native-safe") {
      if (input.cleanupArgv !== undefined) {
        return yield* landingError(
          "landing.cleanup_policy_mismatch",
          "Native-safe cleanup does not accept a repository cleanup command.",
          "Pass cleanup_argv as null so the helper can remove the worktree without force.",
        );
      }
      cleanupArgv = ["git", "worktree", "remove", input.worktreePath];
      if (worktreeExists) {
        const removed = spawnGit(["worktree", "remove", input.worktreePath], {
          cwd: input.repositoryPath,
        });
        if (removed.exitCode !== 0)
          return yield* gitFailure("Non-force worktree removal", removed.stderr);
      }
    } else {
      if (input.cleanupArgv === undefined) {
        return yield* landingError(
          "landing.cleanup_policy_mismatch",
          "Repository cleanup policy requires its exact cleanup command.",
          "Pass the argument array authorized by repository instructions.",
        );
      }
      cleanupArgv = input.cleanupArgv;
      if (worktreeExists) {
        yield* runExactCommand(cleanupArgv, input.repositoryPath, "Repository worktree cleanup");
      }
    }
    const worktreeList = spawnGit(["worktree", "list", "--porcelain"], {
      cwd: input.repositoryPath,
    });
    if (worktreeList.exitCode !== 0)
      return yield* gitFailure("Worktree removal verification", worktreeList.stderr);
    const listedPaths = worktreeList.stdout
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => resolve(line.slice("worktree ".length)));
    if (listedPaths.includes(resolve(input.worktreePath)) || existsSync(input.worktreePath)) {
      return yield* landingError(
        "landing.cleanup_incomplete",
        "Repository cleanup did not remove the landed ticket worktree.",
        "Complete the repository-prescribed cleanup without force, then retry.",
      );
    }
    const retained = spawnGit(["show-ref", "--verify", `refs/heads/${runtime.branch}`], {
      cwd: input.repositoryPath,
    });
    if (retained.exitCode !== 0) {
      return yield* landingError(
        "landing.branch_missing",
        "Cleanup removed the landed ticket branch, but retention is required.",
        "Restore the branch at the landed tip before recording completion.",
      );
    }

    const cleanup = {
      kind: policy.cleanup,
      argv: cleanupArgv,
      runtime_closed: true as const,
      worktree_removed: true as const,
      branch_retained: true as const,
    };
    const evidenceBody = `${JSON.stringify(
      {
        schema_version: 1,
        ticket: input.ticket,
        landed_tip: ticketSha,
        base_sha: ticketSha,
        integration_cycle: ready.integration.cycle,
        branch: runtime.branch,
        review_evidence: reviewEvidence,
        cleanup,
        completed_at: input.completedAt,
      },
      null,
      2,
    )}\n`;
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(input.evidencePath), { recursive: true });
        try {
          await writeFile(input.evidencePath, evidenceBody, { flag: "wx" });
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
          if ((await readFile(input.evidencePath, "utf8")) !== evidenceBody) throw error;
        }
      },
      catch: (error) =>
        landingError(
          "landing.evidence_write_failed",
          `Could not persist immutable landed evidence: ${(error as Error).message}`,
          "Choose an unused run-local path or recover the byte-identical evidence file.",
        ),
    });

    yield* mutateStateFile(input.statePath, (state) =>
      Effect.gen(function* () {
        const current = yield* attempt(() => parseIntegration(state, input.ticket));
        if (current?.ticket_sha !== ticketSha) {
          return yield* landingError(
            "landing.integration_changed",
            `Ticket \`${input.ticket}\` integration changed before landing was recorded.`,
            "Reload RESUME.md before recording landed state.",
          );
        }
        let updated = yield* attempt(() => updateTicketAsLanded(state, input.ticket, ticketSha));
        updated = updated.replace(activeRuntimeBlockPattern(input.ticket), "");
        updated = appendLandedEvidence(
          updated,
          input.ticket,
          input.evidencePath,
          ticketSha,
          runtime.branch,
          policy.cleanup,
        );
        updated = updated.replace(
          /^Base sha:\s*.*$/mu,
          `Base sha:        ${landedBase.stdout.trim()}`,
        );
        updated = appendRetainedBranch(updated, runtime.branch, ticketSha);
        return { markdown: updated, result: undefined };
      }),
    ).pipe(Effect.mapError(fromMutationError));
    return {
      ticket: input.ticket,
      action: "schedule" as const,
      phase: "landed" as const,
      landed_tip: ticketSha,
      base_sha: landedBase.stdout.trim(),
      review_evidence: reviewEvidence,
      cleanup,
      evidence_path: input.evidencePath,
    };
  });

/**
 * Lands a ready ticket through the shared land lock, then closes, cleans, and records it.
 *
 * The lock step fast-forwards the base checkout only when the base is still an ancestor of the
 * reviewed tip; otherwise the ticket bounces to its implementor with `action: "rebase"`. The
 * record step inspects the exact Herdr pane, removes the worktree without force, writes immutable
 * landed evidence, and marks the ticket landed. Repeating the call after a landed lock step skips
 * the merge and resumes the record step.
 *
 * @param input - Landing checkout, worktree, evidence, cleanup policy command, and lock wait.
 * @returns The rebase bounce, the runtime close handshake, or durable landed provenance.
 */
export const completeLanding = (
  input: LandingCompleteInput,
): Effect.Effect<LandingCompleteResult, LandingError> =>
  Effect.gen(function* () {
    const ready = yield* validateReadyLanding(input);
    const landed = yield* landTicket({
      repositoryPath: input.repositoryPath,
      baseBranch: ready.baseBranch,
      ticketSha: ready.integration.ticket_sha,
      waitSeconds: input.lockWaitSeconds ?? LAND_LOCK_WAIT_SECONDS,
    });
    if (landed.outcome === "rebase_required") return yield* recordRebaseRequired(input, ready);
    if (landed.outcome === "dirty") {
      return yield* landingError(
        "landing.base_dirty",
        `Local integration checkout must be clean before fast-forward landing: ${landed.output}`,
        "Finish or remove unrelated local changes in the base checkout, then retry the same landing.",
      );
    }
    if (landed.outcome === "timeout") {
      return yield* landingError(
        "landing.lock_timeout",
        "Timed out waiting for the shared land-local.lock; another landing appears wedged.",
        "Investigate the process holding the lock before retrying the same landing.",
      );
    }
    return yield* recordLanding(input, ready);
  });
