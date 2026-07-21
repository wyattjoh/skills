---
description: Agent authoring conventions including frontmatter fields, reload behavior, and validation
paths:
  - "agents/**/*.md"
alwaysApply: false
---

Agent definitions live at `agents/<name>.md` as markdown files with YAML frontmatter.

## Frontmatter fields

- `name`: kebab-case identifier
- `description`: Delegation trigger (use "PROACTIVELY" or "MUST USE" for auto-activation)
- `tools`: Allowed tools. Two accepted forms:
  - Comma-separated scalar string: `tools: "Bash, Read, Grep"`
  - YAML list (required when entries contain colons or spaces): `tools:\n  - Read\n  - "Bash(jq:*)"`
    Omit the field to inherit all tools from the parent session.
- `model`: `inherit`, `haiku`, `sonnet`, or `opus`
- `skills`: Skills to autoload (subagents don't inherit parent skills)
- `permissionMode`: `default`, `acceptEdits`, `bypassPermissions`, `plan`
- `memory`: Persistence scope. `user` stores memory per-user across sessions. Version-sensitive: verify against the installed Claude Code release.
- `color`: Label color shown in the Claude Code UI (e.g. `cyan`). Version-sensitive: verify against the installed Claude Code release.

## Reload behavior

Agents require a Claude Code restart to pick up changes. Skills, by contrast, hot-reload.

## Validation

Use the `plugin-dev:plugin-validator` agent to validate agent definitions before merging.

## Documentation sync

When adding or removing an agent, update the agents table in `README.md` so the documented agent list stays in sync with the actual contents of `agents/`.
