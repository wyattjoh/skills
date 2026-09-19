import { Data, Effect } from "effect";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  CliIssue,
  GateRecordInput,
  ReviewAxis,
  ReviewLaunchPrepareInput,
  ReviewLaunchRecordInput,
  ReviewPolicyPrepareInput,
  ReviewRoundFinalizeInput,
  RoleRecord,
} from "./contract.ts";
import { spawnGit } from "./git.ts";
import { applyFinalizationFix, applyFinalReviewOutcome, LandingError } from "./landing.ts";
import { mutateStateFile, StateMutationError } from "./state-mutation.ts";
import { validateStateText } from "./state.ts";

/**
 * Fixed review and gate infrastructure retry limit.
 */
export const REVIEW_MAX_INFRASTRUCTURE_ATTEMPTS = 3 as const;

/**
 * Bounded delays used before the second and third infrastructure attempts.
 */
export const REVIEW_RETRY_DELAYS_SECONDS = [1, 2] as const;

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
  retry_delays_seconds: [number, number];
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

const parseRoleBlock = (markdown: string, name: "Implementor" | "Reviewer"): RoleRecord => {
  const expression = new RegExp(`^${name}:\\r?\\n((?:  [^\\r\\n]*(?:\\r?\\n|$))+)`, "gmu");
  const matches = [...markdown.matchAll(expression)];
  if (matches.length !== 1) {
    throw reviewError(
      `state.${name.toLowerCase()}_role_malformed`,
      `RESUME.md must contain exactly one complete \`${name}:\` role block.`,
      `Repair the schema-1 ${name} harness, model, and effort before preparing review policy.`,
    );
  }
  const fields: Record<string, string> = {};
  for (const line of matches[0]![1]!.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    const field = line.match(/^  ([a-z]+):\s*(.*)$/u);
    if (field !== null && field[2]!.length > 0 && fields[field[1]!] === undefined) {
      fields[field[1]!] = field[2]!;
    }
  }
  const harness = fields.harness;
  const model = fields.model;
  const effort = fields.effort;
  if ((harness !== "claude" && harness !== "pi") || model === undefined || effort === undefined) {
    throw reviewError(
      `state.${name.toLowerCase()}_role_malformed`,
      `RESUME.md has an incomplete or malformed \`${name}:\` role block.`,
      `Repair the schema-1 ${name} harness, model, and effort before preparing review policy.`,
    );
  }
  return { harness, model, effort };
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
        retry_delays_seconds: [REVIEW_RETRY_DELAYS_SECONDS[0], REVIEW_RETRY_DELAYS_SECONDS[1]],
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
  action: "continue" | "fix" | "retry" | "blocked" | "manual_cleanup";
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

const sameRole = (left: RoleRecord, right: RoleRecord): boolean =>
  left.harness === right.harness && left.model === right.model && left.effort === right.effort;

const sameStrings = (left: string[], right: string[]): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const parsePrefix = (markdown: string): string => {
  const matches = [...markdown.matchAll(/^Prefix:\s*(\S+)\s*$/gmu)];
  if (matches.length !== 1) {
    throw reviewError(
      "state.prefix_malformed",
      "RESUME.md must contain exactly one non-empty `Prefix:` field.",
      "Repair the schema-1 run prefix before preparing a reviewer launch.",
    );
  }
  return matches[0]![1]!;
};

const parsePolicy = (markdown: string): ReviewPolicy => {
  const matches = [
    ...markdown.matchAll(/^## Review policy\s*\r?\n\r?\n```json\r?\n([\s\S]*?)\r?\n```\s*$/gmu),
  ];
  if (matches.length !== 1) {
    throw reviewError(
      "review.policy_missing",
      "RESUME.md has no single resolved `## Review policy` record.",
      "Run `review.policy.prepare` before launching workers or reviewers.",
    );
  }
  try {
    return JSON.parse(matches[0]![1]!) as ReviewPolicy;
  } catch {
    throw reviewError(
      "review.policy_malformed",
      "RESUME.md contains malformed review policy JSON.",
      "Repair the policy from authoritative repository instructions and CI, then retry.",
    );
  }
};

const parseActiveTicket = (
  markdown: string,
  ticket: string,
): { worktree: string; branch: string; implementor: RoleRecord } => {
  const match = markdown.match(
    new RegExp(`^### ${ticket}\\r?\\n([\\s\\S]*?)(?=^### |^## |(?![\\s\\S]))`, "mu"),
  );
  if (match === null) {
    throw reviewError(
      "review.ticket_runtime_missing",
      `RESUME.md has no active runtime for ticket \`${ticket}\`.`,
      "Restore the ticket runtime before preparing external review.",
    );
  }
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/u)) {
    const field = line.match(/^([A-Za-z][A-Za-z ]*):\s*(.*)$/u);
    if (field !== null) fields[field[1]!] = field[2]!;
  }
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

const validateSerializedFinalization = (
  markdown: string,
  ticket: string,
  head: string,
  baseRef: string | undefined,
): { cycle: number } | undefined => {
  const match = markdown.match(
    /^## Serialized finalization\s*\r?\n\r?\n```json\r?\n([\s\S]*?)\r?\n```\s*$/mu,
  );
  if (match === null) return undefined;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(match[1]!) as Record<string, unknown>;
  } catch {
    throw reviewError(
      "review.finalization_malformed",
      "Serialized finalization state is malformed.",
      "Repair it from synchronization evidence before gates or review.",
    );
  }
  if (value.ticket !== ticket) {
    throw reviewError(
      "review.finalization_serialized",
      `Ticket \`${String(value.ticket)}\` owns serialized finalization.`,
      "Keep other implementors running, but gate and review only the serialized ticket.",
    );
  }
  if (value.phase !== "gates" || value.ticket_sha !== head) {
    throw reviewError(
      "review.finalization_stale",
      "Gate or review input does not match the synchronized ticket tip and phase.",
      "Run landing.synchronize, then rerun every gate against its returned tip.",
    );
  }
  if (baseRef !== undefined && value.base_sha !== baseRef) {
    throw reviewError(
      "review.range_mismatch",
      "Reviewer base_ref does not equal the synchronized full-SHA review base.",
      "Use the exact review_range returned by landing.synchronize.",
    );
  }
  return { cycle: typeof value.cycle === "number" ? value.cycle : 0 };
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

const reviewPrompt = (input: ReviewLaunchPrepareInput, finalizationCycle: number): string => {
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
    ...(finalizationCycle > 0
      ? [
          "This is a refused-fast-forward recovery review. Focus on newly landed interactions and synchronization conflict-resolution hunks.",
        ]
      : []),
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
    prompt: {
      command: "herdr",
      args: [
        "agent",
        "prompt",
        "--wait",
        "--until",
        "working",
        "--timeout",
        "300000",
        "--",
        session,
        prompt,
      ],
    },
  };
};

