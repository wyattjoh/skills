# Claude Code Memory & Auto-Loading

Claude Code auto-loads configuration from multiple locations. Understanding this helps when writing skills, rules, or agents that interact with project context.

## Auto-loaded locations

| Type     | Global (`~/.claude/`) | Project (`./.claude/`)                 |
| -------- | --------------------- | -------------------------------------- |
| Memory   | `CLAUDE.md`           | `CLAUDE.md` (or `./CLAUDE.md`)         |
| Rules    | `rules/*.md`          | `rules/*.md`                           |
| Skills   | `skills/*/SKILL.md`   | `skills/*/SKILL.md`                    |
| Agents   | `agents/*.md`         | `agents/*.md`                          |
| Settings | `settings.json`       | `settings.json`, `settings.local.json` |
| MCP      | (n/a)                 | `.mcp.json` (project root)             |

## Memory loading order (lower = higher priority)

1. `~/.claude/CLAUDE.md`: Global user preferences
2. `~/.claude/rules/*.md`: Global rules
3. Parent directory `CLAUDE.md` files: Recursive upward from cwd
4. `./CLAUDE.md` or `./.claude/CLAUDE.md`: Project memory
5. `./.claude/rules/*.md`: Project rules (supports `paths:` frontmatter for scoping)
6. Subdirectory `CLAUDE.md` files: On-demand when Claude accesses those files

## Key behaviors

- **Recursive parent discovery**: Claude walks up from cwd to root, loading all `CLAUDE.md` and `CLAUDE.local.md` files
- **On-demand subdirectory loading**: Nested `CLAUDE.md` files only load when Claude reads files in that directory
- **Path-scoped rules**: Files in `.claude/rules/` can use YAML frontmatter `paths: src/api/**/*.ts` to conditionally activate
- **Import syntax**: Use `@path/to/file` in any CLAUDE.md to import additional files
- **Local variants**: `CLAUDE.local.md` and `settings.local.json` are auto-gitignored for personal config

## Rule frontmatter shape

Path-scoped rules use this frontmatter pattern:

```yaml
---
description: One-line summary of what the rule enforces
paths:
  - "skills/**"
  - "agents/**/*.md"
alwaysApply: false
---
```

- `paths`: glob patterns that trigger auto-loading when Claude touches a matching file
- `alwaysApply: false`: rule only loads when a path pattern matches (set to `true` for unconditional loading, though that defeats the purpose of scoping)
- `description`: shown in memory index, helps Claude decide relevance
