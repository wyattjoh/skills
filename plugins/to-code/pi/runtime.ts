import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { relative } from "node:path";

import { Effect } from "effect";

import {
  advanceTicket,
  advanceWorker,
  createTicket,
  createWorker,
  currentAssignment,
  needsOutcome,
  TicketEvents,
  WorkerEvents,
  type TicketEvent,
  type WorkerEvent,
} from "../fleet/model.ts";
import { reviewTemplate, validateReview } from "../fleet/reports.ts";
import { digest, processIsAlive, type FleetPlatform, type GitFacts } from "./platform.ts";
import type {
  Callback,
  FleetRun,
  FleetStorage,
  ReportRecord,
  TicketRecord,
  WorkerRecord,
} from "./storage.ts";

/**
 * The adapter binds an actor from launch flags/session context, never from tool parameters.
 */
export type FleetActor =
  | { kind: "coordinator"; pane: string; session: string }
  | { kind: "worker"; pane: string; workerId: string; role: "implementor" | "reviewer" };
/**
 * Worker launch configuration is explicit and retained for subsequent review rounds.
 */
export type WorkerConfig = Pick<WorkerRecord, "model" | "thinking">;

const workerOf = (run: FleetRun, id: string): WorkerRecord => {
  const worker = run.workers.find((entry) => entry.id === id);
  if (worker === undefined) throw new Error(`Unknown worker ${id}`);
  return worker;
};
const ticketOf = (run: FleetRun, id: string): TicketRecord => {
  const ticket = run.tickets.find((entry) => entry.id === id);
  if (ticket === undefined) throw new Error(`Unknown ticket ${id}`);
  return ticket;
};
const replaceWorker = (run: FleetRun, worker: WorkerRecord): FleetRun => ({
  ...run,
  workers: run.workers.map((entry) => (entry.id === worker.id ? worker : entry)),
});
const replaceTicket = (run: FleetRun, ticket: TicketRecord): FleetRun => ({
  ...run,
  tickets: run.tickets.map((entry) => (entry.id === ticket.id ? ticket : entry)),
});
const stepWorker = async (run: FleetRun, id: string, event: WorkerEvent): Promise<FleetRun> => {
  const worker = workerOf(run, id);
  return replaceWorker(run, {
    ...worker,
    snapshot: await Effect.runPromise(advanceWorker(worker.snapshot, event)),
  });
};
const stepTicket = async (run: FleetRun, id: string, event: TicketEvent): Promise<FleetRun> => {
  const ticket = ticketOf(run, id);
  return replaceTicket(run, {
    ...ticket,
    snapshot: await Effect.runPromise(advanceTicket(ticket.snapshot, event)),
  });
};

/**
 * Each review round owns a distinct scratch filename, including after a question is answered.
 */
export const reviewFilename = (run: FleetRun, worker: WorkerRecord): string => {
  const assignment = currentAssignment(worker.snapshot);
  if (assignment === undefined) throw new Error("Retired reviewer has no report assignment");
  return `${relative(run.repository, run.directory).split("\\").join("/")}/reports/${worker.id}-${assignment.id}.md`;
};

const reviewBinding = (run: FleetRun, worker: WorkerRecord, facts: GitFacts) => {
  const ticket = ticketOf(run, worker.ticketId);
  if (ticket.snapshot.state.path !== "Reviewing")
    throw new Error("Ticket has no live review assignment");
  const state = ticket.snapshot.state.value;
  const assignment = currentAssignment(worker.snapshot);
  if (assignment?.id !== state.reviewerAssignment)
    throw new Error("Reviewer assignment does not match the ticket");
  return {
    ticketId: ticket.id,
    reviewerId: worker.id,
    assignmentId: assignment.id,
    base: state.base,
    head: state.head,
    currentBase: facts.base,
    currentHead: facts.head,
    filename: reviewFilename(run, worker),
  };
};

/**
 * Callback applicability derives from production snapshots, not Herdr idle/done state.
 */
export const callbackIsCurrent = (run: FleetRun, callback: typeof Callback.Type): boolean => {
  const worker = run.workers.find((entry) => entry.id === callback.workerId);
  if (worker === undefined) return false;
  if (callback.kind === "assignment")
    return (
      worker.launch === "started" &&
      worker.snapshot.state.path === "Active" &&
      currentAssignment(worker.snapshot)?.id === callback.assignmentId
    );
  if (callback.kind === "superseded")
    return (
      worker.snapshot.state.path === "Reported" &&
      worker.snapshot.state.value.outcome === "superseded" &&
      currentAssignment(worker.snapshot)?.id === callback.assignmentId
    );
  if (callback.kind === "question")
    return (
      worker.snapshot.state.path === "AwaitingAnswer" &&
      worker.snapshot.state.value.reportId === callback.reportId
    );
  const ticket = run.tickets.find((entry) => entry.id === callback.ticketId);
  if (ticket === undefined) return false;
  if (callback.kind === "approval") return ticket.snapshot.state.path === "ReadyToLand";
  if (callback.kind === "implementation") return ticket.snapshot.state.path === "ReviewReady";
  return ticket.snapshot.state.path === "Blocked";
};

