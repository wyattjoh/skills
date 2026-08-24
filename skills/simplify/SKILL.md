---
name: simplify
description: This skill should be used when the user asks to "simplify my code", "clean up changes", "refactor for clarity", "run /simplify", "make this code simpler", "review for simplification", or mentions "code simplification", "reduce complexity", "clean up branch", "simplify this function". Analyzes code changes for simplification opportunities. Presents findings with solution options and collects decisions in batches. Use --auto to apply recommended changes without prompts.
allowed-tools: Bash(git:*), Read, Write, Edit, Grep, Glob, TodoWrite, AskUserQuestion, Agent
effort: high
---

# Code Simplification

Analyze code for simplification opportunities and guide the user through selecting which changes to apply.

**Focus Area**: $ARGUMENTS (if provided, limits analysis scope)

## Arguments

| Argument         | Description                                              | Example                         |
| ---------------- | -------------------------------------------------------- | ------------------------------- |
| `<file-path>`    | Analyze only the specified file                          | `/simplify src/utils/parser.ts` |
| `--scope=staged` | Analyze only staged changes                              | `/simplify --scope=staged`      |
| `--auto`         | Apply all recommended (Option A) changes without prompts | `/simplify --auto`              |
| (none)           | Analyze all changes in current branch                    | `/simplify`                     |

## Workflow Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  1. SCOPE    →  2. ANALYZE  →  3. PRESENT  →  4. DECIDE        │
│  Determine      Collect ALL     Show all       Batch questions  │
│  target files   suggestions     findings       (or --auto)      │
│                 with options                                    │
│                                                                 │
│                                 5. EXECUTE  →  6. COMPLETE      │
│                                 Apply          Show summary     │
│                                 selected       Suggest next     │
└─────────────────────────────────────────────────────────────────┘
```

> **Auto Mode**: With `--auto`, Steps 3-4 are skipped—all Option A (recommended) choices are selected automatically.

## Auto Mode (`--auto`)

When `--auto` is specified, the skill runs non-interactively:

1. **Analysis** proceeds as normal
2. **All suggestions automatically select Option A** (the recommended solution)
3. **No questions are asked**—changes are applied directly
4. **Summary** shows what was changed

This is ideal for:

- Power users who trust the default recommendations
- CI/CD pipelines or scripted workflows
- Quick cleanups where review isn't needed

```bash
# Interactive mode (default): presents options, asks questions
/simplify

# Auto mode: applies all Option A choices without prompts
/simplify --auto

# Auto mode on specific file
/simplify src/utils/parser.ts --auto
```

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

Read each file in scope and analyze for simplification opportunities. Collect **all suggestions with multiple solution options**.

For each file:

1. Read the file content
2. Identify simplification opportunities (see [Simplification Types](#simplification-types))
3. Generate 2-3 alternative solutions for each opportunity

**Structure suggestions in this format (with 2-3 solution options each):**

```
SUGGESTION 1:
- File: path/to/file.ts
- Lines: 45-52
- Type: [extract-function | simplify-conditional | reduce-nesting | remove-duplication | clarify-naming | other]
- Current Code: <code block>
- Solutions:
  - Option A: <code block> — [Brief description, e.g., "Extract to named function"]
  - Option B: <code block> — [Brief description, e.g., "Inline with early return"]
  - Option C: <code block> — [Brief description, e.g., "Use ternary expression"] (optional)
- Rationale: Why this code could benefit from simplification

SUGGESTION 2:
...
```

**Key requirement**: Each suggestion should have **2-3 distinct solution options** so users can choose their preferred approach, not just accept/reject.

## Step 3: Present All Findings

After analysis completes, present **all suggestions at once** so the user can see the full picture:

````markdown
## Simplification Analysis Complete

Found **5 simplification opportunities** across 3 files:

---

### 1. Extract validation logic (`src/utils/parser.ts:45-52`)

**Current:**

```typescript
if (input && input.length > 0 && input.match(/^[a-z]+$/)) {
  // ... 8 more lines of validation
}
```
````

**Options:**

- **A) Extract function**: Create `isValidInput(input)` helper
- **B) Early return**: Invert condition with early return
- **C) Keep original**: No change

---

### 2. Simplify nested conditionals (`src/components/Form.tsx:112-130`)

**Current:**

```typescript
if (user) {
  if (user.isAdmin) {
    if (user.permissions.includes("edit")) {
      // ...
    }
  }
}
```

**Options:**

- **A) Guard clauses**: Flatten with early returns
- **B) Combined condition**: Single `if (user?.isAdmin && ...)`
- **C) Keep original**: No change

---

[... remaining suggestions ...]

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

  - question: "How should we handle the nested conditionals in Form.tsx:112?"
    header: "Form.tsx"
    options:
      - label: "A) Guard clauses"
        description: "Flatten with early returns for readability"
      - label: "B) Combined condition"
        description: "Single condition with optional chaining"
      - label: "Keep original"
        description: "No change to this code"

  # ... up to 4 questions per AskUserQuestion call
````

### Batching Strategy

- **AskUserQuestion supports 1-4 questions per call**
- For 5+ suggestions, make multiple batched calls
- Group related suggestions (same file) in the same batch when possible

### Example Batch Flow

```
Suggestions: 7 total

