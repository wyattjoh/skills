# Delegate harness policy

Coordinate stores the user's local delegate-harness choices in `<state_dir>/delegate-harness-policy.json`, where `state_dir` comes from `COORDINATE_CONFIG` or defaults to `~/.local/state/coordinate`. The file is shared by domains using that same state directory. It is not repository policy and does not sync by itself.

## Current behavior

The current `coordinate delegate` parser requires `--harness pi|claude`; the flag has no default. A missing policy file therefore displays the legacy selection, both Pi and Claude enabled and no implicit default, without changing launch behavior. In this phase, policy commands only inspect or edit stored policy. They do not authorize or block delegate launches, resumes, retries, or queue entries. Keep passing `--harness` explicitly.

Only Pi and Claude are represented. Codex support, model restrictions, launch enforcement, UI editing, watcher notifications, and resume or queue policy behavior are not part of this phase.

## Policy document

A saved file has `schemaVersion: 1`, a positive integer `revision`, a required `domains` object, and an optional `global` selection. A selection is the complete value `{ "enabled": ["pi", "claude"], "default": "pi" }`; the default is `null` or an enabled harness. The enabled list may be empty. Unknown fields, versions, harnesses, malformed selections, duplicate harnesses, and defaults outside the enabled set make the file invalid. Invalid state is reported as an error and is never replaced with legacy defaults.

When `global` is absent, the effective global selection is the legacy Pi-and-Claude-enabled, no-default value. A domain omitted from `domains` inherits that global selection. An entry in `domains` replaces the whole selection; it does not merge with global values. `coordinate harness-policy show --domain <domain>` reports the source, mode, effective value, file path, and revision.

## Commands

Read current state before writing, and pass its revision with every mutation:

```sh
coordinate harness-policy show --json
coordinate harness-policy show --domain <domain> --json
coordinate harness-policy global-set --enabled pi,claude --default pi --expected-revision <revision>
coordinate harness-policy domain-set <domain> --enabled claude --default claude --expected-revision <revision>
coordinate harness-policy domain-reset <domain> --expected-revision <revision>
```

Use `--enabled none --no-default` for an empty enabled set. Specify exactly one of `--default <pi|claude>` or `--no-default`. `global-set` and `domain-set` replace the complete selection for their scope. A domain replacement can be set only for an existing domain. `domain-reset` removes a replacement and restores inheritance; it can also clear an orphaned entry left by manual state editing.

The file revision increases on committed edits. Writers serialize through the state lock and compare `--expected-revision` while holding it. A stale revision is refused with the current revision and instructions to show again, preventing two CLI editors from silently overwriting one another. Read-only show reads the atomically replaced file. Use the CLI as the writer; direct file edits do not participate in locking or stale-write checks.

Anyone who can invoke the CLI and write to the configured state directory can edit this local policy. It has no separate role or identity ACL and is not a security boundary.

## Domain rename

`coordinate backlog rename` refuses to rename a source or target domain while either has a harness replacement. This avoids silently moving an override or activating an orphaned target override. Show the affected domain policy, then explicitly reset its replacement with the current revision before retrying the rename. Global settings and inherited domains do not prevent rename. The rename guard and policy edits share a lock, so an override cannot be added between the check and rename.
