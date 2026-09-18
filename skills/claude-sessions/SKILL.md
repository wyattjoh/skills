---
name: claude-sessions
description: >-
  Parses and analyzes Claude Code conversation history. Triggers on "analyze a
  Claude Code conversation", "parse conversation history", "read session files",
  "extract messages from JSONL", "list Claude sessions", "find conversations by
  prompt", "search conversation content", "find projects", "search plans", or mentions
  "sessions-index.json", ".jsonl conversation", "Claude Code history", "conversation
  parser".
allowed-tools: Bash(bun:*), Read, Grep, Glob
effort: medium
model: sonnet
---

`$SKILL_DIR` is the base directory reported when this skill loads. Skills use it for bundled scripts, and it is not a shell variable.

# Claude Sessions

The `claude-sessions` CLI incrementally indexes Claude Code history, then answers questions from SQLite and FTS5. Use the CLI for deterministic discovery, filtering, pairing, counting, and searching instead of reading raw JSONL files.

## Quick start

Sync the corpus once, then let read commands use the index:

```bash
bun $SKILL_DIR/scripts/cli.ts sync --quiet
```

Examples:

```bash
# Which recent sessions worked on this project?
bun $SKILL_DIR/scripts/cli.ts sessions --project=/absolute/path/to/repository --since=7d --sort=messages --limit=5

# What was happening when the user interrupted the assistant?
bun $SKILL_DIR/scripts/cli.ts interruptions --project=/absolute/path/to/repository --limit=5

# Which tools returned errors, and what followed them?
bun $SKILL_DIR/scripts/cli.ts errors --project=/absolute/path/to/repository --since=30d --limit=5
```

The default database is `~/.cache/claude-sessions/index.db`. Every read command syncs first unless `--no-sync` is present. The CLI emits JSON by default, or a human-readable table with `--table`.

## Commands

Run commands with `bun $SKILL_DIR/scripts/cli.ts`. The usages and flag names below are copied from each command's live `--help` output.

