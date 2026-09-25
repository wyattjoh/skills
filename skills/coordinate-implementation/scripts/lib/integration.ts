import { Data } from "effect";
import { existsSync } from "node:fs";
import type { CliIssue } from "./contract.ts";
import { activeRuntimeBlockPattern, parseActiveRuntimeFields } from "./active-runtime.ts";
import { cleanGitEnv, spawnGit } from "./git.ts";

/**
 * Patch identity recorded for an empty diff, matching Git's null object id width.
 */
export const EMPTY_PATCH_ID = "0".repeat(40);

/**
 * Lifecycle phase of one ticket's integration with the local base branch.
 */
export type IntegrationPhase = "gates" | "fixing" | "rebase-required" | "ready-to-land";

/**
 * Per-ticket integration record persisted as the `Integration:` field of its active block.
 */
export type IntegrationRecord = {
  cycle: number;
  phase: IntegrationPhase;
  base_sha: string;
  ticket_sha: string;
  review_range: string;
  commit_count: number;
  patch_id: string;
  commit_patch_ids: string[];
  passed_gates: string[];
  reviewed_head: string | null;
  reviewed_patch_id: string | null;
  reviewed_commit_patch_ids: string[] | null;
  standards_evidence_path: string | null;
  spec_evidence_path: string | null;
  self_review_path: string | null;
  completed_at: string;
};

/**
 * Git observation of a clean ticket branch measured against the local base branch.
 */
export type ObservedIntegration = {
  base_sha: string;
  ticket_sha: string;
  commit_count: number;
  patch_id: string;
  commit_patch_ids: string[];
};

/**
 * Typed integration parsing or Git observation failure.
 */
export class IntegrationError extends Data.TaggedError("IntegrationError")<{
  issue: CliIssue;
}> {}

const integrationError = (code: string, message: string, remediation: string): IntegrationError =>
  new IntegrationError({ issue: { code, message, remediation } });

const sha = /^[0-9a-f]{40,64}$/u;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const nullableString = (value: unknown): boolean => value === null || typeof value === "string";

const isIntegrationRecord = (value: unknown): value is IntegrationRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Number.isInteger(record.cycle) &&
    (record.cycle as number) >= 0 &&
    (record.phase === "gates" ||
      record.phase === "fixing" ||
      record.phase === "rebase-required" ||
      record.phase === "ready-to-land") &&
    typeof record.base_sha === "string" &&
    sha.test(record.base_sha) &&
    typeof record.ticket_sha === "string" &&
    sha.test(record.ticket_sha) &&
    record.review_range === `${record.base_sha}..${record.ticket_sha}` &&
    Number.isInteger(record.commit_count) &&
    typeof record.patch_id === "string" &&
    isStringArray(record.commit_patch_ids) &&
    isStringArray(record.passed_gates) &&
    nullableString(record.reviewed_head) &&
    nullableString(record.reviewed_patch_id) &&
    (record.reviewed_commit_patch_ids === null ||
      isStringArray(record.reviewed_commit_patch_ids)) &&
    nullableString(record.standards_evidence_path) &&
    nullableString(record.spec_evidence_path) &&
    nullableString(record.self_review_path) &&
    typeof record.completed_at === "string"
  );
};

/**
 * Reads one ticket's integration record from its active runtime block.
 *
 * @param markdown - Complete run-state Markdown.
 * @param ticket - Two-digit ticket number.
 * @returns The record, or undefined when the ticket has no active block or no integration yet.
 * @throws IntegrationError when the persisted field is not a complete record.
 */
export const parseIntegration = (
  markdown: string,
  ticket: string,
): IntegrationRecord | undefined => {
  const block = markdown.match(activeRuntimeBlockPattern(ticket))?.[0];
  if (block === undefined) return undefined;
  const field = parseActiveRuntimeFields(block).Integration;
  if (field === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(field) as unknown;
  } catch {
    value = undefined;
  }
  if (!isIntegrationRecord(value)) {
    throw integrationError(
      "integration.malformed",
      `Ticket \`${ticket}\` has a malformed Integration record.`,
      "Repair the record from gate, review, and rebase evidence, or rerun landing.rebase.check.",
    );
  }
  return value;
};

