# Context index

The curated, annotated entry point for the {{WS_NAME}} workspace. This is the
declared allow-list of agent context: if a document is not reachable from
this index, it is not workspace context. Keep annotations current; `audit`
verifies every manifest context layer appears here.

## Load first (every session)

- [Constitution](constitution.md) — invariant principles; violating one is a
  journaled decision, not a slip
- [Phases](../plan/phases.md) — where the work is and what "done with this
  phase" means, with exit criteria
- [Tasks](../plan/tasks.md) — active work units, their members, batches, and
  stacks

## Specifications (the WHAT and WHY)

<!-- One annotated line per spec document. Say what question the document
     answers, not just its title. -->

- [{{SPEC_TITLE}}](spec/{{SPEC_FILE}}) — {{SPEC_ANNOTATION}}

## Decisions

- [ADR directory](adr/) — architecture decision records; read every top-level
  ADR with status `accepted`, skim `superseded` ones only when tracing
  history. `adr/archive/` is compacted history (see the compact flow), not
  context; do not load it

## Research

<!-- Research reports feeding the specs and ADRs. Annotate with what each
     verified or ruled out. -->

## Working records

- [Journal](../JOURNAL.md) — deviation-driven log; read the newest sections
  to learn what changed since the docs were written
- [Glossary](../CONTEXT.md) — the ubiquitous language for this domain
