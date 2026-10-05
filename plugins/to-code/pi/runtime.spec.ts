import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { currentAssignment } from "../fleet/model.ts";
import { reviewTemplate } from "../fleet/reports.ts";
import { digest, type FleetPlatform } from "./platform.ts";
import {
  callbackIsCurrent,
  createFleetRuntime,
  reviewFilename,
  type FleetActor,
} from "./runtime.ts";
import { fleetStorage, type FleetRun, type WorkerRecord } from "./storage.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const rejected = async (operation: Promise<unknown>): Promise<string> => {
  try {
    await operation;
  } catch (error) {
    return String(error);
  }
  throw new Error("Expected rejection");
};
const config = { model: "test/model", thinking: "high" as const };

const fixture = async () => {
  const repository = await mkdtemp(join(tmpdir(), "to-code-runtime-"));
  directories.push(repository);
  const directory = join(repository, ".scratch", "to-code", "async-test");
  await mkdir(join(directory, "reports"), { recursive: true });
  const storage = fleetStorage(directory);
  const seed: FleetRun = {
    version: 1,
    id: "async-test",
    directory,
    repository,
    commonDirectory: "/common",
    workspace: "w1",
    integrationBranch: "main",
    coordinatorPane: "w1:p1",
    coordinatorSession: "coordinator",
    coordinatorPid: process.pid,
    hostname: hostname(),
    checks: ["test"],
    commandTimeoutMs: 1000,
    workers: [],
    tickets: [],
    reports: [],
    outbox: [],
  };
  await storage.initialize(seed);
  const events: string[] = [];
  const files = new Map<string, string>();
  let count = 0;
  let pane = 1;
  let head = "c000001";
  let merged = false;
  let startFails = false;
  let closeFails = false;
  let checksRun = 0;
  const platform: FleetPlatform = {
    workspaceExists: async () => true,
    scratchIgnored: async () => true,
    facts: async (worktree) => ({
      worktree,
      commonDirectory: "/common",
      head,
      base: merged ? head : "b000001",
      branch: worktree === repository ? "main" : "ticket",
      clean: true,
    }),
    checks: async () => {
      checksRun++;
      events.push("checks");
      return ["test: passed"];
    },
    landed: async () => {
      if (!merged) throw new Error("Head is not in integration branch");
      return head;
    },
    createTab: async () => {
      pane++;
      events.push("tab");
      return { pane: `w1:p${pane}`, tab: `w1:t${pane}` };
    },
    start: async (_run, worker) => {
      events.push("start");
      if (startFails) throw new Error("Startup timeout, possibly applied");
      await storage.change(async (run) => ({
        run: {
          ...run,
          workers: run.workers.map((entry) =>
            entry.id === worker.id ? { ...entry, pid: process.pid, callbackReady: true } : entry,
          ),
        },
        value: undefined,
      }));
    },
    agents: async () => [],
    closeOwned: async (run, worker) => {
      expect(run.tickets[0]?.snapshot.state.path).toBe("Landed");
      events.push(`close:${worker.id}`);
      if (closeFails) throw new Error("Cleanup unavailable");
    },
    reviewFile: async (_run, filename) => {
      const text = files.get(filename);
      if (text === undefined) throw new Error("Report is missing");
      return { text, hash: digest(text) };
    },
  };
  const make = (actor: FleetActor) =>
    createFleetRuntime({
      storage,
      platform,
      actor,
      newId: () => `${(++count).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
      notify: async (_directory, target) => {
        const persisted = await storage.read();
        expect(persisted.outbox.some((entry) => entry.target === target)).toBe(true);
        events.push(`notify:${target}`);
        return false;
      },
    });
  const coordinator = make({ kind: "coordinator", pane: "w1:p1", session: "coordinator" });
  const worker = async (workerId: string) => {
    const record = (await storage.read()).workers.find((entry) => entry.id === workerId);
    if (record === undefined || record.pane === null) throw new Error("Worker not allocated");
    return make({ kind: "worker", workerId, pane: record.pane, role: record.snapshot.value.role });
  };
  const assignmentId = async (workerId: string): Promise<string> => {
    const record = (await storage.read()).workers.find((entry) => entry.id === workerId);
    if (record === undefined) throw new Error("Worker missing");
    return currentAssignment(record.snapshot)!.id;
  };
  const implementation = async (): Promise<string> => {
    const workerId = await coordinator.startTicket({
      ticketId: "T1",
      worktree: "/ticket",
      goal: "Implement behavior",
      config,
    });
    await (
      await worker(workerId)
    ).report({
      reportId: "implementation-1",
      assignmentId: await assignmentId(workerId),
      outcome: "completed",
      summary: "Implemented and committed",
      filename: null,
    });
    return workerId;
  };
  const review = async (): Promise<string> => {
    await implementation();
    return coordinator.startReview("T1", config);
  };
  const writeReview = async (
    reviewerId: string,
    verdict: "approved" | "changes_requested",
  ): Promise<string> => {
    const run = await storage.read();
    const record = run.workers.find((entry) => entry.id === reviewerId)!;
    const ticket = run.tickets[0]!;
    if (ticket.snapshot.state.path !== "Reviewing") throw new Error("No review");
    const state = ticket.snapshot.state.value;
    const filename = reviewFilename(run, record);
    files.set(
      filename,
      reviewTemplate(
        {
          ticketId: "T1",
          reviewerId,
          assignmentId: await assignmentId(reviewerId),
          base: state.base,
          head: state.head,
          currentBase: state.base,
          currentHead: state.head,
          filename,
        },
        verdict,
      ),
    );
    return filename;
  };
  const approval = async (): Promise<{ implementor: WorkerRecord; reviewerId: string }> => {
    const reviewerId = await review();
    const filename = await writeReview(reviewerId, "approved");
    await (
      await worker(reviewerId)
    ).report({
      reportId: "review-1",
      assignmentId: await assignmentId(reviewerId),
      outcome: "review",
      summary: "Approved",
      filename,
    });
    const implementor = (await storage.read()).workers.find(
      (entry) => entry.snapshot.value.role === "implementor",
    )!;
    await (
      await worker(implementor.id)
    ).report({
      reportId: "approval-1",
      assignmentId: await assignmentId(implementor.id),
      outcome: "approval",
      summary: "Forwarding validated approval",
      filename: null,
    });
    return { implementor, reviewerId };
  };
  return {
    storage,
    platform,
    coordinator,
    worker,
    assignmentId,
    implementation,
    review,
    writeReview,
    approval,
    files,
    events,
    repository,
    directory,
    setHead: (value: string) => {
      head = value;
    },
    merge: () => {
      merged = true;
    },
    failStart: () => {
      startFails = true;
    },
    failClose: (value: boolean) => {
      closeFails = value;
    },
    checks: () => checksRun,
  };
};

describe("durable real-runtime interface", () => {
  test("explicit existing worktree dispatch records resources before launch and rejects duplicate starts", async () => {
    const f = await fixture();
    const id = await f.coordinator.startTicket({
      ticketId: "T1",
      worktree: "/ticket",
      goal: "Implement",
      config,
    });
    const run = await f.storage.read();
    expect(run.workers[0]?.id).toBe(id);
    expect(run.workers[0]?.pane).toBe("w1:p2");
    expect(run.workers[0]?.launch).toBe("started");
    expect(run.outbox[0]?.status).toBe("pending");
    expect(f.events.slice(0, 2)).toEqual(["tab", "start"]);
    expect(
      await rejected(
        f.coordinator.startTicket({ ticketId: "T1", worktree: "/ticket", goal: "Again", config }),
      ),
    ).toContain("already assigned");
    expect(f.events.filter((event) => event === "tab").length).toBe(1);
  });

  test("offline callback outcomes survive reload and report IDs deduplicate without rerunning checks", async () => {
    const f = await fixture();
    const id = await f.implementation();
    const run = await f.storage.read();
    const report = run.reports[0]!;
    expect(run.tickets[0]?.snapshot.state.path).toBe("ReviewReady");
    expect(run.workers[0]?.snapshot.state.path).toBe("Reported");
    const calls = f.checks();
    await (
      await f.worker(id)
    ).report({
      reportId: report.id,
      assignmentId: report.assignmentId,
      outcome: "completed",
      summary: "Implemented and committed",
      filename: null,
    });
    expect(f.checks()).toBe(calls);
    expect((await fleetStorage(f.directory).read()).reports.length).toBe(1);
    expect(await (await f.worker(id)).stop()).toBe(undefined);
    const callback = run.outbox.find((entry) => entry.kind === "implementation")!;
    expect(callbackIsCurrent(run, callback)).toBe(true);
    await f.coordinator.acknowledge(callback.id);
    expect((await f.storage.read()).outbox.find((entry) => entry.id === callback.id)?.status).toBe(
      "delivered",
    );
    expect(
      await rejected(
        (await f.worker(id)).report({
          reportId: report.id,
          assignmentId: report.assignmentId,
          outcome: "completed",
          summary: "Different content",
          filename: null,
        }),
      ),
    ).toContain("reused");
  });

  test("question waiting and stale replies are correlated; repeated stops remain armed after answer", async () => {
    const f = await fixture();
    const id = await f.coordinator.startTicket({
      ticketId: "T1",
      worktree: "/ticket",
      goal: "Implement",
      config,
    });
    const w = await f.worker(id);
    const assignment = await f.assignmentId(id);
    expect(await w.stop()).toContain("still open");
    expect(await w.stop()).toContain("still open");
    await w.question("q1", assignment, "Choose behavior?");
    expect(await w.stop()).toBe(undefined);
    expect(await rejected(f.coordinator.send(id, "answer", "other-question"))).toContain(
      "current question",
    );
    await f.coordinator.send(id, "Chosen behavior", "q1");
    expect(await w.stop()).toContain("still open");
    expect(
      await rejected(
        w.report({
          reportId: "stale-report",
          assignmentId: assignment,
          outcome: "completed",
          summary: "Old",
          filename: null,
        }),
      ),
    ).toContain("stale assignment");
    expect((await f.storage.read()).workers[0]?.snapshot.value.reprompts).toBe(3);
  });

  test("reviewer question answer updates both worker and ticket bindings", async () => {
    const f = await fixture();
    const reviewer = await f.review();
    const w = await f.worker(reviewer);
    const old = await f.assignmentId(reviewer);
    await w.question("review-question", old, "Which spec revision?");
    await f.coordinator.send(reviewer, "Current revision", "review-question");
    const filename = await f.writeReview(reviewer, "approved");
    await w.report({
      reportId: "review-after-answer",
      assignmentId: await f.assignmentId(reviewer),
      outcome: "review",
      summary: "Approved",
      filename,
    });
    const run = await f.storage.read();
    expect(run.tickets[0]?.snapshot.state.path).toBe("Approved");
    expect(run.reports.find((report) => report.id === "review-after-answer")?.assignmentId).toBe(
      await f.assignmentId(reviewer),
    );
    expect(run.outbox.filter((entry) => entry.kind === "approval").length).toBe(0);
  });

  test("invalid/missing/stale reviewer artifacts do not release the stop gate", async () => {
    const f = await fixture();
    const reviewer = await f.review();
    const w = await f.worker(reviewer);
    const assignmentId = await f.assignmentId(reviewer);
    expect(
      await rejected(
        w.report({
          reportId: "bad-role",
          assignmentId,
          outcome: "failed",
          summary: "Can't review",
          filename: null,
        }),
      ),
    ).toContain("Reviewer must");
    expect(
      await rejected(
        w.report({
          reportId: "missing",
          assignmentId,
          outcome: "review",
          summary: "Review",
          filename: ".scratch/missing.md",
        }),
      ),
    ).toContain("missing");
    const filename = await f.writeReview(reviewer, "approved");
    f.files.set(filename, "# Review\n");
    expect(
      await rejected(
        w.report({
          reportId: "invalid",
          assignmentId,
          outcome: "review",
          summary: "Review",
          filename,
        }),
      ),
    ).toContain("ticket field");
    await f.writeReview(reviewer, "approved");
    f.setHead("c000002");
    expect(
      await rejected(
        w.report({
          reportId: "stale",
          assignmentId,
          outcome: "review",
          summary: "Review",
          filename,
        }),
      ),
    ).toContain("stale");
    expect(await w.stop()).toContain("still open");
    expect((await f.storage.read()).reports.length).toBe(1);
  });

  test("findings go directly to implementor; fixes rearm the retained reviewer", async () => {
    const f = await fixture();
    const reviewer = await f.review();
    const filename = await f.writeReview(reviewer, "changes_requested");
    await (
      await f.worker(reviewer)
    ).report({
      reportId: "findings-1",
      assignmentId: await f.assignmentId(reviewer),
      outcome: "review",
      summary: "Needs fixes",
      filename,
    });
    let run = await f.storage.read();
    const implementor = run.workers.find((entry) => entry.snapshot.value.role === "implementor")!;
    expect(run.tickets[0]?.snapshot.state.path).toBe("Fixing");
    expect(run.outbox.at(-1)?.target).toBe(implementor.id);
    expect(run.outbox.at(-1)?.text.includes(filename)).toBe(true);
    expect(await (await f.worker(implementor.id)).stop()).toContain("still open");
    f.setHead("c000002");
    await (
      await f.worker(implementor.id)
    ).requestReview("fixes-1", await f.assignmentId(implementor.id), "Fixed and checked");
    run = await f.storage.read();
    expect(run.tickets[0]?.snapshot.state.path).toBe("Reviewing");
    expect(run.workers.length).toBe(2);
    expect(run.workers.find((entry) => entry.id === reviewer)?.snapshot.state.path).toBe("Active");
    expect(run.outbox.at(-1)?.target).toBe(reviewer);
    expect(f.events.filter((event) => event === "tab").length).toBe(2);
  });

  test("approval must pass through implementor, then landing verifies fresh checks and ancestry before cleanup", async () => {
    const f = await fixture();
    const { implementor } = await f.approval();
    expect((await f.storage.read()).tickets[0]?.snapshot.state.path).toBe("ReadyToLand");
    expect(await rejected(f.coordinator.finishTicket("T1"))).toContain("not in integration");
    expect(f.events.filter((event) => event.startsWith("close:")).length).toBe(0);
    // Landing moves merge-base to the approved head. That is not a stale source-head change.
    f.merge();
    await f.coordinator.finishTicket("T1");
    const run = await f.storage.read();
    expect(run.tickets[0]?.snapshot.state.path).toBe("Landed");
    expect(run.workers.map((worker) => worker.snapshot.state.path)).toEqual(["Retired", "Retired"]);
    expect(run.reports.length).toBe(3);
    expect(await rejected(f.coordinator.send(implementor.id, "More work", null))).toContain(
      "Landed tickets",
    );
  });

  test("changed approval/head prevents landing; cleanup failure is independently retryable", async () => {
    const f = await fixture();
    await f.approval();
    f.setHead("c000002");
    f.merge();
    expect(await rejected(f.coordinator.finishTicket("T1"))).toContain("stale");
    f.setHead("c000001");
    f.failClose(true);
    expect(await rejected(f.coordinator.finishTicket("T1"))).toContain("Cleanup unavailable");
    expect((await f.storage.read()).tickets[0]?.snapshot.state.path).toBe("Landed");
    f.failClose(false);
    await f.coordinator.finishTicket("T1");
    expect((await f.storage.read()).workers.map((entry) => entry.snapshot.state.path)).toEqual([
      "Retired",
      "Retired",
    ]);
  });

  test("uncertain startup retains durable ownership and refuses duplicate allocation", async () => {
    const f = await fixture();
    f.failStart();
    expect(
      await rejected(
        f.coordinator.startTicket({
          ticketId: "T1",
          worktree: "/ticket",
          goal: "Implement",
          config,
        }),
      ),
    ).toContain("uncertain");
    const run = await f.storage.read();
    expect(run.workers[0]?.launch).toBe("uncertain");
    expect(run.workers[0]?.pane).toBe("w1:p2");
    expect(run.workers[0]?.snapshot.state.path).toBe("Active");
    expect(run.reports).toEqual([]);
    expect(callbackIsCurrent(run, run.outbox[0]!)).toBe(false);
  });

  test("changed findings cannot become unvalidated fix/re-review evidence", async () => {
    const f = await fixture();
    const reviewer = await f.review();
    const filename = await f.writeReview(reviewer, "changes_requested");
    await (
      await f.worker(reviewer)
    ).report({
      reportId: "findings",
      assignmentId: await f.assignmentId(reviewer),
      outcome: "review",
      summary: "Fix required",
      filename,
    });
    f.files.set(filename, `${f.files.get(filename)}\nUnvalidated alteration`);
    const implementor = (await f.storage.read()).tickets[0]!.implementor;
    expect(
      await rejected(
        (await f.worker(implementor)).requestReview(
          "rereview",
          await f.assignmentId(implementor),
          "Fixed",
        ),
      ),
    ).toContain("artifact changed");
    expect((await f.storage.read()).tickets[0]?.snapshot.state.path).toBe("Fixing");
  });

  test("coordinator refresh accounts for stale reviews and reuses the retained reviewer", async () => {
    const f = await fixture();
    const reviewer = await f.review();
    const implementor = (await f.storage.read()).workers.find(
      (entry) => entry.snapshot.value.role === "implementor",
    )!;
    f.setHead("c000002");
    await f.coordinator.send(implementor.id, "Reverify changed code", null);
    let run = await f.storage.read();
    expect(run.tickets[0]?.snapshot.state.path).toBe("Implementing");
    expect(run.workers.find((entry) => entry.id === reviewer)?.snapshot.state.path).toBe(
      "Reported",
    );
    expect(run.reports.at(-1)?.kind).toBe("superseded");
    await (
      await f.worker(implementor.id)
    ).report({
      reportId: "refreshed",
      assignmentId: await f.assignmentId(implementor.id),
      outcome: "completed",
      summary: "Reverified",
      filename: null,
    });
    expect(await f.coordinator.startReview("T1", config)).toBe(reviewer);
    run = await f.storage.read();
    expect(run.tickets[0]?.snapshot.state.path).toBe("Reviewing");
    expect(run.workers.length).toBe(2);
    expect(f.events.filter((event) => event === "tab").length).toBe(2);
  });

  test("runtime interruption is a durable lost assignment, not a reviewer semantic failure", async () => {
    const f = await fixture();
    const reviewer = await f.review();
    await (await f.worker(reviewer)).interrupted("Provider terminated");
    const run = await f.storage.read();
    expect(run.workers.find((entry) => entry.id === reviewer)?.snapshot.state.path).toBe("Lost");
    expect(run.tickets[0]?.snapshot.state.path).toBe("Blocked");
    expect(run.reports.map((entry) => entry.kind)).toEqual(["implementation"]);
    expect(run.outbox.at(-1)?.text).toContain("NOT a worker completion");
  });
});

describe("cross-process snapshot storage", () => {
  test("concurrent transactions serialize and a proven dead writer lock is archived", async () => {
    const f = await fixture();
    await Promise.all(
      Array.from({ length: 8 }, () =>
        f.storage.change(async (run) => ({
          run: { ...run, commandTimeoutMs: run.commandTimeoutMs + 1 },
          value: undefined,
        })),
      ),
    );
    expect((await f.storage.read()).commandTimeoutMs).toBe(1008);
    const lock = join(f.directory, ".write-lock");
    await mkdir(lock);
    const token = "deadbeef-0000-4000-8000-000000000000";
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({ pid: 2147483647, token, hostname: hostname(), createdAt: "test" }),
    );
    await f.storage.change(async (run) => ({
      run: { ...run, commandTimeoutMs: 2000 },
      value: undefined,
    }));
    expect((await f.storage.read()).commandTimeoutMs).toBe(2000);
    expect(
      JSON.parse(
        await readFile(join(f.directory, `.abandoned-lock-${token}`, "owner.json"), "utf8"),
      ).token,
    ).toBe(token);
  });

  test("live/ambiguous locks time out instead of being stolen", async () => {
    const f = await fixture();
    const lock = join(f.directory, ".write-lock");
    await mkdir(lock);
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        token: "deadbeef-0000-4000-8000-000000000000",
        hostname: hostname(),
        createdAt: "test",
      }),
    );
    expect(
      await rejected(
        fleetStorage(f.directory, 40).change(async (run) => ({ run, value: undefined })),
      ),
    ).toContain("timed out");
    expect(JSON.parse(await readFile(join(lock, "owner.json"), "utf8")).pid).toBe(process.pid);
  });
});
