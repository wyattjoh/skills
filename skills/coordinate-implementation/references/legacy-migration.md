# Migrate an Engine-era run

This is a one-time, evidence-based handoff, not a compatibility runtime. A new
Pi or Claude coordinator can do it cold without starting the old harness,
reading its conversation, or having the old helper installed. Neither a schema
upgrade nor successful execution of an old script is a prerequisite.

## Establish exclusive control first

Read the old RESUME.md without changing it. Identify the repository, Base,
coordinator, Engine Lease (when present), and every recorded implementor/reviewer.
Inspect the matching Herdr server, panes, and processes. The coordinator and
Engine are independent: a dead Claude coordinator can leave a live Bun Engine,
workers, gate subprocesses, or a landing operation behind.

If the old runtime is still available, its `status` and graceful `stop` commands
may help. Run them only from a trusted old checkout, with the absolute run path
and bounded command timeout. Do not copy its runtime into this skill, start an
Engine to obtain status, install old dependencies just to convert Markdown, or
assume a successful stop also terminated workers or child commands.

Without the helper, inspect process identity and Herdr directly. A recorded PID
may have been reused; match host, command, working directory, and session before
acting. A stale lease or heartbeat is not proof a process stopped. Do not edit
the lease to pretend the Engine is gone. If the Engine or old coordinator is
alive, ask the user to stop the identified process safely; never kill Herdr,
force-close a pane, or signal an unverified PID. Wait only with a timeout and
report what remains alive when it expires.

Before takeover, verify that the old coordinator/Engine cannot issue more
commands and that any outstanding gates, rebase, or landing operation has
settled. Ask about unreachable hosts or ambiguous ownership. Preserving evidence
and reporting a blocker is preferable to two coordinators mutating the run.
Living ticket workers can remain, provided their pending assignment is understood
and they are not acting as another coordinator.

## Preserve, reconcile, and translate

1. After exclusive control is established, save the original RESUME.md to a
   unique `legacy/` archive inside the run folder before replacing it. Keep old
   snapshots, events, reviews, assessments, escalation records, and scripts as
   evidence. Do not delete global registry/agreement files or overwrite another
   run's records. Old run scripts are historical and must not be restarted.
2. Read the local spec and numbered tickets, old snapshot if available, decisions,
   and outstanding escalations. Resolve inconsistent dependency graphs or changed
   scope with the user. Retain source pointers, but perform no tracker writeback.
   Do not silently dismiss blocked tickets or unresolved user decisions.
3. Inspect Git and workers independently of old status labels. Preserve branch
   names, worktree paths, dirty changes, actual worker configurations, and report
   pointers. Prove which commits landed by ancestry. Verify old approvals against
   the actual reviewed head/base and check evidence; request a new single-reviewer
   pass if evidence is stale, incomplete, or cannot be interpreted confidently.
   Do not recreate old two-axis review or immutable-assessment machinery.
4. Agree on a dedicated integration branch and worktree. Reuse the old Base only
   if it is already a dedicated run branch with no other owner. If the old Base
   is trunk or shared, create the approved new branch from its current verified
   commit. Keep already-landed work in its history; do not rewind trunk or replay
   landed commits. Existing workers rebase remaining work onto the new run branch
   under the normal checks/review policy before landing.
5. Retain approved implementor/reviewer defaults when known; ask for missing
   preferences and the in-flight cap. The old Coordinator triple does not constrain
   the replacement. Even for exhausted Claude usage, always ask once before
   migrating affected workers. Record which tickets and configurations that
   approval covers, and confirm old workers are stopped before replacements start.
6. Write the concise RESUME.md using the outline linked from SKILL.md. Include
   the archive path, takeover evidence, preserved workers, pending commands,
   reconstructed ticket statuses, approvals, and next actions. Missing facts stay
   explicit blockers, not guessed values. Record worker changes and the new
   integration target before sending further prompts.
7. Tell each retained worker the new coordination boundary when it is ready for
   input: complete only its assigned work, return results, and never merge or
   relaunch the old Engine. Count its ticket against the cap. Notify any known
   legacy supervisor that registry updates have ended and it must not restart
   this run. Report the reconciliation to the user, then supervise normally.

The old global registry is no longer a liveness signal. Historical `run.ts`,
SUMMARY.md, closed-ticket labels, and completion events do not establish success
for the new run. Determine completion from reconciled scope, actual integration,
and current final checks, while reporting abandoned or blocked scope honestly.
