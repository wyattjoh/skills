---
name: pr-create
description: Creates a pull request for the current branch. Reviews commits up to the merge base, detects repo PR templates, or generates a What/Why/How description. Prompts for draft state and optionally rebases stale branches first. Triggers on "create a PR", "open a pull request", "push and create PR", "submit this branch", "run /pr-create", or mentions "new pull request".
allowed-tools: Bash(gh:*), Bash(git status:*), Bash(git branch:*), Bash(git log:*), Bash(git diff:*), Bash(git rev-list:*), Bash(git rev-parse:*), Bash(git push:*), Bash(git fetch:*), Bash(git config:*), AskUserQuestion, Read, Grep, Glob, TodoWrite
argument-hint: "[--draft|--ready] [--base <branch>]"
disable-model-invocation: true
effort: medium
---

# Create a Pull Request

Create a pull request for the current branch, or update an existing one. Reviews
changes up to the merge base, uses the repo's PR template when available,
otherwise generates a What/Why/How description from commits.

**Arguments provided**: $ARGUMENTS

Recognized arguments:

- `--draft` force draft state (skip the draft/ready prompt)
- `--ready` force ready state (skip the draft/ready prompt)
- `--base <branch>` override base branch detection

Use `TodoWrite` to track progress through the phases below.

## Phase 1: Preflight

1. Confirm a git remote named `origin` exists:

   ```bash
   git config --get remote.origin.url
   ```

   If missing, stop and tell the user.

2. Confirm `gh` is authenticated:

   ```bash
   gh auth status
   ```

   If not, suggest `gh auth login` and stop.

3. Read the current branch:

   ```bash
   git branch --show-current
   ```

   If empty (detached HEAD), stop.

4. Refuse to run on the repo's default branch. If
   `current == $(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)`,
   tell the user they need a feature branch and stop.

## Phase 2: Resolve Base Branch

Follow this order, stopping at the first resolution:

1. **Explicit argument:** if `--base <branch>` was provided, use it.
2. **Existing PR:** `gh pr view --json baseRefName,number,url,state,isDraft` on the
   current branch. If a PR exists, use its `baseRefName`. Record the PR number
   so Phase 7 takes the update path instead of the create path.
3. **Repo default:**
   ```bash
   gh repo view --json defaultBranchRef --jq .defaultBranchRef.name
   ```

Validate the resolved base:

```bash
git fetch origin <base>
git rev-parse --verify origin/<base>
```

