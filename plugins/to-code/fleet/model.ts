import { Machine } from "@typeonce/effect-machine";
import { Effect, Schema } from "effect";

/**
 * An immutable dispatch identity, including the exact head assigned to a reviewer.
 */
export const Assignment = Schema.Struct({
  id: Schema.NonEmptyString,
  goal: Schema.NonEmptyString,
  head: Schema.NullOr(Schema.NonEmptyString),
});

/**
 * Worker identity and first assignment supplied by the launch tool.
 */
export const WorkerSeed = Schema.Struct({
  workerId: Schema.NonEmptyString,
  role: Schema.Literals(["implementor", "reviewer"]),
  assignment: Assignment,
});

/**
 * A declined event is an error at the tool interface, not a silent successful no-op.
 */
export class ProtocolError extends Schema.TaggedError<ProtocolError>()("ProtocolError", {
  message: Schema.NonEmptyString,
}) {}

const WorkerRoot = Machine.state({
  fields: {
    workerId: Schema.NonEmptyString,
    role: Schema.Literals(["implementor", "reviewer"]),
    firstAssignment: Assignment,
    reprompts: Schema.Number,
  },
  states: {
    Active: { fields: { assignment: Assignment } },
    AwaitingAnswer: {
      fields: {
        assignment: Assignment,
        reportId: Schema.NonEmptyString,
        question: Schema.NonEmptyString,
      },
    },
    Reported: {
      fields: {
        assignment: Assignment,
        reportId: Schema.NonEmptyString,
        outcome: Schema.NonEmptyString,
      },
    },
    Lost: { fields: { assignment: Assignment, reason: Schema.NonEmptyString } },
    Retired: {},
  },
});

/**
 * Assignment-correlated events. Recorded events are accepted only after external durable commit.
 */
export const WorkerEvents = Machine.events({
  Assign: { assignment: Assignment, answerTo: Schema.NullOr(Schema.NonEmptyString) },
  QuestionRecorded: {
    assignmentId: Schema.NonEmptyString,
    reportId: Schema.NonEmptyString,
    question: Schema.NonEmptyString,
  },
  ImplementationRecorded: {
    assignmentId: Schema.NonEmptyString,
    reportId: Schema.NonEmptyString,
    outcome: Schema.Literals(["completed", "failed"]),
  },
  ReviewRecorded: {
    assignmentId: Schema.NonEmptyString,
    reportId: Schema.NonEmptyString,
    head: Schema.NonEmptyString,
  },
  Superseded: { assignmentId: Schema.NonEmptyString, reportId: Schema.NonEmptyString },
  TryStop: {},
  MarkLost: { reason: Schema.NonEmptyString },
  Retire: {},
});

/**
 * Shared worker statechart used by Pi stop hooks, report tools, and the browser.
 */
export const workerMachine = Machine.make({
  root: WorkerRoot,
  input: WorkerSeed,
  events: WorkerEvents,
}).handle({
  root: ({ input }) => ({
    workerId: input.workerId,
    role: input.role,
    firstAssignment: input.assignment,
    reprompts: 0,
  }),
  initial: { target: "Active", data: ({ root }) => ({ assignment: root.firstAssignment }) },
  states: {
    Active: {
      on: {
        Superseded: {
          target: "Reported",
          guard: ({ state, event }) => event.assignmentId === state.assignment.id,
          data: ({ state, event }) => ({
            assignment: state.assignment,
            reportId: event.reportId,
            outcome: "superseded",
          }),
        },
        QuestionRecorded: {
          target: "AwaitingAnswer",
          guard: ({ state, event }) =>
            event.assignmentId === state.assignment.id && event.question.trim().length > 0,
          data: ({ state, event }) => ({
            assignment: state.assignment,
            reportId: event.reportId,
            question: event.question,
          }),
        },
        ImplementationRecorded: {
          target: "Reported",
          guard: ({ root, state, event }) =>
            root.role === "implementor" && event.assignmentId === state.assignment.id,
          data: ({ state, event }) => ({
            assignment: state.assignment,
            reportId: event.reportId,
            outcome: event.outcome,
          }),
        },
        ReviewRecorded: {
          target: "Reported",
          guard: ({ root, state, event }) =>
            root.role === "reviewer" &&
            event.assignmentId === state.assignment.id &&
            event.head === state.assignment.head,
          data: ({ state, event }) => ({
            assignment: state.assignment,
            reportId: event.reportId,
            outcome: "review",
          }),
        },
        TryStop: {
          update: "root",
          data: ({ root }) => ({ ...root, reprompts: root.reprompts + 1 }),
        },
        MarkLost: {
          target: "Lost",
          data: ({ state, event }) => ({ assignment: state.assignment, reason: event.reason }),
        },
      },
    },
    AwaitingAnswer: {
      on: {
        Superseded: {
          target: "Reported",
          guard: ({ state, event }) => event.assignmentId === state.assignment.id,
          data: ({ state, event }) => ({
            assignment: state.assignment,
            reportId: event.reportId,
            outcome: "superseded",
          }),
        },
        Assign: {
          target: "Active",
          guard: ({ state, event }) =>
            event.answerTo === state.reportId && event.assignment.id !== state.assignment.id,
          data: ({ event }) => ({ assignment: event.assignment }),
        },
        TryStop: { none: true },
        MarkLost: {
          target: "Lost",
          data: ({ state, event }) => ({ assignment: state.assignment, reason: event.reason }),
        },
      },
    },
    Reported: {
      on: {
        Assign: {
          target: "Active",
          guard: ({ state, event }) =>
            event.answerTo === null && event.assignment.id !== state.assignment.id,
          data: ({ event }) => ({ assignment: event.assignment }),
        },
        TryStop: { none: true },
        Retire: { target: "Retired" },
        MarkLost: {
          target: "Lost",
          data: ({ state, event }) => ({ assignment: state.assignment, reason: event.reason }),
        },
      },
    },
    Lost: {
      on: {
        TryStop: { none: true },
        Assign: {
          target: "Active",
          guard: ({ state, event }) =>
            event.answerTo === null && event.assignment.id !== state.assignment.id,
          data: ({ event }) => ({ assignment: event.assignment }),
        },
      },
    },
    Retired: {},
  },
});