/**
 * Writes one ticket's integration record and optional Phase label into its active block.
 *
 * @param markdown - Complete run-state Markdown.
 * @param ticket - Two-digit ticket number.
 * @param record - Complete record to persist on one line.
 * @param phaseLabel - Replacement `Phase:` value, or undefined to keep the current label.
 * @returns Updated Markdown, unchanged when the ticket has no active block.
 */
export const writeIntegration = (
  markdown: string,
  ticket: string,
  record: IntegrationRecord,
  phaseLabel: string | undefined,
): string => {
  const pattern = activeRuntimeBlockPattern(ticket);
  const block = markdown.match(pattern)?.[0];
  if (block === undefined) return markdown;
  const line = `Integration: ${JSON.stringify(record)}`;
  let updated = /^Integration:.*$/mu.test(block)
    ? block.replace(/^Integration:.*$/mu, line)
    : `${block.trimEnd()}\n${line}\n\n`;
  if (phaseLabel !== undefined) {
    updated = /^Phase:.*$/mu.test(updated)
      ? updated.replace(/^Phase:.*$/mu, `Phase: ${phaseLabel}`)
      : updated.replace(/^Integration:/mu, `Phase: ${phaseLabel}\nIntegration:`);
  }
  return markdown.replace(pattern, updated);
};

const gitValue = (args: string[], cwd: string, action: string): string => {
  const result = spawnGit(args, { cwd });
  if (result.exitCode !== 0) {
    throw integrationError(
      "integration.git_failed",
      `${action} failed: ${result.stderr.trim() || "Git returned a nonzero exit code."}`,
      "Inspect the ticket worktree and local base branch, repair the failure, then retry.",
    );
  }
  return result.stdout.trim();
};

/**
 * Checks whether the local base branch is already contained in the ticket branch.
 *
 * @param worktreePath - Ticket worktree whose HEAD is checked.
 * @param baseBranch - Local integration branch name.
 * @returns True when `git merge-base --is-ancestor <base> HEAD` succeeds.
 * @throws IntegrationError when Git cannot answer the ancestry question.
 */
export const checkIntegration = (worktreePath: string, baseBranch: string): boolean => {
  const result = spawnGit(["merge-base", "--is-ancestor", baseBranch, "HEAD"], {
    cwd: worktreePath,
  });
  if (result.exitCode > 1) {
    throw integrationError(
      "integration.git_failed",
      `Base ancestry check failed: ${result.stderr.trim() || "Git returned an unexpected status."}`,
      "Inspect the ticket worktree and local base branch, repair the failure, then retry.",
    );
  }
  return result.exitCode === 0;
};

