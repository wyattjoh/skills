import { Effect } from "effect";
import type { EngineContext } from "./lib/engine.ts";
import type { WorkflowModule } from "./lib/runtime-cli.ts";
import {
  createRun,
  readTicketGraph,
  type Run,
  type Ticket,
  type TicketOps,
} from "./lib/workflow-runtime.ts";

export type {
  FixRequest,
  FrontierResult,
  GateOutcome,
  LandOutcome,
  ReviewAxis,
  RoundOutcome,
  Run,
  Ticket,
  TicketInfo,
} from "./lib/workflow-runtime.ts";

/**
 * Builds engine ticket operations for a run.
 */
export type TicketOpsFactory = (context: EngineContext) => TicketOps;

/**
 * Declares a run script. The default export of `<run>/run.ts` must be the result.
 *
 * Script control flow must be deterministic for a given sequence of step results:
 * after a restart the body runs again from the top and every built-in step and
 * memoized custom step returns its recorded outcome instead of repeating work.
 *
 * @param body - Async orchestration over the run handle.
 * @param options - Optional ticket operations override, used by tests.
 * @returns The workflow module the engine loads.
 */
export const workflow = (
  body: (run: Run) => Promise<void>,
  options: { ops?: TicketOpsFactory } = {},
): WorkflowModule => ({
  kind: "coordinate-workflow",
  run: (context) =>
    Effect.tryPromise({
      try: async (signal) => {
        const factory = options.ops ?? (await import("./lib/builtins.ts")).builtinTicketOps;
        const run = await createRun({
          context,
          ops: factory(context),
          tickets: await readTicketGraph(context.runPath),
          signal,
        });
        await body(run);
      },
      catch: (error) => error,
    }),
});

/**
 * The default per-ticket pipeline: implement, then repeat rebase, gates,
 * self-review, both external reviews, and fixes until the ticket lands.
 *
 * @param ticket - Ticket handle from `run.frontier`.
 * @returns A promise that resolves once the ticket has landed.
 */
export const standardTicket = async (ticket: Ticket): Promise<void> => {
  await ticket.implement();
  while (true) {
    await ticket.rebase();
    const gates = await ticket.gates();
    if (!gates.passed) {
      await ticket.fix({ kind: "gates", failed: gates.failed });
      continue;
    }
    await ticket.selfReview();
    await Promise.all([ticket.review("standards"), ticket.review("spec")]);
    const round = await ticket.finalizeRound();
    if (round.action === "fix") {
      await ticket.fix({ kind: "review", path: round.fixRequestPath! });
      continue;
    }
    if ((await ticket.land()) === "landed") return;
  }
};
