---
name: pr-status
description: Shows a graph of all open PRs authored by the current GitHub user in the current repository, grouped by stack, plus any PRs merged remotely whose local branches still exist. Triggers on "show my PRs", "PR status", "PR graph", "open PRs", "my open pull requests", "what PRs do I have", "pr cleanup", or invocation via /pr-status.
allowed-tools: Bash(gh:*), Bash(git:*), Read, TodoWrite
disable-model-invocation: true
effort: low
---

# PR Status

Show a graph of the current user's open PRs in the current repository, grouped
by stack (via `/stacked-prs:stacked-prs status`), plus merged-remote PRs whose
local branches still exist and need cleanup.

## Quick Start

1. Detect user and repo
2. Collect open PRs and merged-but-local PRs
3. Group open PRs by stack membership
4. Render per-stack graphs via `/stacked-prs:stacked-prs status <name>`
5. Render flat sections for non-stacked open PRs and cleanup candidates

## Phase 1: Detect Context

```bash
# Current GitHub login
gh api user --jq .login

# Current repo (parse owner/name from origin URL)
gh repo view --json nameWithOwner --jq .nameWithOwner
```

If either command fails, report the error and stop. `gh` must be authenticated
and the working directory must be inside a git repo with a GitHub remote.

## Phase 2: Collect PRs

**Open PRs authored by the current user:**

```bash
gh pr list \
  --author @me \
  --state open \
  --json number,title,headRefName,baseRefName,isDraft,url,updatedAt,mergeable,statusCheckRollup \
  --limit 100
```

**Merged PRs whose local branches still exist:**

```bash
# Merged PRs by this user, recent first
gh pr list --author @me --state merged \
  --json number,title,headRefName,mergedAt,url --limit 50

# Local branch names
git for-each-ref --format='%(refname:short)' refs/heads/
```

Intersect `headRefName` values from the merged list with the local branch list.
The intersection is the cleanup set.

## Phase 3: Group Open PRs by Stack

For each open PR's `headRefName`, check for stack metadata:

```bash
git config --get "branch.<headRefName>.stack-name" || true
```

Branches with a `stack-name` belong to that stack; branches without are
"orphan" open PRs. Collect the unique stack names.

**Important:** only inspect stack metadata for branches that exist locally.
Remote-only branches have no local config and are orphans by definition here.

## Phase 4: Render Output

### Per-stack graphs

For each unique stack name found, invoke the stacked-prs skill to render its
status graph:

```
/stacked-prs:stacked-prs status <stack-name>
```

The `/stacked-prs:stacked-prs` skill renders the branch chain, PR numbers,
base targets, and sync state. Reference it by slash command only; do not
reimplement its graph. See the skill's own documentation for output details.

### Non-stacked open PRs

Render as a flat list:

```
Open (not in a stack)
  #123  feat: add widget            [branch: add-widget -> main]      draft
  #128  fix: null check             [branch: fix-null -> main]        checks failing
```

Include for each: PR number, title, head -> base, draft/ready state, CI
rollup status.

### Cleanup candidates

Render a final section listing merged PRs with surviving local branches:

```
Merged remotely, local branch still present
  #119  refactor: extract helper    [branch: extract-helper]  merged 2026-04-10
    Suggested: git branch -d extract-helper
```

Use `git branch -d` (safe delete) for the suggestion. If the branch isn't
fully merged into the local tracking branch, note that `-D` (force) may be
required and recommend verifying first.

## Phase 5: Summary Line

End with a one-line roll-up:

```
<N> open (<S> in stacks, <O> orphan), <C> awaiting local cleanup.
```

## Error Handling

- **Not in a git repo**: report and stop
- **No GitHub remote**: report and stop
- **gh not authenticated**: suggest `gh auth login`
- **No PRs found**: print "No open PRs authored by <user> in <repo>." and skip
  subsequent phases gracefully
- **Stack name refers to a branch that no longer exists**: pass through any
  error from `/stacked-prs:stacked-prs status` verbatim; do not mask it

## Notes

- Use `--author @me` rather than hardcoding a username so the skill is portable
- `gh pr list` defaults to the current repo from the git remote, no `--repo`
  flag needed
- The `mergeable` and `statusCheckRollup` fields are optional context for the
  flat list; omit if output becomes too noisy for large PR sets
