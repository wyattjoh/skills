# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## Overview

This repository is a public collection of Claude Code skills and agents for software
development workflows. There is no application to build: skills are Markdown (`SKILL.md`)
with optional Bun/TypeScript helper scripts, and agents are single Markdown files.

For how Claude Code auto-loads skills, agents, rules, and memory, see
[`references/claude-code-loading.md`](references/claude-code-loading.md).

## Repository structure

```
skills/         # one directory per skill, each with a SKILL.md (plus optional scripts/ and references/)
agents/         # one Markdown file per agent
references/     # shared reference docs for authoring in this repo
.claude/rules/  # path-scoped authoring conventions for this repo
package.json    # Bun workspace root (workspaces: ["skills/*"]) for skill helper scripts
```

## Path-scoped rules

Conformance rules live in `.claude/rules/` and auto-activate via `paths:` frontmatter when
Claude edits matching files:

| Rule                                     | Scope            | Purpose                                                      |
| ---------------------------------------- | ---------------- | ------------------------------------------------------------ |
| [`skills.md`](.claude/rules/skills.md)   | `skills/**`      | SKILL.md format, Bun/TypeScript scripts, directory structure |
| [`agents.md`](.claude/rules/agents.md)   | `agents/**/*.md` | Agent frontmatter fields, reload behavior, validation        |
| [`testing.md`](.claude/rules/testing.md) | All files        | Positive, exact test expectations instead of negated chains  |

## Authoring skills

- Invoke the `claude-skills` skill before creating or editing a skill.
- One directory per skill under `skills/`, containing a `SKILL.md`. Co-locate `scripts/`
  and `references/` inside the skill directory as needed.
- Frontmatter requires `name` and a `description` with trigger phrases so the skill
  activates reliably.
- Helper scripts use Bun + TypeScript. Run `bun test` to exercise their tests.

## Authoring agents

- One Markdown file per agent under `agents/`. Restart Claude Code to load agent changes.
- Follow the frontmatter conventions in [`.claude/rules/agents.md`](.claude/rules/agents.md).

## Available scripts

| Command                | Description                                        |
| ---------------------- | -------------------------------------------------- |
| `bun test`             | Run all tests in the `skills/` directory           |
| `bun run check`        | Type-check skill TypeScript files (`tsc --noEmit`) |
| `bun run lint`         | Lint with oxlint (config: `.oxlintrc.json`)        |
| `bun run format`       | Format with oxfmt (config: `.oxfmtrc.json`)        |
| `bun run format:check` | Verify formatting without writing                  |

## Documentation

ALWAYS update `README.md` when adding, removing, or renaming a skill or agent. Keep the
agents and skills tables in sync with the actual contents of `agents/` and `skills/`.

## Dependency References

Three upstream repositories are registered as pinned git submodules under `.claude/references/`.
They are for read-only reference only; do not edit files inside these paths.

| Dependency | Version / Tag    | Path                            | Repository                                   | Pin (commit SHA)                           |
| ---------- | ---------------- | ------------------------------- | -------------------------------------------- | ------------------------------------------ |
| Catppuccin | `v0.2.0`         | `.claude/references/catppuccin` | https://github.com/catppuccin/catppuccin.git | `9de299f8f1702fe4fb4e439adfd04b5623e7b77f` |
| Effect     | `effect@3.21.4`  | `.claude/references/effect`     | https://github.com/Effect-TS/effect.git      | `4c5a0e384ad768f5a89d650c1a753504dc9b8735` |
| Varlock    | `varlock@1.10.0` | `.claude/references/varlock`    | https://github.com/dmno-dev/varlock.git      | `dd7863b4f319fcf333dfe1c29cb834f8e15313ad` |

To populate locally after a fresh clone:

```sh
git submodule sync
git submodule update --init --depth 1
```

## Conventions

- Use [Conventional Commits](https://www.conventionalcommits.org/): `<type>[scope]: <description>`.
- Never use em dashes in written output, including comments, commit messages, and docs. Use
  commas, parentheses, or separate sentences instead.