const Evidence = {
  base: Schema.NonEmptyString,
  head: Schema.NonEmptyString,
  checks: Schema.Array(Schema.NonEmptyString),
};
const ReviewEvidence = { ...Evidence, reviewerAssignment: Schema.NonEmptyString };
const ApprovalEvidence = { ...ReviewEvidence, filename: Schema.NonEmptyString };

/**
 * Stable ticket configuration, independent of worker process lifetime.
 */
export const TicketSeed = Schema.Struct({
  ticketId: Schema.NonEmptyString,
  worktree: Schema.NonEmptyString,
  goal: Schema.NonEmptyString,
  integrationBranch: Schema.NonEmptyString,
});

const TicketRoot = Machine.state({
  fields: TicketSeed.fields,
  states: {
    Implementing: {},
    ReviewReady: { fields: Evidence },
    Reviewing: { fields: ReviewEvidence },
    Fixing: {
      fields: {
        base: Schema.NonEmptyString,
        previousHead: Schema.NonEmptyString,
        filename: Schema.NonEmptyString,
      },
    },
    Approved: { fields: ApprovalEvidence },
    ReadyToLand: { fields: ApprovalEvidence },
    Landed: { fields: { head: Schema.NonEmptyString, integrationHead: Schema.NonEmptyString } },
    Blocked: { fields: { reason: Schema.NonEmptyString } },
  },
});

/**
 * Events whose evidence is verified by real or simulated platform operations before dispatch.
 */
export const TicketEvents = Machine.events({
  ImplementationRecorded: Evidence,
  StartReview: { reviewerAssignment: Schema.NonEmptyString },
  ReviewAssignmentChanged: {
    previousAssignment: Schema.NonEmptyString,
    reviewerAssignment: Schema.NonEmptyString,
  },
  FindingsRecorded: { ...ReviewEvidence, filename: Schema.NonEmptyString },
  FixesRecorded: ReviewEvidence,
  ApprovalRecorded: ApprovalEvidence,
  ApprovalDelivered: { head: Schema.NonEmptyString, reviewerAssignment: Schema.NonEmptyString },
  LandVerified: {
    head: Schema.NonEmptyString,
    checkedHead: Schema.NonEmptyString,
    integrationHead: Schema.NonEmptyString,
    ancestryVerified: Schema.Boolean,
  },
  HeadChanged: {},
  FailureRecorded: { reason: Schema.NonEmptyString },
  Resume: {},
});

/**
 * Ticket/review lifecycle. Questions belong to the independently correlated worker statechart.
 */
