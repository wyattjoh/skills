import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, watch } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Schema } from "effect";

import {
  assertOk,
  HerdrFailure,
  parseAgentList,
  parseAgentInfo,
  type FleetAgent,
  type Runner,
  type RunOutput,
} from "../hooks/core/herdr.ts";
import { fleetStorage, type FleetRun, type WorkerRecord } from "./storage.ts";
import { waitForRegistration } from "./registration.ts";

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
const SpaceList = Schema.Struct({
  spaces: Schema.Array(Schema.Struct({ id: Schema.String, machine: Schema.NullOr(Schema.String) })),
});
const OwnedTerminal = Schema.Struct({
  address: Schema.String,
  name: Schema.String,
  cwd: Schema.String,
  labels: Schema.Record(Schema.String, Schema.String),
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
  prepareWorker: (
    workspace: string,
    worktree: string,
    label: string,
  ) => Promise<{ pane: string; tab: string | null }>;
  start: (
    run: FleetRun,
    worker: WorkerRecord,
    bind: (address: string) => Promise<void>,
  ) => Promise<void>;
  claimWorker: (run: FleetRun, worker: WorkerRecord, address: string) => Promise<void>;
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
 * Node/current-core adapter. Git subprocesses use an explicit sanitized environment.
 * @param runner Harness-injected bounded CLI execution.
 * @param environment Environment to sanitize for Git and check commands.
 * @param signal Optional cancellation for this operation.
 * @param registration Optional injected startup waiter for deterministic platform tests.
 * @returns Current-core effects with same-host durable startup and ownership-safe cleanup.
 */
export const nodeFleetPlatform = (
  runner: Runner,
  environment: NodeJS.ProcessEnv = process.env,
  signal: AbortSignal | undefined = undefined,
  registration:
    | ((run: FleetRun, worker: WorkerRecord, address: string) => Promise<void>)
    | undefined = undefined,
): FleetPlatform => {
  const env = gitEnvironment(environment);
  const git = async (cwd: string, args: readonly string[]): Promise<string> => {
    const result = await subprocess(["git", ...args], cwd, 10_000, env, signal);
    if (result.exitCode !== 0)
      throw new Error(`git ${args[0]} failed: ${result.stderr.trim().slice(0, 500)}`);
    return result.stdout.trim();
  };
  const core = async (args: readonly string[], timeout = 10_000): Promise<RunOutput> => {
    const result = await runner(["hc", ...args], timeout, signal);
    assertOk(result);
    return result;
  };
  const agents = async (): Promise<FleetAgent[]> => parseAgentList(await core(["ls", "--all"]));
  const claimWorker = async (
    run: FleetRun,
    worker: WorkerRecord,
    address: string,
  ): Promise<FleetAgent> => {
    const output = await core(["get", address]);
    const terminal = Schema.decodeUnknownSync(OwnedTerminal)(JSON.parse(output.stdout));
    const agent = parseAgentInfo(output);
    const ticket = run.tickets.find((entry) => entry.id === worker.ticketId);
    if (
      terminal.address !== address ||
      terminal.name !== worker.name ||
      agent.harness !== "pi" ||
      terminal.labels["to-code.run"] !== run.id ||
      terminal.labels["to-code.worker"] !== worker.id ||
      terminal.labels["herdr.space"] !== run.workspace ||
      ticket === undefined ||
      (await realpath(agent.cwd)) !== ticket.snapshot.value.worktree
    )
      throw new Error("Terminal is not the owned Pi worker in its assigned space/worktree");
    return agent;
  };
  return {
    workspaceExists: async (workspace) => {
      const result = await runner(["herdr-app", "ls"], 10_000, signal);
      assertOk(result);
      return Schema.decodeUnknownSync(SpaceList)(JSON.parse(result.stdout)).spaces.some(
        (entry) => entry.id === workspace && (entry.machine === null || entry.machine === ""),
      );
    },
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
    // Persist a unique core name before launch. The worker binds its immutable
    // terminal address after checking core ownership labels during session_start.
    prepareWorker: async (_workspace, _worktree, name) => ({ pane: name, tab: null }),
    start: async (run, worker, bind) => {
      const ticket = run.tickets.find((entry) => entry.id === worker.ticketId);
      if (ticket === undefined) throw new Error("Worker ticket is missing");
      const flag =
        worker.snapshot.value.role === "implementor" ? "--fleet-implementor" : "--fleet-reviewer";
      const launched = await core([
        "run",
        "--bg",
        "--outlive-parent",
        "--name",
        worker.name,
        "--cwd",
        ticket.snapshot.value.worktree,
        "--label",
        `herdr.space=${run.workspace}`,
        "--label",
        `to-code.run=${run.id}`,
        "--label",
        `to-code.worker=${worker.id}`,
        "--",
        "pi",
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
      ]);
      const address = Schema.decodeUnknownSync(Schema.Struct({ address: Schema.String }))(
        JSON.parse(launched.stdout),
      ).address;
      await claimWorker(run, worker, address);
      // Bind independently of worker readiness, including early process exits.
      await bind(address);
      if (registration !== undefined) await registration(run, worker, address);
      else
        await waitForRegistration(
          async () => {
            const stored = await fleetStorage(run.directory).read();
            const registered = stored.workers.find((entry) => entry.id === worker.id);
            return (
              registered?.pane === address &&
              registered.name === worker.name &&
              registered.callbackReady &&
              registered.pid !== null &&
              processIsAlive(registered.pid)
            );
          },
          (changed) => watch(run.directory, changed),
          signal,
        );
    },
    claimWorker: async (run, worker, address) => {
      await claimWorker(run, worker, address);
    },
    agents,
    closeOwned: async (run, worker) => {
      if (
        worker.pane === null ||
        worker.pane === worker.name ||
        worker.pane === run.coordinatorPane
      )
        throw new Error("Worker terminal ownership is incomplete");
      const live = (await agents()).find((agent) => agent.pane === worker.pane);
      if (live === undefined) {
        // A lost rm reply or crash before durable retirement must be retryable.
        // Listing filters are not absence evidence; inspect the exact immutable ID.
        const probe = await runner(["hc", "get", worker.pane], 10_000, signal);
        try {
          assertOk(probe);
        } catch (error) {
          if (probe.exitCode === 3 && error instanceof HerdrFailure && error.code === "not_found")
            return;
          throw error;
        }
        throw new Error(
          "Owned terminal is absent from agent discovery but still exists; inspect before cleanup",
        );
      }
      await claimWorker(run, worker, worker.pane);
      if (!["idle", "done", "finished"].includes(live.status))
        throw new Error("Worker is not settled; inspect before cleanup");
      // Recheck immediately before destructive operations; core's status guard on
      // send is not a kill guard, so never infer ownership from a terminal name.
      const current = await claimWorker(run, worker, worker.pane);
      if (!["idle", "done", "finished"].includes(current.status))
        throw new Error("Worker status changed before cleanup");
      if (current.status !== "finished") await core(["kill", worker.pane]);
      await core(["rm", worker.pane]);
      // App tabs are views, not resources owned by this fleet. Never close one:
      // it can contain another person's panes or another view of this terminal.
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
