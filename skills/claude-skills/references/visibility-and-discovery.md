# Skill Visibility, Permissions, and Discovery

## Controlling Skill Visibility

Skills can be invoked three ways:

1. **Manual**: User types `/skill-name` in the prompt
2. **Programmatic**: Claude calls it via the Skill tool
3. **Auto-discovery**: Claude reads the description and loads it when relevant

### Visibility Fields

| Setting                          | You can invoke | Claude can invoke | When loaded into context                                     |
| -------------------------------- | -------------- | ----------------- | ------------------------------------------------------------ |
| Default                          | Yes            | Yes               | Description always in context; full skill loads when invoked |
| `disable-model-invocation: true` | Yes            | No                | Description not in context; full skill loads when you invoke |
| `user-invocable: false`          | No             | Yes               | Description always in context; full skill loads when invoked |

**Note:** In a regular session, skill descriptions are loaded into context so
Claude knows what's available, but full skill content only loads when invoked.
Subagents with preloaded skills work differently: the full skill content is
injected at startup.

### Example: Model-Only Skill

Hide from slash menu but allow Claude to invoke programmatically:

```yaml
---
name: internal-review-standards
description: Apply internal code review standards when reviewing pull requests
user-invocable: false
---
```

### Example: User-Only Skill

Allow manual invocation but prevent Claude from calling via Skill tool:

```yaml
---
name: manual-deployment
description: Deploy to production with manual confirmation
disable-model-invocation: true
---
```

## Permission Rules for Skills

Control which skills Claude can invoke using permission rules in `/permissions`:

### Syntax

```text
# Allow specific skills
Skill(commit)
Skill(review-pr *)

# Deny specific skills
Skill(deploy *)

# Disable all skills
Skill
```

- `Skill(name)`: Exact match for a specific skill
- `Skill(name *)`: Prefix match with any arguments
- `Skill`: Matches all skills (useful in deny rules)

### Notes

- `allowed-tools` in skill frontmatter grants tool access without per-use
  approval when the skill is active, but your permission settings still govern
  baseline behavior for all other tools
- `user-invocable` only controls menu visibility, **not** Skill tool access.
  Use `disable-model-invocation: true` to block programmatic invocation
- Built-in commands like `/compact` and `/init` are not available through the
  Skill tool

## Skill Precedence & Discovery

### Scope Priority

When multiple skills exist across different scopes:

1. **Enterprise** skills take highest precedence
2. **Personal** skills (in `~/.claude/skills/`) override project skills
3. **Project** skills (in `.claude/skills/`) are the default scope

**Plugin skills** use a namespaced format (`plugin-name:skill-name`) and don't
conflict with personal or project skills.

If a skill and a built-in command share the same name, the **skill takes
precedence**.

### Nested & Monorepo Discovery

Claude Code automatically discovers skills from nested `.claude/skills/`
directories when working with files in subdirectories. For example, editing a
file in `packages/frontend/` also loads skills from
`packages/frontend/.claude/skills/`.

### Additional Directories

Skills in `.claude/skills/` within directories added via `--add-dir` are loaded
automatically and picked up by live change detection.

## Description Character Budget

Skill descriptions share a character budget (1% of the context window, with a
fallback of **8,000 characters**). Each entry is capped at **250 characters**,
so front-load the key use case. If you have many skills, some descriptions may
be truncated or omitted from context. To diagnose:

1. Run `/context` to check which skills are loaded
2. Keep descriptions concise (under 250 characters for the key use case)
3. Increase the budget via the `SLASH_COMMAND_TOOL_CHAR_BUDGET` environment
   variable if needed

## Commands Migration

Custom commands (`.claude/commands/`) have been **merged into skills**. A file at
`.claude/commands/review.md` and a skill at `.claude/skills/review/SKILL.md` both
create `/review` and work the same way. Existing `.claude/commands/` files
continue to work and support the same frontmatter. Skills are recommended since
they support additional features like supporting files, `context: fork`, and
hooks.

If a skill and a command share the same name, the **skill takes precedence**.

## Bundled Skills

Claude Code ships with built-in skills available in every session:

- **`/simplify [focus]`**: Reviews recently changed files for code reuse,
  quality, and efficiency, then fixes issues. Spawns three parallel review
  agents. Pass text to focus: `/simplify focus on memory efficiency`
- **`/batch <instruction>`**: Orchestrates large-scale changes across a
  codebase. Decomposes work into 5-30 independent units, spawns one agent per
  unit in isolated git worktrees, each opening a PR.
- **`/debug [description]`**: Troubleshoots the current Claude Code session by
  reading the session debug log.
- **`/claude-api`**: Loads Claude API reference material for your project's
  language. Also activates automatically when code imports the Anthropic SDK.
- **`/loop [interval] <prompt>`**: Runs a prompt repeatedly on an interval.
  Useful for polling deployments or periodic checks.

## Types of Skill Content

Skills generally contain one of two types:

- **Reference content**: Knowledge that Claude applies to current work (coding
  conventions, architectural patterns, API reference). Runs inline, augments
  understanding.
- **Task content**: Step-by-step instructions for specific actions (deployment
  workflows, commit procedures). Often paired with
  `disable-model-invocation: true`.

Many skills combine both types. Reference material works best as background
context, while task instructions benefit from explicit invocation.
