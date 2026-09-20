import { Data, Effect, Either } from "effect";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { activeRuntimeBlockPattern, parseActiveRuntimeFields } from "./active-runtime.ts";
import {
  buildHarnessLaunch,
  type ArgumentCommand,
  type HarnessLaunchPlan,
} from "./harness-launch.ts";
import { inspectHerdrWorker, type HerdrWorkerInspection } from "./herdr.ts";
import type {
  CliIssue,
  ImplementorLaunchPrepareInput,
  ImplementorLaunchRecoverInput,
  ImplementorLaunchRecordInput,
  RoleRecord,
} from "./contract.ts";
import { spawnGit } from "./git.ts";
import { validateRole } from "./roles.ts";
import { mutateStateFile, StateMutationError } from "./state-mutation.ts";
import { validateStateText } from "./state.ts";

/**
 * Portable Herdr start and prompt commands for one implementor.
 */
export type ImplementorLaunchPlan = HarnessLaunchPlan;

/**
 * Successful launch preparation result.
 */
export type ImplementorLaunchPrepareResult = {
  recovered: boolean;
  artifact_path: string;
  launch: ImplementorLaunchPlan;
};

/**
 * Validated prompt-only continuation for one compatible exhausted launch.
 */
export type ImplementorLaunchRecoverResult = {
  ticket: string;
  attempt: number;
  recovered: boolean;
  status: "working";
  phase: "working";
  prompt: ArgumentCommand;
  worker: HerdrWorkerInspection;
  recovery: {
    user_authorized: true;
    cause: "coordinator compatibility defect";
    diagnostic: string;
    recovered_at: string;
  };
};

/**
 * Persisted launch outcome returned to the coordinator.
 */
export type ImplementorLaunchRecordResult = {
  ticket: string;
  attempt: number;
  status: "started" | "failed";
  phase: "working" | "launch failed";
  diagnostic: {
    stage: string;
    exit_code: number;
    stderr: string;
  } | null;
};

/**
 * Typed implementor launch or state failure returned through the CLI.
 */
export class ImplementorError extends Data.TaggedError("ImplementorError")<{
  issue: CliIssue;
}> {}

const implementorError = (code: string, message: string, remediation: string): ImplementorError =>
  new ImplementorError({ issue: { code, message, remediation } });

const fromMutationError = (error: unknown): ImplementorError => {
  if (error instanceof ImplementorError) return error;
  const detail = error instanceof StateMutationError ? error.message : (error as Error).message;
  return implementorError(
    error instanceof StateMutationError && error.kind === "lock_busy"
      ? "implementor.state_busy"
      : "implementor.state_io_failed",
    `Could not update implementor runtime state: ${detail}`,
    "Verify RESUME.md and its directory are writable, then retry with the same bound role.",
  );
};

const sameRole = (left: RoleRecord, right: RoleRecord): boolean =>
  left.harness === right.harness && left.model === right.model && left.effort === right.effort;

const parsePersistedImplementor = (markdown: string): RoleRecord => {
  const matches = [...markdown.matchAll(/^Implementor:\r?\n((?:  [^\r\n]*(?:\r?\n|$))+)/gmu)];
  if (matches.length !== 1) {
    throw implementorError(
      "state.implementor_role_malformed",
      "RESUME.md must contain exactly one complete `Implementor:` role block.",
      "Repair the schema-1 Implementor harness, model, and effort before launching.",
    );
  }
  const fields: Record<string, string> = {};
  for (const line of matches[0]![1]!.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    const field = line.match(/^  ([a-z]+):\s*(.*)$/u);
    if (field === null || field[2]!.length === 0 || fields[field[1]!] !== undefined) {
      throw implementorError(
        "state.implementor_role_malformed",
        "RESUME.md has malformed or duplicate fields in its `Implementor:` role block.",
        "Repair the schema-1 Implementor harness, model, and effort before launching.",
      );
    }
    fields[field[1]!] = field[2]!;
  }
  const harness = fields.harness;
  const model = fields.model;
  const effort = fields.effort;
  if ((harness !== "claude" && harness !== "pi") || model === undefined || effort === undefined) {
    throw implementorError(
      "state.implementor_role_malformed",
      "RESUME.md has an incomplete or malformed `Implementor:` role block.",
      "Repair the schema-1 Implementor harness, model, and effort before launching.",
    );
  }
  return { harness, model, effort };
};

