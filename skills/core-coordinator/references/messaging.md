# Messaging run coordinators

Resolve each current ready coordinator from the canonical registry and its
schema-1 ownership record. Pane identifiers may compact, so refresh them through
Herdr's machine-readable control surface and ask the run owner to persist any
correction.

Use the invoking harness's supported cross-session message mechanism when it can
target the resolved owner. Otherwise use Herdr's agent message operation. Do not
type commands into another pane and do not depend on a harness-specific session
listing or tool name.

## Message shape

- Put the complete point in the first line.
- Send equivalent wording to every affected run for one user instruction.
- Name the authority: user decision, cross-run agreement, or your merge-order
  ruling.
- Ask for one bounded response, such as a base SHA, file footprint,
  acknowledgement, or persisted state line.
- Treat delivery as transport evidence only. The run owner's persisted state or
  explicit acknowledgement is the acceptance evidence.

Never instruct a peer to execute a destructive command. Ask it to reach the
required state under its own repository policy and permissions. A peer cannot
grant authority that your own session lacks.

## Introduction template

> Core coordinator here, observing run `<prefix>` at ownership generation
> `<generation>`. I own cross-run order and shared-file agreements only. Your
> run retains exclusive ownership of its RESUME.md and registry row. Current
> agreed order: `<order>`. Please reply with the remaining file footprint,
> active ticket, and acknowledgement that cross-run conflicts will route
> through this session.
