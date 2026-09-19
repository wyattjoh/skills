# Coordinate helper CLI

The bundled Bun helper is the public mechanical boundary for the coordinator.
It reads exactly one JSON request from stdin, writes exactly one JSON result to
stdout, and writes no human-oriented text around that result.

Run it as:

```bash
bun $SKILL_DIR/scripts/coordinate.ts
```

The coordinator supplies the JSON request on stdin. Do not infer success from
partial output. Check both the process exit code and the `ok` field.

## Versioned envelope

Every request uses this outer shape:

```json
{
  "schema_version": 1,
  "operation": "preflight",
  "input": {}
}
```

Every result uses this outer shape:

```json
{
  "schema_version": 1,
  "operation": "preflight",
  "ok": true,
  "result": {},
  "errors": []
}
```

Each error has a stable `code`, a human-readable `message`, and an actionable
`remediation`. The helper never migrates an unsupported request or state schema.

Exit codes:

| Code | Meaning                                                        |
| ---- | -------------------------------------------------------------- |
| `0`  | The request and operation succeeded.                           |
| `1`  | The request was valid, but the requested operation failed.     |
| `2`  | The request JSON or request schema was invalid or unsupported. |

## `preflight`

Run preflight before creating or mutating run state. For a new run, use
`state_path: null`. On resume, provide the existing `RESUME.md` path so machine
capabilities and state schema are checked together.

```json
{
  "schema_version": 1,
  "operation": "preflight",
  "input": {
    "state_path": null,
    "skill_roots": null
  }
}
```

`skill_roots` may instead be an array of directories containing installed
skills. A null value checks the supported harnesses' standard global and local
skill locations.

Preflight checks all independent baseline requirements and returns every
failure in one result:

- the platform is macOS or Linux;
- `git`, `bun`, and `herdr` launch successfully;
- at least one of `pi` or `claude` launches successfully;
- Matt Pocock's required `implement` skill is installed;
- `herdr api schema --json` exposes normalized `context_used` and
  `context_limit` fields;
- the optional state document uses supported schema version 1.

Preflight is read-only. A failed check does not create, rewrite, or migrate
`RESUME.md`.

## `state.validate`

Validate the schema marker of an existing Markdown state document independently.
This operation does not validate the document's later semantic fields:

```json
{
  "schema_version": 1,
  "operation": "state.validate",
  "input": {
    "state_path": ".scratch/example/RESUME.md"
  }
}
```

A schema-1 state contains exactly one integer marker:

```text
Schema version: 1
```

A missing, malformed, duplicate, or unsupported marker fails without changing
the file. Recovery is manual or requires a helper that explicitly supports the
recorded version.

## `snapshot.check`

Validate the normalized snapshot and compare its deterministic hashes with the
accepted Snapshot record in `RESUME.md`. This operation is read-only:

```json
{
  "schema_version": 1,
  "operation": "snapshot.check",
  "input": {
    "run_path": ".scratch/example",
    "state_path": ".scratch/example/RESUME.md",
    "writeback": null,
    "project_remote_writes": "allowed",
    "accepted_at": null
  }
}
```

`project_remote_writes` is always `allowed` or `forbidden`, resolved from the
repository's authoritative instructions. `snapshot.check` rejects a non-null
`writeback` value because policy changes require explicit acceptance.

The result status is `unaccepted`, `unchanged`, or `changed`.
`scheduling_allowed` is true only for `unchanged`. A changed result includes a
sorted `changed_inputs` list whose entries are `added`, `changed`, or `removed`.
It does not update the accepted record.

## `snapshot.accept`

Explicitly accept the current normalized snapshot and persist its hashes and
tracker policy in `RESUME.md`:

```json
{
  "schema_version": 1,
  "operation": "snapshot.accept",
  "input": {
    "run_path": ".scratch/example",
    "state_path": ".scratch/example/RESUME.md",
    "writeback": "final",
    "project_remote_writes": "allowed",
    "accepted_at": "2026-09-19T00:00:00Z"
  }
}
```

`accepted_at` must be a UTC ISO-8601 timestamp with whole seconds. Non-local
sources require `writeback` to be `none`, `final`, or `live` on initial
acceptance. A null local-file choice records `none` without prompting. On later
remote acceptance, null preserves the recorded mode; passing another mode is a
deliberate policy change. `forbidden` project authority rejects `final` and
`live`.

Success returns status `accepted` with `scheduling_allowed: true` only after the
managed `## Snapshot` record and an append-only decision have been written. The
record contains the revision, accepted time, source metadata, writeback mode,
and sorted path, source-reference, and SHA-256 entries.

The normalized manifest and coordinator rules are in
[normalized-snapshot.md](normalized-snapshot.md). The helper never invokes a
tracker command. It only validates and persists the opaque configured tracker
workflow name.
