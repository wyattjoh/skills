---
name: code-walkthrough
description: Builds an annotated code-walkthrough page — the source pinned on the left, explanations scrolling on the right, with the lines under discussion spotlit as you scroll. Use when the user asks to "walk through" a file or diff, wants code "explained line by line", or asks for a "code walkthrough", "annotated source", "explain this migration", or a page explaining what code does and why. Themed Catppuccin Mocha.
effort: high
argument-hint: "[file, diff, or branch to walk through]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash(bun:*)
  - Bash(git:*)
  - Bash(open:*)
---

# Code Walkthrough

Produces a single self-contained HTML page: a sticky code pane on the left holding
the real source, and annotation "beats" on the right. Scrolling the narrative
spotlights the matching lines and auto-scrolls the pane to them; clicking a line
jumps to the beat that explains it.

The page shell, theme, syntax highlighting, and scroll machinery are already
built. **Your job is the reasoning, not the HTML.**

## Quick Start

```bash
bun ${CLAUDE_SKILL_DIR}/scripts/build.ts .scratch/thing.walkthrough.json --open
```

The definition file names source _paths_; the script injects the code and
verifies every rendered line against its file. Never paste source into the JSON.

## Workflow

```
- [ ] 1. Settle the scope — whole file, or only what changed?
- [ ] 2. Read the source
- [ ] 3. Trace the WHY (the step that decides whether this page is worth making)
- [ ] 4. Write the walkthrough definition
- [ ] 5. Build; fix whatever the self-checks report
- [ ] 6. Open it and say what you verified
```

### 1. Settle the scope

Ask which of these the user means, if it isn't obvious:

| Situation                                  | `scope`                   |
| ------------------------------------------ | ------------------------- |
| New file, or the whole file is the subject | omit it                   |
| A change, PR, or "explain my edits"        | `{"diff": "main...HEAD"}` |
| A known region — one function, one block   | `{"ranges": [[40, 96]]}`  |

Scope decides **what owes an explanation**. Out-of-scope lines are still rendered
as context and still readable; long unexplained runs collapse into an expandable
`… N unchanged lines` marker. A small edit to a large file never obliges you to
narrate the whole file.

### 2. Read the source

Read the actual files. For a diff, `git diff` first so you know which lines moved.

### 3. Trace the why

**This is the step that makes the page worth having, and the step that is easiest
to skip.** A walkthrough that only restates what each line does is worthless — the
reader can see the code. The value is in what the code does _not_ say.

Look for the reasoning in, roughly this order:

- comments in the code itself (often the densest source)
- the commit message that introduced the lines (`git log -L`, `git blame`)
- specs, ADRs, design docs, RFCs the repo carries
- decision logs, journals, changelogs
- PR discussion (`gh pr view`), linked issues
- sibling code the line imitates — precedent is a reason

**Attribute every claim.** "Because ADR 0014 makes this caller-asserted" is
useful; "for security reasons" is noise. When you are inferring rather than
citing, say so in the text ("this appears to be…"). Never invent a rationale to
fill a beat — a beat that honestly says "the reason isn't recorded anywhere I
could find" is more valuable than a plausible fabrication.

Prioritise, in order: **traps** (what breaks if someone edits this naively),
**non-obvious constraints**, **rejected alternatives**, then plain mechanics.

### 4. Write the definition

Write it to `.scratch/<name>.walkthrough.json` (confirm `.scratch/` is
gitignored first). Full schema: [references/walkthrough-file.md](references/walkthrough-file.md).

```json
{
  "title": "Four tables, and the reasons behind every line of them.",
  "titleAccent": "reasons",
  "eyebrow": "repo <span>&middot;</span> branch <span>&middot;</span> TICKET-123",
  "lede": "One paragraph on what this is and why it matters.",
  "facts": [{ "label": "Tables", "value": "4" }],
  "files": [{ "path": "../path/to/file.sql", "sub": "187 lines" }],
  "beats": [
    {
      "id": "pending-expiry",
      "from": 43,
      "to": 45,
      "section": "Constraints",
      "sectionSub": "Shown as a chapter heading above this beat.",
      "tags": [
        ["info", "ADR 0004"],
        ["trap", "NULL semantics"]
      ],
      "title": "One-directional on purpose",
      "body": "<p>Prose as raw HTML.</p><div class=\"note trap\"><b>Trap:</b> …</div>"
    }
  ],
  "footer": "Where the annotations came from."
}
```

Beat rules:

- **Contiguous line ranges, in file order.** Beats read top to bottom.
- **Group only what shares one explanation.** A block of six columns that each
  need a different reason is six beats, not one.
- Include the comment lines above a statement in its range — they are part of
  what you are explaining.
- `section` starts a new chapter (heading + entry in the hover rail). Use one
  per logical division, not one per beat.
- `id` must be unique and kebab-case; it becomes the anchor.

### 5. Build

```bash
bun ${CLAUDE_SKILL_DIR}/scripts/build.ts .scratch/thing.walkthrough.json --open
```

| Flag                      | Effect                                         |
| ------------------------- | ---------------------------------------------- |
| `--out <file>`            | Output path, relative to the definition file   |
| `--open`                  | Open in the browser when it succeeds           |
| `--require-full-coverage` | Turn the uncovered-line warning into a failure |

The script refuses to write a page whose pane does not match the source, and
reports beats that overlap or leave in-scope lines unexplained. Fix what it
reports and run it again — that loop is the quality gate.

### 6. Hand it over

Say where the page is, how many beats it has, what the self-checks confirmed,
and — honestly — which beats are inference rather than cited fact.

## Writing the prose

Beat `body` is raw HTML. Ready-made classes, with the full list in
[references/theme.md](references/theme.md):

| Markup                                      | Use                                 |
| ------------------------------------------- | ----------------------------------- |
| `<p>`, `<ul>`, `<strong>`, `<em>`, `<code>` | Ordinary prose                      |
| `<div class="note">`                        | An aside                            |
| `<div class="note trap">`                   | What breaks if edited naively       |
| `<div class="note caution">`                | A deviation from spec or convention |
| `<div class="note good">`                   | A measurement or proof              |
| `<div class="note info">`                   | A pointer to a decision record      |

Tag vocabulary for the `tags` array — `[class, label]`, label free-text:

`info` (blue, a decision/reference) · `caution` (peach, a deviation) ·
`danger` / `trap` (red, a defect or hazard) · `accent` (teal, a structural
property) · `good` (green, measured/verified) · `quiet` (grey, background).

## Rules

1. **Never paste source into the definition.** Give a path. The build injects and
   verifies it; hand-copied code drifts silently.
2. **Never invent a rationale.** Cite, or mark it as inference.
3. **Do not edit `assets/template.html` per page.** It is shared. If a page needs
   something the template lacks, say so rather than forking it.
4. **Do not hand-write the HTML output.** Everything routes through the build.

## References

- [references/walkthrough-file.md](references/walkthrough-file.md) — every field, scope forms, worked example
- [references/theme.md](references/theme.md) — the token system, available classes, contrast rules

Run `bun test` in the skill directory after changing the build script or template.
