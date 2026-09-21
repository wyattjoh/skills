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

**Fixture Oracle**:
A controller-owned expected Disposition for a fabricated scenario that is withheld from every assessed model and worker.
_Avoid_: answer key in model context, judge prompt
