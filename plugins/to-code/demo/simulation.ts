import { Machine } from "@typeonce/effect-machine";
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
  ticketMachine,
  workerMachine,
  type TicketSnapshot,
  type WorkerSnapshot,
} from "../fleet/model.ts";
import { reviewTemplate, validateReview } from "../fleet/reports.ts";

/**
 * Browser commands invoke production Machine events; Git, files, panes and transport are fake.
 */
export type DemoAction =
  | "start"
  | "stop"
  | "complete"
  | "review"
  | "submit"
  | "question"
  | "answer"
  | "rereview"
  | "forward"
  | "land"
  | "head"
  | "refresh"
  | "fault"
  | "recover"
  | "save"
  | "restore"
  | "bare-approval";

/**
 * Serializable fake platform state around real production snapshots, not a second reducer.
 */
export type DemoState = {
  ticket: TicketSnapshot | undefined;
  workers: Partial<Record<"implementor" | "reviewer", WorkerSnapshot>>;
  head: string;
  base: string;
  online: boolean;
  extension: boolean;
  checksPass: boolean;
  merged: boolean;
  foreignPane: boolean;
  physicalIdle: boolean;
  callbacks: { id: string; target: string; text: string; delivered: boolean }[];
  ledger: string[];
  log: string[];
  notice: string;
  error: boolean;
};

/**
 * Creates an isolated simulator. Its dispatch plans actual production transitions atomically;
 * role selects the worker, Markdown is validated by the production review parser.
 */
