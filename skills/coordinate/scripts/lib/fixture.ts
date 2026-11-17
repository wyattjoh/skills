import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
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
