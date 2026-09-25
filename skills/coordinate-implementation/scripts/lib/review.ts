import { Data, Effect } from "effect";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isUtcIsoTimestamp } from "./contract.ts";
import type {
  CliIssue,
  GateRecordInput,
  GateRerunRecordInput,
  ReviewAttemptSupersedeInput,
  ReviewAxis,
  ReviewLaunchPrepareInput,
  ReviewLaunchRecordInput,
  ReviewPolicyPrepareInput,
  ReviewRoundFinalizeInput,
  RoleRecord,
} from "./contract.ts";
import { activeRuntimeBlockPattern, parseActiveRuntimeFields } from "./active-runtime.ts";
import { ImmutableContentConflict, writeImmutable as writeImmutableFile } from "./fs-atomic.ts";
import { spawnGit } from "./git.ts";
import { herdrPromptCommand } from "./harness-launch.ts";
import { IntegrationError, parseIntegration } from "./integration.ts";
import {
  applyFinalReviewOutcome,
  applyGatePass,
  applyIntegrationFix,
  applyNoChangeGateRerun,
  LandingError,
} from "./landing.ts";
import { readJsonSection, readRepositoryPolicy } from "./policy-records.ts";
import { appendSectionLine, readRoleBlock, sameRole } from "./resume-sections.ts";
import { inspectRuntimeClose } from "./runtime-close.ts";
import { mutateStateFile, StateMutationError, withStateLock } from "./state-mutation.ts";
import { validateStateText } from "./state.ts";

/**
 * Fixed review and gate infrastructure retry limit.
 */
export const REVIEW_MAX_INFRASTRUCTURE_ATTEMPTS = 4 as const;

/**
 * Bounded delays used before the three infrastructure retries.
 */
export const REVIEW_RETRY_DELAYS_SECONDS = [1, 2, 4] as const;

/**
 * Harness-appropriate implementor self-review mode.
 */
export type SelfReviewMode = "matt-implement" | "standards-spec-single-session";

/**
 * Persisted repository-derived review policy.
 */
export type ReviewPolicy = {
  instruction_files: string[];
  ci_files: string[];
  gates: Array<{ name: string; argv: string[] }>;
  no_executable_gates: boolean;
  safety_constraints: string[];
  no_additional_safety_constraints: boolean;
  gate_execution: { claude: "background-allowed"; pi: "synchronous" };
  self_review: SelfReviewMode;
  max_infrastructure_attempts: typeof REVIEW_MAX_INFRASTRUCTURE_ATTEMPTS;
  retry_delays_seconds: [number, number, number];
};

/**
 * Result returned after persisting the repository review policy.
 */
export type ReviewPolicyPrepareResult = ReviewPolicy & {
  state_path: string;
};

/**
 * Typed review pipeline failure returned through the CLI.
 */
export class ReviewError extends Data.TaggedError("ReviewError")<{
  issue: CliIssue;
}> {}

const reviewError = (code: string, message: string, remediation: string): ReviewError =>
  new ReviewError({ issue: { code, message, remediation } });

const fromMutationError = (error: unknown): ReviewError => {
  if (error instanceof ReviewError) return error;
  const detail = error instanceof StateMutationError ? error.message : (error as Error).message;
  return reviewError(
    error instanceof StateMutationError && error.kind === "lock_busy"
      ? "review.state_busy"
      : "review.state_io_failed",
    `Could not update review state: ${detail}`,
    "Verify RESUME.md and its directory are writable, then retry with the same review policy.",
  );
};

/**
 * Parses the run-wide Implementor or Reviewer role block from RESUME.md.
 *
 * @param markdown - Run-state Markdown.
 * @param name - Role block heading.
 * @returns The persisted role record.
 */
export const parseRoleBlock = (markdown: string, name: "Implementor" | "Reviewer"): RoleRecord => {
  const role = readRoleBlock(markdown, name);
  if (typeof role !== "string") return role;
  throw reviewError(
    `state.${name.toLowerCase()}_role_malformed`,
    role === "block_count"
      ? `RESUME.md must contain exactly one complete \`${name}:\` role block.`
      : `RESUME.md has an incomplete or malformed \`${name}:\` role block.`,
    `Repair the schema-2 ${name} harness, model, and effort before preparing review policy.`,
  );
};

const renderPolicy = (policy: ReviewPolicy): string =>
  `## Review policy\n\n\`\`\`json\n${JSON.stringify(policy, null, 2)}\n\`\`\`\n`;

const upsertPolicy = (markdown: string, policy: ReviewPolicy): string => {
  const rendered = renderPolicy(policy);
  const expression = /^## Review policy\s*\r?\n\r?\n```json\r?\n[\s\S]*?\r?\n```\s*$/mu;
  if (expression.test(markdown)) return markdown.replace(expression, rendered.trimEnd());
  const decisions = /^## Decisions\s*$/mu.exec(markdown);
  const insertion = decisions?.index ?? markdown.length;
  return `${markdown.slice(0, insertion).trimEnd()}\n\n${rendered}\n${markdown.slice(insertion).trimStart()}`;
};

/**
 * Persists explicit gate commands and repository safety constraints before any worker launches.
 *
 * @param input - Repository-derived gate and safety policy.
 * @returns The complete persisted policy, including harness execution and self-review modes.
 */
export const prepareReviewPolicy = (
  input: ReviewPolicyPrepareInput,
): Effect.Effect<ReviewPolicyPrepareResult, ReviewError> =>
  mutateStateFile(input.statePath, (markdown) =>
    Effect.gen(function* () {
      yield* validateStateText(input.statePath, markdown).pipe(
        Effect.mapError((error) => new ReviewError({ issue: error.issue })),
      );
      if (/^### \d{2}\s*$/mu.test(markdown)) {
        return yield* reviewError(
          "review.policy_workers_started",
          "Review policy must be resolved before any ticket runtime is active.",
          "Finish or clean up active runtimes, then prepare a new run with resolved gates before launch.",
        );
      }
      const implementor = parseRoleBlock(markdown, "Implementor");
      parseRoleBlock(markdown, "Reviewer");
      const policy: ReviewPolicy = {
        instruction_files: input.instructionFiles,
        ci_files: input.ciFiles,
        gates: input.gates.map((gate) => ({ name: gate.name, argv: [...gate.argv] })),
        no_executable_gates: input.noExecutableGates,
        safety_constraints: input.safetyConstraints,
        no_additional_safety_constraints: input.noAdditionalSafetyConstraints,
        gate_execution: { claude: "background-allowed", pi: "synchronous" },
        self_review:
          implementor.harness === "claude" ? "matt-implement" : "standards-spec-single-session",
        max_infrastructure_attempts: REVIEW_MAX_INFRASTRUCTURE_ATTEMPTS,
        retry_delays_seconds: [
          REVIEW_RETRY_DELAYS_SECONDS[0],
          REVIEW_RETRY_DELAYS_SECONDS[1],
          REVIEW_RETRY_DELAYS_SECONDS[2],
        ],
      };
      return {
        markdown: upsertPolicy(markdown, policy),
        result: { state_path: input.statePath, ...policy },
      };
    }),
  ).pipe(Effect.mapError(fromMutationError));

/**
 * Shell-free command returned for coordinator execution.
 */
export type ReviewArgumentCommand = {
  command: string;
  args: string[];
};

/**
 * Fresh Herdr reviewer start and prompt commands.
 */
export type ReviewerLaunchPlan = {
  start: ReviewArgumentCommand;
  prompt: ReviewArgumentCommand;
};

/**
 * Prepared reviewer launch result.
 */
export type ReviewLaunchPrepareResult = {
  recovered: boolean;
  artifact_path: string;
  report_path: string;
  status_before: string;
  reviewed_head: string;
  launch: ReviewerLaunchPlan;
};

/**
 * One normalized actionable reviewer finding.
 */
export type ReviewFinding = {
  severity: "critical" | "high" | "medium" | "low";
  location: string;
  rationale: string;
  suggested_fix: string;
};

type ReviewLaunchDisposition = "continue" | "fix" | "retry" | "blocked" | "manual_cleanup";

/**
 * Persisted reviewer result and required coordinator action.
 */
export type ReviewLaunchRecordResult = {
  ticket: string;
  round: number;
  axis: ReviewAxis;
  attempt: number;
  status: "accepted" | "malformed" | "contaminated" | "infrastructure_failed";
  verdict: "PASS" | "FAIL" | null;
  action: "close-runtime" | ReviewLaunchDisposition;
  after_close_action: ReviewLaunchDisposition;
  runtime_closed: boolean;
  pane_id: string;
  close: ReviewArgumentCommand | null;
  findings: ReviewFinding[];
  report_path: string;
  evidence_path: string;
  retry_delay_seconds: number | null;
  next_attempt: number | null;
};

