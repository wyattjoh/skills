---
name: pr-fix
description: Fetches PR review comments and failing CI checks, verifies each against the codebase, proposes a triaged plan (fix, push back, clarify, skip) for user approval, then silently implements fixes, posts reasoned replies only on disagreements or clarifications, auto-resolves fixed threads, and optionally commits the result. Triggers on "respond to PR review", "address review comments", "handle PR feedback", "fix PR comments", "fix CI failures", "fix failing checks", "address red CI", "process review", "triage PR comments", "run /pr-fix", or mentions "PR review response", "reply to reviewer", "CI failing on PR".
argument-hint: "[PR-number or URL] [--auto]"
allowed-tools: Bash(gh:*), Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git branch:*), Bash(git rev-parse:*), Bash(git add:*), Bash(git commit:*), Bash(jq:*), Bash(act:*), Bash(npm:*), Bash(bun:*), Bash(pnpm:*), Bash(yarn:*), Read, Edit, Write, Grep, Glob, TodoWrite, AskUserQuestion
disable-model-invocation: true
effort: high
---

# PR Review Response

Respond to PR review feedback with technical rigor. **Verify before
implementing. Ask before assuming. Technical correctness over social comfort.**

**Arguments provided**: $ARGUMENTS

## Core Principle

External feedback is a suggestion to evaluate, not an order to follow. Every
comment and every failed CI check gets checked against codebase reality before
any code changes or replies. Agreement is expressed through the diff,
disagreement through reasoned technical comments, and nothing is posted to
GitHub without explicit user confirmation.

## Non-Interactive Mode (`--auto`)

`--auto` exists so an outer loop — `/pr-land` — can call this skill without a
human present. It is never the default; a human invocation always gets the full
interactive flow described below.

When `--auto` is present in `$ARGUMENTS`:

| Phase                     | Behavior under `--auto`                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| Phase 3 (triage approval) | Gate is not shown. Proceed as if the user chose **"Proceed without posting replies"**        |
| Phase 4 (apply changes)   | Unchanged — apply `FIX`, `FIX-MODIFIED`, and `CI-FIX` edits                                  |
| Phase 5 (local verify)    | **Unchanged, and still authoritative.** A failed verification still aborts the pipeline      |
| Phase 6 (post replies)    | Skipped entirely. Nothing is written to GitHub                                               |
| Phase 7 (resolve threads) | Skipped entirely                                                                             |
| Phase 8 (commit)          | Skipped. Leave the worktree dirty                                                            |
| Phase 9 (summary)         | Print the normal summary **plus an explicit list of every file modified**, one path per line |

Phase 8 is skipped rather than automated because the caller may edit further
files after this skill returns (retrying a failed verification); a commit made
here would be stale. The modified-file list is the handoff — the caller stages
those paths by name.

The triage plan from Phase 3 is still printed, just not gated on. The run
remains fully auditable in the transcript.

## Output Contract

| Action                                      | Where                                                                                                                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agreed-upon fixes (comments + CI)           | Applied silently to code, no GitHub reply                                                                                                                                                                                                   |
| Disagreements / clarifications              | Posted as **threaded replies** on the originating inline review comment, after confirmation                                                                                                                                                 |
| Thread resolution                           | Auto-resolve threads whose fix was applied                                                                                                                                                                                                  |
| Failing CI checks                           | Listed alongside comments in the triage plan; agreed-upon code fixes applied silently; no GitHub posting; CI re-runs naturally on the user's next push                                                                                      |
| Local CI verification                       | Before posting replies or committing, every `CI-FIX` edit is verified locally via the project's native command (preferred) or `act` in Docker (fallback). If any verification still fails, the skill aborts before any GitHub state changes |
| Top-level PR comments                       | **Never posted.** The skill must not create new issue comments or review bodies under any condition                                                                                                                                         |
| PR-level feedback that has no inline thread | Surfaced in the terminal summary for the user to handle manually; the skill does not post a reply                                                                                                                                           |
| Optional commit                             | After applying changes and passing local verification, the skill asks once whether to commit; if yes, creates a single Conventional Commits commit limited to files it edited; never pushes                                                 |
| Terminal run summary                        | Shown to user only, never posted to GitHub                                                                                                                                                                                                  |

