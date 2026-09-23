---
name: tidy
description: Finds simplification opportunities in changed code, offers alternative solutions for each, collects the user's choices in batches, and applies them. Use when the user wants to simplify or clean up recent changes, a branch, staged files, or a specific file, reduce complexity, or refactor for clarity. Triggers on "/tidy", "simplify my code", "clean up changes", "reduce complexity", "refactor for clarity". Use --auto to apply recommended changes without prompts.
allowed-tools: Bash(git:*), Read, Write, Edit, Grep, Glob, AskUserQuestion, Agent
effort: high
---

# Code Simplification

Analyze code for simplification opportunities and guide the user through selecting which changes to apply.

**Focus Area**: $ARGUMENTS (if provided, limits analysis scope)

## Arguments

| Argument         | Description                                              | Example                     |
| ---------------- | -------------------------------------------------------- | --------------------------- |
| `<file-path>`    | Analyze only the specified file                          | `/tidy src/utils/parser.ts` |
| `--scope=staged` | Analyze only staged changes                              | `/tidy --scope=staged`      |
| `--auto`         | Apply all recommended (Option A) changes without prompts | `/tidy --auto`              |
| (none)           | Analyze all changes in current branch                    | `/tidy`                     |

## Auto Mode (`--auto`)

With `--auto`, analysis proceeds as normal, every suggestion takes Option A (the recommended solution), Steps 3 and 4 are skipped, no questions are asked, and the summary shows what changed.

## Step 1: Determine Scope

Parse `$ARGUMENTS` to determine what code to analyze:

```bash
# Get current branch and base branch
git branch --show-current
git merge-base HEAD main  # or master

# Based on arguments:
# - File path provided: analyze only that file
# - --scope=staged: use `git diff --cached --name-only`
# - No arguments: use `git diff $(git merge-base HEAD main) --name-only`
```

**Scope determination logic:**

1. If `$ARGUMENTS` contains a file path → analyze only that file
2. If `$ARGUMENTS` is `--scope=staged` → analyze staged files only
3. Otherwise → analyze all changed files in the branch

## Step 2: Analyze Code

Read each file in scope, identify simplification opportunities (see [Simplification Types](#simplification-types)), and generate 2-3 alternative solutions for each.

**Structure suggestions in this format (with 2-3 solution options each):**

```
SUGGESTION 1:
- File: path/to/file.ts
- Lines: 45-52
- Type: [extract-function | simplify-conditional | reduce-nesting | remove-duplication | clarify-naming | other]
- Current Code: <code block>
- Solutions:
  - Option A: <code block> (brief description, e.g., "Extract to named function")
  - Option B: <code block> (brief description, e.g., "Inline with early return")
  - Option C: <code block> (brief description, e.g., "Use ternary expression") (optional)
- Rationale: Why this code could benefit from simplification

SUGGESTION 2:
...
```

**Key requirement**: Each suggestion should have **2-3 distinct solution options** so users can choose their preferred approach, not just accept/reject.

## Step 3: Present All Findings

After analysis completes, present **all suggestions at once** so the user can see the full picture: a count of opportunities and files, then one entry per suggestion with its location, current code, and options. For illustration, one entry might look like this:

````markdown
### 1. Extract validation logic (`src/utils/parser.ts:45-52`)

**Current:**

```typescript
if (input && input.length > 0 && input.match(/^[a-z]+$/)) {
  // ... 8 more lines of validation
}
```

**Options:**

- **A) Extract function**: Create `isValidInput(input)` helper
- **B) Early return**: Invert condition with early return
- **C) Keep original**: No change
````

## Step 4: Batch Decision Questions

After presenting all findings, collect decisions using **batched `AskUserQuestion` calls** (up to 4 questions per batch):

### Question Format

Each question offers the solution alternatives plus a "Keep original" option:

```yaml
questions:
  - question: "How should we handle the validation logic in parser.ts:45?"
    header: "parser.ts"
    options:
      - label: "A) Extract function"
        description: "Create isValidInput() helper for reusability"
      - label: "B) Early return"
        description: "Invert condition and return early on invalid"
      - label: "Keep original"
        description: "No change to this code"

  # ... up to 4 questions per AskUserQuestion call
```

### Batching Strategy

- **AskUserQuestion supports 1-4 questions per call**
- For 5+ suggestions, make multiple batched calls
- Group related suggestions (same file) in the same batch when possible

### Tracking Decisions

After all batches complete, summarize the decisions: each suggestion's location and the chosen option, or "Keep original".

## Step 5: Execute

After all decisions are collected (or auto-selected), display a table of the suggestions being applied (file, lines, selected option, description) and list the ones kept original, then apply the changes immediately.

Apply each accepted suggestion with `Edit`, tracking progress in your task list. If a file changed since analysis, re-read it and adjust the change first.

## Step 6: Complete

After all changes are applied, display the final summary:

```markdown
## Simplification Complete

**Applied 4 simplifications across 4 files:**

| File           | Change Applied                                       |
| -------------- | ---------------------------------------------------- |
| `parser.ts:45` | Extracted `isValidInput()` function (Option A)       |
| `Form.tsx:112` | Flattened with guard clauses (Option A)              |
| `utils.ts:23`  | Simplified with early return (Option B)              |
| `api.ts:45`    | Combined condition with optional chaining (Option B) |

**Suggested next steps:**

- Run `bun run check` to verify types
- Run tests to ensure no regressions
```

Project formatters will run automatically if configured via hooks.

## Simplification Types

The agent should look for these common simplification opportunities:

| Type                     | Description                                     | Example                          |
| ------------------------ | ----------------------------------------------- | -------------------------------- |
| **extract-function**     | Long inline code that could be a named function | 10+ line block → `doSomething()` |
| **simplify-conditional** | Complex if/else that could use early returns    | Nested ifs → guard clauses       |
| **reduce-nesting**       | Deeply nested code that can be flattened        | 4+ indent levels → 2 levels      |
| **remove-duplication**   | Repeated code that should be shared             | Copy-paste → shared function     |
| **clarify-naming**       | Variables/functions with unclear names          | `x` → `userCount`                |
| **remove-dead-code**     | Unreachable or unused code                      | Commented blocks, unused vars    |
| **simplify-logic**       | Overly complex boolean expressions              | `!(a && !b)` → `!a \|\| b`       |

## Edge Cases

If the scope has no changes, no opportunities are found, or the user keeps every original, say so briefly with the scope and files analyzed and stop. For 10 or more suggestions, still present them all and batch the questions in groups of 4, and consider suggesting `/tidy --scope=staged` or specific files for a more focused review.
