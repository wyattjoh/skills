---
name: claude-skills
description: Provides comprehensive guidance on Claude Code skill authoring. Triggers on "create a skill", "build a skill", "make a new skill", "develop a skill", "write a skill", "enhance a skill", "improve this skill", "refine skill description", "add trigger phrases", "fix skill frontmatter", "update SKILL.md", or works with any files matching skills/*/SKILL.md. Fetches official documentation for up-to-date best practices. PROACTIVE.
allowed-tools: WebFetch, WebSearch, Read, Write, Edit, Glob, Grep, Bash(ls:*)
argument-hint: "[skill-name]"
---

# Developing Claude Code Skills

Guide for creating, enhancing, and maintaining Claude Code skills with
up-to-date best practices from official documentation.

> **Note:** Claude Code skills follow the
> [Agent Skills open standard](https://agentskills.io), which works across
> multiple AI coding tools.

## Frontmatter Review (Required Behavior)

**When creating or modifying any skill, you MUST review the full set of
available frontmatter fields (see [references/frontmatter-reference.md](references/frontmatter-reference.md))
and proactively suggest fields that would be valuable for the skill.**

For each suggested field, present:

1. **Which field** and why it's relevant to this specific skill
2. **Concrete configuration options** with specific proposed values
3. **Trade-offs** of enabling/disabling the field

Use the `AskUserQuestion` tool to present frontmatter suggestions when
multiple fields could be valuable. Group related fields together (e.g.,
`context`/`agent` are a natural pair; `disable-model-invocation`/`user-invocable`
control visibility).

**Do not silently skip fields.** Common fields to consider for every skill:

- `allowed-tools` -- should this skill restrict tool access?
- `argument-hint` -- does this skill accept arguments?
- `disable-model-invocation` -- does this skill have side effects?
- `context: fork` -- would this skill benefit from running in isolation?
- `effort` -- does this skill need deeper reasoning (`high`/`max`)?

## When to Fetch Documentation

**ALWAYS fetch fresh documentation when:**

- Creating a new skill from scratch
- Modifying skill frontmatter fields
- Writing or improving trigger descriptions
- Uncertain about skill structure or capabilities

**Documentation sources to fetch:**

| Topic                 | URL                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------- |
| Skills Overview       | https://code.claude.com/docs/en/skills.md                                           |
| Best Practices        | https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices.md |
| Agent Skills Overview | https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview.md       |
| Sub-agents Reference  | https://code.claude.com/docs/en/sub-agents.md                                       |
| Plugins Reference     | https://code.claude.com/docs/en/plugins-reference.md                                |
| Hooks Reference       | https://code.claude.com/docs/en/hooks.md                                            |

## Workflow: Creating a New Skill

### Step 1: Fetch Current Documentation

Before creating any skill, fetch the official documentation to ensure accuracy.

```
Use WebFetch to retrieve: https://code.claude.com/docs/en/skills.md
```

### Step 2: Analyze Existing Skills

Examine existing skills in the repository for patterns:

```bash
ls skills/*/SKILL.md
```

Read a few to understand description style, content organization, tool
restrictions, and reference file usage.

### Step 3: Create Skill Structure

```
skills/
  <skill-name>/
    SKILL.md           # Required: Main skill definition
    scripts/           # Optional: Executable scripts (Bun TypeScript)
    references/        # Optional: Supporting documentation
