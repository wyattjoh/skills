# Finding Schema (Internal Agent Protocol)

> **Audience: other agents, not users.** This schema is consumed by the
> `code-reviewer` orchestrator when it runs parallel Opus and Codex reviewers
> and needs mergeable output. **Never print this JSON to a human invoking
> `/pr-review` directly** -- they should receive the markdown report defined in
> `SKILL.md` under "Output Format".

When a reviewer sub-agent is asked for structured output, emit findings as a
JSON array. Each finding has the following shape:

````json
{
  "id": "string (unique, e.g. 'SEC-001')",
  "file": "string (relative path)",
  "line": "number (primary line of concern)",
  "severity": "critical | high | medium | low",
  "category": "security | performance | logic | style | testing | documentation | architecture",
  "title": "string (concise, under 80 chars)",
  "description": "string (detailed explanation of the issue)",
  "evidence": "string (OPTIONAL: relevant code snippet or reasoning)",
  "fix": {
    "summary": "string (one or two sentences naming the change)",
    "diff": "string (OPTIONAL: unified-diff body, NO ```diff fence)"
  }
}
````

`evidence` and `fix` are the optional fields. `evidence` is never posted to
GitHub, so omit it when there is nothing to record rather than writing filler to
satisfy the schema. Every other field is required and must be a non-empty
string, except `line`, which must be a positive integer.

### The `fix` block

Posted inside a collapsed `<details><summary>Recommended fix</summary>` section
below the description, so the patch is one click away without competing with the
finding for attention.

- **`fix.summary` is short.** One or two sentences. The reader has already read
  `description`; this names the change, it does not re-argue for it.
- **`fix.diff` is a diff, not a snippet.** Use `-`/`+`/context lines so the
  change is visible at a glance. An after-the-change block forces the author to
  diff it by eye, which defeats the point.
- **Pass the diff body only.** The renderer adds the ` ```diff ` fence. A
  pre-fenced value nests and renders as literal backticks; the script rejects it.
- **Omit `fix` when there is no mechanical fix.** Findings that need a product
  decision, a design discussion, or a test you cannot write for the author have
  no honest diff. Inventing a plausible-looking one is worse than no block —
  the author trusts it, applies it, and inherits your guess. Prose-only (a
  `summary` with no `diff`) is the right shape when the direction is clear but
  the code is not.
- **Keep it minimal.** Enough lines to make the change unambiguous, not the
  whole rewritten function. Roughly 15 lines is plenty; elide untouched context
  with `...` rather than reproducing it.

## ID Conventions

Use a category prefix plus a sequential number:

- `SEC-001`, `SEC-002` -- security
- `PERF-001` -- performance
- `LOG-001` -- logic
- `STY-001` -- style
- `TEST-001` -- testing
- `DOC-001` -- documentation
- `ARCH-001` -- architecture

## Submission Fields vs Internal Fields

The synthesis step (see `synthesis-criteria.md`) adds orchestrator-internal fields — `sources`, `contested`, `synthesisNote` — for adjudication and reporting. **Only the eight base fields above** (`id`, `file`, `line`, `severity`, `category`, `title`, `description`, `evidence`) are consumed by `scripts/submit-pr-review.ts`. The internal fields are stripped before the findings file is handed to the script.

`severity` reaches GitHub as a rendered badge (see below). `id`, `file`, `line`, and `title` do not, but they are not dead weight: the script prints `id file:line title` for every finding it has to drop, so those fields are what makes a dropped finding identifiable.

### What the PR author sees

Three fields land in the inline comment: `severity`, rendered by the script as a `**[HIGH]**`-style badge on the first line; `description` beneath it; and `fix`, rendered as a collapsed "Recommended fix" block. `title`, `category`, and `evidence` are kept for internal use (orchestrator dedup and synthesis, logging) but are not posted to GitHub.

The assembled comment looks like this:

````markdown
**[HIGH]**

<description>

<details>
<summary>Recommended fix</summary>

<fix.summary>

```diff
<fix.diff>
```
````

</details>

###### Sent from Claude

- [ ] reviewed by @someone

```

The author reads comments one at a time, out of order, with no access to the findings file, so the badge is the only thing telling them whether a comment blocks the merge or is a nit. That makes `severity` load-bearing on the posted review, not just internal triage — set it honestly per finding rather than defaulting everything to `medium`.

Write `description` as if the author is the only reader, because they are:

- **Keep it short. Aim for under ~900 characters — three or four short paragraphs at the very most, and one or two for anything below `high`.** A PR comment is read inline in a cramped column, next to nine others. Length reads as importance, so a padded `medium` drowns out the `high` above it. State the defect, the concrete path to it, and stop. Cut throat-clearing, restatements of what the code plainly does, and any sentence hedging a point already made.
- It is the body of the comment. The script prepends the severity badge and appends the fix block for you — do not write your own badge, do not restate the severity in prose, and do not end `description` with a "Suggested fix:" paragraph that duplicates `fix.summary`. No separate evidence block either. If a code reference aids the point, inline it directly using backticks or a fenced block.
- Quote sparingly. One short block, only when the reader cannot follow without it — they are looking at the diff already.
- Write in the voice of a single reviewer giving feedback. Direct, specific, points at the actual problem and suggests a fix.
- No methodology references: do not mention parallel reviewers, which reviewer flagged it, synthesis confidence, or corroboration. Phrases like "Reviewed with Opus + Codex", "(codex confirmed)", "both reviewers agree", "contested finding" do not belong in a posted review.
- No reviewer bookkeeping: no `sources:`, no confidence tags, no "high-priority per synthesis".

The `submit-pr-review.ts` script enforces this: it scans `summary`, `title`, `description`, and `evidence` for a small list of methodology tokens and aborts before submission if any match. If the guard fires, rewrite the offending text — do not work around the check.
```
