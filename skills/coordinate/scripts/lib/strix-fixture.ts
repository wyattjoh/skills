import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyBacklog } from "./backlog-store/ops.ts";
import { documentPath } from "./backlog-store/paths.ts";
import type { Backlog } from "./backlog-store/schema.ts";
import { tempDir } from "./fixture.ts";
import { cleanGitEnv, shellWord, spawnGit, UNSET_GIT } from "./git-env.ts";
import { spoken } from "./remote-launch.ts";
import { WATCHER_DOMAIN_LABEL } from "./watch-terminal.ts";

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
      `${UNSET_GIT}; ${script}`,
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
 * This Mac's Herdr core name: the home a coordinator on strix stores its documents on.
 * @returns The name, or undefined when `hc server status` cannot be read.
 */
export const thisCore = (): string | undefined => {
  const status = spawn(["hc", "server", "status", "--json"], hostEnv(), 15_000);
  try {
    return (JSON.parse(status.output) as { core: { name: string } }).core.name;
  } catch {
    return undefined;
  }
};

const SKILL_LINKS = [
  "~/.claude/skills/coordinate",
  "~/.pi/agent/skills/coordinate",
  "~/.agents/skills/coordinate",
] as const;

// One `key=value` line of a probe's output, or "" when it printed none.
const probeField = (probe: string, key: string): string =>
  probe
    .split("\n")
    .find((line) => line.startsWith(`${key}=`))
    ?.slice(key.length + 1)
    .trim() ?? "";

/**
 * What strix lacks to run a coordinator on the herdr-doc backend, read from the probe
 * `strixCoordinatorReadiness` runs there (`key=value` lines: route, bun, app, skill, prefix).
 * @param probe The probe's output.
 * @param home The home core's name.
 * @returns Each missing prerequisite, in a fixed order; empty when strix is ready.
 */
export const coordinatorMissing = (probe: string, home: string): string[] => {
  const field = (key: string) => probeField(probe, key);
  const route = field("route");
  const skill = field("skill");
  return [
    ...(route === "ok" ? [] : [`a Herdr route to ${home}'s store (${route || "no answer"})`]),
    ...(field("bun") === "" ? ["bun on its login PATH"] : []),
    ...(field("app") === "no"
      ? ["a herdr-app answering there (delegates get their own space)"]
      : []),
    ...(skill === ""
      ? [
          `the coordinate skill (no link at ${SKILL_LINKS.slice(0, -1).join(", ")} or ${SKILL_LINKS.at(-1)})`,
        ]
      : field("prefix") === "yes"
        ? []
        : [`a coordinate skill that knows state_prefix (${skill} predates it)`]),
  ];
};

/**
 * Whether strix can run a coordinator against this Mac's store: one read-only probe there for a
 * document read from this core (a throwaway name, never written), bun in the login shell
 * coordinate's preflight uses, herdr-app, and a coordinate skill link new enough to take
 * `state_prefix`. Call it only once `strixReadiness` is ready.
 * @returns Ready with the home, strix's skill folder and bun, or the one-line reason it skips.
 */
