import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Either } from "effect";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitAnyWorker } from "./lib/herdr.ts";

const CLI = join(import.meta.dir, "coordinate.ts");
const decoder = new TextDecoder();
const servers: Server[] = [];

const request = (operation: string, input: Record<string, unknown>) => ({
  schema_version: 1,
  operation,
  input,
});

const runCli = (body: unknown) => {
  const child = Bun.spawnSync([process.execPath, CLI], {
    stdin: Buffer.from(JSON.stringify(body)),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: child.exitCode,
    stdout: JSON.parse(decoder.decode(child.stdout)) as Record<string, unknown>,
    stderr: decoder.decode(child.stderr),
  };
};

const runCliAsync = async (body: unknown) => {
  const child = Bun.spawn([process.execPath, CLI], {
    stdin: Buffer.from(JSON.stringify(body)),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return {
    exitCode,
    stdout: JSON.parse(stdout) as Record<string, unknown>,
    stderr,
  };
};

const ticket = (number: string, dependencies: string[], status = "queued") => ({
  number,
  dependencies,
  status,
});

const runtime = (runtimeId: string, ticketNumber: string, role = "implementor") => ({
  runtime_id: runtimeId,
  ticket: ticketNumber,
  role,
  state: "active",
});

const listen = async (server: Server, path: string): Promise<void> => {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
};

const closeServer = async (server: Server): Promise<void> => {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

const writeLine = (socket: Socket, value: unknown): void => {
  socket.write(`${JSON.stringify(value)}\n`);
};

const snapshot = (
  workers: Array<{ session: string; pane: string; status: string }>,
): Record<string, unknown> => ({
  id: "snapshot",
  result: {
    type: "session_snapshot",
    snapshot: {
      version: "0.9.1",
      protocol: 1,
      focused_workspace_id: null,
      focused_tab_id: null,
      focused_pane_id: null,
      workspaces: [],
      tabs: [],
      panes: workers.map((worker) => ({
        pane_id: worker.pane,
        workspace_id: "w1",
        tab_id: "w1:t1",
        agent_status: worker.status,
      })),
      layouts: [],
      agents: workers.map((worker) => ({
        display_agent: worker.session,
        title: worker.session,
        pane_id: worker.pane,
        workspace_id: "w1",
        tab_id: "w1:t1",
        agent_status: worker.status,
      })),
    },
  },
});

const socketPath = (): string =>
  join("/tmp", `coordinate-wait-${process.pid}-${crypto.randomUUID().slice(0, 8)}.sock`);

const worker = (runtimeId: string, ticketNumber: string, session: string, paneId: string) => ({
  runtime_id: runtimeId,
  ticket: ticketNumber,
  session,
  pane_id: paneId,
});

const retryState = (
  attempt: number,
  completedRetries: number,
): string => `# sample implementation run

Schema version: 1

## Tickets

| NN | harness | model | effort | rounds | esc | status | sha |
| -- | ------- | ----- | ------ | ------ | --- | ------ | --- |
| 04 | pi | openai-codex/gpt-5.6-sol | high | 0 | - | working | - |

## Active tickets

### 04

Worktree: /worktrees/ticket-04
Branch: feature/ticket-04
Implementor: {"harness":"pi","model":"openai-codex/gpt-5.6-sol","effort":"high"}
Implement skill: /skills/implement/SKILL.md
Session: run-04
Tab: implement 04
Pane: w1:p4
Artifact: /run/briefs/launch-04-${attempt}.json
Attempt: ${attempt}
Retry: ${completedRetries} of 3
Phase: working
Last diagnostic: none

## Decisions
`;

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

describe("bounded dependency scheduling", () => {
  it("fills a wide ready frontier deterministically while reviewers use no capacity", () => {
    const result = runCli(
      request("scheduler.plan", {
        mode: "parallel",
        max_implementors: 2,
        tickets: [ticket("04", []), ticket("02", []), ticket("01", []), ticket("03", ["01"])],
        runtimes: [runtime("review-09", "09", "reviewer")],
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.result).toEqual({
      mode: "parallel",
      capacity: 2,
      active_implementors: 0,
      available_slots: 2,
      launch_tickets: ["01", "02"],
    });
  });

  it("refills newly available capacity after a landing without duplicate launches", () => {
    const result = runCli(
      request("scheduler.plan", {
        mode: "parallel",
        max_implementors: 2,
        tickets: [
          ticket("01", [], "landed"),
          ticket("02", [], "working"),
          ticket("03", ["01"]),
          ticket("04", []),
        ],
        runtimes: [runtime("worker-02", "02")],
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.result).toEqual({
      mode: "parallel",
      capacity: 2,
      active_implementors: 1,
      available_slots: 1,
      launch_tickets: ["03"],
    });
  });

  it("drains after a capacity reduction and refills after an increase", () => {
    const tickets = [ticket("01", [], "working"), ticket("02", [], "working"), ticket("03", [])];
    const runtimes = [runtime("worker-01", "01"), runtime("worker-02", "02")];

    const reduced = runCli(
      request("scheduler.plan", {
        mode: "parallel",
        max_implementors: 1,
        tickets,
        runtimes,
      }),
    );
    const increased = runCli(
      request("scheduler.plan", {
        mode: "parallel",
        max_implementors: 3,
        tickets,
        runtimes,
      }),
    );

    expect(reduced.exitCode).toBe(0);
    expect(reduced.stdout.result).toEqual({
      mode: "parallel",
      capacity: 1,
      active_implementors: 2,
      available_slots: 0,
      launch_tickets: [],
    });
    expect(increased.exitCode).toBe(0);
    expect(increased.stdout.result).toEqual({
      mode: "parallel",
      capacity: 3,
      active_implementors: 2,
      available_slots: 1,
      launch_tickets: ["03"],
    });
  });

  it("treats serial mode as one implementor and requires a positive parallel cap", () => {
    const serial = runCli(
      request("scheduler.plan", {
        mode: "serial",
        max_implementors: 1,
        tickets: [ticket("02", []), ticket("01", [])],
        runtimes: [],
      }),
    );
    const missingCap = runCli(
      request("scheduler.plan", {
        mode: "parallel",
        max_implementors: null,
        tickets: [ticket("01", [])],
        runtimes: [],
      }),
    );

    expect(serial.exitCode).toBe(0);
    expect(serial.stdout.result).toEqual({
      mode: "serial",
      capacity: 1,
      active_implementors: 0,
      available_slots: 1,
      launch_tickets: ["01"],
    });
    expect(missingCap.exitCode).toBe(2);
    expect(missingCap.stdout.errors).toEqual([
      {
        code: "request.invalid",
        message:
          "`scheduler.plan` parallel mode requires a positive input.max_implementors; serial mode requires exactly 1.",
        remediation: "Send one JSON request matching the documented schema-version-1 contract.",
      },
    ]);
  });
});

describe("wait-any request validation", () => {
  it("rejects duplicate runtime, session, and pane identities with exact errors", () => {
    const base = [
      worker("runtime-01", "01", "run-01", "w1:p1"),
      worker("runtime-02", "02", "run-02", "w1:p2"),
    ];
    const cases = [
      {
        workers: [base[0], { ...base[1], runtime_id: "runtime-01" }],
        message: "`herdr.wait_any` workers contain duplicate runtime_id `runtime-01`.",
      },
      {
        workers: [base[0], { ...base[1], session: "run-01" }],
        message: "`herdr.wait_any` workers contain duplicate session `run-01`.",
      },
      {
        workers: [base[0], { ...base[1], pane_id: "w1:p1" }],
        message: "`herdr.wait_any` workers contain duplicate pane_id `w1:p1`.",
      },
    ];

    for (const candidate of cases) {
      const result = runCli(
        request("herdr.wait_any", {
          socket_path: "/tmp/herdr.sock",
          timeout_ms: 500,
          workers: candidate.workers,
        }),
      );
      expect(result.exitCode).toBe(2);
      expect(result.stdout.errors).toEqual([
        {
          code: "request.invalid",
          message: candidate.message,
          remediation: "Send one JSON request matching the documented schema-version-1 contract.",
        },
      ]);
    }
  });

  it("requires exactly three implementor launch retries", () => {
    for (const maxAttempts of [2, 4]) {
      const result = runCli(
        request("implementor.launch.prepare", {
          state_path: "/run/RESUME.md",
          artifact_path: "/run/briefs/launch-04.json",
          ticket: "04",
          worktree_path: "/worktrees/ticket-04",
          branch: "feature/ticket-04",
          session: "run-04",
          tab: "implement 04",
          pane: "w1:p4",
          role: { harness: "claude", model: "sonnet", effort: "medium" },
          implement_skill_path: null,
          prompt: "implement ticket 04",
          attempt: 1,
          max_attempts: maxAttempts,
        }),
      );
      expect(result.exitCode).toBe(2);
      expect(result.stdout.errors).toEqual([
        {
          code: "request.invalid",
          message: "`implementor.launch.prepare` requires input.max_attempts to equal 3.",
          remediation: "Send one JSON request matching the documented schema-version-1 contract.",
        },
      ]);
    }
  });
});

describe("event-driven scheduling documentation", () => {
  it("documents the bounded cap and helper cycle without legacy wake mechanisms", () => {
    const skill = readFileSync(join(import.meta.dir, "..", "SKILL.md"), "utf8");
    const helper = readFileSync(join(import.meta.dir, "..", "references", "helper-cli.md"), "utf8");
    const resume = readFileSync(
      join(import.meta.dir, "..", "references", "resume-format.md"),
      "utf8",
    );

    expect(skill.includes("--parallel <N>")).toBe(true);
    expect(resume.includes("Parallel cap:")).toBe(true);
    expect(helper.includes("## `scheduler.plan`")).toBe(true);
    expect(helper.includes("## `herdr.wait_any`")).toBe(true);
    expect(helper.includes("## `infrastructure.retry.record`")).toBe(true);
    expect(skill.includes("CronCreate")).toBe(false);
    expect(skill.includes("/loop 10m")).toBe(false);
    expect(resume.includes("Monitor:")).toBe(false);
  });
});

describe("Herdr event-driven wait-any", () => {
  it("subscribes before snapshot and preserves a completion event from the bootstrap race", async () => {
    const path = socketPath();
    const order: string[] = [];
    let subscription: Socket | undefined;
    const server = createServer((socket) => {
      let buffered = "";
      socket.on("data", (chunk) => {
        buffered += chunk.toString();
        for (const line of buffered.split("\n").slice(0, -1)) {
          const message = JSON.parse(line) as { id: string; method: string };
          if (message.method === "events.subscribe") {
            order.push("subscribe");
            subscription = socket;
            writeLine(socket, { id: message.id, result: { type: "subscription_started" } });
          }
          if (message.method === "session.snapshot") {
            order.push("snapshot");
            writeLine(subscription!, {
              event: "pane.agent_status_changed",
              data: {
                type: "pane_agent_status_changed",
                pane_id: "w1:p1",
                workspace_id: "w1",
                agent_status: "done",
              },
            });
            writeLine(socket, snapshot([{ session: "run-01", pane: "w1:p1", status: "working" }]));
          }
        }
        buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
      });
    });
    await listen(server, path);

    const result = await runCliAsync(
      request("herdr.wait_any", {
        socket_path: path,
        timeout_ms: 500,
        workers: [worker("runtime-01", "01", "run-01", "w1:p1")],
      }),
    );

    expect(order).toEqual(["subscribe", "snapshot"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.result).toEqual({
      reason: "status",
      worker: {
        runtime_id: "runtime-01",
        ticket: "01",
        session: "run-01",
        pane_id: "w1:p1",
        previous_pane_id: "w1:p1",
        status: "done",
      },
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
    });
  });

  it("returns the first of simultaneous meaningful events in socket order", async () => {
    const path = socketPath();
    let subscription: Socket | undefined;
    const server = createServer((socket) => {
      let buffered = "";
      socket.on("data", (chunk) => {
        buffered += chunk.toString();
        for (const line of buffered.split("\n").slice(0, -1)) {
          const message = JSON.parse(line) as { id: string; method: string };
          if (message.method === "events.subscribe") {
            subscription = socket;
            writeLine(socket, { id: message.id, result: { type: "subscription_started" } });
          }
          if (message.method === "session.snapshot") {
            writeLine(
              socket,
              snapshot([
                { session: "run-01", pane: "w1:p1", status: "working" },
                { session: "run-02", pane: "w1:p2", status: "working" },
              ]),
            );
            subscription!.write(
              `${JSON.stringify({
                event: "pane.agent_status_changed",
                data: {
                  type: "pane_agent_status_changed",
                  pane_id: "w1:p2",
                  workspace_id: "w1",
                  agent_status: "blocked",
                },
              })}\n${JSON.stringify({
                event: "pane.agent_status_changed",
                data: {
                  type: "pane_agent_status_changed",
                  pane_id: "w1:p1",
                  workspace_id: "w1",
                  agent_status: "done",
                },
              })}\n`,
            );
          }
        }
        buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
      });
    });
    await listen(server, path);

    const result = await runCliAsync(
      request("herdr.wait_any", {
        socket_path: path,
        timeout_ms: 500,
        workers: [
          worker("runtime-01", "01", "run-01", "w1:p1"),
          worker("runtime-02", "02", "run-02", "w1:p2"),
        ],
      }),
    );

    expect(result.exitCode).toBe(0);
    expect((result.stdout.result as { worker: Record<string, unknown> }).worker).toEqual({
      runtime_id: "runtime-02",
      ticket: "02",
      session: "run-02",
      pane_id: "w1:p2",
      previous_pane_id: "w1:p2",
      status: "blocked",
    });
  });

  it("refreshes a stale pane identity from an already terminal snapshot", async () => {
    const path = socketPath();
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
            writeLine(socket, snapshot([{ session: "run-01", pane: "w9:p7", status: "blocked" }]));
          }
        }
        buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
      });
    });
    await listen(server, path);

    const result = await runCliAsync(
      request("herdr.wait_any", {
        socket_path: path,
        timeout_ms: 500,
        workers: [worker("runtime-01", "01", "run-01", "w1:p1")],
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.result).toEqual({
      reason: "status",
      worker: {
        runtime_id: "runtime-01",
        ticket: "01",
        session: "run-01",
        pane_id: "w9:p7",
        previous_pane_id: "w1:p1",
        status: "blocked",
      },
      workers: [
        {
          runtime_id: "runtime-01",
          ticket: "01",
          session: "run-01",
          pane_id: "w9:p7",
          previous_pane_id: "w1:p1",
          status: "blocked",
        },
      ],
    });
  });

  it("ignores an old-pane exit after refreshing a working runtime", async () => {
    const path = socketPath();
    let originalSubscription: Socket | undefined;
    let subscriptions = 0;
    const server = createServer((socket) => {
      let buffered = "";
      socket.on("data", (chunk) => {
        buffered += chunk.toString();
        for (const line of buffered.split("\n").slice(0, -1)) {
          const message = JSON.parse(line) as { id: string; method: string };
          if (message.method === "events.subscribe") {
            subscriptions += 1;
            if (subscriptions === 1) originalSubscription = socket;
            writeLine(socket, { id: message.id, result: { type: "subscription_started" } });
          }
          if (message.method === "session.snapshot") {
            if (subscriptions === 2) {
              writeLine(originalSubscription!, {
                event: "pane.exited",
                data: { type: "pane_exited", pane_id: "w1:p1", workspace_id: "w1" },
              });
            }
            writeLine(socket, snapshot([{ session: "run-01", pane: "w9:p7", status: "working" }]));
          }
        }
        buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
      });
    });
    await listen(server, path);

    const result = await runCliAsync(
      request("herdr.wait_any", {
        socket_path: path,
        timeout_ms: 75,
        workers: [worker("runtime-01", "01", "run-01", "w1:p1")],
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.result).toEqual({
      reason: "timeout",
      worker: null,
      workers: [
        {
          runtime_id: "runtime-01",
          ticket: "01",
          session: "run-01",
          pane_id: "w9:p7",
          previous_pane_id: "w1:p1",
          status: "working",
        },
      ],
    });
  });

  it("closes a replacement subscription when the refreshed snapshot is malformed", async () => {
    const path = socketPath();
    let subscriptionCount = 0;
    let snapshotCount = 0;
    let observeReplacementClose: ((value: boolean) => void) | undefined;
    const replacementClosed = new Promise<boolean>((resolve) => {
      observeReplacementClose = resolve;
    });
    const server = createServer((socket) => {
      let buffered = "";
      socket.on("data", (chunk) => {
        buffered += chunk.toString();
        for (const line of buffered.split("\n").slice(0, -1)) {
          const message = JSON.parse(line) as { id: string; method: string };
          if (message.method === "events.subscribe") {
            subscriptionCount += 1;
            if (subscriptionCount === 2) {
              socket.on("close", () => observeReplacementClose!(true));
            }
            writeLine(socket, { id: message.id, result: { type: "subscription_started" } });
          }
          if (message.method === "session.snapshot") {
            snapshotCount += 1;
            if (snapshotCount === 1) {
              writeLine(
                socket,
                snapshot([{ session: "run-01", pane: "w9:p7", status: "working" }]),
              );
            } else {
              socket.write("{not-json}\n");
            }
          }
        }
        buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
      });
    });
    await listen(server, path);

    const result = await runCliAsync(
      request("herdr.wait_any", {
        socket_path: path,
        timeout_ms: 500,
        workers: [worker("runtime-01", "01", "run-01", "w1:p1")],
      }),
    );
    const serverObservedClose = await Promise.race([
      replacementClosed,
      Bun.sleep(500).then(() => false),
    ]);

    expect(result.exitCode).toBe(1);
    expect((result.stdout.errors as Array<{ code: string }>)[0]!.code).toBe(
      "herdr.snapshot_malformed",
    );
    expect(subscriptionCount).toBe(2);
    expect(snapshotCount).toBe(2);
    expect(serverObservedClose).toBe(true);
  });

  it("returns pane-exited when an active runtime is absent from the snapshot", async () => {
    const path = socketPath();
    const server = createServer((socket) => {
      let buffered = "";
      socket.on("data", (chunk) => {
        buffered += chunk.toString();
        for (const line of buffered.split("\n").slice(0, -1)) {
          const message = JSON.parse(line) as { id: string; method: string };
          if (message.method === "events.subscribe") {
            writeLine(socket, { id: message.id, result: { type: "subscription_started" } });
          }
          if (message.method === "session.snapshot") writeLine(socket, snapshot([]));
        }
        buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
      });
    });
    await listen(server, path);

    const result = await runCliAsync(
      request("herdr.wait_any", {
        socket_path: path,
        timeout_ms: 500,
        workers: [worker("runtime-01", "01", "run-01", "w1:p1")],
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.result).toEqual({
      reason: "pane_exited",
      worker: {
        runtime_id: "runtime-01",
        ticket: "01",
        session: "run-01",
        pane_id: "w1:p1",
        previous_pane_id: "w1:p1",
        status: "exited",
      },
      workers: [
        {
          runtime_id: "runtime-01",
          ticket: "01",
          session: "run-01",
          pane_id: "w1:p1",
          previous_pane_id: "w1:p1",
          status: "exited",
        },
      ],
    });
  });

  it("returns a complete refreshed snapshot on bounded timeout", async () => {
    const path = socketPath();
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
            writeLine(
              socket,
              snapshot([
                { session: "run-01", pane: "w1:p1", status: "working" },
                { session: "run-02", pane: "w1:p2", status: "unknown" },
              ]),
            );
          }
        }
        buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
      });
    });
    await listen(server, path);

    const result = await runCliAsync(
      request("herdr.wait_any", {
        socket_path: path,
        timeout_ms: 25,
        workers: [
          worker("runtime-01", "01", "run-01", "w1:p1"),
          worker("runtime-02", "02", "run-02", "w1:p2"),
        ],
      }),
    );

    expect(result.exitCode).toBe(0);
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
        {
          runtime_id: "runtime-02",
          ticket: "02",
          session: "run-02",
          pane_id: "w1:p2",
          previous_pane_id: "w1:p2",
          status: "unknown",
        },
      ],
    });
  });

  it("closes the subscription when acknowledgement JSON is malformed", async () => {
    const path = socketPath();
    let observeClose: ((value: boolean) => void) | undefined;
    const closed = new Promise<boolean>((resolve) => {
      observeClose = resolve;
    });
    const server = createServer((socket) => {
      socket.on("close", () => observeClose!(true));
      socket.on("data", () => socket.write("{not-json}\n"));
    });
    await listen(server, path);

    const result = await runCliAsync(
      request("herdr.wait_any", {
        socket_path: path,
        timeout_ms: 500,
        workers: [worker("runtime-01", "01", "run-01", "w1:p1")],
      }),
    );
    const serverObservedClose = await Promise.race([closed, Bun.sleep(500).then(() => false)]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.errors).toEqual([
      {
        code: "herdr.subscribe_malformed",
        message: "Herdr returned malformed subscription acknowledgement JSON.",
        remediation:
          "Treat this as a Herdr infrastructure failure and retry with the same worker bindings.",
      },
    ]);
    expect(serverObservedClose).toBe(true);
  });

  it("writes no subscription request when connection completes after the deadline", async () => {
    const path = socketPath();
    let connections = 0;
    let subscriptionWrites = 0;
    let observeClose: ((value: boolean) => void) | undefined;
    const closed = new Promise<boolean>((resolve) => {
      observeClose = resolve;
    });
    const server = createServer((socket) => {
      connections += 1;
      socket.on("data", () => {
        subscriptionWrites += 1;
      });
      socket.on("close", () => observeClose!(true));
    });
    await listen(server, path);
    let clockReads = 0;
    const clock = (): number => {
      clockReads += 1;
      return clockReads >= 3 ? 101 : 0;
    };

    const outcome = await Effect.runPromise(
      Effect.either(
        waitAnyWorker(
          {
            socketPath: path,
            timeoutMs: 100,
            workers: [
              { runtimeId: "runtime-01", ticket: "01", session: "run-01", paneId: "w1:p1" },
            ],
          },
          clock,
        ),
      ),
    );
    const serverObservedClose = await Promise.race([closed, Bun.sleep(500).then(() => false)]);

    expect(Either.isLeft(outcome)).toBe(true);
    if (Either.isLeft(outcome)) expect(outcome.left.issue.code).toBe("herdr.subscribe_timeout");
    expect(connections).toBe(1);
    expect(subscriptionWrites).toBe(0);
    expect(serverObservedClose).toBe(true);
  });

  it("writes no snapshot request when connection completes after the deadline", async () => {
    const path = socketPath();
    let connections = 0;
    let snapshotWrites = 0;
    let observeSnapshotClose: ((value: boolean) => void) | undefined;
    const snapshotClosed = new Promise<boolean>((resolve) => {
      observeSnapshotClose = resolve;
    });
    const server = createServer((socket) => {
      connections += 1;
      const connection = connections;
      if (connection === 2) socket.on("close", () => observeSnapshotClose!(true));
      let buffered = "";
      socket.on("data", (chunk) => {
        if (connection === 2) snapshotWrites += 1;
        buffered += chunk.toString();
        for (const line of buffered.split("\n").slice(0, -1)) {
          const message = JSON.parse(line) as { id: string; method: string };
          if (message.method === "events.subscribe") {
            writeLine(socket, { id: message.id, result: { type: "subscription_started" } });
          }
          if (message.method === "session.snapshot") {
            writeLine(socket, snapshot([{ session: "run-01", pane: "w1:p1", status: "working" }]));
          }
        }
        buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
      });
    });
    await listen(server, path);
    let clockReads = 0;
    const clock = (): number => {
      clockReads += 1;
      return clockReads >= 6 ? 101 : 0;
    };

    const outcome = await Effect.runPromise(
      Effect.either(
        waitAnyWorker(
          {
            socketPath: path,
            timeoutMs: 100,
            workers: [
              { runtimeId: "runtime-01", ticket: "01", session: "run-01", paneId: "w1:p1" },
            ],
          },
          clock,
        ),
      ),
    );
    const serverObservedClose = await Promise.race([
      snapshotClosed,
      Bun.sleep(500).then(() => false),
    ]);

    expect(Either.isLeft(outcome)).toBe(true);
    if (Either.isLeft(outcome)) expect(outcome.left.issue.code).toBe("herdr.snapshot_timeout");
    expect(connections).toBe(2);
    expect(snapshotWrites).toBe(0);
    expect(serverObservedClose).toBe(true);
  });

  it("does not start a final snapshot after the requested timeout expires", async () => {
    const path = socketPath();
    let snapshots = 0;
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
            snapshots += 1;
            if (snapshots === 1) {
              writeLine(
                socket,
                snapshot([{ session: "run-01", pane: "w1:p1", status: "working" }]),
              );
            }
          }
        }
        buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
      });
    });
    await listen(server, path);

    const startupStarted = performance.now();
    const startup = await runCliAsync(request("unknown.operation", {}));
    const processStartupMs = performance.now() - startupStarted;
    expect(startup.exitCode).toBe(2);

    // Account for measured Bun CLI startup plus 100 ms of ordinary CI scheduling jitter.
    const processSchedulingAllowanceMs = 100;
    const started = performance.now();
    const result = await runCliAsync(
      request("herdr.wait_any", {
        socket_path: path,
        timeout_ms: 50,
        workers: [worker("runtime-01", "01", "run-01", "w1:p1")],
      }),
    );
    const elapsed = performance.now() - started;

    expect(result.exitCode).toBe(0);
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
    });
    expect(snapshots).toBe(1);
    expect(elapsed < processStartupMs + 50 + processSchedulingAllowanceMs).toBe(true);
  });

  it("fails on malformed events and socket disconnects", async () => {
    const runFailure = async (failure: "malformed" | "disconnect") => {
      const path = socketPath();
      let subscription: Socket | undefined;
      const server = createServer((socket) => {
        let buffered = "";
        socket.on("data", (chunk) => {
          buffered += chunk.toString();
          for (const line of buffered.split("\n").slice(0, -1)) {
            const message = JSON.parse(line) as { id: string; method: string };
            if (message.method === "events.subscribe") {
              subscription = socket;
              writeLine(socket, { id: message.id, result: { type: "subscription_started" } });
            }
            if (message.method === "session.snapshot") {
              writeLine(
                socket,
                snapshot([{ session: "run-01", pane: "w1:p1", status: "working" }]),
              );
              if (failure === "malformed") subscription!.write("{not-json}\n");
              else subscription!.end();
            }
          }
          buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
        });
      });
      await listen(server, path);
      return runCliAsync(
        request("herdr.wait_any", {
          socket_path: path,
          timeout_ms: 500,
          workers: [worker("runtime-01", "01", "run-01", "w1:p1")],
        }),
      );
    };

    const malformed = await runFailure("malformed");
    const disconnected = await runFailure("disconnect");

    expect(malformed.exitCode).toBe(1);
    expect((malformed.stdout.errors as Array<{ code: string }>)[0]!.code).toBe(
      "herdr.event_malformed",
    );
    expect(disconnected.exitCode).toBe(1);
    expect((disconnected.stdout.errors as Array<{ code: string }>)[0]!.code).toBe(
      "herdr.subscription_disconnected",
    );
  });
});

