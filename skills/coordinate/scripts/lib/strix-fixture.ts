import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyBacklog } from "./backlog-store/ops.ts";
import { documentPath } from "./backlog-store/paths.ts";
import type { Backlog } from "./backlog-store/schema.ts";
import { tempDir } from "./fixture.ts";
import { cleanGitEnv, spawnGit } from "./git-env.ts";

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
 * The label every placeholder terminal the suite starts carries, valued with the run id.
 */
export const SUITE_LABEL = "coordinate.strix-suite";

// Terminals (here and on connected machines) carrying a label, finished ones included.
const labelled = (label: string): { address: string }[] => {
  const listed = spawn(["hc", "ls", "--json", "--all", "--label", label], hostEnv(), 20_000);
  try {
    return (JSON.parse(listed.output) as { terminals: { address: string }[] }).terminals;
  } catch {
    return [];
  }
};

// The fleet.space label of each terminal: the Herdr space a launch made for it.
const suiteSpaces = (addresses: readonly string[]): string[] =>
  addresses.flatMap((address) => {
    const got = spawn(["hc", "get", address, "--json"], hostEnv(), 15_000);
    try {
      const space = (JSON.parse(got.output) as { labels?: Record<string, string> }).labels?.[
        "fleet.space"
      ];
      return space === undefined ? [] : [space];
    } catch {
      return [];
    }
  });

// The ids of the spaces open in the Herdr window.
const openSpaces = (): Set<string> => {
  const listed = spawn(["herdr-app", "ls"], hostEnv(), 15_000);
  try {
    return new Set(
      (JSON.parse(listed.output) as { spaces: { id: string }[] }).spaces.map((space) => space.id),
    );
  } catch {
    return new Set();
  }
};

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
 * One watch event line as `coordinate watch` prints it, without its delivery id.
 * @param line A printed line.
 * @returns The event text.
 */
const eventText = (line: string): string => line.replace(/ id="e[0-9a-z]+"/u, "");

/**
 * Run one-shot `coordinate watch` passes for the run's domain until an event matches or the
 * deadline passes. Each pass returns at its first tick with events, or after `passSeconds`.
 * @param run The suite run.
 * @param until Stop once an event text satisfies this.
 * @param deadlineMs Give up after this long.
 * @param passSeconds How long one pass waits for events.
 * @returns Every event seen, without ids, in order.
 */
