import { Data, Effect } from "effect";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  CliIssue,
  CommitPolicy,
  LandingCompleteInput,
  LandingConflictRecordInput,
  LandingSynchronizeInput,
} from "./contract.ts";
import { activeRuntimeBlockPattern, parseActiveRuntimeFields } from "./active-runtime.ts";
import { cleanGitEnv, spawnGit } from "./git.ts";
import { inspectRuntimeClose } from "./runtime-close.ts";
import { mutateStateFile, StateMutationError } from "./state-mutation.ts";
import { validateStateText } from "./state.ts";

type FinalizationPhase =
  | "synchronizing"
  | "conflict"
  | "awaiting-user"
  | "fixing"
  | "gates"
  | "ready-to-land"
  | "resynchronize";

type FinalizationRecord = {
  ticket: string;
  cycle: number;
  phase: FinalizationPhase;
  base_branch: string;
  base_sha: string | null;
  ticket_sha: string | null;
  review_range: string | null;
  commit_count: number | null;
  commit_policy: CommitPolicy;
  remote_sync_argv: string[] | null;
  conflicts: string[];
  previous_ticket_sha: string | null;
  standards_evidence_path: string | null;
  spec_evidence_path: string | null;
  self_review_path: string | null;
  completed_at: string;
};

type PersistedRepositoryPolicy = {
  remote: "local-only" | "repository";
  remote_sync_argv: string[] | null;
  cleanup: "native-safe" | "repository";
  commit: CommitPolicy;
};

/**
 * Typed synchronization, conflict, landing, or cleanup failure returned through the CLI.
 */
export class LandingError extends Data.TaggedError("LandingError")<{
  issue: CliIssue;
}> {}

const landingError = (code: string, message: string, remediation: string): LandingError =>
  new LandingError({ issue: { code, message, remediation } });

const fromMutationError = (error: unknown): LandingError => {
  if (error instanceof LandingError) return error;
  const detail = error instanceof StateMutationError ? error.message : (error as Error).message;
  return landingError(
    error instanceof StateMutationError && error.kind === "lock_busy"
      ? "landing.state_busy"
      : "landing.state_io_failed",
    `Could not update serialized finalization state: ${detail}`,
    "Verify RESUME.md is writable, then retry the same operation.",
  );
};

const finalizationPattern =
  /^## Serialized finalization\s*\r?\n\r?\n```json\r?\n([\s\S]*?)\r?\n```\s*$/mu;

const parseFinalization = (markdown: string): FinalizationRecord | undefined => {
  const match = markdown.match(finalizationPattern);
  if (match === null) return undefined;
  try {
    return JSON.parse(match[1]!) as FinalizationRecord;
  } catch {
    throw landingError(
      "landing.finalization_malformed",
      "RESUME.md contains malformed serialized finalization JSON.",
      "Repair the finalization record from durable evidence before continuing.",
    );
  }
};

const renderFinalization = (record: FinalizationRecord): string =>
  `## Serialized finalization\n\n\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\``;

const upsertFinalization = (markdown: string, record: FinalizationRecord): string => {
  const rendered = renderFinalization(record);
  if (finalizationPattern.test(markdown)) return markdown.replace(finalizationPattern, rendered);
  const insertion =
    /^## Review evidence\s*$/mu.exec(markdown)?.index ??
    /^## Decisions\s*$/mu.exec(markdown)?.index ??
    markdown.length;
  return `${markdown.slice(0, insertion).trimEnd()}\n\n${rendered}\n\n${markdown
    .slice(insertion)
    .trimStart()}`;
};

const parseRepositoryPolicy = (markdown: string): PersistedRepositoryPolicy => {
  const match = markdown.match(
    /^## Repository policy\s*\r?\n\r?\n```json\r?\n([\s\S]*?)\r?\n```\s*$/mu,
  );
  if (match === null) {
    throw landingError(
      "landing.repository_policy_missing",
      "RESUME.md has no persisted Repository policy.",
      "Resolve repository synchronization, cleanup, and commit policy before finalization.",
    );
  }
  try {
    const value = JSON.parse(match[1]!) as Partial<PersistedRepositoryPolicy>;
    const commit = value.commit;
    const remoteSyncArgv = value.remote_sync_argv;
    if (
      (value.remote !== "local-only" && value.remote !== "repository") ||
      (value.remote === "local-only" && remoteSyncArgv !== null) ||
      (value.remote === "repository" &&
        (!Array.isArray(remoteSyncArgv) ||
          remoteSyncArgv.length === 0 ||
          remoteSyncArgv.some(
            (argument) =>
              typeof argument !== "string" || argument.length === 0 || /[\r\n]/u.test(argument),
          ))) ||
      (value.cleanup !== "native-safe" && value.cleanup !== "repository") ||
      commit === undefined ||
      (commit.commits !== "multiple" &&
        commit.commits !== "single" &&
        commit.commits !== "squash") ||
      (commit.fixes !== "append" && commit.fixes !== "amend" && commit.fixes !== "squash")
    ) {
      throw new Error("invalid policy fields");
    }
    return {
      remote: value.remote,
      remote_sync_argv: value.remote === "repository" ? (remoteSyncArgv ?? null) : null,
      cleanup: value.cleanup,
      commit,
    };
  } catch {
    throw landingError(
      "landing.repository_policy_malformed",
      "RESUME.md contains an incomplete Repository policy.",
      "Repair the persisted remote, cleanup, and commit records before finalization.",
    );
  }
};