If validation fails (branch doesn't exist on origin), stop and report.

## Phase 3: Staleness Check

Compare the branch against the resolved base:

```bash
BEHIND=$(git rev-list --count HEAD..origin/<base>)
AHEAD=$(git rev-list --count origin/<base>..HEAD)
```

- If `BEHIND == 0`: branch is up to date. Continue.
- If `BEHIND > 0`: branch is behind. Use `AskUserQuestion` with these options:
  1. **Rebase first** -- invoke the `pr-rebase` skill, then resume `pr-create`
     from Phase 4 after it completes.
  2. **Continue anyway** -- proceed with the current branch state. GitHub will
     show the out-of-date banner on the PR.
  3. **Cancel** -- exit without pushing.

If `AHEAD == 0` (no commits on branch): stop. There is nothing to open a PR
for.

## Phase 4: Build Description

### 4.1 Look for a repo PR template

Search in this order and collect all matches:

- `.github/pull_request_template.md`
- `.github/PULL_REQUEST_TEMPLATE.md`
- `docs/pull_request_template.md`
- `docs/PULL_REQUEST_TEMPLATE.md`
- `.github/PULL_REQUEST_TEMPLATE/*.md` (multiple-template directory)

See [references/template-paths.md](references/template-paths.md) for the full
lookup rules including case-sensitivity notes.

**If zero templates found:** generate What/Why/How. See section 4.2 below.

**If one template found:** `Read` it and fill it in. See section 4.3.

**If multiple templates found** (typically inside
`.github/PULL_REQUEST_TEMPLATE/`): use `AskUserQuestion` to let the user pick
which template applies. One option per file. Include a "none -- use
What/Why/How instead" option.

### 4.2 Generate What/Why/How (fallback)

See [references/template-what-why-how.md](references/template-what-why-how.md)
for the format and trivial-vs-non-trivial rules.

Collect inputs:

```bash
git log --pretty=format:"%H%n%s%n%b%n---END---" origin/<base>..HEAD
git diff --stat origin/<base>..HEAD
git diff origin/<base>..HEAD
```

Adaptive length rules:

- **What** -- always included. Bullet list of concrete changes derived from
  commit subjects. Collapse related commits (e.g., multiple `refactor(x):`
  commits into a single bullet).
- **Why** -- derived from commit message bodies and branch name. If commit
  bodies are sparse and the branch name tells the story (e.g.,
  `fix/session-timeout-regression`), that is enough; a single sentence is fine.
- **How** -- only include when the diff shows non-obvious technical approach:
  an architectural change, a non-trivial refactor, a performance-motivated
  change, or a workaround. Skip it for trivial PRs (docs, small tweaks,
  config, dependency bumps, test additions).

Never fabricate "Why" content that is not grounded in the commits, branch
name, or existing PR body. If you genuinely cannot infer it, write `TBD` and
flag it in the plan so the user can edit before confirming.

### 4.3 Fill in a detected template

- Read the template verbatim.
- Replace placeholder sections with content derived from commits and diff.
- Do not remove sections just because you have nothing to say; leave them with
  a short honest note ("No testing changes", "No new dependencies", etc.) or
  flag them for the user to review.
- Preserve any checklists (`- [ ]`) the template contains -- do not check
  them for the user.

### 4.4 Build the title

- If updating an existing PR, preserve the existing title unless the user asks
  to change it.
- For a new PR:
  - If the branch has a single commit, use that commit's subject as the title.
  - If multiple commits, derive a Conventional Commits style subject that
    summarizes the primary intent. Follow the user's `CLAUDE.md`: use
    `<type>[optional scope]: <description>`. Types: `feat`, `fix`, `docs`,
    `style`, `refactor`, `test`, `chore`, `build`, `ci`, `perf`.
  - Title should be <=70 characters; details go in the body.

**Writing style rules** (from the user's global `CLAUDE.md`):

- **Never use em-dashes (`--`) in titles or bodies.** Use commas, parentheses,
  or separate sentences.
- Focus on what changed and why, not ephemeral details. Do not include file
  counts, line counts, or commit counts in the body -- they go stale.

## Phase 5: Draft State

If `--draft` was passed, use draft. If `--ready` was passed, use ready.
Otherwise, use `AskUserQuestion` with:

1. **Draft** -- open as draft; you can flip to ready later with `gh pr ready`.
2. **Ready for review** -- open as ready.
3. **Cancel** -- exit without pushing.

When updating an existing PR: preserve its current state by default. Only use
the prompt (or flags) if the user explicitly wants to flip it.

## Phase 6: Plan Presentation

Before pushing or touching GitHub, show the full plan:

```
pr-create plan
---
Branch:       <current>
Base:         <base>  (resolved via: <explicit-arg|existing-pr|default>)
Ahead/Behind: <AHEAD> ahead, <BEHIND> behind
Action:       <create new PR | update PR #N>
Draft state:  <draft | ready>
Title:        <title>
Template:     <path or "What/Why/How (generated)">

Body:
<full rendered body>

Operations:
  - git push -u origin <current>
  - gh pr create --base <base> --head <current> \
      --title <...> --body-file <tempfile> [--draft]
    (or: gh pr edit <n> --title <...> --body-file <tempfile> \
         [--base <base> if changed])
```

Then ask the user to confirm. Offer three options via `AskUserQuestion`:

1. **Proceed**
2. **Edit body** -- show the body in an editable form; the user provides a
   revised version; re-present the plan.
3. **Cancel**

Never skip this gate.

## Phase 7: Execute

### 7.1 Push

```bash
git push -u origin <current>
```

- Use `-u` only for the initial push (no upstream yet). If upstream already
  exists, use plain `git push`.
- If the push fails because the remote has diverged, stop and tell the user
  to run `pr-rebase` first -- do not force-push from this skill.

### 7.2 Create or edit

Write the body to a tempfile so shell quoting does not mangle markdown:

```bash
BODY_FILE=$(mktemp)
cat > "$BODY_FILE" <<'EOF'
<rendered body>
EOF
```

**Create path:**

```bash
gh pr create \
  --base <base> \
  --head <current> \
  --title "<title>" \
  --body-file "$BODY_FILE" \
  [--draft]
```

**Update path** (existing PR):

```bash
gh pr edit <n> \
  --title "<title>" \
  --body-file "$BODY_FILE"
# If base changed:
gh pr edit <n> --base <new-base>
# If draft state flipped (only if user asked):
gh pr ready <n>           # draft -> ready
gh pr ready --undo <n>    # ready -> draft
```

Clean up the tempfile: `rm "$BODY_FILE"`.

### 7.3 Report

Print:

- The PR URL (from `gh pr create` output, or `gh pr view --json url --jq .url`
  for the update path).
- The action taken (created / updated).
- Draft state.
- Suggested next step if draft: `gh pr ready <n>` when ready for review.

## Error Handling

| Condition                        | Behavior                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dirty worktree                   | Warn in plan. User can abort or proceed; nothing in this skill requires a clean tree, but the PR will show stale state if uncommitted work exists |
| `gh` not authenticated           | Stop in Phase 1, suggest `gh auth login`                                                                                                          |
| Base branch not on origin        | Stop in Phase 2, tell the user which branch failed to resolve                                                                                     |
| Push rejected (non-fast-forward) | Stop, suggest `/pr-rebase`                                                                                                                        |
| `gh pr create` fails             | Surface the `gh` error verbatim; do not retry silently                                                                                            |
| PR template contains checkboxes  | Preserve them unchecked; do not check them on the user's behalf                                                                                   |

## Notes

- **No force-push.** This skill only uses plain `git push`. Force-pushing is
  the `pr-rebase` skill's job.
- **No description for update-path PRs unless requested.** If the user asked
  to refresh the description on an existing PR, do so; otherwise leave it
  alone. GitHub auto-updates the diff after push.
- **Conventional Commits are optional in the PR body**, but the title should
  follow the user's convention when practical.

## References

- [references/template-paths.md](references/template-paths.md) -- PR template
  search locations and precedence rules.
- [references/template-what-why-how.md](references/template-what-why-how.md) --
  What/Why/How fallback format with examples.
