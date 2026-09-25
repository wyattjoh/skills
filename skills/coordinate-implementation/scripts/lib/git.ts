import { realpathSync } from "node:fs";

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
const GIT_CONFIG_ENV_PREFIX = "GIT_CONFIG_";

/**
 * Copies an environment without Git repository-location or injected
 * configuration overrides.
 *
 * @param env - Environment to sanitize.
 * @returns A complete string environment safe for repository discovery.
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
 * Runs one exact argument array with Git's repository-location variables removed, so a command
 * launched from a linked worktree hook cannot act on the caller's repository.
 *
 * @param argv - Exact command and arguments; never interpreted by a shell.
 * @param options - Optional working directory, base environment, and stdin text.
 * @returns The exit code and decoded output streams; a spawn failure reports exit code 127.
 */
export const spawnClean = (
  argv: string[],
  options: Partial<SpawnGitOptions> & { stdin?: string } = {},
): GitResult => {
  try {
    const child = Bun.spawnSync(argv, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: cleanGitEnv(options.env),
      ...(options.stdin === undefined ? {} : { stdin: new TextEncoder().encode(options.stdin) }),
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: child.exitCode,
      stdout: child.stdout.toString(),
      stderr: child.stderr.toString(),
    };
  } catch (error) {
    return { exitCode: 127, stdout: "", stderr: (error as Error).message };
  }
};

/**
 * Runs Git through {@link spawnClean} with commit signing disabled, so fixture commits cannot
 * invoke local signing agents.
 *
 * @param args - Exact Git argument array.
 * @param options - Optional working directory and base environment.
 * @returns The exit code and decoded output streams.
 */
export const spawnGit = (args: string[], options: Partial<SpawnGitOptions> = {}): GitResult =>
  spawnClean(["git", "-c", "commit.gpgsign=false", ...args], options);

/**
 * What Git reports about one checkout.
 */
export type CheckoutIdentity =
  | { ok: true; isRoot: boolean; branch: string | null }
  | { ok: false; stderr: string };

/**
 * Reports whether a path is the top level of a Git checkout and which branch it has checked out.
 *
 * @param path - Repository or worktree path.
 * @returns `isRoot` when the path is the checkout's top level, and the branch or null when
 * detached; or the Git error when the path is not inside a checkout.
 */
export const checkoutIdentity = (path: string): CheckoutIdentity => {
  const root = spawnGit(["rev-parse", "--show-toplevel"], { cwd: path });
  if (root.exitCode !== 0) return { ok: false, stderr: root.stderr };
  const branch = spawnGit(["symbolic-ref", "--short", "HEAD"], { cwd: path });
  return {
    ok: true,
    isRoot: realpathSync(root.stdout.trim()) === realpathSync(path),
    branch: branch.exitCode === 0 ? branch.stdout.trim() : null,
  };
};