const validatePersistedState = (
  path: string,
  markdown: string,
): Effect.Effect<void, ImplementorError> =>
  validateStateText(path, markdown).pipe(
    Effect.mapError((error) => new ImplementorError({ issue: error.issue })),
    Effect.asVoid,
  );

const tableSection = (markdown: string): { start: number; end: number; text: string } => {
  const heading = /^## Tickets\s*$/mu.exec(markdown);
  if (heading === null) {
    throw implementorError(
      "state.tickets_missing",
      "RESUME.md has no `## Tickets` section.",
      "Repair the schema-1 ticket table before launching an implementor.",
    );
  }
  const start = heading.index + heading[0].length;
  const next = /^## /gmu;
  next.lastIndex = start;
  const end = next.exec(markdown)?.index ?? markdown.length;
  return { start, end, text: markdown.slice(start, end) };
};

const updateTicketRow = (
  markdown: string,
  ticket: string,
  updates: Record<string, string>,
): string => {
  const section = tableSection(markdown);
  const lines = section.text.split(/\r?\n/u);
  const headerIndex = lines.findIndex((line) => line.trimStart().startsWith("| NN"));
  if (headerIndex < 0) {
    throw implementorError(
      "state.ticket_table_malformed",
      "RESUME.md ticket table has no `NN` header row.",
      "Repair the schema-1 ticket table before launching an implementor.",
    );
  }
  const columns = lines[headerIndex]!.split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
  const rowIndex = lines.findIndex((line) => {
    const first = line.split("|")[1]?.trim();
    return first === ticket;
  });
  if (rowIndex < 0) {
    throw implementorError(
      "state.ticket_missing",
      `RESUME.md has no ticket row for \`${ticket}\`.`,
      "Add the normalized ticket to state before preparing its launch.",
    );
  }
  const cells = lines[rowIndex]!.split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
  if (cells.length !== columns.length) {
    throw implementorError(
      "state.ticket_table_malformed",
      `Ticket \`${ticket}\` does not match the ticket table columns.`,
      "Repair the schema-1 ticket row before launching an implementor.",
    );
  }
  for (const [column, value] of Object.entries(updates)) {
    const index = columns.indexOf(column);
    if (index < 0) {
      throw implementorError(
        "state.ticket_table_malformed",
        `Ticket table is missing required \`${column}\` column.`,
        "Repair the schema-1 ticket table before launching an implementor.",
      );
    }
    cells[index] = value;
  }
  const skillsIndex = columns.indexOf("skills");
  if (skillsIndex >= 0) cells[skillsIndex] = "implement";
  lines[rowIndex] = `| ${cells.join(" | ")} |`;
  return `${markdown.slice(0, section.start)}${lines.join("\n")}${markdown.slice(section.end)}`;
};

const ticketField = (markdown: string, ticket: string, column: string): string => {
  const section = tableSection(markdown);
  const lines = section.text.split(/\r?\n/u);
  const header = lines.find((line) => line.trimStart().startsWith("| NN"));
  const row = lines.find((line) => line.split("|")[1]?.trim() === ticket);
  if (header === undefined || row === undefined) {
    throw implementorError(
      "state.ticket_table_malformed",
      `Ticket \`${ticket}\` is missing from the ticket table.`,
      "Repair the schema-1 ticket table before recovering an implementor.",
    );
  }
  const columns = header
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
  const cells = row
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
  const index = columns.indexOf(column);
  if (index < 0 || cells.length !== columns.length) {
    throw implementorError(
      "state.ticket_table_malformed",
      `Ticket \`${ticket}\` does not have a valid \`${column}\` field.`,
      "Repair the schema-1 ticket table before recovering an implementor.",
    );
  }
  return cells[index]!;
};

const parseTicketRole = (markdown: string, ticket: string): RoleRecord | null => {
  updateTicketRow(markdown, ticket, {});
  const harness = ticketField(markdown, ticket, "harness");
  const model = ticketField(markdown, ticket, "model");
  const effort = ticketField(markdown, ticket, "effort");
  if (harness === "-" && model === "-" && effort === "-") return null;
  if (
    (harness !== "claude" && harness !== "pi") ||
    model === "-" ||
    model.length === 0 ||
    effort === "-" ||
    effort.length === 0
  ) {
    throw implementorError(
      "state.ticket_role_malformed",
      `Ticket \`${ticket}\` has an incomplete bound Implementor role.`,
      "Repair the ticket row from its immutable launch or escalation evidence before launching.",
    );
  }
  return { harness, model, effort };
};