```

**Important:** The file MUST be named exactly `SKILL.md` (case-sensitive).

### Script Runtime Defaults

Use Bun + TypeScript for executable skill scripts. Prefer Effect-TS for any
script with meaningful I/O, parsing, shell commands, branching, retries,
resource cleanup, or user-facing errors. Add `effect` to the skill's
`package.json`, define typed errors with `Data.TaggedError`, compose operations
with `Effect.gen`, wrap external promises with `Effect.tryPromise`, and run the
program only at the CLI boundary with `Effect.runPromise`.

Plain Bun functions are acceptable for tiny deterministic helpers with no
meaningful failure handling. Do not add Effect only to wrap a single pure
calculation or print statement.

When using Effect, also use the effect-ts skill and follow its critical rules.

### Step 4: Write Frontmatter

All frontmatter fields are optional. If `name` is omitted, it defaults to the
directory name. If `description` is omitted, it defaults to the first paragraph.
However, `description` is **strongly recommended**.

**Recommended fields:**

```yaml
---
name: kebab-case-skill-name
description: Extracts text from PDFs. Use when working with PDF files or when the user mentions PDFs.
---
```

**Validation rules:**

- `name`: Lowercase letters, numbers, hyphens only (max 64 chars). No XML tags.
- `description`: Max 1024 chars. No XML tags.

**All optional fields:**

```yaml
---
allowed-tools: Tool1, Tool2, Bash(command:*)
model: claude-sonnet-5
effort: high
context: fork
agent: Explore
argument-hint: "[issue-number]"
user-invocable: true
disable-model-invocation: false
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/validate.sh"
---
```

For detailed documentation of each field, see
[references/frontmatter-reference.md](references/frontmatter-reference.md).

### Step 5: Suggest Frontmatter Configuration

Before writing the skill body, review all available frontmatter fields against
the skill's purpose. Walk through the
[Frontmatter Field Reference](references/frontmatter-reference.md) and consider:

- Does the skill accept arguments? -> suggest `argument-hint`
- Does the skill have side effects? -> suggest `disable-model-invocation: true`
- Is this background knowledge? -> suggest `user-invocable: false`
- Should the skill restrict tool access? -> suggest `allowed-tools`
- Would it benefit from isolation? -> suggest `context: fork` and an `agent`
- Does it need deeper reasoning? -> suggest `effort: high` or `effort: max`
- Does it need validation hooks? -> suggest `hooks`

Present suggestions using `AskUserQuestion` with concrete proposed values.

### Step 6: Write Skill Body

Structure with clear sections. **Do not include a "When to Use" section** --
activation conditions belong in the `description` frontmatter field.

```markdown
# Skill Title

Brief overview of what this skill provides.

## Quick Start

3-5 step workflow for the most common use case.

## Detailed Guidance

### Workflow A

...

## Best Practices

Key recommendations and patterns.

## References

Point to reference files for detailed documentation.
```

**Key principle: Be concise.** Claude is already very smart. Only add context
Claude doesn't already have. Challenge each piece of information: "Does Claude
really need this explanation?" Keep SKILL.md under 500 lines; move detailed
content to `references/`.

### Step 7: Validate the Skill

- [ ] File is named exactly `SKILL.md`
- [ ] YAML frontmatter is valid (proper quoting, no tabs)
- [ ] Name uses kebab-case
- [ ] Description contains specific trigger phrases in quotes
- [ ] Description explains when to use (not just what it does)
- [ ] Body follows progressive disclosure (overview to details)
- [ ] Under 500 lines for optimal performance
- [ ] File references are one level deep (no chains)

## Workflow: Enhancing an Existing Skill

### Step 1: Read the Current Skill

Use the Read tool to read `skills/<name>/SKILL.md` and understand its state.

### Step 2: Identify Enhancement Type

- **Descriptions**: Add specific trigger phrases, common user phrasings, keywords
- **Content**: Add workflows, examples, error handling guidance
- **References**: Create `references/` subdirectory for detailed docs

### Step 3: Audit Frontmatter Fields

Review existing frontmatter against the full
[Frontmatter Field Reference](references/frontmatter-reference.md). Identify
missing but valuable fields, present suggestions with concrete proposed values.

### Step 4: Make Changes

Apply edits while preserving existing trigger phrases, working patterns, and
user-reported effective guidance.

## Naming Skills

**Recommended conventions:**

- **Gerund form (preferred):** `processing-pdfs`, `analyzing-spreadsheets`
- **Noun phrases:** `pdf-processing`, `code-analysis`
- **Action-oriented:** `process-pdfs`, `analyze-code`

**Avoid:** Vague names (`helper`, `utils`), overly generic (`documents`, `data`),
reserved words in published skills (`anthropic`, `claude`).

## Writing Effective Descriptions

The `description` field determines when skills auto-activate.

### Description Style

Write in **third person**. The description is injected into the system prompt,
and inconsistent point-of-view causes discovery problems.

**Good patterns:**

```yaml
description: Extracts text from PDFs. Use when working with PDF files or when the user mentions PDFs.
```

```yaml
description: Provides patterns for React development. Triggers on "create a React component", "build a form", "implement hooks", or mentions "useState", "useEffect".
```

**Avoid:** `"This skill should be used when..."` (verbose), `"I can help..."` (first-person), `"You can use this to..."` (second-person directed at model).

### Description Components

1. **Purpose statement**: What the skill does (lead with this)
2. **Action phrases** (in quotes): Common ways users request this
3. **Keywords** (in quotes): Technical terms that indicate relevance

## String Substitutions

| Variable               | Description                                      |
| ---------------------- | ------------------------------------------------ |
| `$ARGUMENTS`           | All arguments passed via `/skill-name args`      |
| `$ARGUMENTS[N]`        | Specific argument by 0-based index               |
| `$N`                   | Shorthand for `$ARGUMENTS[N]` (e.g., `$0`, `$1`) |
| `${CLAUDE_SESSION_ID}` | Current session ID for logging/correlation       |
| `${CLAUDE_SKILL_DIR}`  | Directory containing the skill's SKILL.md file   |

If `$ARGUMENTS` is not present in the content, arguments are appended as
`ARGUMENTS: <value>` automatically.

`${CLAUDE_SKILL_DIR}` is especially useful in hook commands and dynamic injection
to reference scripts bundled with the skill regardless of working directory:

```yaml
hooks:
  PostToolUse:
    - matcher: "Write"
      hooks:
        - type: command
          command: "${CLAUDE_SKILL_DIR}/scripts/format.sh"
