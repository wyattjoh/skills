# Changelog

## 2026-04-06

- **Sources checked:** Skills Overview (code.claude.com), Best Practices (platform.claude.com), Agent Skills Overview (platform.claude.com), Sub-agents Reference (code.claude.com), Plugins Reference (code.claude.com), Hooks Reference (code.claude.com), GitHub releases v2.1.89-v2.1.92, 2 community web searches
- **Changes applied:**
  - frontmatter-reference.md: Updated `allowed-tools` to document space-separated as the current official format while noting comma-separated still works and recommending the YAML list form for clarity
  - hooks-and-advanced.md: Added multi-line ` ```! ` fenced code block form for dynamic injection, documented the new `disableSkillShellExecution` setting from v2.1.91, relaxed the skill-scoped hooks event restriction since the upstream hooks reference now shows `SessionStart` used in skill frontmatter
  - best-practices.md: Added Workflow Patterns section (checklists, feedback loops, plan-validate-execute), added Script-Authoring Guidelines section (solve don't punt, verbose error messages), updated "Legacy (deprecated)" terminology to "Old patterns" with a collapsible `<details>` block example
- **Community suggestions reviewed:** 2 (0 accepted — searches surfaced only the same official docs already in Tier 1 plus GitHub issues about `context: fork` bugs, no novel best practices)
- **Broader scan (Phase 7) findings:** Found 6 stale references to the `Task` tool (renamed to `Agent` in v2.1.63, 2026-02-28). Updated one other skill file (4 lines, not part of this snapshot) and `agents/xcode-runner.md` (2 lines) to use the current `Agent` terminology. Old `Task(...)` syntax still works as an alias, so nothing was broken — just drifted terminology that the previous sync missed.
- **Broader scan clean:** No `docs.anthropic.com` or `docs.claude.com` URLs in the toolkit. No stale frontmatter field names. Character budget numbers correct toolkit-wide.
- **No changes needed:** SKILL.md body structure (still accurate), naming conventions, description writing guidance, progressive disclosure patterns 1/2/3, bundled skills list, string substitutions, visibility fields, character budget numbers (already updated last sync), `paths` and `shell` frontmatter fields (already added last sync), HTTP/prompt/agent hook types

## 2026-03-29

- **Sources checked:** Skills Overview (code.claude.com), Best Practices (platform.claude.com), Agent Skills Overview (platform.claude.com), Hooks Reference (code.claude.com), GitHub releases v2.1.83-v2.1.87, 2 community web searches
- **Changes applied:**
  - frontmatter-reference.md: Added `paths` field, `shell` field, 250-char description truncation note
  - hooks-and-advanced.md: Added HTTP hook type, `if` conditional field, `async: true` option
  - best-practices.md: Added MCP tool references best practice
  - visibility-and-discovery.md: Fixed description budget from 2%/16K to 1%/8K, added 250-char per-entry cap
  - SKILL.md: Fixed description budget numbers in troubleshooting section
- **Community suggestions reviewed:** 2 (0 accepted, 2 noted as already covered by official guidance)
- **No changes needed:** SKILL.md body structure, string substitutions, naming conventions, description style guidance, progressive disclosure patterns, visibility controls, dynamic injection, bundled skills list
