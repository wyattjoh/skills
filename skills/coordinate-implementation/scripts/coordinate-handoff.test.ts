import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCliInProcess } from "./test-cli.ts";

const CLI = join(import.meta.dir, "coordinate.ts");
const servers: Server[] = [];

const request = (operation: string, input: Record<string, unknown>) => ({
  schema_version: 1,
  operation,
  input,
});

const runCli = async (
  body: unknown,
  env: Record<string, string | undefined> = process.env,
): Promise<{
  exitCode: number;
  stdout: Record<string, unknown>;
  stderr: string;
}> => {
  const child = await runCliInProcess(body, env);
  return {
    exitCode: child.exitCode,
    stdout: JSON.parse(child.stdout) as Record<string, unknown>,
    stderr: child.stderr,
  };
};

/**
 * Spawns a real CLI process, for tests that exercise cross-process locking.
 */
const runCliProcess = async (
  body: unknown,
  env: Record<string, string | undefined> = process.env,
): Promise<{
  exitCode: number;
  stdout: Record<string, unknown>;
  stderr: string;
}> => {
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

const listen = async (server: Server, path: string): Promise<void> => {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
};

const closeServer = async (server: Server): Promise<void> => {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

const writeLine = (socket: Socket, value: unknown): void => {
  socket.write(`${JSON.stringify(value)}\n`);
};

const socketPath = (): string =>
  join("/tmp", `coordinate-handoff-${process.pid}-${crypto.randomUUID().slice(0, 8)}.sock`);

const snapshot = (
  contextUsed: number | undefined,
  contextLimit: number | undefined,
  workerPane = "w1:p1",
  includeWorker = true,
  coordinatorPane = "w1:p0",
  workerStatus = "working",
): Record<string, unknown> => ({
  id: "snapshot",
  result: {
    type: "session_snapshot",
    snapshot: {
      panes: [
        { pane_id: coordinatorPane, agent_status: "working" },
        ...(includeWorker ? [{ pane_id: workerPane, agent_status: workerStatus }] : []),
      ],
      agents: [
        {
          display_agent: "coordinator-run-5",
          title: "coordinator-run-5",
          pane_id: coordinatorPane,
          agent_status: "working",
          ...(contextUsed === undefined ? {} : { context_used: contextUsed }),
          ...(contextLimit === undefined ? {} : { context_limit: contextLimit }),
        },
        ...(includeWorker
          ? [
              {
                display_agent: "run-01",
                title: "run-01",
                pane_id: workerPane,
                agent_status: workerStatus,
                context_used: 10,
                context_limit: 100,
              },
            ]
          : []),
      ],
    },
  },
});

const serveSnapshot = async (
  contextUsed: number | undefined,
  contextLimit: number | undefined,
  workerPane = "w1:p1",
  includeWorker = true,
  coordinatorPane = "w1:p0",
  workerStatus = "working",
  onSnapshot: (() => void) | undefined = undefined,
): Promise<string> => {
  const path = socketPath();
  let snapshotHandled = false;
  const server = createServer((socket) => {
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += chunk.toString();
      for (const line of buffered.split("\n").slice(0, -1)) {
        const message = JSON.parse(line) as { id: string; method: string };
        if (message.method === "events.subscribe") {
          writeLine(socket, { id: message.id, result: { type: "subscription_started" } });
        }
        if (message.method === "session.snapshot") {
          if (!snapshotHandled) {
            snapshotHandled = true;
            onSnapshot?.();
          }
          writeLine(
            socket,
            snapshot(
              contextUsed,
              contextLimit,
              workerPane,
              includeWorker,
              coordinatorPane,
              workerStatus,
            ),
          );
        }
      }
      buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
    });
  });
  await listen(server, path);
  return path;
};

const waitInput = (path: string, phase: string): Record<string, unknown> => ({
  socket_path: path,
  timeout_ms: 500,
  workers: [{ runtime_id: "runtime-01", ticket: "01", session: "run-01", pane_id: "w1:p1" }],
  coordinator: {
    session: "coordinator-run-5",
    pane_id: "w1:p0",
    phase,
  },
});

const writeCommand = (directory: string, name: string): void => {
  const path = join(directory, name);
  writeFileSync(path, `#!${process.execPath}\nconsole.log("test harness");\n`);
  chmodSync(path, 0o755);
};

const roleState = (
  selectedHarness: "claude" | "pi",
  ownerHarness: "claude" | "pi",
): string => `# handoff run

Schema version: 2

Coordinator:
  harness: ${selectedHarness}
  model: ${selectedHarness === "claude" ? "sonnet" : "openai-codex/gpt-5.6-sol"}
  effort: high
  handoff: yes
  threshold: 80 percent
  unattended: block

Coordinator ownership:
  generation: 4
  pane: w1:p0
  harness: ${ownerHarness}
  model: ${ownerHarness === "claude" ? "fable" : "openai-codex/gpt-5.6-sol"}
  effort: high
  readiness: ready
  marker: coordinator-ready-4-w1:p0

## Decisions

- Existing decision.
`;

const readOwnershipBlock = (statePath: string): string => {
  const match = readFileSync(statePath, "utf8").match(/^Coordinator ownership:\n((?: {2}.+\n)+)/mu);
  return match?.[1]?.trim() ?? "";
};

