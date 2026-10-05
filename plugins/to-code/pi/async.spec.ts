import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { currentAssignment } from "../fleet/model.ts";
import { reviewTemplate } from "../fleet/reports.ts";
import { createAsyncFleetAdapter } from "./async.ts";
import { notifyCallback } from "./callbacks.ts";
import { digest, type FleetPlatform } from "./platform.ts";
import { reviewFilename } from "./runtime.ts";
import { fleetStorage } from "./storage.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
type Tool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
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
  let reviewer: ReturnType<typeof fakePi> | undefined;
  let reviewerAdapter: ReturnType<typeof createAsyncFleetAdapter> | undefined;
  let tabNumber = 1;
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
    createTab: async () => {
      tabNumber += 1;
      return { pane: `w1:p${tabNumber}`, tab: `w1:t${tabNumber}` };
    },
    closeOwned: async () => undefined,
    reviewFile: async () => {
      throw new Error("No review file in this fixture");
    },
    start: async (run, record) => {
      const isReviewer = record.snapshot.value.role === "reviewer";
      const launched = fakePi(
        {
          "fleet-run": run.directory,
          [isReviewer ? "fleet-reviewer" : "fleet-implementor"]: record.id,
        },
        "/ticket",
        record.id,
      );
      if (isReviewer) {
        reviewer = launched;
        reviewerAdapter = createAsyncFleetAdapter(reviewer.pi as never, {
          runner,
          env: { HERDR_PANE_ID: record.pane! },
          platform,
          assertHost: undefined,
        });
        cleanups.push(() => reviewerAdapter!.shutdown());
        await reviewerAdapter.start(reviewer.ctx as never);
        return;
      }
      worker = launched;
      workerAdapter = createAsyncFleetAdapter(worker.pi as never, {
        runner,
        env: { HERDR_PANE_ID: record.pane! },
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
  expect(worker.tools.map((entry) => entry.name)).toEqual([
    "fleet_question",
    "fleet_report",
    "fleet_request_review",
    "fleet_status",
  ]);
  for (const entry of worker.tools) expect(entry.parameters.type).toBe("object");
  expect(worker.tools.find((entry) => entry.name === "fleet_status")?.parameters).toMatchObject({
    properties: {},
    type: "object",
  });
  return {
    repository,
    coordinator,
    worker,
    getReviewer: () => reviewer,
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

test("callback-only implementor context includes literal identity, role-specific report IDs and timeout units", async () => {
  const f = await fixture();
  const message = f.worker.messages[0]?.content;
  if (message === undefined) throw new Error("Assignment callback missing");
  expect(message).toContain(
    `Worker ${f.workerId} (implementor); assignmentId: \`${f.assignmentId}\``,
  );
  for (const operation of ["question", "completed", "failed", "approval", "request-review"]) {
    expect(message).toContain(`${operation}: \`${f.workerId}-${f.assignmentId}-${operation}\``);
  }
  expect(message).toContain("Bash timeout is in SECONDS");
  expect(message).toContain("small, reachable test fixtures");
  const binding = (await f.worker.emit("before_agent_start", {}))[0];
  expect(binding).toHaveProperty("message.content", message.split("\n\n").slice(1).join("\n\n"));
  expect(f.worker.tools.find((entry) => entry.name === "fleet_report")?.description).toContain(
    "Only identical payload retries reuse an ID",
  );
});

test("managed setup validates finite integer millisecond budgets before allocating runs", async () => {
  const f = await fixture();
  const runs = join(f.repository, ".scratch", "to-code");
  const before = await readdir(runs);
  for (const commandTimeoutMs of [0, -1, 570001, 1.5, NaN, Infinity, -Infinity, "180000"]) {
    const rejected = await f.adapter.execute(
      "fleet_setup",
      {
        workspace: "w1",
        integrationBranch: "main",
        checks: ["test"],
        commandTimeoutMs,
      },
      f.coordinator.ctx as never,
    );
    expect(rejected?.isError).toBe(true);
    expect(await readdir(runs)).toEqual(before);
  }
  for (const commandTimeoutMs of [1, 570000, undefined]) {
    const accepted = await f.adapter.execute(
      "fleet_setup",
      {
        workspace: "w1",
        integrationBranch: "main",
        checks: ["test"],
        ...(commandTimeoutMs === undefined ? {} : { commandTimeoutMs }),
      },
      f.coordinator.ctx as never,
    );
    expect(accepted?.isError).toBe(false);
    const { directory } = JSON.parse(accepted?.content[0]?.text ?? "{}");
    expect((await fleetStorage(directory).read()).commandTimeoutMs).toBe(
      commandTimeoutMs ?? 120000,
    );
  }
});

test("managed watch/wait reject both scoped and unscoped worker targets", async () => {
  const f = await fixture();
  for (const name of ["fleet_watch", "fleet_wait"]) {
    for (const params of [
      { fleetId: f.fleetId, panes: ["w1:p2"], timeoutMs: 1000 },
      { panes: ["w1:p2"], timeoutMs: 1000 },
    ]) {
      expect((await f.adapter.execute(name, params, f.coordinator.ctx as never))?.isError).toBe(
        true,
      );
    }
  }
});

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

test("callback-delivered reviewer assignment includes current canonical review binding without lifecycle hook", async () => {
  const f = await fixture();
  const implementationReport = f.worker.tools.find((entry) => entry.name === "fleet_report")!;
  expect(
    (
      await implementationReport.execute(
        "implementation",
        {
          reportId: "implementation-done",
          assignmentId: f.assignmentId,
          outcome: "completed",
          summary: "Implementation committed and verified.",
        },
        undefined,
        undefined,
        f.worker.ctx,
      )
    ).isError,
  ).toBe(false);
  const startReview = f.coordinator.tools.find((entry) => entry.name === "fleet_start_review")!;
  expect(
    (
      await startReview.execute(
        "review",
        { fleetId: f.fleetId, ticketId: "T1", model: "test/model", thinking: "high" },
        undefined,
        undefined,
        f.coordinator.ctx,
      )
    ).isError,
  ).toBe(false);
  const reviewerPane = f.getReviewer();
  if (reviewerPane === undefined) throw new Error("Reviewer was not started");
  expect(reviewerPane.messages).toHaveLength(1);
  const message = reviewerPane.messages[0]!.content;
  const run = await fleetStorage(f.directory).read();
  const reviewer = run.workers.find((entry) => entry.snapshot.value.role === "reviewer")!;
  const filename = reviewFilename(run, reviewer);
  expect(message).toContain(`Ticket T1:`);
  expect(message).toContain(`assignment: ${currentAssignment(reviewer.snapshot)!.id}`);
  expect(message).toContain(`base: b000001`);
  expect(message).toContain(`head: c000001`);
  expect(message).toContain(
    `Write this file using the absolute path ${join(f.repository, filename)}`,
  );
  expect(message).toContain(`pass the exact relative filename \`${filename}\` to fleet_report`);
  expect(message).toContain("# Review");
  expect(message).toContain(`reviewer: ${reviewer.id}`);
  expect(message).toContain("## Findings");
  expect(message).toContain("fleet_question");
  expect(message).toContain("Review Standards, Spec, and check evidence");
  expect(message).toContain("actual test assertions");
  expect(message).toContain("not semantic review completeness");

  const question = reviewerPane.tools.find((entry) => entry.name === "fleet_question")!;
  const assignmentId = currentAssignment(reviewer.snapshot)!.id;
  expect(message).toContain(`review: \`${reviewer.id}-${assignmentId}-review\``);
  expect(message).toContain(`question: \`${reviewer.id}-${assignmentId}-question\``);
  const report = reviewerPane.tools.find((entry) => entry.name === "fleet_report")!;
  const beforeRejection = await fleetStorage(f.directory).read();
  const rejected = await report.execute(
    "invalid-review",
    {
      reportId: `${reviewer.id}-${assignmentId}-review`,
      assignmentId,
      outcome: "review",
      summary: "Invalid review",
      filename: join(f.repository, filename),
    },
    undefined,
    undefined,
    reviewerPane.ctx,
  );
  expect(rejected.isError).toBe(true);
  expect(rejected.content[0]?.text).toContain(`pass the exact relative filename \`${filename}\``);
  expect(rejected.content[0]?.text).toContain(
    `question: \`${reviewer.id}-${assignmentId}-question\``,
  );
  expect(await fleetStorage(f.directory).read()).toEqual(beforeRejection);
  expect(
    (
      await question.execute(
        "review-question",
        { reportId: "review-question", assignmentId, question: "Which path should I inspect?" },
        undefined,
        undefined,
        reviewerPane.ctx,
      )
    ).isError,
  ).toBe(false);
  expect(
    (
      await f.adapter.execute(
        "fleet_send",
        {
          fleetId: f.fleetId,
          workerId: reviewer.id,
          text: "Inspect the changed parser.",
          questionId: "review-question",
        },
        f.coordinator.ctx as never,
      )
    )?.isError,
  ).toBe(false);
  expect(reviewerPane.messages).toHaveLength(2);
  expect(reviewerPane.messages[1]?.content).toContain("# Review");
  const answeredRun = await fleetStorage(f.directory).read();
  const answeredReviewer = answeredRun.workers.find((entry) => entry.id === reviewer.id)!;
  const answeredAssignment = currentAssignment(answeredReviewer.snapshot)!.id;
  expect(reviewerPane.messages[1]?.content).toContain(`assignment: ${answeredAssignment}`);
  expect(reviewerPane.messages[1]?.content).toContain(
    `review: \`${reviewer.id}-${answeredAssignment}-review\``,
  );
  expect(reviewerPane.messages[1]?.content).toContain(
    `question: \`${reviewer.id}-${answeredAssignment}-question\``,
  );
  expect(
    reviewerPane.messages[1]?.content.includes(`review: \`${reviewer.id}-${assignmentId}-review\``),
  ).toBe(false);
  const refreshedFilename = reviewFilename(answeredRun, answeredReviewer);
  const text = reviewTemplate(
    {
      ticketId: "T1",
      reviewerId: reviewer.id,
      assignmentId: answeredAssignment,
      base: "b000001",
      head: "c000001",
      currentBase: "b000001",
      currentHead: "c000001",
      filename: refreshedFilename,
    },
    "approved",
  );
  f.platform.reviewFile = async (_run, requested) => {
    expect(requested).toBe(refreshedFilename);
    return { text, hash: digest(text) };
  };
  expect(
    (
      await report.execute(
        "valid-review",
        {
          reportId: `${reviewer.id}-${answeredAssignment}-review`,
          assignmentId: answeredAssignment,
          outcome: "review",
          summary: "Reviewed current binding",
          filename: refreshedFilename,
        },
        undefined,
        undefined,
        reviewerPane.ctx,
      )
    ).isError,
  ).toBe(false);
  const approved = await fleetStorage(f.directory).read();
  expect(approved.tickets[0]?.snapshot.state.path).toBe("Approved");
  const forwarding = approved.workers.find((entry) => entry.id === f.workerId);
  if (forwarding === undefined) throw new Error("Implementor missing");
  const forwardingAssignment = currentAssignment(forwarding.snapshot)?.id;
  expect(f.worker.messages.at(-1)?.content).toContain(
    `approval: \`${f.workerId}-${forwardingAssignment}-approval\``,
  );
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
