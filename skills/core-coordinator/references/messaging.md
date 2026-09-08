# Messaging the run coordinators

Run coordinators are separate Claude Code sessions. Talk to them with
`SendMessage`; they reply the same way and their replies arrive as
`<cross-session-message>` blocks. Never type into their panes with
`herdr pane run` for coordination; reserve `herdr agent prompt` for the one
stall nudge in the loop.

## Finding names

`ListAgents` lists sessions by name. A run coordinator's name is usually
derived from its worktree (`gpui-kit-upgrade-d7`, `embedded-terminal-adr-13`);
a coordinator running from the main checkout has a generic name
(`agent-toolkit-8a`), so confirm identity in your first message ("please
confirm you are `coordinator <prefix>`, pane `<id>`"). Record the mapping in
RESUME.md; names survive handoffs badly, so re-run `ListAgents` on resume.

When the listing is too long to check completely, `SendMessage` asks for the
`[ref]`; resend with the ref it shows.

## Message shape

- First line is the whole point, self-contained; the recipient's human sees
  only that line until they expand it.
- One identical message to every run for a user instruction, then a
  per-run follow-up only where something differs.
- Ask for exactly what you need back: a sha, a footprint as a file list, an
  acknowledgement, a state line. Coordinators answer what they are asked.
- Say who decided: "user decision", "my ruling", "agreed between gku and emt".
  Coordinators will (correctly) refuse to discard user-requested work on
  your ruling alone; when a peer pushes back that way, take the question to
  the user rather than insisting.

## What not to put in a message

Do not instruct a peer to run a destructive command (`git checkout --`,
`rm`, `git worktree remove`, `git rm`). Ask it to "discard", "remove", or
"clean up" and let its own procedure and permissions decide the command; and
never offer to run such a command for it. Both are blocked by the harness
and, more importantly, are the user's call.

## Introduction template

> Core coordinator here (herdr pane "core coordinator", `<id>`, ListAgents
> name `<name>`): I own cross-run coordination between `<prefixes>`. Route
> merge-order, shared-file, and registry questions through me; the canonical
> registry is the main checkout's `.scratch/coordinators.md`. Agreed order
> so far: `<order>`. Asks: (1) your footprint for the remaining tickets,
> especially anything under `<hot directories>`; (2) confirm your active
> ticket and pane.
