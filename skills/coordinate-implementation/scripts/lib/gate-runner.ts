import { Effect } from "effect";
import { spawn } from "node:child_process";

/**
 * One persisted gate command from the review policy.
 */
export type GateCommand = {
  name: string;
  argv: string[];
};

/**
 * Observed result of executing one gate.
 */
export type GateRun = {
  name: string;
  status: "passed" | "failed" | "infrastructure_failed";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

/**
 * Limits applied to every gate process.
 */
export type GateLimits = {
  timeoutMs: number;
  maxOutputBytes: number;
};

const DEFAULT_LIMITS: GateLimits = { timeoutMs: 45 * 60_000, maxOutputBytes: 2 * 1024 * 1024 };

const append = (current: string, chunk: string, limit: number): string => {
  if (current.length >= limit) return current;
  const next = current + chunk;
  return next.length > limit ? `${next.slice(0, limit)}\n[output truncated]\n` : next;
};

/**
 * Runs one gate argv without a shell in its own process group. Interrupting the
 * Effect or exceeding the timeout kills the whole group, so no orphaned build
 * survives an engine restart.
 *
 * @param gate - Gate name and exact argv.
 * @param cwd - Ticket worktree.
 * @param env - Environment for the gate process.
 * @param limits - Timeout and captured output cap.
 * @returns An Effect containing the classified run; spawn failures are infrastructure failures.
 */
export const runGateProcess = (
  gate: GateCommand,
  cwd: string,
  env: Record<string, string | undefined>,
  limits: GateLimits = DEFAULT_LIMITS,
): Effect.Effect<GateRun> =>
  Effect.callback<GateRun>((resume) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let settled = false;
    const [command, ...args] = gate.argv;
    const child = spawn(command!, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // group already gone
      }
    };
    const finish = (run: Omit<GateRun, "name" | "stdout" | "stderr" | "durationMs">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resume(
        Effect.succeed({
          name: gate.name,
          ...run,
          stdout,
          stderr,
          durationMs: Date.now() - started,
        }),
      );
    };
    const timer = setTimeout(() => {
      killGroup();
      stderr = append(
        stderr,
        `\n[gate timed out after ${limits.timeoutMs}ms]\n`,
        limits.maxOutputBytes * 2,
      );
      finish({ status: "infrastructure_failed", exitCode: null });
    }, limits.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = append(stdout, chunk, limits.maxOutputBytes);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = append(stderr, chunk, limits.maxOutputBytes);
    });
    child.on("error", (error) => {
      stderr = append(stderr, `${error.message}\n`, limits.maxOutputBytes);
      finish({ status: "infrastructure_failed", exitCode: null });
    });
    child.on("close", (code, signal) => {
      if (signal !== null) {
        finish({ status: "infrastructure_failed", exitCode: null });
        return;
      }
      finish({ status: code === 0 ? "passed" : "failed", exitCode: code });
    });
    return Effect.sync(() => {
      killGroup();
      clearTimeout(timer);
    });
  });