type ReviewArtifact = {
  schema_version: 1;
  kind: "coordinate-review-launch";
  state_path: string;
  artifact_path: string;
  report_path: string;
  ticket: string;
  round: number;
  axis: ReviewAxis;
  worktree_path: string;
  branch: string;
  base_ref: string;
  pane: string;
  reviewer: RoleRecord;
  context_paths: string[];
  landed_tickets: string[];
  gate_evidence_paths: string[];
  attempt: number;
  session: string;
  tab: string;
  status_before: string;
  reviewed_head: string;
  prompt: string;
  launch: ReviewerLaunchPlan;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRoleRecord = (value: unknown): value is RoleRecord =>
  isRecord(value) &&
  (value.harness === "claude" || value.harness === "pi") &&
  typeof value.model === "string" &&
  typeof value.effort === "string";

const sameStrings = (left: string[], right: string[]): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const parsePrefix = (markdown: string): string => {
  const matches = [...markdown.matchAll(/^Prefix:\s*(\S+)\s*$/gmu)];
  if (matches.length !== 1) {
    throw reviewError(
      "state.prefix_malformed",
      "RESUME.md must contain exactly one non-empty `Prefix:` field.",
      "Repair the schema-2 run prefix before preparing a reviewer launch.",
    );
  }
  return matches[0]![1]!;
};

/**
 * Parses the single persisted review policy from RESUME.md.
 *
 * @param markdown - Run-state Markdown.
 * @returns The persisted review policy.
 */
export const parsePolicy = (markdown: string): ReviewPolicy => {
  const record = readJsonSection(markdown, "Review policy");
  if ("value" in record) return record.value as ReviewPolicy;
  throw record.problem === "missing"
    ? reviewError(
        "review.policy_missing",
        "RESUME.md has no single resolved `## Review policy` record.",
        "Run `review.policy.prepare` before launching workers or reviewers.",
      )
    : reviewError(
        "review.policy_malformed",
        "RESUME.md contains malformed review policy JSON.",
        "Repair the policy from authoritative repository instructions and CI, then retry.",
      );
};

const parseActiveTicket = (
  markdown: string,
  ticket: string,
): { worktree: string; branch: string; implementor: RoleRecord } => {
  const block = activeRuntimeBlockPattern(ticket).exec(markdown)?.[0];
  if (block === undefined) {
    throw reviewError(
      "review.ticket_runtime_missing",
      `RESUME.md has no active runtime for ticket \`${ticket}\`.`,
      "Restore the ticket runtime before preparing external review.",
    );
  }
  const fields = parseActiveRuntimeFields(block);
  let implementor: RoleRecord;
  try {
    implementor = JSON.parse(fields.Implementor ?? "") as RoleRecord;
  } catch {
    throw reviewError(
      "review.ticket_runtime_malformed",
      `Ticket \`${ticket}\` has a malformed bound Implementor record.`,
      "Repair the active runtime from its launch artifact before review.",
    );
  }
  if (
    fields.Worktree === undefined ||
    fields.Branch === undefined ||
    (implementor.harness !== "claude" && implementor.harness !== "pi") ||
    typeof implementor.model !== "string" ||
    typeof implementor.effort !== "string"
  ) {
    throw reviewError(
      "review.ticket_runtime_malformed",
      `Ticket \`${ticket}\` has an incomplete active runtime.`,
      "Repair its Worktree, Branch, and bound Implementor fields before review.",
    );
  }
  return { worktree: fields.Worktree, branch: fields.Branch, implementor };
};

const canonicalExistingPath = async (path: string): Promise<string> => realpath(resolve(path));

const canonicalPathsEqual = async (left: string, right: string): Promise<boolean> => {
  try {
    return (await canonicalExistingPath(left)) === (await canonicalExistingPath(right));
  } catch {
    return false;
  }
};

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

const ensureRunLocalPath = async (statePath: string, path: string): Promise<void> => {
  const runRoot = await realpath(dirname(statePath));
  const candidate = await canonicalPathAllowingMissing(path);
  const relation = relative(runRoot, candidate);
  if (
    relation === "" ||
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  ) {
    throw reviewError(
      "review.evidence_outside_run",
      "Review artifact and report paths must resolve inside the run directory.",
      "Choose run-local paths under reviews/ or briefs/.",
    );
  }
};

const worktreeStatus = (worktreePath: string): string => {
  const result = spawnGit(["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: worktreePath,
  });
  if (result.exitCode !== 0) {
    throw reviewError(
      "review.git_status_failed",
      `Could not capture reviewer mutation baseline: ${result.stderr.trim()}`,
      "Repair the worktree and retry without launching a reviewer.",
    );
  }
  return result.stdout.trimEnd();
};

const readIntegration = (markdown: string, ticket: string) => {
  try {
    return parseIntegration(markdown, ticket);
  } catch (error) {
    if (error instanceof IntegrationError) throw new ReviewError({ issue: error.issue });
    throw error;
  }
};

const validateIntegration = (
  markdown: string,
  ticket: string,
  head: string,
  baseRef: string | undefined,
): { cycle: number } | undefined => {
  const integration = readIntegration(markdown, ticket);
  if (integration === undefined) return undefined;
  if (integration.phase !== "gates" || integration.ticket_sha !== head) {
    throw reviewError(
      "review.integration_stale",
      "Gate or review input does not match the integrated ticket tip and phase.",
      "Run landing.rebase.check, then rerun every gate against its returned tip.",
    );
  }
  if (baseRef !== undefined && integration.base_sha !== baseRef) {
    throw reviewError(
      "review.range_mismatch",
      "Reviewer base_ref does not equal the integrated full-SHA review base.",
      "Use the exact review_range returned by landing.rebase.check.",
    );
  }
  return { cycle: integration.cycle };
};

const noChangeIntegration = (
  markdown: string,
  ticket: string,
  head: string,
): { baseSha: string; cycle: number } => {
  const integration = readIntegration(markdown, ticket);
  const initial = integration?.phase === "fixing" && integration.reviewed_commit_patch_ids !== null;
  const recovered =
    integration?.phase === "gates" && integration.reviewed_commit_patch_ids === null;
  if (integration === undefined || integration.ticket_sha !== head || (!initial && !recovered)) {
    throw reviewError(
      "gate.rerun_state_invalid",
      "No-change gate rerun does not match the append-only fixing integration binding.",
      "Preserve the failed gate, ticket tip, base, and append policy before recording the rerun.",
    );
  }
  return { baseSha: integration.base_sha, cycle: integration.cycle };
};

const worktreeHead = (worktreePath: string): string => {
  const result = spawnGit(["rev-parse", "HEAD"], { cwd: worktreePath });
  const head = result.stdout.trim();
  if (result.exitCode !== 0 || !/^[0-9a-f]{40,64}$/u.test(head)) {
    throw reviewError(
      "review.git_head_failed",
      `Could not capture the reviewed worktree HEAD: ${result.stderr.trim()}`,
      "Repair the worktree and retry before running or accepting gates.",
    );
  }
  return head;
};

/**
 * File a reviewer writes its complete report to before the engine records it.
 *
 * @param reportPath - Immutable report path chosen for the attempt.
 * @returns The draft path the reviewer writes.
 */
export const reviewDraftPath = (reportPath: string): string => `${reportPath}.draft.md`;

const reviewPrompt = (input: ReviewLaunchPrepareInput): string => {
  const focus =
    input.axis === "standards"
      ? "Review only against the listed repository instruction, architecture, domain, and contract sources."
      : "Review only the ticket against the agreed specification and acceptance criteria. Treat landed tickets as existing scope.";
  return [
    `Perform an independent ${input.axis === "standards" ? "Standards" : "Spec"} review.`,
    `Worktree: ${input.worktreePath}`,
    `Diff range: ${input.baseRef}..${input.branch}`,
    `Sources: ${input.contextPaths.join(", ")}`,
    `Already landed tickets: ${input.landedTickets.length === 0 ? "none" : input.landedTickets.join(", ")}`,
    focus,
    "Do not modify the worktree, index, commits, or any repository file.",
    "Report only actionable defects, not observations or personal style preferences.",
    "For each defect, use exactly this block:",
    "## Finding",
    "Severity: critical|high|medium|low",
    "Location: path:line",
    "Rationale: one concrete line",
    "Suggested fix: one concrete line",
    "Every actionable finding requires FAIL. With no findings, use PASS.",
    "The final non-empty line must be exactly PASS or FAIL.",
    `Before you finish, write your complete report to ${reviewDraftPath(input.reportPath)}. That file is outside the worktree; the terminal transcript is not collected.`,
  ].join("\n");
};

const buildReviewerLaunch = (
  input: ReviewLaunchPrepareInput,
  session: string,
  prompt: string,
): ReviewerLaunchPlan => {
  const harnessArgs =
    input.role.harness === "pi"
      ? ["--approve", "--model", input.role.model, "--thinking", input.role.effort]
      : ["--model", input.role.model, "--effort", input.role.effort, "--permission-mode", "auto"];
  return {
    start: {
      command: "herdr",
      args: [
        "agent",
        "start",
        session,
        "--kind",
        input.role.harness,
        "--pane",
        input.pane,
        "--timeout",
        "300000",
        "--",
        ...harnessArgs,
      ],
    },
    prompt: herdrPromptCommand(session, prompt),
  };
};

const writeImmutable = async (path: string, content: string): Promise<void> => {
  try {
    await writeImmutableFile(path, content);
  } catch (error) {
    if (!(error instanceof ImmutableContentConflict)) throw error;
    throw reviewError(
      "review.evidence_conflict",
      `Durable evidence already exists at ${path} with different content.`,
      "Choose the correct new attempt or round path. Never overwrite earlier evidence.",
    );
  }
};

type ReviewAttemptIndexEntry = {
  artifact: ReviewArtifact;
  artifactPath: string;
  raw: string;
};

type SupersessionRead = {
  status: "missing" | "not-superseded" | "pending" | "committed";
  record: Record<string, unknown> | null;
};

const readSupersessionGeneration = (markdown: string, ticket: string, round: number): number => {
  const prefix = `- Ticket ${ticket} round ${round} `;
  const lines = markdown
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(prefix) && line.includes(": superseded;"));
  const generations = lines.map((line) => {
    const match = line.match(/; supersession generation (\d+); evidence /u);
    if (match === null) {
      throw reviewError(
        "review.supersession_generation_invalid",
        `Supersession state for ticket ${ticket} round ${round} has no durable generation.`,
        "Preserve prior evidence and reconcile legacy supersession state before launching another reviewer.",
      );
    }
    return Number(match[1]);
  });
  if (generations.some((generation, index) => generation !== index + 1)) {
    throw reviewError(
      "review.supersession_generation_invalid",
      `Supersession generations for ticket ${ticket} round ${round} are not contiguous and unique.`,
      "Preserve prior evidence and reconcile duplicate or missing supersession state references before review.",
    );
  }
  return generations.length;
};

const discoverReviewAttempts = async (
  statePath: string,
  activeTicket: string,
  markdown: string,
): Promise<ReviewAttemptIndexEntry[]> => {
  const root = await realpath(dirname(statePath));
  const canonicalStatePath = await canonicalExistingPath(statePath);
  const directories = [root];
  const attempts: ReviewAttemptIndexEntry[] = [];
  let visited = 0;
  while (directories.length > 0) {
    const directory = directories.pop()!;
    // Concurrent run-state writers create and remove transient lock and
    // temporary entries under the run folder while this scan walks it.
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== ".git" && entry.name !== "node_modules") directories.push(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      visited += 1;
      if (visited > 20_000) {
        throw reviewError(
          "review.attempt_index_too_large",
          "Run-local review artifact scan exceeded its safe file bound.",
          "Keep prior attempt artifacts in the reviews directory or reconcile the run before launching.",
        );
      }
      const raw = await readFile(path, "utf8").catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      });
      if (raw === null) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        continue;
      }
      if (
        !isRecord(parsed) ||
        parsed.kind !== "coordinate-review-launch" ||
        parsed.ticket !== activeTicket
      ) {
        continue;
      }
      if (typeof parsed.state_path !== "string") {
        throw reviewError(
          "review.attempt_artifact_mismatch",
          `Active-ticket review artifact at ${path} has no valid state_path binding.`,
          "Preserve the artifact and reconcile its canonical run-state identity before retrying.",
        );
      }
      if ((await canonicalPathAllowingMissing(parsed.state_path)) !== canonicalStatePath) continue;
      const artifact = parsed as unknown as ReviewArtifact;
      if (
        !/^\d{2}$/u.test(artifact.ticket) ||
        !Number.isInteger(artifact.round) ||
        (artifact.axis !== "standards" && artifact.axis !== "spec") ||
        !Number.isInteger(artifact.attempt) ||
        !isRoleRecord(artifact.reviewer) ||
        typeof artifact.report_path !== "string" ||
        typeof artifact.worktree_path !== "string" ||
        typeof artifact.branch !== "string" ||
        typeof artifact.pane !== "string" ||
        typeof artifact.artifact_path !== "string" ||
        (await canonicalExistingPath(artifact.artifact_path)) !== path ||
        !new RegExp(`^### ${artifact.ticket}\\r?$`, "mu").test(markdown)
      ) {
        throw reviewError(
          "review.attempt_artifact_mismatch",
          `Review launch artifact at ${path} has an invalid or conflicting identity.`,
          "Preserve the artifact and reconcile its state, path, ticket, round, axis, and attempt before retrying.",
        );
      }
      attempts.push({ artifact, artifactPath: path, raw });
    }
  }
  return attempts.toSorted(
    (left, right) =>
      left.artifact.ticket.localeCompare(right.artifact.ticket) ||
      left.artifact.round - right.artifact.round ||
      left.artifact.axis.localeCompare(right.artifact.axis) ||
      left.artifact.attempt - right.artifact.attempt,
  );
};

const readSupersessionState = async (
  statePath: string,
  artifact: ReviewArtifact,
  markdown: string,
): Promise<SupersessionRead> => {
  const evidencePath = `${artifact.report_path}.json`;
  const raw = await readFile(evidencePath, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (raw === null) return { status: "missing", record: null };
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed))
    throw new Error(`Supersession evidence at ${evidencePath} is not an object`);
  if (parsed.status !== "superseded") return { status: "not-superseded", record: parsed };
  const stateReference = parsed.state_reference;
  const supersession = isRecord(parsed.supersession) ? parsed.supersession : undefined;
  const supersessionGeneration = supersession?.generation;
  const referenceGeneration =
    typeof stateReference === "string"
      ? Number(stateReference.match(/; supersession generation (\d+); evidence /u)?.[1])
      : Number.NaN;
  const commitPath = `${evidencePath}.commit.json`;
  const commitRaw = await readFile(commitPath, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (
    typeof stateReference !== "string" ||
    !markdown.split(/\r?\n/u).includes(stateReference) ||
    commitRaw === null
  ) {
    return { status: "pending", record: parsed };
  }
  const commitValue = JSON.parse(commitRaw) as unknown;
  if (!isRecord(commitValue))
    throw new Error(`Supersession commit at ${commitPath} is not an object`);
  if (
    commitValue.schema_version !== 1 ||
    commitValue.kind !== "coordinate-review-attempt-supersession-commit" ||
    commitValue.status !== "committed" ||
    commitValue.evidence_path !== evidencePath ||
    commitValue.evidence_sha256 !== createHash("sha256").update(raw).digest("hex") ||
    commitValue.state_reference !== stateReference ||
    !Number.isInteger(supersessionGeneration) ||
    supersessionGeneration !== referenceGeneration ||
    commitValue.supersession_generation !== supersessionGeneration
  ) {
    throw reviewError(
      "review.supersession_commit_mismatch",
      `Supersession commit marker at ${commitPath} does not bind its sidecar and RESUME reference.`,
      "Preserve all records and reconcile the interrupted supersession transaction before retrying.",
    );
  }
  return { status: "committed", record: parsed };
};

const reviewIo = <Value>(
  action: () => Promise<Value>,
  code: string,
  message: string,
): Effect.Effect<Value, ReviewError> =>
  Effect.tryPromise({
    try: action,
    catch: (error) =>
      error instanceof ReviewError
        ? error
        : reviewError(
            code,
            `${message}: ${(error as Error).message}`,
            "Repair the path and retry.",
          ),
  });

/**
 * Result of explicitly superseding one interrupted Claude review attempt.
 */
export type ReviewAttemptSupersedeResult = {
  ticket: string;
  round: number;
  axis: ReviewAxis;
  attempt: number;
  status: "superseded";
  action: "retry";
  next_attempt: number;
  old_reviewer: RoleRecord;
  replacement_reviewer: RoleRecord;
  user_authorized: true;
  runtime_closed: true;
  pane_id: string;
  evidence_path: string;
  commit_path: string;
  report_path: string;
  gate_rerun_required: true;
  recovered: boolean;
};

type SupersededGateEvidence = {
  name: string;
  attempt: number;
  evidence_path: string;
  sha256: string;
  supersession_generation: number;
};

/**
 * Records an interrupted Claude reviewer attempt as superseded without inventing a report.
 *
 * The old launch artifact and gate evidence are only read and hashed. The supersession sidecar is
 * immutable, the exact pane must be absent according to Herdr, and the ticket's clean gates-phase
 * integration is left unchanged. A later reviewer retry must use fresh gate attempts.
 *
 * @param input - Exact prior attempt binding, explicit authority, and interruption reason.
 * @returns Durable supersession provenance and the next reviewer attempt number.
 */