const serializeActiveRole = (role: RoleRecord): string =>
  JSON.stringify({ harness: role.harness, model: role.model, effort: role.effort });

const renderActiveBlock = (
  input: ImplementorLaunchPrepareInput,
  phase: string,
  diagnostic: string,
): string =>
  [
    `### ${input.ticket}`,
    "",
    `Worktree: ${input.worktreePath}`,
    `Branch: ${input.branch}`,
    `Implementor: ${serializeActiveRole(input.role)}`,
    `Implement skill: ${input.implementSkillPath ?? "/implement"}`,
    `Session: ${input.session}`,
    `Tab: ${input.tab}`,
    `Pane: ${input.pane}`,
    `Artifact: ${input.artifactPath}`,
    `Attempt: ${input.attempt}`,
    `Retry: ${input.attempt - 1} of ${input.maxAttempts}`,
    `Phase: ${phase}`,
    `Last diagnostic: ${diagnostic}`,
    "",
  ].join("\n");

const upsertActiveBlock = (
  markdown: string,
  ticket: string,
  rendered: string,
): { markdown: string; recovered: boolean } => {
  const pattern = activeRuntimeBlockPattern(ticket);
  const existing = markdown.match(pattern)?.[0];
  if (existing !== undefined) {
    const recovered = existing.trimEnd() === rendered.trimEnd();
    return {
      markdown: recovered ? markdown : markdown.replace(pattern, rendered),
      recovered,
    };
  }
  const heading = /^## Active tickets\s*$/mu.exec(markdown);
  if (heading === null) {
    throw implementorError(
      "state.active_tickets_missing",
      "RESUME.md has no `## Active tickets` section.",
      "Repair the schema-1 state template before launching an implementor.",
    );
  }
  const insertion = heading.index + heading[0].length;
  return {
    markdown: `${markdown.slice(0, insertion)}\n\n${rendered}${markdown.slice(insertion).replace(/^\s*/u, "\n")}`,
    recovered: false,
  };
};

