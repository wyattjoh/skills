# Normalized snapshot and tracker policy

Coordination reads tracker material only after it has been materialized as a
normalized local snapshot. The coordinator never reads a forge or tracker API
directly. A tracker workflow may create or refresh these files before the run,
but scheduling and review consume only the accepted local revision.

## Snapshot layout

The run folder contains `snapshot.json`, `spec.md`, and the numbered ticket
files declared by the manifest. Those files are the complete tracker-derived
input set used by scheduling and Spec review.

```json
{
  "schema_version": 1,
  "source": {
    "kind": "remote",
    "tracker": "configured-tracker",
    "reference": "tracker:project:portable-run",
    "tracker_workflow": "configured-matt-tracker-workflow"
  },
  "specification": {
    "path": "spec.md",
    "source_reference": "tracker:spec:portable-run",
    "agreed": true
  },
  "tickets": [
    {
      "number": "01",
      "path": "issues/01-foundation.md",
      "source_reference": "tracker:ticket:1",
      "blocked_by": []
    },
    {
      "number": "02",
      "path": "issues/02-feature.md",
      "source_reference": "tracker:ticket:2",
      "blocked_by": ["01"]
    }
  ]
}
```

For a local-file source, use `"kind": "local"` and set
`"tracker_workflow": null`. `tracker`, `reference`, and every
`source_reference` remain required. They identify where an accepted local file
came from even when no remote service exists.

The helper rejects a snapshot unless:

- the manifest uses schema version 1 and has complete source metadata;
- the specification is non-empty and has `agreed: true`;
- every ticket has a unique zero-padded number and a matching `NN-` filename;
- every blocker names another declared ticket and matches the ticket's
  `Blocked by:` line;
- every ticket has a non-empty `Status:` field and at least one Markdown
  acceptance checkbox;
- every referenced path is safe, relative, readable, and resolves by `realpath`
  inside the resolved run folder, including through symlinks;
- every specification and ticket entry has a stable source reference.

The manifest, specification, and all declared tickets are sorted by path and
hashed with SHA-256. The revision is a SHA-256 digest over that ordered path and
content-hash list. Source metadata and references affect the revision because
they are part of `snapshot.json`.

## Initial acceptance

After preflight succeeds and the schema-2 `RESUME.md` exists, invoke
`snapshot.accept`. Pass the run path, state path, authoritative project
remote-write policy, an explicit UTC acceptance timestamp, and the writeback
choice described below.

A successful acceptance writes the managed `## Snapshot` JSON record in
`RESUME.md` and appends a dated entry to `## Decisions` before it returns
`ok: true`. The record contains the accepted revision, every input hash and
source reference, source metadata, acceptance time, and writeback mode. Do not
hand-edit this section.

Local-file sources use `writeback: null` on first acceptance. The helper records
`none` without asking the user a remote-write question.

Non-local sources require one explicit choice:

- `none`: never write status back;
- `final`: invoke the configured tracker workflow only for the final run
  outcome;
- `live`: invoke the configured tracker workflow for durable status changes and
  the final outcome.

The choice persists in the accepted Snapshot record. Passing a different mode
to a later `snapshot.accept` is a deliberate policy change and appends another
decision. Project authority is evaluated on every operation. If it forbids
remote writes, `final` and `live` fail even when they were previously accepted.

## Integrity gate

Invoke `snapshot.check` before every scheduling pass, before review, and during
resume or coordinator takeover. It never mutates state.

- `unchanged` returns `scheduling_allowed: true`.
- `unaccepted` or `changed` returns `scheduling_allowed: false` and reports
  added, changed, or removed input paths.
- A policy conflict or malformed snapshot returns `ok: false`.

When the result is changed, do not start new workers or begin a review. Active
workers may reach their next safe point, but their output is not reviewed or
landed against an unaccepted source revision. Report the changed paths to the
user. Resume only after the user explicitly approves the new material and the
coordinator successfully invokes `snapshot.accept` with a new `accepted_at`
timestamp.

## Tracker workflow boundary

The coordinator treats `source.tracker_workflow` as an opaque Matt tracker
workflow name. For `final` or `live`, invoke that configured workflow with the
persisted source references and the status to write. Do not add tracker-specific
CLI commands, API routes, issue formats, or authentication logic to this skill
or its Bun helper. A tracker adapter owns those details outside the coordinator.
