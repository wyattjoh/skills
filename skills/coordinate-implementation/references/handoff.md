# Safe coordinator takeover

Use this protocol whenever the selected Coordinator role differs from the
invoking session, and for any later coordinator change or context handoff. The
same protocol applies to Pi and Claude Code.

The selected `Coordinator:` record must already be validated with
`role.validate` and persisted with the Implementor and Reviewer records. Never
change the selected role to make the current pane appear to match it.

## Matching current session

When harness, model, and effort all match the invoking session, keep the current
pane. Initial setup writes:

```text
Coordinator ownership:
  generation: 0
  pane: <current HERDR_PANE_ID>
  harness: <current harness>
  model: <current model>
  effort: <current effort>
  readiness: ready
  marker: coordinator-ready-0-<current HERDR_PANE_ID>
```

Do not call `coordinator.claim` with the current pane as successor. The helper
rejects that as `coordinator.same_pane`, leaving the generation unchanged.

## Launch a selected successor

At a safe point, read the current ownership generation, pane, and full role record from RESUME.md.
Create a successor pane in the current coordinator tab with no focus change:

```sh
herdr pane split "$HERDR_PANE_ID" --direction right --cwd <repo> --no-focus
```

Read `result.pane.pane_id` from the JSON response. Start exactly the selected
harness and pass its validated model and effort as arguments after `--`:

```sh
herdr agent start coordinator-<prefix>-<next-generation> --kind claude --pane <successor-pane> -- --model <model> --effort <effort> --permission-mode auto
```

```sh
herdr agent start coordinator-<prefix>-<next-generation> --kind pi --pane <successor-pane> -- --approve --model <provider/model> --thinking <effort>
```

Pi uses `--approve` for project trust and has no permission-mode flag. Claude
Code uses `--permission-mode auto`. Do not adapt one command by swapping only
the executable.

Prompt the new Herdr agent with the resume invocation and the expected owner it
must claim:

```sh
herdr agent prompt coordinator-<prefix>-<next-generation> "/coordinate-implementation /herdr resume .scratch/<slug>. Claim coordinator ownership from generation <generation>, predecessor pane <predecessor-pane>, and predecessor role <harness>/<model>/<effort> for successor pane <successor-pane>." --wait --until working
```

If pane creation, agent start, or prompt submission fails before a claim, close
the failed successor pane and continue in the predecessor. State still names
the predecessor as the ready owner.

## Successor claim and readiness

The successor performs these steps in order:

1. Invoke `coordinator.claim` with the expected generation, predecessor pane,
   predecessor role record, its own pane, and the persisted Coordinator role. A stale claim stops the
   successor. It must not retry with guessed ownership.
2. Resume the run from RESUME.md, refresh runtime pane bindings, and arm the
   run's current Herdr wait mechanism. Claiming alone is not readiness.
3. Invoke `coordinator.ready` with the generation, pane, and marker returned by
   the claim.
4. Print one line containing only `COORDINATOR READY <marker>` so the
   predecessor can observe proof in this exact pane.

The claim advances the generation under a short-lived lock and atomic file
replacement. Competing successors using the same expected owner cannot both
succeed.

## Predecessor verification and self-close

The predecessor remains open after launching the successor. Read a bounded tail
from the exact successor pane and copy the marker from its `COORDINATOR READY`
line:

```sh
herdr pane read <successor-pane> --lines 40 --source recent
```

Call `coordinator.verify` with the expected new generation, successor pane, and
that independently observed marker. Verification checks all of these facts:

- state names the expected successor pane;
- state contains the expected generation;
- state records the selected successor role exactly;
- state records `readiness: ready`;
- the observed marker equals the marker in state.

Only after verification returns `ok: true` may the predecessor stop its own
waiters, update the run registry to the successor pane, and close itself:

```sh
herdr pane close "$HERDR_PANE_ID"
```

A timeout, missing marker, `claiming` state, stale generation, or mismatched pane
means verification failed. Keep the predecessor open. Recover the same
successor, or launch a replacement that claims from the current generation and
currently recorded pane. Never mark readiness or close the predecessor on the
failed successor's behalf.

## Binding rules

- Coordinator changes always use this takeover protocol.
- Existing implementor and reviewer sessions keep the role record bound when
  they launched.
- Changes to the run-wide Implementor and Reviewer records govern future
  launches only.
- A failed launch never triggers model, effort, or harness substitution.
