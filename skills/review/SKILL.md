---
name: review
description: Performs comprehensive code review of Git changes with security, performance, and quality analysis, including repository health diagnostics (churn, bug hotspots, bus factor, momentum, crisis patterns) cross-referenced against the current diff for risk assessment. Triggers on "review code", "review changes", "check my code", "code review", "run /review", or mentions "security review", "performance review", "code quality", "hotspot analysis", "risk assessment", "bug hotspots".
argument-hint: "[focus-area]"
allowed-tools: Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git show:*), Bash(git shortlog:*), Bash(sort:*), Bash(uniq:*), Bash(head:*), Bash(grep:*), Bash(gh pr view:*), Bash(gh pr diff:*), Bash(gh api:*), Bash(gh api user:*), Bash(bun:*), Read, Write, Grep, Glob, TodoWrite, AskUserQuestion
effort: high
---

# Comprehensive Code Review

Perform a thorough code review of all Git changes (both staged and unstaged) with security, performance, and quality analysis.

**Focus Area**: $ARGUMENTS (if provided, emphasize this area in the review)

## Submission Invariant (read this first)

If the review is going to be posted to GitHub, you **MUST** route the submission through `$SKILL_DIR/scripts/submit-pr-review.ts`. This is the only sanctioned path. The script builds a proper GitHub review with inline comments anchored to the PR's right-hand hunks; bypassing it produces a single prose comment that nobody reads as a review.

Never use any of these shortcuts, even "just this once":

- `gh pr review --body` / `gh pr review --body-file`
- `gh pr comment`
- `gh api -X POST /repos/.../pulls/<n>/reviews` with a handcrafted body
- Writing the review to a tempfile and piping it through `gh`
- Dispatching a sub-agent to "just post this"

If you find yourself writing markdown headers like "## Code Review" into a tempfile and then reaching for `gh`, **stop** — you have left the sanctioned path. The script is the path.

Additional rules the script enforces at runtime:

- **Abort on critical drop.** If a finding with `severity: "critical"` anchors to a line outside the PR diff, the script aborts instead of silently dropping it. Re-anchor, downgrade, or remove — do not ignore.
- **No methodology chrome.** The script rejects review text that mentions the parallel reviewers, synthesis, corroboration, contested findings, or confidence tags. The PR review must read as if a human wrote it. "Reviewed with Opus + Codex second-opinion validation." and "(codex confirmed)" are disallowed. Rewrite into plain review prose.

## Output Audience

This skill has two invocation paths, and the output differs for each. Pick the
right one before writing a single character of output.

| Invocation                                            | Audience           | Output format                                                                                                                                    |
| ----------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| User runs `/review` directly                          | Human              | **Markdown only.** Follow the "Output Format" section below (Executive Summary, Critical Issues, etc.). Do **not** print the JSON finding array. |
| `code-reviewer` agent dispatches a reviewer sub-agent | Orchestrator agent | JSON array per [references/finding-schema.md](references/finding-schema.md), for programmatic synthesis.                                         |

If you are uncertain which path you are on, you are on the user-facing path:
emit markdown, never JSON.

## Step 0a: Resolve PR Context

Before the local-diff pipeline runs, determine whether this invocation is scoped to a GitHub pull request. PR mode changes the diff source and enables the optional submission flow in Step 9.

1. If `$ARGUMENTS` is a PR number (e.g., `123`) or a PR URL (e.g., `https://github.com/acme/widgets/pull/123`), resolve with:

   ```bash
   gh pr view <n> --json number,headRepository,baseRefName,author,headRefName,url
   ```

   Capture `pr_number`, `owner` (from `headRepository.owner.login`), `repo` (from `headRepository.name`), `pr_author` (from `author.login`), `pr_url`. Set `pr_mode = true`.

2. Else, try resolving from the current branch:

   ```bash
   gh pr view --json number,headRepository,baseRefName,author,headRefName,url
   ```

   If the command succeeds and returns a PR, capture the same fields and set `pr_mode = true`.

3. Else, set `pr_mode = false` and proceed with today's working-tree flow.

**Failure mode:** if `$ARGUMENTS` clearly intends PR mode (a PR reference was supplied) but the `gh pr view` lookup fails, abort with a clear error. Do not silently fall through to working-tree mode.

## Step 0: Repository Health Context

