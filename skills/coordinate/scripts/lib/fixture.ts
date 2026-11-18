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
 * `hc` first on PATH, and `HC_TERMINAL_ID=t1`. The stub's `hc get` answers t1 with `labels`,
 * or, given `getError`, fails the way herdr-core reports an error; `hc get` answers each address in
 * `terminals` with its document; `hc ls` lists nothing.
 * @param state State dir.
 * @param labels The calling terminal's labels.
 * @param getError An error kind for `hc get` to fail with.
 * @param terminals Other terminals `hc get` knows, by address.
 * @returns The environment.
 */
export const cliEnv = (
  state: string,
  labels: Record<string, string>,
  getError: string | undefined = undefined,
  terminals: Record<string, unknown> = {},
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
  writeFileSync(
    join(bin, "hc"),
    `#!/bin/sh\ncase "$1" in\n  get) ${known}${got} ;;\n  ls) printf '{"terminals":[]}' ;;\n  *) printf '{}' ;;\nesac\n`,
  );
  chmodSync(join(bin, "hc"), 0o755);
  return {
    ...(process.env as Record<string, string>),
    COORDINATE_CONFIG: configFile,
    HC_TERMINAL_ID: "t1",
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
};
