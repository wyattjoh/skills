---
name: executing-workflows-manually
description: Executes Claude Code workflow scripts (.claude/workflows/*.js) in a harness that lacks the Workflow tool (Codex, plain sessions) by interpreting the script and performing each agent() call as a subtask. Use when asked to "run this workflow", "execute the workflow file", "follow the workflow manually", or when handed a .js file that exports a meta block and calls agent()/pipeline()/parallel().
argument-hint: "[path/to/workflow.js]"
---

# Executing Workflow Scripts Manually

Claude Code's Workflow tool runs orchestration scripts that fan work out to
fresh-context subagents. An agent without that tool can still execute the same
script: you become the orchestration engine. You interpret the JavaScript top
to bottom, evaluate the glue code faithfully, and perform every `agent()` call
as a real subtask, either by dispatching a subagent (if your harness has any)
or by doing the work yourself, one task at a time.

The script is the contract. Your job is fidelity, not improvisation.

## What a workflow script is

Plain JavaScript (never TypeScript). The body runs as one async function, so
top-level `await` and a final top-level `return` are normal. It begins with a
pure-literal `export const meta = { name, description, whenToUse?, phases? }`
that describes the run. The rest of the file uses a small set of global
functions to orchestrate subagents. Scripts have no filesystem or Node API
access, and `Date.now()`, `Math.random()`, and argless `new Date()` are banned,
so everything except agent results is deterministic.

## Quick reference: construct to manual equivalent

| Construct                    | Engine semantics                                                | Your manual equivalent                                                                                               |
| ---------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `export const meta`          | run metadata, phases for display                                | announce name, description, and phase list before starting                                                           |
| `phase('Title')`             | starts a progress group                                         | announce "Phase: Title" to the user                                                                                  |
| `log(msg)`                   | narrator line                                                   | evaluate the string with real values and report it                                                                   |
| `agent(prompt, opts)`        | fresh-context subagent; its final text is the return value      | perform the prompt as an isolated subtask (rules below)                                                              |
| `pipeline(items, ...stages)` | each item flows through all stages, no cross-item barrier       | for each item in order, run all of its stages to completion, then move to the next item                              |
| `parallel(thunks)`           | run all thunks, wait for all; a failed thunk resolves to `null` | run the thunks one by one in order; a failed one contributes `null`                                                  |
| `args`                       | the Workflow call's input value                                 | whatever the user supplied; `undefined` otherwise. If the script reads `args` and you have none, ask before starting |
| `budget`                     | `{ total, spent(), remaining() }` token target                  | `total` is `null` unless the user gave you a token target; `remaining()` is `Infinity` when `total` is null          |
| `workflow(ref, args)`        | nested workflow run                                             | execute that script the same way, one nesting level only                                                             |
| `return {...}`               | the run's final result                                          | evaluate the object with real values and present it as the outcome                                                   |

## Execution procedure

1. **Read the whole script first.** Identify the constants, helper functions,
   schemas, and every `agent()` call site. Announce `meta.name`,
   `meta.description`, and the phase list.
2. **Resolve inputs.** If the script references `args`, confirm the value with
   the user. Treat `budget.total` as `null` unless the user stated a token
   target, and evaluate budget-guarded code exactly as written (a
   `while (budget.total && ...)` loop with no target never runs).
3. **Create a run journal** in a temp location outside the repo (for example
   `<tmp>/workflow-runs/<meta.name>/journal.md`). One entry per `agent()` call:
   a sequence number, label, phase, status, and the exact return value. Key
   entries by the sequence number, not the label alone; labels built from a
   shared index can collide across calls. This is your resume state and your
   working memory. Never commit it.
4. **Interpret top to bottom** like a single-threaded engine:
   - `phase()` and `log()`: report to the user.
   - `const x = await agent(...)`: execute the subtask (next section), bind
     the result.
   - `pipeline` / `parallel`: unroll into sequential subtasks as in the table.
     Concurrency in the real engine is a wall-clock optimization only; the
     mandatory thing is data-dependency order, which sequential execution
     satisfies automatically.
   - Glue JavaScript between calls (filters, flattens, grouping, string
     building, conditionals, loops): evaluate it faithfully with the real
     values you produced. Results steer control flow, so do not guess. For
     gnarly glue code, it is legitimate to actually run it: write a tiny
     script that stubs `agent()` with your recorded results and executes the
     derivation with `bun` or `node`.
5. **Finish.** When you reach `return`, evaluate the object with real values,
   record it in the journal, and present it to the user as the workflow
   result.

## Executing an agent() call

Each `agent()` call is designed to run in a fresh context with only its prompt.
Preserve that intent:

1. **Materialize the prompt exactly.** Prompts are built by string
   concatenation with constants and prior results (including
   `JSON.stringify(...)` of earlier structured output). Compute the final
   literal string. Never paraphrase, summarize, or "improve" it.
2. **Dispatch or perform.** If your harness can spawn subagents, send the
   materialized prompt verbatim as the subtask's entire instruction. If not,
   perform it yourself as a self-contained task: read only what the prompt
   names, do the work, produce the deliverable.
3. **Produce the return value.** The subagent's final text IS the return
   value, raw data rather than a user-facing message. If the prompt says
   "return a one-paragraph summary", the call's value is that paragraph.
4. **Honor `schema`.** When `opts.schema` is present, the return value must be
   a JSON object validating against that JSON Schema (required fields, enums,
   nesting). Later glue code indexes into it (`review.findings.length`), so
   the shape must be exact.
5. **Record and release.** Write the return value to the journal, keep only it
   in working memory, and let go of everything else the subtask read or
   produced. Artifacts belong on disk where the prompt said to put them.

Handling `opts`:

| Option                  | Manual handling                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `label`, `phase`        | use in journal entries and progress reporting                                                   |
| `schema`                | return JSON validating against it (rule 4 above)                                                |
| `model`, `effort`       | quality hints; honor if you can pick models or effort, otherwise ignore                         |
| `isolation: 'worktree'` | exists to stop parallel agents clobbering files; running sequentially you may skip the worktree |
| `agentType`             | a named agent definition; if your harness has it, use it, otherwise treat as the default        |

## Error semantics

Match the real engine instead of aborting the run:

- A failed `parallel` thunk resolves to `null` in the results array; the call
  itself never throws. Scripts expect this and `.filter(Boolean)` afterward.
- A `pipeline` stage that throws drops that item to `null` and skips its
  remaining stages; other items continue.
- If a subtask fails, retry once; if it still fails, record `null` in the
  journal and continue with the engine's null semantics. Only stop the whole
  run for failures the script cannot absorb (for example the single agent call
  whose result everything else consumes).

## Context hygiene for single-context harnesses

Without subagents, every task shares your one context. To survive large
workflows:

- Do tasks strictly one at a time; finish and journal each before starting the
  next.
- Keep deliverables on disk, summaries in the journal, and only the current
  task's inputs in focus. Re-read files when a later task needs them instead
  of trusting your memory of them.
- Writer and reviewer calls are separate on purpose. When one prompt writes an
  artifact and a later prompt adversarially reviews it, re-read the artifact
  from disk and judge it only against the review prompt's criteria. Do not
  soften the review because you wrote the artifact.
- If the workflow is too large for one session, tell the user and propose
  splitting the run across sessions, using the journal as the handoff: on
  resume, skip journal entries marked complete, reuse their recorded results,
  and recompute derived glue values from them. Subtasks that edit files are
  not idempotent; before re-running one whose status is uncertain, check
  whether the file already reflects the change.

## Common mistakes

| Mistake                                                | Correction                                                                             |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Paraphrasing or trimming an agent prompt               | The materialized string is the contract; deliver it verbatim                           |
| Skipping a call because its result "seems predictable" | Reviews and verifications exist to be run; execute every call the control flow reaches |
| Merging several agent calls into one pass              | Each call is a deliberate scope and perspective boundary; keep them separate           |
| Assuming a budget-guarded loop runs                    | With no user token target, `budget.total` is null and the guard is false               |
| Forgetting later pipeline stage arguments              | Every stage receives `(prevResult, originalItem, index)`                               |
| Returning prose when a schema is set                   | Return exactly the JSON shape; glue code will index into it                            |
| Aborting the run on one failed subtask                 | Apply the null semantics and continue                                                  |
| Doing pipeline stages breadth-first and losing track   | Depth-first per item keeps the journal and your context coherent                       |

## References

- [references/worked-example.md](references/worked-example.md): a complete
  annotated script with its full manual execution trace, including pipeline
  unrolling, schema handling, and the budget guard.
