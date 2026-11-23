import { Effect } from "effect";
import { inside } from "./git.ts";
import * as hc from "./herdr.ts";
import { Proc } from "./proc.ts";

const HERDR_CORE = new Set(["hc", "herdr-core"]);
const HERDR_CORE_ARGS = /(?:^|\/)(?:hc|herdr-core) (?:hold|connect)(?:\s|$)/;
const HERDR_LAUNCHD = /(?:^|\/)(?:hc|herdr-core)(?:\s.*)?\s--hc-launchd(?:\s|$)/;
const ARGS_SHOWN = 100;

/**
 * A process and a folder it holds: `fd` is `cwd` for its working folder, `txt` for its executable
 * and mapped files.
 */
export type Held = { pid: string; command: string; fd: string; path: string };

/**
 * One line of `ps -axww -o pid=,ppid=,lstart=,args=`. `started` tells a process from a later one
 * that reused its pid.
 */
export type PsRow = { pid: string; ppid: string; started: string; args: string };

/**
 * Every process's folders and parent, with Herdr core's own pids.
 */
export type ProcessTable = { held: Held[]; ps: PsRow[]; core: Set<string> };

/**
 * How long a stopped process gets between SIGTERM and SIGKILL, and whose ancestry is never signalled.
 */
export type StopOptions = { graceMs: number; pollMs: number; selfPid: string };

/**
 * Three seconds of grace, checked every quarter second; this process's ancestry is protected.
 * @returns The options.
 */
export const defaultStop = (): StopOptions => ({
  graceMs: 3000,
  pollMs: 250,
  selfPid: String(process.pid),
});

/**
 * Parse `lsof -d cwd,txt -Fpcfn`.
 * @param text lsof output.
 * @returns Held folders.
 */
export const parseLsof = (text: string): Held[] => {
  const rows: Held[] = [];
  let pid = "";
  let command = "";
  let fd = "";
  for (const line of text.split("\n")) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      pid = value;
      fd = "";
    } else if (tag === "c") command = value;
    else if (tag === "f") fd = value;
    else if (tag === "n") rows.push({ pid, command, fd, path: value });
  }
  return rows;
};

/**
 * Parse `ps -axww -o pid=,ppid=,lstart=,args=`.
 * @param text ps output.
 * @returns One row per process.
 */
export const parsePs = (text: string): PsRow[] =>
  text.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3} +\d+ [\d:]+ \d{4})\s+(.*)$/.exec(line);
    return match
      ? [
          {
            pid: match[1] ?? "",
            ppid: match[2] ?? "",
            started: (match[3] ?? "").replace(/ +/g, " "),
            args: match[4] ?? "",
          },
        ]
      : [];
  });

/**
 * Herdr core's own processes, which hold live terminals and must never be offered for killing:
 * an `hc` or `herdr-core` executable run with `--hc-launchd`, `hold` or `connect`, plus the
 * direct children of a `--hc-launchd` server (its ssh connections to remote cores).
 * The basename comes from lsof's command field, because the executable path can hold spaces.
 * @param held Processes from lsof.
 * @param ps Processes from ps.
 * @returns Their pids.
 */
export const herdrCorePids = (held: readonly Held[], ps: readonly PsRow[]): Set<string> => {
  const named = new Set(
    held.filter((entry) => HERDR_CORE.has(entry.command)).map((entry) => entry.pid),
  );
  const core = ps.filter(
    (row) => named.has(row.pid) && (HERDR_CORE_ARGS.test(row.args) || HERDR_LAUNCHD.test(row.args)),
  );
  const servers = new Set(core.filter((row) => HERDR_LAUNCHD.test(row.args)).map((row) => row.pid));
  return new Set([
    ...core.map((row) => row.pid),
    ...ps.filter((row) => servers.has(row.ppid)).map((row) => row.pid),
  ]);
};

const ENV = (): Record<string, string> => ({ ...process.env }) as Record<string, string>;

const PS_ARGV = ["ps", "-axww", "-o", "pid=,ppid=,lstart=,args="];

