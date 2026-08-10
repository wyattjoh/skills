import { Data, Effect } from "effect";
import { type GitResult, spawnGit } from "./git-env.ts";

/**
 * Raised when a git command exits with a failing status. `stderr` carries
 * git's own diagnostic so callers can surface it verbatim.
 */
export class GitCommandError extends Data.TaggedError("GitCommandError")<{
  repo: string;
  args: string[];
  exitCode: number;
  stderr: string;
}> {}

/**
 * One branch stack read from a member repo's git config, as written by the
 * stacked-prs plugin (`stack.<name>.*` and `branch.<branch>.stack-name`).
 */
export type StackInfo = {
  name: string;
  baseBranch: string | undefined;
  mergeStrategy: string | undefined;
  archived: boolean;
  branches: string[];
};

// `-C` alone does not pin the repository: an inherited GIT_DIR wins over it.
// `spawnGit` strips those variables so a skill command invoked from inside a
// git hook still reads `repo` and not the hook's repository.
const runGitRaw = (repo: string, args: string[]): GitResult => spawnGit(["-C", repo, ...args]);

/**
 * Runs a git command against `repo` (via `git -C`) and returns trimmed
 * stdout, failing with `GitCommandError` on a non-zero exit.
 */
export const runGit = (repo: string, args: string[]): Effect.Effect<string, GitCommandError> =>
  Effect.gen(function* () {
    const result = runGitRaw(repo, args);
    if (result.exitCode !== 0) {
      return yield* new GitCommandError({
        repo,
        args,
        exitCode: result.exitCode,
        stderr: result.stderr.trim(),
      });
    }
    return result.stdout.trim();
  });

/**
 * Like `runGit` but treats exit code 1 with empty output as an empty result,
 * matching `git config --get-regexp` and `git ls-files` semantics when
 * nothing matches.
 */
export const runGitAllowEmpty = (
  repo: string,
  args: string[],
): Effect.Effect<string, GitCommandError> =>
  Effect.gen(function* () {
    const result = runGitRaw(repo, args);
    if (result.exitCode === 0) return result.stdout.trim();
    if (result.exitCode === 1 && result.stdout.trim() === "") return "";
    return yield* new GitCommandError({
      repo,
      args,
      exitCode: result.exitCode,
      stderr: result.stderr.trim(),
    });
  });

/**
 * Returns true when the directory is inside a git work tree.
 */
export const isGitRepo = (repo: string): boolean =>
  runGitRaw(repo, ["rev-parse", "--is-inside-work-tree"]).stdout.trim() === "true";

/**
 * Returns the currently checked-out branch name (or "HEAD" when detached).
 */
export const currentBranch = (repo: string): Effect.Effect<string, GitCommandError> =>
  runGit(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);

/**
 * Returns the SHA of the repository's current HEAD.
 */
export const headSha = (repo: string): Effect.Effect<string, GitCommandError> =>
  runGit(repo, ["rev-parse", "HEAD"]);

/**
 * Returns true when the work tree has uncommitted changes (staged, unstaged,
 * or untracked).
 */
export const isDirty = (repo: string): Effect.Effect<boolean, GitCommandError> =>
  Effect.map(runGit(repo, ["status", "--porcelain"]), (output) => output !== "");

/**
 * Parses one `git config --get-regexp` output block into key/value pairs.
 * Keys may contain dots inside subsections; the value starts after the first
 * space.
 */
const parseConfigLines = (output: string): Array<{ key: string; value: string }> =>
  output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const space = line.indexOf(" ");
      if (space === -1) return { key: line, value: "" };
      return { key: line.slice(0, space), value: line.slice(space + 1) };
    });

/**
 * Reads every stacked-prs stack recorded in the repo's git config. Because
 * the metadata lives in the common dir, this works from the hub via
 * `git -C` without entering any worktree.
 */
export const listStacks = (repo: string): Effect.Effect<StackInfo[], GitCommandError> =>
  Effect.gen(function* () {
    const stackConfig = yield* runGitAllowEmpty(repo, ["config", "--get-regexp", "^stack\\."]);
    const branchConfig = yield* runGitAllowEmpty(repo, [
      "config",
      "--get-regexp",
      "^branch\\..*\\.stack-name$",
    ]);

    const stacks = new Map<string, StackInfo>();
    const ensure = (name: string): StackInfo => {
      const existing = stacks.get(name);
      if (existing) return existing;
      const created: StackInfo = {
        name,
        baseBranch: undefined,
        mergeStrategy: undefined,
        archived: false,
        branches: [],
      };
      stacks.set(name, created);
      return created;
    };

    for (const { key, value } of parseConfigLines(stackConfig)) {
      const body = key.slice("stack.".length);
      const lastDot = body.lastIndexOf(".");
      if (lastDot === -1) continue;
      const name = body.slice(0, lastDot);
      const field = body.slice(lastDot + 1);
      if (name === "") continue;
      const stack = ensure(name);
      if (field === "base-branch") stack.baseBranch = value;
      if (field === "merge-strategy") stack.mergeStrategy = value;
      if (field === "archived") stack.archived = value === "true";
    }

    for (const { key, value } of parseConfigLines(branchConfig)) {
      const branch = key.slice("branch.".length, key.length - ".stack-name".length);
      ensure(value).branches.push(branch);
    }

    return [...stacks.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  });

/**
 * Lists committed paths under the workflow-runtime directories that must
 * never be tracked in a member repo (`.claude/worktrees`,
 * `.claude/task-orchestrator`). A non-empty result is workspace drift.
 */
export const trackedWorkflowArtifacts = (repo: string): Effect.Effect<string[], GitCommandError> =>
  Effect.map(
    runGitAllowEmpty(repo, ["ls-files", "--", ".claude/worktrees", ".claude/task-orchestrator"]),
    (output) => output.split("\n").filter((line) => line.trim() !== ""),
  );
