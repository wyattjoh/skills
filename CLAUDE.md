# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## Overview

This repository is a public collection of Claude Code skills and agents for software
development workflows. There is no application to build: skills are Markdown (`SKILL.md`)
with optional Bun/TypeScript helper scripts, and agents are single Markdown files.

For how Claude Code auto-loads skills, agents, rules, and memory, see
[`.claude/references/claude-code-loading.md`](.claude/references/claude-code-loading.md).

## Repository structure

```
skills/              # one directory per published skill, each with a SKILL.md (plus optional scripts/ and references/)
agents/              # one Markdown file per agent
plugins/             # optional plugins beside the root one (e.g. to-code: a Claude Code mod plus a pi extension)
.claude-plugin/      # plugin.json and marketplace.json, so the repo installs as a Claude Code plugin
.claude/skills/      # skills internal to this repo, not published (e.g. writing-skills-update)
.claude/references/  # shared reference docs for authoring in this repo, plus pinned dependency submodules
.claude/rules/       # path-scoped authoring conventions for this repo
package.json         # Bun workspace root (workspaces: ["skills/*", "plugins/*"])
justfile             # symlink management for installing agents/ into ~/.claude/agents/
```

Skills under `skills/` are the published collection and belong in the `README.md`
table. Skills under `.claude/skills/` are repo-internal tooling: they load
automatically when working in this repository and are not listed in `README.md`.

## Path-scoped rules

Conformance rules live in `.claude/rules/` and auto-activate via `paths:` frontmatter when
Claude edits matching files:

| Rule                                     | Scope            | Purpose                                                      |
| ---------------------------------------- | ---------------- | ------------------------------------------------------------ |
| [`skills.md`](.claude/rules/skills.md)   | `skills/**`      | SKILL.md format, Bun/TypeScript scripts, directory structure |
| [`agents.md`](.claude/rules/agents.md)   | `agents/**/*.md` | Agent frontmatter fields, reload behavior, validation        |
| [`plugins.md`](.claude/rules/plugins.md) | `plugins/**`     | Shared mod/pi core, adapters, the two test runners           |
| [`testing.md`](.claude/rules/testing.md) | All files        | Positive, exact test expectations instead of negated chains  |

## Authoring skills

- Invoke the `writing-skills` skill before creating or editing a skill.
- One directory per skill under `skills/`, containing a `SKILL.md`. Co-locate `scripts/`
  and `references/` inside the skill directory as needed.
- Frontmatter requires `name` and a `description` with trigger phrases so the skill
  activates reliably.
- Helper scripts use Bun + TypeScript. Run `bun test` to exercise their tests.

## Authoring agents

- One Markdown file per agent under `agents/`. Restart Claude Code to load agent changes.
- Follow the frontmatter conventions in [`.claude/rules/agents.md`](.claude/rules/agents.md).

## Plugin packaging

The repository root is a Claude Code plugin (`wyattjoh`) and the marketplace
(`wyattjoh-skills`), defined in `.claude-plugin/`. The marketplace also lists each optional
plugin under `plugins/`, so installing `wyattjoh` never pulls them in. The root plugin relies on the default
`skills/` and `agents/` directories, so new skills and agents ship without manifest
edits. `version` is intentionally omitted so installs track the commit SHA. Run
`claude plugin validate .` after touching either manifest.

## Available scripts

| Command                | Description                                        |
| ---------------------- | -------------------------------------------------- |
| `bun test`             | Run all tests in the `skills/` directory           |
| `bun run check`        | Type-check skill TypeScript files (`tsc --noEmit`) |
| `bun run lint`         | Lint with oxlint (config: `.oxlintrc.json`)        |
| `bun run format`       | Format with oxfmt (config: `.oxfmtrc.json`)        |
| `bun run format:check` | Verify formatting without writing                  |
| `bun run knip`         | Find unused files, deps, and exports (`knip.json`) |
| `just link`            | Symlink `agents/*.md` into `~/.claude/agents/`     |
| `just unlink`          | Remove agent symlinks pointing at this checkout    |

## Documentation

Update `README.md` whenever a skill or agent is added, removed, or renamed, so the
agents and skills tables match the actual contents of `agents/` and `skills/`.

## Dependency References

Five upstream repositories are registered as pinned git submodules under `.claude/references/`.
They are for read-only reference only; do not edit files inside these paths.

| Dependency              | Version / Tag         | Path                                               | Repository                                                       | Pin (commit SHA)                           |
| ----------------------- | --------------------- | -------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| Catppuccin              | `v0.2.0`              | `.claude/references/catppuccin`                    | https://github.com/catppuccin/catppuccin.git                     | `9de299f8f1702fe4fb4e439adfd04b5623e7b77f` |
| Composable Architecture | `1.26.2`              | `.claude/references/swift-composable-architecture` | https://github.com/pointfreeco/swift-composable-architecture.git | `377da4061db10d26337a71bb279c506bb951f50f` |
| Effect                  | `effect@3.22.2`       | `.claude/references/effect`                        | https://github.com/Effect-TS/effect.git                          | `6985be0cf461f0997f28f6798f469d01a2b46ca3` |
| Effect v4               | `effect@4.0.0-rc.118` | `.claude/references/effect-v4`                     | https://github.com/Effect-TS/effect.git                          | `ad61db80efd52637e2901c5ee56b9e0fb4e8ac48` |
| Varlock                 | `varlock@1.21.1`      | `.claude/references/varlock`                       | https://github.com/dmno-dev/varlock.git                          | `fd51d60905b372ab10ae6407300346e67695aec0` |

The Effect repository is vendored twice because this repository uses two incompatible major versions.
`effect` tracks the npm `latest` line (v3), still used by the `workspaces`, `herd`, `clean-storage`, and
`mermaid` helper scripts; `effect-v4` tracks the exact v4 release candidate that the `effect-ts` skill
documents. The v4 checkout also carries upstream `MIGRATION.md`,
`migration/`, `LLMS.md`, and `ai-docs/` directories that the v3 checkout does not.

The `alchemy` and `effect-ts` skills must always target the same Effect release. The source of truth is
upstream alchemy's exact pin (`overrides.effect` in its `pnpm-workspace.yaml`), which
`skills/alchemy/scripts/build-skill.ts` records as `source.effectVersion` in
`skills/alchemy/references/manifest.json`. `skills/alchemy/scripts/effect-version.test.ts` fails unless every
Effect v4 version in `skills/effect-ts/` and the `effect-v4` submodule tag match it, so after regenerating
the alchemy corpus, bump the `effect-ts` skill and the `effect-v4` submodule together in the same change.

To populate locally after a fresh clone:

```sh
git submodule sync
git submodule update --init --depth 1
```

## Conventions

- Use [Conventional Commits](https://www.conventionalcommits.org/): `<type>[scope]: <description>`.
- Never use em dashes in written output, including comments, commit messages, and docs. Use
  commas, parentheses, or separate sentences instead.
