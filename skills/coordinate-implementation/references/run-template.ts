// Copy to .scratch/<slug>/run.ts and replace SKILL_DIR with the absolute skill path.
// Tickets and dependencies come from the accepted snapshot.json, never from this file.
import { standardTicket, workflow } from "SKILL_DIR/scripts/workflow.ts";

export default workflow(async (run) => {
  await run.frontier((ticket) => standardTicket(ticket));
});