```

## Quick Reference: File Requirements

| Requirement | Details                                     |
| ----------- | ------------------------------------------- |
| Filename    | Must be exactly `SKILL.md` (case-sensitive) |
| Location    | `skills/<name>/SKILL.md`                    |
| Max size    | Under 500 lines recommended                 |
| Frontmatter | Valid YAML with `---` delimiters            |

## Troubleshooting

### Skill Not Activating

1. Check description contains specific trigger phrases
2. Verify phrases match what users actually say
3. Add more keyword mentions
4. Test by explicitly mentioning trigger phrases

### YAML Errors

1. Ensure quotes around description (especially with colons)
2. No tabs, use spaces only
3. Check for unescaped special characters

### Skill Too Long

1. Move detailed content to `references/`
2. Keep SKILL.md focused on workflows
3. Use progressive disclosure (overview first, details later)

### Claude Doesn't See All Skills

Skill descriptions share a character budget (1% of context window, fallback of
**8,000 characters**). Each entry (`description` + `when_to_use`) is capped at
**1,536 characters**. Run
`/context` to check. Increase via `SLASH_COMMAND_TOOL_CHAR_BUDGET` environment
variable.

## References

- **Frontmatter field reference**: [references/frontmatter-reference.md](references/frontmatter-reference.md)
- **Best practices and anti-patterns**: [references/best-practices.md](references/best-practices.md)
- **Hooks, dynamic injection, and advanced**: [references/hooks-and-advanced.md](references/hooks-and-advanced.md)
- **Visibility, permissions, and discovery**: [references/visibility-and-discovery.md](references/visibility-and-discovery.md)

## Best Practices

1. **Fetch documentation first** -- Always get current official docs before
   creating or modifying skills
2. **Be concise** -- Only add context Claude doesn't already have
3. **Use specific triggers** -- "create a React component" beats "React help"
4. **Mirror existing patterns** -- Read other skills before creating new ones
5. **Progressive disclosure** -- Overview first, details in reference files
6. **Keep it focused** -- One skill per domain
7. **Test activation** -- Verify the skill triggers on expected phrases
8. **Match freedom to fragility** -- Exact steps for fragile ops, general
   guidance for flexible tasks
9. **Update descriptions iteratively** -- Add trigger phrases as you discover
   how users ask for help
10. **Enable extended thinking** -- Include "ultrathink" in skill content for
    complex reasoning tasks