const readPs = Effect.fn("readPs")(function* () {
  const proc = yield* Proc;
  const ps = yield* proc.run(PS_ARGV, { timeoutMs: 30_000, env: ENV() });
  if (ps.exitCode !== 0)
    return yield* new hc.HerdrError({
      command: "ps",
      kind: "command_failed",
      message: ps.stderr.slice(0, 200),
    });
  return parsePs(ps.stdout);
});

/**
 * Every process's folders (lsof) and parent (ps). Fails rather than guessing when either cannot be read.
 * @returns The table.
 */
export const scanProcesses = Effect.fn("scanProcesses")(function* () {
  const proc = yield* Proc;
  const lsof = yield* proc.run(["lsof", "-d", "cwd,txt", "-Fpcfn"], {
    timeoutMs: 30_000,
    env: ENV(),
  });
  // lsof exits 1 when some processes could not be read; its output is still complete for ours.
  if (lsof.exitCode > 1 || lsof.stdout === "")
    return yield* new hc.HerdrError({
      command: "lsof",
      kind: "command_failed",
      message: lsof.stderr.slice(0, 200),
    });
  const held = parseLsof(lsof.stdout);
  const ps = yield* readPs();
  return { held, ps, core: herdrCorePids(held, ps) } satisfies ProcessTable;
});

/**
 * A pid set and every descendant of it.
 * @param ps Processes.
 * @param roots Starting pids.
 * @returns The roots and their descendants.
 */
export const descendants = (ps: readonly PsRow[], roots: ReadonlySet<string>): Set<string> => {
  const found = new Set(roots);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of ps)
      if (!found.has(row.pid) && found.has(row.ppid)) {
        found.add(row.pid);
        grew = true;
      }
  }
  return found;
};

/**
 * A pid and its ancestors, up to launchd.
 * @param ps Processes.
 * @param pid Starting pid.
 * @returns The chain.
 */
export const ancestry = (ps: readonly PsRow[], pid: string): Set<string> => {
  const parents = new Map(ps.map((row) => [row.pid, row.ppid]));
  const chain = new Set<string>();
  let current: string | undefined = pid;
  while (current !== undefined && !chain.has(current)) {
    chain.add(current);
    current = parents.get(current);
  }
  return chain;
};

/**
 * Processes that provably belong to a folder: each whose working folder is inside it and whose every
 * ancestor below launchd works inside it too (so nothing a live terminal, editor or shell outside it
 * started, and no Herdr core process), plus their descendants. A process whose chain cannot be read
 * is not included.
 * @param table Process table.
 * @param folder Real path of the folder.
 * @returns Their pids, Herdr core excluded.
 */
export const ownedBy = (table: ProcessTable, folder: string): Set<string> => {
  const cwds = new Map(
    table.held.filter((entry) => entry.fd === "cwd").map((entry) => [entry.pid, entry.path]),
  );
  const rows = new Map(table.ps.map((row) => [row.pid, row]));
  const inFolder = (pid: string): boolean => {
    const cwd = cwds.get(pid);
    return cwd !== undefined && inside(cwd, folder) && !table.core.has(pid);
  };
  const rooted = (pid: string): boolean => {
    const seen = new Set<string>();
    let current = rows.get(pid);
    while (current !== undefined && !seen.has(current.pid)) {
      if (!inFolder(current.pid)) return false;
      if (current.ppid === "1") return true;
      seen.add(current.pid);
      current = rows.get(current.ppid);
    }
    return false;
  };
  const roots = new Set(table.ps.filter((row) => rooted(row.pid)).map((row) => row.pid));
  return new Set([...descendants(table.ps, roots)].filter((pid) => !table.core.has(pid)));
};

const shown = (row: PsRow): string =>
  row.args.length > ARGS_SHOWN ? `${row.args.slice(0, ARGS_SHOWN)}…` : row.args;

const same = (a: PsRow, b: PsRow): boolean => a.pid === b.pid && a.started === b.started;

const alive = (targets: readonly PsRow[], ps: readonly PsRow[]): PsRow[] =>
  targets.filter((target) => ps.some((row) => same(row, target)));

const signal = Effect.fn("signal")(function* (name: string, rows: readonly PsRow[]) {
  const proc = yield* Proc;
  // kill exits non-zero when one pid already exited; the next ps read says what still runs.
  yield* proc.run(["kill", `-${name}`, ...rows.map((row) => row.pid)], {
    timeoutMs: 10_000,
    env: ENV(),
  });
});

