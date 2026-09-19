import { Data, Effect } from "effect";
import type { CliIssue, SchedulerPlanInput } from "./contract.ts";

/**
 * Deterministic result of one bounded implementation scheduling pass.
 */
export type SchedulerPlan = {
  mode: "parallel" | "serial";
  capacity: number;
  active_implementors: number;
  available_slots: number;
  launch_tickets: string[];
};

/**
 * Typed invalid scheduling graph or runtime state.
 */
export class SchedulerError extends Data.TaggedError("SchedulerError")<{
  issue: CliIssue;
}> {}

const schedulerError = (code: string, message: string, remediation: string): SchedulerError =>
  new SchedulerError({ issue: { code, message, remediation } });

const compareTickets = (left: string, right: string): number => {
  const numeric = Number(left) - Number(right);
  return numeric === 0 ? left.localeCompare(right) : numeric;
};

/**
 * Selects dependency-ready queued tickets without exceeding active implementor capacity.
 *
 * @param input - Scheduling mode, cap, normalized graph, and current runtimes.
 * @returns An Effect containing the deterministic tickets to launch.
 */
export const planSchedule = (
  input: SchedulerPlanInput,
): Effect.Effect<SchedulerPlan, SchedulerError> =>
  Effect.gen(function* () {
    const ticketsByNumber = new Map(input.tickets.map((ticket) => [ticket.number, ticket]));
    if (ticketsByNumber.size !== input.tickets.length) {
      return yield* schedulerError(
        "scheduler.ticket_duplicate",
        "The scheduling graph contains duplicate ticket numbers.",
        "Repair the normalized snapshot before scheduling.",
      );
    }

    for (const ticket of input.tickets) {
      const unknown = ticket.dependencies.filter((dependency) => !ticketsByNumber.has(dependency));
      if (unknown.length > 0) {
        return yield* schedulerError(
          "scheduler.dependency_unknown",
          `Ticket \`${ticket.number}\` has unknown dependencies: ${unknown.join(", ")}.`,
          "Repair the accepted dependency graph before scheduling.",
        );
      }
    }

    const runtimeIds = new Set(input.runtimes.map((runtime) => runtime.runtimeId));
    if (runtimeIds.size !== input.runtimes.length) {
      return yield* schedulerError(
        "scheduler.runtime_duplicate",
        "The scheduling input contains duplicate runtime identities.",
        "Refresh active runtime records before scheduling.",
      );
    }

    const activeImplementors = input.runtimes.filter(
      (runtime) => runtime.role === "implementor" && runtime.state === "active",
    );
    const activeTickets = new Set<string>();
    for (const runtime of activeImplementors) {
      if (!ticketsByNumber.has(runtime.ticket)) {
        return yield* schedulerError(
          "scheduler.runtime_ticket_unknown",
          `Active implementor \`${runtime.runtimeId}\` names unknown ticket \`${runtime.ticket}\`.`,
          "Refresh or repair the runtime before scheduling.",
        );
      }
      if (activeTickets.has(runtime.ticket)) {
        return yield* schedulerError(
          "scheduler.ticket_runtime_duplicate",
          `Ticket \`${runtime.ticket}\` has more than one active implementor runtime.`,
          "Stop and reconcile duplicate workers before scheduling.",
        );
      }
      activeTickets.add(runtime.ticket);
    }

    const capacity = input.mode === "serial" ? 1 : input.maxImplementors;
    const availableSlots = Math.max(0, capacity - activeImplementors.length);
    const launchTickets = input.tickets
      .filter((ticket) => {
        if (ticket.status !== "queued" || activeTickets.has(ticket.number)) return false;
        return ticket.dependencies.every(
          (dependency) => ticketsByNumber.get(dependency)?.status === "landed",
        );
      })
      .map((ticket) => ticket.number)
      .toSorted(compareTickets)
      .slice(0, availableSlots);

    return {
      mode: input.mode,
      capacity,
      active_implementors: activeImplementors.length,
      available_slots: availableSlots,
      launch_tickets: launchTickets,
    };
  });
