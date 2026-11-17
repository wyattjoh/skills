/**
 * Environment variables that tell git which repository to operate on.
 *
 * `git -C <dir>` and a spawn `cwd` do not override these: when `GIT_DIR` is
 * set, git resolves the repository from the environment. Git exports them into
 * hook environments, and lefthook runs `bun test` from `pre-push`, so every
 * git spawn strips them. Copied from the workspaces skill, since skills ship
 * independently.
 */
export const GIT_ENV_KEYS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
] as const;

const gitEnvKeys: ReadonlySet<string> = new Set(GIT_ENV_KEYS);
const GIT_CONFIG_ENV_PREFIX = "GIT_CONFIG_";

/**
 * Copies `env` without repository-location or injected Git configuration
 * variables. Identity variables (`GIT_AUTHOR_*`, `GIT_COMMITTER_*`) are kept.
 * @param env Base environment.
 * @returns The sanitized environment.
 */
export const cleanGitEnv = (
  env: Record<string, string | undefined> = process.env,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !gitEnvKeys.has(entry[0]) &&
        !entry[0].startsWith(GIT_CONFIG_ENV_PREFIX),
    ),
  );

/**
 * One synchronous git result.
 */
export type GitResult = { exitCode: number; stdout: string; stderr: string };

/**
 * Runs git synchronously with a sanitized environment and commit signing
 * disabled. Test fixtures use this; library code goes through `Proc`.
 * @param args Git arguments.
 * @param options Working directory and base environment.
 * @returns Exit code and output.
 */
export const spawnGit = (
  args: string[],
  options: { cwd: string | undefined; env: Record<string, string | undefined> | undefined } = {
    cwd: undefined,
    env: undefined,
  },
): GitResult => {
  const result = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: cleanGitEnv(options.env ?? process.env),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};
