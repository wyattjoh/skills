# Capacity and the launch queue

Read this on a capacity refusal or wake, a `capacity-unavailable` event, or before changing a budget.

## Budgets

- A machine's Herdr machine name is canonical: budget keys, the `fleet.machine` label on each delegate, ended records and the capacity queue all use it. The config key `local` and this host's OS hostname both resolve to this core's name (`hc server status --json`). When several keys name this core, its Herdr name wins over the hostname, which wins over `local`.
- Coordinator starts stop at each target machine's per-machine budget, defaulting to `max(2, floor(machine cores / 4))`; `max_fleet_delegates` sets the default and `max_fleet_delegates_by_machine` overrides by machine name. "This core" is the machine the coordinator runs on, so a coordinator on one machine launches and counts there by default.
- Delegates on other machines do not count against this one. `--over-budget` overrides only the capacity refusal, never harness policy, and child reviews count but are not refused by the capacity gate.
- Another machine's live delegates come from its own Herdr as this core's listing relays them. A launch counted against a machine that listing does not show connected is refused (exit 1) rather than counted as idle, and the watcher reports `capacity-unavailable` for it instead of a wake.

## Queue

When an authorized launch hits the cap and should wait, repeat the same command with `--queue-if-full`, for example `coordinate delegate fix-login --task "fix login" --repo <repo> --harness pi --brief <brief> --item i4 --queue-if-full`. This writes only the item id, target machine and enqueue order. It never stores the inline message, options or argv, and it starts no delegate. `coordinate queue show` lists the queue with each item's machine and place in that machine's queue (read-only; the Backlog panel shows it as a Queued group).

The domain watcher checks live delegate capacity across domains on that machine, including settled delegates whose terminals remain live, and wakes the coordinator for the oldest eligible item in this domain's queue per machine. It does not start work itself.

## Capacity wake

Inspect the current item and reconstruct the original authorized launch from the current conversation and its brief. Retry with the original launch flags plus `--retry-queued` and the original `--harness` explicitly (and the same `--machine` for a remote one), for example `coordinate delegate fix-login --task "fix login" --repo <repo> --harness pi --brief <brief> --item i4 --retry-queued`. The command rechecks current harness policy, verifies this is the oldest eligible item, and rechecks the regular budget before starting. If policy or capacity refuses the retry, the item stays queued and the watcher wakes again when capacity returns. A successful start removes the queue entry; a stale wake for a removed entry is ignored.

Queue metadata cannot reconstruct launch context after a restart. Recover each required option and the prior authorization from the backlog, brief and available conversation; if anything needed is missing, surface that and ask rather than guessing or launching. Closing or dismissing the item removes its queue entry on the next watcher tick. Items waiting on the user, in review or parked stay queued but are not monitored for capacity until they become active again.
