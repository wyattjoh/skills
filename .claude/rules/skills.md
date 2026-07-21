---
description: Skill authoring conventions including SKILL.md format, Bun-only scripts, and file organization
paths:
  - "skills/**"
alwaysApply: false
---

When creating, modifying, or reviewing any files in `skills/*/`, ALWAYS invoke the `claude-skills` skill first to ensure you're following current best practices and conventions.

## SKILL.md frontmatter

Each skill lives at `skills/<name>/SKILL.md` with YAML frontmatter:

- `name`: Skill identifier
- `description`: Trigger phrases and conditions for auto-activation
- `allowed-tools`: Optional tool restrictions

Skills can have a `references/` subdirectory for supporting documentation.

## Directory structure

```
skills/<name>/
├── SKILL.md                    # Main skill definition
├── package.json                # Workspace member (name, version, type:module, deps, scripts)
├── scripts/                    # Executable scripts (Claude runs these)
│   ├── main-script.ts          # Primary script
│   ├── main-script.test.ts     # Test file (same directory, .test.ts suffix)
│   ├── helper.ts               # Additional scripts
│   └── testdata/               # Static test fixtures
└── references/                 # Documentation, templates, static data (NOT executable)
    └── *.md
```

## Standards

| Aspect            | Standard                                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Location**      | All executable scripts go in `scripts/` subdirectory                                                                                                     |
| **Runtime**       | **MUST use Bun + TypeScript**. Prefer Effect-TS for nontrivial script logic. No bash scripts. Each skill has its own `package.json` in `skills/<name>/`. |
| **Path notation** | Use `$SKILL_DIR` in documentation to reference the skill root                                                                                            |
| **Tests**         | Place test files alongside scripts with `.test.ts` suffix                                                                                                |
| **Test fixtures** | Use `scripts/testdata/` directory. Excluded from lint/fmt via `package.json`                                                                             |
| **Separation**    | `scripts/` = executable code, `references/` = docs/templates/static data                                                                                 |
| **File naming**   | Use lowercase with hyphens for all reference files (e.g., `error-patterns.md`)                                                                           |

**IMPORTANT**: All skill scripts MUST be written in Bun (TypeScript). Bash scripts are not allowed. This ensures:

- Cross-platform compatibility (macOS, Linux, Windows)
- Type safety and better error handling
- Consistent runtime environment
- Easier testing and maintenance

Prefer Effect-TS in scripts that perform meaningful I/O, shell commands,
parsing, branching, retries, cleanup, or user-facing error handling. Add
`effect` to the skill package, model expected failures with typed errors, compose
logic with `Effect.gen`, and run effects at the CLI boundary. Plain Bun
functions are acceptable for tiny pure helpers where Effect would add ceremony
without improving control flow or errors.

## Example SKILL.md script section

````markdown
## Scripts

Run the analysis script:

```bash
bun $SKILL_DIR/scripts/analyze.ts <input> [options]
```

Where `$SKILL_DIR` resolves to `~/.claude/skills/<skill-name>/`.
````

## Tests

Tests use `bun:test`. Import test utilities from `bun:test`:

```ts
import { describe, it, expect } from "bun:test";
// Also available: beforeEach, afterEach, mock, spyOn
```

Run tests for a skill:

```bash
cd skills/<name> && bun test
```

## What goes where

| Content Type            | Location            | Examples                                      |
| ----------------------- | ------------------- | --------------------------------------------- |
| Scripts Claude executes | `scripts/`          | `analyze.ts`, `check-updates.ts`, `export.ts` |
| Script tests            | `scripts/`          | `analyze.test.ts`, `check-updates.test.ts`    |
| Test fixtures           | `scripts/testdata/` | Static fixture files for deterministic tests  |
| Documentation           | `references/`       | `architecture.md`, `api-guide.md`             |
| Templates/schemas       | `references/`       | `manifest-schema.md`, `templates/*.yml`       |
| Static data             | `references/`       | `patterns/*.md`, `examples/`                  |

## Workspace registration

Skills with executable scripts are workspace members via the root `package.json` workspaces glob (`["skills/*"]`). Any skill directory that contains its own `package.json` is automatically discovered. No manual registration is required.

## Hot reload

Skills hot-reload immediately after edits (no Claude Code restart needed). This means changes to `SKILL.md` or `scripts/*.ts` take effect on the next invocation without restarting Claude Code.

## Documentation sync

When adding or removing a skill, update the skills table in `README.md` so the documented skill list stays in sync with the actual contents of `skills/`.
