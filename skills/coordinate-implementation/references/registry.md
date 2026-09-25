# Global run state contract

Cross-run discovery is machine-local. The helper maintains one JSON file per
run under the global state root so other tools can show status across every
active coordinator on the machine. RESUME.md stays the only authoritative run
state; global files are projections of it.

The root is `$XDG_STATE_HOME/coordinate-implementation/` when `XDG_STATE_HOME`
is absolute, otherwise `$HOME/.local/state/coordinate-implementation/`.
Directories are created with mode `0700` and files with mode `0600`.

```text
<root>/
  runs/<run-id>.json          # one file per run, kind "run"
  agreements/<repo-id>.json   # one file per repository, kind "agreements"
```

The retired `.scratch/coordinators.md` registry is never read or written.
Existing copies are left untouched for the user to delete.

## Run identity

`<run-id>` is the UUID recorded as `Run id:` directly after `Schema version: 2`
in RESUME.md. New runs record it at creation. A run without one receives a
fresh UUID on its first locked helper mutation or heartbeat; that backfill is
the only mutation that adds the line.

`<repo-id>` is the first 12 hex characters of the SHA-256 of the realpath of
the repository's Git common directory (`git rev-parse --git-common-dir`), so
every linked worktree of one repository shares it.

## Writers

Only the helper writes global files. Coordinators and readers never edit them.

- **Mutation.** After every RESUME.md write through the state lock, the helper
  projects the new text and replaces `runs/<run-id>.json`. It preserves the
  previous `heartbeat_at`.
- **Heartbeat.** When a `herdr.wait_any` request carrying `state_path` returns
  for any reason, the helper takes the same state lock, reprojects RESUME.md,
  and sets `heartbeat_at`. It preserves the previous `updated_at` and
  `last_operation`.
- **Agreements.** `agreements.update` replaces `agreements/<repo-id>.json`
  under that file's own lock.

Every replacement writes a temporary file in the destination directory, then
renames it over the destination, so readers only ever see complete JSON.

Run file writes are best effort. A failure never fails the helper operation or
rolls back RESUME.md. The response gains a `warnings` array with
`global_state.write_failed` or `global_state.heartbeat_failed`, and the next
mutation or wait republishes the complete projection. Agreement writes are
coordination state and fail the operation instead.

Owners never delete global files. A completed run keeps its final file.

## Versioning

Each file carries `kind` and its own integer `schema_version`. Adding a field
does not change the version. Removing a field, renaming it, or changing its
type or meaning increments that kind's version and adds a new schema file.
Readers reject an unsupported version instead of guessing.

| Kind         | Version | Schema                                                                 |
| ------------ | ------- | ---------------------------------------------------------------------- |
| `run`        | 1       | [schemas/run.v1.schema.json](schemas/run.v1.schema.json)               |
| `agreements` | 1       | [schemas/agreements.v1.schema.json](schemas/agreements.v1.schema.json) |

`scripts/global-state.test.ts` compares the emitted shape against the current
schema file. It fails when a field disappears or changes type without a
version bump, and when a new field is emitted without being declared.

## Run file fields

| Field                    | Meaning                                                           |
| ------------------------ | ----------------------------------------------------------------- |
| `run_id`                 | RESUME.md `Run id:`                                               |
| `repo.common_dir`        | Realpath of the Git common directory, or null outside Git         |
| `repo.base_checkout`     | Realpath of the checkout containing the run folder                |
| `run_folder`             | Absolute run directory                                            |
| `state_path`             | Absolute RESUME.md path                                           |
| `prefix`, `base`         | RESUME.md `Prefix:` and `Base:`                                   |
| `base_sha`               | RESUME.md `Base sha:`                                             |
| `mode`, `parallel_cap`   | RESUME.md scheduling fields                                       |
| `stall_interval_minutes` | RESUME.md `Stall interval:`; 10 when absent, null when invalid    |
| `run_status`             | `## Run outcome` status: `active`, `waiting`, or `completed`      |
| `summary_path`           | `SUMMARY.md` path once `run.finalize` writes it                   |
| `tickets`                | Ticket table rows: number, status, harness, model, effort         |
| `active_runtimes`        | `## Active tickets` blocks: ticket, session, pane, phase, attempt |
| `coordinator`            | `Coordinator ownership:` generation, pane, readiness              |
| `pauses`                 | `## Stall evidence` lines whose disposition is `pause`            |
| `last_operation`         | Helper operation that last mutated RESUME.md                      |
| `updated_at`             | UTC time of the last mutation projection                          |
| `heartbeat_at`           | UTC time of the last returned wait carrying `state_path`, or null |

A section RESUME.md does not contain, or cannot be parsed, projects as null
or an empty list. The projection never fails a mutation.

## Agreements

A downstream multi-run coordinator records merge order and shared-file
assignments for one repository with `agreements.update`. The first writer
becomes `owner_run_id`. Later writes from any other run fail with
`agreements.not_owner` unless the request sets both `transfer_ownership` and
`user_authorized` after explicit user authority, which moves ownership to the
caller. See [helper-cli.md](helper-cli.md#agreementsupdate).

## Reader protocol

A reader, such as a status tool or a downstream coordinator:

1. lists `runs/*.json` and ignores unreadable files and temporary names;
2. rejects unsupported `kind` or `schema_version` values;
3. groups runs by `repo.common_dir`;
4. treats a coordinator as stale when `heartbeat_at` is null or older than
   twice `stall_interval_minutes` (10 when null) while `active_runtimes` is
   not empty;
5. treats a run as orphaned when `state_path` no longer exists;
6. treats `waiting` as unfinished and `completed` as terminal only when
   `summary_path` exists;
7. reads RESUME.md for any detail beyond the summary, without modifying it;
8. refreshes stale pane identifiers through Herdr's machine-readable control
   surface, and reports discrepancies to the owning coordinator instead of
   rewriting any record.
