# Frontmatter Field Reference

All frontmatter fields are optional. Only `description` is strongly recommended.

Boolean fields (`disable-model-invocation`, `user-invocable`, `background`)
accept `yes`, `no`, `on`, `off`, `1`, and `0` in any letter case, in addition
to `true`/`false` (Claude Code v2.1.218+).

## `name`

- **Type:** `string`
- **Required:** No
- **Default:** Directory name (e.g., `skills/my-skill/` -> `my-skill`)

Display name and slash-command identifier for the skill. Must use lowercase
letters, numbers, and hyphens only. Maximum 64 characters. Cannot contain XML
tags or reserved words ("anthropic", "claude") in published/marketplace skills.

```yaml
name: my-skill-name
```

## `description`

- **Type:** `string`
- **Required:** No (strongly recommended)
- **Default:** First paragraph of the skill's markdown body

What the skill does and when to use it. Claude uses this to decide when to
auto-load the skill. Maximum 1024 characters. Cannot contain XML tags. Write in
third person, lead with purpose, then list trigger phrases.

The description is injected into the system prompt, so inconsistent
point-of-view can cause discovery problems. Always write in third person.

**Important:** The combined `description` + `when_to_use` text is truncated at
1,536 characters in the skill listing. Front-load the key use case so Claude
can still match your skill even when truncated.

```yaml
description: Extracts text from PDFs. Use when working with PDF files or when the user mentions "convert PDF", "read PDF", or "parse document".
```

## `when_to_use`

- **Type:** `string`
- **Required:** No
- **Default:** None

Additional context for when Claude should invoke the skill, such as trigger
phrases or example requests. Appended to `description` in the skill listing
and counts toward the same 1,536-character cap.

```yaml
when_to_use: Also trigger on "OCR a scanned document" or "extract tables from PDF".
```

## `allowed-tools`

- **Type:** `string` (space-separated) or `list`
- **Required:** No
- **Default:** All tools available to the parent session

