# Backlog

One JSON document per domain at `<state_dir>/backlogs/<domain>.json` (default `~/.local/state/coordinate`), beside the watcher's `watch/` and `ended/` folders. The `coordinate` CLI is its only writer: each command reads the document, applies one change, validates the result and writes it under a lock with a temp file and rename. Change it only through `backlog`, `item` and `finding` commands; `coordinate backlog show` renders it as Markdown and `--json` prints the document. It is working memory, not docs: plans, specs and reports live where the user keeps docs.

`coordinate start` creates the document. When `<backlog_dir>/<domain>-backlog.md` (default `~/.config/coordinate/backlogs`) exists from before, `start` records its path as `legacy` and never parses it; `backlog show` prints that pointer.

## Document

| Field           | Holds                                                                          | Set with                                                              |
| --------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `schemaVersion` | Always `1`                                                                     | `start`                                                               |
| `domain`        | The domain name                                                                | `start`, `backlog rename <new>`                                       |
| `focus`         | One line on what the domain is doing now, or null                              | `backlog focus "<text>"`, `--clear`                                   |
| `legacy`        | Path of the old Markdown backlog, reference only, or null                      | `start`                                                               |
| `boundary`      | `owned` and `adjacent` absolute paths; only `owned` feeds status, watch, sweep | `backlog boundary add\|rm <path> [--adjacent]`                        |
| `policies`      | `{ id, text, at }[]`: reusable rules with stable short ids (`p1`, `p2`, ...)   | `backlog policy add\|ls\|rm\|replace`                                 |
| `items`         | The work (below)                                                               | `item add`, `item update`, `item close`, `item attach`, `item detach` |
| `findings`      | Issues and opportunities noticed outside an item's scope (below)               | `finding add`, `finding close`                                        |
| `nextId`        | The next shared item/finding id number; items use `iN`, findings `fN`          | item and finding adds                                                 |
| `nextPolicyId`  | The next policy id number (`p1`, `p2`, ...); removals do not reuse ids         | policy adds                                                           |

**Policies**: `backlog policy add "<text>" [--at YYYY-MM-DD]` appends a policy and prints its id. `policy ls` lists ids, dates and text; `policy rm <id>` removes one; `policy replace <id> "<text>" [--at YYYY-MM-DD]` updates its text and date while preserving its id. IDs are not reused after removal. Dates default to today. Each command supports `--domain` and `--json`.

A document that has `standingYes` but no `policies` migrates in memory when read: entries become `p1`, `p2`, ... in their existing order, preserving their text and date. Items without `answered` migrate in memory to `answered: []`; asks without `discuss` migrate to `discuss: null`, including asks in `answered` history. Read-only commands leave the source file untouched; its next successful write stores the `policies` field and no `standingYes` field, and stores `answered` and `discuss` for each item and ask. The panel uses the same validator and accepts both shapes.

## Items

| Field                              | Holds                                                                                                                            |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `title`                            | One line                                                                                                                         |
| `status`                           | One of the statuses below                                                                                                        |
| `touches`                          | Repos the item changes (`--touch`, `--untouch`)                                                                                  |
| `decided`                          | `{ text, at }`, dated user input or an ask event (`--decided`; answer and discussion requests append here)                       |
| `ask`                              | `{ question, context, options, rec, recReason, discuss }` or null (`--ask`, `--context`, `--option`, `--rec`, `--why`)           |
| `ask.optionDetails`                | Optional strings aligned with `ask.options`; omitted when no option has a detail                                                 |
| `ask.discuss`                      | `{ note, at }` or null; a pending request to discuss before deciding, with an optional one-line note and request date            |
| `answered`                         | Completed asks, each preserving the question, context, options, recommendation, answer, and `answeredAt` date; `discuss` is null |
| `due`                              | `YYYY-MM-DD` or null (`--due`, `--no-due`)                                                                                       |
| `delegates`                        | `{ name, session, branch, worktree, brief, report }`, recorded by `delegate --item` or `item attach`; removed by `item detach`   |
| `createdAt`, `closedAt`, `outcome` | When it was added and closed, and the one-line outcome                                                                           |

Use `--option "<label> :: <detail>"` to store a detail; parsing splits at the first delimiter and the detail is optional.

| Status         | Means                                                              |
| -------------- | ------------------------------------------------------------------ |
| `open`         | Recorded, not started                                              |
| `building`     | You are building it in this session                                |
| `delegated`    | A delegate works on it                                             |
| `waiting-user` | It waits on the user: an ask, or the integration they have to name |
| `parked`       | Set aside on purpose                                               |
| `done`         | Finished, with an outcome                                          |
| `dismissed`    | Dropped, with an outcome                                           |

The CLI refuses any change that would break these:

- A `delegated` item has at least one delegate; `delegate --item` and `item attach` add one and set the status, and `item detach` sets the item back to `open` when it removes the last. Ending the last live delegate leaves the item `delegated`; `end --item-status` sets its next status, and `status` and `backlog show` flag it (`[delegated, none live]`) until then.
- One session is filed under one item: attaching a session any item already names, open or closed, is refused with that item's id and the `item detach` command.
- A `waiting-user` item has an ask, or a decision naming the integration choice it waits on.
- An ask's `rec` is one of its `options`.
- `done` and `dismissed` items, and closed findings, have an `outcome` and a `closedAt`.
- Item, finding and policy ids are unique.

