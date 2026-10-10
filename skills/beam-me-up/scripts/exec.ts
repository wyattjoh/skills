/**
 * One way to run a child process: collect stdout as bytes and stderr as text,
 * with an optional stdin stream, and a timeout on every call.
 */

import { Duration, Effect, Schema, Stream } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * Raised when a process cannot be spawned, times out, or exits non-zero where
 * success was required.
 */
export class ExecError extends Schema.TaggedError<ExecError>()("ExecError", {
  message: Schema.String,
}) {}

/**
 * The collected outcome of a finished process.
 */
export interface ExecResult {
  readonly stdout: Uint8Array;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Options for {@link runProcess}. Every field is explicit so call sites stay readable.
 */
export interface ProcessOptions {
  readonly cwd: string | undefined;
  readonly env: Record<string, string> | undefined;
  readonly stdin: Stream.Stream<Uint8Array, PlatformError> | undefined;
  readonly timeout: Duration.Input;
}

/**
 * Default options: inherit cwd and env, no stdin, and a two-minute limit, long
 * enough for a multi-megabyte transfer over a slow link.
 */
export const defaultProcessOptions: ProcessOptions = {
  cwd: undefined,
  env: undefined,
  stdin: undefined,
  timeout: "2 minutes",
};

const collectBytes = (stream: Stream.Stream<Uint8Array, PlatformError>) =>
  Stream.runFold(
    stream,
    () => [] as Array<Uint8Array>,
    (chunks, chunk) => {
      chunks.push(chunk);
      return chunks;
    },
  ).pipe(Effect.map((chunks) => Buffer.concat(chunks)));

/**
 * Runs `command args...` to completion. Never fails on a non-zero exit; use
 * {@link runProcessOk} when success is required.
 */
export const runProcess = Effect.fn("runProcess")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: Partial<ProcessOptions> = {},
) {
  const { cwd, env, stdin, timeout } = { ...defaultProcessOptions, ...options };
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const label = `${command} ${args.join(" ")}`.slice(0, 200);
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, [...args], {
          cwd,
          env,
          extendEnv: true,
          stdin: stdin ?? "ignore",
        }),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectBytes(handle.stdout),
          handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return { stdout: new Uint8Array(stdout), stderr, exitCode: Number(exitCode) };
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        Effect.fail(
          new ExecError({
            message: `\`${label}\` timed out after ${Duration.format(Duration.fromInputUnsafe(timeout))}`,
          }),
        ),
    }),
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(new ExecError({ message: `\`${label}\` could not run: ${error.message}` })),
    ),
  );
});

/**
 * Like {@link runProcess}, but fails with an {@link ExecError} carrying stderr when the
 * process exits non-zero.
 */
export const runProcessOk = Effect.fn("runProcessOk")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: Partial<ProcessOptions> = {},
) {
  const result = yield* runProcess(command, args, options);
  if (result.exitCode !== 0) {
    const label = `${command} ${args.join(" ")}`.slice(0, 200);
    return yield* new ExecError({
      message: `\`${label}\` exited ${result.exitCode}: ${result.stderr.trim() || "(no stderr)"}`,
    });
  }
  return result;
});

/**
 * Decodes stdout as UTF-8 without the trailing newline.
 */
export const stdoutText = (result: ExecResult): string =>
  new TextDecoder().decode(result.stdout).trimEnd();
