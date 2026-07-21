# Frontmatter Field Reference

All frontmatter fields are optional. Only `description` is strongly recommended.

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

**Important:** Descriptions longer than 250 characters are truncated in the skill
listing. Front-load the key use case within the first 250 characters so Claude
can still match your skill even when truncated.

```yaml
description: Extracts text from PDFs. Use when working with PDF files or when the user mentions "convert PDF", "read PDF", or "parse document".
```

## `allowed-tools`

- **Type:** `string` (space-separated) or `list`
- **Required:** No
- **Default:** All tools available to the parent session

Restricts which tools Claude can use when this skill is active. Supports Bash
command patterns with glob syntax (e.g., `Bash(git:*)` allows any git command).

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

## `disable-model-invocation`

- **Type:** `boolean`
- **Required:** No
- **Default:** `false`

When `true`, prevents Claude from automatically loading or invoking this skill
via the Skill tool. The skill is only available via manual `/name` invocation
by the user. The skill's description is also removed from Claude's context
entirely. Use for workflows with side effects (deploy, commit, send messages).

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

Override the model used when this skill is active. Model IDs change with
releases. Check the official documentation for current values.

```yaml
model: claude-sonnet-4-6
```

## `effort`

- **Type:** `string`
- **Required:** No
- **Default:** Inherited from session
- **Options:** `low`, `medium`, `high`, `max` (Opus 4.6 only for `max`)

Override the effort level when this skill is active. Higher effort means more
thorough reasoning. Use `high` or `max` for complex authoring or analysis tasks.
Use `low` for simple lookups or formatting tasks.

```yaml
effort: high
```

## `context`

- **Type:** `string`
- **Required:** No
- **Default:** None (runs inline in main conversation)

Set to `fork` to run the skill in an isolated sub-agent context with its own
conversation history. The skill content becomes the prompt that drives the
sub-agent. The sub-agent will not have access to the main conversation history.
Only makes sense for skills with explicit task instructions, not passive
reference content.

```yaml
context: fork
```

**Warning:** `context: fork` only makes sense for skills with explicit
instructions. If your skill contains guidelines without a task, the subagent
receives the guidelines but no actionable prompt, and returns without meaningful
output.

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
automatically cleaned up when the skill finishes. Supports `PreToolUse`,
`PostToolUse`, and `Stop` events for skill-scoped hooks. Each event contains an
array of matcher/hook pairs. Hook types: `command` (run a shell command),
`prompt` (evaluate with LLM), or `agent` (run an agentic verifier).

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
- `type`: Hook type (`command`, `prompt`, or `agent`)
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
