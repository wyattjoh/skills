import { Effect } from "effect";
import type { BuiltinOptions } from "./lib/builtins.ts";
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
  SyncOutcome,
  Ticket,
  TicketInfo,
} from "./lib/workflow-runtime.ts";

/**
 * Builds engine ticket operations for a run; tests inject fakes.
 */
export type TicketOpsFactory = (context: EngineContext) => TicketOps;

/**
 * Engine settings for a run script.
 */
export type WorkflowOptions = Partial<BuiltinOptions> & {
  ops?: TicketOpsFactory;
};

/**
 * Declares a run script. The default export of `<run>/run.ts` must be the result.
 *
 * Script control flow must be deterministic for a given sequence of step results:
 * after a restart the body runs again from the top and every built-in step and
 * memoized custom step returns its recorded outcome instead of repeating work.
 *
 * @param body - Async orchestration over the run handle.
 * @param options - Engine settings (`repository`, `implementSkill`, ...) or test operations.
 * @returns The workflow module the engine loads.
 */
export const workflow = (
  body: (run: Run) => Promise<void>,
  options: WorkflowOptions = {},
): WorkflowModule => ({
  kind: "coordinate-workflow",
  run: (context) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { ops: factory, ...engine } = options;
        const ops =
          factory === undefined
            ? yield* Effect.flatMap(
                Effect.promise(() => import("./lib/builtins.ts")),
                (module) => module.builtinTicketOps(context, engine),
              )
            : factory(context);
        yield* Effect.tryPromise({
          try: async (signal) => {
            const run = await createRun({
              context,
              ops,
              tickets: await readTicketGraph(context.runPath),
              signal,
            });
            await body(run);
          },
          catch: (error) => error,
        });
      }),
    ),
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
    if ((await ticket.rebase()) === "ready_to_land") {
      if ((await ticket.land()) === "landed") return;
      continue;
    }
    const gates = await ticket.gates();
    if (!gates.passed) {
      await ticket.fix({ kind: "gates", failed: gates.failed });
      continue;
    }
    if (gates.readyToLand) {
      if ((await ticket.land()) === "landed") return;
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
