import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe } from "bun:test";
import { Effect, Layer } from "effect";
import { spawnGit } from "./git-env.ts";
import type { StateBackend } from "./config.ts";
import { type FakeDocCores, fakeDocCores, fileDocTransport } from "./herdr-docs-fake.ts";
import { coreStatus, FAKE_CORE, isCoreNameRead, Proc, realProc, type RunOutput } from "./proc.ts";
import { registerStateStore } from "./state.ts";
import { filesPath } from "./state-files.ts";
import { documentAddress, herdrStore, PRODUCTION_PREFIX } from "./state-herdr.ts";
import type { StateKey } from "./state-store.ts";

/**
 * The home machine `cliEnv` names for the herdr-doc backend.
 */
export const FAKE_HOME = "homebase";

/**
 * A fresh temporary directory (real path).
 * @param prefix Name prefix.
 * @returns Path.
 */
export const tempDir = (prefix = "coordinate-"): string =>
  realpathSync(mkdtempSync(join(tmpdir(), prefix)));

/**
 * Run git in a fixture through the sanitized spawn; throws on failure.
 * @param cwd Directory.
 * @param args Git arguments.
 * @returns Trimmed stdout.
 */
export const g = (cwd: string, ...args: string[]): string => {
  const result = spawnGit(["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    env: process.env,
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

/**
 * A repository with one commit on `main`.
 * @returns Its path.
 */
export const initRepo = (): string => {
  const repo = tempDir("coordinate-repo-");
  g(repo, "init", "-q", "-b", "main");
  // The developer's global excludes (often ignoring .scratch/) must not leak into fixtures.
  g(repo, "config", "core.excludesFile", "/dev/null");
  writeFileSync(join(repo, "README.md"), "hello\n");
  g(repo, "add", "README.md");
  g(repo, "commit", "-q", "-m", "init");
  return repo;
};

/**
 * Write a file and commit it.
 * @param dir Checkout.
 * @param name File name.
 * @param content Content.
 * @param message Commit message.
 */
export const commitFile = (
  dir: string,
  name: string,
  content: string,
  message = `add ${name}`,
): void => {
  writeFileSync(join(dir, name), content);
  g(dir, "add", name);
  g(dir, "commit", "-q", "-m", message);
};

/**
 * Run an effect that needs `Proc` with the real layer, or a given one.
 * @param effect Effect.
 * @param layer Proc layer.
 * @returns Its value.
 */
export const runWith = <A, E>(
  effect: Effect.Effect<A, E, Proc>,
  layer: Layer.Layer<Proc> = Proc.layer,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(layer)));

/**
 * Run an effect and return its failure (or "no failure").
 * @param effect Effect.
 * @param layer Proc layer.
 * @returns The error value.
 */
export const failureOf = <A, E>(
  effect: Effect.Effect<A, E, Proc>,
  layer: Layer.Layer<Proc> = Proc.layer,
): Promise<E | "no failure"> =>
  Effect.runPromise(
    effect.pipe(
      Effect.flip,
      Effect.catch(() => Effect.succeed("no failure" as const)),
      Effect.provide(layer),
    ),
  ) as Promise<E | "no failure">;

/**
 * A `Proc` that runs git for real and answers every other program with `answer`.
 * @param answer Answers for hc, herdr-app, lsof, gh, forgejo, du. The core-name read
 * (`hc server status`) is answered with `FAKE_CORE` before `answer` sees it.
 * @returns The layer and the non-git calls.
 */
export const gitAndFake = (
  answer: (argv: readonly string[]) => RunOutput,
): { layer: Layer.Layer<Proc>; calls: string[][] } => {
  const calls: string[][] = [];
  const layer = Layer.succeed(
    Proc,
    Proc.of({
      run: (argv, options) => {
        if (argv[0] === "git") return realProc.run(argv, options);
        calls.push([...argv]);
        if (isCoreNameRead(argv)) return Effect.succeed(coreStatus(FAKE_CORE));
        return Effect.succeed(answer(argv));
      },
    }),
  );
  return { layer, calls };
};

/**
 * Both state backends, in the order `eachBackend` runs them.
 */
export const BACKENDS: readonly StateBackend[] = ["files", "herdr-doc"];

let backendInUse: StateBackend | undefined;

/**
 * Run a describe block once per backend (named `<name> on <backend>`): inside it, `cliEnv` and
 * `cliState` default to that backend, so the same CLI tests cover files and herdr-doc.
 * @param name Block name.
 * @param body The block's tests, given the backend.
 */
export const eachBackend = (name: string, body: (backend: StateBackend) => void): void =>
  describe.each([...BACKENDS])(`${name} on %s`, (backend) => {
    beforeAll(() => {
      backendInUse = backend;
    });
    afterAll(() => {
      backendInUse = undefined;
    });
    body(backend);
  });

/**
 * The backend `cliEnv` uses by default: the one `eachBackend` runs, else files.
 * @returns The backend.
 */
export const testBackend = (): StateBackend => backendInUse ?? "files";

const noRemote = () => Effect.succeed(undefined);

/**
 * Point `state` at a backend: write the config file the CLI reads, and on herdr-doc the fake
 * cores (kept when present) and a coordinate skill link, and register an in-process herdr-doc
 * store over those cores (on `home`, as this core `FAKE_CORE`), so seeds and reads made through
 * lib functions or `readState` see the documents the spawned CLI sees. Archives on another home
 * are dropped and read as absent, as the `hc` stub does. `cliEnv` calls this; call it first when
 * a test seeds state before building the environment.
 * @param state State dir.
 * @param stateBackend Which backend the config selects.
 * @param home The herdr-doc home: `FAKE_HOME` (another machine), or `FAKE_CORE` for this one.
 */
export const cliState = (
  state: string,
  stateBackend: StateBackend = testBackend(),
  home: string = FAKE_HOME,
): void => {
  const configFile = join(state, "config.json");
  const docs = join(state, "herdr-docs.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      state_dir: state,
      backlog_dir: join(state, "md"),
      ...(stateBackend === "herdr-doc" ? { state_backend: "herdr-doc", state_home: home } : {}),
    }),
  );
  if (stateBackend !== "herdr-doc") return;
  // A coordinator machine on the herdr-doc backend needs a coordinate skill link (preflight).
  const skillLink = join(state, "home", ".claude", "skills", "coordinate");
  if (!existsSync(skillLink)) {
    mkdirSync(join(skillLink, ".."), { recursive: true });
    symlinkSync(join(import.meta.dir, "..", ".."), skillLink);
  }
  // Kept across calls: a test may build the environment again for each command.
  if (!existsSync(docs))
    writeFileSync(
      docs,
      JSON.stringify(fakeDocCores(FAKE_CORE, { [FAKE_HOME]: "up", strix: "up" })),
    );
  registerStateStore(
    state,
    herdrStore({
      home,
      prefix: PRODUCTION_PREFIX,
      transport: fileDocTransport(docs),
      self: Effect.succeed(FAKE_CORE),
      stateDir: state,
      appendRemote: () => Effect.void,
      readRemote: noRemote,
    }),
  );
};

