---
name: claude-sessions
description: >-
  Parses and analyzes Claude Code conversation history. Triggers on "analyze a
  Claude Code conversation", "parse conversation history", "read session files",
  "extract messages from JSONL", "list Claude sessions", "find conversations by
  prompt", "search conversation content", "find projects", "search plans", or mentions
  "sessions-index.json", ".jsonl conversation", "Claude Code history", "conversation
  parser".
argument-hint: "[project-name]"
allowed-tools: Bash(bun:*), Read, Grep, Glob
effort: medium
model: haiku
---

# Conversation Analyzer

Tools and guidance for parsing Claude Code's conversation files to extract insights, analyze patterns, and understand session history.

## Quick Start

1. **Discover all projects**:

   ```bash
   bun $SKILL_DIR/scripts/list-projects.ts
   ```

2. **List sessions** for a project:

   ```bash
   bun $SKILL_DIR/scripts/list-sessions.ts ~/.claude/projects/<project-path>
   ```

3. **Search across conversations**:

   ```bash
   bun $SKILL_DIR/scripts/search-content.ts ~/.claude/projects/<project-path> --pattern="search term"
   ```

4. **Parse a specific conversation**:

   ```bash
   bun $SKILL_DIR/scripts/parse-conversation.ts <path-to-file.jsonl>
   ```

5. **Search plans directory**:
   ```bash
   bun $SKILL_DIR/scripts/search-plans.ts --pattern="research topic"
   ```

## Scripts

### list-projects.ts

Discover and list all Claude Code project directories:

```bash
bun $SKILL_DIR/scripts/list-projects.ts [options]

Options:
  --search=TERM          Filter projects containing TERM in path
  --format=json|table    Output format (default: table)
  --sort=date|sessions   Sort by last modified or session count (default: date)
  --limit=N              Show only N projects
```

**Example output:**

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ Claude Code Projects                                                                       │
├──────────────────────────────────────────────────┬──────────────────────┬─────────────────┤
│ Project Path                                     │ Last Modified        │ Sessions        │
├──────────────────────────────────────────────────┼──────────────────────┼─────────────────┤
│ .../github.com/wyattjoh/skills-private           │ Jan 18, 2026, 2:00 PM│              25 │
│ .../conductor/workspaces/next.js/santo-domingo   │ Jan 18, 2026, 1:30 PM│               8 │
└──────────────────────────────────────────────────┴──────────────────────┴─────────────────┘
```

### list-sessions.ts

List all sessions for a project with metadata:

```bash
bun $SKILL_DIR/scripts/list-sessions.ts <project-dir> [options]

Options:
  --format=json|table    Output format (default: table)
  --sort=date|messages   Sort by date or message count (default: date)
  --limit=N              Show only N most recent sessions
  --search=TERM          Filter sessions by first prompt content
```

### search-content.ts

Search across all conversations in a project for matching content:

```bash
bun $SKILL_DIR/scripts/search-content.ts <project-dir> --pattern="term" [options]

Options:
  --pattern=TERM         Search pattern (required, case-insensitive)
  --format=json|table    Output format (default: table)
  --limit=N              Maximum matches to return (default: 20)
  --context=N            Characters of context around match (default: 100)
  --type=all|user|assistant  Filter by message type (default: all)
```

**Example output:**

```
Found 5 matches for "authentication":

👤 USER      Jan 18, 2:30 PM
   Session: abc-123-def
   ...implement user authentication with JWT tokens...

🤖 ASSISTANT Jan 18, 2:31 PM
   Session: abc-123-def
   ...I'll add JWT authentication to the API routes...
```

### search-plans.ts

Search Claude Code's plans directory for research and planning documents:

```bash
bun $SKILL_DIR/scripts/search-plans.ts --pattern="term" [options]

Options:
  --pattern=TERM         Search pattern (required, case-insensitive)
  --format=json|table    Output format (default: table)
  --limit=N              Maximum matches to return (default: 10)
  --context=N            Characters of context around match (default: 150)
```

### parse-conversation.ts

Parse and display conversation content:

```bash
bun $SKILL_DIR/scripts/parse-conversation.ts <conversation.jsonl> [options]

Options:
  --format=json|readable|stats   Output format (default: readable)
  --include-thinking             Include thinking blocks in output
  --include-tools                Include tool calls in output
  --filter=user|assistant|all    Filter by message type (default: all)
  --search=TERM                  Only show messages containing TERM
```

## Common Workflows

### Find All Conversations About a Topic

```bash
# 1. First, find the project
bun $SKILL_DIR/scripts/list-projects.ts --search="my-project"

# 2. Search across all sessions in that project
bun $SKILL_DIR/scripts/search-content.ts \
  ~/.claude/projects/-Users-me-my-project --pattern="feature name"

# 3. Dive into a specific session
bun $SKILL_DIR/scripts/parse-conversation.ts \
  ~/.claude/projects/-Users-me-my-project/<session-id>.jsonl --search="feature name"
```

### Analyze Tool Usage Patterns

```bash
# Get statistics for a conversation
bun $SKILL_DIR/scripts/parse-conversation.ts <file.jsonl> --format=stats
```

### Find Recent Research Plans

```bash
# Search plans for a topic
bun $SKILL_DIR/scripts/search-plans.ts --pattern="architecture"

# Then read the full plan using the Read tool
# Read ~/.claude/plans/<filename>.md
```

### Export Conversation as JSON

```bash
# Full export with all message types
bun $SKILL_DIR/scripts/parse-conversation.ts <file.jsonl> --format=json > conversation.json

# Filtered export (only matching messages)
bun $SKILL_DIR/scripts/parse-conversation.ts <file.jsonl> \
  --format=json --search="error" --filter=assistant > errors.json
```

## File Format Reference

Claude Code stores conversations in `~/.claude/projects/<encoded-project-path>/`:

### Project Path Encoding

Paths are encoded by replacing `/` with `-`:

- `/Users/john/projects/myapp` → `-Users-john-projects-myapp`

### sessions-index.json

Central index of all sessions for a project containing metadata like session ID, file path, first prompt, message count, timestamps, git branch, and project path.

### Conversation Files (.jsonl)

JSON Lines format where each line is a message event:

| Type                    | Description                                    |
| ----------------------- | ---------------------------------------------- |
| `file-history-snapshot` | File state snapshots for undo/redo             |
| `user`                  | User messages (text or tool_result)            |
| `assistant`             | Assistant responses (text, thinking, tool_use) |
| `system`                | System configuration messages                  |
| `summary`               | Collapsed/summarized message sections          |

### Plans Directory

Claude Code stores research and planning documents in `~/.claude/plans/`:

- Markdown files with research summaries
- Created during plan mode sessions
- Useful for finding past investigations

## Best Practices

1. **Don't modify conversation files** - They're Claude Code's source of truth
2. **Scripts are read-only by design** - They only read from the filesystem for safety
3. **Use search-content.ts for cross-session search** - More efficient than grep on JSONL
4. **Use list-projects.ts to discover project paths** - Avoids manual path encoding

## Type Definitions

For complete TypeScript type definitions including `SessionsIndex`, `SessionEntry`, `ConversationEntry`, and all message content types, see `references/types.ts`.
