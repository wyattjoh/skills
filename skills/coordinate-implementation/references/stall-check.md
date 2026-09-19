# Stall check

Run this check only when `herdr.wait_any` returns `reason: timeout`. The timeout
result contains the complete current worker snapshot, including refreshed pane
ids. Persist those ids before inspecting workers.

For each worker still reported as `working`, read at most 25 recent pane lines
and compare the visible activity with the preceding timeout snapshot. A worker
is stalled if the last activity has not changed across two consecutive bounded
timeouts, or if its tail shows an API or network error, permission prompt, or
question waiting on input.

If a worker is waiting on a prompt or hit a transient error, re-prompt the same
session. If it genuinely crashed or loops, apply the skill's worker failure
path: call `infrastructure.retry.record`, wait its returned delay when retrying,
and relaunch from the exact persisted binding. Never substitute a harness,
model, effort, skill, worktree, or branch. An exhausted retry blocks only that
ticket, then the coordinator runs `scheduler.plan` so independent work can
continue.
