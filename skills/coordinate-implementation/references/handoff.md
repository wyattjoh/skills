# Handoff to a successor orchestrator

This procedure applies only to coordinators running in **Claude**, regardless
of the implementor's model. **Pi coordinators must not run this procedure**:
stay in the current session, keep RESUME.md current, and let Pi manage context
compaction. Do not launch a successor or stop loops and monitors for context usage.

Trigger: your own context exceeds **200,000 tokens**, read from the `🧠`
figure in `herdr pane read <own pane> --lines 6` at each progress tick.
Timing: the next safe point. Finish the in-flight review, fix round, or land
step; do not start another ticket.

## 1. Update RESUME.md

RESUME.md is the only state file; the procedure lives in this skill. Make
sure it holds:

- `Prefix:`, `Base:`, and `Implementor:` lines.
- `<base>` sha and the list of landed tickets.
- For each active ticket: worktree, branch, worker session name, herdr tab label,
  pane id at handoff, what it was told, where it is (reading / editing /
  committed / in fix round N).
- Remaining tickets in order and any parallelism the user allowed.
- Scope decisions and any implementor override.
- Branches landed but not yet deleted by the user.

## 2. Launch the successor

Always a new pane in **your own tab**, never a new tab or workspace, so the
coordinator lineage stays in one place:

```sh
NEW=$(herdr pane split <own pane> --direction right --no-focus | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
herdr pane run "$NEW" "cd <repo> && claude --model claude-fable-5-1 --effort low --permission-mode auto '/coordinate-implementation /herdr resume .scratch/<slug>'"
```

The prompt must begin with `/coordinate-implementation` so the successor
loads this skill; stacking `/herdr` after it loads both, and the trailing
text becomes `$ARGUMENTS` for each.

## 3. Stand down

- `CronDelete` your progress loop and your stall check; the successor
  re-creates both from the skill (`/loop 10m` and
  `references/stall-check.md`).
- Stop your background monitors (TaskStop) so the successor's wait is the only
  one on each pane.
- Point your `.scratch/coordinators.md` line at the successor's pane.
- Stay alive until the successor reports its loop and monitors are armed. The
  user closes your pane.