Grants the listed tools without a permission prompt during the turn that
invokes this skill; the grant clears when you send your next message. It does
**not** restrict which tools are available — every tool remains callable, and
your permission settings still govern tools not listed. Supports Bash command
patterns with glob syntax (e.g., `Bash(git:*)` allows any git command). To
actually remove tools from the pool while the skill is active, use
[`disallowed-tools`](#disallowed-tools) instead.

The official Claude Code docs document a **space-separated** string format.
Comma-separated strings also work in practice. The **YAML list** form is the
clearest and is recommended when you have more than two or three tools, since
it avoids any ambiguity about how the parser splits on spaces or commas.

```yaml
# Space-separated (official format)
allowed-tools: Read Grep Glob Bash(git:*)

# Comma-separated (also works)
allowed-tools: Read, Grep, Glob, Bash(git:*)

# YAML list (recommended for clarity)
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(git:*)
```

### Common Tool Sets

**Read-only skills:**

```yaml
allowed-tools: Read, Grep, Glob
```

**Git-focused skills:**

```yaml
allowed-tools: Bash(git:*), Read, Grep
```

**Development skills:**

```yaml
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(npm:*), Bash(pnpm:*), Bash(bun:*)
```

## `disallowed-tools`

- **Type:** `string` (space-separated) or `list`
- **Required:** No
- **Default:** None

Removes the listed tools from Claude's available pool while this skill is
active; the restriction clears when you send your next message. Use for
autonomous skills that should never call certain tools, e.g. `AskUserQuestion`
in a background loop. Like deny rules, it can't remove `EndConversation` while
any other tool remains.

```yaml
disallowed-tools: AskUserQuestion
```

## `argument-hint`

- **Type:** `string`
- **Required:** No
- **Default:** None

Hint shown in the autocomplete menu to indicate what arguments the skill
expects. Displayed after the skill name in the `/` menu. Use square brackets
for placeholders.

```yaml
argument-hint: "[issue-number]"
# or
argument-hint: "[filename] [format]"
```

## `arguments`

- **Type:** `string` (space-separated) or `list`
- **Required:** No
- **Default:** None

Named positional arguments for `$name` substitution in the skill content.
Names map to argument positions in order, so with `arguments: [issue, branch]`
the placeholder `$issue` expands to the first argument and `$branch` to the
second.

```yaml
arguments: [issue, branch]
```

## `disable-model-invocation`

- **Type:** `boolean`
- **Required:** No
- **Default:** `false`

When `true`, prevents Claude from automatically loading or invoking this skill
via the Skill tool. The skill is only available via manual `/name` invocation
by the user. The skill's description is also removed from Claude's context
entirely. Also prevents the skill from being preloaded into subagents, and
(as of v2.1.196) from running when a scheduled task fires with the skill as
its prompt. Use for workflows with side effects (deploy, commit, send
messages).

```yaml
disable-model-invocation: true
```

## `user-invocable`

- **Type:** `boolean`
- **Required:** No
- **Default:** `true`

When `false`, hides the skill from the `/` slash menu so users cannot invoke it
directly. Claude can still invoke it programmatically via the Skill tool. Use
for background knowledge that isn't meaningful as a user command.

```yaml
user-invocable: false
```

## `model`

- **Type:** `string`
- **Required:** No
- **Default:** Inherited from parent session

Override the model used for the rest of the current turn while this skill is
active (not saved to settings; the session model resumes on the next prompt).
Accepts the same values as `/model`, or `inherit` to keep the active model.
With `context: fork`, this sets the forked subagent's model instead. Model IDs
change with releases. Check the official documentation for current values.

```yaml
model: claude-sonnet-4-6
```

## `effort`

- **Type:** `string`
- **Required:** No
- **Default:** Inherited from session
- **Options:** `low`, `medium`, `high`, `xhigh`, `max` (available levels depend
  on the model)

Override the effort level when this skill is active. Higher effort means more
thorough reasoning. Use `high`, `xhigh`, or `max` for complex authoring or
analysis tasks. Use `low` for simple lookups or formatting tasks.

```yaml
effort: high
```

## `context`

- **Type:** `string`
- **Required:** No
- **Default:** None (runs inline in main conversation)

Set to `fork` to run the skill in an isolated sub-agent context with its own
conversation history. The skill content becomes the prompt that drives the
sub-agent. The sub-agent will not have access to the main conversation history
or CLAUDE.md, except when the agent is `Explore` or `Plan`, which always skip
CLAUDE.md. Only makes sense for skills with explicit task instructions, not
passive reference content.

A forked skill runs in the **background** by default (Claude Code
v2.1.218+): the invoking turn continues, and the result arrives later. Set
`background: false` to block the turn until it finishes instead (see
[`background`](#background) below). Before v2.1.218, forked skills always
blocked the turn.

```yaml
context: fork
```

**Warning:** `context: fork` only makes sense for skills with explicit
instructions. If your skill contains guidelines without a task, the subagent
receives the guidelines but no actionable prompt, and returns without meaningful
output.

## `background`

- **Type:** `boolean`
- **Required:** No
- **Default:** `true`

Only applies with `context: fork`. Set to `false` to wait for the forked
subagent's result in the turn that invoked the skill, instead of running it in
the background. Requires Claude Code v2.1.218+. Claude Code also waits for the
result regardless of this setting in non-interactive mode (`-p`/Agent SDK),
when `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, when an earlier invocation of
the same forked skill is still running, or when a scheduled task fires the
skill as its prompt.

```yaml
context: fork
background: false
```

## `agent`

- **Type:** `string`
- **Required:** No
- **Default:** `general-purpose`

Specifies which sub-agent type to use when `context: fork` is set. Has no
effect without `context: fork`. Options include built-in agents (`Explore`,
`Plan`, `general-purpose`) or any custom sub-agent name defined in
`.claude/agents/`.

```yaml
context: fork
agent: Explore
```

## `hooks`

- **Type:** `object`
- **Required:** No
- **Default:** None

Skill-scoped lifecycle hooks that run during the skill's execution. Hooks are
automatically cleaned up when the skill finishes. All hook events are
supported in skill frontmatter (not just `PreToolUse`/`PostToolUse`/`Stop`) —
see [hooks-and-advanced.md](hooks-and-advanced.md) for the full event list and
handler types (`command`, `http`, `mcp_tool`, `prompt`, `agent`). Each event
contains an array of matcher/hook pairs.

```yaml
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/validate.sh $TOOL_INPUT"
          once: true # Run only once per session
  PostToolUse:
    - matcher: "Write|Edit"
      hooks:
        - type: command
          command: "./scripts/format-code.sh"
  Stop:
    - hooks:
        - type: command
          command: "./scripts/cleanup.sh"
```

### Hook Options

- `once: true`: Run the hook only once per session. After the first successful
  execution, the hook is removed.
- `matcher`: Regex pattern to match tool names (e.g., `"Bash"`, `"Write|Edit"`)
- `type`: Hook type (`command`, `http`, `mcp_tool`, `prompt`, or `agent`)
- `timeout`: Seconds before the hook times out (defaults: 600 for command, 30
  for prompt, 60 for agent)
- `statusMessage`: Custom spinner message shown during hook execution

## `paths`

- **Type:** `string` (comma-separated) or `list`
- **Required:** No
- **Default:** None (skill activates regardless of file context)

Glob patterns that limit when this skill auto-activates. When set, Claude loads
the skill only when working with files matching the patterns. Uses the same
format as path-specific rules.

```yaml
# Comma-separated
paths: src/api/**/*.ts, src/api/**/*.test.ts

# YAML list
paths:
  - src/api/**/*.ts
  - src/api/**/*.test.ts
```

## `shell`

- **Type:** `string`
- **Required:** No
- **Default:** `bash`
- **Options:** `bash`, `powershell`

Shell to use for inline shell commands in this skill. Setting `powershell` runs
commands via PowerShell on Windows. Requires
`CLAUDE_CODE_USE_POWERSHELL_TOOL=1`.

```yaml
shell: powershell
```

## `metadata`

- **Type:** `object` (free-form map)
- **Required:** No
- **Default:** None

Free-form key-value data for your own tooling (e.g. entitlement or catalog
fields) to read from `SKILL.md`. Claude Code doesn't act on its contents, and
drops a value that isn't a map. Don't reuse other frontmatter field names
(e.g. `paths`) as keys.

```yaml
metadata:
  team: platform
  tier: internal
```

## `license`

- **Type:** `string`
- **Required:** No
- **Default:** None

License covering the skill. Part of the [Agent Skills](https://agentskills.io)
open standard. Claude Code accepts the field but doesn't act on it.

```yaml
license: MIT
```

## `compatibility`

- **Type:** `string` (max 500 characters)
- **Required:** No
- **Default:** None

Environment requirements for the skill (intended products, system
prerequisites), as defined by the [Agent Skills](https://agentskills.io) spec.
Claude Code accepts the field but doesn't act on it.

```yaml
compatibility: Requires Node.js 20+ and the GitHub CLI.
```

## Fields outside Claude Code

Claude Code accepts every field on this page. Outside Claude Code — claude.ai
skill uploads, the Skills API, and `package_skill.py` from
[anthropics/skills](https://github.com/anthropics/skills) — only the six
fields in the [Agent Skills](https://agentskills.io) spec are allowed: `name`,
`description`, `license`, `compatibility`, `metadata`, `allowed-tools`. Any
other field (e.g. `argument-hint`) causes a hard validation error on those
paths rather than being silently ignored.