const buildLaunchPlan = (input: ImplementorLaunchPrepareInput): ImplementorLaunchPlan =>
  buildHarnessLaunch({
    role: input.role,
    session: input.session,
    pane: input.pane,
    prompt: `${input.role.harness === "pi" ? "/skill:implement" : "/implement"} ${input.prompt}`,
    skillPath: input.implementSkillPath,
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

const ensurePathInsideState = (
  statePath: string,
  artifactPath: string,
): Effect.Effect<void, ImplementorError> =>
  Effect.tryPromise({
    try: async () => {
      const runRoot = await realpath(dirname(statePath));
      const artifact = await canonicalPathAllowingMissing(artifactPath);
      const relation = relative(runRoot, artifact);
      if (
        relation === "" ||
        relation === ".." ||
        relation.startsWith(`..${sep}`) ||
        isAbsolute(relation)
      ) {
        throw implementorError(
          "implementor.artifact_outside_run",
          "Launch artifact_path must resolve inside the run directory containing RESUME.md.",
          "Choose a run-local artifact path such as briefs/launch-NN.json.",
        );
      }
    },
    catch: (error) =>
      error instanceof ImplementorError
        ? error
        : implementorError(
            "implementor.artifact_path_failed",
            `Could not resolve launch artifact containment: ${(error as Error).message}`,
            "Verify the run directory and artifact parent are readable, then retry.",
          ),
  });

const verifyWorktree = (
  worktreePath: string,
  branch: string,
): Effect.Effect<void, ImplementorError> =>
  Effect.gen(function* () {
    const root = spawnGit(["rev-parse", "--show-toplevel"], { cwd: worktreePath });
    const current = spawnGit(["symbolic-ref", "--short", "HEAD"], { cwd: worktreePath });
    if (
      root.exitCode !== 0 ||
      current.exitCode !== 0 ||
      realpathSync(root.stdout.trim()) !== realpathSync(worktreePath) ||
      current.stdout.trim() !== branch
    ) {
      return yield* implementorError(
        "implementor.worktree_mismatch",
        `Worktree \`${worktreePath}\` is not the expected branch \`${branch}\`.`,
        "Recover the policy-created worktree and recorded branch before launching.",
      );
    }
  });

const writeArtifact = (
  input: ImplementorLaunchPrepareInput,
  plan: ImplementorLaunchPlan,
): Effect.Effect<boolean, ImplementorError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(input.artifactPath), { recursive: true });
      const temporary = `${input.artifactPath}.${process.pid}.${randomUUID()}.tmp`;
      const artifact = {
        schema_version: 1,
        ticket: input.ticket,
        cwd: input.worktreePath,
        branch: input.branch,
        role: input.role,
        implement_skill_path: input.implementSkillPath ?? null,
        session: input.session,
        tab: input.tab,
        pane: input.pane,
        attempt: input.attempt,
        max_attempts: input.maxAttempts,
        launch: plan,
      };
      const rendered = `${JSON.stringify(artifact, null, 2)}\n`;
      const existing = await readFile(input.artifactPath, "utf8").catch(() => null);
      if (existing !== null && existing !== rendered) {
        throw implementorError(
          "implementor.artifact_conflict",
          `Launch artifact \`${input.artifactPath}\` already contains a different launch.`,
          "Keep the existing provenance and choose a new run-local artifact path for a new attempt.",
        );
      }
      if (existing === rendered) return false;
      await writeFile(temporary, rendered, { mode: 0o600 });
      await rename(temporary, input.artifactPath);
      return true;
    },
    catch: (error) =>
      error instanceof ImplementorError
        ? error
        : implementorError(
            "implementor.artifact_write_failed",
            `Could not write launch artifact: ${(error as Error).message}`,
            "Choose a writable run-local artifact path and retry with the same role.",
          ),
  });

const roleFromUnknown = (value: unknown): RoleRecord | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const role = value as Record<string, unknown>;
  if (Object.keys(role).toSorted().join(",") !== "effort,harness,model") return null;
  const { harness, model, effort } = role;
  if (
    (harness !== "claude" && harness !== "pi") ||
    typeof model !== "string" ||
    model.length === 0 ||
    model.includes("\n") ||
    typeof effort !== "string" ||
    effort.length === 0 ||
    effort.includes("\n")
  ) {
    return null;
  }
  return { harness, model, effort };
};

const roleFromActive = (fields: Record<string, string>): RoleRecord | null => {
  const serialized = fields.Implementor;
  if (serialized === undefined) return null;
  try {
    const parsed = JSON.parse(serialized) as unknown;
    return roleFromUnknown(parsed);
  } catch {
    return null;
  }
};

/**
 * Validates the bound role and worktree, writes an argv artifact, and records launch provenance.
 *
 * @param input - Ticket, role, runtime identifiers, prompt, and retry bounds.
 * @returns An Effect containing shell-free Herdr commands and recovery status.
 */
