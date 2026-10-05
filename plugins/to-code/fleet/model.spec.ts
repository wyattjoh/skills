import { describe, expect, test } from "bun:test";

import { Machine } from "@typeonce/effect-machine";
import { Effect } from "effect";

import {
  advanceTicket,
  advanceWorker,
  createTicket,
  createWorker,
  currentAssignment,
  needsOutcome,
  ticketMachine,
  TicketEvents,
  workerMachine,
  WorkerEvents,
} from "./model.ts";
import { reviewTemplate, validateReview } from "./reports.ts";

const seed = {
  workerId: "impl-1",
  role: "implementor" as const,
  assignment: { id: "assignment-1", goal: "Implement ticket", head: null },
};
const binding = {
  ticketId: "ticket-1",
  reviewerId: "review-1",
  assignmentId: "review-assignment-1",
  base: "b000001",
  head: "c000001",
  currentBase: "b000001",
  currentHead: "c000001",
  filename: ".scratch/review-1.md",
};

const rejection = <A, E>(effect: Effect.Effect<A, E>): string => {
  const result = Effect.runSync(Effect.result(effect));
  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure") throw new Error("Expected a rejected event");
  return String(result.failure);
};

const reviewingTicket = () => {
  let ticket = Effect.runSync(
    createTicket({
      ticketId: "ticket-1",
      worktree: "/ticket",
      goal: "Implement",
      integrationBranch: "run/demo",
    }),
  );
  ticket = Effect.runSync(
    advanceTicket(
      ticket,
      TicketEvents.ImplementationRecorded({
        base: binding.base,
        head: binding.head,
        checks: ["bun test: passed"],
      }),
    ),
  );
  return Effect.runSync(
    advanceTicket(ticket, TicketEvents.StartReview({ reviewerAssignment: binding.assignmentId })),
  );
};

describe("assignment stop protocol", () => {
  test("repeated unreported stops remain active and reprompt", () => {
    let worker = Effect.runSync(createWorker(seed));
    for (let i = 0; i < 3; i++)
      worker = Effect.runSync(advanceWorker(worker, WorkerEvents.TryStop({})));
    expect(worker.state.path).toBe("Active");
    expect(worker.value.reprompts).toBe(3);
    expect(needsOutcome(worker)).toBe(true);
  });

  test("a recorded question permits waiting and only its correlated answer rearms", () => {
    let worker = Effect.runSync(createWorker(seed));
    worker = Effect.runSync(
      advanceWorker(
        worker,
        WorkerEvents.QuestionRecorded({
          assignmentId: "assignment-1",
          reportId: "question-1",
          question: "Which behavior?",
        }),
      ),
    );
    expect(needsOutcome(worker)).toBe(false);
    expect(Effect.runSync(advanceWorker(worker, WorkerEvents.TryStop({}))).state.path).toBe(
      "AwaitingAnswer",
    );
    expect(
      rejection(
        advanceWorker(
          worker,
          WorkerEvents.Assign({
            assignment: { id: "assignment-2", goal: "Answer", head: null },
            answerTo: null,
          }),
        ),
      ),
    ).toContain("not allowed");
    worker = Effect.runSync(
      advanceWorker(
        worker,
        WorkerEvents.Assign({
          assignment: { id: "assignment-2", goal: "Answer", head: null },
          answerTo: "question-1",
        }),
      ),
    );
    expect(needsOutcome(worker)).toBe(true);
    expect(currentAssignment(worker)?.id).toBe("assignment-2");
    expect(
      rejection(
        advanceWorker(
          worker,
          WorkerEvents.ImplementationRecorded({
            assignmentId: "assignment-1",
            reportId: "old",
            outcome: "completed",
          }),
        ),
      ),
    ).toContain("not allowed");
  });

  test("reviewers cannot bypass file validation through implementation completion", () => {
    const worker = Effect.runSync(
      createWorker({
        ...seed,
        role: "reviewer",
        assignment: { ...seed.assignment, head: binding.head },
      }),
    );
    expect(
      rejection(
        advanceWorker(
          worker,
          WorkerEvents.ImplementationRecorded({
            assignmentId: "assignment-1",
            reportId: "report-1",
            outcome: "failed",
          }),
        ),
      ),
    ).toContain("not allowed");
    expect(
      rejection(
        advanceWorker(
          worker,
          WorkerEvents.ReviewRecorded({
            assignmentId: "assignment-1",
            reportId: "report-1",
            head: "stale",
          }),
        ),
      ),
    ).toContain("not allowed");
    const reported = Effect.runSync(
      advanceWorker(
        worker,
        WorkerEvents.ReviewRecorded({
          assignmentId: "assignment-1",
          reportId: "report-1",
          head: binding.head,
        }),
      ),
    );
    expect(needsOutcome(reported)).toBe(false);
  });

  test("active work cannot retire or be overwritten by a new dispatch", () => {
    const worker = Effect.runSync(createWorker(seed));
    expect(rejection(advanceWorker(worker, WorkerEvents.Retire({})))).toContain("not allowed");
    expect(
      rejection(
        advanceWorker(
          worker,
          WorkerEvents.Assign({ assignment: { ...seed.assignment, id: "new" }, answerTo: null }),
        ),
      ),
    ).toContain("not allowed");
  });

  test("schema codecs restore actual Machine snapshots", () => {
    const worker = Effect.runSync(createWorker(seed));
    const encoded = Effect.runSync(Machine.encodeSnapshot(workerMachine, worker));
    const restored = Effect.runSync(
      Machine.decodeSnapshot(workerMachine, JSON.parse(JSON.stringify(encoded))),
    );
    expect(restored).toEqual(worker);
  });
});

