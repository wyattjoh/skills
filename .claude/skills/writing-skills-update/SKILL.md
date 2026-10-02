---
name: writing-skills-update
description: Checks upstream Claude Code and Codex skill documentation and release notes for changes, then proposes updates to the writing-skills skill's harness references.
disable-model-invocation: true
user-invocable: true
effort: high
allowed-tools: WebFetch, WebSearch, Read, Edit, Glob, Grep, Bash(ls:*), AskUserQuestion
---

# Update writing-skills

Bring the harness facts in the `writing-skills` skill back in line with upstream. The writing style in `references/writing-style.md` is this collection's own guidance; change it only when upstream documents a contradicting fact (a loading or budget behaviour, for example), not to match upstream prose.

Done when every upstream change since the last sync is classified, every proposed edit has been approved or declined by the user, and the changelog has a new entry.

## Current state

Read `skills/writing-skills/SKILL.md`, every file under `skills/writing-skills/references/`, and `${CLAUDE_SKILL_DIR}/references/changelog.md`. The changelog's newest entry is the last sync date; with no entry, treat everything as new.

## Upstream sources

Official sources, fetched in full:

| Source                | URL                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------- |
| Skills Overview       | `https://code.claude.com/docs/en/skills.md`                                           |
| Best Practices        | `https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices.md` |
| Agent Skills Overview | `https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview.md`       |
| Sub-agents Reference  | `https://code.claude.com/docs/en/sub-agents.md`                                       |
| Plugins Reference     | `https://code.claude.com/docs/en/plugins-reference.md`                                |
| Hooks Reference       | `https://code.claude.com/docs/en/hooks.md`                                            |
| Codex Skills          | `https://developers.openai.com/codex/skills.md`                                       |
| Agent Skills spec     | `https://agentskills.io/specification`                                                |

Release notes since the last sync: `https://github.com/anthropics/claude-code/releases` and `https://github.com/openai/codex/releases`, filtered to skills, agents, hooks, plugins, and frontmatter.

Then run two or three web searches for current skill authoring practice. Tag every finding outside the official domains (`anthropic.com`, `code.claude.com`, `platform.claude.com`, `github.com/anthropics`, `developers.openai.com`, `github.com/openai`, `agentskills.io`) as a **community suggestion**.

## Report

Classify each finding as **New** (upstream, missing here), **Changed** (here, contradicted by upstream), **Deprecated** (here, removed upstream), or **Community** (lower confidence). Present:

```
## Sync Report: writing-skills-update (YYYY-MM-DD)

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

Write "None" under an empty heading.

## Edits

For each New, Changed, or Deprecated item, propose the edit with its file, old and new content, and upstream source. Group proposals by file and get approval per file with `AskUserQuestion` before applying them. Put a harness fact in that harness's reference file; touch `SKILL.md` only when the portable guidance itself changes.

## Changelog

Prepend an entry to `${CLAUDE_SKILL_DIR}/references/changelog.md`, even when nothing changed:

```markdown
## YYYY-MM-DD

- **Sources checked:** [list of URLs fetched and release ranges]
- **Changes applied:** [summary of edits made, or "None"]
- **Community suggestions reviewed:** N (M accepted, K skipped)
- **No changes needed:** [list of files/areas that were already current]
```

## Broader scan

Afterwards, offer to scan the other skills in `skills/` for harness references this sync made stale: documentation URLs that no longer resolve, deprecated frontmatter fields, and renamed tools or APIs. On acceptance, report by skill name in the same format.
