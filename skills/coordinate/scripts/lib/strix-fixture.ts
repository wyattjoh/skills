import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyBacklog } from "./backlog-store/ops.ts";
import { documentPath } from "./backlog-store/paths.ts";
import type { Backlog } from "./backlog-store/schema.ts";
import { tempDir } from "./fixture.ts";
import { cleanGitEnv } from "./git-env.ts";

// Helpers for the real-strix integration suite. Every remote call has an explicit timeout, every
// run owns a unique domain, state dir and strix folder, and teardown removes what the run made.

/**
 * The Herdr machine the suite runs against.
 */
export const STRIX = "strix";

/**
 * Every throwaway folder the suite makes on strix starts with this prefix, and teardown removes
 * nothing else.
 */
const REMOTE_PREFIX = "/tmp/coordinate-strix-";
const REMOTE_ROOT = /^\/tmp\/coordinate-strix-[0-9a-f]{12}$/;

/**
 * One finished command: its exit code (null when it timed out) and merged output.
 */
export type Ran = { exitCode: number | null; output: string };

const spawn = (argv: readonly string[], env: Record<string, string>, timeoutMs: number): Ran => {
  const done = Bun.spawnSync([...argv], {
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
  });
  return {
    exitCode: done.exitCode,
    output: done.stdout.toString() + done.stderr.toString(),
  };
};

// The Mac-side environment for real hc calls: no repository-location variables, and no
// HC_TERMINAL_ID, so the suite never acts as the terminal it runs in.
const hostEnv = (): Record<string, string> => {
  const env = cleanGitEnv(process.env);
  delete env.HC_TERMINAL_ID;
  return env;
};

/**
 * Run a POSIX shell script on strix through `hc exec`, in a login shell so the harness and git
 * are on PATH, with git's repository-location variables unset.
 * @param script Shell script.
 * @param timeoutS Remote timeout in seconds (hc's own limit is 600).
 * @returns Exit code and output.
 */
export const onStrix = (script: string, timeoutS = 30): Ran =>
  spawn(
    [
      "hc",
      "exec",
      "--on",
      STRIX,
      "--timeout",
      String(timeoutS),
      "--",
      "sh",
      "-lc",
      `unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CEILING_DIRECTORIES; ${script}`,
    ],
    hostEnv(),
    (timeoutS + 10) * 1000,
  );

/**
 * Quote a string as one POSIX shell word.
 * @param value Any string.
 * @returns The quoted word.
 */
export const shellWord = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Whether the suite can run, and why not. Nothing remote is called unless COORDINATE_STRIX=1.
 * @returns Ready, or the one-line reason it skips.
 */
export const strixReadiness = (): { ready: true } | { ready: false; reason: string } => {
  if (process.env.COORDINATE_STRIX !== "1")
    return { ready: false, reason: "set COORDINATE_STRIX=1 to run it against strix" };
  const listed = spawn(["hc", "machine", "ls", "--json"], hostEnv(), 15_000);
  let state: string | undefined;
  try {
    const parsed = JSON.parse(listed.output) as { machines: { name: string; state: string }[] };
    state = parsed.machines.find((machine) => machine.name === STRIX)?.state;
  } catch {
    return { ready: false, reason: `hc machine ls failed: ${listed.output.trim()}` };
  }
  if (state !== "connected")
    return { ready: false, reason: `strix is ${state ?? "not a registered Herdr machine"}` };
  const probe = onStrix(
    "for tool in claude git; do command -v $tool >/dev/null || echo missing $tool; done",
    20,
  );
  if (probe.exitCode !== 0)
    return { ready: false, reason: `strix is unreachable: ${probe.output.trim()}` };
  const missing = probe.output.trim();
  if (missing !== "") return { ready: false, reason: `strix lacks prerequisites: ${missing}` };
  return { ready: true };
};

/**
 * A trivial brief for a real Claude Code delegate on strix: one report line, one outbox line, one
 * commit, then stop.
 */
const TRIVIAL_BRIEF = [
  "# Brief: strix suite check",
  "",
  "Write .scratch/REPORT.md containing exactly one line: done.",
  'Append one line to .scratch/OUTBOX.jsonl: {"type":"notify","text":"done"}',
  "Create hello.txt containing hello, commit it with the message test: hello, then stop.",
  "Do nothing else.",
  "",
].join("\n");

/**
 * One isolated suite run: a unique domain, a sandboxed state dir on this Mac, a throwaway folder on
 * strix, and what teardown must remove.
 */