const writeImmutable = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, content, { flag: "wx" });
    return;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const existing = await readFile(path, "utf8");
  if (existing !== content) {
    throw reviewError(
      "review.evidence_conflict",
      `Durable evidence already exists at ${path} with different content.`,
      "Choose the correct new attempt or round path. Never overwrite earlier evidence.",
    );
  }
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
 * Captures a clean Git baseline and constructs one fresh independent reviewer launch.
 *
 * @param input - Axis, runtime, role, and evidence paths for one reviewer attempt.
 * @returns The persisted artifact and exact shell-free Herdr command arrays.
 */
export const prepareReviewerLaunch = (
  input: ReviewLaunchPrepareInput,
): Effect.Effect<ReviewLaunchPrepareResult, ReviewError> =>
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
    let finalizationCycle = 0;
    try {
      finalizationCycle =
        validateSerializedFinalization(markdown, input.ticket, reviewedHead, input.baseRef)
          ?.cycle ?? 0;
    } catch (error) {
      return yield* error as ReviewError;
    }
    if (input.gateEvidencePaths.length !== policy.gates.length) {
      return yield* reviewError(
        "review.gates_incomplete",
        "Reviewer launch requires one passing evidence file for every persisted gate.",
        "Run and record every gate for this ticket, commit, and round before external review.",
      );
    }
    const observedGateNames = new Set<string>();
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
            head: unknown | undefined;
            worktree_path: unknown | undefined;
          },
        "review.gate_evidence_read_failed",
        `Could not read gate evidence at ${path}`,
      );
      const configured = policy.gates.find((gate) => gate.name === evidence.gate?.name);
      if (
        evidence.ticket !== input.ticket ||
        evidence.round !== input.round ||
        evidence.status !== "passed" ||
        evidence.action !== "continue" ||
        evidence.head !== reviewedHead ||
        evidence.worktree_path !== requestedWorktree ||
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
    }
    if (input.previousArtifactPath !== undefined) {
      const previousRaw = yield* reviewIo(
        () => readFile(input.previousArtifactPath!, "utf8"),
        "review.previous_artifact_read_failed",
        "Could not read preceding review artifact",
      );
      let previous: ReviewArtifact;
      try {
        previous = JSON.parse(previousRaw) as ReviewArtifact;
      } catch {
        return yield* reviewError(
          "review.retry_mismatch",
          "Preceding reviewer artifact is malformed.",
          "Recover the immutable preceding artifact before preparing its retry.",
        );
      }
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
      if (
        previous.kind !== "coordinate-review-launch" ||
        previous.schema_version !== 1 ||
        previous.artifact_path !== input.previousArtifactPath ||
        previous.state_path !== input.statePath ||
        previous.ticket !== input.ticket ||
        previous.round !== input.round ||
        previous.axis !== input.axis ||
        previous.attempt !== input.attempt - 1 ||
        previous.worktree_path !== requestedWorktree ||
        previous.branch !== input.branch ||
        previous.base_ref !== input.baseRef ||
        !sameRole(previous.reviewer, input.role) ||
        !sameStrings(previous.context_paths, input.contextPaths) ||
        !sameStrings(previous.landed_tickets, input.landedTickets) ||
        !sameStrings(previous.gate_evidence_paths, input.gateEvidencePaths) ||
        previous.reviewed_head !== reviewedHead ||
        previousEvidence.ticket !== previous.ticket ||
        previousEvidence.round !== previous.round ||
        previousEvidence.axis !== previous.axis ||
        previousEvidence.attempt !== previous.attempt ||
        previousEvidence.report_path !== previous.report_path ||
        (previousEvidence.status !== "malformed" &&
          previousEvidence.status !== "infrastructure_failed") ||
        previousEvidence.action !== "retry" ||
        previousEvidence.next_attempt !== input.attempt
      ) {
        return yield* reviewError(
          "review.retry_mismatch",
          "Reviewer retry does not preserve the preceding attempt's immutable review binding.",
          "Reuse the same ticket, round, axis, role, worktree, diff, sources, landed context, and gate evidence.",
        );
      }
    }
    const prefix = parsePrefix(markdown);
    const session = `${prefix}-review-${input.ticket}-r${input.round}-${input.axis}-a${input.attempt}`;
    const tab = `review ${prefix} ${input.ticket} r${input.round} ${input.axis} a${input.attempt}`;
    const prompt = reviewPrompt(input, finalizationCycle);
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

