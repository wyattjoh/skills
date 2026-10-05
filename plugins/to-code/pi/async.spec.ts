import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { currentAssignment } from "../fleet/model.ts";
import { createAsyncFleetAdapter } from "./async.ts";
import { notifyCallback } from "./callbacks.ts";
import type { FleetPlatform } from "./platform.ts";
import { fleetStorage } from "./storage.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
type Tool = {
  name: string;
  execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; isError: boolean }>;
};
type Message = { customType: string; content: string; details: unknown };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const fakePi = (flags: Record<string, string>, cwd: string, session: string) => {
  const handlers = new Map<string, Handler[]>();
  const tools: Tool[] = [];
  const messages: Message[] = [];
  const branch: { type: string; customType: string; data: unknown; details: unknown }[] = [];
  const pi = {
    getFlag: (name: string) => flags[name],
    on: (name: string, handler: Handler) =>
      handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool: (tool: Tool) => tools.push(tool),
    appendEntry: (customType: string, data: unknown) =>
      branch.push({ type: "custom", customType, data, details: undefined }),
    sendMessage: (message: Message) => messages.push(message),
  };
  const ctx = {
    cwd,
    hasUI: false,
    ui: {},
    sessionManager: { getSessionId: () => session, getBranch: () => [...branch] },
  };
  return {
    pi,
    ctx,
    tools,
    messages,
    emit: async (name: string, event: unknown) =>
      Promise.all((handlers.get(name) ?? []).map((handler) => handler(event, ctx))),
    persist: async (message: Message) => {
      branch.push({
        type: "custom_message",
        customType: message.customType,
        data: undefined,
        details: message.details,
      });
      await Promise.all(
        (handlers.get("message_end") ?? []).map((handler) =>
          handler({ message: { role: "custom", ...message } }, ctx),
        ),
      );
    },
  };
};

const fixture = async () => {
  const repository = await realpath(await mkdtemp(join(tmpdir(), "to-code-adapter-")));
  cleanups.push(() => rm(repository, { recursive: true, force: true }));
  const coordinator = fakePi({}, repository, "coordinator");
  let worker: ReturnType<typeof fakePi> | undefined;
  let workerAdapter: ReturnType<typeof createAsyncFleetAdapter> | undefined;
  const runner = async (): Promise<never> => {
    throw new Error("Unexpected Herdr completion poll");
  };
  const platform: FleetPlatform = {
    workspaceExists: async () => true,
    scratchIgnored: async () => true,
    facts: async (worktree) => ({
      worktree,
      commonDirectory: "/common",
      head: "c000001",
      base: "b000001",
      branch: worktree === repository ? "main" : "ticket",
      clean: true,
    }),
    checks: async () => ["test: passed"],
    landed: async () => "c000001",
    agents: async () => [],
    createTab: async () => ({ pane: "w1:p2", tab: "w1:t2" }),
    closeOwned: async () => undefined,
    reviewFile: async () => {
      throw new Error("No review file in this fixture");
    },
    start: async (run, record) => {
      worker = fakePi(
        { "fleet-run": run.directory, "fleet-implementor": record.id },
        "/ticket",
        "worker",
      );
      workerAdapter = createAsyncFleetAdapter(worker.pi as never, {
        runner,
        env: { HERDR_PANE_ID: "w1:p2" },
        platform,
        assertHost: undefined,
      });
      cleanups.push(() => workerAdapter!.shutdown());
      await workerAdapter.start(worker.ctx as never);
    },
  };
  const adapter = createAsyncFleetAdapter(coordinator.pi as never, {
    runner,
    env: { HERDR_PANE_ID: "w1:p1" },
    platform,
    assertHost: undefined,
  });
  cleanups.push(() => adapter.shutdown());
  const setup = await adapter.execute(
    "fleet_setup",
    { workspace: "w1", integrationBranch: "main", checks: ["test"] },
    coordinator.ctx as never,
  );
  if (setup?.isError) throw new Error(setup.content[0]?.text);
  expect(setup?.isError).toBe(false);
  const { fleetId, directory } = JSON.parse(setup!.content[0]!.text);
  const tool = coordinator.tools.find((entry) => entry.name === "fleet_start_ticket")!;
  const started = await tool.execute(
    "start",
    {
      fleetId,
      ticketId: "T1",
      worktree: "/ticket",
      goal: "Implement",
      model: "test/model",
      thinking: "high",
    },
    undefined,
    undefined,
    coordinator.ctx,
  );
  expect(started.isError).toBe(false);
  if (worker === undefined || workerAdapter === undefined) throw new Error("Worker not started");
  const run = await fleetStorage(directory).read();
  const record = run.workers[0]!;
  return {
    repository,
    coordinator,
    worker,
    adapter,
    workerAdapter,
    platform,
    runner,
    fleetId: String(fleetId),
    directory: String(directory),
    workerId: record.id,
    assignmentId: currentAssignment(record.snapshot)!.id,
  };
};

