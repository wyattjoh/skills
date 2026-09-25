import { Data, Effect, Result } from "effect";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
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
  ImplementorRuntimeBinding,
  ImplementorRuntimeMigrateInput,
  ImplementorRuntimeMigrationRecoverInput,
  ImplementorLaunchRecordInput,
  RoleRecord,
} from "./contract.ts";
import { spawnGit } from "./git.ts";
import { IntegrationError, parseIntegration, type IntegrationRecord } from "./integration.ts";
import { validateRole } from "./roles.ts";
import { inspectRuntimeClose } from "./runtime-close.ts";
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

const isRoleRecord = (value: unknown): value is RoleRecord =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  ((value as Record<string, unknown>).harness === "claude" ||
    (value as Record<string, unknown>).harness === "pi") &&
  typeof (value as Record<string, unknown>).model === "string" &&
  typeof (value as Record<string, unknown>).effort === "string";

const sameRole = (left: RoleRecord, right: RoleRecord): boolean =>
  left.harness === right.harness && left.model === right.model && left.effort === right.effort;

const parsePersistedImplementor = (markdown: string): RoleRecord => {
  const matches = [...markdown.matchAll(/^Implementor:\r?\n((?:  [^\r\n]*(?:\r?\n|$))+)/gmu)];
  if (matches.length !== 1) {
    throw implementorError(
      "state.implementor_role_malformed",
      "RESUME.md must contain exactly one complete `Implementor:` role block.",
      "Repair the schema-2 Implementor harness, model, and effort before launching.",
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
        "Repair the schema-2 Implementor harness, model, and effort before launching.",
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
      "Repair the schema-2 Implementor harness, model, and effort before launching.",
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
      "Repair the schema-2 ticket table before launching an implementor.",
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
      "Repair the schema-2 ticket table before launching an implementor.",
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
      "Repair the schema-2 ticket row before launching an implementor.",
    );
  }
  for (const [column, value] of Object.entries(updates)) {
    const index = columns.indexOf(column);
    if (index < 0) {
      throw implementorError(
        "state.ticket_table_malformed",
        `Ticket table is missing required \`${column}\` column.`,
        "Repair the schema-2 ticket table before launching an implementor.",
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
      "Repair the schema-2 ticket table before recovering an implementor.",
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
      "Repair the schema-2 ticket table before recovering an implementor.",
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
      "Repair the ticket row from its immutable launch or migration evidence before launching.",
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
      "Repair the schema-2 state template before launching an implementor.",
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
            "Launch an already bound ticket with its exact row role. Only an authorized implementor.runtime.migrate may replace that per-ticket binding.",
          );
        }
        const migration = yield* readCommittedMigrationEvidence(
          input.statePath,
          input.ticket,
          markdown,
        );
        const existingBlock = markdown.match(activeRuntimeBlockPattern(input.ticket))?.[0];
        if (migration !== null) {
          if (
            !sameRole(migration.replacement_role, input.role) ||
            migration.old_binding.worktreePath !== input.worktreePath ||
            migration.old_binding.branch !== input.branch
          ) {
            return yield* implementorError(
              "implementor.migration_launch_binding_mismatch",
              "Replacement launch does not use the persisted Pi role, worktree, and branch captured by migration evidence.",
              "Prepare the new runtime only in the exact preserved worktree and branch from the committed migration record.",
            );
          }
          if (existingBlock === undefined) {
            const snapshot = yield* captureMigrationWorktreeSnapshot(input.worktreePath);
            if (JSON.stringify(snapshot) !== JSON.stringify(migration.worktree_snapshot)) {
              return yield* implementorError(
                "implementor.migration_worktree_changed",
                "Preserved worktree contents changed after migration and before replacement launch.",
                "Restore the exact migrated worktree snapshot or reconcile the ticket manually; do not discard untracked files.",
              );
            }
          }
          if (migration.old_binding.phase === "gates") {
            const evidencePath = resolve(
              dirname(input.statePath),
              "briefs",
              `implementor-runtime-migration-${input.ticket}.json`,
            );
            const recoveryReference = `ticket ${input.ticket} implementor migration recovery; evidence ${relative(dirname(input.statePath), evidencePath)}`;
            const recoveryRecorded = markdown
              .split(/\r?\n/u)
              .some((line) => line.includes(recoveryReference));
            if (!recoveryRecorded) {
              return yield* implementorError(
                "implementor.migration_recovery_required",
                "Gates-phase migration requires its explicit recovery transition before replacement launch or further gates.",
                "Call implementor.runtime.migration.recover, prepare the same bound runtime, then complete landing.rebase.check before gates or reviews.",
              );
            }
          }
        }
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
            const carried = migration === null ? null : carriedIntegration(migration);
            const rendered =
              carried === null
                ? renderActiveBlock(input, "launch prepared", "none")
                : `${renderActiveBlock(input, "launch prepared", "none").trimEnd()}\nIntegration: ${JSON.stringify(carried)}\n`;
            const updated = upsertActiveBlock(withRow, input.ticket, rendered);
            return { markdown: updated.markdown, result: updated.recovered };
          },
          catch: fromMutationError,
        });
        artifactCreated = yield* writeArtifact(input, plan);
        return update;
      }),
    ).pipe(Effect.mapError(fromMutationError));
    const outcome = yield* Effect.result(mutation);
    if (Result.isFailure(outcome)) {
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
      return yield* outcome.failure;
    }
    return { recovered: outcome.success, artifact_path: input.artifactPath, launch: plan };
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