export const prepareImplementorLaunch = (
  input: ImplementorLaunchPrepareInput,
): Effect.Effect<ImplementorLaunchPrepareResult, ImplementorError> =>
  Effect.gen(function* () {
    yield* ensurePathInsideState(input.statePath, input.artifactPath);
    yield* verifyWorktree(input.worktreePath, input.branch);
    if (input.role.harness === "pi") {
      const skill = yield* Effect.tryPromise({
        try: () => stat(input.implementSkillPath!),
        catch: () =>
          implementorError(
            "implementor.skill_missing",
            `Pi implement skill path \`${input.implementSkillPath}\` is unavailable.`,
            "Install the required implement skill and retry without removing or substituting it.",
          ),
      });
      if (!skill.isFile()) {
        return yield* implementorError(
          "implementor.skill_missing",
          `Pi implement skill path \`${input.implementSkillPath}\` is not a file.`,
          "Pass the installed implement SKILL.md path.",
        );
      }
    }
    const validation = yield* validateRole({
      role: "implementor",
      triple: undefined,
      record: input.role,
    });
    if (validation.result === null) {
      return yield* new ImplementorError({ issue: validation.errors[0]! });
    }
    if (!sameRole(validation.result.record, input.role)) {
      return yield* implementorError(
        "implementor.role_changed",
        "Role validation changed the requested implementor record.",
        "Persist and launch only the exact validated role; no substitution is allowed.",
      );
    }

    const plan = buildLaunchPlan(input);
    let artifactCreated = false;
    const mutation = mutateStateFile(input.statePath, (markdown) =>
      Effect.gen(function* () {
        yield* validatePersistedState(input.statePath, markdown);
        const expectedRole = yield* Effect.try({
          try: () => parseTicketRole(markdown, input.ticket) ?? parsePersistedImplementor(markdown),
          catch: fromMutationError,
        });
        if (!sameRole(expectedRole, input.role)) {
          return yield* implementorError(
            "implementor.role_mismatch",
            "Requested implementor role does not match the ticket-bound or run-default Implementor role.",
            "Launch an already bound ticket with its exact row role. Only a helper-recorded review escalation may replace that per-ticket binding.",
          );
        }
        const existingBlock = markdown.match(activeRuntimeBlockPattern(input.ticket))?.[0];
        if (existingBlock !== undefined) {
          const fields = parseActiveRuntimeFields(existingBlock);
          const existingRole = roleFromActive(fields);
          const existingAttempt = Number(fields.Attempt);
          const requiredSkill = input.implementSkillPath ?? "/implement";
          const sameAttempt = existingAttempt === input.attempt;
          const nextFailedAttempt =
            (fields.Phase === "launch failed" || fields.Phase === "retry waiting") &&
            existingAttempt + 1 === input.attempt;
          const sameRuntime =
            fields.Session === input.session &&
            fields.Tab === input.tab &&
            fields.Pane === input.pane &&
            fields.Artifact === input.artifactPath;
          if (
            existingRole === null ||
            !sameRole(existingRole, input.role) ||
            fields.Worktree !== input.worktreePath ||
            fields.Branch !== input.branch ||
            fields["Implement skill"] !== requiredSkill ||
            fields.Session !== input.session ||
            fields.Tab !== input.tab ||
            (!sameAttempt && !nextFailedAttempt) ||
            (sameAttempt && !sameRuntime) ||
            (sameAttempt && fields.Phase === "launch failed")
          ) {
            return yield* implementorError(
              "implementor.runtime_conflict",
              `Ticket \`${input.ticket}\` already has a different or completed active launch attempt.`,
              "Recover the recorded runtime or start the next retry without changing its bound role, worktree, or required skill.",
            );
          }
        }
        const update = yield* Effect.try({
          try: () => {
            const withRow = updateTicketRow(markdown, input.ticket, {
              harness: input.role.harness,
              model: input.role.model,
              effort: input.role.effort,
              status: "working",
            });
            const rendered = renderActiveBlock(input, "launch prepared", "none");
            const updated = upsertActiveBlock(withRow, input.ticket, rendered);
            return { markdown: updated.markdown, result: updated.recovered };
          },
          catch: fromMutationError,
        });
        artifactCreated = yield* writeArtifact(input, plan);
        return update;
      }),
    ).pipe(Effect.mapError(fromMutationError));
    const outcome = yield* Effect.either(mutation);
    if (Either.isLeft(outcome)) {
      if (artifactCreated) {
        yield* Effect.tryPromise({
          try: () => rm(input.artifactPath, { force: true }),
          catch: (error) =>
            implementorError(
              "implementor.artifact_rollback_failed",
              `Launch state failed and the new artifact could not be removed: ${(error as Error).message}`,
              "Remove the unreferenced launch artifact manually before retrying.",
            ),
        });
      }
      return yield* outcome.left;
    }
    return { recovered: outcome.right, artifact_path: input.artifactPath, launch: plan };
  });

type RecoveryArtifact = {
  ticket: string;
  worktreePath: string;
  branch: string;
  role: RoleRecord;
  implementSkillPath: string | null;
  session: string;
  tab: string;
  pane: string;
  attempt: number;
  maxAttempts: number;
  prompt: ArgumentCommand;
};

