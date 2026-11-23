# Backlog

One JSON document per domain at `<state_dir>/backlogs/<domain>.json` (default `~/.local/state/coordinate`), beside the watcher's `watch/` and `ended/` folders, `wiki-lint/` (each domain's last passing `wiki lint --mark` date) and `sessions/`, which keeps each delegate session's verify verdict and resume count. The `coordinate` CLI is its only writer: each command reads the document, applies one change, validates the result and writes it under a lock with a temp file and rename. Change it only through `backlog`, `item` and `finding` commands; `coordinate backlog show` renders it as Markdown and `--json` prints the document. It is working memory, not docs: plans, specs and reports live where the user keeps docs.

`coordinate start` creates the document. When `<backlog_dir>/<domain>-backlog.md` (default `~/.config/coordinate/backlogs`) exists from before, `start` records its path as `legacy` and never parses it; `backlog show` prints that pointer. Text output hides closed items by default and reports their count under Done; use `backlog show --done` or `status --resume --done` to include them. `--json` output is unchanged.

## Document

| Field           | Holds                                                                                                                        | Set with                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `schemaVersion` | Always `1`                                                                                                                   | `start`                                                               |
| `domain`        | The domain name                                                                                                              | `start`, `backlog rename <new>`                                       |
| `focus`         | One line on what the domain is doing now, or null                                                                            | `backlog focus "<text>"`, `--clear`                                   |
| `legacy`        | Path of the old Markdown backlog, reference only, or null                                                                    | `start`                                                               |
| `boundary`      | `owned` and `adjacent` absolute paths; only `owned` feeds status, watch, sweep                                               | `backlog boundary add\|rm <path> [--adjacent]`                        |
| `policies`      | `{ id, text, at, wiki? }[]`: reusable rules with stable short ids (`p1`, `p2`, ...); `wiki` names the page that explains one | `backlog policy add\|ls\|rm\|replace`                                 |
| `items`         | The work (below)                                                                                                             | `item add`, `item update`, `item close`, `item attach`, `item detach` |
| `findings`      | Issues and opportunities noticed outside an item's scope (below)                                                             | `finding add`, `finding close`, `finding promote`                     |
| `nextId`        | The next shared item/finding id number; items use `iN`, findings `fN`                                                        | item and finding adds                                                 |
| `nextPolicyId`  | The next policy id number (`p1`, `p2`, ...); removals do not reuse ids                                                       | policy adds                                                           |

