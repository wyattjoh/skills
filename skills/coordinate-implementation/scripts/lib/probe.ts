/**
 * Bounded synchronous probes of external commands (`--version`, schema, and pane queries).
 */

/**
 * Longest a single probe may run. `Bun.spawnSync` blocks the event loop, so without a bound a
 * wedged child would freeze the helper, and every timer, indefinitely.
 */
export const PROBE_TIMEOUT_MS = 10_000;

/**
 * Captured result of one probe. A probe that could not start, or timed out twice, reports a
 * nonzero exit code.
 */
export type ProbeResult = { exitCode: number; stdout: string; stderr: string };

const once = (argv: string[], timeoutMs: number): ProbeResult & { timedOut: boolean } => {
  const child = Bun.spawnSync(argv, {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const timedOut = child.exitCode === null;
  return {
    exitCode: child.exitCode ?? 124,
    stdout: child.stdout.toString(),
    stderr: timedOut ? `timed out after ${timeoutMs}ms` : child.stderr.toString(),
    timedOut,
  };
};

/**
 * Runs one probe with the current environment, retrying once when it times out.
 *
 * @param argv - Exact command and arguments; never interpreted by a shell.
 * @param timeoutMs - Bound for each attempt.
 * @returns The exit code and decoded output; 127 when the command cannot start.
 */
export const runProbe = (argv: string[], timeoutMs = PROBE_TIMEOUT_MS): ProbeResult => {
  try {
    const first = once(argv, timeoutMs);
    const result = first.timedOut ? once(argv, timeoutMs) : first;
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { exitCode: 127, stdout: "", stderr: (error as Error).message };
  }
};
