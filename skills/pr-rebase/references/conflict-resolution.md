# Autonomous conflict resolution protocol

This document describes how `pr-rebase` resolves merge conflicts without
user-in-the-loop per file. The core idea: a conflict is a mini-debugging
problem where both sides had an intent, and the resolution must preserve both.

## Non-negotiable rules

1. **Never ship unverified.** The verification gate in Phase 7 of the skill
   runs _before_ `git rebase --continue` and _before_ any push. A resolution
   that "looks fine" but fails the gate is not a resolution.
2. **Bail out rather than guess.** If both sides' intent cannot be determined
   with confidence from history and context, stop. Print the conflicted
   files with recovery commands and let the user finish.
3. **Preserve behavior from both sides.** Never discard a change just because
   the other side is "newer" or "more specific". If both sides added a case
   to a switch, the resolution must contain both cases.
4. **Never check in conflict markers.** Grep for `<<<<<<<`, `=======`,
   `>>>>>>>` after every edit; if any remain, the resolution is incomplete.
5. **Do not `git add` until resolution passes a syntactic sanity check** (no
   leftover markers; imports look reasonable; braces balance if applicable).

## Context-gathering commands

For each conflicted file, run these before making any edit. The goal is to
understand what each side was trying to accomplish, not just what it looked
like textually.

### Fork point and ranges

```bash
FORK=$(git merge-base HEAD origin/<base>)   # where the branches diverged
```

### Branch's changes to this file

During a rebase, git temporarily puts HEAD on the commit being replayed. The
"ours" side at conflict time is the rebase target (base), and "theirs" is the
commit being replayed (branch). This is the inverse of a merge. Mentally
track which is which before reading any log.

```bash
# What the *branch* changed (from fork point to the original branch tip):
git log -p <fork>..ORIG_HEAD -- <file>

# What *base* changed (from fork point to the new base tip):
git log -p <fork>..origin/<base> -- <file>
```

`ORIG_HEAD` holds the pre-rebase branch tip and is set automatically when the
rebase starts; this is safe to rely on.

### Broader context

```bash
# Full current file with conflict markers:
Read <file>

# Symbols referenced in the conflict region -- find their definitions and
# callers:
Grep "<symbol>" --type <language>

# Tests covering the conflict region:
Grep --glob "**/*test*" "<nearby function/class name>"
```

### Commit messages for the conflict

Commit messages often state intent more clearly than the diff. Read them:

```bash
git log --format="%h%n%s%n%n%b%n---" <fork>..ORIG_HEAD -- <file>
git log --format="%h%n%s%n%n%b%n---" <fork>..origin/<base> -- <file>
```

## Classifying the conflict

After gathering context, categorize the conflict into one of these patterns.
Each pattern has a known-good resolution shape.

### Pattern 1: Both sides added independently at the same location

Example: two developers added unrelated imports at the top of a file.

**Resolution:** Keep both. Order them alphabetically or per the project's
convention (check other files in the same codebase via `Grep`).

### Pattern 2: Both sides added cases / entries to the same structure

Example: both sides added a case to a switch, a route to a router, or a key
to a config object.

**Resolution:** Keep both entries. Preserve the order of each side's entries
where reasonable. Check whether a newly-added key on one side conflicts
_semantically_ (same name, different value) with the other side -- if so,
this is actually a Pattern 5 conflict; escalate to the bail-out path.

### Pattern 3: One side refactored, the other made a local change

Example: base extracted a function; branch edited the original inline code
at the same location.

**Resolution:** Apply the branch's local change _inside the extracted
function_ on the base side. Do not undo the refactor. Verify the change
still makes sense in the new shape (the verification gate catches most
cases; if the refactor changed parameter names or control flow, the change
may need to be adapted).

### Pattern 4: One side deleted what the other modified

Example: base removed a function, branch modified it.