type CliConfigFile = { state_backend?: string; state_home?: string; state_prefix?: string };

// Where a key of `state` is kept: a file, or a document (and field) in the fake cores file.
type Slot =
  | { kind: "file"; file: string }
  | { kind: "doc"; cores: string; home: string; name: string; field: string | undefined };

const slotOf = (state: string, key: StateKey): Slot => {
  const config = JSON.parse(readFileSync(join(state, "config.json"), "utf8")) as CliConfigFile;
  const address =
    config.state_backend === "herdr-doc"
      ? documentAddress(config.state_prefix ?? PRODUCTION_PREFIX, key)
      : undefined;
  if (address === undefined) return { kind: "file", file: filesPath(state, key) };
  return {
    kind: "doc",
    cores: join(state, "herdr-docs.json"),
    home: config.state_home ?? FAKE_HOME,
    name: address.name,
    field: address.field,
  };
};

const readCores = (path: string): FakeDocCores =>
  JSON.parse(readFileSync(path, "utf8")) as FakeDocCores;

/**
 * One shared document's value (null when absent), read straight from where `state`'s backend
 * keeps it: its file, or its document in the fake cores. Read between CLI runs.
 * @param state State dir (after `cliState` or `cliEnv`).
 * @param key Document.
 * @returns The value.
 */
