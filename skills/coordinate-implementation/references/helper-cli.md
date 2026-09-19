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

| Code | Meaning                                                          |
| ---- | ---------------------------------------------------------------- |
| `0`  | The request and operation succeeded.                             |
| `1`  | The request was valid, but preflight or state validation failed. |
| `2`  | The request JSON or request schema was invalid or unsupported.   |

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