export const createSimulation = () => {
  let sequence = 0;
  let saved: string | undefined;
  let state: DemoState = {
    ticket: undefined,
    workers: {},
    head: "c000001",
    base: "b000001",
    online: true,
    extension: true,
    checksPass: true,
    merged: false,
    foreignPane: false,
    physicalIdle: false,
    callbacks: [],
    ledger: [],
    log: [],
    notice: "Choose a guided flow or start a ticket in free play.",
    error: false,
  };
  const id = () => `a-${++sequence}`;
  const worker = (s: DemoState, role: "implementor" | "reviewer") => {
    const w = s.workers[role];
    if (w === undefined) throw new Error("Worker not started");
    return w;
  };
  const ticket = (s: DemoState) => {
    if (s.ticket === undefined) throw new Error("Ticket not started");
    return s.ticket;
  };
  const stepWorker = (
    s: DemoState,
    role: "implementor" | "reviewer",
    event: Parameters<typeof advanceWorker>[1],
  ) => {
    s.workers[role] = Effect.runSync(advanceWorker(worker(s, role), event));
  };
  const stepTicket = (s: DemoState, event: Parameters<typeof advanceTicket>[1]) => {
    s.ticket = Effect.runSync(advanceTicket(ticket(s), event));
  };
  const callback = (s: DemoState, target: string, text: string) => {
    s.callbacks.push({ id: id(), target, text, delivered: target !== "coordinator" || s.online });
  };
  const assign = (
    s: DemoState,
    role: "implementor" | "reviewer",
    goal: string,
    answerTo: string | null = null,
  ) => {
    stepWorker(
      s,
      role,
      WorkerEvents.Assign({ assignment: { id: id(), goal, head: s.head }, answerTo }),
    );
    callback(s, role, goal);
  };
  const binding = (s: DemoState) => {
    const w = worker(s, "reviewer");
    const t = ticket(s);
    if (t.state.path !== "Reviewing") throw new Error("No live review binding");
    const assignment = currentAssignment(w)!;
    return {
      ticketId: "T1",
      reviewerId: "r-1",
      assignmentId: assignment.id,
      base: t.state.value.base,
      head: t.state.value.head,
      currentBase: s.base,
      currentHead: s.head,
      filename: `.scratch/to-code/async-demo/reports/r-1-${assignment.id}.md`,
    };
  };
  const template = (verdict: "approved" | "changes_requested") =>
    reviewTemplate(binding(state), verdict);
  const dispatch = (
    action: DemoAction,
    role: "implementor" | "reviewer" = "implementor",
    markdown = "",
    filename: string | undefined = undefined,
  ): void => {
    const next: DemoState = {
      ...state,
      workers: { ...state.workers },
      callbacks: state.callbacks.map((c) => ({ ...c })),
      ledger: [...state.ledger],
      log: [...state.log],
      error: false,
    };
    try {
      if (action === "start") {
        if (next.ticket !== undefined)
          throw new Error("Ticket already assigned; do not repeat launch");
        next.ticket = Effect.runSync(
          createTicket({
            ticketId: "T1",
            worktree: "/sim/tickets/T1",
            goal: "Implement the agreed ticket and repository standards",
            integrationBranch: "run/demo",
          }),
        );
        next.workers.implementor = Effect.runSync(
          createWorker({
            workerId: "i-1",
            role: "implementor",
            assignment: { id: id(), goal: "Implement T1; commit and check", head: null },
          }),
        );
        callback(
          next,
          "implementor",
          "Background tab, existing worktree, explicit model/thinking, --fleet-implementor i-1",
        );
        next.notice =
          "Assignment open · i-1 · stop guard armed. Report an outcome or ask the coordinator before yielding.";
      } else if (action === "stop") {
        const w = worker(next, role);
        if (!next.extension) {
          next.physicalIdle = true;
          next.notice =
            "Extension off: terminal settled without an outcome. Ticket remains unaccounted.";
        } else {
          stepWorker(next, role, WorkerEvents.TryStop({}));
          next.notice = needsOutcome(w)
            ? `Assignment open · ${currentAssignment(w)!.id} · continue and report or ask the coordinator.`
            : "Accounted waiting allowed; this does not imply the ticket is landed.";
        }
      } else if (action === "complete" || action === "bare-approval") {
        if (!next.checksPass)
          throw new Error("Simulated verification failed; outcome not recorded");
        const w = worker(next, role);
        stepWorker(
          next,
          role,
          WorkerEvents.ImplementationRecorded({
            assignmentId: currentAssignment(w)!.id,
            reportId: id(),
            outcome: "completed",
          }),
        );
        stepTicket(
          next,
          TicketEvents.ImplementationRecorded({
            base: next.base,
            head: next.head,
            checks: ["simulated checks: passed"],
          }),
        );
        next.ledger.push("Implementation outcome durably recorded");
        callback(next, "coordinator", "Implementation verified, dispatch review");
        next.notice = "Implementation recorded before yielding; review is still required.";
      } else if (action === "review") {
        if (next.workers.reviewer === undefined)
          next.workers.reviewer = Effect.runSync(
            createWorker({
              workerId: "r-1",
              role: "reviewer",
              assignment: {
                id: id(),
                goal: "Read-only Standards and Spec review",
                head: next.head,
              },
            }),
          );
        else assign(next, "reviewer", "Review the refreshed implementation");
        stepTicket(
          next,
          TicketEvents.StartReview({
            reviewerAssignment: currentAssignment(worker(next, "reviewer"))!.id,
          }),
        );
        callback(
          next,
          "reviewer",
          "Retained reviewer must submit its assigned Markdown artifact or ask coordinator",
        );
        next.notice = "Review assigned; edit and submit the exact bound Markdown file.";
      } else if (action === "submit") {
        const bound = binding(next);
        const report = Effect.runSync(validateReview(filename ?? bound.filename, markdown, bound));
        stepWorker(
          next,
          "reviewer",
          WorkerEvents.ReviewRecorded({
            assignmentId: bound.assignmentId,
            reportId: id(),
            head: report.head,
          }),
        );
        const evidence = {
          base: report.base,
          head: report.head,
          reviewerAssignment: bound.assignmentId,
          filename: bound.filename,
          checks: ["simulated checks: passed"],
        };
        stepTicket(
          next,
          report.verdict === "approved"
            ? TicketEvents.ApprovalRecorded(evidence)
            : TicketEvents.FindingsRecorded(evidence),
        );
        assign(
          next,
          "implementor",
          report.verdict === "approved"
            ? "Forward validated approval to coordinator"
            : "Fix medium-or-higher findings, then request retained re-review",
        );
        next.ledger.push(`Validated immutable review: ${report.verdict} · ${bound.filename}`);
        callback(next, "implementor", `Review ${report.verdict}: ${bound.filename}`);
        next.notice = "Validated review routed directly to implementor, not to coordinator.";
      } else if (action === "question") {
        const w = worker(next, role);
        const questionId = id();
        stepWorker(
          next,
          role,
          WorkerEvents.QuestionRecorded({
            assignmentId: currentAssignment(w)!.id,
            reportId: questionId,
            question: "Which interpretation should this ticket use?",
          }),
        );
        next.ledger.push(`Coordinator question ${questionId}`);
        callback(next, "coordinator", `Question ${questionId} from ${role}`);
        next.notice =
          "Question recorded. Accounted waiting is allowed; only its correlated answer rearms.";
      } else if (action === "answer") {
        const w = worker(next, role);
        if (w.state.path !== "AwaitingAnswer") throw new Error("No pending question");
        const previous = w.state.value.assignment.id;
        assign(
          next,
          role,
          "Coordinator answer: use the agreed interpretation",
          w.state.value.reportId,
        );
        if (role === "reviewer")
          stepTicket(
            next,
            TicketEvents.ReviewAssignmentChanged({
              previousAssignment: previous,
              reviewerAssignment: currentAssignment(worker(next, role))!.id,
            }),
          );
        next.notice = "Answer correlated; new assignment, stop guard rearmed.";
      } else if (action === "rereview") {
        if (!next.checksPass) throw new Error("Fix checks failed");
        const w = worker(next, "implementor");
        stepWorker(
          next,
          "implementor",
          WorkerEvents.ImplementationRecorded({
            assignmentId: currentAssignment(w)!.id,
            reportId: id(),
            outcome: "completed",
          }),
        );
        assign(next, "reviewer", "Re-review fixes against previous findings");
        stepTicket(
          next,
          TicketEvents.FixesRecorded({
            base: next.base,
            head: next.head,
            checks: ["simulated fix checks: passed"],
            reviewerAssignment: currentAssignment(worker(next, "reviewer"))!.id,
          }),
        );
        next.ledger.push("Fixes and retained re-review assignment recorded together");
        next.notice = "Same reviewer rearmed; no new reviewer/tab allocated.";
      } else if (action === "forward") {
        const t = ticket(next);
        if (t.state.path !== "Approved" || t.state.value.head !== next.head)
          throw new Error("Approval does not match current snapshot");
        const w = worker(next, "implementor");
        stepWorker(
          next,
          "implementor",
          WorkerEvents.ImplementationRecorded({
            assignmentId: currentAssignment(w)!.id,
            reportId: id(),
            outcome: "completed",
          }),
        );
        stepTicket(
          next,
          TicketEvents.ApprovalDelivered({
            head: next.head,
            reviewerAssignment: t.state.value.reviewerAssignment,
          }),
        );
        next.ledger.push("Implementor forwarded approval");
        callback(next, "coordinator", "Approval ready for caller-owned serial landing");
        next.notice = "Coordinator has approval; this is not yet landed.";
      } else if (action === "land") {
        if (!next.checksPass) throw new Error("Fresh source/integration checks failed");
        if (ticket(next).state.path !== "Landed")
          stepTicket(
            next,
            TicketEvents.LandVerified({
              head: next.head,
              checkedHead: next.head,
              integrationHead: next.head,
              ancestryVerified: next.merged,
            }),
          );
        state = next; // Landing is durable before independently retryable cleanup.
        if (next.foreignPane)
          throw new Error("Foreign occupant: refuse cleanup and preserve resources");
        stepWorker(next, "implementor", WorkerEvents.Retire({}));
        stepWorker(next, "reviewer", WorkerEvents.Retire({}));
        next.ledger.push("Verified landing, then owned pane cleanup. Git resources preserved.");
        next.notice =
          "Landed and owned workers retired; branches, worktrees and reports preserved.";
      } else if (action === "head") {
        next.head = `c${String(++sequence).padStart(6, "0")}`;
        next.notice = "Simulated commit/rebase moved HEAD; old evidence is stale.";
      } else if (action === "refresh") {
        for (const r of ["implementor", "reviewer"] as const) {
          const w = next.workers[r];
          if (w !== undefined && (w.state.path === "Active" || w.state.path === "AwaitingAnswer")) {
            stepWorker(
              next,
              r,
              WorkerEvents.Superseded({ assignmentId: currentAssignment(w)!.id, reportId: id() }),
            );
            next.ledger.push(`${r} stale assignment explicitly superseded`);
          }
        }
        stepTicket(
          next,
          ticket(next).state.path === "Blocked"
            ? TicketEvents.Resume({})
            : TicketEvents.HeadChanged({}),
        );
        assign(next, "implementor", "Reverify changed code, then fresh review");
        next.notice = "Stale work accounted; approval invalidated and implementation rearmed.";
      } else if (action === "fault") {
        stepWorker(
          next,
          role,
          WorkerEvents.MarkLost({
            reason: "Observed native interruption, not semantic completion",
          }),
        );
        stepTicket(
          next,
          TicketEvents.FailureRecorded({ reason: "Observed runtime control fault" }),
        );
        callback(next, "coordinator", "Lost control fault; inspect and explicitly recover");
        next.notice = "Lost/Blocked is accounted control-fault waiting, never approval.";
      } else if (action === "recover") {
        next.online = true;
        next.callbacks.forEach((c) => {
          c.delivered = true;
        });
        next.notice = "Recipient resumed; pending callbacks replayed, not outcomes fabricated.";
      } else if (action === "save") {
        saved = JSON.stringify({
          ...next,
          ticket:
            next.ticket === undefined
              ? null
              : Effect.runSync(Machine.encodeSnapshot(ticketMachine, next.ticket)),
          workers: Object.fromEntries(
            Object.entries(next.workers).map(([r, w]) => [
              r,
              Effect.runSync(Machine.encodeSnapshot(workerMachine, w)),
            ]),
          ),
        });
        next.notice = "Actual Machine codecs saved snapshots and fake outbox.";
      } else if (action === "restore") {
        if (saved === undefined) throw new Error("Save before restarting the simulator");
        const value = JSON.parse(saved);
        Object.assign(next, value, {
          ticket:
            value.ticket === null
              ? undefined
              : Effect.runSync(Machine.decodeSnapshot(ticketMachine, value.ticket)),
          workers: Object.fromEntries(
            Object.entries(value.workers).map(([r, w]) => [
              r,
              Effect.runSync(Machine.decodeSnapshot(workerMachine, w)),
            ]),
          ),
          notice: "Machine snapshots restored; durable pending work retained.",
        });
      }
      next.log.push(`${action} · ${role} · ${next.ticket?.state.path ?? "NotStarted"}`);
      state = next;
    } catch (error) {
      state = {
        ...state,
        notice: String(error),
        error: true,
        log: [...state.log, `REJECTED ${action}: ${String(error)}`],
      };
    }
  };
  return {
    getState: () => state,
    dispatch,
    template,
    binding: () => binding(state),
    configure: (
      settings: Partial<
        Pick<DemoState, "online" | "extension" | "checksPass" | "merged" | "foreignPane">
      >,
    ) => {
      state = { ...state, ...settings };
    },
  };
};
