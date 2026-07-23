# Flow: init — create a workspace

Creates a new workspace hub end to end. This flow has side effects (a new
repo, per-member git config), so it starts with an explicit confirmation
gate.

## 1. Confirmation gate

State what will be created and where before touching anything:

- Hub location: sibling of the primary member repo,
  `~/Code/github.com/<org>/<name>-workspace/`
- Member repos to be stacked-prs-initialized
- Project-local skill links: `<hub>/.claude/skills/` symlinks

Get an explicit yes from the user. Never skip this gate even when the skill
was model-invoked.

## 2. Scope the work with grill-with-docs

Run the `grill-with-docs` skill against the workspace idea. Outputs land in
the hub (create the directory first if the grilling session needs a target):

- Spec documents -> `docs/spec/<topic>.md`
- Glossary / domain model -> `CONTEXT.md` (via domain-modeling)
- Initial decisions -> `docs/adr/NNNN-slug.md`
- Invariants surfaced -> `docs/constitution.md`

## 3. Scaffold the hub

1. `git init -b main` the hub directory; it is its own repository.
2. Copy every file from `$SKILL_DIR/references/templates/` into place
   (`workspace.yaml`, `JOURNAL.md`, `docs/constitution.md`, `docs/index.md`,
   `plan/phases.md`, `plan/tasks.md`, `Justfile`) and replace the
   placeholder markers with real values. Markdown and YAML templates use
   `{{PLACEHOLDER}}` markers (markdown formatters rewrite `__x__` as bold,
   so double underscores are unsafe there); the Justfile template alone uses
   `__PLACEHOLDER__` markers because just owns `{{ }}` interpolation.
3. Seed the three skills from `templates/skill-*.md` into
   `skills/<slug>-context/SKILL.md`, `skills/<slug>-domain/SKILL.md`,
   `skills/<slug>-conventions/SKILL.md`. Follow the `claude-skills` skill's
   authoring standards when filling them in (third-person descriptions with
   concrete trigger phrases).
4. Seed the workspace memory: copy `templates/memory-index.md` to
   `.claude/memory/MEMORY.md`, then write the first entries immediately —
   the scoping session that just ran (step 2) already surfaced rejected
   alternatives, open questions, and constraints that belong in memory, not
   only in the spec. A hub born with empty memory teaches every later
   session that memory is optional.
5. `ln -s CLAUDE.md AGENTS.md`.
6. Fill `workspace.yaml` members and layers, then generate:
   `bun $SKILL_DIR/scripts/workspace.ts manifest sync --workspace <hub>`.

## 4. Bind the member repositories

For each member repo:

1. Verify it exists and is a git repository (clone it if the user wants a
   missing member).
2. Initialize stacked-prs if not already active there (the stacked-prs
   skill's `init`/`import` flow). Record the base branch.
3. Do NOT create stacks yet; stacks are created per task by the task flow
   with the `<stack-prefix><task-slug>` naming.

## 5. Link the workspace skills project-locally

Workspace skills are project-local to the hub, never installed globally
(they are meaningless outside their workspace and would pollute every
other session's skill list). Link each seeded skill into the hub's own
`.claude/skills/` with relative symlinks, and commit them:

```bash
mkdir -p <hub>/.claude/skills
ln -s ../../skills/<slug>-context <hub>/.claude/skills/<slug>-context
ln -s ../../skills/<slug>-domain <hub>/.claude/skills/<slug>-domain
ln -s ../../skills/<slug>-conventions <hub>/.claude/skills/<slug>-conventions
```

Claude Code discovers them whenever a session runs inside the hub.
Sessions inside member repos do not see them; member-repo sessions load
workspace context through the `enter` flow instead. Do NOT register the hub
as a global skill source in any skill-sync tooling you use — that would link
the skills into `~/.claude/skills/` globally.

## 6. Optional: worktrunk context injection

If the user wants wt-managed worktrees to receive workspace context, add a
**user-level** per-project `post-start` hook (project `.config/wt.toml`
hooks require interactive approval an agent cannot give — escalate to the
user rather than using `--yes`):

```toml
# ~/.config/worktrunk/config.toml
[projects."github.com/<org>/<member>".hooks]
post-start = "ln -sfn <hub-path> {{ worktree_path }}/.workspace"
```

## 7. Freeze and commit

```bash
bun $SKILL_DIR/scripts/workspace.ts manifest freeze --workspace <hub>
bun $SKILL_DIR/scripts/workspace.ts audit --workspace <hub>   # must pass
bun $SKILL_DIR/scripts/workspace.ts journal add --workspace <hub> \
  --category decision --title "Workspace created" \
  --body "Initial scope per docs/spec/; members: <list>."
git add -A && git commit  # conventional commit, e.g. "feat: initialize <name> workspace"
```

The audit must pass before the first commit; a workspace that starts with
drift never recovers its audit discipline.
