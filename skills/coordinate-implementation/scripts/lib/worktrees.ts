import { Data, Effect } from "effect";
import { basename, dirname, join } from "node:path";
import { access, mkdir } from "node:fs/promises";
import { constants, realpathSync } from "node:fs";
import type {
  CliIssue,
  RepositoryPolicy,
  WorktreePreflightInput,
  WorktreePrepareInput,
} from "./contract.ts";
import { cleanGitEnv, spawnGit } from "./git.ts";
import { mutateStateFile, StateMutationError } from "./state-mutation.ts";
import { validateStateText } from "./state.ts";

/**
 * Persisted JSON representation of repository policy.
 */
export type SerializedRepositoryPolicy = {
  instruction_files: string[];
  worktree: {
    kind: "native" | "repository";
    tool: string;
    root: string | null;
    create_argv: string[] | null;
  };
  branch_naming: string;
  setup_argvs: string[][];
  cleanup: "native-safe" | "repository";
  remote: "local-only" | "repository";
  remote_sync_argv: string[] | null;
  commit: RepositoryPolicy["commit"];
};

/**
 * Actual worktree identity returned after creation or recovery.
 */
export type PreparedWorktree = {
  path: string;
  branch: string;
  base: string;
  created: boolean;
  recovered: boolean;
};

/**
 * Read-only result from checking one resolved worktree policy.
 */
export type WorktreePreflightResult = {
  policy: SerializedRepositoryPolicy;
  required_tool: {
    name: string;
    available: true;
  };
};

/**
 * Successful policy resolution and worktree preparation result.
 */
export type WorktreePrepareResult = {
  policy: SerializedRepositoryPolicy;
  worktree: PreparedWorktree;
};

/**
 * Typed repository-policy or worktree failure returned through the CLI.
 */
export class WorktreeError extends Data.TaggedError("WorktreeError")<{
  issue: CliIssue;
}> {}

const worktreeError = (code: string, message: string, remediation: string): WorktreeError =>
  new WorktreeError({ issue: { code, message, remediation } });

const serializePolicy = (policy: RepositoryPolicy): SerializedRepositoryPolicy => ({
  instruction_files: policy.instructionFiles,
  worktree: {
    kind: policy.worktree.kind,
    tool: policy.worktree.tool,
    root: policy.worktree.root ?? null,
    create_argv: policy.worktree.createArgv ?? null,
  },
  branch_naming: policy.branchNaming,
  setup_argvs: policy.setupArgvs,
  cleanup: policy.cleanup,
  remote: policy.remote,
  remote_sync_argv: policy.remoteSyncArgv ?? null,
  commit: policy.commit,
});

const executableExists = async (command: string): Promise<boolean> => {
  if (command.includes("/")) {
    return access(command, constants.X_OK)
      .then(() => true)
      .catch(() => false);
  }
  return Bun.which(command) !== null;
};

const repositoryPolicyPattern =
  /^## Repository policy\r?\n\r?\n```json\r?\n[\s\S]*?\r?\n```\r?\n?/gmu;

const renderPolicy = (policy: SerializedRepositoryPolicy): string =>
  `## Repository policy\n\n\`\`\`json\n${JSON.stringify(policy, null, 2)}\n\`\`\`\n`;

const appendDecision = (markdown: string, decision: string): string => {
  const heading = /^## Decisions\s*$/mu;
  const match = heading.exec(markdown);
  if (match === null) {
    return `${markdown.trimEnd()}\n\n## Decisions\n\n- ${decision}\n`;
  }
  const sectionStart = match.index + match[0].length;
  const nextHeading = /^## /gmu;
  nextHeading.lastIndex = sectionStart;
  const next = nextHeading.exec(markdown);
  const sectionEnd = next?.index ?? markdown.length;
  const section = markdown.slice(sectionStart, sectionEnd).trimEnd();
  return `${markdown.slice(0, sectionStart)}${section}\n\n- ${decision}\n${markdown.slice(sectionEnd)}`;
};

