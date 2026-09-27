---
name: pr-review
description: Reviews Git changes for correctness, security, performance, and maintainability, with optional evidence-based repository history and guarded inline GitHub PR submission. Triggers on "review code", "review changes", "check my code", "code review", "run /pr-review", or mentions "security review", "performance review", "code quality", "hotspot analysis", "risk assessment", "bug hotspots".
argument-hint: "[PR-number or URL | focus-area]"
allowed-tools: Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git show:*), Bash(git shortlog:*), Bash(sort:*), Bash(uniq:*), Bash(head:*), Bash(grep:*), Bash(gh pr view:*), Bash(gh pr diff:*), Bash(gh repo view:*), Bash(gh api:*), Bash(gh api user:*), Bash(bun:*), Read, Write, Grep, Glob, AskUserQuestion
effort: high
disable-model-invocation: true
---

# Review Git Changes

Review the change the user actually wants reviewed. Report concrete, actionable findings grounded in the diff and surrounding code. Repository history can point to areas worth inspecting, but churn, ownership, and reviewer agreement do not establish a defect or determine its severity.

**Arguments provided:** $ARGUMENTS

## Choose the change and audience

- For a PR number or URL, resolve that PR with `gh pr view` and review `gh pr diff <number>`. Record its URL, author login, head SHA (`headRefOid`), and **base** repository owner/name for possible submission. If an explicit PR cannot be resolved, stop rather than reviewing a different diff.
- For local uncommitted changes, inspect both `git diff` and `git diff --cached`. For a requested branch comparison, use the named base and include its committed changes. If a checked-out PR also has local changes and the request is ambiguous, ask which to review: GitHub's PR diff or the local changes. Never silently substitute one for the other.
- Read the changed code, its callers, tests, and project conventions as needed. Investigate relevant file history when it could explain a choice or a recurring failure, not as a mandatory repository-wide scoring exercise.
- An invocation by a human returns a concise Markdown review with file/line references, impact, and a proposed fix. Include positive observations when useful; do not fill empty severity categories. A reviewer dispatched by `code-reviewer` returns **only** the JSON findings array in [references/finding-schema.md](references/finding-schema.md). It never submits a review.

Judge severity by the demonstrated impact and likelihood of each defect. Do not promote a finding because its file has high churn, a single maintainer, or multiple reviewers who agree. Verify an alleged issue against the code before presenting it.

## Optional PR submission

A review is complete without posting anything. Only consider submission when the target is a PR, at least one finding exists, the current GitHub login is not the PR author, and a user is present to approve the write. Repository rules may forbid posting even when the user approves; follow them. Never post from a dispatched reviewer or an unattended run.

**All GitHub review writes go through** `$SKILL_DIR/scripts/submit-pr-review.ts`. Do not substitute `gh pr review`, `gh pr comment`, a hand-built API call, or another agent. The script anchors comments to right-hand diff lines, appends attribution, detects a moved head, names dropped findings, and refuses to lose a critical finding. Keep these mechanics in the script, not in prose.

When submission is allowed:

1. Create a JSON review document with a short or empty `summary` and `findings` following [references/finding-schema.md](references/finding-schema.md). Exclude unresolved or unverified claims, then strip orchestrator-only fields (`sources`, `contested`, `synthesisNote`) from supported findings. Keep each `description` short and independently understandable to the PR author; put optional mechanical fixes in `fix`. Do not put reviewer identities, corroboration, or other internal methodology in the review. Resolve `--human-name` from `gh api user --jq .login` and choose the executing agent's display name for `--agent-name`.
2. Preview with the script, passing the PR's **base** repository and the SHA captured when its diff was reviewed:

   ```bash
   bun "$SKILL_DIR/scripts/submit-pr-review.ts" \
     --pr <number> --owner <base-owner> --repo <base-repo> \
     --findings <review-json> --agent-name <agent> --human-name <login> \
     --expect-head <reviewed-head-sha> --dry-run
   ```

3. If the head moved, fetch the new diff and recheck every finding and anchor before previewing again. If any critical finding cannot anchor, stop and resolve it; never bypass the guard or silently downgrade it. Inspect **every** non-critical drop as well: re-anchor it, explicitly include it in the review summary if appropriate, or tell the user it will not be delivered. If nothing anchors, do not submit.
4. Show the PR URL, preview of the review body and inline comments, and any dropped findings. Ask the user whether to post **this** review. On approval, rerun the same command without `--dry-run`, retaining `--expect-head`. On failure, report what happened rather than retrying a write blindly. A moved head still requires re-review.

For multiple PRs, preview and confirm each separately in ascending PR-number order, never with concurrent prompts or a single blanket approval. To amend existing comments, use the same preview and confirmation gate with `--update-existing`; the script matches only unambiguous comments carrying this agent's attribution and reports unmatched findings. Do not treat an unmatched finding as posted. The author can also choose not to post; the local report remains the outcome.

If a parent agent coordinates the review, return the findings, reviewed head SHA, PR URL, and relevant submission context **as text** to that parent. The session with the user owns preview, approval, and any temporary findings file; a dispatched reviewer does not write report artifacts or GitHub reviews.

## Recovery and completion

- If the diff is empty, report that no reviewable changes were found; do not invent findings or offer submission.
- If a claim cannot be verified, investigate or omit it. A review with no findings is a valid result.
- If preview finds missing anchors or a moved PR, the review is incomplete until reconciled against the current diff; an idle reviewer or a completed dry run is not a submitted review.
- If the user declines posting, or the repository forbids it, finish with the local findings only.

The orchestrator's shared reviewer instructions and synthesis rules live in [references/reviewer-prompt.md](references/reviewer-prompt.md) and [references/synthesis-criteria.md](references/synthesis-criteria.md). The finding schema and submission script remain the source of truth for JSON shape and GitHub mechanics.
