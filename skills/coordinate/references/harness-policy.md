# Delegate harness policy

Coordinate stores the user's local delegate-harness choices in `<state_dir>/delegate-harness-policy.json`, where `state_dir` comes from `COORDINATE_CONFIG` or defaults to `~/.local/state/coordinate`. The file is shared by domains using that same state directory. It is not repository policy and does not sync by itself.

## Effective behavior

Only Pi and Claude are represented. A missing policy file preserves the legacy selection: both are enabled and there is no implicit default. New launches accept an omitted `--harness` only when the effective policy has an enabled default. Otherwise pass `--harness pi|claude`; an explicit harness that is disabled is refused.

Policy state is checked before launch side effects. Invalid policy files fail closed. A queued retry must pass the same authorized `--harness` explicitly, then rechecks current policy and capacity; a refused retry leaves its queue entry intact. `--over-budget` affects only the capacity limit and never bypasses harness policy.

Resume uses the harness recorded for the ended session and refuses if that harness is currently disabled. It never substitutes the current default. Policy edits affect later launches and resumes only; they do not stop, relabel, or otherwise change running sessions. `coordinate start` and `coordinate status --resume` show effective policy. The existing watcher coalesces policy notifications and sends them only to domains whose effective enabled/default selection, or the list of harnesses their override enables that global disables, changed; a domain with an override gets a `reenabled` attribute on that event. The Backlog panel edits global and domain policy through the same `harness-policy` commands; its domain pane warns when an override enables a harness global disables and notes when an override only copies global (it will not follow later global changes), and its global pane names each domain whose override keeps a harness that global disables. There is no Codex adapter.

## Policy document

A saved file has `schemaVersion: 1`, a positive integer `revision`, a required `domains` object, and an optional `global` selection. A selection is the complete value `{ "enabled": ["pi", "claude"], "default": "pi" }`; the default is `null` or an enabled harness. The enabled list may be empty. Unknown fields, versions, harnesses, malformed selections, duplicate harnesses, and defaults outside the enabled set make the file invalid. Invalid state is reported as an error and is never replaced with legacy defaults.

When `global` is absent, the effective global selection is the legacy Pi-and-Claude-enabled, no-default value. A domain omitted from `domains` inherits that global selection. An entry in `domains` replaces the whole selection; it does not merge with global values, so a domain override can enable a harness the global policy disables. Text views then print a warning naming the `coordinate harness-policy domain-reset <domain> --expected-revision <n>` command that restores inheritance, with one note per such domain on the global view and `global-set`. `coordinate harness-policy show --domain <domain>` reports the source, mode, effective value, file path, and revision; its JSON carries `domain.reenabled` (the harnesses the override enables that global disables, empty when none) and `global.reenabledBy` (each domain with a non-empty list).

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
