---
name: reference-submodules
description: >-
  Manages reference (context) repositories as shallow git submodules under
  .claude/references/, pinned to a dependency's version tag, and keeps the
  project's "Dependency References" table in CLAUDE.md in sync. Use when adding,
  upgrading, removing, or syncing reference repositories. Triggers on "add a
  reference repo", "add a context repository", "vendor dependency source", "add
  X as a reference", "pin a dependency submodule", "upgrade reference
  submodule", "remove reference submodule", "sync references", or mentions
  ".claude/references" submodules.
argument-hint: "[add|upgrade|remove|sync|help] [repo-url]"
allowed-tools: >-
  Bash(git *), Bash(gh *), Read, Grep, Glob, Edit
effort: high
---

# Reference Submodules

Manage context repositories as shallow git submodules under `.claude/references/`,
pinned to the matching version tag, so dependency source is available offline and
the project's `CLAUDE.md` "Dependency References" table stays accurate.

**Arguments provided**: $ARGUMENTS

**Requires:** git 2.13+. `gh` is optional (used for tag listing on private repos).

This skill manages references. _Consuming_ them (preferring local reference
source over web docs) is an always-on rule in global `CLAUDE.md`, not this skill.

## Quick Start

1. `/reference-submodules add <repo-url>` to vendor a repo at the matching tag
2. `/reference-submodules upgrade <name>` to bump an existing reference
3. `/reference-submodules sync` to populate references after a fresh clone
4. `/reference-submodules remove <name>` to cleanly remove one

If no argument is given, infer intent from context (a URL implies `add`; an empty
`.claude/references/` with `.gitmodules` entries implies `sync`).

## Preconditions

Check these before any mutating operation. Each is a place the raw git commands
fail confusingly:

- **Host must be a git repo with at least one commit.** Run `git rev-parse --git-dir`.
  If it fails, stop and offer `git init` (submodules cannot be added otherwise).
- **Already added?** Check `.gitmodules` for the target path. If present, do not
  re-add: route to the **upgrade** flow instead.

## Version resolution

Shared by `add` and `upgrade`. Follow this order and **confirm the resolved ref
before mutating `.gitmodules`**.

1. **Dependency name** (for the directory and table):
   - Directory name = repo name (last URL segment, strip `.git`), e.g.
     `vercel/next.js` -> `next.js`.
   - Table "Dependency" name = the package name if the repo maps to a tracked
     project dependency (e.g. npm `next`), otherwise the repo name.

2. **Target version**, in priority order:
   - **(a) Match the installed dependency.** If the repo is a recognized
     dependency, read its resolved version from the project manifest/lockfile
     (`package.json` + lockfile, `requirements.txt`, `Cargo.toml`, `go.mod`,
     etc.). Pin to the tag matching that version.
   - **(b) Latest release tag.** Otherwise use the newest tag.
   - **(c) Default branch HEAD.** If the repo has no tags, pin to the default
     branch and record the commit.

3. **Match the tag naming scheme.** List tags with
   `git ls-remote --tags <url>` (or `gh api repos/<org>/<repo>/tags` for private
   repos). Find the tag whose normalized version equals the target. Common
   schemes (a single repo uses one):
   - `v<ver>` (e.g. `v15.1.0`) — most common
   - `<ver>` (bare, e.g. `15.1.0`)
   - `<pkg>@<ver>` or `@scope/pkg@<ver>` (monorepos, e.g. `turbo@2.0.0`)

4. **Confirm** the resolved `{dependency, directory, url, ref}` with the user,
   then proceed.

## Sub-commands

### `add <repo-url>`

1. Run the **Preconditions** checks. If the path already exists in `.gitmodules`,
   switch to `upgrade`.
2. Run **Version resolution**, then confirm.
3. Add the submodule. **Never use `git submodule add -b <tag>`** — `-b` names a
   branch, and a shallow clone has no history to synthesize a branch from a tag,
   so it always fails with `fatal: '<tag>' is not a commit`. Clone first, then
   fetch and check out the tag explicitly:
   - With a tag:
     ```bash
     git submodule add --depth 1 <repo-url> .claude/references/<dir>
     cd .claude/references/<dir>
     git fetch --depth 1 origin tag <tag>
     git checkout <tag>
     cd -
     git submodule set-branch --branch <tag> -- .claude/references/<dir>
     git add .gitmodules .claude/references/<dir>
     ```
   - No-tag fallback (default branch): add as-is, then record the commit:
     ```bash
     git submodule add --depth 1 <repo-url> .claude/references/<dir>
     ```
4. Verify the add landed as a submodule, not a flattened directory tree: run
   `git ls-files -s .claude/references/<dir>` and confirm it shows exactly one
   `160000` gitlink entry. Many regular-file (`100644`) entries means the index
   got corrupted during a retry (see Edge cases) — reset and redo the add before
   continuing.
5. Update the **CLAUDE.md table** (see below).
6. Report the path, pinned ref, and that `.gitmodules` + the gitlink are staged.
   Remind the user to commit.

### `upgrade <name> [version]`

Bump an existing reference to a new tag (or the matching installed version).

1. Locate the entry in `.gitmodules` (path `.claude/references/<name>`). If
   absent, suggest `add`.
2. Resolve the new ref via **Version resolution**. If `version` was given, use it
   verbatim after confirming the tag exists. Confirm.
3. Fetch and check out the new ref, then update the tracked branch:
   ```bash
   cd .claude/references/<name>
   git fetch --depth 1 origin tag <new-tag>
   git checkout <new-tag>
   cd -
   git submodule set-branch --branch <new-tag> -- .claude/references/<name>
   git add .gitmodules .claude/references/<name>
   ```