**Resolution:** This is ambiguous. Usually the deletion wins (the function
was removed for a reason), but the branch's modification may represent work
that now belongs somewhere else. If the branch's modification has obvious
semantic value beyond the deleted function's scope, flag this for user
review via the bail-out path rather than guessing.

### Pattern 5: Both sides modified the same lines with different intent

Example: both sides changed the same if-condition, or both rewrote the
same function body.

**Resolution:** This is the most dangerous pattern. Attempt resolution only
when both intents can be _combined_, not when they conflict. Examples:

- Both sides tightened a validation (add both checks): combinable.
- Both sides changed an error message to different strings: not combinable;
  bail.
- Both sides refactored the same function into different shapes: not
  combinable; bail.

### Pattern 6: Formatting / whitespace only

If both sides only touched formatting (no semantic change), take either
side. Run the project's formatter after the rebase if one is configured
(`bunx oxfmt`, `prettier --write`, `rustfmt`, etc.).

## Bail-out conditions

Bail out and hand the rebase back to the user when any of the following is
true:

- More than 10 conflicted files in total.
- Any conflict on a binary file (no text diff available).
- Any conflict on a generated file (lockfiles, build output, etc.).
- Any Pattern 5 conflict where intents cannot be combined.
- Any Pattern 4 conflict where the deleted code had semantic value that the
  modification would lose.
- Any conflict where the context-gathering commands cannot determine intent
  (e.g., commit messages are empty and the diff itself is ambiguous).

The bail-out path is not failure; it is the safe default for ambiguity.

## After resolving a file

1. Grep the file for leftover conflict markers:
   ```bash
   Grep "<<<<<<<|=======|>>>>>>>" <file>
   ```
   If any remain, fix them before staging.
2. Do a syntactic sanity check appropriate to the language. For example, in
   TypeScript/JavaScript, unbalanced braces usually manifest as a parser
   error during verification; catching them earlier saves a run.
3. Stage the file: `git add <file>`.

Do NOT run `git rebase --continue` from inside this document -- the caller
in Phase 6 of the skill does that after the verification gate passes.

## Worked example

Branch added a new error code; base independently added a different error
code to the same enum.

### The conflict

```
pub enum AppError {
    NotFound,
<<<<<<< HEAD (base)
    Unauthorized,
=======
    RateLimited,
>>>>>>> branch-commit (branch)
}
```

### Context

Branch's commit:

```
feat(errors): add RateLimited variant

Adds a new error variant returned by the auth middleware when the per-IP
rate limit is exceeded.
```

Base's commit:

```
feat(errors): add Unauthorized variant

Distinguishes forbidden-for-this-user from general auth failures.
```

### Classification

Pattern 2: both sides added entries to the same enum, different names,
unrelated purposes.

### Resolution

Keep both variants. Alphabetical order matches the rest of the enum, so:

```
pub enum AppError {
    NotFound,
    RateLimited,
    Unauthorized,
}
```

### Verification

`cargo check` passes. Any match statement on `AppError` elsewhere that is
now non-exhaustive would surface here and require fixing.

## Worked example: bail-out

Branch renamed a function; base deleted it.

### The conflict

```
<<<<<<< HEAD (base)
// (function deleted)
=======
fn legacy_login_with_retry() -> Result<Session, AuthError> {
    // ... modified implementation ...
}
>>>>>>> branch-commit (branch)
```

Branch's commit: `refactor(auth): add retry to legacy_login_with_retry`.

Base's commit: `chore(auth): remove unused legacy_login helper`.

### Classification

Pattern 4. Base deleted a function as unused; branch assumed it still
existed and modified it.

### Resolution

**Bail out.** The branch's change is semantically orphaned now -- the
function it modifies no longer exists in the new base. This requires the
developer to decide whether to: (a) re-introduce the function because the
branch still needs it, (b) drop the branch's change because base was right
that the function is unused, or (c) move the retry logic somewhere else.
None of these are mechanical.

Print the recovery commands and exit.
