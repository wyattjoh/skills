# Finding Schema (Internal Agent Protocol)

> **Audience: other agents, not users.** This schema is consumed by the
> `code-reviewer` orchestrator when it runs parallel Opus and Codex reviewers
> and needs mergeable output. **Never print this JSON to a human invoking
> `/pr-review` directly** -- they should receive the markdown report defined in
> `SKILL.md` under "Output Format".

When a reviewer sub-agent is asked for structured output, emit findings as a
JSON array. Each finding has the following shape:

```json
{
  "id": "string (unique, e.g. 'SEC-001')",
  "file": "string (relative path)",
  "line": "number (primary line of concern)",
  "severity": "critical | high | medium | low",
  "category": "security | performance | logic | style | testing | documentation | architecture",
  "title": "string (concise, under 80 chars)",
  "description": "string (detailed explanation of the issue)",
  "evidence": "string (relevant code snippet or reasoning)"
}
```

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

The synthesis step (see `synthesis-criteria.md`) adds orchestrator-internal fields — `sources`, `contested`, `synthesisNote` — for adjudication and reporting. **Only the eight base fields above** (`id`, `file`, `line`, `severity`, `category`, `title`, `description`, `evidence`) are consumed by `scripts/submit-pr-review.ts` and posted to GitHub. The internal fields are stripped before the findings file is handed to the script.

### What the PR author sees

Only `description` lands in the inline comment on the PR. `title`, `severity`, `category`, and `evidence` are kept for internal use (orchestrator dedup and synthesis, logging) but are not posted to GitHub.

Write `description` as if the author is the only reader, because they are:

- It is the whole comment. No badge, no separate evidence block. If a code reference aids the point, inline it directly using backticks or a fenced block.
- Write in the voice of a single reviewer giving feedback. Direct, specific, points at the actual problem and suggests a fix.
- No methodology references: do not mention parallel reviewers, which reviewer flagged it, synthesis confidence, or corroboration. Phrases like "Reviewed with Opus + Codex", "(codex confirmed)", "both reviewers agree", "contested finding" do not belong in a posted review.
- No reviewer bookkeeping: no `sources:`, no confidence tags, no "high-priority per synthesis".

The `submit-pr-review.ts` script enforces this: it scans `summary`, `title`, `description`, and `evidence` for a small list of methodology tokens and aborts before submission if any match. If the guard fires, rewrite the offending text — do not work around the check.
