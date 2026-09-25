import type { EngineContext } from "./engine.ts";
import { WorkflowError, type TicketOps } from "./workflow-runtime.ts";

const pending = (): never => {
  throw new WorkflowError({
    code: "workflow.builtins_pending",
    message: "Built-in ticket operations are not wired yet.",
    remediation: "Pass explicit ticket operations to workflow().",
  });
};

/**
 * Production ticket operations over the helper library.
 *
 * @param _context - Engine context for the run.
 * @returns Ticket operations.
 */
export const builtinTicketOps = (_context: EngineContext): TicketOps => pending();