const patchIds = (patch: string, cwd: string): string[] => {
  const child = Bun.spawnSync(["git", "patch-id", "--stable"], {
    cwd,
    env: cleanGitEnv(),
    stdin: new TextEncoder().encode(patch),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0) {
    throw integrationError(
      "integration.git_failed",
      `Patch identity failed: ${child.stderr.toString().trim() || "git patch-id returned a nonzero exit code."}`,
      "Inspect the ticket worktree and retry.",
    );
  }
  return child.stdout
    .toString()
    .split(/\r?\n/u)
    .filter((line) => line.length > 0);
};

/**
 * Computes the stable patch identity of the complete ticket diff from its merge base.
 *
 * @param worktreePath - Ticket worktree.
 * @param baseBranch - Local integration branch name.
 * @returns The stable patch id, or {@link EMPTY_PATCH_ID} for an empty diff.
 * @throws IntegrationError when Git fails.
 */
export const ticketPatchId = (worktreePath: string, baseBranch: string): string => {
  const mergeBase = gitValue(["merge-base", baseBranch, "HEAD"], worktreePath, "Merge base lookup");
  const diff = gitValue(
    ["diff", "--no-color", "--no-ext-diff", mergeBase, "HEAD"],
    worktreePath,
    "Ticket diff",
  );
  return patchIds(`${diff}\n`, worktreePath)[0]?.split(" ")[0] ?? EMPTY_PATCH_ID;
};

/**
 * Computes one stable patch id per ticket commit, oldest first.
 *
 * @param worktreePath - Ticket worktree.
 * @param baseBranch - Local integration branch name.
 * @returns Patch ids in commit order, with {@link EMPTY_PATCH_ID} for empty commits.
 * @throws IntegrationError when Git fails.
 */
export const commitPatchIds = (worktreePath: string, baseBranch: string): string[] => {
  const range = `${baseBranch}..HEAD`;
  const commits = gitValue(["rev-list", "--reverse", range], worktreePath, "Commit range lookup")
    .split(/\r?\n/u)
    .filter((line) => line.length > 0);
  if (commits.length === 0) return [];
  const log = gitValue(
    ["log", "--reverse", "-p", "--no-color", "--no-ext-diff", "--format=medium", range],
    worktreePath,
    "Commit patch lookup",
  );
  const byCommit = new Map(
    patchIds(`${log}\n`, worktreePath).map((line) => {
      const [patchId, commit] = line.split(" ");
      return [commit!, patchId!] as const;
    }),
  );
  return commits.map((commit) => byCommit.get(commit) ?? EMPTY_PATCH_ID);
};

/**
 * Captures the base tip, ticket tip, commit count, and patch identities of a ticket branch.
 *
 * @param worktreePath - Ticket worktree.
 * @param baseBranch - Local integration branch name.
 * @returns The observed integration binding.
 * @throws IntegrationError when Git fails.
 */
export const observeIntegration = (
  worktreePath: string,
  baseBranch: string,
): ObservedIntegration => {
  const baseSha = gitValue(["rev-parse", baseBranch], worktreePath, "Base HEAD lookup");
  const ticketSha = gitValue(["rev-parse", "HEAD"], worktreePath, "Ticket HEAD lookup");
  const count = Number(
    gitValue(["rev-list", "--count", `${baseBranch}..HEAD`], worktreePath, "Commit count"),
  );
  return {
    base_sha: baseSha,
    ticket_sha: ticketSha,
    commit_count: count,
    patch_id: ticketPatchId(worktreePath, baseBranch),
    commit_patch_ids: commitPatchIds(worktreePath, baseBranch),
  };
};

/**
 * Reports whether a Git rebase, merge, or cherry-pick is still in progress in a worktree.
 *
 * @param worktreePath - Ticket worktree.
 * @returns True when any in-progress operation marker exists.
 */
export const operationInProgress = (worktreePath: string): boolean =>
  ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD"].some((marker) => {
    const path = spawnGit(["rev-parse", "--path-format=absolute", "--git-path", marker], {
      cwd: worktreePath,
    });
    return path.exitCode === 0 && existsSync(path.stdout.trim());
  });

/**
 * Checks the append-only fix rule: every reviewed commit is preserved and at least one is added.
 *
 * @param reviewed - Commit patch ids recorded when the fix was requested.
 * @param current - Commit patch ids of the new range.
 * @returns True when `reviewed` is a strict prefix of `current`.
 */
export const isAppendedFix = (reviewed: string[], current: string[]): boolean =>
  current.length > reviewed.length &&
  reviewed.every((patchId, index) => current[index] === patchId);

/**
 * Builds the implementor instruction for rebasing its own branch onto the local base.
 *
 * @param input - Ticket, base branch and tip, and the implementor's worktree.
 * @returns Prompt text for the bound implementor session.
 */