export const watchEvents = (
  run: StrixRun,
  until: (event: string) => boolean,
  deadlineMs: number,
  passSeconds = 20,
): string[] => {
  const seen: string[] = [];
  const stop = Date.now() + deadlineMs;
  for (;;) {
    const ran = run.cli(
      ["watch", "--interval", "2", "--max-minutes", String(passSeconds / 60)],
      (passSeconds + 40) * 1000,
    );
    seen.push(
      ...ran.output
        .split("\n")
        .filter((line) => line.startsWith("<event "))
        .map(eventText),
    );
    if (seen.some(until) || Date.now() >= stop) return seen;
  }
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
   * Environment for spawning the coordinate CLI: real hc, sandboxed config and state, and no
   * HC_TERMINAL_ID until `becomeCoordinator` sets the run's own coordinator placeholder.
   */
  env: Record<string, string>;
  /**
   * Write the domain's backlog document directly (no coordinate start, which would label and
   * launch real terminals).
   */
  seed: (boundary: Backlog["boundary"]) => void;
  /**
   * Run the coordinate CLI with `--domain` appended, as the run's coordinator once
   * `becomeCoordinator` has made one.
   */
  cli: (args: readonly string[], timeoutMs?: number) => Ran;
  /**
   * Merge keys into the sandbox config file (`state_dir` and `backlog_dir` stay).
   */
  configure: (extra: Record<string, unknown>) => void;
  /**
   * Start a local placeholder terminal labelled as the domain's coordinator, and run the CLI from
   * it from now on.
   * @returns Its address.
   */
  becomeCoordinator: () => string;
  /**
   * Start a placeholder terminal (`sleep`) on this machine (`machine` undefined) or on another one,
   * with labels; tracked for teardown.
   * @returns Its address.
   */
  placeholder: (machine: string | undefined, labels: Record<string, string>) => string;
  /**
   * Make a git repository with one commit on main under the strix folder.
   */
  remoteRepo: (name: string) => string;
  /**
   * Copy a local repository's history to a new repository under the strix folder (moved as a
   * base64 bundle through `hc file write`), checked out on main with no remote, its own commit
   * identity and signing off, so a bundle relative to its commits fetches back into the original.
   */
  remoteClone: (local: string, name: string) => string;
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
  // COORDINATE_CONFIG points every coordinate path at the sandbox. XDG_STATE_HOME stays real:
  // hc finds its herdr-core socket under it, and coordinate itself never reads it.
  const env: Record<string, string> = { ...hostEnv(), COORDINATE_CONFIG: configFile };
  let config: Record<string, unknown> = { state_dir: stateDir, backlog_dir: join(stateDir, "md") };
  const terminals: string[] = [];
  const spaces: string[] = [];
  const script = join(import.meta.dir, "..", "coordinate.ts");
  writeFileSync(configFile, JSON.stringify(config));
  let placeholders = 0;
  const placeholder = (machine: string | undefined, labels: Record<string, string>): string => {
    placeholders += 1;
    const started = spawn(
      [
        "hc",
        "run",
        "--bg",
        "--json",
        "--name",
        `sx-${id}-${placeholders}`,
        "--no-parent",
        ...(machine === undefined ? [] : ["--on", machine]),
        ...Object.entries({ ...labels, [SUITE_LABEL]: id }).flatMap(([key, value]) => [
          "--label",
          `${key}=${value}`,
        ]),
        "--",
        "sleep",
        "1800",
      ],
      hostEnv(),
      20_000,
    );
    if (started.exitCode !== 0) throw new Error(`could not start a placeholder: ${started.output}`);
    const address = (JSON.parse(started.output) as { address: string }).address;
    terminals.push(address);
    return address;
  };
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
    configure: (extra) => {
      config = { ...config, ...extra };
      writeFileSync(configFile, JSON.stringify(config));
    },
    becomeCoordinator: () => {
      const address = placeholder(undefined, {
        "fleet.role": "coordinator",
        "fleet.domain": domain,
      });
      env.HC_TERMINAL_ID = address;
      return address;
    },
    placeholder,
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
    remoteClone: (local, name) => {
      const repo = `${remoteRoot}/${name}`;
      const bundle = join(stateDir, `${name}.bundle`);
      const bundled = spawnGit(["-C", local, "bundle", "create", "-q", bundle, "--all"]);
      if (bundled.exitCode !== 0) throw new Error(`could not bundle ${local}: ${bundled.stderr}`);
      const encoded = `${repo}.b64`;
      const wrote = Bun.spawnSync(["hc", "file", "write", "--on", STRIX, encoded], {
        env: hostEnv(),
        stdin: Buffer.from(readFileSync(bundle).toString("base64")),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
      });
      if (wrote.exitCode !== 0)
        throw new Error(`could not write ${encoded} on strix: ${wrote.stderr.toString()}`);
      const ran = onStrix(
        [
          `base64 -d ${shellWord(encoded)} > ${shellWord(`${repo}.bundle`)}`,
          `git clone -q -b main ${shellWord(`${repo}.bundle`)} ${shellWord(repo)}`,
          `cd ${shellWord(repo)}`,
          "git remote remove origin",
          "git config core.excludesFile /dev/null",
          "git config user.name Test",
          "git config user.email test@example.com",
          "git config commit.gpgsign false",
          `rm -f ${shellWord(encoded)} ${shellWord(`${repo}.bundle`)}`,
        ].join(" && "),
        60,
      );
      if (ran.exitCode !== 0)
        throw new Error(`could not clone into ${repo} on strix: ${ran.output}`);
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
      // A CLI call that timed out after launching left no address behind: find what it started by
      // the run's own domain label, here and on strix.
      for (const listed of labelled(`fleet.domain=${domain}`))
        if (!terminals.includes(listed.address)) terminals.push(listed.address);
      for (const listed of labelled(`${SUITE_LABEL}=${id}`))
        if (!terminals.includes(listed.address)) terminals.push(listed.address);
      for (const space of suiteSpaces(terminals)) if (!spaces.includes(space)) spaces.push(space);
      // Spaces first: closing one ends its terminals, which are then removed below.
      const open = openSpaces();
      for (const space of spaces) {
        if (!open.has(space)) continue;
        const closed = spawn(
          ["herdr-app", "do", "space.close", JSON.stringify({ id: space, confirmed: true })],
          hostEnv(),
          15_000,
        );
        if (closed.exitCode !== 0) left.push(`space ${space}: ${closed.output.trim()}`);
      }
      for (const address of terminals) {
        spawn(["hc", "kill", address], hostEnv(), 15_000);
        const removed = spawn(["hc", "rm", address], hostEnv(), 15_000);
        if (removed.exitCode !== 0 && !removed.output.includes("not_found"))
          left.push(`terminal ${address}: ${removed.output.trim()}`);
      }
      if (REMOTE_ROOT.test(remoteRoot)) {
        // Claude Code keeps a session folder named after the worktree path, which holds the run id.
        const removed = onStrix(
          `rm -rf ${shellWord(remoteRoot)} "$HOME"/.claude/projects/-tmp-coordinate-strix-${id}-*`,
          30,
        );
        if (removed.exitCode !== 0) left.push(`strix ${remoteRoot}: ${removed.output.trim()}`);
      } else left.push(`strix ${remoteRoot}: not a suite folder, left in place`);
      rmSync(stateDir, { recursive: true, force: true });
      return left;
    },
  };
};

/**
 * Answer Claude Code's folder trust dialog in a terminal the suite launched, when its screen shows
 * that dialog for exactly that folder: a fresh /tmp worktree on strix is never trusted yet, and in
 * real use the dialog is the user's to answer. Claude Code then records the trust in strix's
 * ~/.claude.json, which the suite does not edit.
 * @param address The suite's own terminal (`strix/tN`).
 * @param folder The folder the dialog must name.
 * @returns Whether the dialog was there and answered.
 */
export const answerTrustDialog = (address: string, folder: string): boolean => {
  const screen = spawn(["hc", "read", address, "--lines", "60"], hostEnv(), 15_000).output;
  const asking =
    screen.includes("Accessing workspace:") &&
    screen.includes(folder) &&
    screen.includes("Yes, I trust this folder");
  if (!asking) return false;
  return spawn(["hc", "keys", address, "down", "enter"], hostEnv(), 15_000).exitCode === 0;
};