const saveReport = (
  run: FleetRun,
  worker: WorkerRecord,
  report: Omit<typeof ReportRecord.Type, "workerId" | "assignmentId">,
): FleetRun => {
  const assignment = currentAssignment(worker.snapshot);
  if (assignment === undefined) throw new Error("Report has no assignment");
  return {
    ...run,
    reports: [...run.reports, { ...report, workerId: worker.id, assignmentId: assignment.id }],
  };
};

/**
 * A transaction owns the outcome, follow-up assignment, and outbox atomically. Platform
 * verification precedes that transaction, then assignment/Git evidence is checked again.
 */
export const createFleetRuntime = (options: {
  storage: FleetStorage;
  platform: FleetPlatform;
  actor: FleetActor;
  notify: (directory: string, target: string) => Promise<boolean>;
  newId: (() => string) | undefined;
}) => {
  const { storage, platform, actor } = options;
  const id = options.newId ?? randomUUID;
  const coordinator = (run: FleetRun): void => {
    if (
      actor.kind !== "coordinator" ||
      actor.pane !== run.coordinatorPane ||
      actor.session !== run.coordinatorSession ||
      run.coordinatorPid !== process.pid ||
      run.hostname !== hostname()
    )
      throw new Error("This session does not own the fleet coordinator");
  };
  const self = (run: FleetRun): WorkerRecord => {
    if (actor.kind !== "worker")
      throw new Error("This tool is restricted to launch-bound async workers");
    const worker = workerOf(run, actor.workerId);
    if (
      worker.pane !== actor.pane ||
      worker.snapshot.value.role !== actor.role ||
      worker.snapshot.value.workerId !== actor.workerId ||
      (worker.pid !== null && worker.pid !== process.pid)
    )
      throw new Error("Worker launch identity/pane does not match the durable fleet");
    return worker;
  };
  const activeSelf = (run: FleetRun): WorkerRecord => {
    const worker = self(run);
    if (worker.snapshot.state.path !== "Active")
      throw new Error(
        `No active assignment (${worker.snapshot.state.path}); outcomes cannot be overwritten`,
      );
    return worker;
  };
  const factsFor = async (run: FleetRun, ticket: TicketRecord): Promise<GitFacts> => {
    const facts = await platform.facts(ticket.snapshot.value.worktree, run.integrationBranch);
    if (facts.commonDirectory !== run.commonDirectory || !facts.clean)
      throw new Error("Ticket worktree must be clean and belong to the configured repository");
    return facts;
  };
  const emit = (
    run: FleetRun,
    callback: Omit<typeof Callback.Type, "id" | "status">,
  ): FleetRun => ({
    ...run,
    outbox: [...run.outbox, { ...callback, id: `callback-${id()}`, status: "pending" }],
  });
  const assignmentCallback = (run: FleetRun, worker: WorkerRecord): FleetRun => {
    const assignment = currentAssignment(worker.snapshot);
    if (assignment === undefined) throw new Error("Cannot dispatch a retired worker");
    const ticket = ticketOf(run, worker.ticketId);
    const ending =
      worker.snapshot.value.role === "reviewer"
        ? `Write the assigned Markdown file ${run.repository}/${reviewFilename(run, worker)}, then call fleet_report with outcome review and that relative filename. Ask fleet_question if blocked. Never return bare approval or failure.`
        : `Use fleet_report for completed/failed outcomes or forwarding approval. Use fleet_request_review after fixes. Ask fleet_question if blocked. Do not yield without a recorded outcome.`;
    return emit(run, {
      target: worker.id,
      kind: "assignment",
      ticketId: ticket.id,
      workerId: worker.id,
      assignmentId: assignment.id,
      reportId: null,
      text: `[async fleet ${run.id}] Assignment ${assignment.id}\nTicket ${ticket.id}: ${ticket.snapshot.value.goal}\n${assignment.goal}\n${ending}\nAll questions go to the coordinator; never prompt the user or other workers directly.`,
    });
  };
  const notify = async (): Promise<void> => {
    const run = await storage.read();
    await Promise.all(
      [
        ...new Set(
          run.outbox.filter((entry) => entry.status === "pending").map((entry) => entry.target),
        ),
      ].map((target) => options.notify(run.directory, target)),
    );
  };
  const checkReplay = (run: FleetRun, reportId: string, hash: string): boolean => {
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(reportId))
      throw new Error("Report ID must be a bounded plain token");
    const worker = self(run);
    const previous = run.reports.find(
      (report) => report.id === reportId && report.workerId === worker.id,
    );
    if (previous === undefined) return false;
    if (previous.workerId !== worker.id || previous.requestHash !== hash)
      throw new Error("Report ID reused with different content or identity");
    return true;
  };
  const unchangedReview = async (run: FleetRun, filename: string): Promise<void> => {
    const accepted = run.reports.find(
      (report) => report.kind === "review" && report.filename === filename,
    );
    if (
      accepted === undefined ||
      accepted.fileHash === null ||
      (await platform.reviewFile(run, filename)).hash !== accepted.fileHash
    )
      throw new Error("Validated review artifact changed or is missing");
  };
  const integrationFacts = async (run: FleetRun, head: string): Promise<void> => {
    const facts = await platform.facts(run.repository, run.integrationBranch);
    if (
      !facts.clean ||
      facts.branch !== run.integrationBranch ||
      facts.commonDirectory !== run.commonDirectory ||
      facts.head !== head
    )
      throw new Error(
        "Integration worktree/branch must be clean and remain at the verified landed head",
      );
  };
  const newWorker = async (
    ticketId: string,
    role: "implementor" | "reviewer",
    goal: string,
    head: string | null,
    config: WorkerConfig,
  ): Promise<WorkerRecord> => {
    const workerId = `${role === "implementor" ? "i" : "r"}${id().replaceAll("-", "").slice(0, 20)}`;
    return {
      id: workerId,
      ticketId,
      name: `fleet_${workerId}`,
      pane: null,
      tab: null,
      pid: null,
      callbackReady: false,
      ...config,
      launch: "prepared",
      launchError: null,
      snapshot: await Effect.runPromise(
        createWorker({ workerId, role, assignment: { id: `a-${id()}`, goal, head } }),
      ),
    };
  };
  const launch = async (workerId: string, allocate: boolean): Promise<void> => {
    let run = await storage.read();
    coordinator(run);
    const worker = workerOf(run, workerId);
    try {
      if (allocate) {
        const ticket = ticketOf(run, worker.ticketId);
        const resource = await platform.createTab(
          run.workspace,
          ticket.snapshot.value.worktree,
          worker.name,
        );
        await storage.change(async (current) => {
          coordinator(current);
          const allocated = { ...workerOf(current, workerId), ...resource };
          return {
            run: assignmentCallback(replaceWorker(current, allocated), allocated),
            value: undefined,
          };
        });
      }
      run = await storage.read();
      coordinator(run);
      await platform.start(run, workerOf(run, workerId));
      await storage.change(async (current) => {
        coordinator(current);
        const registered = workerOf(current, workerId);
        if (registered.pid === null || !registered.callbackReady || !processIsAlive(registered.pid))
          throw new Error(
            "Flag-bound Pi extension did not register a live worker; inspect startup/version before retrying",
          );
        return {
          run: replaceWorker(current, { ...registered, launch: "started", launchError: null }),
          value: undefined,
        };
      });
      await notify();
    } catch (error) {
      await storage.change(async (current) => {
        coordinator(current);
        return {
          run: replaceWorker(current, {
            ...workerOf(current, workerId),
            launch: "uncertain",
            launchError: String(error),
          }),
          value: undefined,
        };
      });
      throw new Error(
        `Worker launch is uncertain, not completed. Inspect ${worker.name} before restart: ${String(error)}`,
        { cause: error },
      );
    }
  };
  const freshAssignment = async (
    run: FleetRun,
    worker: WorkerRecord,
    goal: string,
    head: string | null,
    answerTo: string | null,
  ): Promise<FleetRun> => {
    const next = await stepWorker(
      run,
      worker.id,
      WorkerEvents.Assign({ assignment: { id: `a-${id()}`, goal, head }, answerTo }),
    );
    return assignmentCallback(next, workerOf(next, worker.id));
  };

  const supersede = async (
    run: FleetRun,
    worker: WorkerRecord,
    reason: string,
  ): Promise<FleetRun> => {
    if (worker.snapshot.state.path !== "Active" && worker.snapshot.state.path !== "AwaitingAnswer")
      return run;
    const assignment = currentAssignment(worker.snapshot)!;
    const reportId = `superseded-${id()}`;
    let next = await stepWorker(
      run,
      worker.id,
      WorkerEvents.Superseded({ assignmentId: assignment.id, reportId }),
    );
    next = saveReport(next, worker, {
      id: reportId,
      kind: "superseded",
      requestHash: digest(reason),
      filename: null,
      fileHash: null,
      summary: reason,
    });
    return emit(next, {
      target: worker.id,
      kind: "superseded",
      ticketId: worker.ticketId,
      workerId: worker.id,
      assignmentId: assignment.id,
      reportId,
      text: `Assignment ${assignment.id} was explicitly superseded by the coordinator: ${reason}. This is not approval or completion. Retain the worker and await a fresh assignment.`,
    });
  };

  return {
    read: storage.read,
    notify,
    transportReady: async (ready: boolean): Promise<void> =>
      storage.change(async (run) => {
        const worker = self(run);
        return { run: replaceWorker(run, { ...worker, callbackReady: ready }), value: undefined };
      }),
    startTicket: async (input: {
      ticketId: string;
      worktree: string;
      goal: string;
      config: WorkerConfig;
    }): Promise<string> => {
      const initial = await storage.read();
      coordinator(initial);
      if (!/^[A-Za-z0-9._:-]{1,160}$/.test(input.ticketId))
        throw new Error(
          "Ticket ID must be a plain 1..160 character token for its bound review metadata",
        );
      const facts = await platform.facts(input.worktree, initial.integrationBranch);
      if (
        !facts.clean ||
        facts.commonDirectory !== initial.commonDirectory ||
        facts.worktree === initial.repository ||
        facts.branch === initial.integrationBranch
      )
        throw new Error(
          "Supply a clean, separate, already-created ticket worktree in this repository",
        );
      const worker = await newWorker(input.ticketId, "implementor", input.goal, null, input.config);
      await storage.change(async (run) => {
        coordinator(run);
        if (
          run.tickets.some(
            (ticket) =>
              ticket.id === input.ticketId ||
              (ticket.snapshot.state.path !== "Landed" &&
                ticket.snapshot.value.worktree === facts.worktree),
          )
        )
          throw new Error(
            "Ticket or active worktree already assigned; never blindly repeat launch",
          );
        const snapshot = await Effect.runPromise(
          createTicket({
            ticketId: input.ticketId,
            worktree: facts.worktree,
            goal: input.goal,
            integrationBranch: run.integrationBranch,
          }),
        );
        return {
          run: {
            ...run,
            tickets: [
              ...run.tickets,
              { id: input.ticketId, implementor: worker.id, reviewer: null, snapshot },
            ],
            workers: [...run.workers, worker],
          },
          value: undefined,
        };
      });
      await launch(worker.id, true);
      return worker.id;
    },
    startReview: async (ticketId: string, config: WorkerConfig): Promise<string> => {
      const initial = await storage.read();
      coordinator(initial);
      const original = ticketOf(initial, ticketId);
      if (original.snapshot.state.path !== "ReviewReady")
        throw new Error(
          "Initial review requires a recorded implementation outcome; fixes use fleet_request_review",
        );
      const facts = await factsFor(initial, original);
      if (
        facts.head !== original.snapshot.state.value.head ||
        facts.base !== original.snapshot.state.value.base
      )
        throw new Error("Implementation evidence is stale; reassign implementation before review");
      let workerId = "";
      let allocate = false;
      await storage.change(async (run) => {
        coordinator(run);
        const ticket = ticketOf(run, ticketId);
        if (
          ticket.snapshot.state.path !== "ReviewReady" ||
          ticket.snapshot.state.value.head !== facts.head
        )
          throw new Error("Ticket changed before review dispatch");
        let next = run;
        if (ticket.reviewer === null) {
          const worker = await newWorker(
            ticketId,
            "reviewer",
            "Review the implementation against the ticket and repository standards.",
            facts.head,
            config,
          );
          next = { ...run, workers: [...run.workers, worker] };
          next = replaceTicket(next, { ...ticket, reviewer: worker.id });
          workerId = worker.id;
          allocate = true;
        } else {
          workerId = ticket.reviewer;
          const retained = workerOf(next, workerId);
          if (retained.model !== config.model || retained.thinking !== config.thinking)
            throw new Error(
              "Retained reviewer configuration is fixed; use its recorded model/thinking",
            );
          next = await freshAssignment(
            next,
            workerOf(next, workerId),
            "Review the refreshed implementation against the ticket and repository standards.",
            facts.head,
            null,
          );
        }
        const assignment = currentAssignment(workerOf(next, workerId).snapshot);
        if (assignment === undefined) throw new Error("Review assignment missing");
        return {
          run: await stepTicket(
            next,
            ticketId,
            TicketEvents.StartReview({ reviewerAssignment: assignment.id }),
          ),
          value: undefined,
        };
      });
      if (allocate) await launch(workerId, true);
      else await notify();
      return workerId;
    },
    send: async (workerId: string, text: string, questionId: string | null): Promise<void> => {
      await storage.change(async (run) => {
        coordinator(run);
        const worker = workerOf(run, workerId);
        const ticket = ticketOf(run, worker.ticketId);
        const phase = ticket.snapshot.state;
        if (phase.path === "Landed")
          throw new Error("Landed tickets cannot receive further worker assignments");
        const old = currentAssignment(worker.snapshot);
        if (old === undefined) throw new Error("Retired worker cannot be rearmed");
        if (worker.snapshot.state.path === "AwaitingAnswer") {
          if (questionId !== worker.snapshot.state.value.reportId)
            throw new Error("Answer must identify the current question ID");
        } else if (questionId !== null) throw new Error("Question is no longer pending");

        // A changed Git snapshot cannot be repaired by simply relabeling an old review.
        // Explicit coordinator dispatch accounts for superseded work and starts verification again.
        if (
          phase.path === "Reviewing" ||
          phase.path === "Approved" ||
          phase.path === "ReadyToLand"
        ) {
          const facts = await factsFor(run, ticket);
          if (facts.head !== phase.value.head || facts.base !== phase.value.base) {
            if (
              worker.snapshot.value.role === "reviewer" &&
              worker.snapshot.state.path !== "AwaitingAnswer"
            )
              throw new Error("Reassign the implementor to refresh a stale review");
            const reason = `Git snapshot changed from ${phase.value.head} to ${facts.head}; ${text}`;
            let next = run;
            if (ticket.reviewer !== null)
              next = await supersede(next, workerOf(next, ticket.reviewer), reason);
            next = await supersede(next, workerOf(next, ticket.implementor), reason);
            next = await stepTicket(next, ticket.id, TicketEvents.HeadChanged({}));
            next = await freshAssignment(
              next,
              workerOf(next, ticket.implementor),
              `Reverify the changed implementation and ticket requirements. ${text}. Commit/check any needed changes, then report completed for fresh review.`,
              facts.head,
              null,
            );
            return { run: next, value: undefined };
          }
        }
        let next = run;
        let goal = text;
        if (worker.snapshot.state.path === "AwaitingAnswer")
          goal = `${old.goal}\nCoordinator answer to ${questionId}: ${text}`;
        else {
          if (worker.snapshot.value.role === "reviewer")
            throw new Error(
              "Use review tools for new reviewer assignments; fleet_send answers their identified questions",
            );
          if (phase.path === "Reviewing")
            throw new Error(
              "Review is in flight; wait for its callback instead of replacing implementation",
            );
          if (phase.path === "Blocked")
            next = await stepTicket(next, ticket.id, TicketEvents.Resume({}));
          else if (["ReviewReady", "Approved", "ReadyToLand"].includes(phase.path))
            next = await stepTicket(next, ticket.id, TicketEvents.HeadChanged({}));
        }
        next = await freshAssignment(next, worker, goal, old.head, questionId);
        if (worker.snapshot.value.role === "reviewer") {
          const assignment = currentAssignment(workerOf(next, workerId).snapshot);
          if (assignment === undefined) throw new Error("Answered review assignment missing");
          next = await stepTicket(
            next,
            ticket.id,
            TicketEvents.ReviewAssignmentChanged({
              previousAssignment: old.id,
              reviewerAssignment: assignment.id,
            }),
          );
        }
        return { run: next, value: undefined };
      });
      await notify();
    },
    question: async (reportId: string, assignmentId: string, question: string): Promise<void> => {
      const hash = digest(JSON.stringify({ kind: "question", assignmentId, question }));
      await storage.change(async (run) => {
        if (checkReplay(run, reportId, hash)) return { run, value: undefined };
        const worker = activeSelf(run);
        const assignment = currentAssignment(worker.snapshot)!;
        if (assignment.id !== assignmentId)
          throw new Error("Question belongs to a stale assignment");
        let next = await stepWorker(
          run,
          worker.id,
          WorkerEvents.QuestionRecorded({ assignmentId: assignment.id, reportId, question }),
        );
        next = saveReport(next, worker, {
          id: reportId,
          kind: "question",
          requestHash: hash,
          filename: null,
          fileHash: null,
          summary: question,
        });
        next = emit(next, {
          target: "coordinator",
          kind: "question",
          ticketId: worker.ticketId,
          workerId: worker.id,
          assignmentId: assignment.id,
          reportId,
          text: `[async fleet ${run.id}] Question ${reportId} from ${worker.id} (${worker.pane})\n${question}\nAnswer with fleet_send using this fleetId, workerId, and questionId. Do not answer through the worker UI.`,
        });
        return { run: next, value: undefined };
      });
      await notify();
    },
    report: async (input: {
      reportId: string;
      assignmentId: string;
      outcome: "completed" | "failed" | "review" | "approval";
      summary: string;
      filename: string | null;
    }): Promise<void> => {
      const hash = digest(
        JSON.stringify({
          reportId: input.reportId,
          assignmentId: input.assignmentId,
          outcome: input.outcome,
          summary: input.summary,
          filename: input.filename,
        }),
      );
      const initial = await storage.read();
      if (checkReplay(initial, input.reportId, hash)) {
        await notify();
        return;
      }
      const original = activeSelf(initial);
      const originalAssignment = currentAssignment(original.snapshot)!;
      if (originalAssignment.id !== input.assignmentId)
        throw new Error("Report belongs to a stale assignment");
      const originalTicket = ticketOf(initial, original.ticketId);
      if ((original.snapshot.value.role === "reviewer") !== (input.outcome === "review"))
        throw new Error(
          "Reviewer must return a validated Markdown review; implementation outcomes belong to implementors",
        );
      const facts =
        input.outcome === "failed" ? undefined : await factsFor(initial, originalTicket);
      const checks =
        input.outcome === "completed"
          ? await platform.checks(
              originalTicket.snapshot.value.worktree,
              initial.checks,
              initial.commandTimeoutMs,
            )
          : [];
      const file =
        input.outcome === "review" && input.filename !== null
          ? await platform.reviewFile(initial, input.filename)
          : undefined;
      const review =
        input.outcome === "review" &&
        facts !== undefined &&
        file !== undefined &&
        input.filename !== null
          ? await Effect.runPromise(
              validateReview(input.filename, file.text, reviewBinding(initial, original, facts)),
            )
          : undefined;
      await storage.change(async (run) => {
        if (checkReplay(run, input.reportId, hash)) return { run, value: undefined };
        const worker = activeSelf(run);
        const assignment = currentAssignment(worker.snapshot)!;
        const ticket = ticketOf(run, worker.ticketId);
        if (assignment.id !== originalAssignment.id)
          throw new Error("Assignment changed while report verification ran");
        if (facts !== undefined) {
          const current = await factsFor(run, ticket);
          if (current.head !== facts.head || current.base !== facts.base)
            throw new Error("Git snapshot changed while verification ran");
        }
        let next = run;
        let kind: typeof ReportRecord.Type.kind = "implementation";
        if (input.outcome === "review") {
          if (
            worker.snapshot.value.role !== "reviewer" ||
            facts === undefined ||
            review === undefined ||
            file === undefined ||
            input.filename === null
          )
            throw new Error("Reviewer must return a validated assigned Markdown file");
          await Effect.runPromise(
            validateReview(input.filename, file.text, reviewBinding(run, worker, facts)),
          );
          if ((await platform.reviewFile(run, input.filename)).hash !== file.hash)
            throw new Error("Review file changed during validation");
          next = await stepWorker(
            next,
            worker.id,
            WorkerEvents.ReviewRecorded({
              assignmentId: assignment.id,
              reportId: input.reportId,
              head: facts.head,
            }),
          );
          const state = ticket.snapshot.state;
          if (state.path !== "Reviewing") throw new Error("Review is no longer live");
          const evidence = {
            base: facts.base,
            head: facts.head,
            checks: state.value.checks,
            reviewerAssignment: assignment.id,
            filename: input.filename,
          };
          next = await stepTicket(
            next,
            ticket.id,
            review.verdict === "approved"
              ? TicketEvents.ApprovalRecorded(evidence)
              : TicketEvents.FindingsRecorded(evidence),
          );
          const implementor = workerOf(next, ticket.implementor);
          const goal =
            review.verdict === "approved"
              ? `Review approved at ${facts.head}. Read ${run.repository}/${input.filename}, verify the unchanged head, then forward approval using fleet_report outcome approval. Do not change code or land it yourself.`
              : `Fix the validated medium-or-higher findings in ${run.repository}/${input.filename}. Commit fixes and rerun checks, then call fleet_request_review to wake the retained reviewer. Low suggestions do not independently block landing.`;
          next = await freshAssignment(next, implementor, goal, facts.head, null);
          kind = "review";
        } else {
          if (worker.snapshot.value.role !== "implementor")
            throw new Error("Reviewer outcomes must be a question or validated Markdown review");
          next = await stepWorker(
            next,
            worker.id,
            WorkerEvents.ImplementationRecorded({
              assignmentId: assignment.id,
              reportId: input.reportId,
              outcome: input.outcome === "failed" ? "failed" : "completed",
            }),
          );
          if (input.outcome === "failed") {
            next = await stepTicket(
              next,
              ticket.id,
              TicketEvents.FailureRecorded({ reason: input.summary }),
            );
            kind = "failure";
          } else if (input.outcome === "approval") {
            if (
              ticket.snapshot.state.path !== "Approved" ||
              facts === undefined ||
              facts.head !== ticket.snapshot.state.value.head ||
              facts.base !== ticket.snapshot.state.value.base
            )
              throw new Error("Approval must match the live, unchanged reviewed snapshot");
            const filename = ticket.snapshot.state.value.filename;
            await unchangedReview(run, filename);
            next = await stepTicket(
              next,
              ticket.id,
              TicketEvents.ApprovalDelivered({
                head: facts.head,
                reviewerAssignment: ticket.snapshot.state.value.reviewerAssignment,
              }),
            );
            kind = "approval";
          } else {
            if (facts === undefined) throw new Error("Implementation has no verified Git snapshot");
            next = await stepTicket(
              next,
              ticket.id,
              TicketEvents.ImplementationRecorded({ base: facts.base, head: facts.head, checks }),
            );
          }
          next = emit(next, {
            target: "coordinator",
            kind:
              kind === "approval" ? "approval" : kind === "failure" ? "failure" : "implementation",
            ticketId: ticket.id,
            workerId: worker.id,
            assignmentId: assignment.id,
            reportId: input.reportId,
            text: `[async fleet ${run.id}] ${kind} recorded for ${ticket.id} by ${worker.id}.\n${input.summary}\n${kind === "approval" ? "Approval passed through the implementor. Land serially and use fleet_finish_ticket to verify and retire owned workers." : kind === "implementation" ? "Dispatch initial review with fleet_start_review." : "Explicit failure is durable; inspect and reassign rather than treating it as completion."}`,
          });
        }
        next = saveReport(next, worker, {
          id: input.reportId,
          kind,
          requestHash: hash,
          filename: input.outcome === "review" ? input.filename : null,
          fileHash: file?.hash ?? null,
          summary: input.summary,
        });
        return { run: next, value: undefined };
      });
      await notify();
    },
    requestReview: async (
      reportId: string,
      assignmentId: string,
      summary: string,
    ): Promise<void> => {
      const hash = digest(JSON.stringify({ kind: "re-review", assignmentId, summary }));
      const initial = await storage.read();
      if (checkReplay(initial, reportId, hash)) {
        await notify();
        return;
      }
      const original = activeSelf(initial);
      const ticket = ticketOf(initial, original.ticketId);
      if (currentAssignment(original.snapshot)?.id !== assignmentId)
        throw new Error("Re-review request belongs to a stale assignment");
      if (
        original.snapshot.value.role !== "implementor" ||
        ticket.snapshot.state.path !== "Fixing" ||
        ticket.reviewer === null
      )
        throw new Error(
          "Only the active implementor can request re-review after recorded findings",
        );
      await unchangedReview(initial, ticket.snapshot.state.value.filename);
      const facts = await factsFor(initial, ticket);
      const checks = await platform.checks(
        ticket.snapshot.value.worktree,
        initial.checks,
        initial.commandTimeoutMs,
      );
      await storage.change(async (run) => {
        if (checkReplay(run, reportId, hash)) return { run, value: undefined };
        const worker = activeSelf(run);
        const currentTicket = ticketOf(run, worker.ticketId);
        if (
          currentAssignment(worker.snapshot)?.id !== currentAssignment(original.snapshot)?.id ||
          currentTicket.snapshot.state.path !== "Fixing" ||
          currentTicket.reviewer === null
        )
          throw new Error("Re-review request belongs to a stale assignment");
        await unchangedReview(run, currentTicket.snapshot.state.value.filename);
        const current = await factsFor(run, currentTicket);
        if (current.head !== facts.head || current.base !== facts.base)
          throw new Error("Git changed while fixes were checked");
        let next = await stepWorker(
          run,
          worker.id,
          WorkerEvents.ImplementationRecorded({
            assignmentId: currentAssignment(worker.snapshot)!.id,
            reportId,
            outcome: "completed",
          }),
        );
        next = await freshAssignment(
          next,
          workerOf(next, currentTicket.reviewer),
          "Re-review the fixes against previous findings, ticket scope, and repository standards.",
          facts.head,
          null,
        );
        const reviewer = workerOf(next, currentTicket.reviewer);
        next = await stepTicket(
          next,
          ticket.id,
          TicketEvents.FixesRecorded({
            base: facts.base,
            head: facts.head,
            checks,
            reviewerAssignment: currentAssignment(reviewer.snapshot)!.id,
          }),
        );
        next = saveReport(next, worker, {
          id: reportId,
          kind: "re-review",
          requestHash: hash,
          filename: null,
          fileHash: null,
          summary,
        });
        return { run: next, value: undefined };
      });
      await notify();
    },
    interrupted: async (reason: string): Promise<void> => {
      await storage.change(async (run) => {
        const worker = self(run);
        if (worker.snapshot.state.path !== "Active") return { run, value: undefined };
        const assignment = currentAssignment(worker.snapshot)!;
        let next = await stepWorker(run, worker.id, WorkerEvents.MarkLost({ reason }));
        next = await stepTicket(next, worker.ticketId, TicketEvents.FailureRecorded({ reason }));
        next = emit(next, {
          target: "coordinator",
          kind: "failure",
          ticketId: worker.ticketId,
          workerId: worker.id,
          assignmentId: assignment.id,
          reportId: null,
          text: `[async fleet ${run.id}] Runtime interruption, NOT a worker completion: ${worker.id} (${worker.pane})\n${reason}\nInspect the worker/native UI and explicitly reassign/restart it. No semantic outcome or approval was fabricated.`,
        });
        return { run: next, value: undefined };
      });
      await notify();
    },
    stop: async (): Promise<string | undefined> => {
      const reason = await storage.change(async (run) => {
        const worker = self(run);
        if (!needsOutcome(worker.snapshot)) return { run, value: undefined };
        const next = await stepWorker(run, worker.id, WorkerEvents.TryStop({}));
        return {
          run: next,
          value: `Assignment ${currentAssignment(worker.snapshot)!.id} is still open. Record fleet_report, fleet_question, or fleet_request_review before yielding. A final chat message does not satisfy the stop guard.`,
        };
      });
      if (reason === undefined) await notify();
      return reason;
    },
    reviewTemplate: async (): Promise<string> => {
      const run = await storage.read();
      const worker = self(run);
      return reviewTemplate(
        reviewBinding(run, worker, await factsFor(run, ticketOf(run, worker.ticketId))),
        "approved",
      );
    },
    acknowledge: async (callbackId: string): Promise<void> =>
      storage.change(async (run) => {
        const target = actor.kind === "coordinator" ? "coordinator" : self(run).id;
        if (actor.kind === "coordinator") coordinator(run);
        const outbox = run.outbox.map((entry) =>
          entry.id === callbackId && entry.target === target
            ? { ...entry, status: "delivered" as const }
            : entry,
        );
        return { run: { ...run, outbox }, value: undefined };
      }),
    obsolete: async (callbackId: string): Promise<void> =>
      storage.change(async (run) => {
        const target = actor.kind === "coordinator" ? "coordinator" : self(run).id;
        if (actor.kind === "coordinator") coordinator(run);
        return {
          run: {
            ...run,
            outbox: run.outbox.map((entry) =>
              entry.id === callbackId && entry.target === target
                ? { ...entry, status: "obsolete" as const }
                : entry,
            ),
          },
          value: undefined,
        };
      }),
    restartWorker: async (workerId: string): Promise<void> => {
      const run = await storage.read();
      coordinator(run);
      const worker = workerOf(run, workerId);
      if (worker.pane === null || worker.tab === null || worker.snapshot.state.path === "Retired")
        throw new Error(
          "Worker resources are absent/unowned; inspect the uncertain launch instead of allocating duplicate tabs",
        );
      const live = (await platform.agents()).find((agent) => agent.pane === worker.pane);
      if (live !== undefined) {
        if (
          live.name !== worker.name ||
          live.harness !== "pi" ||
          worker.pid === null ||
          !worker.callbackReady ||
          !processIsAlive(worker.pid) ||
          !["idle", "done"].includes(live.status)
        )
          throw new Error(
            "Existing occupant is not a confirmed ready async worker; inspect it rather than starting another",
          );
        await storage.change(async (current) => ({
          run: replaceWorker(current, {
            ...workerOf(current, workerId),
            launch: "started",
            launchError: null,
          }),
          value: undefined,
        }));
        await notify();
        return;
      }
      await launch(workerId, false);
    },
    finishTicket: async (ticketId: string): Promise<void> => {
      const initial = await storage.read();
      coordinator(initial);
      const ticket = ticketOf(initial, ticketId);
      if (ticket.snapshot.state.path !== "ReadyToLand" && ticket.snapshot.state.path !== "Landed")
        throw new Error("Ticket is not approved through its implementor");
      if (ticket.snapshot.state.path === "ReadyToLand") {
        const facts = await factsFor(initial, ticket);
        if (facts.head !== ticket.snapshot.state.value.head)
          throw new Error(
            "Approval is stale after rebase/head movement; reassign and obtain fresh review",
          );
        const filename = ticket.snapshot.state.value.filename;
        await unchangedReview(initial, filename);
        const checks = await platform.checks(
          ticket.snapshot.value.worktree,
          initial.checks,
          initial.commandTimeoutMs,
        );
        if (checks.length === 0) throw new Error("Landing has no fresh checks");
        const integrationHead = await platform.landed(
          ticket.snapshot.value.worktree,
          initial.integrationBranch,
          facts.head,
        );
        await integrationFacts(initial, integrationHead);
        const integrationChecks = await platform.checks(
          initial.repository,
          initial.checks,
          initial.commandTimeoutMs,
        );
        if (integrationChecks.length === 0) throw new Error("Integration has no fresh checks");
        await storage.change(async (run) => {
          coordinator(run);
          const currentTicket = ticketOf(run, ticketId);
          await unchangedReview(run, filename);
          await integrationFacts(run, integrationHead);
          const current = await factsFor(run, currentTicket);
          if (
            current.head !== facts.head ||
            current.base !== facts.base ||
            (await platform.landed(current.worktree, run.integrationBranch, current.head)) !==
              integrationHead
          )
            throw new Error("Landing evidence changed while verification ran");
          return {
            run: await stepTicket(
              run,
              ticketId,
              TicketEvents.LandVerified({
                head: facts.head,
                checkedHead: current.head,
                integrationHead,
                ancestryVerified: true,
              }),
            ),
            value: undefined,
          };
        });
      }
      // Persist Landed first. Cleanup is independently retryable and never touches Git resources.
      for (const workerId of [ticket.implementor, ticket.reviewer].filter(
        (value): value is string => value !== null,
      )) {
        const run = await storage.read();
        coordinator(run);
        const worker = workerOf(run, workerId);
        if (worker.snapshot.state.path === "Retired") continue;
        if (worker.snapshot.state.path !== "Reported")
          throw new Error("Worker still has an unaccounted assignment; refuse cleanup");
        await platform.closeOwned(run, worker);
        await storage.change(async (current) => {
          coordinator(current);
          const retired = await stepWorker(current, workerId, WorkerEvents.Retire({}));
          return {
            run: replaceWorker(retired, { ...workerOf(retired, workerId), callbackReady: false }),
            value: undefined,
          };
        });
      }
    },
  };
};

/**
 * Pi lifecycle and tool adapter consume this interface rather than implementing their own reducer.
 */
export type FleetRuntime = ReturnType<typeof createFleetRuntime>;
