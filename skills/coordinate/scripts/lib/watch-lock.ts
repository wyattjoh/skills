import { readFileSync, rmSync } from "node:fs";
import { mkdir, open, readFile, rm } from "node:fs/promises";
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

/**
 * Take the domain's watcher lock with O_EXCL. A stale file (dead pid, or a pid that is not a watcher) is
 * replaced once.
 * @param stateDir State dir.
 * @param domain Domain.
 * @param pid This process.
 * @returns `{ ok: true }`, or the pid already holding it.
 */
export const acquireLock = Effect.fn("acquireLock")(function* (
  stateDir: string,
  domain: string,
  pid: number,
) {
  const path = lockPath(stateDir, domain);
  return yield* Effect.promise(async () => {
    await mkdir(join(stateDir, "watch"), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(path, "wx");
        await handle.writeFile(`${pid}\n`);
        await handle.close();
        return { ok: true as const };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const holder = await readPid(path);
        if (holder !== undefined && holder !== pid && pidAlive(holder) && isWatcher(holder))
          return { ok: false as const, holder };
        await rm(path, { force: true });
      }
    }
    return { ok: false as const, holder: undefined };
  });
});

/**
 * Release the lock if this process holds it.
 * @param stateDir State dir.
 * @param domain Domain.
 * @param pid This process.
 */
export const releaseLock = Effect.fn("releaseLock")(function* (
  stateDir: string,
  domain: string,
  pid: number,
) {
  const path = lockPath(stateDir, domain);
  yield* Effect.promise(async () => {
    if ((await readPid(path)) === pid) await rm(path, { force: true });
  });
});

/**
 * Release the lock now, synchronously, for a signal handler that exits right after.
 * @param stateDir State dir.
 * @param domain Domain.
 * @param pid This process.
 */
export const releaseLockSync = (stateDir: string, domain: string, pid: number): void => {
  const path = lockPath(stateDir, domain);
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  if (Number(text.trim()) === pid) rmSync(path, { force: true });
};