export const strixCoordinatorReadiness = ():
  | { ready: true; home: string; skill: string; bun: string }
  | { ready: false; reason: string } => {
  const home = thisCore();
  if (home === undefined)
    return { ready: false, reason: "this Mac's Herdr core name is unreadable" };
  const request = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "doc.get",
    params: { name: "ct000000.domains", on: home },
  });
  const probe = onStrix(
    [
      `reply=$(printf '%s\\n' ${shellWord(request)} | hc connect 2>&1 | tr '\\n' ' ')`,
      `case "$reply" in *'"result"'*) echo route=ok ;; *) printf 'route=%s\\n' "$reply" ;; esac`,
      "printf 'bun=%s\\n' \"$(\"${SHELL:-/bin/sh}\" -lc 'command -v bun' 2>/dev/null)\"",
      "if herdr-app ls >/dev/null 2>&1; then echo app=ok; else echo app=no; fi",
      "skill=",
      `for link in ${SKILL_LINKS.map((link) => `"$HOME"/${shellWord(link.slice(2))}`).join(" ")}; do`,
      '  if [ -e "$link" ]; then skill=$(cd "$link" && pwd -P); break; fi',
      "done",
      "printf 'skill=%s\\n' \"$skill\"",
      'if [ -n "$skill" ] && grep -q state_prefix "$skill/scripts/lib/config.ts"; then echo prefix=yes; else echo prefix=no; fi',
    ].join("\n"),
    40,
  );
  if (probe.exitCode !== 0)
    return { ready: false, reason: `strix is unreachable: ${probe.output.trim()}` };
  const missing = coordinatorMissing(probe.output, home);
  if (missing.length > 0) return { ready: false, reason: `strix lacks ${spoken(missing)}` };
  return {
    ready: true,
    home,
    skill: probeField(probe.output, "skill"),
    bun: probeField(probe.output, "bun"),
  };
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
): string[] => watchWith(run.cli, until, deadlineMs, passSeconds);