describe("shared infrastructure retries", () => {
  it("returns increasing bounded delays with the exact persisted binding", () => {
    const root = mkdtempSync(join(tmpdir(), "coordinate-retry-"));
    const statePath = join(root, "RESUME.md");
    const delays: number[] = [];

    for (const attempt of [1, 2, 3]) {
      writeFileSync(statePath, retryState(attempt, attempt - 1));
      const result = runCli(
        request("infrastructure.retry.record", {
          state_path: statePath,
          ticket: "04",
          attempt,
          failure: "launch",
          diagnostic: `temporary failure ${attempt}`,
        }),
      );
      expect(result.exitCode).toBe(0);
      const outcome = result.stdout.result as {
        action: string;
        delay_ms: number;
        binding: unknown;
      };
      expect(outcome.action).toBe("retry");
      delays.push(outcome.delay_ms);
      expect(outcome.binding).toEqual({
        role: { harness: "pi", model: "openai-codex/gpt-5.6-sol", effort: "high" },
        worktree_path: "/worktrees/ticket-04",
        branch: "feature/ticket-04",
        implement_skill_path: "/skills/implement/SKILL.md",
        session: "run-04",
        tab: "implement 04",
      });
      expect(readFileSync(statePath, "utf8").includes("Phase: retry waiting")).toBe(true);
    }

    expect(delays).toEqual([1000, 2000, 4000]);
  });

  it("blocks only the affected ticket after three retries are exhausted", () => {
    const root = mkdtempSync(join(tmpdir(), "coordinate-retry-"));
    const statePath = join(root, "RESUME.md");
    writeFileSync(
      statePath,
      retryState(4, 3).replace(
        "| 04 | pi | openai-codex/gpt-5.6-sol | high | 0 | - | working | - |",
        "| 04 | pi | openai-codex/gpt-5.6-sol | high | 0 | - | working | - |\n| 05 | - | - | - | 0 | - | queued | - |",
      ),
    );

    const result = runCli(
      request("infrastructure.retry.record", {
        state_path: statePath,
        ticket: "04",
        attempt: 4,
        failure: "herdr",
        diagnostic: "socket disconnected",
      }),
    );

    expect(result.exitCode).toBe(0);
    expect((result.stdout.result as { action: string }).action).toBe("block");
    const persisted = readFileSync(statePath, "utf8");
    expect(
      persisted.includes("| 04 | pi | openai-codex/gpt-5.6-sol | high | 0 | - | blocked | - |"),
    ).toBe(true);
    expect(persisted.includes("| 05 | - | - | - | 0 | - | queued | - |")).toBe(true);
    expect(persisted.includes("Phase: retry exhausted")).toBe(true);
  });
});