/**
 * Result of replacing one closed Claude implementor with the persisted Pi default.
 */
export type ImplementorRuntimeMigrateResult = {
  ticket: string;
  action: "prepare-replacement";
  recovered: boolean;
  runtime_closed: true;
  pane_id: string;
  worktree_path: string;
  branch: string;
  old_role: RoleRecord;
  replacement_role: RoleRecord;
  evidence_path: string;
  dirty_worktree_preserved: boolean;
  integration_preserved: boolean;
};

export type ImplementorRuntimeMigrationRecoverResult = {
  ticket: string;
  action: "prepare-and-check-rebase";
  phase: "rebase-required";
  recovered: boolean;
  head: string;
  evidence_path: string;
};

type MigrationWorktreeSnapshot = {
  head: string;
  status: string;
  content_sha256: string;
};

type ImplementorMigrationEvidence = {
  schema_version: 3;
  kind: "coordinate-implementor-runtime-migration";
  transaction_state: "pending";
  state_path: string;
  ticket: string;
  user_authorized: true;
  completed_at: string;
  old_binding: ImplementorRuntimeBinding;
  replacement_role: RoleRecord;
  old_runtime_block: string;
  old_artifact_sha256: string;
  old_integration: IntegrationRecord | null;
  old_integration_cycle: number | null;
  worktree_snapshot: MigrationWorktreeSnapshot;
  state_references: { closed_runtime: string; decision: string };
  pane_closure: { pane_id: string; observed: "pane_not_found" };
};

type ImplementorMigrationCommit = {
  schema_version: 1;
  kind: "coordinate-implementor-runtime-migration-commit";
  status: "committed";
  evidence_path: string;
  evidence_sha256: string;
  state_references: string[];
  committed_at: string;
};

const appendSectionEntry = (markdown: string, headingText: string, entry: string): string => {
  if (markdown.split(/\r?\n/u).includes(entry)) return markdown;
  const heading = [...markdown.matchAll(/^## [^\r\n]+\s*$/gmu)].find(
    (match) => match[0].trim() === headingText,
  );
  if (heading === undefined) {
    return `${markdown.trimEnd()}\n\n${headingText}\n\n${entry}\n`;
  }
  const sectionStart = heading.index! + heading[0].length;
  const next = /^## /gmu;
  next.lastIndex = sectionStart;
  const sectionEnd = next.exec(markdown)?.index ?? markdown.length;
  return `${markdown.slice(0, sectionEnd).trimEnd()}\n${entry}\n\n${markdown.slice(sectionEnd).trimStart()}`;
};

/**
 * Integration record the replacement runtime inherits from its migrated predecessor. A
 * gates-phase migration must re-establish integration, so its record carries forward as
 * `rebase-required` and the next check starts a new cycle with fresh gates.
 */
const carriedIntegration = (evidence: ImplementorMigrationEvidence): IntegrationRecord | null => {
  if (evidence.old_integration === null) return null;
  if (evidence.old_binding.phase !== "gates") return evidence.old_integration;
  return { ...evidence.old_integration, phase: "rebase-required", passed_gates: [] };
};

const readBlockIntegration = (
  block: string,
  ticket: string,
): Effect.Effect<IntegrationRecord | undefined, ImplementorError> =>
  Effect.try({
    try: () => parseIntegration(block, ticket),
    catch: (error) =>
      error instanceof IntegrationError
        ? new ImplementorError({ issue: error.issue })
        : implementorError(
            "implementor.migration_integration_malformed",
            `Ticket integration could not be read: ${(error as Error).message}`,
            "Repair the Integration record from gate and review evidence before migrating.",
          ),
  });

const validateMigrationIntegration = (
  integration: IntegrationRecord | undefined,
  ticket: string,
  head: string,
): Effect.Effect<IntegrationRecord, ImplementorError> =>
  Effect.gen(function* () {
    if (integration === undefined) {
      return yield* implementorError(
        "implementor.migration_integration_missing",
        `Ticket \`${ticket}\` is in gates without an Integration record.`,
        "Run landing.rebase.check for the ticket before migrating the runtime.",
      );
    }
    if (
      integration.phase !== "gates" ||
      integration.ticket_sha !== head ||
      integration.standards_evidence_path !== null ||
      integration.spec_evidence_path !== null ||
      integration.self_review_path !== null
    ) {
      return yield* implementorError(
        "implementor.migration_integration_stale",
        "Ticket integration is not an untouched gate-phase binding for the current tip.",
        "Do not migrate through active review or landed state; repair or finish that integration first.",
      );
    }
    return integration;
  });

const persistMigrationEvidence = (
  path: string,
  serialized: string,
): Effect.Effect<void, ImplementorError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true });
      const existing = await readFile(path, "utf8").catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      });
      if (existing !== null) {
        if (existing !== serialized) {
          throw implementorError(
            "implementor.migration_evidence_conflict",
            "Runtime migration evidence already exists with different content.",
            "Preserve the prior evidence and retry only the byte-identical migration request.",
          );
        }
        return;
      }
      await writeFile(path, serialized, { flag: "wx", mode: 0o600 });
    },
    catch: (error) =>
      error instanceof ImplementorError
        ? error
        : implementorError(
            "implementor.migration_evidence_write_failed",
            `Could not persist runtime migration evidence: ${(error as Error).message}`,
            "Repair the run-local briefs directory and retry the exact request.",
          ),
  });