const parsePromptCommand = (value: unknown, session: string): ArgumentCommand | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const command = value as Record<string, unknown>;
  const args = command.args;
  if (
    command.command !== "herdr" ||
    !Array.isArray(args) ||
    args.some((argument) => typeof argument !== "string")
  ) {
    return null;
  }
  const strings = args as string[];
  if (
    strings.length === 7 &&
    strings[0] === "agent" &&
    strings[1] === "prompt" &&
    strings[2] === session &&
    strings[3]!.length > 0 &&
    strings[4] === "--wait" &&
    strings[5] === "--timeout" &&
    strings[6] === "300000"
  ) {
    return { command: "herdr", args: strings };
  }
  if (
    strings.length === 10 &&
    strings[0] === "agent" &&
    strings[1] === "prompt" &&
    strings[2] === "--wait" &&
    strings[3] === "--until" &&
    strings[4] === "working" &&
    strings[5] === "--timeout" &&
    strings[6] === "300000" &&
    strings[7] === "--" &&
    strings[8] === session &&
    strings[9]!.length > 0
  ) {
    return {
      command: "herdr",
      args: ["agent", "prompt", session, strings[9]!, "--wait", "--timeout", "300000"],
    };
  }
  return null;
};

const readRecoveryArtifact = (path: string): Effect.Effect<RecoveryArtifact, ImplementorError> =>
  Effect.tryPromise({
    try: async () => {
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
      const artifact = parsed as Record<string, unknown>;
      const role = roleFromUnknown(artifact.role);
      const launch = artifact.launch;
      const prompt =
        typeof launch === "object" && launch !== null && !Array.isArray(launch)
          ? parsePromptCommand((launch as Record<string, unknown>).prompt, String(artifact.session))
          : null;
      if (
        artifact.schema_version !== 1 ||
        typeof artifact.ticket !== "string" ||
        typeof artifact.cwd !== "string" ||
        typeof artifact.branch !== "string" ||
        role === null ||
        (typeof artifact.implement_skill_path !== "string" &&
          artifact.implement_skill_path !== null) ||
        typeof artifact.session !== "string" ||
        typeof artifact.tab !== "string" ||
        typeof artifact.pane !== "string" ||
        typeof artifact.attempt !== "number" ||
        typeof artifact.max_attempts !== "number" ||
        prompt === null
      ) {
        throw new Error();
      }
      return {
        ticket: artifact.ticket,
        worktreePath: artifact.cwd,
        branch: artifact.branch,
        role,
        implementSkillPath: artifact.implement_skill_path,
        session: artifact.session,
        tab: artifact.tab,
        pane: artifact.pane,
        attempt: artifact.attempt,
        maxAttempts: artifact.max_attempts,
        prompt,
      };
    },
    catch: () =>
      implementorError(
        "implementor.recovery_artifact_invalid",
        `Launch artifact \`${path}\` is missing or malformed for compatibility recovery.`,
        "Preserve and repair the immutable attempt-4 artifact before recovering the existing worker.",
      ),
  });

const recoveryFields = (input: ImplementorLaunchRecoverInput): Record<string, string> => ({
  "Recovery authorization": "user",
  "Recovery cause": "coordinator compatibility defect",
  "Recovery diagnostic": input.diagnostic,
  "Recovered at": input.recoveredAt,
});

/**
 * Recovers an exhausted launch only when its exact idle Herdr worker and immutable binding survive.
 *
 * @param input - Authorized compatibility diagnostic and Herdr inspection boundary.
 * @returns An Effect containing the existing worker's prompt-only continuation command.
 */