const persistPolicy = (
  statePath: string,
  policy: SerializedRepositoryPolicy,
): Effect.Effect<void, WorktreeError> =>
  mutateStateFile(statePath, (markdown) =>
    Effect.gen(function* () {
      yield* validateStateText(statePath, markdown).pipe(
        Effect.mapError((error) => new WorktreeError({ issue: error.issue })),
      );
      const rendered = renderPolicy(policy);
      const existing = markdown.match(repositoryPolicyPattern)?.[0];
      if (existing === rendered) return { markdown: undefined, result: undefined };
      const withPolicy =
        existing === undefined
          ? markdown.replace(/^## Tickets\s*$/mu, `${rendered}\n## Tickets`)
          : markdown.replace(repositoryPolicyPattern, rendered);
      if (withPolicy === markdown) {
        return yield* worktreeError(
          "state.tickets_missing",
          "RESUME.md has no `## Tickets` section where repository policy can be persisted.",
          "Repair the schema-1 state template before preparing a worktree.",
        );
      }
      const source =
        policy.worktree.kind === "native" ? "native Git fallback" : policy.worktree.tool;
      return {
        markdown: appendDecision(
          withPolicy,
          `${new Date().toISOString().slice(0, 10)} repository policy resolved from ${policy.instruction_files.join(", ")} (${source}; commits: ${policy.commit.commits}; fixes: ${policy.commit.fixes}).`,
        ),
        result: undefined,
      };
    }),
  ).pipe(
    Effect.mapError((error) => {
      if (error instanceof WorktreeError) return error;
      const detail = error instanceof StateMutationError ? error.message : (error as Error).message;
      return worktreeError(
        error instanceof StateMutationError && error.kind === "lock_busy"
          ? "worktree.state_busy"
          : "worktree.state_io_failed",
        `Could not persist repository policy: ${detail}`,
        "Verify RESUME.md is writable and retry before creating a worktree.",
      );
    }),
  );

const gitFailure = (action: string, stderr: string): WorktreeError =>
  worktreeError(
    "worktree.git_failed",
    `${action} failed: ${stderr.trim() || "Git returned a nonzero exit code."}`,
    "Inspect the repository and policy, correct the reported Git failure, then retry.",
  );

const validateRepository = (repositoryPath: string): Effect.Effect<void, WorktreeError> =>
  Effect.gen(function* () {
    const result = spawnGit(["rev-parse", "--show-toplevel"], { cwd: repositoryPath });
    if (result.exitCode !== 0) return yield* gitFailure("Repository validation", result.stderr);
    if (realpathSync(result.stdout.trim()) !== realpathSync(repositoryPath)) {
      return yield* worktreeError(
        "worktree.repository_mismatch",
        `Repository path \`${repositoryPath}\` is not its Git top level.`,
        "Pass the repository root named by the run state.",
      );
    }
  });

const validateBranchInputs = (
  repositoryPath: string,
  baseBranch: string,
  branch: string,
): Effect.Effect<void, WorktreeError> =>
  Effect.gen(function* () {
    const validBranch = spawnGit(["check-ref-format", "--branch", branch], {
      cwd: repositoryPath,
    });
    if (validBranch.exitCode !== 0)
      return yield* gitFailure("Branch validation", validBranch.stderr);
    const base = spawnGit(["show-ref", "--verify", `refs/heads/${baseBranch}`], {
      cwd: repositoryPath,
    });
    if (base.exitCode !== 0) {
      return yield* worktreeError(
        "worktree.base_missing",
        `Local integration branch \`${baseBranch}\` does not exist.`,
        "Create or select the local integration branch required by repository policy.",
      );
    }
  });

const inspectExistingWorktree = (
  path: string,
  branch: string,
): { exists: boolean; matches: boolean } => {
  const root = spawnGit(["rev-parse", "--show-toplevel"], { cwd: path });
  if (root.exitCode !== 0) return { exists: false, matches: false };
  const current = spawnGit(["symbolic-ref", "--short", "HEAD"], { cwd: path });
  return {
    exists: true,
    matches:
      realpathSync(root.stdout.trim()) === realpathSync(path) && current.stdout.trim() === branch,
  };
};

const runExactCommand = (
  argv: string[],
  cwd: string,
  action: string,
): Effect.Effect<void, WorktreeError> =>
  Effect.gen(function* () {
    const result = yield* Effect.sync(() => {
      try {
        const child = Bun.spawnSync(argv, {
          cwd,
          env: cleanGitEnv(),
          stdout: "pipe",
          stderr: "pipe",
        });
        return {
          exitCode: child.exitCode,
          stderr: child.stderr.toString(),
        };
      } catch (error) {
        return { exitCode: 1, stderr: (error as Error).message };
      }
    });
    if (result.exitCode !== 0) {
      return yield* worktreeError(
        "worktree.command_failed",
        `${action} failed: ${result.stderr.trim() || "command returned a nonzero exit code."}`,
        "Follow the repository worktree policy to repair the failure, then retry without substituting another tool.",
      );
    }
  });

const resolveWorktreePath = (input: WorktreePrepareInput): Effect.Effect<string, WorktreeError> =>
  Effect.gen(function* () {
    if (input.policy.worktree.kind === "repository") return input.expectedWorktreePath!;
    if (
      input.worktreeName === "." ||
      input.worktreeName === ".." ||
      input.worktreeName.includes("/") ||
      input.worktreeName.includes("\\")
    ) {
      return yield* worktreeError(
        "worktree.name_invalid",
        "Native fallback worktree_name must be one filesystem path component.",
        "Choose a worktree name without directory separators; the recorded root supplies the parent.",
      );
    }
    return join(input.policy.worktree.root!, input.worktreeName);
  });

/**
 * Checks the resolved worktree tool before state or worktree creation.
 *
 * @param input - Complete repository policy resolved from instructions.
 * @returns An Effect containing the normalized policy and available required tool.
 */
export const preflightWorktreePolicy = (
  input: WorktreePreflightInput,
): Effect.Effect<WorktreePreflightResult, WorktreeError> =>
  Effect.gen(function* () {
    const tool = input.policy.worktree.tool;
    const available = yield* Effect.promise(() => executableExists(tool));
    if (!available) {
      return yield* worktreeError(
        "worktree.tool_unavailable",
        `Repository-required worktree tool \`${tool}\` is unavailable.`,
        "Install the prescribed tool or revise the repository policy; native Git fallback was not used.",
      );
    }
    if (input.policy.worktree.kind === "repository") {
      const command = input.policy.worktree.createArgv![0]!;
      if (basename(command) !== tool && command !== tool) {
        return yield* worktreeError(
          "worktree.command_mismatch",
          "Repository worktree create_argv does not invoke its recorded required tool.",
          "Resolve the exact repository-prescribed command before retrying.",
        );
      }
    }
    return {
      policy: serializePolicy(input.policy),
      required_tool: { name: tool, available: true },
    };
  });

/**
 * Persists resolved repository policy, then creates or recovers one ticket worktree.
 *
 * @param input - Repository, branch, worktree identity, and normalized policy.
 * @returns An Effect containing durable policy and actual worktree provenance.
 */
export const prepareWorktree = (
  input: WorktreePrepareInput,
): Effect.Effect<WorktreePrepareResult, WorktreeError> =>
  Effect.gen(function* () {
    const preflight = yield* preflightWorktreePolicy({ policy: input.policy });
    const serialized = preflight.policy;

    yield* validateRepository(input.repositoryPath);
    yield* validateBranchInputs(input.repositoryPath, input.baseBranch, input.branch);
    const path = yield* resolveWorktreePath(input);
    const existing = inspectExistingWorktree(path, input.branch);
    if (existing.exists && !existing.matches) {
      return yield* worktreeError(
        "worktree.path_conflict",
        `Worktree path \`${path}\` exists but is not the expected branch \`${input.branch}\`.`,
        "Choose another policy-compliant path or repair the existing worktree manually.",
      );
    }

    yield* persistPolicy(input.statePath, serialized);
    if (existing.matches) {
      return {
        policy: serialized,
        worktree: {
          path,
          branch: input.branch,
          base: input.baseBranch,
          created: false,
          recovered: true,
        },
      };
    }

    if (input.policy.worktree.kind === "native") {
      yield* Effect.tryPromise({
        try: () => mkdir(dirname(path), { recursive: true }),
        catch: (error) =>
          worktreeError(
            "worktree.root_failed",
            `Could not create fallback worktree root: ${(error as Error).message}`,
            "Choose a writable worktree root and persist that setup choice before retrying.",
          ),
      });
      const branchExists = spawnGit(["show-ref", "--verify", `refs/heads/${input.branch}`], {
        cwd: input.repositoryPath,
      });
      if (branchExists.exitCode === 0) {
        return yield* worktreeError(
          "worktree.branch_exists",
          `Branch \`${input.branch}\` already exists without the expected worktree.`,
          "Recover or remove the stale branch according to repository policy, then retry.",
        );
      }
      const created = spawnGit(["worktree", "add", "-b", input.branch, path, input.baseBranch], {
        cwd: input.repositoryPath,
      });
      if (created.exitCode !== 0)
        return yield* gitFailure("Native worktree creation", created.stderr);
    } else {
      yield* runExactCommand(
        input.policy.worktree.createArgv!,
        input.repositoryPath,
        `Repository worktree tool ${input.policy.worktree.tool}`,
      );
    }

    const actual = inspectExistingWorktree(path, input.branch);
    if (!actual.matches) {
      return yield* worktreeError(
        "worktree.result_invalid",
        `Worktree creation did not produce branch \`${input.branch}\` at \`${path}\`.`,
        "Inspect the prescribed tool output and repair the worktree before launching an implementor.",
      );
    }
    for (const argv of input.policy.setupArgvs) {
      yield* runExactCommand(argv, path, `Repository setup command ${argv[0]}`);
    }
    return {
      policy: serialized,
      worktree: {
        path,
        branch: input.branch,
        base: input.baseBranch,
        created: true,
        recovered: false,
      },
    };
  });
