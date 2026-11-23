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
  /**
   * Text fed to the program's stdin; undefined gives it none.
   */
  stdin: string | undefined;
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
    stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
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
 * The Herdr machine name fakes give this core: never this host's OS hostname, so a test that
 * passes only because the two agree cannot pass.
 */
export const FAKE_CORE = "fake-core";

/**
 * Whether argv reads this core's identity (`hc server status --json`).
 * @param argv Program and arguments.
 * @returns True for the core-name read.
 */
export const isCoreNameRead = (argv: readonly string[]): boolean =>
  argv[0] === "hc" && argv[1] === "server" && argv[2] === "status";

/**
 * The `hc server status --json` answer naming a core.
 * @param name Herdr machine name.
 * @returns The output.
 */
export const coreStatus = (name: string): RunOutput => ({
  exitCode: 0,
  stdout: JSON.stringify({ core: { id: "0", name }, version: "0" }),
  stderr: "",
});

/**
 * A scripted `Proc` for tests: each call is answered by `answer`, and recorded. The core-name
 * read is answered with `core` (default `FAKE_CORE`) before `answer` sees it; pass
 * `core: undefined` to let `answer` handle it.
 * @param answer Maps argv (and cwd) to an output.
 * @param options `core`: this core's Herdr machine name, or undefined to pass the read through.
 * @returns The layer and the recorded calls.
 */
export const fakeProc = (
  answer: (argv: readonly string[], cwd: string | undefined) => RunOutput,
  options: { core: string | undefined } = { core: FAKE_CORE },
): { layer: Layer.Layer<Proc>; calls: Array<{ argv: string[]; cwd: string | undefined }> } => {
  const calls: Array<{ argv: string[]; cwd: string | undefined }> = [];
  const layer = Layer.succeed(
    Proc,
    Proc.of({
      run: (argv, runOptions) =>
        Effect.sync(() => {
          calls.push({ argv: [...argv], cwd: runOptions?.cwd });
          if (options.core !== undefined && isCoreNameRead(argv)) return coreStatus(options.core);
          return answer(argv, runOptions?.cwd);
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
