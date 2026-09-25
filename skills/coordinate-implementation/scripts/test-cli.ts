import { runCoordinatorRequest } from "./coordinate-program.ts";

type Env = Record<string, string | undefined>;

/**
 * Raw result of one coordinator request: the exit code and exact CLI stdout.
 */
export type RawCliResult = { exitCode: number; stdout: string; stderr: string };

let queue: Promise<unknown> = Promise.resolve();

const applyEnv = (next: Env): void => {
  for (const key of Object.keys(process.env)) {
    if (next[key] === undefined) delete process.env[key];
  }
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined) process.env[key] = value;
  }
};

const replaceEnv = (env: Env): (() => void) => {
  const saved = { ...process.env };
  applyEnv(env);
  return () => applyEnv(saved);
};

/**
 * Runs one coordinator request inside the test process.
 *
 * Launching the CLI costs a full Bun startup per request, which dominated this
 * suite's runtime. This runs the same request handler the CLI uses, with
 * `process.env` replaced by `env` for the duration of the call, exactly as a
 * spawned CLI would see it. Calls are queued so environments and module-level
 * response state never interleave. Tests that exercise real concurrency between
 * processes must keep spawning the CLI.
 *
 * @param request Request value, serialized to JSON like CLI stdin.
 * @param env Complete environment the request sees.
 * @returns Exit code and stdout exactly as the CLI would produce them.
 */
export const runCliInProcess = (
  request: unknown,
  env: Env = process.env,
): Promise<RawCliResult> => {
  const raw = typeof request === "string" ? request : JSON.stringify(request);
  const snapshot = { ...env };
  const run = queue.then(async () => {
    const restore = replaceEnv(snapshot);
    try {
      const { exitCode, stdout } = await runCoordinatorRequest(raw);
      return { exitCode, stdout, stderr: "" };
    } finally {
      restore();
    }
  });
  queue = run.catch(() => undefined);
  return run;
};

/**
 * Parsed result of one coordinator request.
 */
export type CliResult = { exitCode: number; stdout: Record<string, unknown>; stderr: string };

/**
 * Builds a schema-1 coordinator request.
 *
 * @param operation Operation name.
 * @param input Operation input.
 * @returns The request envelope.
 */
export const request = (operation: string, input: Record<string, unknown>) => ({
  schema_version: 1,
  operation,
  input,
});

/**
 * Runs one request in-process through {@link runCliInProcess} and parses its JSON stdout.
 *
 * @param body Request value.
 * @param env Complete environment the request sees.
 * @returns Exit code, parsed stdout, and stderr.
 */
export const runJson = async (body: unknown, env: Env = process.env): Promise<CliResult> => {
  const child = await runCliInProcess(body, env);
  return {
    exitCode: child.exitCode,
    stdout: JSON.parse(child.stdout.trim()) as Record<string, unknown>,
    stderr: child.stderr,
  };
};

const CLI = new URL("./coordinate.ts", import.meta.url).pathname;

/**
 * Runs one request in a spawned CLI process, for tests that need real process concurrency.
 * The environment is always passed explicitly, because Bun children ignore runtime changes to
 * `process.env`.
 *
 * @param body Request value.
 * @param env Complete environment the process sees.
 * @returns Exit code, parsed stdout, and stderr.
 */
export const runJsonProcess = async (body: unknown, env: Env = process.env): Promise<CliResult> => {
  const child = Bun.spawn([process.execPath, CLI], {
    env,
    stdin: Buffer.from(JSON.stringify(body)),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout: JSON.parse(stdout) as Record<string, unknown>, stderr };
};
