/**
 * Environment variables that tell git which repository to operate on.
 *
 * `git -C <dir>` does **not** override these. When `GIT_DIR` is set, git
 * resolves the repository from the environment and treats `-C` as a plain
 * chdir, so a command that names a fixture directory still reads and writes
 * the repository the environment points at.
 *
 * This matters because git exports `GIT_DIR` (and often `GIT_INDEX_FILE`) into
 * hook environments, and lefthook runs `bun test` from `pre-push`. Any test
 * that shells out to git therefore inherits a pointer to the developer's real
 * repository. `git init` is the worst of them: it silently re-inits `GIT_DIR`
 * instead of creating the fixture, and when `GIT_DIR` is a linked worktree's
 * gitdir the re-init has no work tree and writes `core.bare=true` into the
 * shared config.
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

/**
 * Copies `env` without the repository-location variables, so a spawned git
 * discovers its repository from the arguments and working directory alone.
 *
 * Identity variables (`GIT_AUTHOR_*`, `GIT_COMMITTER_*`) are deliberately kept:
 * they only supply a committer name, and dropping them can leave git with no
 * identity at all.
 */
export const cleanGitEnv = (
  env: Record<string, string | undefined> = process.env,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !gitEnvKeys.has(entry[0]),
    ),
  );

export type GitResult = { exitCode: number; stdout: string; stderr: string };

export type SpawnGitOptions = {
  cwd?: string;
  /** Base environment to sanitize. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
};

/**
 * Runs git with a sanitized environment. Every git spawn in this skill goes
 * through here so the sanitizing happens once, at the spawn boundary, rather
 * than being remembered at each call site.
 */
export const spawnGit = (args: string[], options: SpawnGitOptions = {}): GitResult => {
  const result = Bun.spawnSync(["git", ...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: cleanGitEnv(options.env),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};
