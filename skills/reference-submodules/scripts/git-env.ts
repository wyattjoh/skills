import { execFile } from "node:child_process";

// Skills ship independently, so this duplicates the workspaces skill's key list.
const gitEnvKeys = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
]);

/**
 * Remove repository selectors and injected Git configuration, preserving credentials.
 */
export const cleanGitEnv = (env: NodeJS.ProcessEnv = process.env): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !gitEnvKeys.has(entry[0]) && !entry[0].startsWith("GIT_CONFIG_"),
    ),
  );

/**
 * Run Git in cwd with a sanitized environment and a bounded, noninteractive process.
 * Return its exit code and captured output, including diagnostics on timeout.
 */
export const spawnGit = (
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ exitCode: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        env: { ...cleanGitEnv(env), GIT_TERMINAL_PROMPT: "0" },
        // Two minutes bounds authentication/network stalls without limiting the whole workflow.
        timeout: 120_000,
        // ls-remote on large monorepos can return several megabytes of tags.
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) =>
        resolve({
          exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout,
          stderr: error ? `${stderr}\n${error.message}`.trim() : stderr,
        }),
    );
  });
