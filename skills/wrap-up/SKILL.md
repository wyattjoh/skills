---
name: wrap-up
description: Closes out a long working session by sweeping for uncommitted work, failing checks, newly added TODOs, decisions that never landed in a document, and stale plan/spec/ticket files, then proposing commits and reporting what remains. Use before handing the work to a fresh agent. Triggers on "wrap up", "wrap up this session", "close out this task", "land this work", "what's left to do here", "I'm running out of context", "before I hand off", or "summarize the remaining work".
argument-hint: "[what the next session will pick up]"
allowed-tools: Bash(git:*), Bash(gh:*), Bash(bun:*), Bash(npm:*), Bash(pnpm:*), Bash(yarn:*), Bash(deno:*), Bash(just:*), Bash(make:*), Bash(cargo:*), Bash(swift:*), Bash(rg:*), Bash(fd:*), Read, Write, Edit, Grep, Glob, TodoWrite, AskUserQuestion
disable-model-invocation: true
effort: high
---

# Wrap Up

Land the current session so a fresh agent can resume it. Two outputs:

1. **Durable changes**: commits, and updates to any plan/spec/ticket doc this session made stale.
2. **A chat-only report** of what remains. Nothing is written to a summary file.

**Next session focus**: $ARGUMENTS (if provided, weight the report toward what that session will need)

## Boundaries

- **Do not write a handoff document.** That is a separate skill's job (`/handoff`). This
  skill exists so that skill has solid artifacts to point at instead of re-deriving them.
- **Do not push, open a PR, or merge.** Committing is the last write this skill performs.
- **Do not start new work.** A loose end found during the sweep gets reported, not fixed.
  The one exception is a stale tracking doc, which is unwritten work, not new work.

## Phase 1: Sweep

Run these five sweeps. Sources 1 through 3 are read-only shell work and should go out in
parallel; sources 4 and 5 are judgment.

### 1. Uncommitted work

```bash
git status --porcelain=v1 -uall
git stash list
git log --oneline "$(git merge-base HEAD "$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null | sed 's|origin/||' || echo main)")"..HEAD
git diff --stat && git diff --cached --stat
```

Read the full diff of anything you are unsure about. Note half-finished edits: a function
added but never called, an import with no use, a test file with no assertions.

### 2. Verification gaps

Find the project's commands (`package.json` scripts, `justfile`, `Makefile`, `CLAUDE.md`)
and run its lint, typecheck, and test commands. Report three states per command:
**passing**, **failing** (with the actual output), or **not run** (no such command, or its
runner is outside this skill's `allowed-tools`). Never report "not run" as passing.

### 3. TODO markers this session introduced

Scan added lines only, not the whole tree, in both committed and uncommitted changes:

```bash
git diff "$(git merge-base HEAD main)"...HEAD -U0 | grep -E '^\+.*\b(TODO|FIXME|HACK|XXX)\b'
git diff -U0 | grep -E '^\+.*\b(TODO|FIXME|HACK|XXX)\b'
```

### 4. Decisions with no home

**This is the highest-value sweep and the only one a fresh agent cannot reproduce.** Read
back over the actual conversation. Find every decision that was made and settled here but
exists nowhere except this transcript: an approach chosen over an alternative, a constraint
discovered, a tradeoff accepted, a rejected path and the reason it was rejected.

For each, name where it belongs: a commit message, a spec, an ADR, a ticket comment, a
code comment, a `CLAUDE.md` or `.claude/rules/` entry. Decisions bound for a commit message
are handled in Phase 3; the rest are reported as gaps.

Scan the transcript. Do not reconstruct decisions from the diff, which shows what was done
but not what was considered and dropped.

### 5. Tracking documents that no longer match reality

Identify what this effort tracks its state in, then check each against what actually
happened this session:

| Artifact                                                    | Check                                                    |
| ----------------------------------------------------------- | -------------------------------------------------------- |
| Wayfinder map / tickets                                     | Resolved tickets still open; fog now specifiable         |
| Plan or spec files, task lists                              | Completed steps unchecked; steps overtaken by a new plan |
| ADRs, workspace docs                                        | A decision from sweep 4 that supersedes a recorded one   |
| Issue tracker items                                         | Status, or a resolution comment never posted             |
| Branch description (`git config branch.<name>.description`) | Scope changed but the description did not                |
| The session's own todo list                                 | Items done but never marked, or abandoned but still open |

## Phase 2: Report

Print this to chat. It is a punch-list, not a narrative, so no recap of how the session went.
Omit any section that is empty rather than writing "none".

```markdown
## Landed

- <commit subject> (<short sha>)

## Uncommitted

- <group name>: <files>

## Verification

- <command>: passing | FAILING: <what broke> | not run: <why>

## Loose ends

- <half-finished edit, new TODO, or failing check, with file:line>

## Unwritten

- <decision or stale doc> → belongs in <destination>

## Next

- <recommended follow-up>
```

## Phase 3: Land

Propose everything in one batch, confirm once with `AskUserQuestion`, then execute in this
order. The order matters: doc updates land first so the commits capture them.

1. **Doc updates.** For each stale artifact from sweep 5 and each homeless decision from
   sweep 4 that belongs in a file, show the exact proposed edit. Apply only what is
   approved.

2. **Commits.** Group the dirty tree into logical [Conventional Commits](https://www.conventionalcommits.org/)
   rather than one catch-all commit, and show the plan as `<type>(<scope>): <subject>` plus
   the files in each. Stage each group explicitly by path so groups stay separate. Put the
   decisions from sweep 4 that belong in history into the relevant commit body.

   Guardrails:
   - If `HEAD` is the default branch, stop and ask before committing. Offer to branch first.
   - If the repo uses the `stacked-prs` skill, create any new branch through it.
   - Leave genuinely broken or half-finished code uncommitted, and say so in **Loose ends**.
     A wrap-up that commits a broken tree hands the next agent a worse starting point than
     a dirty one.

3. **Re-run verification** on anything the doc updates touched, then reprint the changed
   lines of the report. The report must describe the tree as it stands after landing.

## Phase 4: Point at the next step

Close with a single recommended follow-up, and name only skills that exist in this
environment:

- **`/handoff`**: the next agent needs the full context of this session.
- **`/wayfinder`**: the work belongs to an existing map; resolve its ticket and graduate
  the fog this session cleared.
- **`/pr-create`**: the branch is complete and verification passes.
- **Nothing**: the work is landed and closed.
