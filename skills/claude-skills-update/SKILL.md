---
name: claude-skills-update
description: |
  Checks for updates to Claude Code skill authoring APIs and best practices, then proposes changes to the claude-skills skill. Triggers on "update claude-skills", "sync skill docs", "check for skill API changes", "are my skills up to date", "claude-skills outdated", "refresh skill documentation".
disable-model-invocation: true
user-invocable: true
effort: high
allowed-tools: WebFetch, WebSearch, Read, Edit, Glob, Grep, Bash(ls:*), AskUserQuestion
---

# Update claude-skills Skill

Periodic maintenance workflow that checks upstream Claude Code documentation and
release notes for changes to skill authoring APIs, then proposes updates to the
`claude-skills` skill and its reference files.

## Quick Start

1. Read current state (claude-skills + changelog)
2. Fetch upstream documentation and release notes
3. Search for community insights
4. Compare and present a structured report
5. Propose edits grouped by file, wait for approval
6. Update the changelog

## Phase 1: Read Current State

Read all of the following files to build an understanding of what the
`claude-skills` skill currently documents:

- `skills/claude-skills/SKILL.md`
- `skills/claude-skills/references/frontmatter-reference.md`
- `skills/claude-skills/references/best-practices.md`
- `skills/claude-skills/references/hooks-and-advanced.md`
- `skills/claude-skills/references/visibility-and-discovery.md`

Then read `${CLAUDE_SKILL_DIR}/references/changelog.md` to determine the
last sync date. If no prior syncs exist, treat everything as potentially new.

## Phase 2: Fetch Upstream Sources

### Tier 1: Official Documentation

Fetch each of these URLs using `WebFetch`:

| Source                | URL                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------- |
| Skills Overview       | `https://code.claude.com/docs/en/skills.md`                                           |
| Best Practices        | `https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices.md` |
| Agent Skills Overview | `https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview.md`       |
| Sub-agents Reference  | `https://code.claude.com/docs/en/sub-agents.md`                                       |
| Plugins Reference     | `https://code.claude.com/docs/en/plugins-reference.md`                                |
| Hooks Reference       | `https://code.claude.com/docs/en/hooks.md`                                            |

For each fetch, extract the full content. Focus on: frontmatter fields, API
changes, new features, deprecations, and best practice updates.

### Tier 2: GitHub Release Notes

Fetch release notes from `https://github.com/anthropics/claude-code/releases`.
Focus on releases since the last sync date from the changelog. Extract any
changes related to skills, agents, hooks, plugins, or frontmatter.

### Tier 3: Community Insights

Run 2-3 web searches using `WebSearch`:

- "Claude Code skills best practices" (current year)
- "Claude Code skill authoring tips"
- "Claude Code SKILL.md guide"

Any findings NOT from official Anthropic sources (`anthropic.com`,
`code.claude.com`, `platform.claude.com`, `github.com/anthropics`) must be
tagged as **community suggestion** in the report.

## Phase 3: Compare and Analyze

Compare fetched content against the current `claude-skills` skill files.
Categorize findings into:

- **New**: Features, fields, or APIs documented upstream but missing from the
  current skill
- **Changed**: Content in the current skill that contradicts or is outdated
  relative to upstream
- **Deprecated**: Content in the current skill that references removed or
  deprecated features
- **Community**: Suggestions from non-official sources (lower confidence)

## Phase 4: Present Report

Present findings in this structured format:

```
## Sync Report: claude-skills-update (YYYY-MM-DD)

### New (not in current skill)
- [item]: [source URL]

### Changed (current skill is outdated)
- [what changed]: [current state] -> [upstream state]

### Deprecated (current skill references something removed)
- [item]: [deprecation note]

### Community Suggestions
- [suggestion]: [source] (unverified)

### No Changes
- [areas that are already up to date]
```

If there are no findings in a category, note "None" under that heading.

## Phase 5: Propose Edits

For each actionable item (New, Changed, Deprecated), propose a specific edit:

1. State which file would be modified
2. Show the proposed change (old content vs new content)
3. Cite the upstream source

Group edits by target file:

- All `SKILL.md` changes together
- All `frontmatter-reference.md` changes together
- All `best-practices.md` changes together
- etc.

Use `AskUserQuestion` to get approval for each file's group of changes before
applying them with the `Edit` tool.

## Phase 6: Update Changelog

After all edits are applied (or declined), prepend an entry to
`${CLAUDE_SKILL_DIR}/references/changelog.md` with this format:

```markdown
## YYYY-MM-DD

- **Sources checked:** [list of URLs fetched and GitHub release range]
- **Changes applied:** [summary of edits made, or "None"]
- **Community suggestions reviewed:** N (M accepted, K skipped)
- **No changes needed:** [list of files/areas that were already current]
```

Always record an entry, even if no changes were applied. This tracks what was
reviewed and when.

## Phase 7: Optional Broader Scan

After the primary update is complete, ask:

> "Primary update complete. Want me to scan the other skills in this toolkit for
> outdated Claude Code references?"

If the user accepts:

1. Use `Grep` to search `skills/*/SKILL.md` and `skills/*/references/*.md` for:
   - Claude Code documentation URLs (check if they still resolve)
   - Frontmatter field names that were deprecated upstream
   - API patterns or tool names that changed
2. Cross-reference matches against what was learned in Phase 2
3. Present a secondary report grouped by skill name, following the same format
   as Phase 4

If the user declines, skip this phase.
