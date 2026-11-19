// Shared by the build and typecheck scripts: where this project is, and the root's tsc.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The Herdr project's folder.
 */
export const root = resolve(import.meta.dir, "..");

/**
 * The tsc binary from the nearest node_modules above this project. The project's own
 * install adds only @wyattjoh/herdr-ui; the repository root's install provides TypeScript.
 * @returns The binary's path.
 */
export const tscPath = (): string => {
  for (let dir = root; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules/.bin/tsc");
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) throw new Error("No node_modules/.bin/tsc above " + root);
  }
};

/**
 * Run a command to completion, inheriting output, with a fifteen-minute bound. herdr-app check
 * has taken over eleven minutes under heavy machine load, so a shorter bound fails good builds.
 * @param argv The command and its arguments.
 * @param env The environment to run it with.
 * @returns The exit code.
 */
export const run = async (
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): Promise<number> => {
  const child = Bun.spawn(argv, {
    cwd: root,
    env,
    stdout: "inherit",
    stderr: "inherit",
    timeout: 900_000,
  });
  return await child.exited;
};