4. Update the version cell in the **CLAUDE.md table**.
5. Report old -> new ref. Remind the user to commit.

### `remove <name>`

Submodule removal is multi-step; doing only `git rm` leaves stale config behind.

1. Deinit, then remove from the working tree and `.gitmodules`:
   ```bash
   git submodule deinit -f .claude/references/<name>
   git rm -f .claude/references/<name>
   ```
2. Clean the stored git module so a future re-add does not collide:
   ```bash
   rm -rf .git/modules/.claude/references/<name>
   ```
3. If that was the last reference, `.gitmodules` is now empty — don't leave an
   empty tracked file staged:
   - Already committed before this session: stage its deletion with
     `git rm .gitmodules`.
   - Newly created earlier in this session (first-ever reference, never
     committed): unstage and delete it directly with
     `git restore --staged .gitmodules && rm -f .gitmodules`.
4. Remove the row from the **CLAUDE.md table**. If it was the last row, remove the
   now-empty "Dependency References" subsection.
5. Report what was removed. Remind the user to commit (`git rm` already staged
   `.gitmodules` and the gitlink removal).

### `sync`

Populate or refresh references (e.g. after a fresh clone where
`.claude/references/` is empty but `.gitmodules` has entries).

```bash
git submodule sync --recursive
git submodule update --init --recursive --depth 1
```

Read-only with respect to project config (no `.gitmodules`/table edits). Report
which references were initialized.

### `help`

Print the sub-commands above with one-line descriptions. Read-only.

## CLAUDE.md table format

Maintain a "Dependency References" subsection in the **project root** `CLAUDE.md`:

```markdown
### Dependency References

| Dependency | Version | Path                          |
| ---------- | ------- | ----------------------------- |
| next       | 15.1.0  | `.claude/references/next.js/` |
```

Rules when editing:

- If the subsection is absent, create it (a sensible home is a "Dependency
  Management" or "Dependencies" area; otherwise append near the end).
- **Version** cell: the bare version for a tag (`15.1.0`, not `v15.1.0`); for a
  no-tag fallback use `<branch>@<short-sha>` (e.g. `main@a1b2c3d`).
- Keep rows sorted by Dependency and deduplicated (one row per path).
- On `remove`, delete the matching row; drop the subsection if it becomes empty.

## Confirmation gate rules

**Never execute without showing the plan first:**

- `git submodule add` / `set-branch`, `git checkout` of a new ref
- `git submodule deinit`, `git rm`, `rm -rf .git/modules/...`
- Edits to `CLAUDE.md`

**Always allowed without confirmation (read-only):**

- `git rev-parse`, `git ls-remote`, `git config --get`
- `gh api .../tags`, `git submodule status`
- `git submodule sync` / `update --init` (the `sync` command)

## Edge cases

- **Not a git repo / no commits:** stop, offer `git init` (see Preconditions).
- **Already added:** route to `upgrade`, never re-`add`.
- **Private repo / auth failure:** use the URL form the user provided; if HTTPS
  auth fails, suggest the SSH URL (`git@github.com:org/repo.git`). Do not manage
  credentials. Use `gh api` for tag listing when `git ls-remote` is unauthorized.
- **No tags found:** fall back to default-branch HEAD; record `<branch>@<sha>` in
  the table (resolution step 2c).
- **Reproducibility:** every reference resolves to a fixed tag or commit, never a
  moving branch tip without a recorded sha.
- **Failed `add` leaves partial state:** if an add fails partway (bad ref,
  interrupted checkout), clean up atomically before retrying — `git submodule
  deinit -f <dir>` (if registered), `git rm -f <dir>` (if staged), `rm -rf
  .git/modules/<dir>`, and remove any stray `submodule.<dir>` section from
  `.git/config`. Confirm `git status --short` is clean for that path before
  retrying. A partial retry without full cleanup can stage the dependency's
  entire source tree as regular files in the host repo instead of a submodule
  gitlink — this is why step 4 of `add` always verifies with `git ls-files -s`.
- **Cleanup `rm -rf` blocked by a destructive-command guard:** if `rm -rf
  .git/modules/<dir>` is blocked in the current environment, prefer salvaging
  over asking the user to run it by hand — a failed tag checkout usually still
  has the objects fetched, so retry `git fetch --depth 1 origin tag <tag>` and
  `git checkout <tag>` directly inside the existing clone instead of deleting
  and re-cloning. Only ask the user to run cleanup manually if salvage isn't
  possible.
- **Monorepo tag verification:** don't verify a checked-out ref with `git
  describe --tags` in a repo with multiple co-located scoped tags (e.g.
  `agents@0.16.2` and `@cloudflare/think@0.10.0` on the same commit) — it can
  report an arbitrary sibling tag instead of the one you checked out. Verify by
  comparing `git rev-parse HEAD` against the commit resolved from `git
  ls-remote --tags <url> <tag>` instead.
- **Don't background the add/upgrade git commands** without checking their
  captured output: a shallow-clone tag failure can still exit 0 at the top
  level even though the checkout underneath failed. Confirm the ref actually
  resolved (the `git ls-files -s` verification) before reporting success.
- **Parallel worktrees adding different references:** rebasing one branch onto
  another that also ran `add` can conflict in both `.gitmodules` and the
  CLAUDE.md table. Both sides are additive — resolve by keeping both entries
  (both submodule sections, both table rows), not by picking one side.
