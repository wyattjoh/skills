import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Schema } from "effect";

import {
  assertOk,
  parseAgentList,
  type FleetAgent,
  type Runner,
  type RunOutput,
} from "../hooks/core/herdr.ts";
import type { FleetRun, WorkerRecord } from "./storage.ts";

const GIT_LOCATION = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
];
const CreatedTab = Schema.Struct({
  result: Schema.Struct({
    tab: Schema.Struct({ tab_id: Schema.String }),
    root_pane: Schema.Struct({ pane_id: Schema.String }),
  }),
});
const WorkspaceList = Schema.Struct({
  result: Schema.Struct({
    workspaces: Schema.Array(Schema.Struct({ workspace_id: Schema.String })),
  }),
});
const PaneList = Schema.Struct({
  result: Schema.Struct({
    panes: Schema.Array(Schema.Struct({ pane_id: Schema.String, tab_id: Schema.String })),
  }),
});
const PaneDocument = Schema.Struct({
  result: Schema.Struct({
    pane: Schema.Struct({
      pane_id: Schema.String,
      tab_id: Schema.String,
      workspace_id: Schema.String,
    }),
  }),
});

/**
 * Fresh Git facts derived from the supplied worktree, with repository-location env sanitized.
 */
export type GitFacts = {
  worktree: string;
  commonDirectory: string;
  head: string;
  base: string;
  branch: string;
  clean: boolean;
};
/**
 * Platform effects are injected in runtime tests; no Herdr completion wait is part of this port.
 */
export type FleetPlatform = {
  workspaceExists: (workspace: string) => Promise<boolean>;
  scratchIgnored: (worktree: string) => Promise<boolean>;
  facts: (worktree: string, integrationBranch: string) => Promise<GitFacts>;
  checks: (
    worktree: string,
    commands: readonly string[],
    timeoutMs: number,
  ) => Promise<readonly string[]>;
  landed: (worktree: string, integrationBranch: string, head: string) => Promise<string>;
  createTab: (
    workspace: string,
    worktree: string,
    label: string,
  ) => Promise<{ pane: string; tab: string }>;
  start: (run: FleetRun, worker: WorkerRecord) => Promise<void>;
  agents: () => Promise<readonly FleetAgent[]>;
  closeOwned: (run: FleetRun, worker: WorkerRecord) => Promise<void>;
  reviewFile: (run: FleetRun, filename: string) => Promise<{ text: string; hash: string }>;
};

/**
 * A canonical digest is persisted with each accepted report and immutable review content.
 */
export const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * Strip Git repository-location overrides before operating on a supplied worktree.
 * Returns a fresh environment; fixture spawns use the same helper as production Git calls.
 */
export const gitEnvironment = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const env = { ...environment };
  for (const key of GIT_LOCATION) delete env[key];
  return env;
};

/**
 * Zero-signal liveness check, used only for owner/startup safety, never completion polling.
 */
export const processIsAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid owner process ID");
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
};

const subprocess = (
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined = undefined,
): Promise<RunOutput> =>
  new Promise((done) => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || signal?.aborted) {
      done({ exitCode: 1, stdout: "", stderr: "Command aborted or timeout invalid" });
      return;
    }
    const [command = "git", ...args] = argv;
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      failure: string | undefined;
    let settled = false,
      bytes = 0;
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    let finalDeadline: ReturnType<typeof setTimeout> | undefined;
    const kill = (kind: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill(kind);
        else process.kill(-child.pid, kind);
      } catch {
        /* Already exited. */
      }
    };
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardKill !== undefined) clearTimeout(hardKill);
      if (finalDeadline !== undefined) clearTimeout(finalDeadline);
      signal?.removeEventListener("abort", abort);
      done({
        exitCode: failure === undefined ? code : 1,
        stdout,
        stderr: failure === undefined ? stderr : `${stderr}\n${failure}`,
      });
    };
    const terminate = (reason: string): void => {
      if (failure !== undefined || settled) return;
      failure = reason;
      kill("SIGTERM");
      hardKill = setTimeout(() => kill("SIGKILL"), 500);
      finalDeadline = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        finish(1);
      }, 2_000);
    };
    const abort = (): void => terminate("Command aborted");
    const timer = setTimeout(() => terminate(`Command timed out after ${timeoutMs}ms`), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    const append = (data: string, target: "stdout" | "stderr"): void => {
      if (failure !== undefined) return;
      bytes += Buffer.byteLength(data, "utf8");
      if (bytes > 4 * 1024 * 1024) {
        terminate("Command exceeded the 4 MiB output limit");
        return;
      }
      if (target === "stdout") stdout += data;
      else stderr += data;
    };
    child.stdout?.setEncoding("utf8").on("data", (data: string) => append(data, "stdout"));
    child.stderr?.setEncoding("utf8").on("data", (data: string) => append(data, "stderr"));
    child.once("error", (error) => {
      failure = error.message;
      finish(1);
    });
    child.once("close", (code) => finish(code ?? 1));
    if (signal?.aborted) abort();
  });

