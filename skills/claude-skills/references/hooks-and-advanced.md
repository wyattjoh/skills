# Hooks, Dynamic Injection, and Advanced Patterns

## Skill-Scoped Hooks

Skills can define hooks that run during the skill's lifecycle using the `hooks`
frontmatter field. These hooks are automatically cleaned up when the skill
finishes.

### Supported Events (Skill-Scoped)

The core tool-lifecycle events always work in skill frontmatter:

- `PreToolUse`: Before Claude uses any tool
- `PostToolUse`: After Claude successfully uses a tool
- `Stop`: When Claude attempts to stop

The official hooks reference also shows `SessionStart` used in skill
frontmatter (paired with `once: true` to run setup exactly once), so skills
can hook into broader session lifecycle events. If you need an event beyond
`PreToolUse`/`PostToolUse`/`Stop`/`SessionStart`, check the
[official hooks reference](https://code.claude.com/docs/en/hooks.md)
for the full list and confirm it's supported in skill frontmatter before
relying on it. Project-level hooks in `settings.json` support the complete
set of events including `InstructionsLoaded`, `CwdChanged`, `FileChanged`,
`PreCompact`/`PostCompact`, and the `Permission*` family.

Regardless of event, skill-scoped hooks are automatically cleaned up when
the skill finishes.

### Hook Configuration Example

```yaml
---
name: secure-operations
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/security-check.sh $TOOL_INPUT"
          once: true
  PostToolUse:
    - matcher: "Write|Edit"
      hooks:
        - type: command
          command: "./scripts/format-code.sh"
---
```

### Hook Handler Types

**Command hooks** run a shell command:

```yaml
- type: command
  command: "./scripts/validate.sh"
  timeout: 30 # seconds, default 600
```

**HTTP hooks** send a POST request to an endpoint:

```yaml
- type: http
  url: "https://example.com/hook"
  timeout: 30 # seconds
```

**Prompt hooks** evaluate with an LLM:

```yaml
- type: prompt
  prompt: "Review this tool call for safety: $ARGUMENTS"
  model: claude-haiku-4-5-20251001 # optional, defaults to fast model
  timeout: 30 # seconds, default 30
```

**Agent hooks** run an agentic verifier:

```yaml
- type: agent
  prompt: "Verify the output meets quality standards: $ARGUMENTS"
  timeout: 60 # seconds, default 60
```

### Hook Options

- `once: true`: Run only once per session, then remove
- `matcher`: Regex pattern to match tool names (e.g., `"Bash"`, `"Write|Edit"`)
- `if`: Permission rule syntax filter (e.g., `Bash(git *)`) to control when the
  hook fires, reducing process spawning overhead
- `async: true`: Run command hooks in the background without blocking
- `statusMessage`: Custom spinner message during execution

## Dynamic Context Injection

Use the exclamation-backtick syntax to run shell commands before skill content
is sent to Claude. The command's output replaces the placeholder inline.

> The dynamic injection syntax cannot be shown literally in this file because
> it would trigger auto-execution. The syntax is: an exclamation mark ("!")
> immediately followed by a backtick-wrapped command (like `` `command` ``),
> with no space between them.

### Syntax

```
Format: ! + ` + command + `
(Write as a single unit without spaces)
```

### Example: PR Summary Skill

```markdown
---
name: pr-summary
description: Summarizes the current PR diff.
disable-model-invocation: true
---

# PR Summary

Review and summarize the following diff:

[Dynamic injection: gh pr diff]
```

Replace `[Dynamic injection: gh pr diff]` with the actual syntax (exclamation
mark + backtick-wrapped command). When invoked, `gh pr diff` runs first and its
output is embedded into the skill content Claude receives.

This is powerful for skills that need live data (git status, file listings, API
responses) at invocation time. The commands are preprocessing, not something
Claude executes.

### Multi-Line Block Form

For commands that span multiple lines (or multiple commands whose output you
want combined), use a fenced code block opened with the language tag `!`
instead of the inline form:

````
## Environment
```!
node --version
npm --version
git status --short
```
````

Each line inside the block is run, and the combined stdout replaces the block
in the skill content Claude receives. Use this form whenever a single inline
command would be too awkward to read.

### Disabling Inline Shell Execution

Set `"disableSkillShellExecution": true` in `settings.json` to disable the `!`
inline form and ` ```! ` block form in skills, custom slash commands, and
plugin commands from user, project, plugin, or additional-directory sources.
Each command is replaced with `[shell command execution disabled by policy]`
instead of being executed. Bundled and managed skills are unaffected.

This is most useful as a **managed setting** in enterprise environments, where
users cannot override it. For individual use, prefer carefully auditing
untrusted skills over blanket disabling.

## Running Skills in Forked Context

Use `context: fork` to run a skill in an isolated sub-agent context with its own
conversation history.

```yaml
---
name: code-analysis
description: Analyze code quality and generate detailed reports
context: fork
agent: Explore
---
```

### When to Use Forked Context

- Complex analysis that generates verbose output
- Multi-step operations that need isolation
- Tasks that benefit from a fresh conversation context

### Agent Selection

When using `context: fork`, the `agent` field determines the execution
environment:

- `Explore`: Fast agent for codebase exploration (read-only tools, Haiku model)
- `Plan`: Software architect for planning (read-only tools, inherited model)
- `general-purpose`: Default multi-purpose agent (all tools, inherited model)
- Custom agent name from `.claude/agents/`

### Skills and Subagents Interaction

| Approach                     | System prompt            | Task                        | Also loads                   |
| ---------------------------- | ------------------------ | --------------------------- | ---------------------------- |
| Skill with `context: fork`   | From agent type          | SKILL.md content            | CLAUDE.md                    |
| Subagent with `skills` field | Subagent's markdown body | Claude's delegation message | Preloaded skills + CLAUDE.md |

## String Substitutions

Skills can use dynamic string substitutions replaced at runtime. These work in
both the skill body and in hook commands.

| Variable               | Description                                                |
| ---------------------- | ---------------------------------------------------------- |
| `$ARGUMENTS`           | All arguments passed when invoking via `/skill-name args`  |
| `$ARGUMENTS[N]`        | Specific argument by 0-based index (e.g., `$ARGUMENTS[0]`) |
| `$N`                   | Shorthand for `$ARGUMENTS[N]` (e.g., `$0`, `$1`)           |
| `${CLAUDE_SESSION_ID}` | Current session ID for logging/correlation                 |
| `${CLAUDE_SKILL_DIR}`  | Directory containing the skill's SKILL.md file             |

### `${CLAUDE_SKILL_DIR}` Details

The directory containing the skill's `SKILL.md` file. For plugin skills, this
resolves to the skill's subdirectory within the plugin, not the plugin root.
Use this in bash injection commands to reference scripts or files bundled with
the skill, regardless of the current working directory.

```yaml
hooks:
  PostToolUse:
    - matcher: "Write"
      hooks:
        - type: command
          command: "${CLAUDE_SKILL_DIR}/scripts/format.sh"
```

### Usage Examples

**Passing arguments to a script:**

```markdown
Run with: `/analyze-code <directory>`

The skill will analyze the directory at: `$ARGUMENTS`
```

**Accessing individual arguments:**

```markdown
Run with: `/deploy <environment> <version>`

Deploy version `$1` to `$0` environment.
```

**If `$ARGUMENTS` is not present in the content**, arguments are appended as
`ARGUMENTS: <value>` automatically.

## Extended Thinking

Include the word "ultrathink" anywhere in your skill content to activate
extended thinking mode for complex reasoning tasks.