export type StrixRun = {
  id: string;
  domain: string;
  stateDir: string;
  remoteRoot: string;
  brief: string;
  /**
   * Environment for spawning the coordinate CLI: real hc, sandboxed config and state, no
   * HC_TERMINAL_ID.
   */
  env: Record<string, string>;
  /**
   * Write the domain's backlog document directly (no coordinate start, which would label and
   * launch real terminals).
   */
  seed: (boundary: Backlog["boundary"]) => void;
  /**
   * Run the coordinate CLI with `--domain` appended.
   */
  cli: (args: readonly string[], timeoutMs?: number) => Ran;
  /**
   * Make a git repository with one commit on main under the strix folder.
   */
  remoteRepo: (name: string) => string;
  /**
   * Record a terminal (a `strix/tN` address) or a Herdr space id the run made, for teardown.
   */
  trackTerminal: (address: string) => void;
  trackSpace: (id: string) => void;
  /**
   * Remove every tracked terminal and space, the strix folder and the state dir. Never throws;
   * returns what it could not remove.
   */
  teardown: () => string[];
};

/**
 * Start an isolated suite run. Call its teardown from afterAll.
 * @returns The run.
 */
export const strixRun = (): StrixRun => {
  const id = randomBytes(6).toString("hex");
  const domain = `strix-${id}`;
  const stateDir = tempDir("coordinate-strix-");
  const remoteRoot = `${REMOTE_PREFIX}${id}`;
  const configFile = join(stateDir, "config.json");
  writeFileSync(
    configFile,
    JSON.stringify({ state_dir: stateDir, backlog_dir: join(stateDir, "md") }),
  );
  // COORDINATE_CONFIG points every coordinate path at the sandbox. XDG_STATE_HOME stays real:
  // hc finds its herdr-core socket under it, and coordinate itself never reads it.
  const env = { ...hostEnv(), COORDINATE_CONFIG: configFile };
  const terminals: string[] = [];
  const spaces: string[] = [];
  const script = join(import.meta.dir, "..", "coordinate.ts");
  const made = onStrix(`mkdir -p ${shellWord(remoteRoot)}`, 15);
  if (made.exitCode !== 0) throw new Error(`could not make ${remoteRoot} on strix: ${made.output}`);
  return {
    id,
    domain,
    stateDir,
    remoteRoot,
    brief: TRIVIAL_BRIEF,
    env,
    seed: (boundary) => {
      mkdirSync(join(stateDir, "backlogs"), { recursive: true });
      writeFileSync(
        documentPath(stateDir, domain),
        `${JSON.stringify({ ...emptyBacklog(domain, null), boundary }, null, 2)}\n`,
      );
    },
    cli: (args, timeoutMs = 30_000) =>
      spawn(["bun", script, ...args, "--domain", domain], env, timeoutMs),
    remoteRepo: (name) => {
      const repo = `${remoteRoot}/${name}`;
      const ran = onStrix(
        [
          `mkdir -p ${shellWord(repo)}`,
          `cd ${shellWord(repo)}`,
          "git init -q -b main",
          "git config core.excludesFile /dev/null",
          "printf 'hello\\n' > README.md",
          "git add README.md",
          "git -c user.name=Test -c user.email=test@example.com -c commit.gpgsign=false commit -q -m init",
        ].join(" && "),
        30,
      );
      if (ran.exitCode !== 0) throw new Error(`could not make ${repo} on strix: ${ran.output}`);
      return repo;
    },
    trackTerminal: (address) => {
      terminals.push(address);
    },
    trackSpace: (space) => {
      spaces.push(space);
    },
    teardown: () => {
      const left: string[] = [];
      for (const address of terminals) {
        spawn(["hc", "kill", address], hostEnv(), 15_000);
        const removed = spawn(["hc", "rm", address], hostEnv(), 15_000);
        if (removed.exitCode !== 0 && !removed.output.includes("not_found"))
          left.push(`terminal ${address}: ${removed.output.trim()}`);
      }
      for (const space of spaces) {
        const closed = spawn(
          ["herdr-app", "do", "space.close", JSON.stringify({ id: space, confirmed: true })],
          hostEnv(),
          15_000,
        );
        if (closed.exitCode !== 0) left.push(`space ${space}: ${closed.output.trim()}`);
      }
      if (REMOTE_ROOT.test(remoteRoot)) {
        const removed = onStrix(`rm -rf ${shellWord(remoteRoot)}`, 30);
        if (removed.exitCode !== 0) left.push(`strix ${remoteRoot}: ${removed.output.trim()}`);
      } else left.push(`strix ${remoteRoot}: not a suite folder, left in place`);
      rmSync(stateDir, { recursive: true, force: true });
      return left;
    },
  };
};