export const supersedeInterruptedReviewerAttempt = (
  input: ReviewAttemptSupersedeInput,
): Effect.Effect<ReviewAttemptSupersedeResult, ReviewError> =>
  Effect.gen(function* () {
    if (
      !input.userAuthorized ||
      input.expectedBinding.attempt >= REVIEW_MAX_INFRASTRUCTURE_ATTEMPTS
    ) {
      return yield* reviewError(
        "review.supersession_not_authorized",
        "Superseding a reviewer attempt requires explicit authority and an available next attempt.",
        "Authorize a non-exhausted interrupted attempt before preparing a replacement reviewer.",
      );
    }
    yield* reviewIo(
      () => ensureRunLocalPath(input.statePath, input.artifactPath),
      "review.supersession_artifact_path_failed",
      "Could not validate interrupted reviewer artifact path",
    );
    const canonicalStatePath = yield* reviewIo(
      () => canonicalExistingPath(input.statePath),
      "review.supersession_state_path_failed",
      "Could not canonicalize run state path for supersession locking",
    );
    let commitRecord: Record<string, unknown> | null = null;
    let commitPath: string | null = null;
    const mutation = mutateStateFile(canonicalStatePath, (markdown) =>
      Effect.gen(function* () {
        yield* validateStateText(input.statePath, markdown).pipe(
          Effect.mapError((error) => new ReviewError({ issue: error.issue })),
        );
        const artifactRaw = yield* reviewIo(
          () => readFile(input.artifactPath, "utf8"),
          "review.supersession_artifact_read_failed",
          "Could not read interrupted reviewer launch artifact",
        );
        let artifact: ReviewArtifact;
        try {
          const parsed = JSON.parse(artifactRaw) as unknown;
          if (!isRecord(parsed)) throw new Error("review artifact is not an object");
          artifact = parsed as unknown as ReviewArtifact;
        } catch {
          return yield* reviewError(
            "review.supersession_artifact_malformed",
            "Interrupted reviewer launch artifact is not valid JSON.",
            "Preserve it and recover its exact binding before superseding the attempt.",
          );
        }
        const expected = input.expectedBinding;
        const artifactSha256 = createHash("sha256").update(artifactRaw).digest("hex");
        const statePathMatches =
          typeof artifact.state_path === "string" &&
          (yield* reviewIo(
            () => canonicalPathsEqual(artifact.state_path, input.statePath),
            "review.supersession_state_path_failed",
            "Could not canonicalize interrupted reviewer state path",
          ));
        if (
          artifact.kind !== "coordinate-review-launch" ||
          artifact.schema_version !== 1 ||
          !statePathMatches ||
          artifact.artifact_path !== input.artifactPath ||
          artifact.ticket !== expected.ticket ||
          artifact.round !== expected.round ||
          artifact.axis !== expected.axis ||
          artifact.attempt !== expected.attempt ||
          !isRoleRecord(artifact.reviewer) ||
          !sameRole(artifact.reviewer, expected.reviewer) ||
          !Array.isArray(artifact.context_paths) ||
          !Array.isArray(artifact.landed_tickets) ||
          !Array.isArray(artifact.gate_evidence_paths) ||
          artifact.worktree_path !== expected.worktreePath ||
          artifact.branch !== expected.branch ||
          artifact.base_ref !== expected.baseRef ||
          artifact.pane !== expected.pane ||
          artifact.session !== expected.session ||
          artifact.tab !== expected.tab ||
          artifact.reviewed_head !== expected.reviewedHead ||
          artifact.status_before !== expected.statusBefore ||
          !sameStrings(artifact.context_paths, expected.contextPaths) ||
          !sameStrings(artifact.landed_tickets, expected.landedTickets) ||
          !sameStrings(artifact.gate_evidence_paths, expected.gateEvidencePaths) ||
          artifactSha256 !== expected.artifactSha256 ||
          artifact.reviewer.harness !== "claude" ||
          artifact.status_before !== ""
        ) {
          return yield* reviewError(
            "review.supersession_binding_mismatch",
            "Reviewer artifact does not match the exact interrupted Claude attempt binding.",
            "Refresh the artifact hash, reviewer, pane, worktree, branch, head, gates, and session from immutable launch evidence.",
          );
        }
        if (artifact.attempt + 1 > REVIEW_MAX_INFRASTRUCTURE_ATTEMPTS) {
          return yield* reviewError(
            "review.supersession_attempt_exhausted",
            "No reviewer attempt remains after this interrupted attempt.",
            "Do not reset the retry budget; escalate the exhausted attempt for explicit manual recovery.",
          );
        }
        yield* reviewIo(
          () => ensureRunLocalPath(input.statePath, artifact.report_path),
          "review.supersession_report_path_failed",
          "Could not validate interrupted reviewer report path",
        );
        const evidencePath = `${artifact.report_path}.json`;
        commitPath = `${evidencePath}.commit.json`;
        yield* reviewIo(
          () => ensureRunLocalPath(input.statePath, evidencePath),
          "review.supersession_evidence_path_failed",
          "Could not validate supersession evidence path",
        );
        yield* reviewIo(
          () => ensureRunLocalPath(input.statePath, commitPath!),
          "review.supersession_commit_path_failed",
          "Could not validate supersession commit path",
        );
        const reportRaw = yield* reviewIo(
          () =>
            readFile(artifact.report_path, "utf8").catch((error: unknown) => {
              if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
              throw error;
            }),
          "review.supersession_report_read_failed",
          "Could not inspect the prior reviewer report path",
        );
        if (reportRaw !== null) {
          return yield* reviewError(
            "review.supersession_report_exists",
            "A report already exists for this reviewer attempt, so it is not an interrupted attempt.",
            "Preserve and process the existing report with review.launch.record instead of superseding it.",
          );
        }

        const priorEvidenceRaw = yield* reviewIo(
          () =>
            readFile(evidencePath, "utf8").catch((error: unknown) => {
              if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
              throw error;
            }),
          "review.supersession_evidence_read_failed",
          "Could not inspect existing reviewer evidence",
        );
        const policy = parsePolicy(markdown);
        if (
          policy.gates.length === 0 ||
          artifact.gate_evidence_paths.length !== policy.gates.length
        ) {
          return yield* reviewError(
            "review.supersession_gates_missing",
            "Interrupted review has no complete persisted gate set to bind for a fresh retry.",
            "Resolve and rerun every repository gate before launching another reviewer.",
          );
        }
        const runtime = parseActiveTicket(markdown, artifact.ticket);
        const activeWorktree = yield* reviewIo(
          () => realpath(runtime.worktree),
          "review.supersession_worktree_path_failed",
          "Could not resolve active ticket worktree",
        );
        const requestedWorktree = yield* reviewIo(
          () => realpath(artifact.worktree_path),
          "review.supersession_worktree_path_failed",
          "Could not resolve artifact worktree",
        );
        if (activeWorktree !== requestedWorktree || runtime.branch !== artifact.branch) {
          return yield* reviewError(
            "review.supersession_runtime_mismatch",
            "Interrupted reviewer binding no longer matches the active ticket worktree and branch.",
            "Restore the exact ticket worktree binding before superseding reviewer attempts.",
          );
        }
        const currentReviewer = parseRoleBlock(markdown, "Reviewer");
        if (currentReviewer.harness !== "pi") {
          return yield* reviewError(
            "review.supersession_role_mismatch",
            "Interrupted Claude reviewers can only be superseded by the persisted Pi Reviewer default.",
            "Persist and validate the intended Pi Reviewer role before retrying.",
          );
        }
        const head = worktreeHead(requestedWorktree);
        const status = worktreeStatus(requestedWorktree);
        if (head !== artifact.reviewed_head || head !== expected.reviewedHead) {
          return yield* reviewError(
            "review.supersession_head_changed",
            "Ticket HEAD differs from the interrupted review's immutable reviewed tip.",
            "Synchronize the ticket and prepare new gates and review artifacts for its current tip.",
          );
        }
        if (status.length > 0) {
          return yield* reviewError(
            "review.supersession_worktree_dirty",
            "Interrupted review can only be superseded while its reviewed worktree remains clean.",
            "Preserve any worktree changes and resolve them before restarting integration.",
          );
        }
        let integration: ReturnType<typeof parseIntegration>;
        try {
          integration = readIntegration(markdown, artifact.ticket);
        } catch (error) {
          return yield* error as ReviewError;
        }
        if (
          integration === undefined ||
          integration.phase !== "gates" ||
          integration.ticket_sha !== head ||
          integration.base_sha !== artifact.base_ref ||
          integration.standards_evidence_path !== null ||
          integration.spec_evidence_path !== null ||
          integration.self_review_path !== null
        ) {
          return yield* reviewError(
            "review.supersession_integration_stale",
            "Ticket is no longer at an untouched gates-phase integration boundary.",
            "Do not supersede attempts after review evidence or integration has advanced.",
          );
        }

        const gateNames = new Set<string>();
        const gateEvidence: SupersededGateEvidence[] = [];
        for (const path of artifact.gate_evidence_paths) {
          yield* reviewIo(
            () => ensureRunLocalPath(input.statePath, path),
            "review.supersession_gate_path_failed",
            "Could not validate prior gate evidence path",
          );
          const raw = yield* reviewIo(
            () => readFile(path, "utf8"),
            "review.supersession_gate_read_failed",
            `Could not read prior gate evidence at ${path}`,
          );
          let gateEvidenceRecord: Record<string, unknown>;
          try {
            gateEvidenceRecord = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            return yield* reviewError(
              "review.supersession_gate_malformed",
              "Prior gate evidence is malformed.",
              "Preserve it and rerun every configured gate before fresh review.",
            );
          }
          const configured = policy.gates.find(
            (gate) =>
              gate.name === (gateEvidenceRecord.gate as Record<string, unknown> | undefined)?.name,
          );
          const gate = gateEvidenceRecord.gate as Record<string, unknown> | undefined;
          const attempt = gateEvidenceRecord.attempt;
          // Legacy gates are accepted only in this hash-bound supersession snapshot.
          const gateSupersessionGeneration =
            gateEvidenceRecord.supersession_generation === undefined
              ? 0
              : gateEvidenceRecord.supersession_generation;
          if (
            gateEvidenceRecord.ticket !== artifact.ticket ||
            gateEvidenceRecord.round !== artifact.round ||
            gateEvidenceRecord.head !== head ||
            gateEvidenceRecord.worktree_path !== requestedWorktree ||
            gateEvidenceRecord.status !== "passed" ||
            gateEvidenceRecord.action !== "continue" ||
            gateEvidenceRecord.exit_code !== 0 ||
            !Number.isInteger(attempt) ||
            (attempt as number) < 1 ||
            !Number.isInteger(gateSupersessionGeneration) ||
            (gateSupersessionGeneration as number) < 0 ||
            configured === undefined ||
            JSON.stringify(gate?.argv) !== JSON.stringify(configured.argv) ||
            gateNames.has(configured.name)
          ) {
            return yield* reviewError(
              "review.supersession_gate_mismatch",
              "Prior gate evidence is incomplete, stale, duplicated, or not a passing configured gate.",
              "Rerun and record every exact repository gate before launching fresh reviewers.",
            );
          }
          gateNames.add(configured.name);
          gateEvidence.push({
            name: configured.name,
            attempt: attempt as number,
            evidence_path: path,
            sha256: createHash("sha256").update(raw).digest("hex"),
            supersession_generation: gateSupersessionGeneration as number,
          });
        }
        if (gateNames.size !== policy.gates.length) {
          return yield* reviewError(
            "review.supersession_gates_missing",
            "Prior evidence does not contain one attempt for every persisted gate.",
            "Rerun and record all configured gates before launching fresh reviewers.",
          );
        }
        const currentArtifactPath = yield* reviewIo(
          () => realpath(input.artifactPath),
          "review.supersession_artifact_path_failed",
          "Could not resolve the current interrupted reviewer artifact",
        );
        const attempts = yield* reviewIo(
          () => discoverReviewAttempts(input.statePath, artifact.ticket, markdown),
          "review.supersession_attempt_index_failed",
          "Could not index reviewer attempts before supersession",
        );
        for (const entry of attempts) {
          if (entry.artifact.round !== artifact.round || entry.artifactPath === currentArtifactPath)
            continue;
          const stateReferencePrefix = `- Ticket ${entry.artifact.ticket} round ${entry.artifact.round} ${entry.artifact.axis} attempt ${entry.artifact.attempt}:`;
          const hasStateReference = markdown
            .split(/\r?\n/u)
            .some(
              (line) => line.startsWith(stateReferencePrefix) && line.includes(": superseded;"),
            );
          const priorSupersession = yield* reviewIo(
            () => readSupersessionState(input.statePath, entry.artifact, markdown),
            "review.supersession_read_failed",
            `Could not verify the prior ${entry.artifact.axis} supersession transaction`,
          );
          if (
            priorSupersession.status === "pending" ||
            (hasStateReference && priorSupersession.status !== "committed")
          ) {
            return yield* reviewError(
              "review.supersession_pending",
              `Supersession for ${entry.artifact.axis} attempt ${entry.artifact.attempt} has not committed before this round can advance.`,
              "Retry the exact pending supersession request before superseding another reviewer attempt in this round.",
            );
          }
        }
        const existingLine = markdown
          .split(/\r?\n/u)
          .find((line) =>
            line.startsWith(
              `- Ticket ${artifact.ticket} round ${artifact.round} ${artifact.axis} attempt ${artifact.attempt}:`,
            ),
          );
        let currentGeneration: number;
        try {
          currentGeneration = readSupersessionGeneration(markdown, artifact.ticket, artifact.round);
        } catch (error) {
          return yield* error as ReviewError;
        }
        const existingGeneration = existingLine?.match(
          /; supersession generation (\d+); evidence /u,
        );
        const supersessionGeneration =
          existingLine === undefined ? currentGeneration + 1 : Number(existingGeneration?.[1]);
        const evidenceLine = `- Ticket ${artifact.ticket} round ${artifact.round} ${artifact.axis} attempt ${artifact.attempt}: superseded; reviewer ${JSON.stringify(artifact.reviewer)}; Herdr confirmed pane ${artifact.pane} absent; supersession generation ${supersessionGeneration}; evidence ${evidencePath}`;
        if (
          !Number.isInteger(supersessionGeneration) ||
          supersessionGeneration < 1 ||
          (existingLine !== undefined && existingGeneration === null) ||
          (existingLine !== undefined && supersessionGeneration !== currentGeneration) ||
          (existingLine !== undefined && existingLine !== evidenceLine)
        ) {
          return yield* reviewError(
            "review.supersession_state_conflict",
            "Run state already records a different outcome for this reviewer attempt.",
            "Preserve existing review provenance and do not supersede a recorded result.",
          );
        }
        const paneInspection = yield* inspectRuntimeClose(artifact.pane).pipe(
          Effect.mapError((error) => new ReviewError({ issue: error.issue })),
        );
        if (!paneInspection.runtime_closed) {
          return yield* reviewError(
            "review.supersession_runtime_live",
            "Herdr still reports the exact interrupted reviewer pane as live.",
            "Do not supersede or relaunch a live reviewer; wait for machine-observed closure.",
          );
        }
        const supersession = {
          user_authorized: true,
          reason: input.reason,
          artifact_sha256: artifactSha256,
          pane_id: artifact.pane,
          pane_closed: true,
          replacement_reviewer: currentReviewer,
          replacement_attempt: artifact.attempt + 1,
          gate_evidence: gateEvidence,
          generation: supersessionGeneration,
        };
        const evidenceRecord = {
          schema_version: 1,
          ticket: artifact.ticket,
          round: artifact.round,
          axis: artifact.axis,
          attempt: artifact.attempt,
          reviewer: artifact.reviewer,
          status: "superseded",
          verdict: null,
          action: "retry",
          findings: [],
          status_before: artifact.status_before,
          status_after: status,
          head_before: artifact.reviewed_head,
          head_after: head,
          diagnostic: null,
          retry_delay_seconds: null,
          next_attempt: artifact.attempt + 1,
          completed_at: input.completedAt,
          report_path: artifact.report_path,
          state_reference: evidenceLine,
          supersession,
          supersession_generation: supersessionGeneration,
        };
        const serializedEvidence = `${JSON.stringify(evidenceRecord, null, 2)}\n`;
        commitRecord = {
          schema_version: 1,
          kind: "coordinate-review-attempt-supersession-commit",
          status: "committed",
          evidence_path: evidencePath,
          evidence_sha256: createHash("sha256").update(serializedEvidence).digest("hex"),
          state_reference: evidenceLine,
          supersession_generation: supersessionGeneration,
          committed_at: input.completedAt,
        };
        if (priorEvidenceRaw !== null && priorEvidenceRaw !== serializedEvidence) {
          return yield* reviewError(
            "review.supersession_evidence_conflict",
            "Reviewer evidence already exists with different content.",
            "Preserve it and retry only the byte-identical supersession request.",
          );
        }
        yield* reviewIo(
          () => writeImmutable(evidencePath, serializedEvidence),
          "review.supersession_evidence_write_failed",
          "Could not persist immutable reviewer supersession evidence",
        );
        return {
          markdown: appendEvidenceLine(markdown, evidenceLine),
          result: {
            ticket: artifact.ticket,
            round: artifact.round,
            axis: artifact.axis,
            attempt: artifact.attempt,
            status: "superseded" as const,
            action: "retry" as const,
            next_attempt: artifact.attempt + 1,
            old_reviewer: artifact.reviewer,
            replacement_reviewer: currentReviewer,
            user_authorized: true as const,
            runtime_closed: true as const,
            pane_id: artifact.pane,
            evidence_path: evidencePath,
            commit_path: `${evidencePath}.commit.json`,
            report_path: artifact.report_path,
            gate_rerun_required: true as const,
            recovered: priorEvidenceRaw !== null,
          },
        };
      }),
    ).pipe(Effect.mapError(fromMutationError));
    const result = yield* mutation;
    if (commitRecord === null || commitPath === null) {
      return yield* reviewError(
        "review.supersession_commit_missing",
        "Reviewer state changed without a prepared supersession commit marker.",
        "Preserve the sidecar and state, then retry the exact supersession request to reconcile them.",
      );
    }
    yield* reviewIo(
      () => writeImmutable(commitPath!, `${JSON.stringify(commitRecord, null, 2)}\n`),
      "review.supersession_commit_write_failed",
      "Could not persist reviewer supersession commit marker",
    );
    return result;
  });

