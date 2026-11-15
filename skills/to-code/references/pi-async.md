# Pi callback-driven runs

Use this protocol when `fleet_start_ticket` is available. Both coordinator and managed workers use Pi's async extension; Claude and unmanaged workers use the legacy supervision branch. Require the supported Pi CLI and read the installed plugin's `README.md` for its exact schema and recovery limits. Resolve and record the installed skill and extension paths/revisions independently; a cached remote skill can lag a local extension. Use supported installation/source controls to align them after approval, then check routing in a fresh session. Updating a remote source does not include unpushed local commits.

## Start and schedule

Agree on one existing Herdr workspace, integration branch/worktree, verification commands, model/thinking defaults, ticket worktree naming/location, and in-flight cap. The coordinator's cwd must be that integration worktree. `.scratch/` must be ignored. Call `fleet_setup` with `workspace`, `integrationBranch`, and `checks`; retain both `fleetId` and absolute run `directory` in `RESUME.md`. Its optional `commandTimeoutMs` is an integer **millisecond** budget per verification command (1..570000, default 120000). Worker Bash `timeout` is in **seconds**: 180, not 180000, for a three-minute bound. Require finite shell timeouts and small, reachable fixtures; the extension does not enforce worker Bash budgets.

Create each approved ticket branch/worktree yourself before `fleet_start_ticket`. Supply its clean root, plain `ticketId`, scope/context-pointer `goal`, explicit `model`, and `thinking`. The tool creates a background tab and flag-bound implementor, preserving focus. A launch acknowledgment is not completion. Account for uncertain launches by inspection/reconciliation rather than allocating duplicates.

Track the frontier from durable callbacks and Machine snapshots. An implementor must record completion or failure, or ask `fleet_question`; a chat summary or idle terminal does not count. `fleet_status` is an explicit diagnostic/recovery view. For managed completion, use neither `fleet_wait`/`fleet_watch` nor bounded terminal polling. Yield after assigning work so the next applicable callback can wake this coordinator.

## Questions and review

Every worker question belongs here. Answer with `fleet_send` using the exact `workerId`, pending `questionId`, and `text`; this creates a new correlated assignment and rearms its guard. Route decisions needing human authority to the user. A coordinator answer never grants native permissions or resolves a human confirmation dialog.

Use the assignment's literal identity and suggested per-worker/assignment/operation report IDs. Identical retries keep the ID and payload; changed submissions use a fresh ID, not a bare worker ID. Collision errors identify the prior binding and suggest a usable current ID. Rejected reviews return strict filename/template recovery context and a distinct question ID. A correlated answer refreshes both the assignment and review binding.

On verified implementation, dispatch `fleet_start_review` with the chosen reviewer configuration. The reviewer must ask here or submit its exact assigned scratch Markdown file with current ticket/reviewer/assignment/base/head and a structured verdict/findings section. Bare approval/failure is not a reviewer outcome. Require Standards, Spec, and check-evidence review: read applicable guidance and map acceptance requirements to actual test assertions, identifying uncovered cases. A structurally valid `None` findings report does not prove semantic completeness.

Findings go directly to the implementor. The implementor checks and fixes them, then calls `fleet_request_review`; the retained reviewer is rearmed. Approval goes to the implementor, which must forward `fleet_report` with `outcome: approval` before this coordinator receives ready-to-land evidence.

Changes to a reviewed Git snapshot invalidate approval. Use `fleet_send` to the implementor to account for stale work and request re-verification; a stale reviewer question also routes to implementation refresh. Obtain fresh recorded implementation and review, retaining the reviewer/configuration. Do not reinterpret an old file or ID as approval of a rebased head.

## Land and recover

Land serially yourself with the agreed `git merge --ff-only` workflow. Then call `fleet_finish_ticket`. It verifies unchanged approved source head/artifact, fresh source and integration checks, clean integration worktree, and actual ancestry before recording `Landed` and retiring only owned settled sessions. Keep worktrees, branches, reports, and unrelated panes. Retry failed cleanup independently.

Cold resume uses `fleet_resume` with the canonical absolute run directory. Inspect snapshots, assignments, outbox, pending questions, Git, and named workers before changing the frontier. Live/ambiguous ownership is not transferable. A recorded control fault means waiting for recovery, never semantic completion; hard crashes outside hooks need explicit inspection. Use `fleet_restart_worker` only for a known absent worker or confirmed instance in its already-owned pane. Preserve its worktree and recorded model/thinking; ask once before any migration.

Independently inspect and verify the final integrated branch against repository standards and the spec, including explicit coverage requirements. Delegate any corrections for fresh review before completion; per-ticket approvals do not replace this final check.

Done means every ticket is durably `Landed` (or explicitly resolved as abandoned/blocked by the user), independent integration verification passes, and `RESUME.md`/`SUMMARY.md` preserve evidence and next actions. Pending callbacks or terminal quiet are not proof of this condition.
