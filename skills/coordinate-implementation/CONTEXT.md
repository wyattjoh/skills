# Implementation Coordination

Implementation Coordination owns the durable movement of accepted tickets from assignment through review and local landing. It separates semantic judgment from workflow authority so uncertain judgments cannot silently change a run.

## Language

**Assessment**:
A semantic judgment over a bounded, authoritative snapshot of one coordination seam.
_Avoid_: AI check, model call, classifier run

**Assessment Evidence**:
An immutable record binding an Assessment request to its provider outcome, timing, usage, and selected Disposition.
_Avoid_: response log, model output

**Disposition**:
The workflow route selected after applying an Authority Policy to Assessment Evidence and deterministic run invariants.
_Avoid_: prediction, answer, recommendation

**Authority Policy**:
A versioned set of deterministic rules that defines which Dispositions an Assessment may select and when uncertainty must pause the seam.
_Avoid_: prompt policy, confidence heuristic

**Stall Assessment**:
A production Assessment over two bounded worker observations, Git summaries, accepted ticket criteria, and the current Herdr status. Its validated Disposition may wait, issue a code-owned re-prompt, pause, or enter the existing worker-retry path.
_Avoid_: pane guess, coordinator intuition

**Linked Attempt**:
A new immutable request that references the exact prior failed Assessment Evidence for unchanged state. Provider failures never overwrite evidence or retry automatically.
_Avoid_: overwrite, silent retry

**Engine**:
The detached, long-lived process in its own Herdr tab that executes a run's Workflow Script, launches and prompts every agent, runs gates, reads agent reports from files, and lands tickets. The coordinator only starts it, waits on its events, and answers its Escalations.
_Avoid_: daemon, background coordinator, runner

**Engine Lease**:
The generation-numbered claim in RESUME.md that names the one Engine allowed to drive a run. Every Engine write re-checks the generation, so a superseded Engine cannot mutate the run.
_Avoid_: lock, pid file

**Event Cursor**:
The persisted sequence number up to which the coordinator has read the Engine's append-only event log. A `wait` without an explicit cursor resumes from it after compaction or restart.
_Avoid_: offset, bookmark

**Workflow Script**:
The run's deterministic `run.ts`, whose control flow over Built-in Steps and custom steps the Engine replays from the top after every restart. The Engine Lease records its SHA-256, and a changed script requires explicit acceptance.
_Avoid_: plan, pipeline config

**Built-in Step**:
A workflow operation such as implement, rebase, gates, self-review, review, fix, or land that converges on the effect already recorded in RESUME.md and immutable evidence instead of repeating it. Only custom steps store write-once results.
_Avoid_: task, job, memoized step

**Escalation**:
A write-once request for judgment outside the review and fix contract that parks exactly one ticket until a single immutable answer arrives. Questions are answered by the coordinator from the spec and tickets first, and by the user otherwise.
_Avoid_: alert, interrupt, block

**Integration Cycle**:
The per-ticket counter of rebases onto the integration branch. Gate and review evidence binds the cycle it ran against, and every rebase starts a new cycle that reruns every gate.
_Avoid_: finalization slot, round

**Patch Identity**:
The stable `git patch-id` of a ticket's change relative to its base. When a rebase leaves it unchanged, both prior reviews remain valid; when it changes, both reviews rerun.
_Avoid_: diff hash, commit SHA

**Land Lock**:
The shared `<git-common-dir>/land-local.lock` held only for the ancestor check and `git merge --ff-only` of one landing, so runs and manual `land-local` invocations on one repository never land concurrently.
_Avoid_: finalization slot, merge queue