const predecessorOwnership = `generation: 4
  pane: w1:p0
  harness: claude
  model: fable
  effort: high
  readiness: ready
  marker: coordinator-ready-4-w1:p0`;

const makeAcceptedRun = async (
  selectedHarness: "claude" | "pi" = "pi",
  ownerHarness: "claude" | "pi" = "claude",
): Promise<{
  root: string;
  runPath: string;
  statePath: string;
  artifactPath: string;
}> => {
  const root = mkdtempSync(join(tmpdir(), "coordinate-handoff-ready-"));
  const runPath = join(root, "run");
  const issuesPath = join(runPath, "issues");
  mkdirSync(join(runPath, "briefs"), { recursive: true });
  mkdirSync(issuesPath, { recursive: true });
  writeFileSync(join(runPath, "spec.md"), "# Accepted design\n\nCoordinate safely.\n");
  writeFileSync(
    join(issuesPath, "01-worker.md"),
    "# 01: Worker\n\n**Blocked by:** none\n\n**Status:** ready-for-agent\n\n- [ ] Worker completes.\n",
  );
  writeFileSync(
    join(runPath, "snapshot.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        source: {
          kind: "local",
          tracker: "local-files",
          reference: "file:handoff-run",
          tracker_workflow: null,
        },
        specification: {
          path: "spec.md",
          source_reference: "file:spec.md",
          agreed: true,
        },
        tickets: [
          {
            number: "01",
            path: "issues/01-worker.md",
            source_reference: "file:issues/01-worker.md",
            blocked_by: [],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  const statePath = join(runPath, "RESUME.md");
  writeFileSync(
    statePath,
    `${roleState(selectedHarness, ownerHarness)}\n## Tickets\n\n| NN | harness | model | effort | rounds | esc | status | sha |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| 01 | claude | opus | high | 0 | - | working | - |\n\n## Active tickets\n\n### 01\n\nWorktree: /tmp/run-01\nBranch: run-01\nImplementor: {"harness":"claude","model":"opus","effort":"high"}\nImplement skill: /implement\nSession: run-01\nTab: implement run 01\nPane: w1:p1\nArtifact: ${join(runPath, "briefs", "launch-01.json")}\nAttempt: 1\nRetry: 0 of 3\nPhase: working\nLast diagnostic: none\n`,
  );
  const accepted = await runCli(
    request("snapshot.accept", {
      run_path: runPath,
      state_path: statePath,
      writeback: null,
      project_remote_writes: "allowed",
      accepted_at: "2026-09-19T00:00:00Z",
    }),
  );
  expect(accepted.exitCode).toBe(0);
  const artifactPath = join(runPath, "briefs", "handoff-5-attempt-1.json");
  const path = await serveSnapshot(80, 100);
  const prepared = await runCli(
    request("coordinator.handoff.prepare", {
      state_path: statePath,
      run_path: runPath,
      artifact_path: artifactPath,
      session: "coordinator-run-5",
      successor_pane: "w1:p2",
      predecessor_session: "coordinator-run-5",
      socket_path: path,
      timeout_ms: 500,
      phase: "waiting",
      attempt: 1,
      max_retries: 3,
      previous_artifact_path: null,
    }),
  );
  expect(prepared.exitCode).toBe(0);
  return { root, runPath, statePath, artifactPath };
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

describe("released Herdr coordinator continuity documentation", () => {
  it("disables automatic handoff and documents durable replacement recovery", async () => {
    const skill = readFileSync(join(import.meta.dir, "..", "SKILL.md"), "utf8");
    const handoff = readFileSync(join(import.meta.dir, "..", "references", "handoff.md"), "utf8");
    const helper = readFileSync(join(import.meta.dir, "..", "references", "helper-cli.md"), "utf8");
    const resume = readFileSync(
      join(import.meta.dir, "..", "references", "resume-format.md"),
      "utf8",
    );

    const continuity = skill.slice(
      skill.indexOf("## Coordinator continuity"),
      skill.indexOf("## Resume"),
    );
    expect(continuity.split("\n").slice(0, 8)).toEqual([
      "## Coordinator continuity",
      "",
      "Automatic coordinator handoff is disabled because Herdr 0.9.1 does not expose",
      "normalized model context utilization. Record `Coordinator.handoff: disabled`",
      "and `Coordinator.threshold: unavailable` in RESUME.md. Continue through the",
      "active harness's normal context compaction without replacing the coordinator.",
      "Never parse rendered pane output to estimate context use.",
      "",
    ]);
    expect(handoff.match(/^## .+$/gmu)).toEqual([
      "## Continue through normal compaction",
      "## Recover an ended coordinator",
      "## Unsupported automatic operations",
      "## Binding rules",
    ]);
    expect(helper.match(/^### `coordinator\.handoff\.[a-z]+`$/gmu)).toEqual([
      "### `coordinator.handoff.prepare`",
      "### `coordinator.handoff.retry`",
      "### `coordinator.handoff.ready`",
      "### `coordinator.handoff.verify`",
    ]);
    expect(resume.match(/^  (?:handoff|threshold):.+$/gmu)?.slice(0, 2)).toEqual([
      "  handoff:    disabled",
      "  threshold:  unavailable",
    ]);
    expect(handoff.match(/rendered pane output/gu)).toEqual(["rendered pane output"]);
  });
});

describe("automatic coordinator context handoff", () => {
  it("requests handoff at exactly 80 percent from normalized Herdr fields", async () => {
    const path = await serveSnapshot(80, 100);

    const result = await runCli(request("herdr.wait_any", waitInput(path, "waiting")));

    expect(result.exitCode).toBe(0);
    expect(result.stdout.result).toEqual({
      reason: "handoff",
      worker: null,
      workers: [
        {
          runtime_id: "runtime-01",
          ticket: "01",
          session: "run-01",
          pane_id: "w1:p1",
          previous_pane_id: "w1:p1",
          status: "working",
        },
      ],
      coordinator: {
        session: "coordinator-run-5",
        pane_id: "w1:p0",
        previous_pane_id: "w1:p0",
        context_used: 80,
        context_limit: 100,
        utilization_percent: 80,
        handoff: "required",
      },
    });
  });

  it("prioritizes a required safe-point handoff over a terminal worker", async () => {
    const path = await serveSnapshot(80, 100, "w1:p1", true, "w1:p0", "done");

    const result = await runCli(request("herdr.wait_any", waitInput(path, "waiting")));

    expect(result.exitCode).toBe(0);
    expect((result.stdout.result as { reason: string }).reason).toBe("handoff");
    expect((result.stdout.result as { worker: unknown }).worker).toBe(null);
  });

  it("defers an over-threshold handoff until review reaches a safe point", async () => {
    const path = await serveSnapshot(99, 100);

    const result = await runCli(request("herdr.wait_any", waitInput(path, "reviewing")));

    expect(result.exitCode).toBe(0);
    expect((result.stdout.result as { reason: string }).reason).toBe("timeout");
    expect((result.stdout.result as { coordinator: { handoff: string } }).coordinator.handoff).toBe(
      "deferred",
    );
  });

  it("continues below the exact 80 percent threshold", async () => {
    const path = await serveSnapshot(799, 1_000);

    const result = await runCli(request("herdr.wait_any", waitInput(path, "waiting")));

    expect(result.exitCode).toBe(0);
    expect((result.stdout.result as { reason: string }).reason).toBe("timeout");
    expect((result.stdout.result as { coordinator: { handoff: string } }).coordinator.handoff).toBe(
      "continue",
    );
  });

  it("keeps a near-MAX_SAFE_INTEGER value strictly below 80 percent", async () => {
    const contextUsed = 7_205_759_403_792_791;
    const contextLimit = 9_007_199_254_740_989;
    const path = await serveSnapshot(contextUsed, contextLimit);

    const result = await runCli(request("herdr.wait_any", waitInput(path, "waiting")));

    expect(result.exitCode).toBe(0);
    const wait = result.stdout.result as {
      reason: string;
      coordinator: { context_used: number; context_limit: number; handoff: string };
    };
    expect({
      reason: wait.reason,
      context_used: wait.coordinator.context_used,
      context_limit: wait.coordinator.context_limit,
      handoff: wait.coordinator.handoff,
    }).toEqual({
      reason: "timeout",
      context_used: contextUsed,
      context_limit: contextLimit,
      handoff: "continue",
    });
  });

  it("continues worker coordination when normalized context data is unavailable", async () => {
    const path = await serveSnapshot(undefined, undefined);

    const result = await runCli(request("herdr.wait_any", waitInput(path, "waiting")));

    expect(result.exitCode).toBe(0);
    expect(result.stdout.errors).toEqual([]);
    expect(result.stdout.result).toEqual({
      reason: "timeout",
      worker: null,
      workers: [
        {
          runtime_id: "runtime-01",
          ticket: "01",
          session: "run-01",
          pane_id: "w1:p1",
          previous_pane_id: "w1:p1",
          status: "working",
        },
      ],
      coordinator: {
        session: "coordinator-run-5",
        pane_id: "w1:p0",
        previous_pane_id: "w1:p0",
        context_used: null,
        context_limit: null,
        utilization_percent: null,
        handoff: "unavailable",
      },
    });
  });
});

describe("successor readiness and predecessor close", () => {
  it("refreshes active workers, arms wait-any, and authorizes only the recorded predecessor close", async () => {
    const fixture = await makeAcceptedRun();
    const path = await serveSnapshot(10, 100, "w9:p7", true, "w1:p2");

    const ready = await runCli(
      request("coordinator.handoff.ready", {
        artifact_path: fixture.artifactPath,
        socket_path: path,
        timeout_ms: 500,
        project_remote_writes: "allowed",
      }),
    );

    expect(ready.exitCode).toBe(0);
    const marker = "coordinator-ready-5-w1:p2";
    const artifactDigest = `sha256:${createHash("sha256")
      .update(readFileSync(fixture.artifactPath))
      .digest("hex")}`;
    expect(ready.stdout.result).toEqual({
      ownership: {
        generation: 5,
        pane: "w1:p2",
        harness: "pi",
        model: "openai-codex/gpt-5.6-sol",
        effort: "high",
        readiness: "ready",
        marker,
        predecessor_pane: "w1:p0",
        handoff_artifact_sha256: artifactDigest,
      },
      snapshot_revision: (
        (
          await runCli(
            request("snapshot.check", {
              run_path: fixture.runPath,
              state_path: fixture.statePath,
              writeback: null,
              project_remote_writes: "allowed",
              accepted_at: null,
            }),
          )
        ).stdout.result as { revision: string }
      ).revision,
      wait_reason: "timeout",
      workers: [
        {
          runtime_id: "run-01-attempt-1",
          ticket: "01",
          session: "run-01",
          pane_id: "w9:p7",
          previous_pane_id: "w1:p1",
          status: "working",
        },
      ],
      marker,
    });
    expect(readFileSync(fixture.statePath, "utf8").match(/^Pane:.+$/gmu)).toEqual(["Pane: w9:p7"]);

    const verified = await runCli(
      request("coordinator.handoff.verify", {
        artifact_path: fixture.artifactPath,
        observed_marker: marker,
      }),
    );
    expect(verified.exitCode).toBe(0);
    expect(verified.stdout.result).toEqual({
      verified: true,
      ownership: {
        generation: 5,
        pane: "w1:p2",
        harness: "pi",
        model: "openai-codex/gpt-5.6-sol",
        effort: "high",
        readiness: "ready",
        marker,
        predecessor_pane: "w1:p0",
        handoff_artifact_sha256: artifactDigest,
      },
      close_predecessor: true,
      close: { command: "herdr", args: ["pane", "close", "w1:p0"] },
    });
  });

  it("rejects stale markers and forged predecessor close artifacts", async () => {
    const fixture = await makeAcceptedRun();
    const path = await serveSnapshot(10, 100, "w9:p7", true, "w1:p2");
    const marker = "coordinator-ready-5-w1:p2";
    const ready = await runCli(
      request("coordinator.handoff.ready", {
        artifact_path: fixture.artifactPath,
        socket_path: path,
        timeout_ms: 500,
        project_remote_writes: "allowed",
      }),
    );
    expect(ready.exitCode).toBe(0);

    const staleMarker = await runCli(
      request("coordinator.handoff.verify", {
        artifact_path: fixture.artifactPath,
        observed_marker: "coordinator-ready-4-w1:p0",
      }),
    );
    expect(staleMarker.exitCode).toBe(1);
    expect((staleMarker.stdout.errors as Array<{ code: string }>)[0]!.code).toBe(
      "coordinator.marker_mismatch",
    );

    const forged = JSON.parse(readFileSync(fixture.artifactPath, "utf8")) as {
      predecessor: { pane: string };
    };
    forged.predecessor.pane = "w1:p9";
    writeFileSync(fixture.artifactPath, `${JSON.stringify(forged, null, 2)}\n`);
    const forgedClose = await runCli(
      request("coordinator.handoff.verify", {
        artifact_path: fixture.artifactPath,
        observed_marker: marker,
      }),
    );
    expect(forgedClose.exitCode).toBe(1);
    expect((forgedClose.stdout.errors as Array<{ code: string }>)[0]!.code).toBe(
      "coordinator.verify_artifact_mismatch",
    );
    expect(forgedClose.stdout.result).toBe(null);
  });

  it("rejects a stale predecessor generation before claiming ownership", async () => {
    const fixture = await makeAcceptedRun();
    const state = readFileSync(fixture.statePath, "utf8").replace("generation: 4", "generation: 5");
    writeFileSync(fixture.statePath, state);

    const ready = await runCli(
      request("coordinator.handoff.ready", {
        artifact_path: fixture.artifactPath,
        socket_path: "/missing/herdr.sock",
        timeout_ms: 500,
        project_remote_writes: "allowed",
      }),
    );

    expect(ready.exitCode).toBe(1);
    expect((ready.stdout.errors as Array<{ code: string }>)[0]!.code).toBe(
      "coordinator.artifact_binding_changed",
    );
    expect(readOwnershipBlock(fixture.statePath).split("\n")[0]).toBe("generation: 5");
  });

  it("keeps takeover unready when the accepted snapshot changes", async () => {
    const fixture = await makeAcceptedRun();
    writeFileSync(join(fixture.runPath, "spec.md"), "# Changed design\n");
    const path = await serveSnapshot(10, 100, "w9:p7", true, "w1:p2");

    const ready = await runCli(
      request("coordinator.handoff.ready", {
        artifact_path: fixture.artifactPath,
        socket_path: path,
        timeout_ms: 500,
        project_remote_writes: "allowed",
      }),
    );

    expect(ready.exitCode).toBe(1);
    expect((ready.stdout.errors as Array<{ code: string }>)[0]!.code).toBe(
      "coordinator.snapshot_changed",
    );
    expect(readOwnershipBlock(fixture.statePath)).toBe(predecessorOwnership);
    const retry = await runCli(
      request("coordinator.handoff.retry", {
        artifact_path: fixture.artifactPath,
        diagnostic: "snapshot changed before claim",
      }),
    );
    expect(retry.exitCode).toBe(0);
    expect((retry.stdout.result as { action: string }).action).toBe("retry");
  });

  it("keeps takeover unready when an active worker is missing", async () => {
    const fixture = await makeAcceptedRun();
    const path = await serveSnapshot(10, 100, "w9:p7", false, "w1:p2");

    const ready = await runCli(
      request("coordinator.handoff.ready", {
        artifact_path: fixture.artifactPath,
        socket_path: path,
        timeout_ms: 500,
        project_remote_writes: "allowed",
      }),
    );

    expect(ready.exitCode).toBe(1);
    expect((ready.stdout.errors as Array<{ code: string }>)[0]!.code).toBe(
      "coordinator.worker_missing",
    );
    expect(readOwnershipBlock(fixture.statePath)).toBe(predecessorOwnership);
  });

  for (const [label, mutateDuringWait] of [
    [
      "added runtime",
      (state: string) =>
        state
          .replace(
            "| 01 | claude | opus | high | 0 | - | working | - |",
            "| 01 | claude | opus | high | 0 | - | working | - |\n| 02 | claude | opus | high | 0 | - | working | - |",
          )
          .replace(
            "Last diagnostic: none\n",
            "Last diagnostic: none\n\n### 02\n\nSession: run-02\nPane: w2:p2\nAttempt: 1\n",
          ),
    ],
    [
      "removed runtime",
      (state: string) => state.replace(/### 01[\s\S]*?Last diagnostic: none\n/u, ""),
    ],
    ["changed runtime pane", (state: string) => state.replace("Pane: w1:p1", "Pane: w7:p7")],
  ] as const) {
    it(`rejects a concurrently ${label} under the ownership lock`, async () => {
      const fixture = await makeAcceptedRun();
      const path = await serveSnapshot(10, 100, "w9:p7", true, "w1:p2", "working", () => {
        writeFileSync(fixture.statePath, mutateDuringWait(readFileSync(fixture.statePath, "utf8")));
      });

      const ready = await runCli(
        request("coordinator.handoff.ready", {
          artifact_path: fixture.artifactPath,
          socket_path: path,
          timeout_ms: 500,
          project_remote_writes: "allowed",
        }),
      );

      expect(ready.exitCode).toBe(1);
      expect((ready.stdout.errors as Array<{ code: string }>)[0]!.code).toBe(
        "coordinator.worker_state_changed",
      );
      expect(readOwnershipBlock(fixture.statePath)).toBe(predecessorOwnership);
    });
  }

  for (const [label, mutateState] of [
    ["zero attempt", (state: string) => state.replace("Attempt: 1", "Attempt: 0")],
    ["landed ticket", (state: string) => state.replace("| working |", "| landed |")],
    [
      "duplicate ticket runtime",
      (state: string) =>
        state.replace(
          "Last diagnostic: none\n",
          "Last diagnostic: none\n\n### 01\n\nSession: duplicate-run\nPane: w8:p8\nAttempt: 2\n",
        ),
    ],
  ] as const) {
    it(`rejects ${label} state before successor ownership`, async () => {
      const fixture = await makeAcceptedRun();
      writeFileSync(fixture.statePath, mutateState(readFileSync(fixture.statePath, "utf8")));
      const path = await serveSnapshot(10, 100, "w9:p7", true, "w1:p2");

      const ready = await runCli(
        request("coordinator.handoff.ready", {
          artifact_path: fixture.artifactPath,
          socket_path: path,
          timeout_ms: 500,
          project_remote_writes: "allowed",
        }),
      );

      expect(ready.exitCode).toBe(1);
      expect((ready.stdout.errors as Array<{ code: string }>)[0]!.code).toBe(
        "coordinator.worker_state_malformed",
      );
      expect(readOwnershipBlock(fixture.statePath)).toBe(predecessorOwnership);
    });
  }

  for (const [ownerHarness, successorHarness] of [
    ["claude", "claude"],
    ["pi", "pi"],
    ["claude", "pi"],
    ["pi", "claude"],
  ] as const) {
    it(`completes the ${ownerHarness} to ${successorHarness} ownership lifecycle`, async () => {
      const fixture = await makeAcceptedRun(successorHarness, ownerHarness);
      const path = await serveSnapshot(10, 100, "w9:p7", true, "w1:p2");
      const ready = await runCli(
        request("coordinator.handoff.ready", {
          artifact_path: fixture.artifactPath,
          socket_path: path,
          timeout_ms: 500,
          project_remote_writes: "allowed",
        }),
      );
      expect(ready.exitCode).toBe(0);
      expect((ready.stdout.result as { ownership: { harness: string } }).ownership.harness).toBe(
        successorHarness,
      );
      const marker = (ready.stdout.result as { marker: string }).marker;
      const verified = await runCli(
        request("coordinator.handoff.verify", {
          artifact_path: fixture.artifactPath,
          observed_marker: marker,
        }),
      );
      expect(verified.exitCode).toBe(0);
      expect((verified.stdout.result as { close: { args: string[] } }).close.args).toEqual([
        "pane",
        "close",
        "w1:p0",
      ]);
    });
  }
});

describe("safe coordinator handoff launch", () => {
  for (const [ownerHarness, successorHarness] of [
    ["claude", "claude"],
    ["pi", "pi"],
    ["claude", "pi"],
    ["pi", "claude"],
  ] as const) {
    it(`constructs the ${ownerHarness} to ${successorHarness} launch as argument arrays`, async () => {
      const root = mkdtempSync(join(tmpdir(), "coordinate-handoff-launch-"));
      const bin = join(root, "bin");
      const runPath = join(root, "run with apostrophe's space");
      mkdirSync(bin, { recursive: true });
      mkdirSync(join(runPath, "briefs"), { recursive: true });
      writeCommand(bin, "pi");
      writeCommand(bin, "claude");
      const statePath = join(runPath, "RESUME.md");
      const artifactPath = join(runPath, "briefs", "handoff-5-attempt-1.json");
      writeFileSync(statePath, roleState(successorHarness, ownerHarness));

      const path = await serveSnapshot(80, 100);
      const result = await runCli(
        request("coordinator.handoff.prepare", {
          state_path: statePath,
          run_path: runPath,
          artifact_path: artifactPath,
          session: "coordinator-run-5",
          successor_pane: "w1:p2",
          predecessor_session: "coordinator-run-5",
          socket_path: path,
          timeout_ms: 500,
          phase: "waiting",
          attempt: 1,
          max_retries: 3,
          previous_artifact_path: null,
        }),
        { PATH: bin, HOME: join(root, "home") },
      );

      expect(result.exitCode).toBe(0);
      const successorModel = successorHarness === "claude" ? "sonnet" : "openai-codex/gpt-5.6-sol";
      const harnessArgs =
        successorHarness === "claude"
          ? ["--model", successorModel, "--effort", "high", "--permission-mode", "auto"]
          : ["--approve", "--model", successorModel, "--thinking", "high"];
      expect(result.stdout.result).toEqual({
        recovered: false,
        artifact_path: artifactPath,
        attempt: 1,
        max_retries: 3,
        predecessor: {
          generation: 4,
          pane: "w1:p0",
          role: {
            harness: ownerHarness,
            model: ownerHarness === "claude" ? "fable" : "openai-codex/gpt-5.6-sol",
            effort: "high",
          },
        },
        successor_role: { harness: successorHarness, model: successorModel, effort: "high" },
        launch: {
          start: {
            command: "herdr",
            args: [
              "agent",
              "start",
              "coordinator-run-5",
              "--kind",
              successorHarness,
              "--pane",
              "w1:p2",
              "--timeout",
              "300000",
              "--",
              ...harnessArgs,
            ],
          },
          prompt: {
            command: "herdr",
            args: [
              "agent",
              "prompt",
              "coordinator-run-5",
              `${successorHarness === "pi" ? "/skill:coordinate-implementation" : "/coordinate-implementation"} resume ${runPath}. Refresh active runtime bindings, validate schema and snapshot hashes, then claim coordinator generation 5 from pane w1:p0 for successor pane w1:p2. Arm herdr.wait_any before declaring readiness.`,
              "--wait",
              "--timeout",
              "300000",
            ],
          },
        },
      });
      expect(JSON.parse(readFileSync(artifactPath, "utf8"))).toEqual({
        schema_version: 1,
        kind: "coordinator-handoff",
        attempt: 1,
        max_retries: 3,
        run_path: runPath,
        state_path: statePath,
        predecessor: {
          generation: 4,
          pane: "w1:p0",
          role: {
            harness: ownerHarness,
            model: ownerHarness === "claude" ? "fable" : "openai-codex/gpt-5.6-sol",
            effort: "high",
          },
        },
        successor: {
          session: "coordinator-run-5",
          pane: "w1:p2",
          role: { harness: successorHarness, model: successorModel, effort: "high" },
        },
        context: { used: 80, limit: 100, threshold_percent: 80 },
        launch: (result.stdout.result as { launch: unknown }).launch,
      });
    });
  }

  it("retries a failed successor three times without surrendering predecessor ownership", async () => {
    const root = mkdtempSync(join(tmpdir(), "coordinate-handoff-retry-"));
    const runPath = join(root, "run");
    mkdirSync(join(runPath, "briefs"), { recursive: true });
    const statePath = join(runPath, "RESUME.md");
    const state = roleState("pi", "claude");
    writeFileSync(statePath, state);
    let previousArtifact: string | null = null;
    const path = await serveSnapshot(80, 100);

    for (const attempt of [1, 2, 3, 4]) {
      const artifactPath = join(runPath, "briefs", `handoff-5-attempt-${attempt}.json`);
      const prepared = await runCli(
        request("coordinator.handoff.prepare", {
          state_path: statePath,
          run_path: runPath,
          artifact_path: artifactPath,
          session: `coordinator-run-5-attempt-${attempt}`,
          successor_pane: `w1:p${attempt + 1}`,
          predecessor_session: "coordinator-run-5",
          socket_path: path,
          timeout_ms: 500,
          phase: "waiting",
          attempt,
          max_retries: 3,
          previous_artifact_path: previousArtifact,
        }),
      );
      expect(prepared.exitCode).toBe(0);

      const retry = await runCli(
        request("coordinator.handoff.retry", {
          artifact_path: artifactPath,
          diagnostic: `successor attempt ${attempt} exited before claim`,
        }),
      );
      expect(retry.exitCode).toBe(0);
      const diagnostic = `successor attempt ${attempt} exited before claim`;
      const evidencePath = `${artifactPath}.retry.json`;
      const artifactDigest = `sha256:${createHash("sha256")
        .update(readFileSync(artifactPath))
        .digest("hex")}`;
      const action = attempt <= 3 ? "retry" : "block";
      const delayMs = attempt <= 3 ? 1_000 * 2 ** (attempt - 1) : 0;
      expect(retry.stdout.result).toEqual({
        attempt,
        retries_completed: attempt - 1,
        max_retries: 3,
        action,
        delay_ms: delayMs,
        diagnostic,
        evidence_path: evidencePath,
        evidence_recovered: false,
        binding: {
          run_path: runPath,
          state_path: statePath,
          predecessor: {
            generation: 4,
            pane: "w1:p0",
            role: { harness: "claude", model: "fable", effort: "high" },
          },
          successor_role: {
            harness: "pi",
            model: "openai-codex/gpt-5.6-sol",
            effort: "high",
          },
        },
      });
      expect(JSON.parse(readFileSync(evidencePath, "utf8"))).toEqual({
        schema_version: 1,
        kind: "coordinator-handoff-retry",
        artifact_path: artifactPath,
        artifact_sha256: artifactDigest,
        diagnostic,
        decision: {
          attempt,
          retries_completed: attempt - 1,
          max_retries: 3,
          action,
          delay_ms: delayMs,
        },
      });
      if (attempt === 1) {
        const recovered = await runCli(
          request("coordinator.handoff.retry", {
            artifact_path: artifactPath,
            diagnostic,
          }),
        );
        expect(recovered.exitCode).toBe(0);
        expect(
          (recovered.stdout.result as { evidence_recovered: boolean }).evidence_recovered,
        ).toBe(true);
        const originalEvidence = readFileSync(evidencePath, "utf8");
        const conflicting = await runCli(
          request("coordinator.handoff.retry", {
            artifact_path: artifactPath,
            diagnostic: `${diagnostic} with changed detail`,
          }),
        );
        expect(conflicting.exitCode).toBe(1);
        expect((conflicting.stdout.errors as Array<{ code: string }>)[0]!.code).toBe(
          "coordinator.retry_evidence_conflict",
        );
        expect(readFileSync(evidencePath, "utf8")).toBe(originalEvidence);
      }
      expect(readFileSync(statePath, "utf8")).toBe(state);
      previousArtifact = artifactPath;
    }
  });

  it("derives threshold context from Herdr instead of forged request values", async () => {
    const root = mkdtempSync(join(tmpdir(), "coordinate-handoff-context-"));
    const runPath = join(root, "run");
    mkdirSync(join(runPath, "briefs"), { recursive: true });
    const statePath = join(runPath, "RESUME.md");
    writeFileSync(statePath, roleState("claude", "claude"));
    const artifactPath = join(runPath, "briefs", "handoff.json");
    const path = await serveSnapshot(79, 100);

    const result = await runCli(
      request("coordinator.handoff.prepare", {
        state_path: statePath,
        run_path: runPath,
        artifact_path: artifactPath,
        session: "coordinator-run-5",
        successor_pane: "w1:p2",
        predecessor_session: "coordinator-run-5",
        socket_path: path,
        timeout_ms: 500,
        phase: "waiting",
        context_used: 80,
        context_limit: 100,
        attempt: 1,
        max_retries: 3,
        previous_artifact_path: null,
      }),
    );

    expect(result.exitCode).toBe(1);
    expect((result.stdout.errors as Array<{ code: string }>)[0]!.code).toBe(
      "coordinator.handoff_below_threshold",
    );
    expect(Bun.file(artifactPath).size).toBe(0);
  });

  it("rejects a rounded-up large context value in a persisted artifact", async () => {
    const fixture = await makeAcceptedRun();
    const artifact = JSON.parse(readFileSync(fixture.artifactPath, "utf8")) as {
      context: { used: number; limit: number };
    };
    artifact.context.used = 7_205_759_403_792_791;
    artifact.context.limit = 9_007_199_254_740_989;
    writeFileSync(fixture.artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);

    const retry = await runCli(
      request("coordinator.handoff.retry", {
        artifact_path: fixture.artifactPath,
        diagnostic: "large boundary must stay below threshold",
      }),
    );

    expect(retry.exitCode).toBe(1);
    expect((retry.stdout.errors as Array<{ code: string }>)[0]!.code).toBe(
      "coordinator.artifact_binding_changed",
    );
    expect(Bun.file(`${fixture.artifactPath}.retry.json`).size).toBe(0);
  });

  it("rejects a valid sibling state file instead of canonical RESUME.md", async () => {
    const root = mkdtempSync(join(tmpdir(), "coordinate-handoff-state-path-"));
    const runPath = join(root, "run");
    mkdirSync(join(runPath, "briefs"), { recursive: true });
    const state = roleState("claude", "claude");
    writeFileSync(join(runPath, "RESUME.md"), state);
    const siblingStatePath = join(runPath, "other.md");
    writeFileSync(siblingStatePath, state);

    const result = await runCli(
      request("coordinator.handoff.prepare", {
        state_path: siblingStatePath,
        run_path: runPath,
        artifact_path: join(runPath, "briefs", "handoff.json"),
        session: "coordinator-run-5",
        successor_pane: "w1:p2",
        predecessor_session: "coordinator-run-5",
        socket_path: "/missing/herdr.sock",
        timeout_ms: 500,
        phase: "waiting",
        attempt: 1,
        max_retries: 3,
        previous_artifact_path: null,
      }),
    );

    expect(result.exitCode).toBe(1);
    expect((result.stdout.errors as Array<{ code: string }>)[0]!.code).toBe(
      "coordinator.run_mismatch",
    );
  });

  it("publishes one identical artifact across concurrent preparation", async () => {
    const root = mkdtempSync(join(tmpdir(), "coordinate-handoff-publish-"));
    const runPath = join(root, "run");
    mkdirSync(join(runPath, "briefs"), { recursive: true });
    const statePath = join(runPath, "RESUME.md");
    writeFileSync(statePath, roleState("claude", "claude"));
    const artifactPath = join(runPath, "briefs", "handoff.json");
    const path = await serveSnapshot(80, 100);
    const prepareRequest = request("coordinator.handoff.prepare", {
      state_path: statePath,
      run_path: runPath,
      artifact_path: artifactPath,
      session: "coordinator-run-5",
      successor_pane: "w1:p2",
      predecessor_session: "coordinator-run-5",
      socket_path: path,
      timeout_ms: 500,
      phase: "waiting",
      attempt: 1,
      max_retries: 3,
      previous_artifact_path: null,
    });

    const results = await Promise.all([
      runCliProcess(prepareRequest),
      runCliProcess(prepareRequest),
    ]);

    expect(results.map((result) => result.exitCode)).toEqual([0, 0]);
    expect(
      results
        .map((result) => (result.stdout.result as { recovered: boolean }).recovered)
        .toSorted(),
    ).toEqual([false, true]);
    expect((JSON.parse(readFileSync(artifactPath, "utf8")) as { kind: string }).kind).toBe(
      "coordinator-handoff",
    );
  });

  it("rejects automatic handoff when the run records the released Herdr policy", async () => {
    const root = mkdtempSync(join(tmpdir(), "coordinate-handoff-disabled-state-"));
    const runPath = join(root, "run");
    mkdirSync(join(runPath, "briefs"), { recursive: true });
    const statePath = join(runPath, "RESUME.md");
    writeFileSync(
      statePath,
      roleState("claude", "claude")
        .replace("handoff: yes", "handoff: disabled")
        .replace("threshold: 80 percent", "threshold: unavailable"),
    );
    const artifactPath = join(runPath, "briefs", "handoff.json");

    const result = await runCli(
      request("coordinator.handoff.prepare", {
        state_path: statePath,
        run_path: runPath,
        artifact_path: artifactPath,
        session: "coordinator-run-5",
        successor_pane: "w1:p2",
        predecessor_session: "coordinator-run-5",
        socket_path: "/missing/herdr.sock",
        timeout_ms: 500,
        phase: "waiting",
        attempt: 1,
        max_retries: 3,
        previous_artifact_path: null,
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout.errors).toEqual([
      {
        code: "coordinator.handoff_disabled",
        message: "Automatic coordinator handoff is disabled for this run.",
        remediation:
          "Continue in the current coordinator session, or resume from RESUME.md after that session ends.",
      },
    ]);
    expect(Bun.file(artifactPath).size).toBe(0);
  });

  it("rejects invalid durable handoff policy before launch", async () => {
    const root = mkdtempSync(join(tmpdir(), "coordinate-handoff-invalid-state-"));
    const runPath = join(root, "run");
    mkdirSync(join(runPath, "briefs"), { recursive: true });
    const statePath = join(runPath, "RESUME.md");
    writeFileSync(
      statePath,
      roleState("claude", "claude").replace("threshold: 80 percent", "threshold: 79 percent"),
    );
    const artifactPath = join(runPath, "briefs", "handoff.json");

    const result = await runCli(
      request("coordinator.handoff.prepare", {
        state_path: statePath,
        run_path: runPath,
        artifact_path: artifactPath,
        session: "coordinator-run-5",
        successor_pane: "w1:p2",
        predecessor_session: "coordinator-run-5",
        socket_path: "/missing/herdr.sock",
        timeout_ms: 500,
        phase: "waiting",
        attempt: 1,
        max_retries: 3,
        previous_artifact_path: null,
      }),
    );

    expect(result.exitCode).toBe(1);
    expect((result.stdout.errors as Array<{ code: string }>)[0]!.code).toBe(
      "state.coordinator_handoff_policy_malformed",
    );
    expect(Bun.file(artifactPath).size).toBe(0);
  });

  it("does not prepare a successor during an unsafe operation", async () => {
    const root = mkdtempSync(join(tmpdir(), "coordinate-handoff-unsafe-"));
    const runPath = join(root, "run");
    mkdirSync(join(runPath, "briefs"), { recursive: true });
    const statePath = join(runPath, "RESUME.md");
    writeFileSync(statePath, roleState("claude", "claude"));

    const result = await runCli(
      request("coordinator.handoff.prepare", {
        state_path: statePath,
        run_path: runPath,
        artifact_path: join(runPath, "briefs", "handoff.json"),
        session: "coordinator-run-5",
        successor_pane: "w1:p2",
        predecessor_session: "coordinator-run-5",
        socket_path: "/missing/herdr.sock",
        timeout_ms: 500,
        phase: "landing",
        attempt: 1,
        max_retries: 3,
        previous_artifact_path: null,
      }),
    );

    expect(result.exitCode).toBe(1);
    expect((result.stdout.errors as Array<{ code: string }>)[0]!.code).toBe(
      "coordinator.handoff_unsafe",
    );
    expect(readFileSync(statePath, "utf8")).toBe(roleState("claude", "claude"));
  });
});
