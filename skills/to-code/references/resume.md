# Handoff and cold resume

`RESUME.md` is a human-readable handoff, not a parser contract or event journal.
Keep it concise and current. Resolve paths relative to this file, or use absolute
paths when a checkout differs. The shared run folder must survive ticket-worktree
cleanup. Workers write only their own results, never the shared handoff.

## Starting shape

Adapt this outline to the run. Remove unused fields rather than manufacturing
values, and mark unknown facts explicitly. Put detailed results in linked files.

```markdown
# Run: <slug>

## Configuration

- Spec and tickets: <paths>
- Repository: <main checkout and Git common directory>
- Starting branch/commit: <branch, SHA>
- Integration: <dedicated run branch, worktree, last observed SHA>
- Ticket branches/worktrees: <approved naming and location>
- Implementor default: <harness, model, effort>
- Reviewer default: <harness, model, effort>
- In-flight cap: <positive integer>
- Setup/checks/cleanup: <resolved commands and governing instruction paths>
- Approval: <user-approved configuration and boundaries>

## Coordinator

<Current harness, Herdr session/pane identity, host, and last update time.
Previous owner and evidence for any takeover. Identity is observational,
not a requirement that the next coordinator use the same harness.>

## Tickets

| Ticket | Blocked by | Status   | Branch / worktree | Workers and bound configurations                         | Next action       |
| ------ | ---------- | -------- | ----------------- | -------------------------------------------------------- | ----------------- |
| <path> | <IDs>      | <status> | <branch, path>    | <implementor/reviewer session IDs, harness/model/effort> | <specific action> |

## Evidence

<Per ticket: implementation head, checked head and commands/results, reviewed
head/base and findings, landed commit, result paths, and pending cleanup.
For pending launches/prompts/merges, record intent and observed outcome so a
replacement can reconcile an interrupted action before repeating it.>

## Decisions and blockers

<Dated user decisions, their scope, unanswered questions, and why a ticket is
blocked. Distinguish approvals from recommendations. Record any worker
migration approval and preserve the previous binding.>

## Next actions

<What the next coordinator should inspect or do first; outstanding operations,
final checks, cleanup, and any separate trunk-integration decision.>
```

Use plain statuses such as `pending`, `implementing`, `reviewing`, `ready to
land`, `blocked`, and `landed`. A blocked ticket releases capacity only after
its worker is stopped or waiting; reserve a slot before unblocking it. An
abandoned prerequisite does not satisfy a dependency. Ask the user to resolve
the downstream scope rather than treating it as landed.

## Take over from either harness

1. Read this handoff, the spec, tickets, decisions, and linked results. Missing
   or stale fields are questions to resolve, not grounds to require the old
   harness. Check the recorded repository and actual worktrees before using paths.
2. Verify through Herdr and process inspection that the former coordinator no
   longer drives the run. A stale timestamp, exhausted quota, absent pane on a
   different server, or user saying it is dead is not sufficient process evidence.
   If it is alive or cannot be checked, establish an explicit safe handoff with
   the user before mutating shared state. Do not kill a live predecessor or clear
   ownership by editing the handoff. No schema, PID, or chat log alone is authority.
3. Inspect the integration branch and each ticket's actual branch, working tree,
   and commit ancestry. A commit already merged can be recorded landed even if
   the old coordinator died before updating the table. A report without a merge
   is not landed. Preserve dirty work and investigate unexpected branch movement.
4. Match recorded workers to live Herdr sessions and their cwd/configuration.
   Reuse active workers. Inspect an interrupted launch or prompt before repeating
   it; absence of a result is not proof that nothing started. Recover results
   from their files or ask the existing worker for a concise status.
5. For missing workers, preserve the same branch/worktree and bound configuration
   when restarting. If unavailable, ask once about migrating affected workers;
   collect the destination harness/model/effort and verify old workers are stopped
   before replacements start. Do not require Claude to launch to resume its work
   in Pi, or change worker bindings just because the coordinator changed harness.
6. Record your coordinator identity, reconciled evidence, and next actions. Count
   all existing in-flight tickets against the cap before launching more. Report
   the state briefly, then continue scheduling and supervision.
