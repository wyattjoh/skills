import { Data, Effect, Either } from "effect";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { activeRuntimeBlockPattern, parseActiveRuntimeFields } from "./active-runtime.ts";
import { buildHarnessLaunch, type HarnessLaunchPlan } from "./harness-launch.ts";
import type {
  CliIssue,
  ImplementorLaunchPrepareInput,
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

const roleFromActive = (fields: Record<string, string>): RoleRecord | null => {
  const serialized = fields.Implementor;
  if (serialized === undefined) return null;
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const role = parsed as Record<string, unknown>;
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
        const persistedRole = yield* Effect.try({
          try: () => parsePersistedImplementor(markdown),
          catch: fromMutationError,
        });
        if (!sameRole(persistedRole, input.role)) {
          return yield* implementorError(
            "implementor.role_mismatch",
            "Requested implementor role does not match the persisted Implementor role.",
            "Launch with the exact persisted Implementor harness, model, and effort; preference changes apply only to future unbound tickets.",
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
