# Handoff to a successor orchestrator

Gated on `Coordinator.handoff` in RESUME.md, which defaults from the
coordinator's own harness (`claude` -> `yes`, `pi` -> `no`) and is settable
mid-run like any other preference. When it is `no`, **do not run this
procedure**: stay in the current session, keep RESUME.md current, and let the
harness manage context compaction. Do not launch a successor or stop loops and
monitors for context usage.

Trigger: your own context exceeds `Coordinator.threshold`, read from the `🧠`
figure in `herdr pane read "$HERDR_PANE_ID" --lines 6` at each progress tick and
compared against the record, never against a number memorised from this file.

Timing: the next safe point. Finish the coordinator-owned review, fix, or land
action; do not start more tickets. Active implementors do not need to finish
before handoff, because their runtime blocks and launch scripts transfer their
state to the successor.

## 1. Bring RESUME.md up to date

RESUME.md is the only state file and the successor's only inheritance. Its
format, fields, and validation rules are in
[resume-format.md](resume-format.md). Before handing off, confirm it holds:

- `Prefix:`, `Base:`, `Base sha:`, `Mode:`, `Branch template:`, and complete
  `Coordinator:` and `Implementor:` records.
- The current `<base>` sha and the list of landed tickets.
- A row per ticket carrying its bound record, fix-round count, escalation flag,
  and status.
- A complete `## Active tickets` block for every active worker: actual worktree
  and branch, worker session, herdr tab and pane, current phase, launch script,
  and monitor state. Update each block from the current pane list and pane tail,
  not from memory.
- Remaining tickets in dependency order. The successor applies the recorded
  mode without asking again.
- A `## Decisions` entry for every preference change and scope decision.
- Landed Pi/Pando branches retained for the user. Claude Code's native
  `worktree-*` branches may already be removed by `ExitWorktree`.

If a preference changed and you have been following the write-before-you-reply
rule, this step finds nothing to add. That is the intended outcome: handoff is
a checkpoint, not the moment preferences get written down.

## 2. Launch the successor

The successor inherits the `Coordinator:` record **verbatim**, so an
intentional coordinator choice survives the whole run rather than decaying to a
default at each handoff. Generate the launch line from the record:

```
<harness> --model <model> --effort <effort> --permission-mode auto
```

Always a new pane in **your own tab**, never a new tab or workspace, so the
coordinator lineage stays in one place:

```sh
NEW=$(herdr pane split "$HERDR_PANE_ID" --direction right --no-focus | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
herdr pane run "$NEW" "cd <repo> && claude --model <model> --effort <effort> --permission-mode auto '/coordinate-implementation /herdr resume .scratch/<slug>'"
```

The prompt must begin with `/coordinate-implementation` so the successor
loads this skill; stacking `/herdr` after it loads both, and the trailing
text becomes `$ARGUMENTS` for each. Pass no `--implementor`: the successor
reads the record, and a flag would register as a preference change.

## 3. Stand down

- `CronDelete` your progress loop and your stall check; the successor
  re-creates both from the skill (`/loop 10m` and
  `references/stall-check.md`).
- Stop your background monitors (TaskStop) so the successor's wait is the only
  one on each pane.
- Point your `.scratch/coordinators.md` line at the successor's pane.
- Stay alive until the successor reports its loop and monitors are armed. The
  user closes your pane.
