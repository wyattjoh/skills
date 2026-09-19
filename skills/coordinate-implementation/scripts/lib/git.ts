/**
 * Environment variables that redirect Git away from its argument or working directory.
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
 * Copies an environment without Git repository-location overrides.
 *
 * @param env - Environment to sanitize.
 * @returns A complete string environment safe for repository discovery.
 */
export const cleanGitEnv = (
  env: Record<string, string | undefined> = process.env,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !gitEnvKeys.has(entry[0]),
    ),
  );

/**
 * Captured result from one Git process.
 */
export type GitResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/**
 * Options accepted by the sanitized Git process boundary.
 */
export type SpawnGitOptions = {
  cwd: string | undefined;
  env: Record<string, string | undefined> | undefined;
};

/**
 * Runs Git with repository-location variables removed from its environment.
 *
 * @param args - Exact Git argument array.
 * @param options - Optional working directory and base environment.
 * @returns The exit code and decoded output streams.
 */
export const spawnGit = (args: string[], options: Partial<SpawnGitOptions> = {}): GitResult => {
  try {
    const child = Bun.spawnSync(["git", ...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: cleanGitEnv(options.env),
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: child.exitCode,
      stdout: child.stdout.toString(),
      stderr: child.stderr.toString(),
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: (error as Error).message,
    };
  }
};