/**
 * Captures a clean Git baseline and constructs one fresh independent reviewer launch.
 *
 * @param input - Axis, runtime, role, and evidence paths for one reviewer attempt.
 * @returns The persisted artifact and exact shell-free Herdr command arrays.
 */
export const prepareReviewerLaunch = (
  input: ReviewLaunchPrepareInput,
): Effect.Effect<ReviewLaunchPrepareResult, ReviewError> =>
  Effect.gen(function* () {
    const canonicalStatePath = yield* reviewIo(
      () => canonicalExistingPath(input.statePath),
      "review.state_path_failed",
      "Could not canonicalize run state path before reviewer launch",
    );
    return yield* withStateLock(
      canonicalStatePath,
      Effect.gen(function* () {
        yield* reviewIo(
          () => ensureRunLocalPath(input.statePath, input.artifactPath),
          "review.artifact_path_failed",
          "Could not validate launch artifact path",
        );
        yield* reviewIo(
          () => ensureRunLocalPath(input.statePath, input.reportPath),
          "review.report_path_failed",
          "Could not validate review report path",
        );
        if (input.previousArtifactPath !== undefined) {
          yield* reviewIo(
            () => ensureRunLocalPath(input.statePath, input.previousArtifactPath!),
            "review.previous_artifact_path_failed",
            "Could not validate preceding review artifact path",
          );
        }
        const markdown = yield* reviewIo(
          () => readFile(input.statePath, "utf8"),
          "review.state_read_failed",
          "Could not read run state",
        );
        yield* validateStateText(input.statePath, markdown).pipe(
          Effect.mapError((error) => new ReviewError({ issue: error.issue })),
        );
        const policy = parsePolicy(markdown);
        const reviewer = parseRoleBlock(markdown, "Reviewer");
        if (!sameRole(reviewer, input.role)) {
          return yield* reviewError(
            "review.role_mismatch",
            "Reviewer launch role does not match the persisted Reviewer role.",
            "Retry with the exact persisted harness, model, and effort. Role changes apply only to future launches.",
          );
        }
        const runtime = parseActiveTicket(markdown, input.ticket);
        const runtimeWorktree = yield* reviewIo(
          () => realpath(runtime.worktree),
          "review.worktree_path_failed",
          "Could not resolve the active ticket worktree",
        );
        const requestedWorktree = yield* reviewIo(
          () => realpath(input.worktreePath),
          "review.worktree_path_failed",
          "Could not resolve the requested review worktree",
        );
        if (runtimeWorktree !== requestedWorktree || runtime.branch !== input.branch) {
          return yield* reviewError(
            "review.runtime_mismatch",
            "Reviewer launch worktree or branch does not match the active ticket runtime.",
            "Refresh RESUME.md from the ticket launch artifact and retry.",
          );
        }
        const reviewedHead = worktreeHead(requestedWorktree);
        let integrationCycle: number | null = null;
        try {
          integrationCycle =
            validateIntegration(markdown, input.ticket, reviewedHead, input.baseRef)?.cycle ?? null;
        } catch (error) {
          return yield* error as ReviewError;
        }
        const migrationRecoveryRecorded = markdown.includes(
          `ticket ${input.ticket} implementor migration recovery;`,
        );
        if (input.gateEvidencePaths.length !== policy.gates.length) {
          return yield* reviewError(
            "review.gates_incomplete",
            "Reviewer launch requires one passing evidence file for every persisted gate.",
            "Run and record every gate for this ticket, commit, and round before external review.",
          );
        }
        const observedGateNames = new Set<string>();
        const observedGateAttempts = new Map<
          string,
          {
            attempt: number;
            path: string;
            supersessionGeneration: number | null;
            integrationCycle: number | null;
          }
        >();
        for (const path of input.gateEvidencePaths) {
          yield* reviewIo(
            () => ensureRunLocalPath(input.statePath, path),
            "review.gate_evidence_path_failed",
            "Could not validate gate evidence path",
          );
          const evidence = yield* reviewIo(
            async () =>
              JSON.parse(await readFile(path, "utf8")) as {
                ticket: unknown | undefined;
                round: unknown | undefined;
                gate: { name: unknown | undefined; argv: unknown | undefined } | undefined;
                status: unknown | undefined;
                action: unknown | undefined;
                attempt: unknown | undefined;
                head: unknown | undefined;
                worktree_path: unknown | undefined;
                completed_at: unknown | undefined;
                supersession_generation: unknown | undefined;
                integration_cycle: unknown | undefined;
              },
            "review.gate_evidence_read_failed",
            `Could not read gate evidence at ${path}`,
          );
          const configured = policy.gates.find((gate) => gate.name === evidence.gate?.name);
          if (
            (migrationRecoveryRecorded && integrationCycle === null) ||
            (integrationCycle !== null && evidence.integration_cycle !== integrationCycle)
          ) {
            const code = migrationRecoveryRecorded
              ? "review.migration_gates_stale"
              : "review.gates_cycle_stale";
            return yield* reviewError(
              code,
              "Gate evidence does not bind the ticket's current integration cycle.",
              "Rerun and record every configured gate after landing.rebase.check before preparing reviewers.",
            );
          }
          if (
            evidence.ticket !== input.ticket ||
            evidence.round !== input.round ||
            evidence.status !== "passed" ||
            evidence.action !== "continue" ||
            evidence.head !== reviewedHead ||
            evidence.worktree_path !== requestedWorktree ||
            !Number.isInteger(evidence.attempt) ||
            (evidence.attempt as number) < 1 ||
            !isUtcIsoTimestamp(evidence.completed_at) ||
            configured === undefined ||
            JSON.stringify(evidence.gate?.argv) !== JSON.stringify(configured.argv) ||
            observedGateNames.has(configured.name)
          ) {
            return yield* reviewError(
              "review.gates_incomplete",
              "Gate evidence is failed, duplicated, stale, or does not match the persisted argv.",
              "Rerun and record every exact gate for this ticket and round before review.",
            );
          }
          observedGateNames.add(configured.name);
          observedGateAttempts.set(configured.name, {
            attempt: evidence.attempt as number,
            path,
            supersessionGeneration: Number.isInteger(evidence.supersession_generation)
              ? (evidence.supersession_generation as number)
              : null,
            integrationCycle: Number.isInteger(evidence.integration_cycle)
              ? (evidence.integration_cycle as number)
              : null,
          });
        }
        const attemptIndex = yield* reviewIo(
          () => discoverReviewAttempts(input.statePath, input.ticket, markdown),
          "review.attempt_index_failed",
          "Could not establish run-wide reviewer attempt identity",
        );
        const requestedArtifactIdentity = yield* reviewIo(
          () => canonicalPathAllowingMissing(input.artifactPath),
          "review.artifact_path_failed",
          "Could not canonicalize reviewer artifact identity",
        );
        const requestedPreviousIdentity =
          input.previousArtifactPath === undefined
            ? undefined
            : yield* reviewIo(
                () => canonicalPathAllowingMissing(input.previousArtifactPath!),
                "review.previous_artifact_path_failed",
                "Could not canonicalize preceding reviewer artifact identity",
              );
        const scopedAttempts = attemptIndex.filter(
          ({ artifact }) => artifact.ticket === input.ticket && artifact.round === input.round,
        );
        const stateIdentities = [
          ...markdown.matchAll(/^- Ticket (\d{2}) round (\d+) (standards|spec) attempt (\d+):/gmu),
        ]
          .map((match) => ({
            ticket: match[1]!,
            round: Number(match[2]),
            axis: match[3] as ReviewAxis,
            attempt: Number(match[4]),
          }))
          .filter((identity) => identity.ticket === input.ticket && identity.round === input.round);
        for (const identity of stateIdentities) {
          const count = scopedAttempts.filter(
            ({ artifact }) =>
              artifact.axis === identity.axis && artifact.attempt === identity.attempt,
          ).length;
          if (count !== 1) {
            return yield* reviewError(
              "review.attempt_artifact_missing",
              `Run state records ${identity.axis} attempt ${identity.attempt}, but its unique immutable launch artifact is not indexed.`,
              "Preserve prior provenance and recover the exact artifact before launching another attempt.",
            );
          }
        }
        for (const identity of stateIdentities) {
          const duplicates = stateIdentities.filter(
            (candidate) =>
              candidate.axis === identity.axis && candidate.attempt === identity.attempt,
          );
          if (duplicates.length > 1) {
            return yield* reviewError(
              "review.attempt_identity_conflict",
              `Run state contains duplicate ${identity.axis} attempt ${identity.attempt} identities.`,
              "Reconcile the duplicate state references without overwriting attempt artifacts.",
            );
          }
        }
        const sameAxisAttempts = scopedAttempts
          .filter(({ artifact }) => artifact.axis === input.axis)
          .toSorted((left, right) => left.artifact.attempt - right.artifact.attempt);
        const sameAttempt = sameAxisAttempts.find(
          ({ artifact }) => artifact.attempt === input.attempt,
        );
        if (
          (sameAttempt !== undefined &&
            (sameAttempt.artifactPath !== requestedArtifactIdentity ||
              !sameRole(sameAttempt.artifact.reviewer, input.role))) ||
          sameAxisAttempts.some(({ artifact }) => artifact.attempt > input.attempt)
        ) {
          return yield* reviewError(
            "review.attempt_identity_conflict",
            "Requested reviewer attempt identity is already bound to a different artifact, role, or later attempt.",
            "Use the next unused per-axis attempt number and preserve all prior launch artifacts.",
          );
        }
        const priorAttempts = sameAxisAttempts.filter(
          ({ artifact }) => artifact.attempt < input.attempt,
        );
        if (input.previousArtifactPath === undefined) {
          if (input.attempt !== 1 || priorAttempts.length > 0) {
            return yield* reviewError(
              "review.attempt_identity_conflict",
              "Reviewer attempt cannot restart at one or skip a required preceding artifact.",
              "Bind the next attempt to the unique preceding artifact for this ticket, round, and axis.",
            );
          }
        } else {
          const previousIdentity = priorAttempts.at(-1);
          if (
            previousIdentity === undefined ||
            previousIdentity.artifact.attempt !== input.attempt - 1 ||
            previousIdentity.artifactPath !== requestedPreviousIdentity
          ) {
            return yield* reviewError(
              "review.attempt_identity_conflict",
              "Previous artifact path is not the unique immediately preceding attempt for this ticket, round, and axis.",
              "Use the exact artifact path indexed for the prior attempt; never reuse or replace an attempt identity.",
            );
          }
        }

        let requiredSupersessionGeneration = 0;
        const supersededGateBaselines: Array<{
          gates: Array<{
            name: string;
            attempt: number;
            path: string;
            sha256: string;
            supersessionGeneration: number;
          }>;
        }> = [];
        if (input.role.harness === "pi") {
          const latestClaudeByAxis = new Map<ReviewAxis, ReviewAttemptIndexEntry>();
          for (const entry of scopedAttempts) {
            if (entry.artifact.reviewer.harness !== "claude") continue;
            const existing = latestClaudeByAxis.get(entry.artifact.axis);
            if (existing === undefined || existing.artifact.attempt < entry.artifact.attempt) {
              latestClaudeByAxis.set(entry.artifact.axis, entry);
            }
          }
          for (const entry of latestClaudeByAxis.values()) {
            const supersession = yield* reviewIo(
              () => readSupersessionState(input.statePath, entry.artifact, markdown),
              "review.supersession_read_failed",
              `Could not verify supersession for ${entry.artifact.axis} attempt ${entry.artifact.attempt}`,
            );
            if (supersession.status === "pending") {
              return yield* reviewError(
                "review.supersession_pending",
                `Supersession for ${entry.artifact.axis} attempt ${entry.artifact.attempt} has not committed both its state reference and commit marker.`,
                "Retry the exact review.attempt.supersede request before preparing any Pi reviewer.",
              );
            }
            const record = supersession.record;
            const details = isRecord(record?.supersession) ? record.supersession : undefined;
            if (
              supersession.status !== "committed" ||
              record?.status !== "superseded" ||
              record.ticket !== entry.artifact.ticket ||
              record.round !== entry.artifact.round ||
              record.axis !== entry.artifact.axis ||
              record.attempt !== entry.artifact.attempt ||
              record.report_path !== entry.artifact.report_path ||
              !isRoleRecord(record.reviewer) ||
              !sameRole(record.reviewer, entry.artifact.reviewer) ||
              !isUtcIsoTimestamp(record.completed_at) ||
              !Number.isInteger(details?.generation) ||
              (details?.generation as number) < 1 ||
              record.supersession_generation !== details?.generation ||
              details?.user_authorized !== true ||
              details.pane_closed !== true ||
              details.pane_id !== entry.artifact.pane ||
              details.artifact_sha256 !== createHash("sha256").update(entry.raw).digest("hex") ||
              details.replacement_attempt !== entry.artifact.attempt + 1 ||
              !isRoleRecord(details.replacement_reviewer) ||
              !sameRole(details.replacement_reviewer, input.role) ||
              record.next_attempt !== entry.artifact.attempt + 1 ||
              !Array.isArray(details.gate_evidence)
            ) {
              return yield* reviewError(
                "review.supersession_axes_incomplete",
                `Claude ${entry.artifact.axis} attempt ${entry.artifact.attempt} has no committed, identity-matched supersession.`,
                "Supersede every interrupted Claude axis with exact Herdr closure evidence before launching Pi reviewers.",
              );
            }
            const generation = details.generation as number;
            requiredSupersessionGeneration = Math.max(requiredSupersessionGeneration, generation);
            const gates: Array<{
              name: string;
              attempt: number;
              path: string;
              sha256: string;
              supersessionGeneration: number;
            }> = [];
            for (const value of details.gate_evidence) {
              if (!isRecord(value)) continue;
              if (
                typeof value.name === "string" &&
                Number.isInteger(value.attempt) &&
                typeof value.evidence_path === "string" &&
                typeof value.sha256 === "string" &&
                Number.isInteger(value.supersession_generation) &&
                (value.supersession_generation as number) >= 0 &&
                (value.supersession_generation as number) < generation
              ) {
                gates.push({
                  name: value.name,
                  attempt: value.attempt as number,
                  path: value.evidence_path,
                  sha256: value.sha256,
                  supersessionGeneration: value.supersession_generation as number,
                });
              }
            }
            if (
              gates.length !== policy.gates.length ||
              entry.artifact.gate_evidence_paths.length !== policy.gates.length
            ) {
              return yield* reviewError(
                "review.superseded_gates_stale",
                `Superseded ${entry.artifact.axis} attempt does not bind every configured gate.`,
                "Rerun each configured gate after all old reviewer attempts are superseded.",
              );
            }
            for (const gate of gates) {
              if (!entry.artifact.gate_evidence_paths.includes(gate.path)) {
                return yield* reviewError(
                  "review.superseded_gates_stale",
                  `Superseded ${entry.artifact.axis} attempt has a gate baseline outside its launch binding.`,
                  "Preserve gate provenance and rerun every configured gate before review.",
                );
              }
              yield* reviewIo(
                () => ensureRunLocalPath(input.statePath, gate.path),
                "review.previous_gate_path_failed",
                "Could not validate superseded gate evidence path",
              );
              const raw = yield* reviewIo(
                () => readFile(gate.path, "utf8"),
                "review.previous_gate_read_failed",
                `Could not read superseded gate evidence at ${gate.path}`,
              );
              if (createHash("sha256").update(raw).digest("hex") !== gate.sha256) {
                return yield* reviewError(
                  "review.superseded_gates_stale",
                  `Gate evidence for superseded ${entry.artifact.axis} attempt was changed.`,
                  "Preserve immutable gate evidence and rerun all configured gates before review.",
                );
              }
            }
            supersededGateBaselines.push({ gates });
          }
          if (latestClaudeByAxis.size > 0) {
            let currentSupersessionGeneration: number;
            try {
              currentSupersessionGeneration = readSupersessionGeneration(
                markdown,
                input.ticket,
                input.round,
              );
            } catch (error) {
              return yield* error as ReviewError;
            }
            if (currentSupersessionGeneration !== requiredSupersessionGeneration) {
              return yield* reviewError(
                "review.supersession_generation_invalid",
                "Run state and committed Claude supersession records disagree on the active generation.",
                "Reconcile all supersession sidecars and state references before recording new gate evidence.",
              );
            }
            for (const configured of policy.gates) {
              const current = observedGateAttempts.get(configured.name);
              if (
                current === undefined ||
                current.supersessionGeneration !== currentSupersessionGeneration ||
                supersededGateBaselines.some((baseline) =>
                  baseline.gates.some(
                    (prior) =>
                      prior.name === configured.name &&
                      (prior.path === current.path ||
                        current.attempt <= prior.attempt ||
                        current.supersessionGeneration === null ||
                        current.supersessionGeneration <= prior.supersessionGeneration),
                  ),
                )
              ) {
                return yield* reviewError(
                  "review.superseded_gates_stale",
                  `Gate ${configured.name} is not durably ordered after every superseded Claude axis.`,
                  "Rerun and record every configured gate after all supersession state references, at a higher attempt and a new evidence path.",
                );
              }
            }
          }
        }

        if (input.previousArtifactPath !== undefined) {
          const previousRaw = yield* reviewIo(
            () => readFile(input.previousArtifactPath!, "utf8"),
            "review.previous_artifact_read_failed",
            "Could not read preceding review artifact",
          );
          let previous: ReviewArtifact;
          try {
            const parsed = JSON.parse(previousRaw) as unknown;
            if (!isRecord(parsed)) throw new Error("preceding artifact is not an object");
            previous = parsed as unknown as ReviewArtifact;
          } catch {
            return yield* reviewError(
              "review.retry_mismatch",
              "Preceding reviewer artifact is malformed.",
              "Recover the immutable preceding artifact before preparing its retry.",
            );
          }
          const previousStatePathMatches =
            typeof previous.state_path === "string" &&
            (yield* reviewIo(
              () => canonicalPathsEqual(previous.state_path, input.statePath),
              "review.previous_artifact_path_failed",
              "Could not canonicalize preceding review state path",
            ));
          const previousEvidencePath = `${previous.report_path}.json`;
          yield* reviewIo(
            () => ensureRunLocalPath(input.statePath, previous.artifact_path),
            "review.previous_artifact_path_failed",
            "Could not validate preceding review artifact declaration",
          );
          yield* reviewIo(
            () => ensureRunLocalPath(input.statePath, previous.report_path),
            "review.previous_report_path_failed",
            "Could not validate preceding review report path",
          );
          yield* reviewIo(
            () => ensureRunLocalPath(input.statePath, previousEvidencePath),
            "review.previous_evidence_path_failed",
            "Could not validate preceding review evidence path",
          );
          const previousEvidence = yield* reviewIo(
            async () =>
              JSON.parse(await readFile(previousEvidencePath, "utf8")) as Record<string, unknown>,
            "review.previous_evidence_read_failed",
            "Could not read preceding review evidence",
          );
          const superseded = previousEvidence.status === "superseded";
          if (
            previous.kind !== "coordinate-review-launch" ||
            previous.schema_version !== 1 ||
            previous.artifact_path !== input.previousArtifactPath ||
            !previousStatePathMatches ||
            previous.ticket !== input.ticket ||
            previous.round !== input.round ||
            previous.axis !== input.axis ||
            previous.attempt !== input.attempt - 1 ||
            previous.worktree_path !== requestedWorktree ||
            previous.branch !== input.branch ||
            previous.base_ref !== input.baseRef ||
            !isRoleRecord(previous.reviewer) ||
            !Array.isArray(previous.gate_evidence_paths) ||
            !sameStrings(previous.context_paths, input.contextPaths) ||
            !sameStrings(previous.landed_tickets, input.landedTickets) ||
            previous.reviewed_head !== reviewedHead ||
            previousEvidence.ticket !== previous.ticket ||
            previousEvidence.round !== previous.round ||
            previousEvidence.axis !== previous.axis ||
            previousEvidence.attempt !== previous.attempt ||
            previousEvidence.report_path !== previous.report_path ||
            previousEvidence.action !== "retry" ||
            previousEvidence.next_attempt !== input.attempt
          ) {
            return yield* reviewError(
              "review.retry_mismatch",
              "Reviewer retry does not preserve the preceding attempt's immutable review binding.",
              "Reuse the same ticket, round, axis, worktree, diff, sources, and landed context.",
            );
          }
          if (superseded) {
            const supersessionValue = previousEvidence.supersession;
            if (
              typeof supersessionValue !== "object" ||
              supersessionValue === null ||
              Array.isArray(supersessionValue)
            ) {
              return yield* reviewError(
                "review.retry_mismatch",
                "Superseded attempt has no valid immutable supersession record.",
                "Use the sidecar written by review.attempt.supersede; do not infer an interruption.",
              );
            }
            const supersession = supersessionValue as Record<string, unknown>;
            const gateEvidenceValue = supersession.gate_evidence;
            if (
              previous.reviewer.harness !== "claude" ||
              input.role.harness !== "pi" ||
              sameRole(previous.reviewer, input.role) ||
              !isRoleRecord(previousEvidence.reviewer) ||
              !sameRole(previousEvidence.reviewer, previous.reviewer) ||
              supersession.user_authorized !== true ||
              supersession.artifact_sha256 !==
                createHash("sha256").update(previousRaw).digest("hex") ||
              supersession.pane_closed !== true ||
              supersession.pane_id !== previous.pane ||
              supersession.replacement_attempt !== input.attempt ||
              !isRoleRecord(supersession.replacement_reviewer) ||
              !sameRole(supersession.replacement_reviewer, input.role) ||
              !Array.isArray(gateEvidenceValue) ||
              gateEvidenceValue.length !== policy.gates.length ||
              previousEvidence.head_before !== reviewedHead ||
              previousEvidence.head_after !== reviewedHead ||
              previousEvidence.status_before !== previous.status_before ||
              previousEvidence.status_after !== previous.status_before
            ) {
              return yield* reviewError(
                "review.retry_mismatch",
                "Supersession evidence does not authorize this exact Claude-to-Pi reviewer retry.",
                "Preserve the old artifact and use only the persisted Pi Reviewer default after verified closure.",
              );
            }
            const priorGateAttempts = new Map<
              string,
              {
                attempt: number;
                path: string;
                sha256: string;
                supersessionGeneration: number;
              }
            >();
            for (const value of gateEvidenceValue) {
              if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
              const record = value as Record<string, unknown>;
              if (
                typeof record.name === "string" &&
                Number.isInteger(record.attempt) &&
                typeof record.evidence_path === "string" &&
                typeof record.sha256 === "string" &&
                Number.isInteger(record.supersession_generation) &&
                (record.supersession_generation as number) >= 0
              ) {
                priorGateAttempts.set(record.name, {
                  attempt: record.attempt as number,
                  path: record.evidence_path,
                  sha256: record.sha256,
                  supersessionGeneration: record.supersession_generation as number,
                });
              }
            }
            if (priorGateAttempts.size !== policy.gates.length) {
              return yield* reviewError(
                "review.superseded_gates_stale",
                "Supersession evidence does not bind one immutable prior attempt for every gate.",
                "Rerun every configured gate and record new evidence before preparing fresh review.",
              );
            }
            for (const configured of policy.gates) {
              const prior = priorGateAttempts.get(configured.name);
              const current = observedGateAttempts.get(configured.name);
              if (
                prior === undefined ||
                current === undefined ||
                current.path === prior.path ||
                current.attempt <= prior.attempt ||
                current.supersessionGeneration === null ||
                current.supersessionGeneration <= prior.supersessionGeneration
              ) {
                return yield* reviewError(
                  "review.superseded_gates_stale",
                  `Gate \`${configured.name}\` has not been rerun after reviewer supersession.`,
                  "Run and record every exact gate at a higher attempt number before preparing fresh Pi reviewers.",
                );
              }
              if (!previous.gate_evidence_paths.includes(prior.path)) {
                return yield* reviewError(
                  "review.retry_mismatch",
                  "Supersession gate baseline does not match the prior reviewer artifact.",
                  "Use the gate evidence paths captured by the immutable prior attempt.",
                );
              }
              yield* reviewIo(
                () => ensureRunLocalPath(input.statePath, prior.path),
                "review.previous_gate_path_failed",
                "Could not validate superseded gate evidence path",
              );
              const priorGateRaw = yield* reviewIo(
                () => readFile(prior.path, "utf8"),
                "review.previous_gate_read_failed",
                `Could not read superseded gate evidence at ${prior.path}`,
              );
              let priorGateRecord: unknown;
              try {
                priorGateRecord = JSON.parse(priorGateRaw) as unknown;
              } catch {
                return yield* reviewError(
                  "review.retry_mismatch",
                  "Prior gate evidence is malformed after reviewer supersession.",
                  "Preserve immutable gate evidence and rerun all gates before preparing review.",
                );
              }
              const priorGateSupersessionGeneration =
                isRecord(priorGateRecord) && priorGateRecord.supersession_generation === undefined
                  ? 0
                  : isRecord(priorGateRecord)
                    ? priorGateRecord.supersession_generation
                    : undefined;
              if (
                !isRecord(priorGateRecord) ||
                priorGateSupersessionGeneration !== prior.supersessionGeneration ||
                createHash("sha256").update(priorGateRaw).digest("hex") !== prior.sha256
              ) {
                return yield* reviewError(
                  "review.retry_mismatch",
                  "Prior gate evidence or its durable ordering generation changed after reviewer supersession.",
                  "Preserve immutable gate evidence and rerun all gates before preparing review.",
                );
              }
            }
            const priorReport = yield* reviewIo(
              () =>
                readFile(previous.report_path, "utf8").catch((error: unknown) => {
                  if (error instanceof Error && "code" in error && error.code === "ENOENT")
                    return null;
                  throw error;
                }),
              "review.previous_report_read_failed",
              "Could not inspect superseded report path",
            );
            if (priorReport !== null) {
              return yield* reviewError(
                "review.retry_mismatch",
                "A report appeared after the interrupted attempt was superseded.",
                "Preserve it and resolve the conflicting reviewer outcome manually.",
              );
            }
          } else if (
            !sameRole(previous.reviewer, input.role) ||
            !sameStrings(previous.gate_evidence_paths, input.gateEvidencePaths) ||
            (previousEvidence.status !== "malformed" &&
              previousEvidence.status !== "infrastructure_failed")
          ) {
            return yield* reviewError(
              "review.retry_mismatch",
              "Reviewer retry does not preserve the preceding attempt's immutable role and gate binding.",
              "Keep the same reviewer role and gate evidence for ordinary infrastructure retries.",
            );
          }
        }
        const prefix = parsePrefix(markdown);
        const session = `${prefix}-review-${input.ticket}-r${input.round}-${input.axis}-a${input.attempt}`;
        const tab = `review ${prefix} ${input.ticket} r${input.round} ${input.axis} a${input.attempt}`;
        const prompt = reviewPrompt(input);
        const statusBefore = worktreeStatus(requestedWorktree);
        if (statusBefore.length > 0) {
          return yield* reviewError(
            "review.worktree_dirty_before",
            "Ticket worktree must be clean before a reviewer launches.",
            "Return existing changes to the implementor or clean them manually, then capture a new baseline.",
          );
        }
        const launch = buildReviewerLaunch(input, session, prompt);
        const artifact: ReviewArtifact = {
          schema_version: 1,
          kind: "coordinate-review-launch",
          state_path: input.statePath,
          artifact_path: input.artifactPath,
          report_path: input.reportPath,
          ticket: input.ticket,
          round: input.round,
          axis: input.axis,
          worktree_path: requestedWorktree,
          branch: input.branch,
          base_ref: input.baseRef,
          pane: input.pane,
          reviewer: input.role,
          context_paths: input.contextPaths,
          landed_tickets: input.landedTickets,
          gate_evidence_paths: input.gateEvidencePaths,
          attempt: input.attempt,
          session,
          tab,
          status_before: statusBefore,
          reviewed_head: reviewedHead,
          prompt,
          launch,
        };
        const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
        const existing = yield* reviewIo(
          () => readFile(input.artifactPath, "utf8").catch(() => ""),
          "review.artifact_read_failed",
          "Could not inspect launch artifact",
        );
        if (existing.length > 0 && existing !== serialized) {
          return yield* reviewError(
            "review.artifact_conflict",
            "Reviewer launch artifact already exists with different bound configuration.",
            "Preserve the artifact and recover the recorded attempt instead of overwriting it.",
          );
        }
        if (existing.length === 0) {
          yield* reviewIo(
            () => writeImmutable(input.artifactPath, serialized),
            "review.artifact_write_failed",
            "Could not persist launch artifact",
          );
        }
        return {
          recovered: existing.length > 0,
          artifact_path: input.artifactPath,
          report_path: input.reportPath,
          status_before: statusBefore,
          reviewed_head: reviewedHead,
          launch,
        };
      }),
    ).pipe(Effect.mapError(fromMutationError));
  });

