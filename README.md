# Agent Skills

<p align="center">
  <img src="icons/icon.png" alt="Agent Skills icon" width="256" height="256" />
</p>

A curated public collection of reusable [Agent Skills](https://agentskills.io/) and
[Claude Code](https://claude.ai/code) agents for software development workflows.

The skills cover code review, pull requests, release automation, dependency management,
iOS development, research, workspace orchestration, and other repeatable engineering
tasks. Each skill is self-contained, inspectable, and installable on its own.

## Install skills

Use the open source [Skills CLI](https://github.com/vercel-labs/skills) to browse and
install skills from this repository. The interactive flow lets you choose skills, target
agents, and project or global scope.

With Bun:

```bash
bunx skills@latest add wyattjoh/skills
```

With npm:

```bash
npx skills@latest add wyattjoh/skills
```

Useful variations:

```bash
# List the available skills without installing them
bunx skills@latest add wyattjoh/skills --list

# Install one skill globally for Claude Code
bunx skills@latest add wyattjoh/skills --skill pr-create --global --agent claude-code

# Install every skill globally for Claude Code without prompts
bunx skills@latest add wyattjoh/skills --skill '*' --global --agent claude-code --yes
```

Replace `bunx` with `npx` in any example if you prefer npm.

Some skills use agent-specific features or require an external CLI. Check the selected
skill's `SKILL.md` for its requirements before installing it.

## Install Claude Code agents

The Skills CLI installs the entries under `skills/`. The definitions under `agents/` are
Claude Code subagents and must be installed separately.

Clone the repository, then symlink the agents you want into `~/.claude/agents/`:

```bash
git clone https://github.com/wyattjoh/skills.git
cd skills
mkdir -p ~/.claude/agents
ln -sfn "$PWD/agents/code-reviewer.md" ~/.claude/agents/code-reviewer.md
```

Restart Claude Code after adding or changing an agent definition.

## Skills

| Skill                         | Description                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------- |
| claude-skills                 | Guidance for authoring Claude Code skills                                         |
| claude-skills-update          | Periodic check for upstream Claude Code skill API changes                         |
| conductor                     | Navigate Conductor worktree environments for parallel agents                      |
| dialkit                       | Live parameter tweaking and design exploration in React via dialkit               |
| driving-ios-simulator         | Drive a booted iOS Simulator: tap, swipe, type, read elements, screenshot         |
| effect-ts                     | Effect-TS patterns: services, layers, error handling, composition                 |
| executing-workflows-manually  | Run Claude Code workflow scripts in harnesses without the Workflow tool           |
| herdr                         | Control herdr from inside a pane over its unix socket                             |
| icon-gen                      | Generate app icons with AI (snapai), with refinement and platform resizing        |
| json-inspect                  | Generate JSON Schema from JSON files with genson                                  |
| just                          | Kickstart the just command runner and author justfiles                            |
| mermaid                       | Create and render Mermaid diagrams                                                |
| name-gen                      | Brainstorm project names, check domains, research conflicts                       |
| new-cli-skill                 | Generate a CLI-usage skill from a name or URL                                     |
| npm-info                      | Fetch npm package metadata from the registry                                      |
| pr-create                     | Create a PR from the current branch with a template or generated description      |
| pr-fix                        | Triage PR review comments and failing CI, then implement agreed fixes             |
| pr-rebase                     | Rebase onto the latest base, resolve conflicts, force-push with lease             |
| pr-status                     | Graph of open PRs grouped by stack, plus local cleanup list                       |
| raycast-dev                   | Build, maintain, and publish Raycast extensions                                   |
| reference-submodules          | Manage context repos as pinned shallow git submodules under `.claude/references/` |
| release-please                | Configure, operate, and debug release-please                                      |
| research-augmented-design     | Interleave background research agents with brainstorming during design            |
| resticprofile                 | Operate the resticprofile CLI for restic backups                                  |
| review                        | Comprehensive code review with repository health diagnostics                      |
| setup-project-memory          | Capture a session learning into .claude/memory, indexed and wired into CLAUDE.md |
| simplify                      | Interactive code simplification with batched approval                             |
| skill-audit                   | Audit skill execution for permission denials, tool errors, and corrections        |
| swift-composable-architecture | Adoption index for The Composable Architecture (TCA 1.26.0), mapped by topic      |
| swift-sql                     | Type-safe Swift SQL with swift-structured-queries                                 |
| swift-tca                     | TCA reducer and navigation patterns                                               |
| task-orchestrator             | Coordinate parallel work units across isolated per-task worktree agents           |
| task-planner                  | Decompose a settled feature design into validated orchestrator plan files         |
| varlock                       | Kickstart varlock, the encrypted schema-driven dotenv replacement                 |
| vhs                           | Interview-driven terminal screencasts rendered to GIF/MP4/WebM                    |
| workspaces                    | Create, operate, and compact multi-repo workspace hubs                            |

## Claude Code agents

| Agent                | Description                                                                      |
| -------------------- | -------------------------------------------------------------------------------- |
| code-reviewer        | Dual-pipeline code review with parallel reviewers and interactive fix delegation |
| debug-investigator   | Systematically investigates bugs and unexpected behavior                         |
| git-history-explorer | Searches git history for code evolution and commit patterns                      |
| researcher           | Research specialist for online sources and local codebases                       |
| ui-ux-analyzer       | Expert UI/UX analysis and recommendations                                        |
| xcode-builder        | Performs Xcode builds with error parsing and structured reports                  |
| xcode-runner         | Runs Xcode apps on simulators or physical devices                                |

## Repository layout

```text
skills/         # One directory per skill, with SKILL.md and optional supporting files
agents/         # Claude Code subagent definitions
references/     # Shared authoring documentation
.claude/rules/  # Repository-specific authoring conventions
```

For details about how Claude Code loads skills, agents, rules, and memory, see
[`references/claude-code-loading.md`](references/claude-code-loading.md).

## Contributing

Clone the repository and install its development dependencies with Bun:

```bash
git clone https://github.com/wyattjoh/skills.git
cd skills
bun install
```

Run the repository checks before submitting changes:

```bash
bun test
bun run check
bun run lint
bun run format:check
```

Skills follow the `SKILL.md` format with YAML frontmatter and Markdown instructions.
Helper scripts use Bun and TypeScript. Repository-specific conventions live in
[`.claude/rules/`](.claude/rules/).

Keep the skills and agents tables above synchronized when adding, removing, or renaming
entries.

## License

MIT
