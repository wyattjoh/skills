import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { spawnGit } from "./git-env.ts";
import { Proc, realProc, type RunOutput } from "./proc.ts";

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
 * @param answer Answers for hc, herdr-app, lsof, gh, forgejo, du.
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
        return Effect.succeed(answer(argv));
      },
    }),
  );
  return { layer, calls };
};

/**
 * An environment for spawning the coordinate CLI against `state`: a config file naming it, a stub
 * `hc`, a stub `herdr-app`, and stub `lsof`, `ps` and `kill` first on PATH, and `HC_TERMINAL_ID=t1`. The stub's `hc get` answers t1 with `labels`,
 * or, given `getError`, fails the way herdr-core reports an error; `hc get` answers each address in
 * `terminals` with its document; `hc ls` lists the first entry of `lists` whose `key=value` label
 * filter the call passes, else nothing. Every call's arguments are appended to `<state>/bin/calls.log`.
 * The `herdr-app` stub makes space sp9 (tab tab9, shell t6) on `space.new`, lists no spaces, answers
 * anything else with `{}`, and appends its arguments to `<state>/bin/app-calls.log`, so no test
 * reaches the real Herdr app. HOME is `<state>/home`, whose `.local/bin` is not on PATH.
 * @param state State dir.
 * @param labels The calling terminal's labels.
 * @param getError An error kind for `hc get` to fail with.
 * @param terminals Other terminals `hc get` knows, by address.
 * @param lists Terminals `hc ls` lists, by label filter, checked in order.
 * @returns The environment.
 */
export const cliEnv = (
  state: string,
  labels: Record<string, string>,
  getError: string | undefined = undefined,
  terminals: Record<string, unknown> = {},
  lists: Record<string, unknown[]> = {},
): Record<string, string> => {
  const configFile = join(state, "config.json");
  writeFileSync(configFile, JSON.stringify({ state_dir: state, backlog_dir: join(state, "md") }));
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
  return {
    ...(process.env as Record<string, string>),
    // A sandboxed HOME keeps start and status --resume from writing the real ~/.local/bin.
    HOME: join(state, "home"),
    COORDINATE_CONFIG: configFile,
    XDG_STATE_HOME: join(state, "xdg"),
    HC_TERMINAL_ID: "t1",
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
