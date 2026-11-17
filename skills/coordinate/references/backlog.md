# Backlog

`<backlog_dir>/<domain>-backlog.md` (default `~/.config/coordinator/backlogs`). Working memory, not docs: plans, specs and reports live where the user keeps docs. Sections, in order: `## Boundary`, `## Standing yes`, `## Open`, `## Done`. `coordinate start` creates them and reports any missing.

## Boundary

Repos by absolute or `~/` path, in backticks when a path has spaces; the scripts find the domain's repos and PRs from them. Then the adjacent repos and services, read-only.

## Standing yes

What the user approved for every later case, one line each in their words, with the date and limits:

```markdown
- Land verified work into local main with land-local, no push (2026-11-16: "land as each verifies").
```

## Open

Each item names what it touches, what is decided (in the user's words, dated), what is open with your recommendation, and the handle when delegated. Paste the handle line `coordinate delegate` prints:

```markdown
- **Search: one query per keystroke.** Touches `src/search/query.ts`. Decided: drop the debounce
  (11-14: "Drop it"). Ask: keep the 300 ms floor for paste? Recommend yes.
  - search-query | t24 | "search query" | ~/Code/app/.claude/worktrees/search-query | wyattjoh/search-query | 0b9c…-uuid | pi openai/gpt-6.1 high | brief …/.scratch/BRIEF.md | report …/.scratch/REPORT.md
```

- **Asks** start `Ask:` and carry options and a recommendation; mark ones that survive a restart "open before restart".
- **Due dates**: `due: YYYY-MM-DD` anywhere in an Open line makes the watcher fire on that day.
- **Ended delegates**: write "ended <date>" on the handle; `coordinate status` still lists them with their resume command.
- **Unlabelled sessions**: a session the user started is counted as the domain's when Open names its session id.

## Done

The date, what changed and what it touched. When `<backlog_dir>` is in a Git repo that does not ignore it, commit the backlog by path (`git commit --only <backlog>`) so other sessions' staged work stays out.