Before examining the diff, build a risk profile of the repository. These five commands surface files and patterns that deserve extra scrutiny during the review. Run all five.

```bash
# 1. High-churn files (20 most-changed in the last year)
#    Frequently changed files signal maintenance hotspots and defect clusters.
git log --format=format: --name-only --since="1 year ago" | sort | uniq -c | sort -nr | head -20

# 2. Team structure & bus factor
#    Reveals knowledge concentration and active vs historical maintainers.
git shortlog -sn --no-merges

# 3. Bug hotspots (files recurring in fix/bug/broken commits)
#    Maps the areas that get repeatedly patched.
git log -i -E --grep="fix|bug|broken" --name-only --format='' | sort | uniq -c | sort -nr | head -20

# 4. Project momentum (monthly commit frequency)
#    Exposes velocity patterns and team transitions.
git log --format='%ad' --date=format:'%Y-%m' | sort | uniq -c

# 5. Crisis patterns (reverts, hotfixes, emergencies, rollbacks in the last year)
#    Indicates deployment confidence and process reliability.
git log --oneline --since="1 year ago" | grep -iE 'revert|hotfix|emergency|rollback'
```

**Cross-reference for risk assessment (critical step):**

After Step 1 produces the list of changed files, check each one against the outputs above:

- **Changed file appears in #1 (high-churn)** -> raise review severity by one level; the file has a history of instability.
- **Changed file appears in #3 (bug hotspots)** -> treat as high-risk; scrutinize error handling, edge cases, and test coverage aggressively.
- **Changed file is owned by a single contributor per #2** -> flag bus-factor risk in the review summary.
- **Recent crisis activity per #5 touches related areas** -> call out in the Executive Summary and question whether this change could reintroduce or compound a prior incident.