const captureMigrationWorktreeSnapshot = (
  worktreePath: string,
): Effect.Effect<MigrationWorktreeSnapshot, ImplementorError> =>
  Effect.tryPromise({
    try: async () => {
      const headResult = spawnGit(["rev-parse", "HEAD"], { cwd: worktreePath });
      const statusResult = spawnGit(["status", "--porcelain=v1", "--untracked-files=all"], {
        cwd: worktreePath,
      });
      const statusEntries = spawnGit(
        ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
        { cwd: worktreePath },
      );
      if (
        headResult.exitCode !== 0 ||
        statusResult.exitCode !== 0 ||
        statusEntries.exitCode !== 0
      ) {
        throw new Error("Git could not capture the worktree baseline");
      }
      const root = resolve(worktreePath);
      const manifest: Array<{ path: string; kind: string; sha256: string }> = [];
      for (const record of statusEntries.stdout.split("\0").filter(Boolean)) {
        if (record.length < 4 || record[2] !== " ") throw new Error("Malformed Git status entry");
        const path = record.slice(3);
        const absolute = resolve(root, path);
        const relation = relative(root, absolute);
        if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
          throw new Error("Git returned a worktree path outside its root");
        }
        let entry: { path: string; kind: string; sha256: string };
        try {
          const metadata = await lstat(absolute);
          if (metadata.isSymbolicLink()) {
            entry = {
              path,
              kind: "symlink",
              sha256: createHash("sha256")
                .update(await readlink(absolute))
                .digest("hex"),
            };
          } else if (metadata.isFile()) {
            entry = {
              path,
              kind: "file",
              sha256: createHash("sha256")
                .update(await readFile(absolute))
                .digest("hex"),
            };
          } else if (metadata.isDirectory()) {
            const nestedHead = spawnGit(["rev-parse", "HEAD"], { cwd: absolute });
            const nestedStatus = spawnGit(["status", "--porcelain=v1", "--untracked-files=all"], {
              cwd: absolute,
            });
            if (
              nestedHead.exitCode !== 0 ||
              nestedStatus.exitCode !== 0 ||
              nestedStatus.stdout.trim().length > 0
            ) {
              throw new Error(`Cannot safely fingerprint dirty nested repository ${path}`);
            }
            entry = {
              path,
              kind: "repository",
              sha256: createHash("sha256").update(nestedHead.stdout.trim()).digest("hex"),
            };
          } else {
            throw new Error(`Unsupported worktree entry ${path}`);
          }
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            entry = {
              path,
              kind: "missing",
              sha256: createHash("sha256").update("missing").digest("hex"),
            };
          } else {
            throw error;
          }
        }
        manifest.push(entry);
      }
      manifest.sort((left, right) => left.path.localeCompare(right.path));
      return {
        head: headResult.stdout.trim(),
        status: statusResult.stdout,
        content_sha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
      };
    },
    catch: (error) =>
      implementorError(
        "implementor.migration_worktree_inspection_failed",
        `Could not capture preserved worktree contents: ${(error as Error).message}`,
        "Keep the worktree untouched and repair Git or filesystem access before retrying migration.",
      ),
  });