**Policies**: `backlog policy add "<text>" [--at YYYY-MM-DD] [--wiki <page>]` appends a policy and prints its id. `--wiki` cites the page that explains the rule, by its name in the domain wiki or the shared wiki (the domain's is checked first); it refuses (exit 1, nothing written, no wiki created) when neither wiki has that page. The citation is stored as `wiki` and printed after the text as `(wiki: [[<page>]])` by `policy add`, `policy ls`, `policy replace` and `backlog show`, and beside the policy in the Backlog panel; `backlog show --json` includes it. `policy ls` lists ids, dates and text; `policy rm <id>` removes one; `policy replace <id> "<text>" [--at YYYY-MM-DD]` updates its text and date while preserving its id and citation. IDs are not reused after removal. Dates default to today. Each command supports `--domain` and `--json`.

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
| `in-review`    | Pushed and waiting for review; `item close` it when review passes  |
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

**Answers, discussions and Boundary edits**: `coordinate item answer <id> <answer> [--note "<note>"] --domain <d>` records the same answer and optional note as `item update <id> --answer "<answer>" [--note "<note>"]`. `Discuss` or `Discuss: <note>` leaves the ask in place and the item `waiting-user`, stores `{ note, at }` in `ask.discuss` (an empty note when omitted), and appends `Discuss "<question>"` or `Discuss "<question>": <note>` to `decided`. It does not create an `answered` entry. A revised ask clears `ask.discuss`; a real answer moves the ask with `discuss: null`, the answer, and the `YYYY-MM-DD` answered date into `answered`, clears `ask`, and appends `Re "<question>": <answer>` to `decided`. The discussion decision is an event record, not a final choice. `backlog show` prints the pending marker and a `discuss <date>` event; `status` summarizes pending discussions, and the panel shows `In discussion` with the note. A later ask stays open alongside earlier answered asks, shown newest first. The watcher fires a `discuss` event (the item id, `<title>` and `<request>`) once for each discussion request and an `answered` event (the item id, `<title>` and `<answer>`) once for each real answer, whoever ran it. These are distinct events; a first arm, or a state file from before these events were tracked, seeds existing requests without firing them.

Outside a Herdr terminal (`HC_TERMINAL_ID` unset), the Backlog panel may submit answers or discussion requests with `coordinate item answer <id> <answer> --domain <d>`, and edit paths with `coordinate backlog boundary add <path> [--adjacent] --domain <d>` or `coordinate backlog boundary rm <path> --domain <d>`, close an item with `coordinate item close <id> --outcome "<line>" [--dismissed] --domain <d>` (its Dismiss button), set an item's status to open, building, in-review or parked with `coordinate item update <id> --status <s> --domain <d>` and no other flag (the item detail's Change status), and approve or dismiss a finding with `coordinate finding promote <id> --domain <d>` or `coordinate finding close <id> --outcome "<line>" --dismissed --domain <d>` (the finding detail's Approve and Dismiss). These are the only backlog changes accepted from outside a terminal besides `backlog rename --domain` (below); `--domain` is required. Any terminal not labelled coordinator is still refused. Boundary add requires an existing path that is not already listed. Boundary rm removes the path from whichever Boundary list contains it and refuses a path in neither.

**Delegates**: the session id is the stable key, so a resumed delegate needs no update. `coordinate item attach <id> <delegate>` files a session already running, by name or terminal address: an unfiled delegate, or an agent the user started by hand. It records what `delegate --item` would have (the worktree and branch from the `fleet.worktree`/`fleet.branch` labels, else the Git checkout holding the terminal's folder, else null; brief and report under `<worktree>/.scratch/<name>/` when a `--cwd` start left a brief there, else under `<worktree>/.scratch/` when there is a worktree, else empty) and adds the labels `coordinate delegate` sets that the terminal lacks, never overwriting one. It refuses a coordinator, a terminal labelled for another domain, and one with no session id Herdr can see (no `fleet.session` label, no `--session-id` or `--resume` argument) unless `--session <id>` supplies it (Claude Code shows it in `/status`); a `--session` that differs from the one Herdr sees is refused. `coordinate item detach <id> <delegate>` takes a name, session id or address, works on closed items and ended delegates, and leaves the terminal's labels, so a live one shows as unfiled again. `coordinate status` adopts an unlabelled session the user started when an item's delegate names its session id. Ended delegates keep their record on the item; `coordinate status` lists them with their resume command.

## Findings

`{ kind, title, detail, path, from, source, createdAt, status, closedAt, outcome }`: `kind` is `issue` or `opportunity`, `from` the item it was noticed under, `source` where it came from when `finding add --source <ref>` gave one (such as `retro:<delegate>`; omitted otherwise, and `backlog show` prints it beside `from`), `createdAt` when `finding add` recorded it (findings added before the field existed have none), `status` `open`, `acted` or `dismissed`. `coordinate wiki lint` flags an open finding whose `createdAt` is more than 14 days old. Delegates may run `coordinate finding add` (the domain comes from their terminal's label); every other change except `backlog rename --domain` is the coordinator's, and the CLI refuses it (exit 1) from any terminal not labelled `fleet.role=coordinator`, even with `--domain`. A coordinator's `--domain` may name another domain, which is how it routes an item there.

`coordinate finding promote <id> [--title "<title>"]` turns an open finding into an open item in the same domain, titled after the finding unless `--title` overrides it, and closes the finding as `acted` with the outcome `promoted to <item id>`, in one locked write. It refuses an unknown id and a finding already closed. `--json` prints `{ item, finding }`. The Backlog panel's finding detail runs it as Approve, and runs `finding close --dismissed` as Dismiss.

## Rename

`coordinate backlog rename <new>` renames this coordinator's domain, or `--domain <old>` from any terminal. Holding both domains' backlog locks, it writes `backlogs/<new>.json` (with `domain` set), `<new>.archive.jsonl` and `watch/<new>.json`, sets `domain` in each matching `ended/*.json` record, relabels the terminals carrying `fleet.domain=<old>` (a failed relabel is printed with its `hc label` command, not fatal), then removes the old files and a stale `watch/<old>.pid`. It refuses (exit 1) a new name `start` would refuse, a new name that already has a backlog or archive, an old domain with no backlog, a live delegate, and a live watcher. Text such as "(from <old>)" in other domains' items stays as written. It prints a warning when `keep_running` in the config names the old domain, and leaves a legacy Markdown backlog where the document's `legacy` field points.

A crash before the old backlog is removed leaves the old domain whole and a partial new one beside it (its ended records and labels possibly already renamed); delete `backlogs/<new>.json` and `<new>.archive.jsonl` and run it again with `--domain <old>`. A crash after leaves the rename done, with old archive or snapshot files to delete by hand.

## Retention

After each write, closed items and findings beyond the newest 50 move to `<state_dir>/backlogs/<domain>.archive.jsonl`, one record per line, so the history stays greppable.