const parseReviewReport = (
  report: string,
): { verdict: "PASS" | "FAIL"; findings: ReviewFinding[] } | null => {
  const lines = report.trimEnd().split(/\r?\n/u);
  const verdict = lines.at(-1);
  if (verdict !== "PASS" && verdict !== "FAIL") return null;
  const blocks = [
    ...report.matchAll(/^## Finding\s*\r?\n([\s\S]*?)(?=^## Finding\s*$|^PASS\s*$|^FAIL\s*$)/gmu),
  ];
  const findings: ReviewFinding[] = [];
  for (const block of blocks) {
    const fields: Record<string, string> = {};
    for (const line of block[1]!.trim().split(/\r?\n/u)) {
      const field = line.match(/^(Severity|Location|Rationale|Suggested fix):\s*(\S.*)$/u);
      if (field === null || fields[field[1]!] !== undefined) return null;
      fields[field[1]!] = field[2]!;
    }
    const severity = fields.Severity;
    if (
      (severity !== "critical" &&
        severity !== "high" &&
        severity !== "medium" &&
        severity !== "low") ||
      fields.Location === undefined ||
      !/^(?!unknown(?::|$)|none(?::|$)|n\/a(?::|$)|\?)(?:[^:\r\n]+):[1-9]\d*$/iu.test(
        fields.Location,
      ) ||
      fields.Rationale === undefined ||
      fields["Suggested fix"] === undefined
    ) {
      return null;
    }
    findings.push({
      severity,
      location: fields.Location,
      rationale: fields.Rationale,
      suggested_fix: fields["Suggested fix"],
    });
  }
  const findingHeadings = report.match(/^## Finding\s*$/gmu)?.length ?? 0;
  if (findingHeadings !== findings.length) return null;
  if (
    (findings.length === 0 && verdict !== "PASS") ||
    (findings.length > 0 && verdict !== "FAIL")
  ) {
    return null;
  }
  return { verdict, findings };
};

const appendEvidenceLine = (markdown: string, line: string): string =>
  appendSectionLine(markdown, "Review evidence", line, { spacing: "tight", before: "Decisions" });

const appendEvidence = (
  markdown: string,
  artifact: ReviewArtifact,
  status: ReviewLaunchRecordResult["status"],
  reportPath: string,
): string =>
  appendEvidenceLine(
    markdown,
    `- Ticket ${artifact.ticket} round ${artifact.round} ${artifact.axis} attempt ${artifact.attempt}: ${status}; reviewer ${JSON.stringify(artifact.reviewer)}; report ${reportPath}`,
  );

/**
 * Persists a complete reviewer report, rejects reviewer mutations, and applies strict verdict rules.
 *
 * @param input - Completed reviewer attempt or exact infrastructure failure.
 * @returns The accepted verdict or required retry, fix, block, or cleanup action.
 */
export const recordReviewerLaunch = (
  input: ReviewLaunchRecordInput,
): Effect.Effect<ReviewLaunchRecordResult, ReviewError> =>
  Effect.gen(function* () {
    yield* reviewIo(
      () => ensureRunLocalPath(input.statePath, input.artifactPath),
      "review.artifact_path_failed",
      "Could not validate supplied reviewer artifact path",
    );
    const rawArtifact = yield* reviewIo(
      () => readFile(input.artifactPath, "utf8"),
      "review.artifact_read_failed",
      "Could not read reviewer launch artifact",
    );
    let artifact: ReviewArtifact;
    try {
      artifact = JSON.parse(rawArtifact) as ReviewArtifact;
    } catch {
      return yield* reviewError(
        "review.artifact_malformed",
        "Reviewer launch artifact is not valid JSON.",
        "Recover it from durable state or prepare a new fixed-configuration attempt.",
      );
    }
    const artifactStatePathMatches =
      typeof artifact.state_path === "string" &&
      (yield* reviewIo(
        () => canonicalPathsEqual(artifact.state_path, input.statePath),
        "review.artifact_path_failed",
        "Could not canonicalize reviewer state path",
      ));
    if (
      artifact.kind !== "coordinate-review-launch" ||
      artifact.schema_version !== 1 ||
      !artifactStatePathMatches ||
      artifact.artifact_path !== input.artifactPath ||
      typeof artifact.report_path !== "string"
    ) {
      return yield* reviewError(
        "review.artifact_mismatch",
        "Reviewer launch artifact does not belong to this schema-2 run state or supplied path.",
        "Use the artifact recorded for this active ticket and attempt.",
      );
    }
    const evidencePath = `${artifact.report_path}.json`;
    yield* reviewIo(
      () => ensureRunLocalPath(input.statePath, artifact.artifact_path),
      "review.artifact_path_failed",
      "Could not validate reviewer artifact declaration",
    );
    yield* reviewIo(
      () => ensureRunLocalPath(input.statePath, artifact.report_path),
      "review.report_path_failed",
      "Could not validate reviewer report path",
    );
    yield* reviewIo(
      () => ensureRunLocalPath(input.statePath, evidencePath),
      "review.evidence_path_failed",
      "Could not validate reviewer evidence path",
    );
    const existingEvidence = yield* reviewIo(
      () =>
        readFile(evidencePath, "utf8").catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
          throw error;
        }),
      "review.evidence_read_failed",
      "Could not inspect existing reviewer evidence",
    );
    if (existingEvidence !== null) {
      let persisted: Record<string, unknown>;
      try {
        const parsed = JSON.parse(existingEvidence) as unknown;
        if (!isRecord(parsed)) throw new Error("review evidence is not an object");
        persisted = parsed;
      } catch {
        return yield* reviewError(
          "review.evidence_malformed",
          "Existing reviewer sidecar evidence is not valid JSON.",
          "Preserve it and recover the exact attempt before recording a result.",
        );
      }
      if (persisted.status === "superseded") {
        return yield* reviewError(
          "review.attempt_superseded",
          "This reviewer attempt has immutable supersession evidence and cannot later be recorded as a review.",
          "Use the authorized next attempt after rerunning every gate; never fabricate a report for this attempt.",
        );
      }
    }
    const statusAfter = worktreeStatus(artifact.worktree_path);
    const headAfter = worktreeHead(artifact.worktree_path);
    const contaminated =
      statusAfter !== artifact.status_before || headAfter !== artifact.reviewed_head;
    const parsed = input.report === undefined ? null : parseReviewReport(input.report);
    let status: ReviewLaunchRecordResult["status"];
    let verdict: ReviewLaunchRecordResult["verdict"] = null;
    let findings: ReviewFinding[] = [];
    let action: ReviewLaunchDisposition;
    let retryDelay: number | null = null;
    let nextAttempt: number | null = null;
    if (contaminated) {
      status = "contaminated";
      action = "manual_cleanup";
    } else if (input.status === "infrastructure_failed") {
      status = "infrastructure_failed";
      if (artifact.attempt < REVIEW_MAX_INFRASTRUCTURE_ATTEMPTS) {
        action = "retry";
        nextAttempt = artifact.attempt + 1;
        retryDelay = REVIEW_RETRY_DELAYS_SECONDS[artifact.attempt - 1]!;
      } else {
        action = "blocked";
      }
    } else if (parsed === null) {
      status = "malformed";
      if (artifact.attempt < REVIEW_MAX_INFRASTRUCTURE_ATTEMPTS) {
        action = "retry";
        nextAttempt = artifact.attempt + 1;
        retryDelay = REVIEW_RETRY_DELAYS_SECONDS[artifact.attempt - 1]!;
      } else {
        action = "blocked";
      }
    } else {
      status = "accepted";
      verdict = parsed.verdict;
      findings = parsed.findings;
      action = parsed.verdict === "PASS" ? "continue" : "fix";
    }
    const reportBody =
      input.report ??
      `# ${artifact.axis} review infrastructure failure\n\nStage: ${input.diagnostic!.stage}\nExit code: ${input.diagnostic!.exitCode}\nStderr:\n\n${input.diagnostic!.stderr}\n`;
    const reportHeader = [
      `<!-- ticket: ${artifact.ticket}; round: ${artifact.round}; axis: ${artifact.axis}; attempt: ${artifact.attempt}; status: ${status}; completed: ${input.completedAt} -->`,
      "",
    ].join("\n");
    yield* reviewIo(
      async () => {
        await writeImmutable(artifact.report_path, `${reportHeader}${reportBody}`);
        await writeImmutable(
          evidencePath,
          `${JSON.stringify(
            {
              schema_version: 1,
              ticket: artifact.ticket,
              round: artifact.round,
              axis: artifact.axis,
              attempt: artifact.attempt,
              reviewer: artifact.reviewer,
              status,
              verdict,
              action,
              findings,
              status_before: artifact.status_before,
              status_after: statusAfter,
              head_before: artifact.reviewed_head,
              head_after: headAfter,
              diagnostic: input.diagnostic ?? null,
              retry_delay_seconds: retryDelay,
              next_attempt: nextAttempt,
              completed_at: input.completedAt,
              report_path: artifact.report_path,
            },
            null,
            2,
          )}\n`,
        );
      },
      "review.report_write_failed",
      "Could not persist reviewer evidence",
    );
    yield* mutateStateFile(input.statePath, (markdown) =>
      Effect.succeed({
        markdown: appendEvidence(markdown, artifact, status, artifact.report_path),
        result: undefined,
      }),
    ).pipe(Effect.mapError(fromMutationError));
    const runtimeClosure = yield* inspectRuntimeClose(artifact.pane).pipe(
      Effect.mapError((error) => new ReviewError({ issue: error.issue })),
    );
    return {
      ticket: artifact.ticket,
      round: artifact.round,
      axis: artifact.axis,
      attempt: artifact.attempt,
      status,
      verdict,
      action: runtimeClosure.runtime_closed ? action : "close-runtime",
      after_close_action: action,
      runtime_closed: runtimeClosure.runtime_closed,
      pane_id: runtimeClosure.pane_id,
      close: runtimeClosure.close,
      findings,
      report_path: artifact.report_path,
      evidence_path: evidencePath,
      retry_delay_seconds: retryDelay,
      next_attempt: nextAttempt,
    };
  });