export const recoverImplementorLaunch = (
  input: ImplementorLaunchRecoverInput,
): Effect.Effect<ImplementorLaunchRecoverResult, ImplementorError> =>
  mutateStateFile(input.statePath, (markdown) =>
    Effect.gen(function* () {
      yield* validatePersistedState(input.statePath, markdown);
      const pattern = activeRuntimeBlockPattern(input.ticket);
      const active = markdown.match(pattern)?.[0];
      if (active === undefined) {
        return yield* implementorError(
          "implementor.runtime_missing",
          `Ticket \`${input.ticket}\` has no exhausted active runtime to recover.`,
          "Recover only a preserved attempt-4 runtime with its existing worker still alive.",
        );
      }
      const fields = parseActiveRuntimeFields(active);
      const requestedRecovery = recoveryFields(input);
      const status = yield* Effect.try({
        try: () => ticketField(markdown, input.ticket, "status"),
        catch: fromMutationError,
      });
      const alreadyRecovered =
        status === "working" &&
        fields.Phase === "working" &&
        Object.entries(requestedRecovery).every(([name, value]) => fields[name] === value);
      if (
        !alreadyRecovered &&
        (status !== "blocked" ||
          fields.Phase !== "retry exhausted" ||
          fields.Attempt !== "4" ||
          fields.Retry !== "3 of 3")
      ) {
        return yield* implementorError(
          "implementor.recovery_not_exhausted",
          `Ticket \`${input.ticket}\` is not an exhausted attempt-4 launch eligible for compatibility recovery.`,
          "Use the normal prepare, record, and retry operations unless the durable launch is blocked at retry 3 of 3.",
        );
      }
      const activeRole = roleFromActive(fields);
      const ticketRole = yield* Effect.try({
        try: () =>
          roleFromUnknown({
            harness: ticketField(markdown, input.ticket, "harness"),
            model: ticketField(markdown, input.ticket, "model"),
            effort: ticketField(markdown, input.ticket, "effort"),
          }),
        catch: fromMutationError,
      });
      const worktreePath = fields.Worktree;
      const branch = fields.Branch;
      const session = fields.Session;
      const tab = fields.Tab;
      const pane = fields.Pane;
      const artifactPath = fields.Artifact;
      const implementSkillPath = fields["Implement skill"];
      if (
        activeRole === null ||
        ticketRole === null ||
        !sameRole(activeRole, ticketRole) ||
        worktreePath === undefined ||
        branch === undefined ||
        session === undefined ||
        tab === undefined ||
        pane === undefined ||
        artifactPath === undefined ||
        implementSkillPath === undefined
      ) {
        return yield* implementorError(
          "implementor.recovery_binding_invalid",
          `Ticket \`${input.ticket}\` has an incomplete or changed exhausted runtime binding.`,
          "Restore the exact role, worktree, branch, session, tab, pane, skill, and artifact provenance before recovery.",
        );
      }
      yield* ensurePathInsideState(input.statePath, artifactPath);
      yield* verifyWorktree(worktreePath, branch);
      const artifact = yield* readRecoveryArtifact(artifactPath);
      const expectedSkill = activeRole.harness === "pi" ? implementSkillPath : null;
      if (
        artifact.ticket !== input.ticket ||
        artifact.worktreePath !== worktreePath ||
        artifact.branch !== branch ||
        !sameRole(artifact.role, activeRole) ||
        artifact.implementSkillPath !== expectedSkill ||
        artifact.session !== session ||
        artifact.tab !== tab ||
        artifact.pane !== pane ||
        artifact.attempt !== 4 ||
        artifact.maxAttempts !== 3 ||
        !artifact.prompt.args[3]!.startsWith(
          `${activeRole.harness === "pi" ? "/skill:implement" : "/implement"} `,
        )
      ) {
        return yield* implementorError(
          "implementor.recovery_binding_mismatch",
          `Ticket \`${input.ticket}\` does not match its immutable attempt-4 launch artifact.`,
          "Restore the exact exhausted runtime and artifact binding; do not substitute launch provenance.",
        );
      }
      const worker = yield* inspectHerdrWorker({
        socketPath: input.socketPath,
        timeoutMs: input.timeoutMs,
        session,
        paneId: pane,
      }).pipe(Effect.mapError((error) => new ImplementorError({ issue: error.issue })));
      if (worker.status !== "idle" && worker.status !== "done") {
        return yield* implementorError(
          "implementor.recovery_worker_not_ready",
          `Worker \`${session}\` is \`${worker.status}\`, not idle or done.`,
          "Recover only the existing ready worker that never received its implementation prompt.",
        );
      }
      if (alreadyRecovered) {
        return {
          markdown,
          result: {
            ticket: input.ticket,
            attempt: 4,
            recovered: true,
            status: "working" as const,
            phase: "working" as const,
            prompt: artifact.prompt,
            worker,
            recovery: {
              user_authorized: input.userAuthorized,
              cause: "coordinator compatibility defect" as const,
              diagnostic: input.diagnostic,
              recovered_at: input.recoveredAt,
            },
          },
        };
      }
      const recoveryLines = Object.entries(requestedRecovery)
        .map(([name, value]) => `${name}: ${value}`)
        .join("\n");
      const updatedBlock = active
        .replace(/^Phase: .*$/mu, "Phase: working")
        .replace(/^Last diagnostic: .*$/mu, (line) => `${line}\n${recoveryLines}`);
      const withRow = updateTicketRow(markdown, input.ticket, { status: "working" });
      return {
        markdown: withRow.replace(pattern, updatedBlock),
        result: {
          ticket: input.ticket,
          attempt: 4,
          recovered: false,
          status: "working" as const,
          phase: "working" as const,
          prompt: artifact.prompt,
          worker,
          recovery: {
            user_authorized: input.userAuthorized,
            cause: "coordinator compatibility defect" as const,
            diagnostic: input.diagnostic,
            recovered_at: input.recoveredAt,
          },
        },
      };
    }),
  ).pipe(Effect.mapError(fromMutationError));

