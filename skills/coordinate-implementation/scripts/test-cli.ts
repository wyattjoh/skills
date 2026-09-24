import { runCoordinatorRequest } from "./coordinate-program.ts";

type Env = Record<string, string | undefined>;

/**
 * Raw result of one coordinator request: the exit code and exact CLI stdout.
 */
export type RawCliResult = { exitCode: number; stdout: string; stderr: string };

let queue: Promise<unknown> = Promise.resolve();

const replaceEnv = (env: Env): (() => void) => {
  const saved = { ...process.env };
  const apply = (next: Env): void => {
    for (const key of Object.keys(process.env)) {
      if (next[key] === undefined) delete process.env[key];
    }
    for (const [key, value] of Object.entries(next)) {
      if (value !== undefined) process.env[key] = value;
    }
  };
  apply(env);
  return () => apply(saved);
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