const readCommittedMigrationEvidence = (
  statePath: string,
  ticket: string,
  markdown: string,
): Effect.Effect<ImplementorMigrationEvidence | null, ImplementorError> =>
  Effect.tryPromise({
    try: async () => {
      const evidencePath = resolve(
        dirname(statePath),
        "briefs",
        `implementor-runtime-migration-${ticket}.json`,
      );
      const raw = await readFile(evidencePath, "utf8").catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      });
      if (raw === null) return null;
      const parsed = JSON.parse(raw) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed) ||
        (parsed as Record<string, unknown>).schema_version !== 3 ||
        (parsed as Record<string, unknown>).kind !== "coordinate-implementor-runtime-migration"
      ) {
        throw implementorError(
          "implementor.migration_evidence_malformed",
          "Implementor migration evidence is malformed or from an unsupported schema.",
          "Preserve the pending evidence and retry migration reconciliation with its original request.",
        );
      }
      const evidence = parsed as ImplementorMigrationEvidence;
      const commitPath = `${evidencePath}.commit.json`;
      const commitRaw = await readFile(commitPath, "utf8").catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      });
      const references = [
        evidence.state_references.closed_runtime,
        evidence.state_references.decision,
      ];
      if (
        evidence.transaction_state !== "pending" ||
        evidence.state_path !== statePath ||
        evidence.ticket !== ticket ||
        !references.every((reference) => markdown.split(/\r?\n/u).includes(reference)) ||
        commitRaw === null
      ) {
        throw implementorError(
          "implementor.migration_pending",
          "Implementor migration has pending evidence that is not committed in RESUME.md.",
          "Retry the exact implementor.runtime.migrate request to reconcile its pending transaction before launching or reviewing.",
        );
      }
      const commitValue = JSON.parse(commitRaw) as unknown;
      if (typeof commitValue !== "object" || commitValue === null || Array.isArray(commitValue)) {
        throw implementorError(
          "implementor.migration_commit_malformed",
          "Implementor migration commit marker is malformed.",
          "Preserve it and retry the exact migration request to reconcile the transaction.",
        );
      }
      const commit = commitValue as Record<string, unknown>;
      if (
        commit.schema_version !== 1 ||
        commit.kind !== "coordinate-implementor-runtime-migration-commit" ||
        commit.status !== "committed" ||
        commit.evidence_path !== evidencePath ||
        commit.evidence_sha256 !== createHash("sha256").update(raw).digest("hex") ||
        JSON.stringify(commit.state_references) !== JSON.stringify(references)
      ) {
        throw implementorError(
          "implementor.migration_commit_mismatch",
          "Implementor migration commit marker does not bind its evidence and RESUME references.",
          "Preserve all migration records and reconcile the transaction before consumers continue.",
        );
      }
      return evidence;
    },
    catch: (error) =>
      error instanceof ImplementorError
        ? error
        : implementorError(
            "implementor.migration_evidence_read_failed",
            `Could not verify implementor migration evidence: ${(error as Error).message}`,
            "Repair the run-local pending or commit evidence before continuing.",
          ),
  });

/**
 * Archives one exact closed Claude implementor binding and adopts only the run's persisted Pi default.
 *
 * The operation leaves the worktree, branch, and launch artifact intact and preserves the ticket's
 * Integration record in the migration evidence for the replacement runtime.
 * The coordinator uses the returned binding with `implementor.launch.prepare` afterward.
 *
 * @param input - Exact prior binding, expected persisted Pi role, and explicit user authority.
 * @returns An Effect containing durable provenance and the unchanged worktree binding.
 */
