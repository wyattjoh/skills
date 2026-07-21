# Journal

Deviation-driven log for the {{WS_NAME}} workspace. An entry is written
whenever the work deviates from what is recorded: a decision that changes
direction, a deviation from a plan or spec, a scope change, or a change that
crosses member repositories. Routine activity does not belong here; git
history already records it.

Entry format (newest date first, appended via `just journal` or
`workspace.ts journal add`):

- `### Decision: <title>` — a direction-setting choice (usually paired with an ADR)
- `### Deviation: <title>` — reality diverged from a recorded plan/spec/ADR
- `### Scope change: <title>` — the boundary of the work moved
- `### Cross-repo change: <title>` — a coordinated change across members

Every entry links three ways where applicable: the plan/phase it touches, the
ADR that governs it, and the member commit/PR that implements it.
