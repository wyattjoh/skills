import { Context, Effect, Layer, Schema } from "effect";

/**
 * One finished subprocess.
 */
export type RunOutput = { exitCode: number; stdout: string; stderr: string };

/**
 * How to run one subprocess. Every spawn has a timeout and an explicit environment.
 */
export type RunOptions = {
  cwd: string | undefined;
  timeoutMs: number | undefined;
  env: Record<string, string> | undefined;
};

/**
 * Default per-command budget.
 */
export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * The program could not be started, or ran past its timeout.
 */
export class SpawnError extends Schema.TaggedError<SpawnError>()("SpawnError", {
  argv: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

/**
 * The program ran and exited non-zero where success was required.
 */
export class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  argv: Schema.Array(Schema.String),
  exitCode: Schema.Number,
  output: Schema.String,
}) {}

/**
 * Subprocess execution, injectable so tests can answer `hc`, `gh` and `forgejo` calls.
 */
export class Proc extends Context.Service<
  Proc,
  {
    run(
      argv: readonly string[],
      options?: Partial<RunOptions>,
    ): Effect.Effect<RunOutput, SpawnError>;
  }
>()("coordinate/Proc") {
  static readonly layer = Layer.sync(Proc, () => realProc);
}

/**
 * The real subprocess runner, used by `Proc.layer`.
 */
export const realProc: Proc["Service"] = {
  run: (argv, options) =>
    Effect.tryPromise({
      try: () => bunRun(argv, options ?? {}),
      catch: (cause) =>
        new SpawnError({
          argv: [...argv],
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    }),
};

const bunRun = async (
  argv: readonly string[],
  options: Partial<RunOptions>,
): Promise<RunOutput> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const child = Bun.spawn([...argv], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env ?? { ...process.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (timedOut) throw new Error(`${argv[0]} timed out after ${timeoutMs / 1000}s`);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * A scripted `Proc` for tests: each call is answered by `answer`, and recorded.
 * @param answer Maps argv (and cwd) to an output.
 * @returns The layer and the recorded calls.
 */
export const fakeProc = (
  answer: (argv: readonly string[], cwd: string | undefined) => RunOutput,
): { layer: Layer.Layer<Proc>; calls: Array<{ argv: string[]; cwd: string | undefined }> } => {
  const calls: Array<{ argv: string[]; cwd: string | undefined }> = [];
  const layer = Layer.succeed(
    Proc,
    Proc.of({
      run: (argv, options) =>
        Effect.sync(() => {
          calls.push({ argv: [...argv], cwd: options?.cwd });
          return answer(argv, options?.cwd);
        }),
    }),
  );
  return { layer, calls };
};

/**
 * A successful output with `stdout`.
 * @param stdout Text printed.
 * @returns The output.
 */
export const ok = (stdout = ""): RunOutput => ({ exitCode: 0, stdout, stderr: "" });