export const migrateClosedImplementorRuntime = (
  input: ImplementorRuntimeMigrateInput,
): Effect.Effect<ImplementorRuntimeMigrateResult, ImplementorError> =>
  Effect.gen(function* () {
    if (!input.userAuthorized) {
      return yield* implementorError(
        "implementor.migration_authority_missing",
        "Closed implementor migration requires explicit user authorization.",
        "Retry only after the user authorizes this exact role replacement.",
      );
    }
    const evidencePath = resolve(
      dirname(input.statePath),
      "briefs",
      `implementor-runtime-migration-${input.ticket}.json`,
    );
    yield* ensurePathInsideState(input.statePath, input.expectedBinding.artifactPath);
    yield* ensurePathInsideState(input.statePath, evidencePath);
    let commitRecord: ImplementorMigrationCommit | null = null;
    const mutation = mutateStateFile(input.statePath, (markdown) =>
      Effect.gen(function* () {
        yield* validatePersistedState(input.statePath, markdown);
        const persistedDefault = yield* Effect.try({
          try: () => parsePersistedImplementor(markdown),
          catch: fromMutationError,
        });
        if (
          persistedDefault.harness !== "pi" ||
          !sameRole(persistedDefault, input.replacementRole)
        ) {
          return yield* implementorError(
            "implementor.migration_role_mismatch",
            "Replacement role does not exactly match the persisted Pi Implementor default.",
            "Use the complete Pi role recorded in RESUME.md; migration never selects a substitute.",
          );
        }
        const validation = yield* validateRole({
          role: "implementor",
          triple: undefined,
          record: persistedDefault,
        });
        if (validation.result === null) {
          return yield* new ImplementorError({ issue: validation.errors[0]! });
        }
        if (!sameRole(validation.result.record, persistedDefault)) {
          return yield* implementorError(
            "implementor.migration_role_changed",
            "Role validation changed the persisted Pi Implementor default.",
            "Repair role discovery and retry without substituting a model or effort.",
          );
        }

        const pattern = activeRuntimeBlockPattern(input.ticket);
        const activeBlock = markdown.match(pattern)?.[0];
        const rowRole = yield* Effect.try({
          try: () => parseTicketRole(markdown, input.ticket),
          catch: fromMutationError,
        });
        const evidenceRaw = yield* Effect.tryPromise({
          try: () =>
            readFile(evidencePath, "utf8").catch((error: unknown) => {
              if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
              throw error;
            }),
          catch: (error) =>
            implementorError(
              "implementor.migration_evidence_read_failed",
              `Could not inspect prior migration evidence: ${(error as Error).message}`,
              "Repair the run-local evidence path before retrying.",
            ),
        });
        let priorEvidence: ImplementorMigrationEvidence | undefined;
        if (evidenceRaw !== null) {
          try {
            const parsed = JSON.parse(evidenceRaw) as unknown;
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
              throw new Error("migration evidence is not an object");
            }
            priorEvidence = parsed as ImplementorMigrationEvidence;
          } catch {
            return yield* implementorError(
              "implementor.migration_evidence_malformed",
              "Existing implementor migration evidence is malformed.",
              "Preserve it and repair the state from its recorded migration artifact.",
            );
          }
          if (
            priorEvidence.kind !== "coordinate-implementor-runtime-migration" ||
            priorEvidence.schema_version !== 3 ||
            priorEvidence.transaction_state !== "pending" ||
            priorEvidence.state_path !== input.statePath ||
            priorEvidence.ticket !== input.ticket ||
            priorEvidence.user_authorized !== true ||
            priorEvidence.completed_at !== input.completedAt ||
            JSON.stringify(priorEvidence.old_binding) !== JSON.stringify(input.expectedBinding) ||
            !isRoleRecord(priorEvidence.replacement_role) ||
            !sameRole(priorEvidence.replacement_role, persistedDefault) ||
            typeof priorEvidence.pane_closure !== "object" ||
            priorEvidence.pane_closure === null ||
            priorEvidence.pane_closure.pane_id !== input.expectedBinding.pane ||
            priorEvidence.pane_closure.observed !== "pane_not_found" ||
            typeof priorEvidence.state_references?.closed_runtime !== "string" ||
            typeof priorEvidence.state_references?.decision !== "string"
          ) {
            return yield* implementorError(
              "implementor.migration_evidence_mismatch",
              "Existing migration evidence does not match this exact authorized request.",
              "Retry with the original binding, persisted role, and timestamp; never overwrite evidence.",
            );
          }
        }

        const originalBlock = activeBlock ?? priorEvidence?.old_runtime_block;
        if (originalBlock === undefined) {
          return yield* implementorError(
            "implementor.migration_runtime_missing",
            `Ticket \`${input.ticket}\` has no active Claude runtime or matching migration evidence.`,
            "Restore the exact runtime from its immutable launch artifact before migrating.",
          );
        }
        const fields = parseActiveRuntimeFields(originalBlock);
        const runtimeRole = roleFromActive(fields);
        const actualBinding: ImplementorRuntimeBinding | undefined =
          runtimeRole === null ||
          fields.Worktree === undefined ||
          fields.Branch === undefined ||
          fields["Implement skill"] === undefined ||
          fields.Session === undefined ||
          fields.Tab === undefined ||
          fields.Pane === undefined ||
          fields.Artifact === undefined ||
          fields.Retry === undefined ||
          (fields.Phase !== "working" && fields.Phase !== "gates") ||
          !Number.isInteger(Number(fields.Attempt))
            ? undefined
            : {
                worktreePath: fields.Worktree,
                branch: fields.Branch,
                role: runtimeRole,
                implementSkillPath: fields["Implement skill"],
                session: fields.Session,
                tab: fields.Tab,
                pane: fields.Pane,
                artifactPath: fields.Artifact,
                attempt: Number(fields.Attempt),
                retry: fields.Retry,
                phase: fields.Phase,
              };
        if (
          actualBinding === undefined ||
          JSON.stringify(actualBinding) !== JSON.stringify(input.expectedBinding) ||
          actualBinding.role.harness !== "claude"
        ) {
          return yield* implementorError(
            "implementor.migration_binding_mismatch",
            "Active runtime does not match the exact closed Claude binding supplied for migration.",
            "Refresh every worktree, branch, role, session, pane, artifact, attempt, retry, and phase field from RESUME.md.",
          );
        }
        if (
          activeBlock !== undefined &&
          priorEvidence !== undefined &&
          activeBlock !== priorEvidence.old_runtime_block
        ) {
          return yield* implementorError(
            "implementor.migration_state_conflict",
            "Active runtime differs from the immutable runtime block captured by the migration evidence.",
            "Preserve both records and reconcile the run state manually.",
          );
        }
        if (
          rowRole === undefined ||
          rowRole === null ||
          (!sameRole(rowRole, actualBinding.role) && !sameRole(rowRole, persistedDefault))
        ) {
          return yield* implementorError(
            "implementor.migration_ticket_role_mismatch",
            "Ticket table role matches neither the archived runtime nor the persisted Pi default.",
            "Repair the ticket row from its launch provenance before migration.",
          );
        }

        if (activeBlock === undefined && !sameRole(rowRole, persistedDefault)) {
          return yield* implementorError(
            "implementor.migration_state_conflict",
            "The active runtime is already absent but the ticket row does not record the Pi replacement.",
            "Preserve the run state and reconcile its ticket role with immutable migration evidence.",
          );
        }

        const artifactRaw = yield* Effect.tryPromise({
          try: () => readFile(actualBinding.artifactPath, "utf8"),
          catch: (error) =>
            implementorError(
              "implementor.migration_artifact_read_failed",
              `Could not read the original launch artifact: ${(error as Error).message}`,
              "Preserve and restore the exact launch artifact before migrating.",
            ),
        });
        let artifact: Record<string, unknown>;
        try {
          const parsed = JSON.parse(artifactRaw) as unknown;
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new Error("launch artifact is not an object");
          }
          artifact = parsed as Record<string, unknown>;
        } catch {
          return yield* implementorError(
            "implementor.migration_artifact_malformed",
            "Original implementor launch artifact is not valid JSON.",
            "Preserve the artifact and recover its exact launch provenance before migrating.",
          );
        }
        const artifactRole = roleFromUnknown(artifact.role);
        if (
          artifact.schema_version !== 1 ||
          artifact.ticket !== input.ticket ||
          artifact.cwd !== actualBinding.worktreePath ||
          artifact.branch !== actualBinding.branch ||
          artifactRole === null ||
          !sameRole(artifactRole, actualBinding.role) ||
          artifact.implement_skill_path !== null ||
          artifact.session !== actualBinding.session ||
          artifact.tab !== actualBinding.tab ||
          artifact.pane !== actualBinding.pane ||
          artifact.attempt !== actualBinding.attempt ||
          artifact.max_attempts !== 3
        ) {
          return yield* implementorError(
            "implementor.migration_artifact_mismatch",
            "Original launch artifact does not match the exact active runtime binding.",
            "Do not rewrite or replace launch provenance; reconcile the artifact and RESUME.md manually.",
          );
        }

        const paneInspection = yield* inspectRuntimeClose(actualBinding.pane).pipe(
          Effect.mapError((error) => new ImplementorError({ issue: error.issue })),
        );
        if (!paneInspection.runtime_closed) {
          return yield* implementorError(
            "implementor.migration_runtime_live",
            "Herdr still reports the exact old implementor pane as live.",
            "Do not replace a live runtime; resume it or obtain a later machine-observed closure before retrying.",
          );
        }
        yield* verifyWorktree(actualBinding.worktreePath, actualBinding.branch);
        const worktreeSnapshot = yield* captureMigrationWorktreeSnapshot(
          actualBinding.worktreePath,
        );
        const dirtyWorktree = worktreeSnapshot.status.trim().length > 0;
        const oldIntegration = yield* readBlockIntegration(originalBlock, input.ticket);
        if (actualBinding.phase === "gates") {
          if (dirtyWorktree) {
            return yield* implementorError(
              "implementor.migration_worktree_dirty",
              "A gates-phase implementor migration requires the integrated worktree to remain clean.",
              "Preserve the work and restore the reviewed tip before migrating this integration.",
            );
          }
          yield* validateMigrationIntegration(oldIntegration, input.ticket, worktreeSnapshot.head);
        }

        const relativeEvidencePath = relative(dirname(input.statePath), evidencePath);
        const decisionLine = `- ${input.completedAt} user-authorized ticket ${input.ticket} implementor migration; old binding ${JSON.stringify(actualBinding)}; persisted Pi default ${JSON.stringify(persistedDefault)}; Herdr observed pane_not_found for ${actualBinding.pane}`;
        const closedEntry = `- ${input.completedAt} ticket ${input.ticket} closed Claude implementor runtime superseded; binding ${JSON.stringify(actualBinding)}; evidence ${relativeEvidencePath}`;
        const evidence: ImplementorMigrationEvidence = {
          schema_version: 3,
          kind: "coordinate-implementor-runtime-migration",
          transaction_state: "pending",
          state_path: input.statePath,
          ticket: input.ticket,
          user_authorized: true,
          completed_at: input.completedAt,
          old_binding: actualBinding,
          replacement_role: persistedDefault,
          old_runtime_block: originalBlock,
          old_artifact_sha256: createHash("sha256").update(artifactRaw).digest("hex"),
          old_integration: oldIntegration ?? null,
          old_integration_cycle: oldIntegration?.cycle ?? null,
          worktree_snapshot: worktreeSnapshot,
          state_references: { closed_runtime: closedEntry, decision: decisionLine },
          pane_closure: { pane_id: actualBinding.pane, observed: "pane_not_found" },
        };
        const serializedEvidence = `${JSON.stringify(evidence, null, 2)}\n`;
        commitRecord = {
          schema_version: 1,
          kind: "coordinate-implementor-runtime-migration-commit",
          status: "committed",
          evidence_path: evidencePath,
          evidence_sha256: createHash("sha256").update(serializedEvidence).digest("hex"),
          state_references: [closedEntry, decisionLine],
          committed_at: input.completedAt,
        };
        if (evidenceRaw !== null && evidenceRaw !== serializedEvidence) {
          return yield* implementorError(
            "implementor.migration_evidence_conflict",
            "Runtime migration evidence already exists with different content.",
            "Preserve the prior evidence and retry only the byte-identical migration request.",
          );
        }
        yield* persistMigrationEvidence(evidencePath, serializedEvidence);

        let updated = markdown;
        const alreadyReplaced =
          activeBlock === undefined || sameRole(rowRole ?? actualBinding.role, persistedDefault);
        if (!alreadyReplaced) {
          updated = updateTicketRow(updated, input.ticket, {
            harness: persistedDefault.harness,
            model: persistedDefault.model,
            effort: persistedDefault.effort,
          });
          updated = updated.replace(pattern, "");
        } else if (activeBlock !== undefined) {
          const activeFields = parseActiveRuntimeFields(activeBlock);
          const activeRole = roleFromActive(activeFields);
          if (
            activeRole === null ||
            !sameRole(activeRole, persistedDefault) ||
            activeFields.Worktree !== actualBinding.worktreePath ||
            activeFields.Branch !== actualBinding.branch
          ) {
            return yield* implementorError(
              "implementor.migration_state_conflict",
              "The active ticket now has a different runtime than the recorded Pi replacement.",
              "Preserve current runtime state and reconcile its launch artifact manually.",
            );
          }
        }
        updated = appendSectionEntry(updated, "## Closed ticket runtimes", closedEntry);
        updated = appendSectionEntry(updated, "## Decisions", decisionLine);
        return {
          markdown: updated,
          result: {
            ticket: input.ticket,
            action: "prepare-replacement" as const,
            recovered: evidenceRaw !== null,
            runtime_closed: true as const,
            pane_id: actualBinding.pane,
            worktree_path: actualBinding.worktreePath,
            branch: actualBinding.branch,
            old_role: actualBinding.role,
            replacement_role: persistedDefault,
            evidence_path: evidencePath,
            dirty_worktree_preserved: dirtyWorktree,
            integration_preserved: oldIntegration !== undefined,
          },
        };
      }),
    ).pipe(Effect.mapError(fromMutationError));
    const result = yield* mutation;
    if (commitRecord === null) {
      return yield* implementorError(
        "implementor.migration_commit_missing",
        "Migration state changed without a prepared commit record.",
        "Preserve the run state and reconcile the evidence transaction before continuing.",
      );
    }
    yield* persistMigrationEvidence(
      `${evidencePath}.commit.json`,
      `${JSON.stringify(commitRecord, null, 2)}\n`,
    );
    return result;
  });