/**
 * Stop processes: SIGTERM, up to `graceMs` for them to exit, then SIGKILL for the rest. Each pid is
 * re-read first and signalled only while it is still the same process (same start time), never when it
 * is launchd, this process or one of its ancestors.
 * @param targets Processes to stop, as last read.
 * @param options Grace period and the protected pid.
 * @returns A line per process, and the ones still running.
 */
export const stopProcesses = Effect.fn("stopProcesses")(function* (
  targets: readonly PsRow[],
  options: StopOptions,
) {
  if (targets.length === 0) return { lines: [] as string[], survivors: [] as PsRow[] };
  const fresh = yield* readPs();
  const protectedPids = ancestry(fresh, options.selfPid);
  const lines: string[] = [];
  const live = alive(targets, fresh).filter((row) => {
    if (row.pid === "0" || row.pid === "1" || protectedPids.has(row.pid)) {
      lines.push(`left ${row.pid} ${shown(row)}: it runs this command`);
      return false;
    }
    return true;
  });
  if (live.length === 0) return { lines, survivors: [] as PsRow[] };
  yield* signal("TERM", live);
  let remaining = live;
  let waited = 0;
  do {
    yield* Effect.sleep(options.pollMs);
    remaining = alive(remaining, yield* readPs());
    waited += Math.max(options.pollMs, 1);
  } while (remaining.length > 0 && waited < options.graceMs);
  const hard = remaining;
  let survivors: PsRow[] = [];
  if (hard.length > 0) {
    yield* signal("KILL", hard);
    yield* Effect.sleep(options.pollMs);
    survivors = alive(hard, yield* readPs());
  }
  for (const row of live) {
    if (survivors.some((survivor) => same(survivor, row)))
      lines.push(`could not stop ${row.pid} ${shown(row)}: still running after SIGKILL`);
    else
      lines.push(
        `stopped ${row.pid} ${shown(row)}${hard.some((other) => same(other, row)) ? " (SIGKILL)" : ""}`,
      );
  }
  return { lines, survivors };
});

/**
 * What `coordinate end` stops once the terminal has ended: the terminal's process tree as read before
 * it ended (kept only when its root is a local Herdr terminal process, a child of Herdr core), plus
 * processes the delegate's own worktree provably holds (see `ownedBy`).
 * @param spec The terminal's root pid and the delegate's worktree (undefined when it has none of its own).
 * @param before The process table read before the terminal ended, when it could be read.
 * @param options Stop options.
 * @returns Lines to print.
 */
export const teardownEnded = Effect.fn("teardownEnded")(function* (
  spec: { name: string; rootPid: number | undefined; worktree: string | undefined },
  before: ProcessTable | undefined,
  options: StopOptions,
) {
  const notes: string[] = [];
  const targets = new Map<string, PsRow>();
  const root = spec.rootPid === undefined ? undefined : String(spec.rootPid);
  if (before === undefined)
    notes.push("  the process scan before ending failed, so its terminal's tree is unknown");
  else if (root !== undefined) {
    const row = before.ps.find((candidate) => candidate.pid === root);
    if (row === undefined || !before.core.has(row.ppid))
      notes.push(`  pid ${root} is not a local Herdr terminal process, so its tree was left alone`);
    else
      for (const pid of descendants(before.ps, new Set([root])))
        if (!before.core.has(pid)) {
          const found = before.ps.find((candidate) => candidate.pid === pid);
          if (found) targets.set(pid, found);
        }
  }
  if (spec.worktree !== undefined) {
    const after = yield* scanProcesses();
    for (const pid of ownedBy(after, spec.worktree)) {
      const found = after.ps.find((candidate) => candidate.pid === pid);
      if (found && !targets.has(pid)) targets.set(pid, found);
    }
  }
  const { lines } = yield* stopProcesses([...targets.values()], options);
  return lines.length === 0
    ? [`no processes of ${spec.name} were left running`, ...notes]
    : [`processes of ${spec.name}:`, ...lines.map((line) => `  ${line}`), ...notes];
});