| Command         | Usage                                                                                          | Flags                                                                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync`          | `bun $SKILL_DIR/scripts/cli.ts sync [options]`                                                 | `--root=<value>`, `--projects=<value> (repeatable)`, `--vacuum`, `--quiet`, `--table`, `--no-redact`                                                                                |
| `projects`      | `bun $SKILL_DIR/scripts/cli.ts projects [options]`                                             | shared read flags, `--search=<value>`, `--table`, `--no-redact`                                                                                                                     |
| `sessions`      | `bun $SKILL_DIR/scripts/cli.ts sessions [options]`                                             | shared read flags, `--sort=<value>`, `--first-prompt=<value>`, `--table`, `--no-redact`, judge flags                                                                                |
| `search`        | `bun $SKILL_DIR/scripts/cli.ts search <query> [options] \| search --regex=<pattern> [options]` | shared read flags, `--in=<value>`, `--type=<value>`, `--regex=<value>`, `--context=<value>`, `--include-injected`, `--table`, `--no-redact`, judge flags                            |
| `messages`      | `bun $SKILL_DIR/scripts/cli.ts messages [options]`                                             | shared read flags, `--include-tools`, `--include-thinking`, `--around=<value>`, `--table`, `--no-redact`                                                                            |
| `tools`         | `bun $SKILL_DIR/scripts/cli.ts tools [options]`                                                | shared read flags, `--name=<value> (repeatable)`, `--input=<value>`, `--errors-only`, `--agent-type=<value>`, `--skill=<value>`, `--result-chars=<value>`, `--table`, `--no-redact` |
| `errors`        | `bun $SKILL_DIR/scripts/cli.ts errors [options]`                                               | shared read flags, `--name=<value>`, `--pattern=<value>`, `--table`, `--no-redact`, judge flags                                                                                     |
| `interruptions` | `bun $SKILL_DIR/scripts/cli.ts interruptions [options]`                                        | shared read flags, `--include-injected`, `--table`, `--no-redact`, judge flags                                                                                                      |
| `stats`         | `bun $SKILL_DIR/scripts/cli.ts stats [options]`                                                | shared read flags, `--by=<value>`, `--table`, `--no-redact`                                                                                                                         |
| `sql`           | `bun $SKILL_DIR/scripts/cli.ts sql <statement> [options] \| sql --schema`                      | `--schema`, `--limit=<value>`, `--table`, `--no-redact`                                                                                                                             |
| `plans`         | `bun $SKILL_DIR/scripts/cli.ts plans --pattern=<text> [options]`                               | `--pattern=<value>`, `--root=<value>`, `--limit=<value>`, `--context=<value>`, `--table`, `--no-redact`                                                                             |

### Shared read flags

These exact options appear on `projects`, `sessions`, `search`, `messages`, `tools`, `errors`, `interruptions`, and `stats`:

| Flag                             | Help text                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| `--project=<value> (repeatable)` | Filter by exact canonical repository root or case-sensitive glob (repeatable)       |
| `--session=<value> (repeatable)` | Filter by session id (repeatable)                                                   |
| `--since=<value>`                | Only include records at or after this time (ISO 8601, or relative like 3h, 6d, 2w)  |
| `--until=<value>`                | Only include records at or before this time (ISO 8601, or relative like 3h, 6d, 2w) |
| `--model=<value>`                | Filter by model name                                                                |
| `--include-subagents`            | Include subagent transcript sessions (excluded by default)                          |
| `--limit=<value>`                | Maximum number of rows to return (default 100)                                      |

Output flags use the following help text: `--table` means "Print a human-readable table instead of JSON". `--no-redact` means "Redact secrets in output (default: on; use --no-redact to disable)". The sync command also accepts these flags.

Command-specific help text:

| Flag                              | Help text                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| `--root=<value>`                  | Corpus root (default: ~/.claude/projects)                                          |
| `--projects=<value> (repeatable)` | Only sync exact canonical repository roots or case-sensitive globs (repeatable)    |
| `--vacuum`                        | Run VACUUM on the index database after syncing                                     |
| `--quiet`                         | Suppress progress lines on stderr                                                  |
| `--search=<value>`                | Filter by substring of the canonical repository root                               |
| `--sort=<value>`                  | Sort by date, messages, tokens, or errors (default: date)                          |
| `--first-prompt=<value>`          | Filter by substring of the session's first prompt                                  |
| `--in=<value>`                    | Search messages, tools, or all (default: messages)                                 |
| `--type=<value>`                  | Filter message hits by user or assistant                                           |
| `--regex=<value>`                 | Run a regular expression pass over FTS candidates                                  |
| `--context=<value>`               | Characters of context on each side of a match (default: 160)                       |
| `--include-injected`              | Include injected text (skill bodies, slash-command expansions, system reminders)   |
| `--include-tools`                 | Include tool_use and tool_result blocks                                            |
| `--include-thinking`              | Include thinking blocks                                                            |
| `--around=<value>`                | Context window around a message: <uuid>:<n>                                        |
| `--name=<value> (repeatable)`     | Filter by tool name (repeatable)                                                   |
| `--input=<value>`                 | Filter by regex over the tool input                                                |
| `--errors-only`                   | Only include calls whose result was an error                                       |
| `--agent-type=<value>`            | Filter Agent calls by subagent type                                                |
| `--skill=<value>`                 | Filter Skill calls by skill name                                                   |
| `--result-chars=<value>`          | Maximum result text characters (default: 400)                                      |
| `--pattern=<value>`               | Case-insensitive pattern to search for (required)                                  |
| `--by=<value>`                    | Group by project, model, version, day, or session                                  |
| `--schema`                        | Print the index database schema instead of running a statement                     |
| `--limit=<value>` for `sql`       | Maximum rows to return; applied only when the statement has no LIMIT (default 200) |
| `--root=<value>` for `plans`      | Plans directory (default: ~/.claude/plans)                                         |
| `--limit=<value>` for `plans`     | Maximum matches to return (default 10)                                             |
| `--context=<value>` for `plans`   | Characters of context around each match (default 150)                              |

Global help adds `--no-sync`, "Skip the automatic index sync before running a read command". Judge-enabled commands also show:

| Flag                       | Help text                                                       |
| -------------------------- | --------------------------------------------------------------- |
| `--judge=<preset>`         | Annotate supported rows with a TypeSafe preset                  |
| `--judge-file=<json>`      | Load ad hoc TypeSafe questions and state fields from JSON       |
| `--query=<text>`           | Query text required by the relevance preset                     |
| `--min-confidence=<value>` | Mark answers below this confidence as uncertain                 |
| `--no-cache`               | Use the judgment cache (default: on; use --no-cache to disable) |
| `--max-judge-rows=<value>` | Cap TypeSafe requests (default: 500)                            |

Root help summarizes `--no-cache` as "Bypass the judgment cache"; command help expands it as "Use the judgment cache (default: on; use --no-cache to disable)".

## Filters

Use `--project` with a full canonical repository root. Plain values match exactly, while values containing `*`, `?`, or `[...]` use case-sensitive glob matching. Repeat it to match multiple repositories with OR semantics. Linked worktrees share the primary repository root identity. Use `--session` for one or more raw session IDs. `--since` and `--until` accept ISO 8601 timestamps or relative values such as `3h`, `6d`, and `2w`; relative values are resolved when the command starts. `--model` filters assistant model names. Subagents are excluded unless `--include-subagents` is supplied. Keep result sets reviewable with `--limit`.

Use `--no-sync` for repeatable reads after a known sync. It prevents a full corpus walk and is especially important when inspecting a historical window or running several recipes.

## Judging

Judging is optional. It adds a TypeSafe annotation to each supported row while preserving the original row. Use `--judge-file=<json>` for custom questions and dot-separated `state_fields`, or use these built-in presets:

| Preset           | Command         | Questions                                                                                                                        |
| ---------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `steering`       | `interruptions` | What kind of correction was this, and was the assistant heading the wrong way?                                                   |
| `error-resolved` | `errors`        | Was the error resolved in following turns, and was the resolution a code fix, environment fix, retry, workaround, or unresolved? |
| `task-kind`      | `sessions`      | Is this feature, bugfix, refactor, research, ops, docs, review, or other, and is it delegation-shaped?                           |
| `relevance`      | `search`        | Score the hit from unrelated to directly answering the supplied `--query`, and identify concrete examples.                       |

The response has top-level `judge.status`, `reason`, `rows_judged`, `rows_cached`, and `estimated_input_tokens`. Each row has `judge.status`, `reason`, `error_class`, and `answers`. Trust answers with `uncertain: false`; inspect uncertain answers yourself. Choice answers include probabilities and confidence. Noul answers use a probability and are uncertain in the middle range.

Set `TYPESAFE_API_KEY` before a live judgment run. The default model is `jev-latest`; `TYPESAFE_DEFAULT_MODEL` can override it. A missing key, `APIConnectionError`, `APITimeoutError`, `AuthenticationError`, `RateLimitError` after SDK retries, `UnprocessableEntityError`, or an answer that fails validation leaves every affected row in the response and marks it `skipped`. The reason is one of `no_api_key`, `connection`, `timeout`, `auth`, `rate_limit`, or `bad_answer`; the command prints one diagnostic line to stderr and exits 0. A partially successful batch reports `partial`. Use `--no-cache` to bypass the SQLite judgment cache and `--max-judge-rows` to bound spend.

State is redacted before it is sent and truncated from both ends under the 32,000-token budget. The estimate is printed to stderr and returned as `estimated_input_tokens`. As a rough cost bound, `--max-judge-rows=5` makes at most five requests, each capped at 32,000 input tokens, while cached rows make no request. Start with `--limit=5` and a low max-row value before widening a run.

## Redaction

JSON and table output redact secrets by default. Recognized patterns include Anthropic and generic API keys, GitHub tokens, AWS access keys and high-entropy secrets, Stripe keys, bearer tokens, `enc:v1:` payloads, high-entropy `KEY=`, `TOKEN=`, and `SECRET=` values, and private key blocks. Redacted values are rendered as `[redacted:<kind>]`. Use `--no-redact` only when the output is safe to handle, and never use it for a secret exposure sweep.

## SQL escape hatch

Use `sql --schema` to print the authoritative SQLite schema. The application tables are:

| Table            | Important columns                                                                                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `files`          | `path` primary key, `size`, `mtime`, `last_line`, `session_id`, `parent_session_id`, `ingested_at`                                                                                           |
| `projects`       | `dir` primary key, `decoded_path`, `cwd`, `last_activity`, `session_count`                                                                                                                   |
| `sessions`       | composite `id` key, raw `session_id`, `project_dir`, cwd and branch, parent session, agent name, prompts, timestamps, models, versions, message, tool, error, interruption, and token counts |
| `messages`       | composite `(session_id, uuid)` key, parent UUID, timestamp, type, role, text, injection and interruption markers, model, effort, and token counts                                            |
| `tool_calls`     | composite `(session_id, id)` key, message UUID, timestamp, name, JSON input, paired result, error marker, result timestamp, latency, subagent type, and skill name                           |
| `judgments`      | composite `(model, preset, question_hash, state_hash)` key, JSON answer, and creation timestamp                                                                                              |
| `messages_fts`   | FTS5 external-content index over `messages.text`                                                                                                                                             |
| `tool_calls_fts` | FTS5 external-content index over `tool_calls.input` and `tool_calls.result_text`                                                                                                             |

Only a single read-only `SELECT` statement is accepted. `sql --limit=<value>` adds a limit when the statement has none. Use bound-safe literal values, and prefer named commands when one exists.

## Recipes

Each recipe below is a read against the live index. The examples use `--no-sync --limit=5` so they are quick to repeat. Replace the canonical project root when needed.

### Tech adoption candidates

```bash
bun $SKILL_DIR/scripts/cli.ts sessions --project=/absolute/path/to/repository --first-prompt="adopt" --sort=messages --judge=task-kind --no-sync --limit=5
```

### Steering interruptions

```bash
bun $SKILL_DIR/scripts/cli.ts interruptions --project=/absolute/path/to/repository --judge=steering --no-sync --limit=5
```

Injected skill-expansion turns are excluded by default. Add `--include-injected` to inspect them, including with `--judge=steering`; returned rows identify them with `is_injected: true`.

### Recurring error prior fix

```bash
bun $SKILL_DIR/scripts/cli.ts errors --project=/absolute/path/to/repository --judge=error-resolved --no-sync --limit=5
```

### Time-boxed change audit

```bash
bun $SKILL_DIR/scripts/cli.ts search "changed implemented fixed" --regex="changed|implemented|fixed" --project=/absolute/path/to/repository --since=7d --until=1d --in=all --no-sync --limit=5
```

### Secret exposure sweep

```bash
bun $SKILL_DIR/scripts/cli.ts search "token" --regex="sk-ant-|sk_live_|sk_test_|ghp_|gho_|github_pat_|AKIA|Bearer " --project=/absolute/path/to/repository --since=90d --in=all --include-injected --no-sync --limit=5
```

Keep redaction enabled for this recipe.

### Implementation archaeology

```bash
bun $SKILL_DIR/scripts/cli.ts search "implementation" --project=/absolute/path/to/repository --in=all --include-subagents --no-sync --limit=5
```

### Delegation mining

```bash
bun $SKILL_DIR/scripts/cli.ts tools --project=/absolute/path/to/repository --name=Agent --include-subagents --input="task|prompt" --no-sync --limit=5
```

### Retro on a session set

```bash
bun $SKILL_DIR/scripts/cli.ts sessions --project=/absolute/path/to/repository --since=30d --sort=messages --no-sync --limit=5
```

Use the returned session IDs with repeated `--session=<value>` on `messages`, `tools`, `errors`, or `interruptions` for the focused retro.

### Tool and CLI usage census

```bash
bun $SKILL_DIR/scripts/cli.ts tools --project=/absolute/path/to/repository --name=Bash --input="bun|npm|pnpm|yarn" --since=7d --no-sync --limit=5
```

### Cost and habit analytics

```bash
bun $SKILL_DIR/scripts/cli.ts stats --project=/absolute/path/to/repository --since=30d --by=model --no-sync --limit=5
```

Repeat with `--by=day` or `--by=session` to compare habits over time.

### Evals from transcripts

```bash
bun $SKILL_DIR/scripts/cli.ts search "evaluation" --regex="assert|expected|test case|evaluation|eval" --project=/absolute/path/to/repository --since=90d --in=all --include-subagents --no-sync --limit=5
```

### Instruction drift

```bash
bun $SKILL_DIR/scripts/cli.ts search "instruction" --regex="system-reminder|CLAUDE\\.md|instruction" --project=/absolute/path/to/repository --since=90d --in=messages --include-injected --no-sync --limit=5
```

### Hook and allowlist mining

```bash
bun $SKILL_DIR/scripts/cli.ts search "hook" --regex="hook|allowed-tools|allowlist|permission" --project=/absolute/path/to/repository --since=90d --in=all --include-injected --no-sync --limit=5
```

### Unfinished work

```bash
bun $SKILL_DIR/scripts/cli.ts search "TODO" --regex="TODO|unfinished|remaining|follow[- ]?up|not done" --project=/absolute/path/to/repository --since=90d --in=messages --no-sync --limit=5
```

### Decision log

```bash
bun $SKILL_DIR/scripts/cli.ts search "decision" --regex="decided|decision|agreed|trade[- ]?off" --project=/absolute/path/to/repository --since=90d --type=user --no-sync --limit=5
```

### Hallucinated API catalog

```bash
bun $SKILL_DIR/scripts/cli.ts search "API" --regex="does not exist|not found|unknown method|API" --project=/absolute/path/to/repository --since=90d --in=all --no-sync --limit=5
```

### Model and version regression

```bash
bun $SKILL_DIR/scripts/cli.ts stats --project=/absolute/path/to/repository --since=90d --by=version --no-sync --limit=5
```

Run the same recipe with `--by=model` to compare model cohorts.

### Prompt phrasing feedback

```bash
bun $SKILL_DIR/scripts/cli.ts search "please" --regex="please|could you|implement|fix|why|how" --project=/absolute/path/to/repository --since=30d --type=user --no-sync --limit=5
```

### Parser fixture generation

```bash
bun $SKILL_DIR/scripts/cli.ts sql "SELECT type, COUNT(*) AS records FROM messages GROUP BY type ORDER BY records DESC" --no-sync --limit=5
```

Use the rare record shapes from this result to choose cases for the bundled fixture generator.

### Project memory seeding

```bash
bun $SKILL_DIR/scripts/cli.ts projects --project=/absolute/path/to/repository --no-sync --limit=5
```

Use the project rows as the seed, then search its sessions and plans for durable decisions before writing project memory.

## File format reference

Claude Code stores project directories using a best-effort encoded path. A session is a JSONL file named by its session ID. Subagent transcripts are nested under `<session-id>/subagents/agent-*.jsonl`; they are indexed during sync and excluded from read results unless `--include-subagents` is supplied.

A line can be a `user`, `assistant`, `system`, `summary`, `queue-operation`, `attachment`, `last-prompt`, `ai-title`, `atis-latch`, or `file-history-snapshot` record. User and assistant `message.content` may be a plain string or an array of text, thinking, tool-use, and tool-result blocks. The index extracts both forms. `ai-title` records carry generated titles, and `attachment` records carry linked message data. Unknown control records are tolerated and skipped when they have no searchable text.

Plans are Markdown files under `~/.claude/plans/`; use the `plans` command rather than scanning that directory manually.

## Best practices

1. Do not modify conversation files. They are Claude Code's source of truth.
2. Use the indexed CLI for cross-session search and analysis. Do not grep or parse raw JSONL when the index can answer the question.