describe("ticket review and landing", () => {
  test("findings lead to fixes and implementor-requested re-review", () => {
    let ticket = reviewingTicket();
    ticket = Effect.runSync(
      advanceTicket(
        ticket,
        TicketEvents.FindingsRecorded({
          base: binding.base,
          head: binding.head,
          reviewerAssignment: binding.assignmentId,
          checks: ["passed"],
          filename: binding.filename,
        }),
      ),
    );
    expect(ticket.state.path).toBe("Fixing");
    expect(
      rejection(
        advanceTicket(
          ticket,
          TicketEvents.FixesRecorded({
            base: binding.base,
            head: binding.head,
            checks: ["passed"],
            reviewerAssignment: "review-assignment-2",
          }),
        ),
      ),
    ).toContain("not allowed");
    ticket = Effect.runSync(
      advanceTicket(
        ticket,
        TicketEvents.FixesRecorded({
          base: binding.base,
          head: "c000002",
          checks: ["passed"],
          reviewerAssignment: "review-assignment-2",
        }),
      ),
    );
    expect(ticket.state.path).toBe("Reviewing");
  });

  test("approval is insufficient until delivered; landing requires current checks and ancestry", () => {
    let ticket = reviewingTicket();
    const evidence = {
      base: binding.base,
      head: binding.head,
      checks: ["passed"],
      reviewerAssignment: binding.assignmentId,
      filename: binding.filename,
    };
    ticket = Effect.runSync(advanceTicket(ticket, TicketEvents.ApprovalRecorded(evidence)));
    const land = {
      head: binding.head,
      checkedHead: binding.head,
      integrationHead: "d000001",
      ancestryVerified: true,
    };
    expect(rejection(advanceTicket(ticket, TicketEvents.LandVerified(land)))).toContain(
      "not allowed",
    );
    ticket = Effect.runSync(
      advanceTicket(
        ticket,
        TicketEvents.ApprovalDelivered({
          head: binding.head,
          reviewerAssignment: binding.assignmentId,
        }),
      ),
    );
    expect(
      rejection(
        advanceTicket(ticket, TicketEvents.LandVerified({ ...land, ancestryVerified: false })),
      ),
    ).toContain("not allowed");
    expect(
      rejection(
        advanceTicket(ticket, TicketEvents.LandVerified({ ...land, checkedHead: "stale" })),
      ),
    ).toContain("not allowed");
    ticket = Effect.runSync(advanceTicket(ticket, TicketEvents.LandVerified(land)));
    expect(ticket.state.path).toBe("Landed");
    expect(
      Effect.runSync(
        Machine.decodeSnapshot(
          ticketMachine,
          Effect.runSync(Machine.encodeSnapshot(ticketMachine, ticket)),
        ),
      ),
    ).toEqual(ticket);
  });

  test("head movement invalidates approval and forces new work", () => {
    let ticket = reviewingTicket();
    ticket = Effect.runSync(
      advanceTicket(
        ticket,
        TicketEvents.ApprovalRecorded({
          base: binding.base,
          head: binding.head,
          checks: ["passed"],
          reviewerAssignment: binding.assignmentId,
          filename: binding.filename,
        }),
      ),
    );
    ticket = Effect.runSync(advanceTicket(ticket, TicketEvents.HeadChanged({})));
    expect(ticket.state.path).toBe("Implementing");
    expect(
      rejection(
        advanceTicket(
          ticket,
          TicketEvents.ApprovalDelivered({
            head: binding.head,
            reviewerAssignment: binding.assignmentId,
          }),
        ),
      ),
    ).toContain("not allowed");
  });
});

describe("shared review Markdown validation", () => {
  test("valid approval and findings use the same binding", () => {
    const report = Effect.runSync(
      validateReview(binding.filename, reviewTemplate(binding, "approved"), binding),
    );
    expect(report.verdict).toBe("approved");
    expect(report.findings).toEqual([]);
    expect(
      Effect.runSync(
        validateReview(binding.filename, reviewTemplate(binding, "changes_requested"), binding),
      ).findings[0]?.severity,
    ).toBe("medium");
  });

  test("rejects missing metadata, wrong file, stale assignment/head, and contradictory approval", () => {
    const valid = reviewTemplate(binding, "approved");
    expect(rejection(validateReview(binding.filename, "# Review\n", binding))).toContain(
      "ticket field",
    );
    expect(rejection(validateReview(".scratch/wrong.md", valid, binding))).toContain("filename");
    expect(
      rejection(
        validateReview(
          binding.filename,
          valid.replace(binding.assignmentId, "old-assignment"),
          binding,
        ),
      ),
    ).toContain("assignmentId");
    expect(
      rejection(validateReview(binding.filename, valid, { ...binding, currentHead: "c000002" })),
    ).toContain("stale");
    expect(
      rejection(
        validateReview(binding.filename, valid.replace("None.", "- [high] Unfixed issue"), binding),
      ),
    ).toContain("medium-or-higher");
  });
});