Record the risk profile before proceeding so it informs every subsequent section. Source: Piechowski, "Git Commands Before Reading Code" (https://piechowski.io/post/git-commands-before-reading-code/).

## Step 1: Gather Context

When `pr_mode == true`, the review diff is the PR's own diff:

```bash
gh pr diff <pr_number>
```

Note: this is the diff shown on github.com for the PR. Uncommitted local edits to a checked-out PR branch are **not** included; if the user wants those reviewed, they should run `/review` without a PR argument on a branch with no associated PR.

When `pr_mode == false`, analyze the current Git state:

```bash
git status                    # Current state
git diff --cached --stat      # Staged changes summary
git diff --stat               # Unstaged changes summary
git log -5 --oneline          # Recent commits for context
```

Then read the actual diffs:

```bash
git diff --cached             # Full staged diff
git diff                      # Full unstaged diff
```

## Review Sections

### 1. Git Changes Analysis

- Examine all modified, added, and deleted files
- Review the scope and nature of changes
- Check for large file modifications that might need special attention
- Identify files that may have unintended changes

### 2. Code Quality Review

| Area                    | What to Check                           |
| ----------------------- | --------------------------------------- |
| **Style & Conventions** | Adherence to project coding standards   |
| **Complexity**          | Overly complex functions or classes     |
| **Pattern Consistency** | Consistent architectural patterns       |
| **Dead Code**           | Unused variables, functions, or imports |
| **DRY Violations**      | Code duplication opportunities          |
| **Naming**              | Variable, function, and class naming    |
| **Organization**        | File structure and module organization  |

### 3. Security Review

| Area                 | What to Check                                  |
| -------------------- | ---------------------------------------------- |
| **Secrets**          | Hardcoded credentials, API keys, passwords     |
| **Input Validation** | Proper sanitization of user inputs             |
| **SQL Injection**    | Database queries for injection vulnerabilities |
| **XSS Prevention**   | Proper output escaping in web contexts         |
| **Auth/AuthZ**       | Access control implementations                 |
| **Dependencies**     | Potentially vulnerable dependencies            |
| **Data Exposure**    | Sensitive data logging or exposure             |

### 4. Performance Analysis

| Area           | What to Check                                     |
| -------------- | ------------------------------------------------- |
| **Algorithms** | Inefficient algorithms or data structures         |
| **Database**   | N+1 queries, missing indexes, inefficient queries |
| **Memory**     | Potential memory leaks or excessive allocations   |
| **Frontend**   | Unnecessary re-renders, large bundle sizes        |
| **Caching**    | Areas that could benefit from caching             |
| **Async**      | Proper use of asynchronous patterns               |

### 5. Error Handling & Reliability

| Area            | What to Check                    |
| --------------- | -------------------------------- |
| **Exceptions**  | Proper try/catch implementations |
| **Propagation** | Error handling strategies        |
| **Degradation** | Graceful failure handling        |
| **Logging**     | Logging levels and completeness  |
| **Validation**  | Comprehensive input validation   |

### 6. Testing Considerations

| Area             | What to Check                      |
| ---------------- | ---------------------------------- |
| **Coverage**     | New functionality that needs tests |
| **Edge Cases**   | Edge cases that should be tested   |
| **Test Quality** | Existing test modifications        |
| **Integration**  | Integration points needing tests   |
| **Mocks**        | Proper use of test doubles         |

### 7. Documentation Review

| Area           | What to Check                           |
| -------------- | --------------------------------------- |
| **Comments**   | Missing or outdated comments            |
| **Docstrings** | Function documentation and parameters   |
| **API Docs**   | Updated API documentation needs         |
| **README**     | Changes requiring documentation updates |

### 8. Best Practices Compliance

| Area            | What to Check                                |
| --------------- | -------------------------------------------- |
| **SOLID**       | Adherence to design principles               |
| **Patterns**    | Appropriate use of design patterns           |
| **Separation**  | Proper separation of concerns                |
| **Config**      | Hardcoded values that should be configurable |
| **Environment** | Environment-specific code handling           |

## Output Format

Provide a structured review with these sections:

### Executive Summary

High-level overview of changes and overall assessment.

### Critical Issues (Must Fix)

Security vulnerabilities, bugs, breaking changes.

### High Priority

Important improvements for performance and maintainability.

### Medium Priority

Good-to-have improvements for code quality and conventions.

### Low Priority

Minor suggestions for style and optimizations.

### Positive Highlights

Well-implemented aspects worth noting.

### Action Items

Specific, actionable recommendations.

## Issue Format

For each issue, include:

```markdown
**[SEVERITY] Issue Title**

- **File**: path/to/file.ts:123
- **Problem**: Clear description of the issue
- **Suggestion**: How to fix it
- **Impact**: Risk level (Critical/High/Medium/Low)
```

## Guidelines

- Be thorough but constructive
- Prioritize issues by impact
- Provide specific line references where applicable
- Suggest solutions, not just problems
- Acknowledge good practices

## Step 9: PR Submission (conditional)

Runs only if **all three** conditions hold:

1. `pr_mode == true` (resolved in Step 0a).
2. The current GitHub user is not the PR author:

   ```bash
   gh api user --jq .login
   ```

   Compare to `pr_author` from Step 0a. If equal, skip Step 9 entirely. No prompt, no submission. The markdown report is the final output.

3. The review produced at least one finding.

When all three hold, drive this flow:

1. Resolve the attribution values before assembling the review:
   - `agent_name`: the current executing agent's display name, such as `Codex` or `Claude`.
   - `human_name`: run `gh api user --jq '.name // .login'` and use its output.

   The submission script appends this footer to the review body and every inline comment:

   ```markdown
   ###### Sent from <agent name>

   - [ ] reviewed by <human name>
   ```

   Do not add the footer to the findings file yourself. Pass the resolved values to the submission script with `--agent-name` and `--human-name`.

2. Assemble a review document and write it to a tempfile using `Write`:

   ```json
   {
     "summary": "<short prose, often empty; see rules below>",
     "findings": [<Finding>, ...]
   }
   ```

   Findings match the shape in `references/finding-schema.md`. **Only `description` plus the generated footer is posted inline** to the PR; the other fields are orchestrator bookkeeping. Inline any code reference the reader needs directly into `description` (backticks or fenced blocks) — there is no separate evidence block. **Strip orchestrator-internal fields** (`sources`, `contested`, `synthesisNote`) before writing. **Do not mention the review methodology** (no "Opus", "Codex", "corroborated", "contested", "synthesis", "second-opinion", "(codex confirmed)", "reviewed with..."). The script rejects these tokens; if your text hits them, rewrite to plain review prose.

   **Keep `summary` short or empty.** It becomes the review body (before the generated footer, with no `## Code review` heading). One or two sentences max, and only when you have something meaningful to add on top of the inline comments. When there's nothing to add, pass `""`; the required footer still appears in the review body.

3. Invoke the submission script with `--dry-run` to preview the payload:

   ```bash
   bun $SKILL_DIR/scripts/submit-pr-review.ts \
     --pr <pr_number> \
     --owner <owner> --repo <repo> \
     --findings <tempfile-path> \
     --agent-name <agent_name> \
     --human-name <human_name> \
     --dry-run
   ```

   Parse the JSON on stdout. Fields: `payload` (the assembled review), `counters` (`{ inline, dropped, critical_dropped }`), `critical_dropped` (the specific findings, if any).

4. **Critical-drop abort.** If the script exits with code 2 or `counters.critical_dropped > 0`, stop. Show the user the criticals (path:line + title) and explain they would be silently dropped. Offer to re-anchor them (pick a line that IS in the diff) or downgrade severity, then retry. Do not submit.

5. **Empty-anchorable short-circuit:** if `counters.inline == 0` and `counters.critical_dropped == 0`, do not prompt. Tell the user "no findings anchor to the PR diff; nothing to submit" and stop.

6. Otherwise, present to the user:
   - PR URL
   - First ~15 lines of `payload.body`, including the attribution footer
   - `counters.inline` (inline comments to post)
   - `counters.dropped` (non-critical findings not anchorable, skipped)

7. Ask for confirmation with `AskUserQuestion`:

   > "Submit this review to `<pr_url>`?" — options: `yes`, `skip`.

8. On `yes`: re-run the script with the same `--agent-name` and `--human-name` flags, without `--dry-run`. On success the script prints the submitted review's `html_url` to stdout; show it to the user. On non-zero exit, surface the stderr message and do not retry.

9. On `skip`: print nothing further. The markdown report stands.

### Multi-PR Batch Mode

When the parent session is reviewing N PRs in parallel (e.g., "review each of `<author>`'s open PRs"):

- Each PR gets its own Step 9 flow with its own confirmation. Do **not** collapse into a single "submit all?" prompt — per-PR confirmation is intentional.
- **Serialize the confirmations deterministically.** Even if the reviews ran in parallel, present Step 9 for one PR at a time in **ascending PR number order**. The loop is: present preview → `AskUserQuestion` → **await the answer** → act on it → only then move to the next PR. No concurrent prompts, no ordering based on which sub-agent happened to finish first. Sort the collected reviews by `pr_number` before entering the loop.
- A skip on one PR does not cancel the others. Continue to the next.
- If any PR's submission hits a critical-drop abort, surface it (show the blocking findings) and continue to the next PR. Do not silently skip, but do not block the rest of the batch either.

### Boundary Conditions

- **Self-authored PR**: Step 9 is skipped. Markdown report is the only output. No prompt.
- **PR resolve failure with explicit argument**: abort; do not silently fall back to working-tree mode (see Step 0a).
- **Orchestrator path**: when dispatched as a sub-reviewer by the `code-reviewer` agent via `references/reviewer-prompt.md`, emit findings as JSON per `references/finding-schema.md` and stop. Sub-reviewers must never run Step 9. Submission is the orchestrator's concern, not individual reviewers'.
- **Dispatched as a subagent with no direct user**: if you were spawned as a subagent (e.g. the parent session dispatched you in a worktree) and no user is available to answer `AskUserQuestion`, **do not submit**. Instead, write the findings file to a predictable path inside the worktree and return `{ findingsPath, submitCmd }` to your caller. The caller (with the user in the loop) runs the submit flow.

## Internal: Agent-to-Agent Protocol

The sections below are **not** for direct `/review` invocations. They are used
only when the `code-reviewer` orchestrator dispatches parallel reviewers that
need machine-mergeable output. If a human is the audience, ignore these and
emit the markdown report from "Output Format" above.

- **Finding schema (JSON)**: [references/finding-schema.md](references/finding-schema.md)
- **Shared reviewer prompt**: [references/reviewer-prompt.md](references/reviewer-prompt.md)
- **Synthesis criteria**: [references/synthesis-criteria.md](references/synthesis-criteria.md)

Sub-reviewers never run Step 9. The submission flow is human-invocation-only; invoking it from parallel reviewers would produce duplicate reviews on the same PR.