/**
 * Opens a gates-phase migration for an explicit new integration cycle without changing the worktree.
 *
 * @param input - Ticket, exact migration evidence hash, explicit authority, and timestamp.
 * @returns The action to prepare the replacement runtime and then run landing.rebase.check.
 */
export const recoverImplementorRuntimeMigration = (
  input: ImplementorRuntimeMigrationRecoverInput,
): Effect.Effect<ImplementorRuntimeMigrationRecoverResult, ImplementorError> =>
  Effect.gen(function* () {
    if (!input.userAuthorized) {
      return yield* implementorError(
        "implementor.migration_recovery_authority_missing",
        "Gates-phase migration recovery requires explicit user authorization.",
        "Retry only after the user authorizes recovery for this exact migration evidence.",
      );
    }
    const evidencePath = resolve(
      dirname(input.statePath),
      "briefs",
      `implementor-runtime-migration-${input.ticket}.json`,
    );
    yield* ensurePathInsideState(input.statePath, evidencePath);
    const mutation = mutateStateFile(input.statePath, (markdown) =>
      Effect.gen(function* () {
        yield* validatePersistedState(input.statePath, markdown);
        const evidence = yield* readCommittedMigrationEvidence(
          input.statePath,
          input.ticket,
          markdown,
        );
        if (evidence === null) {
          return yield* implementorError(
            "implementor.migration_evidence_missing",
            `Ticket ${input.ticket} has no committed implementor migration to recover.`,
            "Run implementor.runtime.migrate first and retain its evidence artifact.",
          );
        }
        if (evidence.old_binding.phase !== "gates" || evidence.old_integration_cycle === null) {
          return yield* implementorError(
            "implementor.migration_recovery_not_required",
            "Explicit revalidation is available only for a gates-phase implementor migration.",
            "Use the normal launch and gate lifecycle for working-phase migrations.",
          );
        }
        const evidenceRaw = yield* Effect.tryPromise({
          try: () => readFile(evidencePath, "utf8"),
          catch: (error) =>
            implementorError(
              "implementor.migration_evidence_read_failed",
              `Could not read migration evidence: ${(error as Error).message}`,
              "Repair the run-local evidence path and retry recovery.",
            ),
        });
        if (
          createHash("sha256").update(evidenceRaw).digest("hex") !== input.migrationEvidenceSha256
        ) {
          return yield* implementorError(
            "implementor.migration_recovery_binding_mismatch",
            "Recovery request does not identify the exact committed migration evidence bytes.",
            "Use the SHA-256 of the immutable migration evidence artifact without editing or replacing it.",
          );
        }
        const relativeEvidencePath = relative(dirname(input.statePath), evidencePath);
        const recoveryReference = `ticket ${input.ticket} implementor migration recovery; evidence ${relativeEvidencePath}`;
        const result = (recovered: boolean) => ({
          ticket: input.ticket,
          action: "prepare-and-check-rebase" as const,
          phase: "rebase-required" as const,
          recovered,
          head: evidence.worktree_snapshot.head,
          evidence_path: evidencePath,
        });
        if (markdown.split(/\r?\n/u).some((line) => line.includes(recoveryReference))) {
          return { markdown, result: result(true) };
        }
        if (activeRuntimeBlockPattern(input.ticket).test(markdown)) {
          return yield* implementorError(
            "implementor.migration_recovery_state_conflict",
            "A replacement runtime is already active without a recorded migration recovery.",
            "Preserve the current state and reconcile the replacement runtime against the migration evidence.",
          );
        }
        yield* verifyWorktree(evidence.old_binding.worktreePath, evidence.old_binding.branch);
        const snapshot = yield* captureMigrationWorktreeSnapshot(evidence.old_binding.worktreePath);
        if (
          snapshot.status.trim().length > 0 ||
          JSON.stringify(snapshot) !== JSON.stringify(evidence.worktree_snapshot)
        ) {
          return yield* implementorError(
            "implementor.migration_recovery_worktree_changed",
            "Gates-phase recovery requires the original clean integrated worktree snapshot.",
            "Preserve and reconcile the worktree manually; recovery will not discard or rewrite ticket files.",
          );
        }
        const decision = `- ${input.completedAt} user-authorized ${recoveryReference}; evidence_sha256 ${input.migrationEvidenceSha256}; integration cycle ${evidence.old_integration_cycle} released as rebase-required at ${snapshot.head}`;
        return {
          markdown: appendSectionEntry(markdown, "## Decisions", decision),
          result: result(false),
        };
      }),
    ).pipe(Effect.mapError(fromMutationError));
    return yield* mutation;
  });
