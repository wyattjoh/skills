---
name: new-cli-skill
description: 'Generates a new CLI-usage skill for a target CLI. Given a name (searched) or a URL (GitHub repo / package), it maps the CLI''s command surface and config-file formats into a skill that kickstarts common operations. Triggers on "use the new-cli-skill", "create a skill for the [cli] cli", "generate a CLI skill", "make a skill for [tool] and its [config] file", "map this CLI into a skill".'
allowed-tools: Task, Bash, Read, Write, Edit, Glob, AskUserQuestion
disable-model-invocation: true
effort: high
argument-hint: "<cli-name|url> [config-format...]"
---

# new-cli-skill

Generate a new CLI-usage skill into `skills/<cli-name>/`. The generated skill is
built to **kickstart the common operations** of a CLI, not to clone its man
pages. It documents the command surface, source-cited common workflows, and any
associated config-file formats (e.g. `just` -> `Justfile`).

The generator runs **two parallel subagents** (documentation research + local
`--help` exploration), writes their structured findings to the scratchpad, then
**synthesizes in this main context so you can watch and correct it**.

Read [`references/output-structure.md`](references/output-structure.md) before
synthesis. The two agent prompts live in
[`references/research-agent-prompt.md`](references/research-agent-prompt.md) and
[`references/explore-agent-prompt.md`](references/explore-agent-prompt.md).

## Inputs

Read the target from the invocation:

- A **bare name** (`just`) -> resolve to canonical sources (see below).
- A **URL** (GitHub repo or package page) -> unambiguous source; skip name search.
- Optional **config formats** named in the prompt ("...and its Justfile") are
  always documented anyway (config discovery is automatic), but an explicit
  mention guarantees a dedicated reference file.

## Workflow

### 1. Resolve the target

Run this ladder for a bare name (a URL skips steps that it already answers):

1. **Local binary**: `command -v <cli>` and `<cli> --version`. Pins the version
   and confirms the tool exists on this machine.
2. **Canonical repo + homepage**: resolve via the package registry
   (`npm`/`crates.io`/`PyPI`/`brew info <cli>`) or GitHub search.
3. **Curated docs**: check `context7` for up-to-date library/CLI docs.
4. Assemble a **source set**: `{ repoUrl, docsUrl, binaryPath, version }`.

If the name is genuinely ambiguous (multiple plausible tools share it),
**stop and ask** with `AskUserQuestion` — do not guess.

### 2. Handle a missing binary

If step 1 found no binary, **stop and offer** with `AskUserQuestion`:

- Install it (suggest the manager: Homebrew on this Mac, else `npm`/`cargo`/`pipx`),
  then continue with a real `--help` pass, **or**
- Proceed **docs-only**. If docs-only, every generated file is marked
  `> Unverified against a local binary.` and the explore agent is skipped.

**Never install silently.**

### 3. Handle an existing skill

If `skills/<cli-name>/` already exists, **stop and offer** with
`AskUserQuestion`, showing the recorded version vs the now-installed version:

- **Refresh** (regenerate from scratch) — the default suggestion **when the
  installed version changed**.
- **Update in place** (re-run agents, merge new findings).
- **Cancel** — suggested when versions match.

Never silently clobber a directory that may carry hand-edits.

### 4. Launch both subagents in parallel

In a **single message**, launch two `Task` subagents. Fill the source set into
each prompt template:

- **Research agent** — prompt from `references/research-agent-prompt.md`. Reads
  canonical docs + README + `context7`; extracts the command surface, config
  formats, and **source-cited** common workflows. Writes
  `<scratchpad>/<cli>-research.md`.
- **Explore agent** — prompt from `references/explore-agent-prompt.md`. Runs the
  **`--help` fan-out only, depth 2**, against the local binary; captures the real
  command/flag tree + version. Writes `<scratchpad>/<cli>-explore.md`.

Both agents return a short pointer, not prose — the findings live on disk so
synthesis reads files instead of bloating context. Skip the explore agent
entirely in docs-only mode.

### 5. Synthesize the skill (this context)

Read both scratchpad files. Follow
[`references/output-structure.md`](references/output-structure.md) exactly.
Apply the conflict rule:

- **The local binary's `--help` wins** on command/subcommand/flag existence and
  exact spelling (it is what runs on this machine).
- **The docs win** on explanation, workflow narrative, config-format semantics,
  and worked examples.
- On a real conflict, record the binary's truth and **note the discrepancy
  inline** with the pinned version (e.g. "docs show `--foo`; local v1.2 exposes
  `--foo-bar`").

Every workflow example must **cite its source** (a docs URL or `` `<cli> --help` ``).
Mark any workflow the agent assembled without a documented example as
`(inferred)`.

### 6. Self-check and finish

Run a structural self-check and report pass/fail inline:

- Valid YAML frontmatter (no tabs, quoted description).
- The generated `description` carries concrete triggers: the CLI name, key
  subcommands, and the config-file name(s).
- Every `references/` file is linked from the generated `SKILL.md`; no broken
  internal links.
- The pinned version appears in the generated skill's local-setup section.

Then update this repo's `README.md` skills table (keep it alphabetical).

**Do not** automatically sync or install the generated skill, and **do not**
stage a commit. End by **suggesting** the user run `skill-audit` for a deeper
review.

## Output location

Default to `skills/<cli-name>/` in **this repo** (version-controlled, workspace
glob picks it up). Honor an explicit target directory if the invocation gives
one; when invoked outside this repo with no target, default to
`~/.claude/skills/<cli-name>/`.

Generated CLI skills are **pure documentation** (`SKILL.md` + `references/`), so
they carry **no `package.json`** and no scripts.

## Safety

The explore agent runs **help / version output only**, in an empty scratch
working directory, with **no credentials in its environment**. It never executes
a real subcommand for its effect. This boundary is baked into its prompt
template — preserve it.
