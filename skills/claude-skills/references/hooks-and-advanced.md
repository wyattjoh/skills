# Hooks, Dynamic Injection, and Advanced Patterns

## Skill-Scoped Hooks

Skills can register hooks using the `hooks` frontmatter field.

### Lifetime

How long Claude Code keeps a frontmatter hook registered depends on where it
was defined:

- **Skill hooks** are registered when you or Claude invoke the skill and keep
  running **for the rest of the session**, including on turns after the skill's
  own turn. They are not removed when the skill's turn ends. To remove one after
  its first successful run, set `once: true` on it.
- **Subagent hooks** run only while that subagent is running and are removed
  when it finishes.

Workspace trust applies asymmetrically: a project **skill's** frontmatter hooks
register whenever the skill is invoked, including in a `-p` run inside a folder
you have never trusted. A project **subagent's** frontmatter hooks run only
after you accept the workspace trust dialog for the folder the agent file came
from, and a `-p` session doesn't count as accepting it (before v2.1.218 these
could run untrusted).

### Supported Events (Skill-Scoped)

**All hook events are supported** in skill and agent frontmatter — not just
the core tool-lifecycle ones. This includes `PreToolUse`, `PostToolUse`,
`Stop`, `SessionStart`, `InstructionsLoaded`, `CwdChanged`, `FileChanged`,
`PreCompact`/`PostCompact`, the `Permission*` family, and any other event in
the [official hooks reference](https://code.claude.com/docs/en/hooks.md).
`SessionStart` is commonly paired with `once: true` to run setup exactly once.

For subagents, a `Stop` hook is automatically converted to `SubagentStop`,
since that's the event that actually fires when a subagent completes.

`/hooks` opens a read-only browser showing every registered hook, its type, and
its source; hooks a skill registered appear there as `Session Hooks`.

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
  async: true # optional: run in the background without blocking
  shell: bash # optional: bash (default) or powershell
```

Command hooks also accept `args` (exec-form argument list, run without a
shell) and `asyncRewake` (run in the background and wake Claude when the
command exits with code 2).

**HTTP hooks** send a POST request to an endpoint:

```yaml
- type: http
  url: "https://example.com/hook"
  timeout: 30 # seconds
```

**MCP tool hooks** call a tool on a connected MCP server:

```yaml
- type: mcp_tool
  server: "my-mcp-server"
  tool: "validate"
  input:
    path: "$TOOL_INPUT"
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

### How Injected Commands Run

Injected commands go through the Bash tool (or the PowerShell tool when
`shell: powershell` is set and that tool is enabled), and inherit its behavior:

- **Working directory:** the session shell's current directory, which moves when
  Claude runs `cd`. Use `${CLAUDE_SKILL_DIR}` or `${CLAUDE_PROJECT_DIR}` in any
  path that must resolve the same way every time.
- **stderr:** merged into stdout under the default `bash` shell, so anything the
  command writes to stderr lands in the injected text.
- **Timeout:** the Bash tool's default 2 minutes. If the tool backgrounds the
  timed-out command the skill still renders, and the injected text names the
  background task and its output file. Otherwise the command is killed and the
  invocation aborts.
- **Output size:** output past the inline ceiling arrives as a file path plus a
  short preview rather than truncated text.
- `shell: bash` on a machine without bash (Windows without Git Bash) fails the
  invocation before any command runs.

### When an Injected Command Fails

A failed command **aborts the entire skill invocation**, not just its own
placeholder. Claude never sees the skill content for that invocation. The abort
shows `Shell command failed for pattern "..."` with the command's output under
`[stderr]`.

Under the default `bash` shell, any non-zero exit code counts as a failure. The
one carveout: exit code 1 from search and comparison commands (`grep`, `diff`,
and friends) is treated as a normal result and its output is injected. Exit
codes of 2 or higher fail even for those. **Append `|| true` to any other
command you expect to exit non-zero**, such as a check script that exits 1 when
it finds problems.

Injected commands never prompt for permission. If a command's permission check
returns anything other than allow, including a rule that would normally ask, the
invocation aborts with `Shell command permission check failed for pattern
"..."`. Pre-approve the command with `allowed-tools`; a matching ask or deny
rule still aborts regardless.

### Pre-approving a Bundled Script

`${CLAUDE_SKILL_DIR}` and `${CLAUDE_PROJECT_DIR}` are substituted in two places:
the skill body, and Bash rules in `allowed-tools`. Using the same variable in
both lets a skill run a bundled script with no permission prompt, because the
rule matches the exact command the body tells Claude to run:

```yaml
---
name: render-chart
description: Render a chart from a CSV file
allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/render.sh *)
---
Run `${CLAUDE_SKILL_DIR}/scripts/render.sh <csv-file>` to render the chart.
```

In a plugin skill, `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` work the
same way in both places.

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

As of v2.1.218, a forked skill runs in the **background** by default: the
invoking turn continues while it runs, and the result arrives when it
completes. Set `background: false` in the frontmatter to block the turn
instead. A backgrounded fork also gets the narrower tool set that applies to
background subagents, so set `background: false` if a step needs a tool
outside that set. Edits from a background fork bypass the session's
checkpoints (`/rewind` won't undo them — use git instead).

### When to Use Forked Context

- Complex analysis that generates verbose output
- Multi-step operations that need isolation
- Tasks that benefit from a fresh conversation context

### Agent Selection

When using `context: fork`, the `agent` field determines the execution
environment:

- `Explore`: Fast, read-only agent for codebase exploration. Model inherits
  from the main conversation (capped at Opus on the Claude API), not a fixed
  Haiku model — define a custom `Explore` subagent with `model: haiku` to pin
  it to a cheaper model.
- `Plan`: Software architect for planning (read-only tools, inherited model)
- `general-purpose`: Default multi-purpose agent (all tools, inherited model)
- Custom agent name from `.claude/agents/`

### Skills and Subagents Interaction

| Approach                     | System prompt            | Task                        | Also loads                                                                    |
| ---------------------------- | ------------------------ | --------------------------- | ----------------------------------------------------------------------------- |
| Skill with `context: fork`   | From agent type          | SKILL.md content            | CLAUDE.md, except when the agent is `Explore` or `Plan` (they always skip it) |
| Subagent with `skills` field | Subagent's markdown body | Claude's delegation message | Preloaded skills + CLAUDE.md                                                  |

## String Substitutions

Skills can use dynamic string substitutions replaced at runtime. These work in
both the skill body and in hook commands.

| Variable                | Description                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `$ARGUMENTS`            | All arguments passed when invoking via `/skill-name args`                                                                     |
| `$ARGUMENTS[N]`         | Specific argument by 0-based index (e.g., `$ARGUMENTS[0]`)                                                                    |
| `$N`                    | Shorthand for `$ARGUMENTS[N]` (e.g., `$0`, `$1`)                                                                              |
| `$name`                 | Named argument declared in the `arguments` frontmatter list (e.g. `arguments: [issue, branch]` → `$issue`, `$branch`)         |
| `${CLAUDE_SESSION_ID}`  | Current session ID for logging/correlation                                                                                    |
| `${CLAUDE_EFFORT}`      | Current effort level: `low`, `medium`, `high`, `xhigh`, or `max` (Ultracode reports as `xhigh`)                               |
| `${CLAUDE_SKILL_DIR}`   | Directory containing the skill's SKILL.md file                                                                                |
| `${CLAUDE_PROJECT_DIR}` | The project root directory (same path hooks and MCP servers receive as `CLAUDE_PROJECT_DIR`). Requires Claude Code v2.1.196+. |
| `${CLAUDE_PLUGIN_ROOT}` | A plugin skill's install directory. Substituted only in plugin skills.                                                        |
| `${CLAUDE_PLUGIN_DATA}` | A plugin's persistent-data directory, which survives plugin updates. Substituted only in plugin skills.                       |

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

### Argument Quoting and Escaping

- Indexed arguments use **shell-style quoting**, so wrap multi-word values in
  quotes to pass them as one argument. `/my-skill "hello world" second` makes
  `$0` expand to `hello world` and `$1` to `second`. `$ARGUMENTS` always expands
  to the full argument string as typed.
- An **indexed** placeholder with no matching argument (`$2` when only one was
  passed) stays in the content unchanged. A **named** placeholder from
  `arguments` with no matching argument expands to an empty string.
- Argument values are inserted as literal text and never re-expanded. If a skill
  body contains `Summarize $0` and you run `/summarize "$ARGUMENTS from
yesterday"`, Claude receives `Summarize $ARGUMENTS from yesterday`.
  `${CLAUDE_*}` variables are still substituted after arguments are inserted.
- To write a literal `$` before a digit, `ARGUMENTS`, or a declared argument
  name, escape it with a backslash: `\$1.00`. A backslash before any other `$`
  is left as-is, and a doubled backslash (`\\$1`) does not escape. The backslash
  escape does not apply to `${CLAUDE_*}` variables.

## Extended Thinking

Include the word "ultrathink" anywhere in your skill content to activate
extended thinking mode for complex reasoning tasks.