export const readState = (state: string, key: StateKey): any => {
  const slot = slotOf(state, key);
  if (slot.kind === "file")
    return existsSync(slot.file) ? JSON.parse(readFileSync(slot.file, "utf8")) : null;
  const value = readCores(slot.cores).docs[slot.home]?.[slot.name]?.value ?? null;
  if (slot.field === undefined) return value;
  return (value as { records?: Record<string, unknown> } | null)?.records?.[slot.field] ?? null;
};

/**
 * Everything that marks a change to one shared document: its file's bytes, or its document's
 * value and version. Equal snapshots mean nothing wrote it.
 * @param state State dir (after `cliState` or `cliEnv`).
 * @param key Document.
 * @returns The snapshot.
 */
export const stateSnapshot = (state: string, key: StateKey): string => {
  const slot = slotOf(state, key);
  if (slot.kind === "file") return existsSync(slot.file) ? readFileSync(slot.file, "utf8") : "";
  return JSON.stringify(readCores(slot.cores).docs[slot.home]?.[slot.name] ?? null);
};

/**
 * Write a shared document behind the CLI's back, as another machine or a hand edit would: its file,
 * or its document in the fake cores with the version moved on. null deletes it. Write between CLI
 * runs.
 * @param state State dir (after `cliState` or `cliEnv`).
 * @param key Document.
 * @param value The new value.
 */
export const writeState = (state: string, key: StateKey, value: unknown): void => {
  const slot = slotOf(state, key);
  if (slot.kind === "file") {
    if (value === null) rmSync(slot.file, { force: true });
    else {
      mkdirSync(join(slot.file, ".."), { recursive: true });
      writeFileSync(slot.file, JSON.stringify(value));
    }
    return;
  }
  const cores = readCores(slot.cores);
  const docs = (cores.docs[slot.home] ??= {});
  const current = docs[slot.name] ?? { value: null, version: 0 };
  const next =
    slot.field === undefined
      ? value
      : {
          records: {
            ...(current.value as { records?: Record<string, unknown> } | null)?.records,
            [slot.field]: value,
          },
        };
  docs[slot.name] = { value: next, version: current.version + 1 };
  writeFileSync(slot.cores, JSON.stringify(cores));
};

/**
 * Text with herdr-doc addresses on `FAKE_HOME` written as the files under `state` they stand
 * for, so one expected output fits both backends.
 * @param text CLI output.
 * @param state State dir.
 * @returns The text.
 */
export const asFileAddresses = (text: string, state: string): string =>
  text
    .replaceAll(
      new RegExp(`herdr-doc://${FAKE_HOME}/cs\\.b\\.([a-z0-9._-]+)`, "g"),
      `${state}/backlogs/$1.json`,
    )
    .replaceAll(
      new RegExp(`herdr-doc://${FAKE_HOME}/cs\\.q\\.([a-z0-9._-]+)`, "g"),
      `${state}/capacity/$1.json`,
    )
    .replaceAll(
      new RegExp(`herdr-doc://${FAKE_HOME}/cs\\.ended\\.\\d+#([A-Za-z0-9._-]+)`, "g"),
      `${state}/ended/$1.json`,
    )
    .replaceAll(`herdr-doc://${FAKE_HOME}/cs.policy`, `${state}/delegate-harness-policy.json`)
    .replaceAll(new RegExp(`herdr-doc://${FAKE_HOME}(?![/\\w])`, "g"), `${state}/ended`);