const appendEvidenceLine = (markdown: string, line: string): string => {
  if (markdown.split(/\r?\n/u).includes(line)) return markdown;
  const heading = /^## Review evidence\s*$/mu.exec(markdown);
  if (heading === null) {
    const decisions = /^## Decisions\s*$/mu.exec(markdown);
    const insertion = decisions?.index ?? markdown.length;
    return `${markdown.slice(0, insertion).trimEnd()}\n\n## Review evidence\n\n${line}\n\n${markdown.slice(insertion).trimStart()}`;
  }
  const sectionStart = heading.index + heading[0].length;
  const next = /^## /gmu;
  next.lastIndex = sectionStart;
  const sectionEnd = next.exec(markdown)?.index ?? markdown.length;
  return `${markdown.slice(0, sectionEnd).trimEnd()}\n${line}\n\n${markdown.slice(sectionEnd).trimStart()}`;
};

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
    if (
      artifact.kind !== "coordinate-review-launch" ||
      artifact.schema_version !== 1 ||
      artifact.state_path !== input.statePath ||
      artifact.artifact_path !== input.artifactPath ||
      typeof artifact.report_path !== "string"
    ) {
      return yield* reviewError(
        "review.artifact_mismatch",
        "Reviewer launch artifact does not belong to this schema-1 run state or supplied path.",
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
    const statusAfter = worktreeStatus(artifact.worktree_path);
    const headAfter = worktreeHead(artifact.worktree_path);
    const contaminated =
      statusAfter !== artifact.status_before || headAfter !== artifact.reviewed_head;
    const parsed = input.report === undefined ? null : parseReviewReport(input.report);
    let status: ReviewLaunchRecordResult["status"];
    let verdict: ReviewLaunchRecordResult["verdict"] = null;
    let findings: ReviewFinding[] = [];
    let action: ReviewLaunchRecordResult["action"];
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
    return {
      ticket: artifact.ticket,
      round: artifact.round,
      axis: artifact.axis,
      attempt: artifact.attempt,
      status,
      verdict,
      action,
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
    yield* reviewIo(
      () => ensureRunLocalPath(input.statePath, input.evidencePath),
      "gate.evidence_path_failed",
      "Could not validate gate evidence path",
    );
    const markdown = yield* reviewIo(
      () => readFile(input.statePath, "utf8"),
      "gate.state_read_failed",
      "Could not read run state",
    );
    const policy = parsePolicy(markdown);
    const runtime = parseActiveTicket(markdown, input.ticket);
    const currentHead = worktreeHead(runtime.worktree);
    try {
      validateSerializedFinalization(markdown, input.ticket, currentHead, undefined);
    } catch (error) {
      return yield* error as ReviewError;
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
            },
            null,
            2,
          )}\n`,
        ),
      "gate.evidence_write_failed",
      "Could not persist gate evidence",
    );
    if (action === "fix") {
      yield* mutateStateFile(input.statePath, (state) =>
        Effect.try({
          try: () => ({
            markdown: applyFinalizationFix(state, {
              ticket: input.ticket,
              reviewedHead: head,
              completedAt: input.completedAt,
              phase: "gate fix required",
            }),
            result: undefined,
          }),
          catch: (error) =>
            error instanceof LandingError
              ? new ReviewError({ issue: error.issue })
              : reviewError(
                  "gate.finalization_failed",
                  `Could not advance serialized finalization: ${(error as Error).message}`,
                  "Repair finalization state and retry the immutable gate evidence.",
                ),
        }),
      ).pipe(Effect.mapError(fromMutationError));
    }
    return {
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
    };
  });

/**
 * Consolidated independent review round result.
 */
export type ReviewRoundFinalizeResult = {
  ticket: string;
  round: number;
  verdict: "PASS" | "FAIL";
  action: "land" | "fix" | "escalate";
  findings: Array<ReviewFinding & { axis: ReviewAxis }>;
  self_review_path: string;
  standards_report_path: string;
  spec_report_path: string;
  fix_request_path: string | null;
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
  const match = markdown.match(
    /^## Repository policy\s*\r?\n\r?\n```json\r?\n([\s\S]*?)\r?\n```\s*$/mu,
  );
  if (match === null) return "append";
  try {
    const value = JSON.parse(match[1]!) as {
      commit: { fixes: unknown | undefined } | undefined;
    };
    const fixes = value.commit?.fixes;
    return fixes === "amend" || fixes === "squash" ? fixes : "append";
  } catch {
    return "append";
  }
};

/**
 * Validates harness self-review and consolidates both accepted axes into one fix request.
 *
 * @param input - Both axis evidence files, self-review evidence, and round paths.
 * @returns A strict pass, fix, or explicit third-round escalation outcome.
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
    const action = verdict === "PASS" ? "land" : input.round >= 3 ? "escalate" : "fix";
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
      next_round: findings.length > 0 && input.round < 3 ? input.round + 1 : null,
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
          const withFinalization = applyFinalReviewOutcome(state, {
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
              withFinalization,
              `- Ticket ${input.ticket} round ${input.round} finalized: ${verdict}; self-review ${input.selfReviewPath}; Standards ${standards.report_path}; Spec ${spec.report_path}${findings.length > 0 ? `; fixes ${input.fixRequestPath}` : ""}`,
            ),
            result: undefined,
          };
        },
        catch: (error) =>
          error instanceof LandingError
            ? new ReviewError({ issue: error.issue })
            : reviewError(
                "review.finalization_failed",
                `Could not advance serialized finalization: ${(error as Error).message}`,
                "Repair finalization state and retry the same immutable review evidence.",
              ),
      }),
    ).pipe(Effect.mapError(fromMutationError));
    return result;
  });
