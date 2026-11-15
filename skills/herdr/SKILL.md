---
name: herdr
description: "Controls Herdr persistent terminals, agents, and remote commands or files through herdr-core (hc), and inspects or customizes the visible app through herdr-app. Use when the user explicitly requests Herdr work, names herdr-core or herdr-app, or uses hc in a Herdr CLI context. Covers agent coordination, terminal output, spaces, tabs, panes, layouts, settings, and mods. Do not activate for generic delegation or background work."
---

# Herdr

Before acting, run and read the relevant installed manual:

- **Terminals, programs, agents, or remote commands and files:** `herdr-core --skill` (`hc --skill` is equivalent).
- **Visible window, spaces, tabs, panes, settings, layouts, or mods:** `herdr-app --skill`.
- **Work spanning both:** run and read both commands.

Follow those manuals as the source of operating instructions and command discovery. If a required manual cannot be loaded, report the error and stop rather than substituting the older `herdr` CLI or remembered syntax.

## Route agent messages deliberately

Before messaging an existing agent, identify it from the explicit delegation or parent-child relationship and use its exact terminal address. Use `hc get <address>` to confirm the observed agent and current folder; use the machine-qualified address returned by a remote launch. Treat names, list order, active space, and matching project or directory as clues, not identity. If the intended recipient or workspace is still ambiguous, stop and ask rather than guessing or falling back to another agent. A changed or unavailable recipient is not permission to redirect the message.

For child reports, use the coordinator's explicit address from the task or Herdr's reported `reach` instruction. `$HC_TERMINAL_ID` means the address of the process whose environment expands it: in the documented double-quoted launch example, the coordinator's shell expands it before starting the child; inside a child, it is that child's own address, not its parent's. Check the actual expanded target before sending when the launch context is unclear.
