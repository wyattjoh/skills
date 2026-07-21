import { describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest, type TaskInput } from "./plan-graph.ts";
import { initState, writeState } from "./state.ts";
import type { DashboardBroadcast } from "./dashboard.ts";

const REAP_INTERVAL_MS = 25;
const ZERO_REGISTRY_GRACE_MS = 750;
const SINGLE_REAP_WINDOW_MS = REAP_INTERVAL_MS + 50;

function task(id: string, dependsOn: string[] = [], title = id): TaskInput {
  return { id, planPath: null, dependsOn, title };
}

function stateFixture() {
  return initState({
    batch: "daemon-integration",
    baseBranch: "main",
    integrationBranch: "wyattjoh/daemon-integration",
    concurrency: 1,
    manifest: buildManifest([task("00-lease", [], "Lease lifecycle")]),
  });
}

describe("dashboard daemon lease lifecycle", () => {
  it("registers a real leased batch, reaps it, and exits after zero-registry grace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-daemon-integration-"));
    const repoPath = join(dir, "repo");
    const journalPath = join(repoPath, ".claude/task-orchestrator/daemon-integration/state.json");
    const registryPath = join(dir, "registry.json");
    const lease = spawn("sleep", ["30"], { stdio: "ignore" });
    let daemon: ChildProcess | null = null;

    try {
      if (lease.pid == null) throw new Error("Lease process did not start");
      writeState(journalPath, stateFixture());

      await sleep(3_100);
      daemon = spawnDaemon(registryPath);
      const url = await readDaemonUrl(daemon);

      const register = await fetch(`${url}register`, {
        method: "POST",
        body: JSON.stringify({ journalPath, pid: lease.pid }),
        headers: { "content-type": "application/json" },
      });
      expect(register.status).toBe(200);

      const registeredState = await waitForState(url, (payload) => payload.batches.length === 1);
      expect(registeredState.batches[0]).toMatchObject({
        key: journalPath,
        repo: repoPath,
      });
      const snapshot = registeredState.batches[0].snapshot;
      if ("error" in snapshot) throw new Error(snapshot.error);
      expect(snapshot.batch).toBe("daemon-integration");
      expect(snapshot.tasks.map((dashboardTask) => dashboardTask.id)).toEqual(["00-lease"]);

      lease.kill("SIGTERM");
      await childExited(lease);

      await sleep(SINGLE_REAP_WINDOW_MS);
      expect((await fetchState(url)).batches).toEqual([]);
      await waitUntil(async () => daemonExited(daemon), 2_000);
      await waitUntil(async () => !(await responds(url)), 2_000);
    } finally {
      lease.kill("SIGKILL");
      if (daemon && !daemonExited(daemon)) daemon.kill("SIGTERM");
      if (daemon) await childExited(daemon);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function spawnDaemon(registryPath: string): ChildProcess {
  return spawn(
    process.execPath,
    [
      join(import.meta.dir, "dashboard.ts"),
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--registry",
      registryPath,
      "--reap-interval-ms",
      String(REAP_INTERVAL_MS),
      "--zero-registry-grace-ms",
      String(ZERO_REGISTRY_GRACE_MS),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
}

async function readDaemonUrl(child: ChildProcess): Promise<string> {
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdout) throw new Error("Daemon stdout was not readable");

  let output = "";
  let errorOutput = "";
  stderr?.on("data", (chunk: Buffer) => {
    errorOutput += chunk.toString("utf8");
  });

  return await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for daemon URL. stderr: ${errorOutput}`));
    }, 2_000);

    const onData = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      const match = output.match(/Task orchestrator dashboard daemon: (http:\/\/[^\s]+)\n/);
      if (!match) return;
      clearTimeout(timeout);
      stdout.off("data", onData);
      resolve(match[1]);
    };

    const onExit = (): void => {
      clearTimeout(timeout);
      stdout.off("data", onData);
      reject(new Error(`Daemon exited before printing URL. stderr: ${errorOutput}`));
    };

    child.once("exit", onExit);
    stdout.on("data", onData);
  });
}

async function waitForState(
  url: string,
  predicate: (payload: DashboardBroadcast) => boolean,
  timeoutMs = 3_000,
): Promise<DashboardBroadcast> {
  let lastPayload: DashboardBroadcast | null = null;
  await waitUntil(async () => {
    const response = await fetch(`${url}state`, { signal: AbortSignal.timeout(300) });
    lastPayload = (await response.json()) as DashboardBroadcast;
    return predicate(lastPayload);
  }, timeoutMs);
  if (!lastPayload) throw new Error("State endpoint did not return a payload");
  return lastPayload;
}

async function fetchState(url: string): Promise<DashboardBroadcast> {
  const response = await fetch(`${url}state`, { signal: AbortSignal.timeout(300) });
  return (await response.json()) as DashboardBroadcast;
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error("Timed out waiting for condition");
}

async function responds(url: string): Promise<boolean> {
  try {
    await fetch(`${url}healthz`, { signal: AbortSignal.timeout(300) });
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function daemonExited(child: ChildProcess | null): boolean {
  return child == null || child.exitCode !== null || child.signalCode !== null;
}

async function childExited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
}