// `watchEvents` through any coordinate runner that adds the run's `--domain`.
const watchWith = (
  cli: (args: readonly string[], timeoutMs?: number) => Ran,
  until: (event: string) => boolean,
  deadlineMs: number,
  passSeconds: number,
): string[] => {
  const seen: string[] = [];
  const stop = Date.now() + deadlineMs;
  for (;;) {
    const ran = cli(
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
   * Run the coordinate CLI as given, without `--domain`, for commands that take none.
   */
  bare: (args: readonly string[], timeoutMs?: number) => Ran;
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
    bare: (args, timeoutMs = 30_000) => spawn(["bun", script, ...args], env, timeoutMs),
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
      // A coordinator started on strix arms a watcher terminal there, labelled by domain only.
      for (const listed of labelled(`${WATCHER_DOMAIN_LABEL}=${domain}`))
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

/**
 * Every document name a herdr-doc store under `prefix` can write for one domain: the index, the
 * policy, the domain's backlog, queue and claims, and the ended-record shards.
 * @param prefix Throwaway test prefix.
 * @param domain The run's domain.
 * @returns The names.
 */
export const testDocumentNames = (prefix: string, domain: string): string[] => [
  `${prefix}domains`,
  `${prefix}policy`,
  `${prefix}b.${domain}`,
  `${prefix}q.${domain}`,
  `${prefix}k.${domain}`,
  ...Array.from({ length: 8 }, (_, shard) => `${prefix}ended.${shard}`),
];

// One batch of document calls on this Mac's core through `hc connect`, replies by request.
const docCalls = (requests: readonly Record<string, unknown>[]): Record<string, unknown>[] => {
  if (requests.length === 0) return [];
  const input = requests
    .map((request, index) => `${JSON.stringify({ jsonrpc: "2.0", id: index + 1, ...request })}\n`)
    .join("");
  const done = Bun.spawnSync(["hc", "connect"], {
    env: hostEnv(),
    stdin: Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  const replies = done.stdout
    .toString()
    .split("\n")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as { id?: number; result?: Record<string, unknown> }];
      } catch {
        return [];
      }
    });
  return requests.map((_, index) => replies.find((reply) => reply.id === index + 1)?.result ?? {});
};

/**
 * Null every test document under `prefix` that holds a value. A name never written is left alone,
 * since nulling it would add a tombstone; the written ones keep theirs (Herdr cannot remove one).
 * @param prefix Throwaway test prefix (never `cs.`).
 * @param domain The run's domain.
 * @returns The names that still hold a value afterwards.
 */
export const nullTestDocuments = (prefix: string, domain: string): string[] => {
  if (prefix === "cs.") return ["refused to null production documents"];
  const names = testDocumentNames(prefix, domain);
  // A name with no reply (hc down, a refused call) counts as holding a value, so teardown never
  // reports clean on documents it could not read.
  const read = () =>
    docCalls(names.map((name) => ({ method: "doc.get", params: { name } }))).map((result) =>
      typeof result.version === "number"
        ? { value: result.value, version: result.version }
        : undefined,
    );
  const held = read().flatMap((result, index) =>
    result !== undefined && result.value === null
      ? []
      : [{ name: names[index] ?? "", version: result?.version }],
  );
  docCalls(
    held.flatMap(({ name, version }) =>
      version === undefined ? [] : [{ method: "doc.set", params: { name, value: null, version } }],
    ),
  );
  return read().flatMap((result, index) =>
    result !== undefined && result.value === null ? [] : [names[index] ?? ""],
  );
};

/**
 * A coordinator run on strix with the herdr-doc backend against this Mac's core, isolated like the
 * rest of the suite: its config and state under the run's strix folder, its documents under a
 * throwaway prefix, its archives in the run's state dir here.
 */
export type StrixCoordinator = {
  prefix: string;
  /**
   * Its placeholder terminal, as this Mac names it (`strix/tN`), and as strix names it.
   */
  address: string;
  bare: string;
  /**
   * Run strix's coordinate CLI as that terminal, with the run's config.
   */
  cli: (args: readonly string[], timeoutMs?: number) => Ran;
  /**
   * `watchEvents` for the coordinator on strix: one-shot passes there, which renew its lease.
   */
  watch: (until: (event: string) => boolean, deadlineMs: number, passSeconds?: number) => string[];
};

/**
 * Start a coordinator's placeholder terminal on strix and write its config there.
 * @param run The suite run (its domain, strix folder and state dir).
 * @param ready What `strixCoordinatorReadiness` found.
 * @param ready.home The home core's name.
 * @param ready.skill Strix's coordinate skill folder.
 * @param ready.bun Bun on strix's login PATH.
 * @returns The coordinator.
 */
export const strixCoordinator = (
  run: StrixRun,
  ready: { home: string; skill: string; bun: string },
): StrixCoordinator => {
  const prefix = `ct${run.id.slice(0, 6)}.`;
  const dir = `${run.remoteRoot}/coordinator`;
  const config = {
    state_dir: `${dir}/state`,
    backlog_dir: `${dir}/md`,
    state_backend: "herdr-doc",
    state_home: ready.home,
    state_prefix: prefix,
    // Archives append on the home: into the run's state dir there, never the live one.
    home_state_dir: run.stateDir,
    max_fleet_delegates_by_machine: { [STRIX]: 99, [ready.home]: 99 },
  };
  const wrote = onStrix(
    `mkdir -p ${shellWord(dir)} && printf '%s' ${shellWord(JSON.stringify(config))} > ${shellWord(`${dir}/config.json`)}`,
    15,
  );
  if (wrote.exitCode !== 0) throw new Error(`could not write the strix config: ${wrote.output}`);
  const address = run.placeholder(STRIX, {});
  const bare = address.slice(`${STRIX}/`.length);
  // ~/.local/bin leaves PATH, so `coordinate start` writes no PATH wrapper on strix; hc is passed
  // by its absolute path, as the Backlog panel passes it.
  const cli = (args: readonly string[], timeoutMs = 30_000): Ran =>
    onStrix(
      [
        `cd ${shellWord(run.remoteRoot)}`,
        "hc_path=$(command -v hc)",
        "PATH=$(printf '%s' \"$PATH\" | tr ':' '\\n' | grep -vx \"$HOME/.local/bin\" | paste -sd: -)",
        `COORDINATE_HC="$hc_path" COORDINATE_CONFIG=${shellWord(`${dir}/config.json`)} HC_TERMINAL_ID=${shellWord(bare)} exec ${[ready.bun, `${ready.skill}/scripts/coordinate.ts`, ...args].map(shellWord).join(" ")}`,
      ].join(" && "),
      Math.ceil(timeoutMs / 1000),
    );
  return {
    prefix,
    address,
    bare,
    cli,
    watch: (until, deadlineMs, passSeconds = 20) =>
      watchWith(
        (args, timeoutMs) => cli([...args, "--domain", run.domain], timeoutMs),
        until,
        deadlineMs,
        passSeconds,
      ),
  };
};
