# Decomposition Grilling Protocol

Use this protocol after the feature design is settled. Ask one question at a
time, update the decomposition JSON after each answer, then re-validate the DAG
with `task-orchestrator` before writing plan files.

## Working Shape

Maintain the decomposition as a JSON array:

```json
[
  {
    "id": "01-schema",
    "title": "Schema migration",
    "dependsOn": [],
    "context": "Trace back to the design source, ADR, or glossary term.",
    "implementation": "Scope, boundaries, and likely files touched.",
    "acceptance": ["Concrete reviewer-checkable condition"]
  }
]
```

Ids are part of the public contract. Use `NN-slug`, keep them stable during the
discussion when possible, and reference only those ids in `dependsOn`.

## Five-Dimension Grill

### 1. Seams and Right-Sizing

Confirm each task is one focused review loop.

Ask:

- Can one implementer complete this without owning a whole feature area?
- Is the diff reviewable in isolation?
- Does the task have a single reason to change?
- Would splitting it reduce review risk without creating artificial ordering?

Split tasks that mix unrelated concerns, such as schema, API, UI, migration
cleanup, and observability.

### 2. Dependency Edges

Justify every edge. A `dependsOn` entry means the dependent task needs the
dependency's merged code before it can start correctly.

Use this rule:

- Real code dependency: task B imports, calls, migrates from, renders, or tests
  code produced by task A. Add `dependsOn: ["A"]`.
- Conceptual relationship only: tasks share a feature goal, terminology, or
  design source but can be implemented against existing code independently. Do
  not add an edge.
- Review preference only: the user wants to look at one task first. Do not add a
  graph edge unless the code needs it.

Ask for each edge:

> What breaks if these two tasks run in parallel and merge in either order?

If the answer is "nothing, but they are related", remove the edge.

### 3. Conflict Hotspots

Independent tasks may still touch the same files. That is not automatically a
dependency, but it is a scheduling risk.

Ask:

- Which files are likely touched by more than one independent task?
- Can scope boundaries avoid editing the same file?
- Should one task own the shared file, with follow-up tasks consuming it later?
- Is the expected conflict small enough for the orchestrator merge loop?

Record hotspots in each task's `implementation` text, not as fake
dependencies.

### 4. Acceptance Criteria

Every task needs concrete checks that a reviewer can verify without guessing the
entire feature intent.

Good criteria:

- Name visible behavior, API shape, generated artifact, test, or migration
  outcome.
- Include negative cases where relevant.
- Avoid vague words such as "works", "clean", or "complete" unless paired with
  an observable condition.

Ask:

> How will the reviewer know this individual task is done without reading the
> whole parent design again?

### 5. Risk

Mark tasks that are too broad, too sensitive, or too ambiguous for unattended
execution.

Ask:

- Does this touch auth, billing, production data, migrations, secrets, or deploy
  behavior?
- Does it need manual product judgment mid-implementation?
- Would a wrong implementation be expensive to unwind?
- Should this task stop at a plan, spike, or user review gate instead of being
  sent directly to `task-orchestrator`?

High-risk tasks are still allowed, but their plan text must make the review
gate explicit.

## Validation Loop

After each meaningful graph change:

1. Save the current JSON decomposition to a temp file.
2. Invoke the `task-orchestrator` skill to validate the decomposition JSON
   at `<file>`.
3. If validation fails, fix the decomposition before asking the next question.
4. Only scaffold files after the graph is valid.

After scaffolding, invoke the `task-orchestrator` skill to validate the plan
directory at `<plans-dir>` and display the graph.

The emitted directory is the handoff contract for `task-orchestrator`.