/**
 * Persisted gate attempt outcome.
 */
export type GateRecordResult = {
  ticket: string;
  round: number;
  name: string;
  worktree_path: string;
  attempt: number;
  status: "passed" | "failed" | "infrastructure_failed";
  action: "continue" | "fix" | "retry" | "blocked";
  head: string;
  evidence_path: string;
  retry_delay_seconds: number | null;
  next_attempt: number | null;
};

/**
 * Persists exact gate output and applies the shared infrastructure retry policy.
 *
 * @param input - Gate identity, output, status, and evidence path.
 * @returns The next coordinator action without interpreting command output.
 */
export const recordGate = (input: GateRecordInput): Effect.Effect<GateRecordResult, ReviewError> =>
  Effect.gen(function* () {
    const canonicalStatePath = yield* reviewIo(
      () => canonicalExistingPath(input.statePath),
      "gate.state_path_failed",
      "Could not canonicalize run state path before recording gate evidence",
    );
    return yield* mutateStateFile(canonicalStatePath, (markdown) =>
      Effect.gen(function* () {
        yield* validateStateText(input.statePath, markdown).pipe(
          Effect.mapError((error) => new ReviewError({ issue: error.issue })),
        );
        yield* reviewIo(
          () => ensureRunLocalPath(input.statePath, input.evidencePath),
          "gate.evidence_path_failed",
          "Could not validate gate evidence path",
        );
        const policy = parsePolicy(markdown);
        const runtime = parseActiveTicket(markdown, input.ticket);
        const currentHead = worktreeHead(runtime.worktree);
        let integration: ReturnType<typeof validateIntegration>;
        try {
          integration = validateIntegration(markdown, input.ticket, currentHead, undefined);
        } catch (error) {
          return yield* error as ReviewError;
        }
        const migrationRecoveryRecorded = markdown.includes(
          `ticket ${input.ticket} implementor migration recovery;`,
        );
        if (migrationRecoveryRecorded && integration === undefined) {
          return yield* reviewError(
            "gate.migration_integration_stale",
            "Recovered migration has no integration cycle to bind gate evidence to.",
            "Complete landing.rebase.check before executing or recording gates.",
          );
        }
        const activeWorktree = yield* reviewIo(
          () => realpath(runtime.worktree),
          "gate.worktree_path_failed",
          "Could not resolve the active ticket worktree",
        );
        const suppliedWorktree = yield* reviewIo(
          () => realpath(input.worktreePath),
          "gate.worktree_path_failed",
          "Could not resolve the supplied gate worktree",
        );
        if (activeWorktree !== suppliedWorktree) {
          return yield* reviewError(
            "gate.worktree_mismatch",
            "Gate worktree does not match the active ticket runtime.",
            "Run and record the gate in the active ticket worktree only.",
          );
        }
        const head = worktreeHead(activeWorktree);
        const gate = policy.gates.find((candidate) => candidate.name === input.name);
        if (gate === undefined) {
          return yield* reviewError(
            "gate.not_configured",
            `Gate \`${input.name}\` is not present in the persisted repository-derived policy.`,
            "Run only exact gate argv arrays persisted before workers launched.",
          );
        }
        const supersessionGeneration = yield* reviewIo(
          async () => readSupersessionGeneration(markdown, input.ticket, input.round),
          "gate.supersession_generation_invalid",
          "Could not read durable reviewer supersession ordering",
        );
        let action: GateRecordResult["action"];
        let retryDelay: number | null = null;
        let nextAttempt: number | null = null;
        if (input.status === "passed") action = "continue";
        else if (input.status === "failed") action = "fix";
        else if (input.attempt < REVIEW_MAX_INFRASTRUCTURE_ATTEMPTS) {
          action = "retry";
          nextAttempt = input.attempt + 1;
          retryDelay = REVIEW_RETRY_DELAYS_SECONDS[input.attempt - 1]!;
        } else action = "blocked";
        const updatedMarkdown = yield* Effect.try({
          try: () =>
            action === "fix"
              ? applyIntegrationFix(markdown, {
                  ticket: input.ticket,
                  reviewedHead: head,
                  completedAt: input.completedAt,
                  phase: "gate fix required",
                })
              : action === "continue"
                ? applyGatePass(markdown, {
                    ticket: input.ticket,
                    name: input.name,
                    head,
                    gateNames: policy.gates.map((candidate) => candidate.name),
                  })
                : markdown,
          catch: (error) =>
            error instanceof LandingError || error instanceof IntegrationError
              ? new ReviewError({ issue: error.issue })
              : reviewError(
                  "gate.integration_failed",
                  `Could not advance ticket integration: ${(error as Error).message}`,
                  "Repair the Integration record and retry the immutable gate evidence.",
                ),
        });
        yield* reviewIo(
          () =>
            writeImmutable(
              input.evidencePath,
              `${JSON.stringify(
                {
                  schema_version: 1,
                  ticket: input.ticket,
                  round: input.round,
                  head,
                  worktree_path: activeWorktree,
                  gate: { name: input.name, argv: gate.argv },
                  attempt: input.attempt,
                  status: input.status,
                  action,
                  exit_code: input.exitCode,
                  stdout: input.stdout,
                  stderr: input.stderr,
                  completed_at: input.completedAt,
                  supersession_generation: supersessionGeneration,
                  integration_cycle: integration?.cycle ?? null,
                },
                null,
                2,
              )}\n`,
            ),
          "gate.evidence_write_failed",
          "Could not persist gate evidence",
        );
        return {
          markdown: updatedMarkdown,
          result: {
            ticket: input.ticket,
            round: input.round,
            name: input.name,
            worktree_path: activeWorktree,
            attempt: input.attempt,
            status: input.status,
            action,
            head,
            evidence_path: input.evidencePath,
            retry_delay_seconds: retryDelay,
            next_attempt: nextAttempt,
          },
        };
      }),
    ).pipe(Effect.mapError(fromMutationError));
  });