const parseBaseBranch = (markdown: string): string => {
  const matches = [...markdown.matchAll(/^Base:\s*(\S[^\r\n]*)$/gmu)];
  if (matches.length !== 1) {
    throw landingError(
      "landing.base_malformed",
      "RESUME.md must contain exactly one non-empty Base field.",
      "Repair the schema-1 run header before synchronization.",
    );
  }
  return matches[0]![1]!;
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
      "Restore its durable runtime before synchronization or landing.",
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

const updateActivePhase = (markdown: string, ticket: string, phase: string): string => {
  const pattern = activeRuntimeBlockPattern(ticket);
  const block = markdown.match(pattern)?.[0];
  if (block === undefined) return markdown;
  const updated = /^Phase:.*$/mu.test(block)
    ? block.replace(/^Phase:.*$/mu, `Phase: ${phase}`)
    : `${block.trimEnd()}\nPhase: ${phase}\n`;
  return markdown.replace(pattern, updated);
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
        "Restore or select the persisted local integration branch before synchronization.",
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

const updateFinalization = (
  statePath: string,
  ticket: string,
  record: FinalizationRecord,
  phase: string,
): Effect.Effect<void, LandingError> =>
  mutateStateFile(statePath, (markdown) =>
    Effect.gen(function* () {
      const current = parseFinalization(markdown);
      if (current?.ticket !== ticket) {
        return yield* landingError(
          "landing.serialization_lost",
          `Ticket \`${ticket}\` no longer owns serialized finalization.`,
          "Reload RESUME.md and continue only with the recorded finalization ticket.",
        );
      }
      let updated = updateActivePhase(upsertFinalization(markdown, record), ticket, phase);
      if (record.base_sha !== null) {
        updated = updated.replace(/^Base sha:\s*.*$/mu, `Base sha:        ${record.base_sha}`);
      }
      return { markdown: updated, result: undefined };
    }),
  ).pipe(Effect.mapError(fromMutationError));

/**
 * Claims the single finalization slot and rebases one clean ticket branch onto the local base.
 *
 * @param input - Run state, integration checkout, ticket worktree, and optional policy command.
 * @returns The exact review range or the conflict/fix action required next.
 */
export const synchronizeLanding = (
  input: LandingSynchronizeInput,
): Effect.Effect<
  {
    ticket: string;
    action: "run-gates" | "resolve-conflicts" | "fix-commits";
    phase: "gates" | "conflict" | "fixing";
    base_branch: string;
    base_sha: string;
    ticket_sha: string;
    review_range: string;
    commit_count: number;
    commit_policy: CommitPolicy;
    remote_sync_argv: string[] | null;
    conflicts: string[];
    cycle: number;
  },
  LandingError
> =>
  Effect.gen(function* () {
    const claim = yield* mutateStateFile(input.statePath, (markdown) =>
      Effect.gen(function* () {
        yield* validateStateText(input.statePath, markdown).pipe(
          Effect.mapError((error) => new LandingError({ issue: error.issue })),
        );
        const policy = parseRepositoryPolicy(markdown);
        const baseBranch = parseBaseBranch(markdown);
        const runtime = parseActiveTicket(markdown, input.ticket);
        const existing = parseFinalization(markdown);
        if (existing !== undefined && existing.ticket !== input.ticket) {
          return yield* landingError(
            "landing.serialized",
            `Ticket \`${existing.ticket}\` already owns serialized finalization in phase \`${existing.phase}\`.`,
            "Keep other implementors running, but wait for that ticket to leave synchronization, gates, review, and landing.",
          );
        }
        if (existing?.phase === "conflict" || existing?.phase === "awaiting-user") {
          return yield* landingError(
            "landing.conflict_pending",
            `Ticket \`${input.ticket}\` has unresolved synchronization coordination work.`,
            "Finish and classify the recorded conflict before synchronizing again.",
          );
        }
        const cycle =
          existing?.phase === "resynchronize" ? existing.cycle + 1 : (existing?.cycle ?? 0);
        const record: FinalizationRecord = {
          ticket: input.ticket,
          cycle,
          phase: "synchronizing",
          base_branch: baseBranch,
          base_sha: existing?.base_sha ?? null,
          ticket_sha: existing?.ticket_sha ?? null,
          review_range: null,
          commit_count: null,
          commit_policy: policy.commit,
          remote_sync_argv: policy.remote_sync_argv,
          conflicts: [],
          previous_ticket_sha: existing?.previous_ticket_sha ?? null,
          standards_evidence_path: null,
          spec_evidence_path: null,
          self_review_path: null,
          completed_at: input.completedAt,
        };
        return {
          markdown: updateActivePhase(
            upsertFinalization(markdown, record),
            input.ticket,
            "synchronizing with local base",
          ),
          result: { policy, baseBranch, runtime, record, previousPhase: existing?.phase },
        };
      }),
    ).pipe(Effect.mapError(fromMutationError));

    yield* validateRepositoryAndWorktree(
      input.repositoryPath,
      input.worktreePath,
      claim.runtime.worktree,
      claim.runtime.branch,
      claim.baseBranch,
    );
    const status = spawnGit(["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: input.worktreePath,
    });
    if (status.exitCode !== 0) return yield* gitFailure("Worktree status", status.stderr);
    if (status.stdout !== "") {
      return yield* landingError(
        "landing.worktree_dirty",
        "Ticket worktree must be clean before synchronization.",
        "Commit policy-compliant work or return it to the bound implementor before finalization.",
      );
    }
    if (claim.policy.remote === "local-only" && input.remoteSyncArgv !== undefined) {
      return yield* landingError(
        "landing.remote_policy_mismatch",
        "Local-only repository policy forbids a remote synchronization command.",
        "Pass remote_sync_argv as null and synchronize from the current local integration branch.",
      );
    }
    if (claim.policy.remote === "repository" && input.remoteSyncArgv === undefined) {
      return yield* landingError(
        "landing.remote_policy_mismatch",
        "Repository synchronization policy requires an exact remote command.",
        "Pass the argument array authorized by repository instructions or explicit run policy.",
      );
    }
    if (
      claim.policy.remote === "repository" &&
      JSON.stringify(input.remoteSyncArgv) !== JSON.stringify(claim.policy.remote_sync_argv)
    ) {
      return yield* landingError(
        "landing.remote_policy_mismatch",
        "Remote synchronization command does not match persisted repository policy.",
        "Pass the exact remote_sync_argv persisted in Repository policy.",
      );
    }
    if (input.remoteSyncArgv !== undefined) {
      yield* runExactCommand(
        input.remoteSyncArgv,
        input.repositoryPath,
        "Repository synchronization",
      );
    }

    const ticketBefore = spawnGit(["rev-parse", "HEAD"], { cwd: input.worktreePath });
    if (ticketBefore.exitCode !== 0)
      return yield* gitFailure("Ticket HEAD lookup", ticketBefore.stderr);
    if (
      claim.previousPhase !== "resynchronize" &&
      claim.policy.commit.fixes === "append" &&
      claim.record.previous_ticket_sha !== null
    ) {
      const ancestor = spawnGit(
        [
          "merge-base",
          "--is-ancestor",
          claim.record.previous_ticket_sha,
          ticketBefore.stdout.trim(),
        ],
        { cwd: input.worktreePath },
      );
      if (
        ancestor.exitCode !== 0 ||
        claim.record.previous_ticket_sha === ticketBefore.stdout.trim()
      ) {
        yield* updateFinalization(
          input.statePath,
          input.ticket,
          {
            ...claim.record,
            phase: "fixing",
            ticket_sha: ticketBefore.stdout.trim(),
            completed_at: input.completedAt,
          },
          "commit policy fix required",
        );
        return yield* landingError(
          "landing.fix_policy_violated",
          "The fix round did not append a commit to the previously reviewed ticket tip.",
          "Return the ticket to its bound implementor and apply the persisted append fix policy.",
        );
      }
    }

    const rebased = spawnGit(["rebase", claim.baseBranch], { cwd: input.worktreePath });
    if (rebased.exitCode !== 0) {
      const conflictResult = spawnGit(["diff", "--name-only", "--diff-filter=U"], {
        cwd: input.worktreePath,
      });
      const conflicts = conflictResult.stdout
        .split(/\r?\n/u)
        .filter((path) => path.length > 0)
        .toSorted();
      if (conflicts.length === 0)
        return yield* gitFailure("Ticket synchronization", rebased.stderr);
      const baseSha = spawnGit(["rev-parse", claim.baseBranch], {
        cwd: input.repositoryPath,
      }).stdout.trim();
      const record = {
        ...claim.record,
        phase: "conflict" as const,
        base_sha: baseSha,
        ticket_sha: ticketBefore.stdout.trim(),
        conflicts,
      };
      yield* updateFinalization(input.statePath, input.ticket, record, "synchronization conflict");
      return {
        ticket: input.ticket,
        action: "resolve-conflicts" as const,
        phase: "conflict" as const,
        base_branch: claim.baseBranch,
        base_sha: baseSha,
        ticket_sha: ticketBefore.stdout.trim(),
        review_range: `${baseSha}..${ticketBefore.stdout.trim()}`,
        commit_count: Number(
          spawnGit(["rev-list", "--count", `${claim.baseBranch}..HEAD`], {
            cwd: input.worktreePath,
          }).stdout.trim() || "0",
        ),
        commit_policy: claim.policy.commit,
        remote_sync_argv: claim.policy.remote_sync_argv,
        conflicts,
        cycle: claim.record.cycle,
      };
    }

    const baseShaResult = spawnGit(["rev-parse", claim.baseBranch], { cwd: input.repositoryPath });
    const ticketShaResult = spawnGit(["rev-parse", "HEAD"], { cwd: input.worktreePath });
    const countResult = spawnGit(["rev-list", "--count", `${claim.baseBranch}..HEAD`], {
      cwd: input.worktreePath,
    });
    if (baseShaResult.exitCode !== 0)
      return yield* gitFailure("Base HEAD lookup", baseShaResult.stderr);
    if (ticketShaResult.exitCode !== 0)
      return yield* gitFailure("Ticket HEAD lookup", ticketShaResult.stderr);
    if (countResult.exitCode !== 0)
      return yield* gitFailure("Commit range lookup", countResult.stderr);
    const baseSha = baseShaResult.stdout.trim();
    const ticketSha = ticketShaResult.stdout.trim();
    const commitCount = Number(countResult.stdout.trim());
    const commitShapeValid =
      claim.policy.commit.commits === "multiple" ? commitCount > 0 : commitCount === 1;
    const action = commitShapeValid ? ("run-gates" as const) : ("fix-commits" as const);
    const phase = commitShapeValid ? ("gates" as const) : ("fixing" as const);
    const record: FinalizationRecord = {
      ...claim.record,
      phase,
      base_sha: baseSha,
      ticket_sha: ticketSha,
      review_range: `${baseSha}..${ticketSha}`,
      commit_count: commitCount,
      conflicts: [],
      previous_ticket_sha: commitShapeValid ? null : ticketSha,
    };
    yield* updateFinalization(
      input.statePath,
      input.ticket,
      record,
      commitShapeValid ? "gates" : "commit policy fix required",
    );
    return {
      ticket: input.ticket,
      action,
      phase,
      base_branch: claim.baseBranch,
      base_sha: baseSha,
      ticket_sha: ticketSha,
      review_range: `${baseSha}..${ticketSha}`,
      commit_count: commitCount,
      commit_policy: claim.policy.commit,
      remote_sync_argv: claim.policy.remote_sync_argv,
      conflicts: [],
      cycle: claim.record.cycle,
    };
  });

/**
 * Records the coordinator's classification after a synchronization conflict is resolved.
 *
 * @param input - Conflict classification and any explicit user-authorized scope decision.
 * @returns The next finalization action.
 */
export const recordLandingConflict = (
  input: LandingConflictRecordInput,
): Effect.Effect<
  {
    ticket: string;
    classification: LandingConflictRecordInput["classification"];
    action: "run-gates" | "fix" | "await-user";
    phase: "gates" | "fixing" | "awaiting-user";
    base_sha: string;
    ticket_sha: string;
    review_range: string;
    commit_count: number;
    decision: string | null;
    user_authorized: boolean;
  },
  LandingError
> =>
  mutateStateFile(input.statePath, (markdown) =>
    Effect.gen(function* () {
      const finalization = parseFinalization(markdown);
      if (
        finalization === undefined ||
        finalization.ticket !== input.ticket ||
        (finalization.phase !== "conflict" && finalization.phase !== "awaiting-user")
      ) {
        return yield* landingError(
          "landing.conflict_not_pending",
          `Ticket \`${input.ticket}\` has no pending serialized conflict to classify.`,
          "Synchronize the ticket and resolve its recorded conflict before classifying it.",
        );
      }
      const runtime = parseActiveTicket(markdown, input.ticket);
      const status = spawnGit(["status", "--porcelain=v1", "--untracked-files=all"], {
        cwd: runtime.worktree,
      });
      const unmerged = spawnGit(["diff", "--name-only", "--diff-filter=U"], {
        cwd: runtime.worktree,
      });
      if (status.exitCode !== 0)
        return yield* gitFailure("Resolved worktree status", status.stderr);
      if (unmerged.exitCode !== 0) return yield* gitFailure("Conflict status", unmerged.stderr);
      if (status.stdout !== "" || unmerged.stdout !== "") {
        return yield* landingError(
          "landing.conflict_unresolved",
          "Synchronization conflict resolution must be complete and clean before classification.",
          "Finish the rebase and commit the textual resolution before recording its classification.",
        );
      }
      const baseResult = spawnGit(["rev-parse", finalization.base_branch], {
        cwd: runtime.worktree,
      });
      const ticketResult = spawnGit(["rev-parse", "HEAD"], { cwd: runtime.worktree });
      const countResult = spawnGit(["rev-list", "--count", `${finalization.base_branch}..HEAD`], {
        cwd: runtime.worktree,
      });
      if (baseResult.exitCode !== 0)
        return yield* gitFailure("Base HEAD lookup", baseResult.stderr);
      if (ticketResult.exitCode !== 0)
        return yield* gitFailure("Ticket HEAD lookup", ticketResult.stderr);
      if (countResult.exitCode !== 0)
        return yield* gitFailure("Commit range lookup", countResult.stderr);
      const baseSha = baseResult.stdout.trim();
      const ticketSha = ticketResult.stdout.trim();
      const commitCount = Number(countResult.stdout.trim());
      const commitShapeValid =
        finalization.commit_policy.commits === "multiple" ? commitCount > 0 : commitCount === 1;
      if (!commitShapeValid) {
        return yield* landingError(
          "landing.commit_policy_violated",
          `Resolved ticket range contains ${commitCount} commits under \`${finalization.commit_policy.commits}\` policy.`,
          "Return commit-shape adaptation to the bound implementor before final gates.",
        );
      }

      const awaitingUser = input.classification === "scope" && !input.userAuthorized;
      const substantive = input.classification === "substantive";
      const phase: "awaiting-user" | "fixing" | "gates" = awaitingUser
        ? "awaiting-user"
        : substantive
          ? "fixing"
          : "gates";
      const action: "await-user" | "fix" | "run-gates" = awaitingUser
        ? "await-user"
        : substantive
          ? "fix"
          : "run-gates";
      const record: FinalizationRecord = {
        ...finalization,
        phase,
        base_sha: baseSha,
        ticket_sha: ticketSha,
        review_range: `${baseSha}..${ticketSha}`,
        commit_count: commitCount,
        conflicts: [],
        previous_ticket_sha: substantive ? ticketSha : null,
        completed_at: input.completedAt,
      };
      let updated = upsertFinalization(markdown, record);
      updated = updateActivePhase(
        updated,
        input.ticket,
        awaitingUser
          ? "awaiting user scope authority"
          : substantive
            ? "substantive conflict adaptation requires implementor fix"
            : "gates",
      );
      if (input.classification === "scope" && input.userAuthorized) {
        const decisionHeading = /^## Decisions\s*$/mu.exec(updated);
        if (decisionHeading === null) {
          return yield* landingError(
            "landing.decisions_missing",
            "RESUME.md has no Decisions section for the authorized scope choice.",
            "Repair the schema-1 state template before proceeding.",
          );
        }
        const insertion = decisionHeading.index + decisionHeading[0].length;
        updated = `${updated.slice(0, insertion)}\n\n- ${input.completedAt.slice(0, 10)} ticket ${input.ticket} scope decision (user authorized): ${input.decision}\n${updated
          .slice(insertion)
          .replace(/^\s*/u, "")}`;
      }
      return {
        markdown: updated,
        result: {
          ticket: input.ticket,
          classification: input.classification,
          action,
          phase,
          base_sha: baseSha,
          ticket_sha: ticketSha,
          review_range: `${baseSha}..${ticketSha}`,
          commit_count: commitCount,
          decision: input.decision ?? null,
          user_authorized: input.userAuthorized,
        },
      };
    }),
  ).pipe(Effect.mapError(fromMutationError));

const ticketTableSection = (markdown: string): { start: number; end: number; text: string } => {
  const heading = /^## Tickets\s*$/mu.exec(markdown);
  if (heading === null) {
    throw landingError(
      "landing.tickets_missing",
      "RESUME.md has no Tickets section.",
      "Repair the schema-1 ticket table before recording landing.",
    );
  }
  const start = heading.index + heading[0].length;
  const next = /^## /gmu;
  next.lastIndex = start;
  const end = next.exec(markdown)?.index ?? markdown.length;
  return { start, end, text: markdown.slice(start, end) };
};

const updateTicketAsLanded = (markdown: string, ticket: string, sha: string): string => {
  const section = ticketTableSection(markdown);
  const lines = section.text.split(/\r?\n/u);
  const headerIndex = lines.findIndex((line) => line.trimStart().startsWith("| NN"));
  const columns =
    headerIndex < 0
      ? []
      : lines[headerIndex]!.split("|")
          .slice(1, -1)
          .map((cell) => cell.trim());
  const rowIndex = lines.findIndex((line) => line.split("|")[1]?.trim() === ticket);
  if (headerIndex < 0 || rowIndex < 0) {
    throw landingError(
      "landing.ticket_missing",
      `Ticket \`${ticket}\` is absent from the state table.`,
      "Restore the normalized ticket row before recording landing.",
    );
  }
  const cells = lines[rowIndex]!.split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
  const statusIndex = columns.indexOf("status");
  const shaIndex = columns.indexOf("sha");
  if (cells.length !== columns.length || statusIndex < 0 || shaIndex < 0) {
    throw landingError(
      "landing.ticket_table_malformed",
      "Ticket table is missing status or sha columns.",
      "Repair the schema-1 ticket table before recording landing.",
    );
  }
  cells[statusIndex] = "landed";
  cells[shaIndex] = sha;
  lines[rowIndex] = `| ${cells.join(" | ")} |`;
  return `${markdown.slice(0, section.start)}${lines.join("\n")}${markdown.slice(section.end)}`;
};

const appendSectionLine = (markdown: string, heading: string, line: string): string => {
  const expression = new RegExp(`^## ${heading}\\s*$`, "mu");
  const match = expression.exec(markdown);
  if (match === null) return `${markdown.trimEnd()}\n\n## ${heading}\n\n${line}\n`;
  const start = match.index + match[0].length;
  const next = /^## /gmu;
  next.lastIndex = start;
  const end = next.exec(markdown)?.index ?? markdown.length;
  const section = markdown.slice(start, end).trimEnd();
  if (section.split(/\r?\n/u).includes(line)) return markdown;
  return `${markdown.slice(0, start)}${section}\n\n${line}\n${markdown.slice(end)}`;
};

const appendRetainedBranch = (markdown: string, branch: string, sha: string): string =>
  appendSectionLine(markdown, "Retained landed branches", `- ${branch} (${sha})`);

const appendLandedEvidence = (
  markdown: string,
  ticket: string,
  evidencePath: string,
  ticketSha: string,
  branch: string,
  cleanup: "native-safe" | "repository",
): string => {
  const withoutFinalization = markdown.replace(finalizationPattern, "");
  return appendSectionLine(
    withoutFinalization,
    "Landed evidence",
    `- Ticket ${ticket}: ${evidencePath}; tip ${ticketSha}; branch ${branch}; cleanup ${cleanup}`,
  );
};

/**
 * Marks an owned synchronized ticket as requiring an implementor fix.
 *
 * @param markdown - Latest locked run-state Markdown.
 * @param input - Ticket, reviewed tip, completion time, and active phase label.
 * @returns Updated Markdown, or the original text when no serialized finalization exists.
 */
export const applyFinalizationFix = (
  markdown: string,
  input: { ticket: string; reviewedHead: string; completedAt: string; phase: string },
): string => {
  const finalization = parseFinalization(markdown);
  if (finalization === undefined) return markdown;
  if (finalization.ticket !== input.ticket || finalization.ticket_sha !== input.reviewedHead) {
    throw landingError(
      "landing.review_stale",
      "Fix evidence does not match the ticket owning serialized finalization.",
      "Rerun synchronization and gates against the current serialized ticket tip.",
    );
  }
  return updateActivePhase(
    upsertFinalization(markdown, {
      ...finalization,
      phase: "fixing",
      previous_ticket_sha: input.reviewedHead,
      standards_evidence_path: null,
      spec_evidence_path: null,
      self_review_path: null,
      completed_at: input.completedAt,
    }),
    input.ticket,
    input.phase,
  );
};

/**
 * Restores gate review after an authorized same-HEAD rerun proves a failed gate was transient.
 *
 * @param markdown - Latest locked run-state Markdown.
 * @param input - Exact gate evidence, unchanged ticket identity, and reconstructed range details.
 * @returns Updated Markdown plus whether the same transition was already durable.
 */
export const applyNoChangeGateRerun = (
  markdown: string,
  input: {
    ticket: string;
    name: string;
    reviewedHead: string;
    baseSha: string;
    commitCount: number;
    previousEvidencePath: string;
    evidencePath: string;
    diagnostic: string;
    completedAt: string;
  },
): { markdown: string; recovered: boolean } => {
  const finalization = parseFinalization(markdown);
  if (finalization === undefined) {
    throw landingError(
      "landing.finalization_missing",
      "No serialized finalization exists for the no-change gate rerun.",
      "Synchronize the ticket and record its failed gate before recovery.",
    );
  }
  const decision = `- ${input.completedAt.slice(0, 10)} ticket ${input.ticket} user-authorized no-change rerun of gate ${input.name}: ${input.diagnostic}; prior ${input.previousEvidencePath}; passing ${input.evidencePath}`;
  const commitShapeValid =
    finalization.commit_policy.commits === "multiple"
      ? input.commitCount > 0
      : input.commitCount === 1;
  const alreadyRecovered =
    finalization.ticket === input.ticket &&
    finalization.phase === "gates" &&
    finalization.ticket_sha === input.reviewedHead &&
    finalization.base_sha === input.baseSha &&
    finalization.previous_ticket_sha === null &&
    finalization.review_range === `${input.baseSha}..${input.reviewedHead}` &&
    finalization.commit_count === input.commitCount &&
    finalization.completed_at === input.completedAt &&
    markdown.includes(decision);
  if (alreadyRecovered) return { markdown, recovered: true };
  if (
    finalization.ticket !== input.ticket ||
    (finalization.phase !== "fixing" && finalization.phase !== "synchronizing") ||
    finalization.ticket_sha !== input.reviewedHead ||
    finalization.previous_ticket_sha !== input.reviewedHead ||
    finalization.base_sha !== input.baseSha ||
    finalization.commit_policy.fixes !== "append" ||
    !commitShapeValid
  ) {
    throw landingError(
      "landing.gate_rerun_state_invalid",
      "No-change gate recovery does not match the append-only serialized finalization binding.",
      "Preserve the failed gate, ticket tip, base, and append policy before recording the passing rerun.",
    );
  }
  const record: FinalizationRecord = {
    ...finalization,
    phase: "gates",
    review_range: `${input.baseSha}..${input.reviewedHead}`,
    commit_count: input.commitCount,
    previous_ticket_sha: null,
    standards_evidence_path: null,
    spec_evidence_path: null,
    self_review_path: null,
    completed_at: input.completedAt,
  };
  const withFinalization = updateActivePhase(
    upsertFinalization(markdown, record),
    input.ticket,
    "gates after authorized no-change rerun",
  );
  return {
    markdown: appendSectionLine(withFinalization, "Decisions", decision),
    recovered: false,
  };
};

/**
 * Advances an owned serialized finalization record from external review to fixing or landing.
 *
 * Runs with the caller's existing state lock. State without a finalization record is preserved
 * for compatibility with review-only workflows that have not entered ticket finalization.
 *
 * @param markdown - Latest locked run-state Markdown.
 * @param input - Final verdict, reviewed tip, and immutable evidence paths.
 * @returns Updated Markdown with durable review provenance in the finalization record.
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
  const finalization = parseFinalization(markdown);
  if (finalization === undefined) return markdown;
  if (finalization.ticket !== input.ticket) {
    throw landingError(
      "landing.serialized",
      `Ticket \`${finalization.ticket}\` owns serialized finalization, not \`${input.ticket}\`.`,
      "Finalize review only for the ticket holding the serialized slot.",
    );
  }
  if (finalization.phase !== "gates") {
    throw landingError(
      "landing.review_phase_invalid",
      "Final review requires serialized finalization to remain in the gates phase.",
      "Rerun every configured gate and both review axes against the current synchronized ticket tip.",
    );
  }
  if (finalization.ticket_sha !== input.reviewedHead) {
    throw landingError(
      "landing.review_stale",
      "Final review evidence does not match the synchronized ticket tip.",
      "Rerun gates and both review axes against the complete recorded review range.",
    );
  }
  const passed = input.verdict === "PASS";
  if (!passed) {
    return applyFinalizationFix(markdown, {
      ticket: input.ticket,
      reviewedHead: input.reviewedHead,
      completedAt: input.completedAt,
      phase: "review fixes required",
    });
  }
  const record: FinalizationRecord = {
    ...finalization,
    phase: "ready-to-land",
    previous_ticket_sha: null,
    standards_evidence_path: input.standardsEvidencePath,
    spec_evidence_path: input.specEvidencePath,
    self_review_path: input.selfReviewPath,
    completed_at: input.completedAt,
  };
  return updateActivePhase(
    upsertFinalization(markdown, record),
    input.ticket,
    "review passed; ready to land",
  );
};

/**
 * Blocks one ticket after its third failed fix round and releases serialized finalization.
 *
 * @param markdown - Latest locked run-state Markdown after recording the failed review.
 * @param input - Ticket, completed round, and decision timestamp.
 * @returns Updated state that preserves the runtime while independent tickets continue.
 */
export const applyEscalationBlock = (
  markdown: string,
  input: { ticket: string; round: number; completedAt: string },
): string => {
  const finalization = parseFinalization(markdown);
  if (finalization !== undefined && finalization.ticket !== input.ticket) {
    throw landingError(
      "landing.escalation_state_invalid",
      `Ticket \`${input.ticket}\` does not own serialized finalization for escalation.`,
      "Restore the third failed review finalization before recording escalation.",
    );
  }
  const section = ticketTableSection(markdown);
  const lines = section.text.split(/\r?\n/u);
  const headerIndex = lines.findIndex((line) => line.trimStart().startsWith("| NN"));
  const columns =
    headerIndex < 0
      ? []
      : lines[headerIndex]!.split("|")
          .slice(1, -1)
          .map((cell) => cell.trim());
  const rowIndex = lines.findIndex((line) => line.split("|")[1]?.trim() === input.ticket);
  const roundsIndex = columns.indexOf("rounds");
  const escalationIndex = columns.indexOf("esc");
  const statusIndex = columns.indexOf("status");
  if (
    headerIndex < 0 ||
    rowIndex < 0 ||
    roundsIndex < 0 ||
    escalationIndex < 0 ||
    statusIndex < 0
  ) {
    throw landingError(
      "landing.ticket_table_malformed",
      "Ticket table is missing rounds, esc, or status columns for escalation.",
      "Repair the schema-1 ticket table before recording escalation.",
    );
  }
  const cells = lines[rowIndex]!.split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
  cells[roundsIndex] = String(input.round);
  cells[escalationIndex] = "yes";
  cells[statusIndex] = "blocked";
  lines[rowIndex] = `| ${cells.join(" | ")} |`;
  const withTicket = `${markdown.slice(0, section.start)}${lines.join("\n")}${markdown.slice(section.end)}`;
  const withoutFinalization = withTicket.replace(finalizationPattern, "");
  const withPhase = updateActivePhase(
    withoutFinalization,
    input.ticket,
    "blocked, awaiting escalation role",
  );
  return appendSectionLine(
    withPhase,
    "Decisions",
    `- ${input.completedAt.slice(0, 10)} ticket ${input.ticket} blocked after fix round ${input.round}; awaiting explicit escalation role`,
  );
};

const recordRefusedFastForward = (
  input: LandingCompleteInput,
  finalization: FinalizationRecord,
  baseSha: string,
  ticketSha: string,
): Effect.Effect<
  {
    ticket: string;
    action: "resynchronize";
    phase: "resynchronize";
    base_sha: string;
    ticket_sha: string;
    cycle: number;
  },
  LandingError
> =>
  Effect.gen(function* () {
    yield* updateFinalization(
      input.statePath,
      input.ticket,
      {
        ...finalization,
        phase: "resynchronize",
        base_sha: baseSha,
        standards_evidence_path: null,
        spec_evidence_path: null,
        self_review_path: null,
        completed_at: input.completedAt,
      },
      "fast-forward refused; resynchronize and re-review",
    );
    return {
      ticket: input.ticket,
      action: "resynchronize" as const,
      phase: "resynchronize" as const,
      base_sha: baseSha,
      ticket_sha: ticketSha,
      cycle: finalization.cycle,
    };
  });

/**
 * Fast-forwards the integration branch, cleans the worktree, and records landed evidence.
 *
 * @param input - Landing checkout, worktree, evidence, and cleanup policy command.
 * @returns Durable landing and cleanup provenance.
 */
export const completeLanding = (
  input: LandingCompleteInput,
): Effect.Effect<
  | {
      ticket: string;
      action: "resynchronize";
      phase: "resynchronize";
      base_sha: string;
      ticket_sha: string;
      cycle: number;
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
    },
  LandingError
> =>
  Effect.gen(function* () {
    const markdown = yield* Effect.tryPromise({
      try: () => readFile(input.statePath, "utf8"),
      catch: (error) =>
        landingError(
          "landing.state_read_failed",
          `Could not read run state: ${(error as Error).message}`,
          "Verify RESUME.md is readable before landing.",
        ),
    });
    const policy = parseRepositoryPolicy(markdown);
    const finalization = parseFinalization(markdown);
    if (
      finalization === undefined ||
      finalization.ticket !== input.ticket ||
      finalization.phase !== "ready-to-land" ||
      finalization.ticket_sha === null ||
      finalization.standards_evidence_path === null ||
      finalization.spec_evidence_path === null ||
      finalization.self_review_path === null
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
    const runtime = parseActiveTicket(markdown, input.ticket);
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
      repositoryBranch.stdout.trim() !== finalization.base_branch
    ) {
      return yield* landingError(
        "landing.base_checkout_mismatch",
        "Landing must run from the recorded local integration branch checkout.",
        "Use the persisted Base checkout and retry without assuming a remote.",
      );
    }
    const baseStatus = spawnGit(["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: input.repositoryPath,
    });
    if (baseStatus.exitCode !== 0)
      return yield* gitFailure("Integration checkout status", baseStatus.stderr);
    if (baseStatus.stdout !== "") {
      return yield* landingError(
        "landing.base_dirty",
        "Local integration checkout must be clean before fast-forward landing.",
        "Finish or remove unrelated local changes, then retry the same landing.",
      );
    }
    const branchTip = spawnGit(["rev-parse", `refs/heads/${runtime.branch}`], {
      cwd: input.repositoryPath,
    });
    if (branchTip.exitCode !== 0)
      return yield* gitFailure("Ticket branch lookup", branchTip.stderr);
    const ticketSha = branchTip.stdout.trim();
    if (ticketSha !== finalization.ticket_sha) {
      return yield* landingError(
        "landing.review_stale",
        "Ticket branch moved after its accepted final review.",
        "Synchronize again, rerun all gates, and repeat both review axes for the new tip.",
      );
    }

    for (const [axis, path] of [
      ["standards", finalization.standards_evidence_path],
      ["spec", finalization.spec_evidence_path],
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
        evidence.head_before !== ticketSha
      ) {
        return yield* landingError(
          "landing.review_evidence_invalid",
          `${axis} review evidence is stale, failed, or belongs to another ticket tip.`,
          "Repeat the axis against the current complete integration-base-to-ticket-tip range.",
        );
      }
    }
    yield* Effect.tryPromise({
      try: () => readFile(finalization.self_review_path!, "utf8"),
      catch: (error) =>
        landingError(
          "landing.self_review_missing",
          `Could not read implementor self-review: ${(error as Error).message}`,
          "Restore the final round self-review before landing.",
        ),
    });

    const currentBase = spawnGit(["rev-parse", finalization.base_branch], {
      cwd: input.repositoryPath,
    });
    if (currentBase.exitCode !== 0)
      return yield* gitFailure("Base HEAD lookup", currentBase.stderr);
    const landedCheck = spawnGit(
      ["merge-base", "--is-ancestor", ticketSha, finalization.base_branch],
      { cwd: input.repositoryPath },
    );
    if (landedCheck.exitCode > 1)
      return yield* gitFailure("Landed ancestry check", landedCheck.stderr);
    const fastForwardCheck = spawnGit(
      ["merge-base", "--is-ancestor", finalization.base_branch, ticketSha],
      { cwd: input.repositoryPath },
    );
    if (fastForwardCheck.exitCode > 1)
      return yield* gitFailure("Fast-forward ancestry check", fastForwardCheck.stderr);
    const alreadyLanded = landedCheck.exitCode === 0;
    const canFastForward = fastForwardCheck.exitCode === 0;
    if (!alreadyLanded && !canFastForward) {
      return yield* recordRefusedFastForward(
        input,
        finalization,
        currentBase.stdout.trim(),
        ticketSha,
      );
    }
    if (!alreadyLanded) {
      const merged = spawnGit(["merge", "--ff-only", runtime.branch], {
        cwd: input.repositoryPath,
      });
      if (merged.exitCode !== 0) {
        const baseAfterRefusal = spawnGit(["rev-parse", finalization.base_branch], {
          cwd: input.repositoryPath,
        });
        const stillFastForwardable = spawnGit(
          ["merge-base", "--is-ancestor", finalization.base_branch, ticketSha],
          { cwd: input.repositoryPath },
        );
        if (baseAfterRefusal.exitCode === 0 && stillFastForwardable.exitCode === 1) {
          return yield* recordRefusedFastForward(
            input,
            finalization,
            baseAfterRefusal.stdout.trim(),
            ticketSha,
          );
        }
        return yield* gitFailure("Fast-forward landing", merged.stderr);
      }
    }
    const landedBase = spawnGit(["rev-parse", finalization.base_branch], {
      cwd: input.repositoryPath,
    });
    if (landedBase.exitCode !== 0)
      return yield* gitFailure("Landed base lookup", landedBase.stderr);
    if (landedBase.stdout.trim() !== ticketSha) {
      return yield* landingError(
        "landing.tip_mismatch",
        "Local integration branch does not end at the reviewed ticket tip after landing.",
        "Stop cleanup and inspect the integration checkout before retrying.",
      );
    }
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
        cycle: finalization.cycle,
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
    const landedAncestor = spawnGit(
      ["merge-base", "--is-ancestor", ticketSha, finalization.base_branch],
      { cwd: input.repositoryPath },
    );
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
    const reviewEvidence = {
      standards: finalization.standards_evidence_path,
      spec: finalization.spec_evidence_path,
      self_review: finalization.self_review_path,
    };
    const evidenceBody = `${JSON.stringify(
      {
        schema_version: 1,
        ticket: input.ticket,
        landed_tip: ticketSha,
        base_sha: landedBase.stdout.trim(),
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
        const current = parseFinalization(state);
        if (current?.ticket !== input.ticket) {
          return yield* landingError(
            "landing.serialization_lost",
            `Ticket \`${input.ticket}\` no longer owns serialized finalization.`,
            "Reload RESUME.md before recording landed state.",
          );
        }
        let updated = updateTicketAsLanded(state, input.ticket, ticketSha);
        updated = updated.replace(activeRuntimeBlockPattern(input.ticket), "");
        updated = appendLandedEvidence(
          updated,
          input.ticket,
          input.evidencePath,
          ticketSha,
          runtime.branch,
          policy.cleanup,
        );
        updated = updated.replace(/^Base sha:\s*.*$/mu, `Base sha:        ${ticketSha}`);
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