## Phases

Use `TodoWrite` to track each phase as a task.

### Phase 1: Identify PR and Fetch Comments + CI Checks

1. Resolve PR number: use `$ARGUMENTS` if a number or URL was supplied, else
   `gh pr view --json number,headRefName,baseRefName,headRepository,url`.
2. Pull the three comment surfaces plus the GraphQL review-thread graph for
   resolution IDs. See [references/github-api.md](references/github-api.md) for
   exact queries.
3. Partition comments into two sets:

   **Replyable (inline review comments only):**
   - From `/pulls/{n}/comments`, keep threads whose GraphQL
     `isResolved == false` and `isOutdated == false`
   - These are the only comments that can receive replies and resolutions,
     because they are the only surface with a thread API

   **Context-only (no reply path, read for awareness):**
   - PR-level issue comments from `/issues/{n}/comments` posted after the PR
     author's last push (`created_at` vs branch head commit date)
   - Reviewer summary bodies from `/pulls/{n}/reviews` with state
     `CHANGES_REQUESTED` or `COMMENTED`

   Context-only comments inform triage (e.g., the reviewer's overall framing)
   but must never be responded to by the skill. If they contain actionable asks
   that are not also mirrored in an inline thread, flag them in the terminal
   summary for manual follow-up.

   Discard bot noise (match `user.type == "Bot"`), outdated threads, and
   reactions-only comments from both sets.

4. Pull failing CI checks for the PR's head ref. See
   [references/ci-checks.md](references/ci-checks.md) for exact commands.

   Keep checks where `bucket` is `fail` or `cancel`. Checks with `bucket ==
"pending"` are not actionable yet, so omit them and note their count in the
   terminal summary.

   For each qualifying check, parse the workflow run ID from `link` and
   pull the failed log slice (`gh run view <runId> --log-failed`, last ~200
   lines retained for the verification step). The log slice is what Phase 2b
   reasons over.

### Phase 2a: Verify Each Comment

For every kept comment, run this checklist against the codebase. Do not skip
steps even if the feedback "obviously" looks right.

1. **Understand**: restate the reviewer's point in a single sentence. If
   ambiguous, mark as `CLARIFY` and move on (do not guess).
2. **Locate**: read the file + surrounding context using `path` and `line` from
   the comment payload. Use `Read`, `Grep`, `Glob`.
3. **Check correctness for THIS codebase**:
   - Does the suggestion actually improve behavior here, given existing
     patterns?
   - Does it break existing tests, types, or callers? Grep for usages.
   - Is there a reason the current code looks the way it does (comment, git
     blame, adjacent code)?
   - Is the suggested feature actually used anywhere (YAGNI)?
4. **Classify** into exactly one bucket:

   | Bucket         | Meaning                                                                                                                              |
   | -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
   | `FIX`          | Reviewer is correct for this codebase; implement as requested                                                                        |
   | `FIX-MODIFIED` | Underlying concern is valid, but the exact fix needs adjustment; implement the adjusted version and note the deviation in a reply    |
   | `PUSHBACK`     | Suggestion is incorrect, unsafe, violates YAGNI, or conflicts with an existing architectural decision; draft a technical explanation |
   | `CLARIFY`      | Ambiguous or missing context; draft a specific question                                                                              |
   | `SKIP`         | Already addressed in a later commit, outdated, non-actionable (LGTM, thanks)                                                         |

5. **Draft reply text** for `FIX-MODIFIED`, `PUSHBACK`, and `CLARIFY` only. Skip
   drafting for `FIX` and `SKIP`.

Reply-drafting rules (from `superpowers:receiving-code-review`):

- No `"You're absolutely right!"`, `"Great point!"`, or any gratitude.
- Lead with the technical reasoning, not the conclusion.
- Reference concrete evidence: file paths with line numbers, test names, commit
  SHAs, or doc links.
- For `PUSHBACK`, invite correction: end with a specific question ("Am I missing
  a caller?") rather than a verdict.

### Phase 2b: Verify Each Failed Check

For every failing CI check kept in Phase 1, run this checklist. CI failures are
not human suggestions, so the bucket vocabulary differs from comments.

1. **Read the log slice**: load the last ~200 lines from
   `gh run view <runId> --log-failed`. Extract the first concrete error line
   (failed assertion, compiler diagnostic, missing dependency, exit code), not
   the surrounding noise.
2. **Locate**: open the file(s) referenced in the error using `Read`/`Grep`. If
   the failure is environmental (missing secret, network timeout, runner crash),
   there is no file to open; capture the indicator that establishes that.
3. **Cross-reference recent commits on this branch**: a failure on an older
   commit may already be addressed by a later commit.
   `git log --oneline <baseRef>..HEAD` to scan, then check whether the failing
   line still exists in `HEAD`.
4. **Classify** into one of these CI buckets:

   | Bucket     | Meaning                                                                                                                                                                |
   | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `CI-FIX`   | The branch's code is broken; identifiable code change makes the check pass                                                                                             |
   | `CI-FLAKE` | Failure pattern is known-flaky (random network, timing, retried test); no code change, will pass on re-run                                                             |
   | `CI-INFRA` | Failure is environmental (runner crash, missing secret, registry outage, `action_required` approval gate); no code change pr-fix can make, surface for manual handling |
   | `CI-SKIP`  | Already addressed in a later commit on this branch, or the check is non-actionable here (e.g. preview deploy that needs the user to merge first)                       |

   See [references/ci-checks.md](references/ci-checks.md) for the bucketing
   heuristics applied to each `conclusion` value.

5. **Draft the fix plan** for `CI-FIX`: the specific edit(s) to apply, expressed
   as `path:line - change description`. No GitHub reply is drafted (CI is not a
   human reviewer); the fix speaks through the diff.

### Phase 3: Present the Triage Plan

Before touching code or GitHub, show the user a single plan with this shape:

```
PR #<n>: <title>
Branch: <head> -> <base>

═══ Review comments ═══

FIX (N)
  - [path:line] <one-line summary of fix>
  ...

FIX-MODIFIED (N)
  - [path:line] Reviewer asked X. Doing Y because Z.
    Planned reply: "<draft>"
  ...

PUSHBACK (N)
  - [path:line] Reviewer: "<quoted point>"
    Planned reply: "<draft>"
  ...

CLARIFY (N)
  - [path:line] Reviewer: "<quoted point>"
    Planned reply: "<draft question>"
  ...

SKIP (N)
  - [path:line] Reason: <already addressed in <sha> | outdated | non-actionable>

═══ CI failures ═══

CI-FIX (N)
  - [job-name @ workflow] Root cause: <one line from log>
    Plan: <path:line - change to apply>
  ...

CI-FLAKE (N)
  - [job-name @ workflow] Marked flaky because: <evidence from log>
    Plan: no code change; will pass on re-run after the user's next push
  ...

CI-INFRA (N)
  - [job-name @ workflow] Environment issue: <runner crash | missing secret | approval gate | ...>
    Plan: no code change; surfaced for manual handling
  ...

CI-SKIP (N)
  - [job-name @ workflow] Reason: <already addressed in <sha> | not actionable here>
  ...

In-progress / queued checks omitted from triage: <count>
```

Omit any section whose count is zero so the plan stays compact.

Then ask for confirmation using `AskUserQuestion` with these explicit choices:

1. **Proceed** (apply all FIX + FIX-MODIFIED + CI-FIX edits, post all drafted
   comment replies, resolve fixed threads)
2. **Proceed without posting replies** (code changes only — including CI-FIX
   edits — keep all threads open)
3. **Edit the plan** (user specifies which items to move between buckets or
   which reply drafts to revise)
4. **Cancel**

Never skip this gate. Even a single-comment, single-failure PR goes through it.
The sole exception is `--auto`, where option 2 is taken automatically — see
[Non-Interactive Mode](#non-interactive-mode---auto).

### Phase 4: Apply Code Changes

Only after Proceed or Proceed-without-replies:

1. Implement `FIX`, `FIX-MODIFIED`, and `CI-FIX` items one at a time,
   smallest/safest first. CI-FIX edits are applied with the same caution as
   comment fixes; the log was the source of truth, but the verification work in
   Phase 2b chose the actual edit.
2. After each edit, re-read the file to confirm the change looks right in
   context.
3. **Track the exact set of files this skill modified.** Phase 8 will use this
   list to stage selectively, so do not lose it.
4. Run formatters/linters if the project defines them (check `package.json`,
   `deno.json`, `Makefile`, `.pre-commit-config.yaml`).
5. Do **not** commit or push at this point. Phase 8 handles the optional commit;
   pushing is always the user's decision.

### Phase 5: Local CI Verification

Skip this phase entirely if no `CI-FIX` edits were applied in Phase 4. Otherwise
this gate runs **before** any GitHub state changes (replies, resolutions,
commits) so a failed verification leaves the working tree dirty but the PR
untouched.

For every `CI-FIX` item from the triage plan:

1. **Choose a verification method.** Try methods in order; stop at the first
   that fits.
   - **Native command (preferred).** Map the failing job to a project-native
     command using these heuristics:
     - typecheck failures → `tsc --noEmit`, `bun run check`, or the project's
       `typecheck` script
     - lint failures → the project's `lint` script (e.g. `npm run lint`,
       `bun run lint`, `pnpm run lint`)
     - test failures → the project's test runner scoped to the failing test if
       possible (e.g. `bun test path/to/file`, `bun test -t '<name>'`,
       `pnpm test -- <path>`)
     - build failures → the project's `build` script
     - Inspect `package.json` `scripts`, `deno.json` `tasks`, or `Makefile`
       targets to find the right invocation. If multiple candidates fit, pick
       the one whose name most closely matches the failing job name.
   - **`act` fallback.** If no clear native mapping exists, replay the actual
     workflow job in Docker:
     ```bash
     act -W .github/workflows/<workflow>.yml -j <job-name> --reuse \
       --container-architecture linux/amd64
     ```
     Use `--reuse` to keep the container across CI-FIX items in the same run.
     See [references/ci-checks.md](references/ci-checks.md) for image selection,
     secrets handling (1Password injection), and platform notes.
   - **Skip with a note.** For checks that cannot be replayed locally (Vercel or
     Netlify deploy previews, `action_required` approval gates, self-hosted
     runner jobs), record the skip reason and continue. These should already be
     classified as `CI-INFRA` or `CI-SKIP` and not reach this phase as `CI-FIX`;
     if one does, treat it as a triage error and surface in the summary.

2. **Tool availability checks** (run once at the start of the phase, not per
   item):
   - If a native command is needed, confirm the script/task exists before
     invoking. Missing scripts mean the project's local toolchain isn't wired
     the way pr-fix assumed; record the verification as
     `unverified
(no native command)` and proceed without blocking.
   - If `act` is needed, run `which act`. If missing, record the verification as
     `unverified (act not installed)`, suggest `brew install act` in the
     summary, and proceed without blocking.
   - If Docker is needed for `act`, confirm `docker info` returns a healthy
     daemon. If Docker is down, record `unverified (docker unavailable)` and
     proceed without blocking.

   Record these as `unverified` rather than `failed`. Unverified means we
   couldn't run the check; failed means we ran it and the fix didn't hold.

3. **Run the verification** and capture the exit code plus the last ~100 lines
   of combined stdout/stderr.

4. **Aggregate** results across all `CI-FIX` items:
   - **All passed (or unverified due to missing tools).** Continue to Phase 6.
     Mention any unverified items in the Phase 9 summary so the user knows what
     wasn't proven locally.
   - **Any item failed.** Abort the post-apply pipeline:
     - Skip Phase 6 (no replies posted)
     - Skip Phase 7 (no threads resolved)
     - Skip Phase 8 (no commit)
     - Jump straight to Phase 9 (terminal summary), surfacing for each failed
       item: the job name, the fresh log slice (last ~100 lines), and the
       proposed-but-not-effective fix path
     - Suggest next steps: revise the fix and rerun `/pr-fix`, or revert the
       Phase 4 edits with `git restore <paths>` and start over

The working tree keeps the Phase 4 edits regardless of outcome. The user can
inspect the diff with `git diff` and decide whether to keep, revise, or revert.

### Phase 6: Post Replies (Only If User Chose "Proceed")

All replies must go on an **inline review thread**. There is no fallback path.
If a draft has no associated inline comment ID, it cannot be posted by this
skill.

For each `FIX-MODIFIED`, `PUSHBACK`, and `CLARIFY` draft:

1. Resolve the **root comment ID** of the thread. For comments that are
   themselves replies (`in_reply_to_id != null`), walk back to the root: the
   root is the comment whose `in_reply_to_id` is null and which shares the same
   `pull_request_review_thread` in GraphQL.
2. Post via `POST /repos/{owner}/{repo}/pulls/{n}/comments/{root_id}/replies`.
   See [references/github-api.md](references/github-api.md).
3. Never call `POST /issues/{n}/comments` or `POST /pulls/{n}/reviews` from this
   skill. Top-level PR comments and new review submissions are both out of
   scope.
4. If the API returns a 4xx, stop and report which reply failed with its thread
   ID. Do not retry silently and do not fall back to any other endpoint.
5. If a draft somehow lacks a thread root (e.g. the triage logic mistakenly
   attached it to a context-only comment), skip posting it and surface it in the
   terminal summary under "Replies not posted — no inline thread available" so
   the user can decide what to do manually.

CI buckets do not generate replies — failed checks have no thread to post to.

### Phase 7: Resolve Fixed Threads

For each `FIX` and `FIX-MODIFIED` whose reply (if any) posted successfully,
resolve the corresponding review thread via GraphQL `resolveReviewThread`
mutation. Leave `PUSHBACK` and `CLARIFY` threads open — resolution belongs to
the reviewer in those cases. CI buckets have no GitHub thread to resolve.

### Phase 8: Commit Confirmation

Skip this phase entirely under `--auto` (the caller commits), or if Phase 4
produced no edits (everything was `PUSHBACK`, `CLARIFY`, `SKIP`, `CI-FLAKE`,
`CI-INFRA`, or `CI-SKIP`).

Otherwise, draft a Conventional Commits message that summarizes what was
addressed. Example:

```
fix(review): address PR #<n> feedback and CI failures

- <bullet for each FIX / FIX-MODIFIED item: path - one-line description>
- <bullet for each CI-FIX item: job-name - one-line description>
```

Then ask via `AskUserQuestion`:

1. **Commit with this message** (Recommended) — show the drafted message; on
   confirmation, stage and commit.
2. **Commit with a different message I'll provide** — collect a replacement;
   stage and commit with it.
3. **Don't commit** — leave the working tree dirty for the user.

If the user picks a commit option:

1. Stage **only the files this skill modified in Phase 4**, by exact path:
   ```bash
   git add <path1> <path2> ...
   ```
   Never `git add .` or `git add -A`. Pre-existing dirty state in the worktree
   must not be swept into this commit.
2. Commit using a HEREDOC to preserve formatting:
   ```bash
   git commit -m "$(cat <<'EOF'
   <chosen message>
   EOF
   )"
   ```
3. Do **not** push. Pushing is the user's decision; it is also the trigger that
   re-runs CI.

If `git commit` fails (e.g., a pre-commit hook rejects the change), report the
failure and stop. Do not amend, do not retry with `--no-verify`, and do not
silently leave files staged without telling the user.

### Phase 9: Terminal Summary

Print to the user (not to GitHub):

- Comment fixes applied (count + list of paths)
- CI fixes applied (count + list of `<job-name> -> <path>`)
- Local CI verification: per `CI-FIX` item, one of `passed (native: <cmd>)` |
  `passed (act)` | `failed (native: <cmd>)` | `failed (act)` |
  `unverified (no native command)` | `unverified (act not installed)` |
  `unverified (docker unavailable)`. Include the fresh log slice for any
  `failed` entry.
- Replies posted (count + thread IDs); `0 (verification failed)` if Phase 5
  aborted the pipeline
- Threads resolved (count); `0 (verification failed)` if Phase 5 aborted
- CI failures left for manual handling (count + list of `CI-INFRA` and any
  `CI-SKIP` items the user should know about)
- In-progress / queued checks omitted from triage (count)
- Commit status: `committed <sha>: <subject>` | `not committed (user opted out)`
  | `not committed (no code changes)` | `not committed (verification failed)` |
  `not committed (--auto: caller commits)` | `commit failed: <reason>`
- Under `--auto` only: `Modified files:` followed by one path per line, so the
  caller can stage exactly these paths
- Next suggested step:
  - If verification passed and a commit was made: push the branch when ready; CI
    re-runs automatically on push.
  - If verification failed: review the fresh log slice, revise the CI-FIX edit
    in the working tree (or `git restore <paths>` to start over), then rerun
    `/pr-fix`.

## Error Handling

| Condition                                                                  | Behavior                                                                                                                                                             |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No PR found for current branch                                             | Stop, tell user, suggest pushing the branch or supplying a PR number                                                                                                 |
| Comment references a file not in the worktree                              | Move to `CLARIFY`, note the mismatch in the draft reply                                                                                                              |
| Failed log fetch returns nothing (e.g. `gh run view` 404 on a deleted run) | Move that check to `CI-INFRA` with reason "log unavailable", surface in summary                                                                                      |
| `link` does not match the GitHub Actions URL pattern (third-party check)   | Skip log fetch, classify based on `name` + `description` only; bucket conservatively as `CI-INFRA` if uncertain                                                      |
| GraphQL or REST auth failure                                               | Stop before Phase 4, report the failing command                                                                                                                      |
| Pre-existing dirty worktree                                                | Warn before Phase 4; ask whether to proceed or stash first. If the user proceeds, the Phase 8 commit still stages only files this skill modified                     |
| `act` or `docker` unavailable in Phase 5                                   | Record verification as `unverified` for affected items, do **not** block; surface in the Phase 9 summary with install hint (`brew install act`, start Docker daemon) |
| Phase 5 verification fails on any CI-FIX                                   | Skip Phases 6/7/8 entirely; jump to Phase 9 with the fresh log slice and revise/rerun guidance. Working tree keeps the Phase 4 edits                                 |
| `git commit` fails in Phase 8                                              | Stop, report the failing command and any hook output, leave files staged for the user                                                                                |

## References

- [references/github-api.md](references/github-api.md): exact `gh` and GraphQL
  commands for fetch, reply, and resolve.
- [references/ci-checks.md](references/ci-checks.md): exact commands for
  fetching CI checks, parsing run IDs, pulling failure logs, and bucketing each
  `conclusion` value.
- [references/triage-examples.md](references/triage-examples.md): worked
  examples of bucket classification and reply drafts (comments + CI).
