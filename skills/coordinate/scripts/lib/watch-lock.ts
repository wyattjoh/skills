import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";

/**
 * The watcher's pid file for a domain.
 * @param stateDir State dir.
 * @param domain Domain.
 * @returns Path.
 */
export const lockPath = (stateDir: string, domain: string): string =>
  join(stateDir, "watch", `${domain}.pid`);

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const isWatcher = (pid: number): boolean => {
  const ps = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], {
    env: { ...process.env },
    stdout: "pipe",
    stderr: "ignore",
    timeout: 5_000,
  });
  const command = ps.stdout.toString();
  return command.includes("coordinate") && command.includes("watch");
};

const readPid = async (path: string): Promise<number | undefined> => {
  const text = await readFile(path, "utf8").catch(() => "");
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
};

/**
 * The pid of the live watcher for a domain, if any.
 * @param stateDir State dir.
 * @param domain Domain.
 * @returns Pid, or undefined.
 */
export const watcherAlive = Effect.fn("watcherAlive")(function* (stateDir: string, domain: string) {
  const pid = yield* Effect.promise(() => readPid(lockPath(stateDir, domain)));
  return pid !== undefined && pidAlive(pid) && isWatcher(pid) ? pid : undefined;
});