/**
 * Node/Herdr adapter. Every subprocess is bounded and receives an explicit sanitized environment.
 */
export const nodeFleetPlatform = (
  runner: Runner,
  environment: NodeJS.ProcessEnv = process.env,
  signal: AbortSignal | undefined = undefined,
): FleetPlatform => {
  const env = gitEnvironment(environment);
  const git = async (cwd: string, args: readonly string[]): Promise<string> => {
    const result = await subprocess(["git", ...args], cwd, 10_000, env, signal);
    if (result.exitCode !== 0)
      throw new Error(`git ${args[0]} failed: ${result.stderr.trim().slice(0, 500)}`);
    return result.stdout.trim();
  };
  const herdr = async (args: readonly string[], timeout = 10_000): Promise<RunOutput> => {
    const result = await runner(["herdr", ...args], timeout, signal);
    assertOk(result);
    return result;
  };
  const agents = async (): Promise<FleetAgent[]> => parseAgentList(await herdr(["agent", "list"]));
  return {
    workspaceExists: async (workspace) =>
      Schema.decodeUnknownSync(WorkspaceList)(
        JSON.parse((await herdr(["workspace", "list"])).stdout),
      ).result.workspaces.some((entry) => entry.workspace_id === workspace),
    scratchIgnored: async (worktree) =>
      (
        await subprocess(
          ["git", "check-ignore", "--quiet", ".scratch/to-code/probe"],
          worktree,
          10_000,
          env,
          signal,
        )
      ).exitCode === 0,
    facts: async (worktree, integrationBranch) => {
      const canonical = await realpath(worktree);
      await git(canonical, ["check-ref-format", "--branch", integrationBranch]);
      const root = await realpath(await git(canonical, ["rev-parse", "--show-toplevel"]));
      if (root !== canonical)
        throw new Error("Supply an existing worktree root, not a subdirectory");
      const common = await git(canonical, ["rev-parse", "--git-common-dir"]);
      const branch = await git(canonical, ["symbolic-ref", "--short", "HEAD"]);
      return {
        worktree: canonical,
        commonDirectory: await realpath(resolve(canonical, common)),
        branch,
        head: await git(canonical, ["rev-parse", "HEAD"]),
        base: await git(canonical, ["merge-base", "HEAD", `refs/heads/${integrationBranch}`]),
        clean: (await git(canonical, ["status", "--porcelain"])).length === 0,
      };
    },
    checks: async (worktree, commands, timeoutMs) => {
      if (commands.length === 0)
        throw new Error("At least one configured verification command is required");
      const results: string[] = [];
      for (const command of commands) {
        const result = await subprocess(
          ["/bin/sh", "-c", command],
          worktree,
          timeoutMs,
          env,
          signal,
        );
        if (result.exitCode !== 0)
          throw new Error(
            `Check failed (${command}): ${(result.stderr || result.stdout).slice(-1500)}`,
          );
        results.push(`${command}: passed`);
      }
      return results;
    },
    landed: async (worktree, integrationBranch, head) => {
      const integrationHead = await git(worktree, ["rev-parse", `refs/heads/${integrationBranch}`]);
      await git(worktree, ["merge-base", "--is-ancestor", head, integrationHead]);
      return integrationHead;
    },
    createTab: async (workspace, worktree, label) => {
      const result = Schema.decodeUnknownSync(CreatedTab)(
        JSON.parse(
          (
            await herdr([
              "tab",
              "create",
              "--workspace",
              workspace,
              "--cwd",
              worktree,
              "--label",
              label,
              "--no-focus",
            ])
          ).stdout,
        ),
      ).result;
      return { pane: result.root_pane.pane_id, tab: result.tab.tab_id };
    },
    start: async (run, worker) => {
      if (worker.pane === null) throw new Error("Cannot launch an unallocated worker");
      const flag =
        worker.snapshot.value.role === "implementor" ? "--fleet-implementor" : "--fleet-reviewer";
      await herdr(
        [
          "agent",
          "start",
          worker.name,
          "--kind",
          "pi",
          "--pane",
          worker.pane,
          "--timeout",
          "30000",
          "--",
          "--extension",
          fileURLToPath(new URL("./index.ts", import.meta.url)),
          "--model",
          worker.model,
          "--thinking",
          worker.thinking,
          "--fleet-run",
          run.directory,
          flag,
          worker.id,
        ],
        35_000,
      );
    },
    agents,
    closeOwned: async (run, worker) => {
      if (worker.pane === null || worker.tab === null || worker.pane === run.coordinatorPane)
        throw new Error("Worker resource ownership is incomplete");
      const panes = Schema.decodeUnknownSync(PaneList)(
        JSON.parse((await herdr(["pane", "list", "--workspace", run.workspace])).stdout),
      ).result.panes;
      const pane = panes.find((entry) => entry.pane_id === worker.pane);
      if (pane === undefined) return;
      if (pane.tab_id !== worker.tab)
        throw new Error("Owned pane moved; refuse to close its new location");
      const live = (await agents()).find((agent) => agent.pane === worker.pane);
      if (
        live === undefined ||
        live.name !== worker.name ||
        live.harness !== "pi" ||
        live.workspace !== run.workspace ||
        !["idle", "done"].includes(live.status)
      ) {
        throw new Error(
          "Worker occupant is not the owned, settled Pi agent; inspect before cleanup",
        );
      }
      const ticket = run.tickets.find((entry) => entry.id === worker.ticketId);
      if (ticket === undefined || (await realpath(live.cwd)) !== ticket.snapshot.value.worktree)
        throw new Error("Worker cwd no longer matches the owned ticket");
      const current = Schema.decodeUnknownSync(PaneDocument)(
        JSON.parse((await herdr(["pane", "get", worker.pane])).stdout),
      ).result.pane;
      if (current.tab_id !== worker.tab || current.workspace_id !== run.workspace)
        throw new Error("Worker topology changed before cleanup");
      await herdr(["pane", "close", worker.pane]);
      // Closing the last pane closes the tab. Never close a tab containing another user's pane.
      const remaining = Schema.decodeUnknownSync(PaneList)(
        JSON.parse((await herdr(["pane", "list", "--workspace", run.workspace])).stdout),
      ).result.panes;
      if (remaining.some((entry) => entry.tab_id === worker.tab)) return;
    },
    reviewFile: async (run, filename) => {
      if (
        !filename.startsWith(".scratch/") ||
        filename.split("/").some((part) => part === ".." || part === ".") ||
        isAbsolute(filename)
      )
        throw new Error("Review file must be an assigned relative scratch path");
      const reports = await realpath(join(run.directory, "reports"));
      if (reports !== resolve(run.directory, "reports"))
        throw new Error("Reports directory is not canonical");
      const path = resolve(run.repository, filename);
      const canonical = await realpath(path);
      if (
        relative(reports, canonical).startsWith("..") ||
        dirname(canonical) !== reports ||
        (await lstat(path)).isSymbolicLink()
      )
        throw new Error("Review file is outside the canonical reports directory or is a symlink");
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 1024 * 1024)
          throw new Error("Review must be a readable regular Markdown file under 1 MiB");
        const text = await file.readFile("utf8");
        if (Buffer.byteLength(text) > 1024 * 1024)
          throw new Error("Review grew beyond 1 MiB while reading");
        return { text, hash: digest(text) };
      } finally {
        await file.close();
      }
    },
  };
};