**Due dates**: the watcher fires once per item id and date, for items that are not closed. Editing the title does not fire it again.

**Answers, discussions and Boundary edits**: `coordinate item answer <id> <answer> --domain <d>` records the same input as `item update --answer`. `Discuss` or `Discuss: <note>` leaves the ask in place and the item `waiting-user`, stores `{ note, at }` in `ask.discuss` (an empty note when omitted), and appends `Discuss "<question>"` or `Discuss "<question>": <note>` to `decided`. It does not create an `answered` entry. A revised ask clears `ask.discuss`; a real answer moves the ask with `discuss: null`, the answer, and the `YYYY-MM-DD` answered date into `answered`, clears `ask`, and appends `Re "<question>": <answer>` to `decided`. The discussion decision is an event record, not a final choice. `backlog show` prints the pending marker and a `discuss <date>` event; `status` summarizes pending discussions, and the panel shows `In discussion` with the note. A later ask stays open alongside earlier answered asks, shown newest first. The watcher fires `discuss <id> <title>: ...` once for each discussion request and `answered <id> <title>: ...` once for each real answer, whoever ran it. These are distinct events; a first arm, or a state file from before these events were tracked, seeds existing requests without firing them.

Outside a Herdr terminal (`HC_TERMINAL_ID` unset), the Backlog panel may submit answers or discussion requests with `coordinate item answer <id> <answer> --domain <d>`, and edit paths with `coordinate backlog boundary add <path> [--adjacent] --domain <d>` or `coordinate backlog boundary rm <path> --domain <d>`. These are the only backlog changes accepted from outside a terminal besides `backlog rename --domain` (below); `--domain` is required. Any terminal not labelled coordinator is still refused. Boundary add requires an existing path that is not already listed. Boundary rm removes the path from whichever Boundary list contains it and refuses a path in neither.

**Delegates**: the session id is the stable key, so a resumed delegate needs no update. `coordinate item attach <id> <delegate>` files a session already running, by name or terminal address: an unfiled delegate, or an agent the user started by hand. It records what `delegate --item` would have (the worktree and branch from the `fleet.worktree`/`fleet.branch` labels, else the Git checkout holding the terminal's folder, else null; brief and report under `<worktree>/.scratch/` when there is a worktree, else empty) and adds the labels `coordinate delegate` sets that the terminal lacks, never overwriting one. It refuses a coordinator, a terminal labelled for another domain, and one with no session id Herdr can see (no `fleet.session` label, no `--session-id` or `--resume` argument) unless `--session <id>` supplies it (Claude Code shows it in `/status`); a `--session` that differs from the one Herdr sees is refused. `coordinate item detach <id> <delegate>` takes a name, session id or address, works on closed items and ended delegates, and leaves the terminal's labels, so a live one shows as unfiled again. `coordinate status` adopts an unlabelled session the user started when an item's delegate names its session id. Ended delegates keep their record on the item; `coordinate status` lists them with their resume command.

## Findings

`{ kind, title, detail, path, from, status, closedAt, outcome }`: `kind` is `issue` or `opportunity`, `from` the item it was noticed under, `status` `open`, `acted` or `dismissed`. Delegates may run `coordinate finding add` (the domain comes from their terminal's label); every other change except `backlog rename --domain` is the coordinator's, and the CLI refuses it (exit 1) from any terminal not labelled `fleet.role=coordinator`, even with `--domain`. A coordinator's `--domain` may name another domain, which is how it routes an item there.

## Rename

`coordinate backlog rename <new>` renames this coordinator's domain, or `--domain <old>` from any terminal. Holding both domains' backlog locks, it writes `backlogs/<new>.json` (with `domain` set), `<new>.archive.jsonl` and `watch/<new>.json`, sets `domain` in each matching `ended/*.json` record, relabels the terminals carrying `fleet.domain=<old>` (a failed relabel is printed with its `hc label` command, not fatal), then removes the old files and a stale `watch/<old>.pid`. It refuses (exit 1) a new name `start` would refuse, a new name that already has a backlog or archive, an old domain with no backlog, a live delegate, and a live watcher. Text such as "(from <old>)" in other domains' items stays as written. It prints a warning when `keep_running` in the config names the old domain, and leaves a legacy Markdown backlog where the document's `legacy` field points.

A crash before the old backlog is removed leaves the old domain whole and a partial new one beside it (its ended records and labels possibly already renamed); delete `backlogs/<new>.json` and `<new>.archive.jsonl` and run it again with `--domain <old>`. A crash after leaves the rename done, with old archive or snapshot files to delete by hand.

## Retention

After each write, closed items and findings beyond the newest 50 move to `<state_dir>/backlogs/<domain>.archive.jsonl`, one record per line, so the history stays greppable.