test("real callback transport queues a single wake and acknowledges only the persisted Pi message", async () => {
  const f = await fixture();
  expect(f.worker.messages.length).toBe(1);
  expect((await fleetStorage(f.directory).read()).outbox[0]?.status).toBe("pending");
  await notifyCallback(f.directory, f.workerId);
  await notifyCallback(f.directory, f.workerId);
  expect(f.worker.messages.length).toBe(1);
  await f.worker.persist(f.worker.messages[0]!);
  expect((await fleetStorage(f.directory).read()).outbox[0]?.status).toBe("delivered");
  const stop = await f.worker.emit("agent_before_settle", {
    outcome: "completed",
    context: { canContinue: true },
  });
  expect(stop[0]).toEqual({
    continue: true,
    entries: [
      {
        type: "custom_message",
        customType: "to-code-outcome-required",
        content: `Assignment ${f.assignmentId} is still open. Record fleet_report, fleet_question, or fleet_request_review before yielding. A final chat message does not satisfy the stop guard.`,
        display: true,
        details: undefined,
      },
    ],
  });
  const question = f.worker.tools.find((entry) => entry.name === "fleet_question")!;
  expect(
    (
      await question.execute(
        "q",
        { reportId: "q1", assignmentId: f.assignmentId, question: "Which behavior?" },
        undefined,
        undefined,
        f.worker.ctx,
      )
    ).isError,
  ).toBe(false);
  expect(
    (
      await f.worker.emit("agent_before_settle", {
        outcome: "completed",
        context: { canContinue: true },
      })
    )[0],
  ).toBe(undefined);
  expect(f.coordinator.messages.length).toBe(1);
  expect(
    (
      await f.adapter.execute(
        "fleet_send",
        { fleetId: f.fleetId, workerId: f.workerId, text: "Chosen behavior", questionId: "q1" },
        f.coordinator.ctx as never,
      )
    )?.isError,
  ).toBe(false);
  expect(
    (
      await f.worker.emit("agent_before_settle", {
        outcome: "completed",
        context: { canContinue: true },
      })
    )[0],
  ).toHaveProperty("continue", true);
  expect(
    (
      await f.adapter.execute(
        "fleet_wait",
        { fleetId: f.fleetId, panes: ["w1:p2"], timeoutMs: 1000 },
        f.coordinator.ctx as never,
      )
    )?.isError,
  ).toBe(true);
});

test("offline coordinator gets the persisted question after resume, without completion polling", async () => {
  const f = await fixture();
  await f.adapter.shutdown();
  const question = f.worker.tools.find((entry) => entry.name === "fleet_question")!;
  expect(
    (
      await question.execute(
        "q",
        { reportId: "offline-q", assignmentId: f.assignmentId, question: "Recover me?" },
        undefined,
        undefined,
        f.worker.ctx,
      )
    ).isError,
  ).toBe(false);
  expect(f.coordinator.messages).toEqual([]);
  const replacement = fakePi({}, f.repository, "replacement");
  const adapter = createAsyncFleetAdapter(replacement.pi as never, {
    runner: f.runner,
    env: { HERDR_PANE_ID: "w1:p1" },
    platform: f.platform,
    assertHost: undefined,
  });
  cleanups.push(() => adapter.shutdown());
  const resume = replacement.tools.find((entry) => entry.name === "fleet_resume")!;
  expect(
    (
      await resume.execute(
        "resume",
        { directory: f.directory },
        undefined,
        undefined,
        replacement.ctx,
      )
    ).isError,
  ).toBe(false);
  expect(replacement.messages.length).toBe(1);
  expect(replacement.messages[0]?.content).toContain("offline-q");
  await replacement.persist(replacement.messages[0]!);
  expect(
    (await fleetStorage(f.directory).read()).outbox.find((entry) => entry.kind === "question")
      ?.status,
  ).toBe("delivered");
});

test("native extension UI questions route to coordinator without granting native permissions", async () => {
  const f = await fixture();
  await f.worker.emit("ui_prompt_start", {
    kind: "confirm",
    title: "Approve protected operation?",
  });
  const run = await fleetStorage(f.directory).read();
  expect(run.workers[0]?.snapshot.state.path).toBe("AwaitingAnswer");
  expect(run.reports[0]?.kind).toBe("question");
  expect(f.coordinator.messages[0]?.content).toContain("authorized human must resolve");
});

test("worker user questions are blocked and native abort remains lost, never completed", async () => {
  const f = await fixture();
  expect((await f.worker.emit("tool_call", { toolName: "ask_user_question" }))[0]).toEqual({
    block: true,
    reason: "Async worker questions must use fleet_question and route to the coordinator.",
  });
  expect(
    (
      await f.worker.emit("agent_before_settle", {
        outcome: "aborted",
        context: { canContinue: false },
      })
    )[0],
  ).toBe(undefined);
  const run = await fleetStorage(f.directory).read();
  expect(run.workers[0]?.snapshot.state.path).toBe("Lost");
  expect(run.reports).toEqual([]);
  expect(f.coordinator.messages[0]?.content).toContain("NOT a worker completion");
});