export const rebasePrompt = (input: {
  ticket: string;
  baseBranch: string;
  baseSha: string;
  worktreePath: string;
}): string =>
  [
    `REBASE REQUIRED for ticket ${input.ticket}.`,
    `The local integration branch \`${input.baseBranch}\` advanced to ${input.baseSha}.`,
    `In your worktree ${input.worktreePath}, run \`git rebase ${input.baseBranch}\` and resolve any conflicts there, preserving the intent of both the landed change and this ticket.`,
    "Never check out, edit, reset, or merge in the base checkout.",
    "Do not squash or reword existing commits beyond what the conflict resolution requires.",
    `When the rebase is complete and the worktree is clean, print \`REBASE DONE ${input.ticket}\`.`,
  ].join("\n");

const reviewsReset = {
  reviewed_head: null,
  reviewed_patch_id: null,
  reviewed_commit_patch_ids: null,
  standards_evidence_path: null,
  spec_evidence_path: null,
  self_review_path: null,
} as const;

/**
 * Options for binding an observed ticket tip to its integration record.
 */
export type BindIntegrationOptions = {
  minimumCycle: number;
  commitShapeValid: boolean;
  gateCount: number;
  completedAt: string;
};

const bind = (
  prior: IntegrationRecord | undefined,
  observed: ObservedIntegration,
  cycle: number,
  options: BindIntegrationOptions,
): IntegrationRecord => {
  const reviewsKept =
    prior !== undefined &&
    prior.reviewed_patch_id !== null &&
    prior.reviewed_patch_id === observed.patch_id &&
    prior.standards_evidence_path !== null &&
    prior.spec_evidence_path !== null &&
    prior.self_review_path !== null;
  const base = {
    cycle,
    base_sha: observed.base_sha,
    ticket_sha: observed.ticket_sha,
    review_range: `${observed.base_sha}..${observed.ticket_sha}`,
    commit_count: observed.commit_count,
    patch_id: observed.patch_id,
    commit_patch_ids: observed.commit_patch_ids,
    passed_gates: [],
    completed_at: options.completedAt,
  };
  if (!options.commitShapeValid) {
    return {
      ...base,
      phase: "fixing",
      ...reviewsReset,
      reviewed_commit_patch_ids: observed.commit_patch_ids,
    };
  }
  if (!reviewsKept) return { ...base, phase: "gates", ...reviewsReset };
  return {
    ...base,
    phase: options.gateCount === 0 ? "ready-to-land" : "gates",
    reviewed_head: prior.reviewed_head,
    reviewed_patch_id: prior.reviewed_patch_id,
    reviewed_commit_patch_ids: prior.reviewed_commit_patch_ids,
    standards_evidence_path: prior.standards_evidence_path,
    spec_evidence_path: prior.spec_evidence_path,
    self_review_path: prior.self_review_path,
  };
};

/**
 * Binds a ticket tip that already contains the base without starting a new integration cycle.
 * An unchanged binding is returned as-is so repeated checks are idempotent.
 *
 * @param prior - Current record, if any.
 * @param observed - Current Git observation.
 * @param options - Cycle floor for new records, commit shape, gate count, and timestamp.
 * @returns The record to persist.
 */
export const bindIntegration = (
  prior: IntegrationRecord | undefined,
  observed: ObservedIntegration,
  options: BindIntegrationOptions,
): IntegrationRecord => {
  if (
    prior !== undefined &&
    prior.phase !== "rebase-required" &&
    prior.phase !== "fixing" &&
    prior.ticket_sha === observed.ticket_sha &&
    prior.base_sha === observed.base_sha
  ) {
    return prior;
  }
  return bind(prior, observed, prior?.cycle ?? options.minimumCycle, options);
};

/**
 * Records an implementor rebase as a new integration cycle. Gates always rerun; both reviews
 * are kept only when the ticket patch id equals the reviewed patch id.
 *
 * @param prior - Record in the `rebase-required` phase.
 * @param observed - Git observation of the rebased tip.
 * @param options - Commit shape, gate count, and timestamp.
 * @returns The record for the next cycle.
 */
export const recordRebase = (
  prior: IntegrationRecord,
  observed: ObservedIntegration,
  options: BindIntegrationOptions,
): IntegrationRecord => bind(prior, observed, prior.cycle + 1, options);
