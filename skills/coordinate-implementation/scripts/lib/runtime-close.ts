import { Data, Effect } from "effect";
import type { CliIssue } from "./contract.ts";
import type { ArgumentCommand } from "./harness-launch.ts";
import { runProbe } from "./probe.ts";

/**
 * Failure while inspecting the exact Herdr pane bound to one agent runtime.
 */
export class RuntimeCloseError extends Data.TaggedError("RuntimeCloseError")<{
  issue: CliIssue;
}> {}

/**
 * Machine-observed closure state and the only permitted command for a live runtime.
 */
export type RuntimeCloseInspection =
  | {
      runtime_closed: false;
      pane_id: string;
      close: ArgumentCommand;
    }
  | {
      runtime_closed: true;
      pane_id: string;
      close: null;
    };

const runtimeCloseError = (code: string, message: string, remediation: string): RuntimeCloseError =>
  new RuntimeCloseError({ issue: { code, message, remediation } });

const parseResponse = (value: string): Record<string, unknown> | undefined => {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Inspects one opaque Herdr pane ID and returns a deterministic close plan until it is absent.
 *
 * @param paneId - Exact pane ID persisted when the coordinator launched the runtime.
 * @returns An Effect containing observed closure or the exact shell-free close command.
 */
export const inspectRuntimeClose = (
  paneId: string,
): Effect.Effect<RuntimeCloseInspection, RuntimeCloseError> =>
  Effect.try({
    try: () => {
      const child = runProbe(["herdr", "pane", "get", paneId]);
      const stdout = child.stdout.trim();
      const stderr = child.stderr.trim();
      if (child.exitCode === 0) {
        const response = parseResponse(stdout);
        const result = response?.result;
        const pane =
          typeof result === "object" && result !== null && !Array.isArray(result)
            ? (result as Record<string, unknown>).pane
            : undefined;
        const observedPane =
          typeof pane === "object" && pane !== null && !Array.isArray(pane)
            ? (pane as Record<string, unknown>).pane_id
            : undefined;
        if (observedPane !== paneId) {
          throw runtimeCloseError(
            "runtime.close_response_malformed",
            "Herdr returned a pane response that does not match the persisted runtime identity.",
            "Keep the runtime open and inspect the installed Herdr CLI response before retrying.",
          );
        }
        return {
          runtime_closed: false as const,
          pane_id: paneId,
          close: { command: "herdr", args: ["pane", "close", paneId] },
        };
      }
      const response = parseResponse(stderr.length > 0 ? stderr : stdout);
      const error = response?.error;
      const code =
        typeof error === "object" && error !== null && !Array.isArray(error)
          ? (error as Record<string, unknown>).code
          : undefined;
      if (child.exitCode === 1 && code === "pane_not_found") {
        return { runtime_closed: true as const, pane_id: paneId, close: null };
      }
      throw runtimeCloseError(
        "runtime.close_inspection_failed",
        `Could not inspect Herdr pane \`${paneId}\`: ${stderr || stdout || `exit ${child.exitCode}`}`,
        "Keep serialized state and the worktree intact, repair Herdr connectivity, then retry.",
      );
    },
    catch: (error) =>
      error instanceof RuntimeCloseError
        ? error
        : runtimeCloseError(
            "runtime.close_inspection_failed",
            `Could not inspect Herdr pane \`${paneId}\`: ${(error as Error).message}`,
            "Keep serialized state and the worktree intact, repair Herdr connectivity, then retry.",
          ),
  });
