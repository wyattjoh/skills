// Copy to .scratch/<slug>/run.ts, then replace every placeholder:
//   SKILL_DIR        absolute skill path
//   BASE_CHECKOUT    absolute path of the recorded local base checkout (the main checkout for `main`)
//   IMPLEMENT_SKILL  absolute Pi implement SKILL.md path; delete the line for Claude implementors
//   REMOTE_WRITES    "allowed" or "forbidden", the project's authoritative remote-write policy
// Tickets and dependencies come from the accepted snapshot.json; roles and policies from RESUME.md.
import { standardTicket, workflow } from "SKILL_DIR/scripts/workflow.ts";

export default workflow(
  async (run) => {
    await run.frontier((ticket) => standardTicket(ticket));
  },
  {
    repository: "BASE_CHECKOUT",
    implementSkill: "IMPLEMENT_SKILL",
    projectRemoteWrites: "REMOTE_WRITES",
  },
);
