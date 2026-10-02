# Codex skills

Codex reads the same `SKILL.md` format as Claude Code. This file covers what differs. Source: [Codex skill docs](https://developers.openai.com/codex/skills).

## Requirements and loading

- `SKILL.md` must include `name` and `description`. Codex ignores Claude Code-only fields.
- At session start Codex lists each skill's name, description, and file path, capped at 2% of the context window (8,000 characters when the window is unknown). With many skills installed it shortens descriptions first and may drop skills from the list, so front-load the description's first clause.
- Codex detects skill edits automatically; restart it if a change does not appear.

## Locations

Codex scans `.agents/skills` in every directory from the working directory up to the repository root, then `$HOME/.agents/skills`, then `/etc/codex/skills` and system skills. Two skills with the same `name` are not merged; both appear.

To serve one checkout to both harnesses, point `.agents/skills` at `.claude/skills` with a symlink, as this repository does.

## Invocation

- **Explicit**: the user types `$skill-name` or picks it from `/skills`.
- **Implicit**: Codex selects a skill whose `description` matches the task.

## `agents/openai.yaml`

An optional file beside `SKILL.md` that holds Codex UI metadata, invocation policy, and tool dependencies:

```yaml
interface:
  display_name: "Setup Alchemy"
  short_description: "Bootstrap Alchemy CI deploys"
  default_prompt: "Optional prompt to start the skill with"

policy:
  allow_implicit_invocation: false

dependencies:
  tools:
    - type: "mcp"
      value: "openaiDeveloperDocs"
      description: "OpenAI Docs MCP server"
      transport: "streamable_http"
      url: "https://developers.openai.com/mcp"
```

`interface` also accepts `icon_small`, `icon_large`, and `brand_color`. `allow_implicit_invocation` defaults to `true`; `false` leaves only explicit `$skill` invocation.

## Mapping from Claude Code

| Intent                  | Claude Code (`SKILL.md` frontmatter) | Codex (`agents/openai.yaml`)              |
| ----------------------- | ------------------------------------ | ----------------------------------------- |
| Only the human can run  | `disable-model-invocation: true`     | `policy.allow_implicit_invocation: false` |
| Picker label            | `name`                               | `interface.display_name`                  |
| Short human description | `description` (when user-invoked)    | `interface.short_description`             |
| Hide from human menu    | `user-invocable: false`              | No equivalent                             |
| Declared tool needs     | `allowed-tools` (pre-approval only)  | `dependencies.tools`                      |

Keep a user-invoked skill user-invoked in both harnesses: when a skill sets `disable-model-invocation: true`, give it an `agents/openai.yaml` with `allow_implicit_invocation: false`.