/**
 * An environment for spawning the coordinate CLI against `state`: a config file naming it, a stub
 * `hc`, a stub `herdr-app`, and stub `lsof`, `ps` and `kill` first on PATH, and `HC_TERMINAL_ID=t1`. The stub's `hc get` answers t1 with `labels`,
 * or, given `getError`, fails the way herdr-core reports an error; `hc get` answers each address in
 * `terminals` with its document; `hc ls` lists the first entry of `lists` whose `key=value` label
 * filter the call passes, else nothing; `hc server status` names the core `FAKE_CORE`; `hc machine ls`
 * lists one other machine, strix. Every call's arguments are appended to `<state>/bin/calls.log`.
 * The `herdr-app` stub makes space sp9 (tab tab9, shell t6) on `space.new`, lists no spaces, answers
 * anything else with `{}`, and appends its arguments to `<state>/bin/app-calls.log`, so no test
 * reaches the real Herdr app. HOME is `<state>/home`, whose `.local/bin` is not on PATH.
 * With the herdr-doc backend (`stateBackend`, by default the one `eachBackend` runs), the config
 * keeps shared state on `home` (`FAKE_HOME` by default), the stub's `hc connect` answers document
 * calls from fake cores in `<state>/herdr-docs.json` (and `hc file read` finds no file) (this core
 * `FAKE_CORE`, which knows the home and strix, both up), HOME has a Claude Code coordinate skill
 * link to this checkout, and this process reads the same documents (`cliState`). SHELL is a stub
 * login shell that keeps the given PATH.
 * @param state State dir.
 * @param labels The calling terminal's labels.
 * @param getError An error kind for `hc get` to fail with.
 * @param terminals Other terminals `hc get` knows, by address.
 * @param lists Terminals `hc ls` lists, by label filter, checked in order.
 * @param stateBackend Which backend the config selects.
 * @param home The herdr-doc home (`cliState`).
 * @returns The environment.
 */
export const cliEnv = (
  state: string,
  labels: Record<string, string>,
  getError: string | undefined = undefined,
  terminals: Record<string, unknown> = {},
  lists: Record<string, unknown[]> = {},
  stateBackend: StateBackend = testBackend(),
  home: string = FAKE_HOME,
): Record<string, string> => {
  cliState(state, stateBackend, home);
  const configFile = join(state, "config.json");
  const docs = join(state, "herdr-docs.json");
  const bin = join(state, "bin");
  mkdirSync(bin, { recursive: true });
  const got =
    getError === undefined
      ? `printf '%s' '${JSON.stringify({ address: "t1", state: "live", labels })}'`
      : `printf '%s' '${JSON.stringify({ error: { kind: getError, message: "herdr-core is not answering" } })}' >&2; exit 1`;
  const known = Object.entries(terminals)
    .map(
      ([address, terminal]) =>
        `[ "$2" = '${address}' ] && { printf '%s' '${JSON.stringify(terminal)}'; exit 0; }; `,
    )
    .join("");
  const listed = Object.entries(lists)
    .map(
      ([filter, listing]) =>
        `case " $* " in *' ${filter} '*) printf '%s' '${JSON.stringify({ terminals: listing })}'; exit 0 ;; esac; `,
    )
    .join("");
  writeFileSync(
    join(bin, "hc"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(bin, "calls.log")}'\ncase "$1" in\n  get) ${known}${got} ;;\n  ls) ${listed}printf '{"terminals":[]}' ;;\n  run) printf '{"address":"t-watch"}' ;;
  file) [ "$2" = read ] && { printf '{"error":{"kind":"not_found","message":"no such file"}}' >&2; exit 1; }; printf '{}' ;;
  connect) exec '${process.execPath}' '${join(import.meta.dir, "herdr-docs-fake.ts")}' '${docs}' ;;
  server) printf '%s' '${JSON.stringify({ core: { id: "0", name: FAKE_CORE } })}' ;;
  machine) printf '%s' '${JSON.stringify({ machines: [{ name: "strix", state: "connected" }] })}' ;;
  *) printf '{}' ;;\nesac\n`,
  );
  chmodSync(join(bin, "hc"), 0o755);
  writeFileSync(
    join(bin, "herdr-app"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(bin, "app-calls.log")}'\ncase "$1 $2" in\n  "do space.new") printf '{"space":"sp9","tab":"tab9","terminal":"t6"}' ;;\n  "ls ") printf '{"spaces":[]}' ;;\n  *) printf '{}' ;;\nesac\n`,
  );
  chmodSync(join(bin, "herdr-app"), 0o755);
  // The sweep reads every process's folders through lsof; answer with one process outside `state`
  // so the CLI never depends on the host's lsof or its live process table.
  writeFileSync(join(bin, "lsof"), `#!/bin/sh\nprintf 'p1\\ncinit\\nn/\\n'\n`);
  chmodSync(join(bin, "lsof"), 0o755);
  // end and sweep remove read the process table from ps and may signal with kill: answer that read
  // with an empty table and record kill calls, so no CLI test targets a host process. Other ps
  // reads (a watcher's pid check) pass through.
  writeFileSync(
    join(bin, "ps"),
    `#!/bin/sh\ncase "$*" in *lstart*) exit 0 ;; esac\nexec '${Bun.which("ps") ?? "/bin/ps"}' "$@"\n`,
  );
  chmodSync(join(bin, "ps"), 0o755);
  writeFileSync(
    join(bin, "kill"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(bin, "kill-calls.log")}'\n`,
  );
  chmodSync(join(bin, "kill"), 0o755);
  // A login shell that keeps the caller's PATH, so the preflight's bun check sees the test's PATH
  // rather than the host's profile.
  writeFileSync(
    join(bin, "login-shell"),
    `#!/bin/sh\n[ "$1" = -lc ] && shift\nexec /bin/sh -c "$1"\n`,
  );
  chmodSync(join(bin, "login-shell"), 0o755);
  return {
    ...(process.env as Record<string, string>),
    // A sandboxed HOME keeps start and status --resume from writing the real ~/.local/bin.
    HOME: join(state, "home"),
    COORDINATE_CONFIG: configFile,
    XDG_STATE_HOME: join(state, "xdg"),
    HC_TERMINAL_ID: "t1",
    SHELL: join(bin, "login-shell"),
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
};