/**
 * Successful user-authorized rerun of a failed gate without a ticket commit.
 */
export type GateRerunRecordResult = {
  ticket: string;
  round: number;
  name: string;
  worktree_path: string;
  attempt: number;
  status: "passed";
  action: "continue";
  head: string;
  previous_evidence_path: string;
  evidence_path: string;
  user_authorized: true;
  diagnostic: string;
  recovered: boolean;
};

/**
 * Records a passing same-HEAD rerun and restores gate review without a fake commit.
 *
 * @param input - Prior failed evidence, fresh output, explicit authority, and unchanged worktree.
 * @returns The durable passing evidence and restored gate action.
 */
export const recordGateRerun = (
  input: GateRerunRecordInput,
): Effect.Effect<GateRerunRecordResult, ReviewError> =>
  Effect.gen(function* () {
    yield* reviewIo(
      () => ensureRunLocalPath(input.statePath, input.previousEvidencePath),
      "gate.rerun_evidence_path_failed",
      "Could not validate prior gate evidence path",
    );
    yield* reviewIo(
      () => ensureRunLocalPath(input.statePath, input.evidencePath),
      "gate.rerun_evidence_path_failed",
      "Could not validate passing rerun evidence path",
    );
    const markdown = yield* reviewIo(
      () => readFile(input.statePath, "utf8"),
      "gate.rerun_state_read_failed",
      "Could not read run state",
    );
    yield* validateStateText(input.statePath, markdown).pipe(
      Effect.mapError((error) => new ReviewError({ issue: error.issue })),
    );
    const policy = parsePolicy(markdown);
    const runtime = parseActiveTicket(markdown, input.ticket);
    const activeWorktree = yield* reviewIo(
      () => realpath(runtime.worktree),
      "gate.rerun_worktree_path_failed",
      "Could not resolve the active ticket worktree",
    );
    const suppliedWorktree = yield* reviewIo(
      () => realpath(input.worktreePath),
      "gate.rerun_worktree_path_failed",
      "Could not resolve the supplied gate worktree",
    );
    if (activeWorktree !== suppliedWorktree) {
      return yield* reviewError(
        "gate.rerun_worktree_mismatch",
        "Gate rerun worktree does not match the active ticket runtime.",
        "Rerun the exact failed gate in the active ticket worktree only.",
      );
    }
    const head = worktreeHead(activeWorktree);
    if (worktreeStatus(activeWorktree) !== "") {
      return yield* reviewError(
        "gate.rerun_worktree_dirty",
        "No-change gate recovery requires a clean ticket worktree.",
        "Commit a real fix under the persisted policy or restore the clean reviewed tip before rerunning.",
      );
    }
    const noChange = yield* Effect.try({
      try: () => noChangeIntegration(markdown, input.ticket, head),
      catch: (error) =>
        error instanceof ReviewError
          ? error
          : reviewError(
              "gate.rerun_state_invalid",
              `Could not validate the no-change integration: ${(error as Error).message}`,
              "Repair the Integration record from durable gate evidence.",
            ),
    });
    const baseSha = noChange.baseSha;
    const integrationCycle = noChange.cycle;
    const supersessionGeneration = yield* reviewIo(
      async () => readSupersessionGeneration(markdown, input.ticket, input.round),
      "gate.rerun_supersession_generation_invalid",
      "Could not read durable reviewer supersession ordering",
    );
    const gate = policy.gates.find((candidate) => candidate.name === input.name);
    if (gate === undefined) {
      return yield* reviewError(
        "gate.not_configured",
        `Gate \`${input.name}\` is not present in the persisted repository-derived policy.`,
        "Rerun only an exact gate argv persisted before workers launched.",
      );
    }
    const previous = yield* reviewIo(
      async () => JSON.parse(await readFile(input.previousEvidencePath, "utf8")) as unknown,
      "gate.rerun_previous_evidence_read_failed",
      "Could not read prior failed gate evidence",
    );
    if (typeof previous !== "object" || previous === null || Array.isArray(previous)) {
      return yield* reviewError(
        "gate.rerun_previous_evidence_invalid",
        "Prior gate evidence is malformed.",
        "Use the immutable failed evidence produced by gate.record.",
      );
    }
    const prior = previous as Record<string, unknown>;
    const priorGate = prior.gate;
    if (
      prior.schema_version !== 1 ||
      prior.ticket !== input.ticket ||
      prior.round !== input.round ||
      prior.head !== head ||
      prior.worktree_path !== activeWorktree ||
      typeof priorGate !== "object" ||
      priorGate === null ||
      Array.isArray(priorGate) ||
      (priorGate as Record<string, unknown>).name !== input.name ||
      JSON.stringify((priorGate as Record<string, unknown>).argv) !== JSON.stringify(gate.argv) ||
      prior.attempt !== input.attempt - 1 ||
      prior.status !== "failed" ||
      prior.action !== "fix" ||
      prior.supersession_generation !== supersessionGeneration ||
      prior.integration_cycle !== integrationCycle ||
      typeof prior.exit_code !== "number" ||
      prior.exit_code === 0 ||
      typeof prior.stdout !== "string" ||
      typeof prior.stderr !== "string" ||
      !isUtcIsoTimestamp(prior.completed_at)
    ) {
      return yield* reviewError(
        "gate.rerun_previous_evidence_invalid",
        "Prior gate evidence does not match the failed same-HEAD gate attempt.",
        "Use the immediately preceding failed evidence for this ticket, round, gate, worktree, and HEAD.",
      );
    }
    const count = spawnGit(["rev-list", "--count", `${baseSha}..HEAD`], {
      cwd: activeWorktree,
    });
    const commitCount = Number(count.stdout.trim());
    if (count.exitCode !== 0 || !Number.isSafeInteger(commitCount) || commitCount <= 0) {
      return yield* reviewError(
        "gate.rerun_range_invalid",
        "Could not reconstruct a non-empty integrated ticket range for the gate rerun.",
        "Restore the integrated base and ticket commits before recovery.",
      );
    }
    const evidence = `${JSON.stringify(
      {
        schema_version: 1,
        ticket: input.ticket,
        round: input.round,
        head,
        worktree_path: activeWorktree,
        gate: { name: input.name, argv: gate.argv },
        attempt: input.attempt,
        status: "passed",
        action: "continue",
        exit_code: input.exitCode,
        stdout: input.stdout,
        stderr: input.stderr,
        completed_at: input.completedAt,
        supersession_generation: supersessionGeneration,
        integration_cycle: integrationCycle,
        rerun_of: input.previousEvidencePath,
        user_authorized: input.userAuthorized,
        recovery_diagnostic: input.diagnostic,
      },
      null,
      2,
    )}\n`;
    yield* reviewIo(
      () => writeImmutable(input.evidencePath, evidence),
      "gate.rerun_evidence_write_failed",
      "Could not persist passing rerun evidence",
    );
    const recovered = yield* mutateStateFile(input.statePath, (state) =>
      Effect.try({
        try: () => {
          if (worktreeHead(activeWorktree) !== head) {
            throw reviewError(
              "gate.rerun_head_changed",
              "Ticket HEAD changed while recording the no-change gate rerun.",
              "Rerun the gate and record new evidence against the current clean HEAD.",
            );
          }
          if (worktreeStatus(activeWorktree) !== "") {
            throw reviewError(
              "gate.rerun_worktree_dirty",
              "Ticket worktree changed while recording the no-change gate rerun.",
              "Commit a real fix or restore the clean reviewed tip before retrying.",
            );
          }
          const update = applyNoChangeGateRerun(state, {
            ticket: input.ticket,
            name: input.name,
            reviewedHead: head,
            previousEvidencePath: input.previousEvidencePath,
            evidencePath: input.evidencePath,
            diagnostic: input.diagnostic,
            completedAt: input.completedAt,
            fixes: parseFixCommitPolicy(state),
          });
          return { markdown: update.markdown, result: update.recovered };
        },
        catch: (error) =>
          error instanceof ReviewError
            ? error
            : error instanceof LandingError || error instanceof IntegrationError
              ? new ReviewError({ issue: error.issue })
              : reviewError(
                  "gate.rerun_integration_failed",
                  `Could not restore gate review: ${(error as Error).message}`,
                  "Repair the Integration record from immutable gate evidence.",
                ),
      }),
    ).pipe(Effect.mapError(fromMutationError));
    return {
      ticket: input.ticket,
      round: input.round,
      name: input.name,
      worktree_path: activeWorktree,
      attempt: input.attempt,
      status: "passed",
      action: "continue",
      head,
      previous_evidence_path: input.previousEvidencePath,
      evidence_path: input.evidencePath,
      user_authorized: input.userAuthorized,
      diagnostic: input.diagnostic,
      recovered,
    };
  });