Batch 1 (questions 1-4): parser.ts, Form.tsx, client.ts, utils.ts
  → User answers all 4

Batch 2 (questions 5-7): hooks.ts, api.ts, types.ts
  → User answers remaining 3

All decisions collected → Proceed to execution
```

### Tracking Decisions

After all batches complete, summarize using `TodoWrite`:

```
Simplification Decisions:
- ✅ parser.ts:45 → Extract function (Option A)
- ✅ Form.tsx:112 → Guard clauses (Option A)
- ❌ client.ts:67 → Keep original
- ✅ utils.ts:23 → Early return (Option B)
- ❌ hooks.ts:89 → Keep original
- ✅ api.ts:45 → Combined condition (Option B)
- ❌ types.ts:12 → Keep original
```

## Step 5: Execute

After all decisions are collected (or auto-selected), display the execution summary and immediately apply changes:

```markdown
## Applying Selected Changes

**Executing 4 of 7 suggestions:**

| #   | File      | Lines   | Selected Option | Description                               |
| --- | --------- | ------- | --------------- | ----------------------------------------- |
| 1   | parser.ts | 45-52   | Option A        | Extract to `isValidInput()` function      |
| 2   | Form.tsx  | 112-130 | Option A        | Flatten with guard clauses                |
| 4   | utils.ts  | 23-31   | Option B        | Simplify with early return                |
| 6   | api.ts    | 45-67   | Option B        | Combined condition with optional chaining |

**Kept Original (3):** client.ts:67, hooks.ts:89, types.ts:12
```

Apply the selected simplifications:

1. **Update todo list** with execution items
2. **For each accepted suggestion**:
   - Read the current file content
   - Apply the change using `Edit` tool
   - Mark as complete in todo list
3. **Handle conflicts**: If a file was modified since analysis, re-read and adjust

### Execution Order

Apply changes in reverse line order within each file to preserve line numbers:

```
file.ts:
  - Change at line 130 first
  - Change at line 45 second
```

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

### No Changes Detected

If no changes are found in scope:

```markdown
No code changes detected in scope.

**Scope analyzed**: All changed files in branch vs main
**Files checked**: 0

To analyze specific files, use: `/simplify path/to/file.ts`
```

### No Simplifications Found

If the agent finds no simplification opportunities:

```markdown
No simplification opportunities found in the analyzed code.

**Files analyzed**: 3

- src/utils/parser.ts
- src/components/Form.tsx
- src/api/client.ts

The code appears to be well-structured. No changes recommended.
```

### All Suggestions Rejected

If user selects "Keep original" for all suggestions:

```markdown
No simplifications selected. All code will remain unchanged.

You can run `/simplify` again later if you change your mind.
```

### Many Suggestions (10+)

For large numbers of suggestions:

1. Present all findings in the summary (Step 3)
2. Batch questions in groups of 4 (Step 4)
3. Consider suggesting `/simplify --scope=staged` or specific files for more focused review

## Tips

- **Review the summary first**: Read through all suggestions before answering questions—context helps decisions
- **Choose the best option**: Each suggestion offers 2-3 solutions—pick the one that fits your codebase style
- **"Keep original" is valid**: Not every suggestion needs to be accepted—trust your judgment
- **Start small**: For large changesets, consider `/simplify --scope=staged` or targeting specific files
- **Use `--auto` for speed**: When you trust the recommendations, `--auto` applies all Option A choices instantly
- **Re-run after changes**: After executing, you can run `/simplify` again to catch new opportunities
