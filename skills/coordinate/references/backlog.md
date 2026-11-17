# Backlog

One JSON document per domain at `<state_dir>/backlogs/<domain>.json` (default `~/.local/state/coordinate`), beside the watcher's `watch/` and `ended/` folders. The `coordinate` CLI is its only writer: each command reads the document, applies one change, validates the result and writes it under a lock with a temp file and rename. Change it only through `backlog`, `item` and `finding` commands; `coordinate backlog show` renders it as Markdown and `--json` prints the document. It is working memory, not docs: plans, specs and reports live where the user keeps docs.

`coordinate start` creates the document. When `<backlog_dir>/<domain>-backlog.md` (default `~/.config/coordinate/backlogs`) exists from before, `start` records its path as `legacy` and never parses it; `backlog show` prints that pointer.

## Document

| Field           | Holds                                                                          | Set with                                       |
| --------------- | ------------------------------------------------------------------------------ | ---------------------------------------------- |
| `schemaVersion` | Always `1`                                                                     | `start`                                        |
| `domain`        | The domain name                                                                | `start`                                        |
| `focus`         | One line on what the domain is doing now, or null                              | `backlog focus "<text>"`, `--clear`            |
| `legacy`        | Path of the old Markdown backlog, reference only, or null                      | `start`                                        |
| `boundary`      | `owned` and `adjacent` absolute paths; only `owned` feeds status, watch, sweep | `backlog boundary add\|rm <path> [--adjacent]` |
| `standingYes`   | `{ text, at }`: approvals for every later case, in the user's words, dated     | `backlog standing add "<text>" [--at date]`    |
| `items`         | The work (below)                                                               | `item add`, `item update`, `item close`        |
| `findings`      | Issues and opportunities noticed outside an item's scope (below)               | `finding add`, `finding close`                 |
| `nextId`        | The next short id; items are `i1`, `i2`, ..., findings `f1`, `f2`, ...         | every add                                      |

## Items

| Field                              | Holds                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `title`                            | One line                                                                                                      |
| `status`                           | One of the statuses below                                                                                     |
| `touches`                          | Repos the item changes (`--touch`, `--untouch`)                                                               |
| `decided`                          | `{ text, at }`, the user's words, dated (`--decided`; `--answer` appends the answered ask here)               |
| `ask`                              | `{ question, context, options, rec, recReason }` or null (`--ask`, `--context`, `--option`, `--rec`, `--why`) |
| `due`                              | `YYYY-MM-DD` or null (`--due`, `--no-due`)                                                                    |
| `delegates`                        | `{ name, session, branch, worktree, brief, report }`, recorded by `delegate --item`                           |
| `createdAt`, `closedAt`, `outcome` | When it was added and closed, and the one-line outcome                                                        |

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

- A `delegated` item has at least one delegate; `delegate --item` adds it and sets the status.
- A `waiting-user` item has an ask, or a decision naming the integration choice it waits on.
- An ask's `rec` is one of its `options`.
- `done` and `dismissed` items, and closed findings, have an `outcome` and a `closedAt`.
- Ids are unique.

**Due dates**: the watcher fires once per item id and date, for items that are not closed. Editing the title does not fire it again.

**Delegates**: the session id is the stable key, so a resumed delegate needs no update. `coordinate status` adopts an unlabelled session the user started when an item's delegate names its session id. Ended delegates keep their record on the item; `coordinate status` lists them with their resume command.

## Findings

`{ kind, title, detail, path, from, status, closedAt, outcome }`: `kind` is `issue` or `opportunity`, `from` the item it was noticed under, `status` `open`, `acted` or `dismissed`. Delegates may run `coordinate finding add` (the domain comes from their terminal's label); every other change is the coordinator's.

## Retention

After each write, closed items and findings beyond the newest 50 move to `<state_dir>/backlogs/<domain>.archive.jsonl`, one record per line, so the history stays greppable.