/**
 * Consolidated independent review round result.
 */
export type ReviewRoundFinalizeResult = {
  ticket: string;
  round: number;
  verdict: "PASS" | "FAIL";
  action: "land" | "fix";
  findings: Array<ReviewFinding & { axis: ReviewAxis }>;
  self_review_path: string;
  standards_report_path: string;
  spec_report_path: string;
  fix_request_path: string | null;
  fix_request_authorized: boolean;
  next_round: number | null;
  fix_commit_policy: "append" | "amend" | "squash";
};

type StoredReviewEvidence = {
  schema_version: number;
  ticket: string;
  round: number;
  axis: ReviewAxis;
  status: string;
  verdict: "PASS" | "FAIL" | null;
  findings: ReviewFinding[];
  report_path: string;
  head_before: string;
};

const readStoredEvidence = (path: string): Effect.Effect<StoredReviewEvidence, ReviewError> =>
  reviewIo(
    async () => JSON.parse(await readFile(path, "utf8")) as StoredReviewEvidence,
    "review.evidence_read_failed",
    `Could not read accepted review evidence at ${path}`,
  );

const parseFixCommitPolicy = (markdown: string): "append" | "amend" | "squash" => {
  const record = readRepositoryPolicy(markdown);
  if ("policy" in record) return record.policy.commit.fixes;
  if (record.problem === "missing") return "append";
  throw reviewError(
    "review.repository_policy_malformed",
    "RESUME.md contains an incomplete Repository policy.",
    "Repair the persisted remote, cleanup, and commit records before consolidating review.",
  );
};

/**
 * Validates harness self-review and consolidates both accepted axes into one fix request.
 *
 * @param input - Both axis evidence files, self-review evidence, and round paths.
 * @returns A strict pass or pre-authorized fix outcome.
 */
export const finalizeReviewRound = (
  input: ReviewRoundFinalizeInput,
): Effect.Effect<ReviewRoundFinalizeResult, ReviewError> =>
  Effect.gen(function* () {
    for (const path of [
      input.standardsEvidencePath,
      input.specEvidencePath,
      input.selfReviewPath,
      input.fixRequestPath,
    ]) {
      yield* reviewIo(
        () => ensureRunLocalPath(input.statePath, path),
        "review.round_path_failed",
        "Could not validate review round evidence path",
      );
    }
    const markdown = yield* reviewIo(
      () => readFile(input.statePath, "utf8"),
      "review.state_read_failed",
      "Could not read run state",
    );
    const runtime = parseActiveTicket(markdown, input.ticket);
    const expectedMethod: SelfReviewMode =
      runtime.implementor.harness === "claude" ? "matt-implement" : "standards-spec-single-session";
    if (input.selfReviewMethod !== expectedMethod) {
      return yield* reviewError(
        "review.self_review_mismatch",
        `Ticket \`${input.ticket}\` requires self-review method \`${expectedMethod}\` for its bound implementor harness.`,
        "Run the harness-appropriate self-review in the existing implementor session, then retry.",
      );
    }
    if (
      expectedMethod === "standards-spec-single-session" &&
      (!/^## Standards\s*$/mu.test(input.selfReviewReport) ||
        !/^## Spec\s*$/mu.test(input.selfReviewReport))
    ) {
      return yield* reviewError(
        "review.pi_self_review_malformed",
        "Pi fallback self-review must contain both `## Standards` and `## Spec` sections.",
        "Complete both axes in the same Pi implementor session without requiring subagents.",
      );
    }
    const standards = yield* readStoredEvidence(input.standardsEvidencePath);
    const spec = yield* readStoredEvidence(input.specEvidencePath);
    for (const [axis, evidence] of [
      ["standards", standards],
      ["spec", spec],
    ] as const) {
      if (
        evidence.schema_version !== 1 ||
        evidence.ticket !== input.ticket ||
        evidence.round !== input.round ||
        evidence.axis !== axis ||
        evidence.status !== "accepted" ||
        (evidence.verdict !== "PASS" && evidence.verdict !== "FAIL") ||
        typeof evidence.report_path !== "string" ||
        typeof evidence.head_before !== "string" ||
        (evidence.verdict === "PASS" && evidence.findings.length !== 0) ||
        (evidence.verdict === "FAIL" && evidence.findings.length === 0)
      ) {
        return yield* reviewError(
          "review.round_evidence_invalid",
          `Round evidence for the ${axis} axis is missing, rejected, contaminated, or belongs to another round.`,
          "Retry that axis in a fresh Reviewer session and persist it before finalizing.",
        );
      }
      yield* reviewIo(
        () => ensureRunLocalPath(input.statePath, evidence.report_path),
        "review.round_report_path_failed",
        `Could not validate the ${axis} report path`,
      );
      yield* reviewIo(
        () => readFile(evidence.report_path, "utf8"),
        "review.round_report_missing",
        `Could not read the complete ${axis} report`,
      );
    }
    const findings = [
      ...standards.findings.map((finding) => ({ ...finding, axis: "standards" as const })),
      ...spec.findings.map((finding) => ({ ...finding, axis: "spec" as const })),
    ];
    const verdict = findings.length === 0 ? "PASS" : "FAIL";
    const action = verdict === "PASS" ? "land" : "fix";
    const fixCommitPolicy = parseFixCommitPolicy(markdown);
    yield* reviewIo(
      async () => {
        await writeImmutable(
          input.selfReviewPath,
          `<!-- ticket: ${input.ticket}; round: ${input.round}; method: ${input.selfReviewMethod}; completed: ${input.completedAt} -->\n\n${input.selfReviewReport}`,
        );
        if (findings.length > 0) {
          const rendered = findings.flatMap((finding, index) => [
            `## ${index + 1}. ${finding.axis} ${finding.severity}`,
            "",
            `Location: ${finding.location}`,
            `Rationale: ${finding.rationale}`,
            `Suggested fix: ${finding.suggested_fix}`,
            "",
          ]);
          await writeImmutable(
            input.fixRequestPath,
            [
              `# Ticket ${input.ticket} review fixes, round ${input.round}`,
              "",
              ...rendered,
              "This ordinary review-remediation request is pre-authorized by the run's standing fix loop. Apply it immediately without asking the user for permission.",
              "",
              `Apply the persisted ${fixCommitPolicy} fix-commit policy, rerun every recorded gate, rerun the harness-appropriate self-review, and print \`FIXES DONE ${input.ticket}\`.`,
              "",
            ].join("\n"),
          );
        }
      },
      "review.round_write_failed",
      "Could not persist self-review or consolidated fix request",
    );
    const result: ReviewRoundFinalizeResult = {
      ticket: input.ticket,
      round: input.round,
      verdict,
      action,
      findings,
      self_review_path: input.selfReviewPath,
      standards_report_path: standards.report_path,
      spec_report_path: spec.report_path,
      fix_request_path: findings.length > 0 ? input.fixRequestPath : null,
      fix_request_authorized: action === "fix",
      next_round: findings.length > 0 ? input.round + 1 : null,
      fix_commit_policy: fixCommitPolicy,
    };
    if (standards.head_before !== spec.head_before) {
      return yield* reviewError(
        "review.round_evidence_invalid",
        "Standards and Spec evidence do not cover the same ticket tip.",
        "Repeat both axes against the current complete integration-base-to-ticket-tip range.",
      );
    }
    yield* mutateStateFile(input.statePath, (state) =>
      Effect.try({
        try: () => {
          const withIntegration = applyFinalReviewOutcome(state, {
            ticket: input.ticket,
            verdict,
            reviewedHead: standards.head_before,
            standardsEvidencePath: input.standardsEvidencePath,
            specEvidencePath: input.specEvidencePath,
            selfReviewPath: input.selfReviewPath,
            completedAt: input.completedAt,
          });
          return {
            markdown: appendEvidenceLine(
              withIntegration,
              `- Ticket ${input.ticket} round ${input.round} finalized: ${verdict}; self-review ${input.selfReviewPath}; Standards ${standards.report_path}; Spec ${spec.report_path}${findings.length > 0 ? `; fixes ${input.fixRequestPath}` : ""}`,
            ),
            result: undefined,
          };
        },
        catch: (error) =>
          error instanceof LandingError || error instanceof IntegrationError
            ? new ReviewError({ issue: error.issue })
            : reviewError(
                "review.integration_failed",
                `Could not advance ticket integration: ${(error as Error).message}`,
                "Repair the Integration record and retry the same immutable review evidence.",
              ),
      }),
    ).pipe(Effect.mapError(fromMutationError));
    return result;
  });