export const ticketMachine = Machine.make({
  root: TicketRoot,
  input: TicketSeed,
  events: TicketEvents,
}).handle({
  root: ({ input }) => input,
  initial: { target: "Implementing" },
  states: {
    Implementing: {
      on: {
        ImplementationRecorded: {
          target: "ReviewReady",
          guard: ({ event }) => event.checks.length > 0,
          data: ({ event }) => ({ base: event.base, head: event.head, checks: event.checks }),
        },
        FailureRecorded: { target: "Blocked", data: ({ event }) => ({ reason: event.reason }) },
      },
    },
    ReviewReady: {
      on: {
        StartReview: {
          target: "Reviewing",
          data: ({ state, event }) => ({
            base: state.base,
            head: state.head,
            checks: state.checks,
            reviewerAssignment: event.reviewerAssignment,
          }),
        },
        HeadChanged: { target: "Implementing" },
      },
    },
    Reviewing: {
      on: {
        ReviewAssignmentChanged: {
          target: "Reviewing",
          guard: ({ state, event }) =>
            state.reviewerAssignment === event.previousAssignment &&
            event.reviewerAssignment !== event.previousAssignment,
          data: ({ state, event }) => ({
            base: state.base,
            head: state.head,
            checks: state.checks,
            reviewerAssignment: event.reviewerAssignment,
          }),
        },
        FindingsRecorded: {
          target: "Fixing",
          guard: ({ state, event }) =>
            event.head === state.head &&
            event.base === state.base &&
            event.reviewerAssignment === state.reviewerAssignment,
          data: ({ event }) => ({
            base: event.base,
            previousHead: event.head,
            filename: event.filename,
          }),
        },
        ApprovalRecorded: {
          target: "Approved",
          guard: ({ state, event }) =>
            event.head === state.head &&
            event.base === state.base &&
            event.reviewerAssignment === state.reviewerAssignment,
          data: ({ state, event }) => ({
            base: event.base,
            head: event.head,
            checks: state.checks,
            reviewerAssignment: event.reviewerAssignment,
            filename: event.filename,
          }),
        },
        HeadChanged: { target: "Implementing" },
        FailureRecorded: { target: "Blocked", data: ({ event }) => ({ reason: event.reason }) },
      },
    },
    Fixing: {
      on: {
        FixesRecorded: {
          target: "Reviewing",
          guard: ({ state, event }) => event.checks.length > 0 && event.head !== state.previousHead,
          data: ({ event }) => ({
            base: event.base,
            head: event.head,
            checks: event.checks,
            reviewerAssignment: event.reviewerAssignment,
          }),
        },
        FailureRecorded: { target: "Blocked", data: ({ event }) => ({ reason: event.reason }) },
      },
    },
    Approved: {
      on: {
        ApprovalDelivered: {
          target: "ReadyToLand",
          guard: ({ state, event }) =>
            event.head === state.head && event.reviewerAssignment === state.reviewerAssignment,
          data: ({ state }) => ({
            base: state.base,
            head: state.head,
            checks: state.checks,
            reviewerAssignment: state.reviewerAssignment,
            filename: state.filename,
          }),
        },
        HeadChanged: { target: "Implementing" },
        FailureRecorded: { target: "Blocked", data: ({ event }) => ({ reason: event.reason }) },
      },
    },
    ReadyToLand: {
      on: {
        LandVerified: {
          target: "Landed",
          guard: ({ state, event }) =>
            event.head === state.head && event.checkedHead === event.head && event.ancestryVerified,
          data: ({ event }) => ({ head: event.head, integrationHead: event.integrationHead }),
        },
        HeadChanged: { target: "Implementing" },
      },
    },
    Blocked: { on: { Resume: { target: "Implementing" } } },
    Landed: {},
  },
});

/**
 * Decoded worker snapshot, including assignment-owned data.
 */
export type WorkerSnapshot = Machine.Snapshot<typeof workerMachine>;
/**
 * Decoded ticket snapshot, with mutually exclusive lifecycle evidence.
 */
export type TicketSnapshot = Machine.Snapshot<typeof ticketMachine>;
/**
 * Public worker event or typed deferred event construction.
 */
export type WorkerEvent = Machine.Machine.EventInput<Machine.Machine.Event<typeof workerMachine>>;
/**
 * Public ticket event or typed deferred event construction.
 */
export type TicketEvent = Machine.Machine.EventInput<Machine.Machine.Event<typeof ticketMachine>>;

/**
 * Initialize a worker from its explicit launch identity and first assignment.
 */
export const createWorker = Effect.fn("fleet.createWorker")(function* (
  seed: typeof WorkerSeed.Type,
) {
  return (yield* Machine.planInitial(workerMachine, seed)).state;
});
/**
 * Initialize a ticket before any external launch operation.
 */
export const createTicket = Effect.fn("fleet.createTicket")(function* (
  seed: typeof TicketSeed.Type,
) {
  return (yield* Machine.planInitial(ticketMachine, seed)).state;
});
/**
 * Reject disabled/uncorrelated events instead of reporting a successful ignored dispatch.
 */
export const advanceWorker = Effect.fn("fleet.advanceWorker")(function* (
  snapshot: WorkerSnapshot,
  event: WorkerEvent,
) {
  const plan = yield* Machine.plan(workerMachine, snapshot, event);
  if (plan.microsteps.every((step) => step.transitions.length === 0)) {
    return yield* new ProtocolError({
      message: `${event._tag} is not allowed in ${snapshot.state.path}`,
    });
  }
  return plan.next;
});
/**
 * Advance a ticket only when the declared transition and evidence guards accept it.
 */
export const advanceTicket = Effect.fn("fleet.advanceTicket")(function* (
  snapshot: TicketSnapshot,
  event: TicketEvent,
) {
  const plan = yield* Machine.plan(ticketMachine, snapshot, event);
  if (plan.microsteps.every((step) => step.transitions.length === 0)) {
    return yield* new ProtocolError({
      message: `${event._tag} is not allowed in ${snapshot.state.path}`,
    });
  }
  return plan.next;
});
/**
 * Only active assignments lack an outcome. Lost is an accounted control fault awaiting
 * coordinator recovery, never semantic completion or approval.
 */
export const needsOutcome = (snapshot: WorkerSnapshot): boolean => snapshot.state.path === "Active";
/**
 * Read the current assignment without treating worker terminal state as completion evidence.
 */
export const currentAssignment = (snapshot: WorkerSnapshot): typeof Assignment.Type | undefined =>
  snapshot.state.path === "Retired" ? undefined : snapshot.state.value.assignment;