const updateActiveOutcome = (
  block: string,
  input: ImplementorLaunchRecordInput,
): { block: string } => {
  const fields = parseActiveRuntimeFields(block);
  if (fields.Attempt !== String(input.attempt)) {
    throw implementorError(
      "implementor.attempt_stale",
      `Launch attempt ${input.attempt} does not match the active runtime attempt.`,
      "Re-read RESUME.md and record only the currently prepared attempt.",
    );
  }
  if (fields.Phase !== "launch prepared" && fields.Phase !== "working") {
    throw implementorError(
      "implementor.outcome_not_recordable",
      `Launch attempt ${input.attempt} is in terminal or retry phase \`${fields.Phase ?? "missing"}\`.`,
      "Use the explicit compatibility recovery operation before recording an exhausted launch.",
    );
  }
  const retry = fields.Retry?.match(/^(\d+) of (\d+)$/u);
  if (retry === null || retry === undefined) {
    throw implementorError(
      "implementor.retry_malformed",
      "Active runtime has a malformed Retry field.",
      "Repair the retry count before recording the launch outcome.",
    );
  }
  const phase = input.status === "started" ? "working" : "launch failed";
  const diagnostic =
    input.diagnostic === undefined
      ? "none"
      : `${input.diagnostic.stage} exited ${input.diagnostic.exitCode}: ${input.diagnostic.stderr.replace(/\s+/gu, " ").trim()}`;
  const updated = block
    .replace(/^Phase: .*$/mu, `Phase: ${phase}`)
    .replace(/^Last diagnostic: .*$/mu, `Last diagnostic: ${diagnostic}`);
  return { block: updated };
};

/**
 * Persists the observed start or failure of one prepared implementor launch.
 *
 * @param input - Ticket attempt, terminal preparation outcome, and exact failure diagnostic.
 * @returns An Effect containing the truthful persisted launch status.
 */
export const recordImplementorLaunch = (
  input: ImplementorLaunchRecordInput,
): Effect.Effect<ImplementorLaunchRecordResult, ImplementorError> =>
  mutateStateFile(input.statePath, (markdown) =>
    Effect.gen(function* () {
      yield* validatePersistedState(input.statePath, markdown);
      const pattern = activeRuntimeBlockPattern(input.ticket);
      const active = markdown.match(pattern)?.[0];
      if (active === undefined) {
        return yield* implementorError(
          "implementor.runtime_missing",
          `Ticket \`${input.ticket}\` has no prepared active runtime.`,
          "Prepare or recover the launch artifact before recording its outcome.",
        );
      }
      return yield* Effect.try({
        try: () => {
          const updated = updateActiveOutcome(active, input);
          const status = "working";
          const withRow = updateTicketRow(markdown, input.ticket, { status });
          const next = withRow.replace(pattern, updated.block);
          const phase: ImplementorLaunchRecordResult["phase"] =
            input.status === "started" ? "working" : "launch failed";
          return {
            markdown: next,
            result: {
              ticket: input.ticket,
              attempt: input.attempt,
              status: input.status,
              phase,
              diagnostic:
                input.diagnostic === undefined
                  ? null
                  : {
                      stage: input.diagnostic.stage,
                      exit_code: input.diagnostic.exitCode,
                      stderr: input.diagnostic.stderr,
                    },
            },
          };
        },
        catch: fromMutationError,
      });
    }),
  ).pipe(Effect.mapError(fromMutationError));
