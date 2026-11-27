# Spawn

`coordinate spawn <domain>` starts a coordinator for a domain, where `delegate` starts a worker on one item. Read this before spawning.

- It is refused from a delegate, an unlabelled terminal, or a plain shell outside Herdr, and (exit 1) while the domain has a live coordinator or another coordinator's live lease: go to that one instead.
- Before launching, it seeds that domain's backlog: it creates the backlog if missing, adds `--cwd` to its owned Boundary, and adds each `--item "<title>"` (repeatable) as an open item, unless an item not yet closed already has that title, which it reports as already present. Without `--cwd` it starts in the existing backlog's first owned Boundary path, and refuses when there is none.
- It launches `<domain>-coordinator` (a `.` becomes `-`, and a long domain is shortened with a hash) in its own unfocused space, tab `<Domain> · No active focus`, with no parent so it outlives you, and its first message starts the coordinate skill for that domain.
- `--harness`, `--model` and `--effort` follow the Delegate rules ([harness-policy.md](harness-policy.md)), checked against the new domain's harness policy.

It then waits about 120s for the new coordinator to arm the domain's watcher: a live watcher terminal it started, not a leftover one of another coordinator. `ready` exits 0 and names the watcher. `not ready` exits 1 after the backlog is seeded and the coordinator launched, so do not run spawn again (only an error before the launch makes a retry right, and it adds no item twice): when it is still starting or blocked on a dialog (the user answers it in the named tab), the terminal is left running; when it is gone, it ended before arming its watcher, so report that and ask. `--json` prints terminal, space, watcher and status.

Done when spawn prints `ready`, or you have given the user its not-ready line.