/**
 * One fake process: pid, parent pid, command line and working folder.
 */
export type FakeProcess = { pid: number; ppid: number; args: string; cwd: string };

/**
 * A scripted process table answering `ps`, `lsof` and `kill`: `kill` removes a pid unless it is
 * listed as ignoring that signal. Every other argv falls through to `rest`.
 * @param processes Processes alive at the start.
 * @param ignores Signal name (TERM, KILL) to the pids that ignore it.
 * @param rest Answers for other argv.
 * @returns The answer function, the live pids and every kill argv.
 */
export const processMachine = (
  processes: readonly FakeProcess[],
  ignores: Record<string, readonly number[]> = {},
  rest: (argv: readonly string[]) => RunOutput = () => ({ exitCode: 0, stdout: "{}", stderr: "" }),
) => {
  const alive = new Set(processes.map((entry) => entry.pid));
  const kills: string[][] = [];
  const live = () => processes.filter((entry) => alive.has(entry.pid));
  const answer = (argv: readonly string[]): RunOutput => {
    if (argv[0] === "ps")
      return {
        exitCode: 0,
        stdout: live()
          .map((entry) => `${entry.pid} ${entry.ppid} Mon Nov 23 04:50:09 2026 ${entry.args}\n`)
          .join(""),
        stderr: "",
      };
    if (argv[0] === "lsof")
      return {
        exitCode: 0,
        stdout: live()
          .map((entry) => `p${entry.pid}\nc${entry.args.split(" ")[0]}\nfcwd\nn${entry.cwd}\n`)
          .join(""),
        stderr: "",
      };
    if (argv[0] === "kill") {
      kills.push([...argv]);
      const name = (argv[1] ?? "").replace(/^-/, "");
      for (const pid of argv.slice(2).map(Number))
        if (!(ignores[name] ?? []).includes(pid)) alive.delete(pid);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return rest(argv);
  };
  return { answer, alive, kills };
};
