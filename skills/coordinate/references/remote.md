# Remote delegates

A delegate started with `--machine <name>` runs on another Herdr machine (a name `hc machine ls` lists). Read this before launching one, verifying or ending one, and when a `machine-unreachable`, `notify` or `delegate-outbox-invalid` event arrives. Everything not named here works as for a local delegate.

## Launch

- `--machine` goes on a `--repo` launch; `--cwd` and `--no-space` are refused with it, and a name for this machine launches here.
- The repo needs a checkout recorded for that machine (`coordinate backlog boundary add <repo> --machine <name> --checkout <path>`), else the launch is refused naming the missing entry.
- coordinate then checks there that the harness, git and the base tools copy-back, fetch and the process scan use (tar, gzip, base64, fold, mktemp, ps, sha256sum or shasum) are on the login PATH, that the machine has Linux `/proc`, and that the checkout is a Git repository. A missing tool is refused (exit 1) as that machine's own domain's setup to file, never installed from here.
- It makes `<checkout>/.claude/worktrees/<name>` with git on that machine on the usual branch, runs the repo's declared worktree setup there through `hc exec` (the same log and refusal as a local launch, the log on that machine), writes the brief to its `.scratch/BRIEF.md` with a Delegate outbox section appended ([brief.md](brief.md#remote-delegates-the-delegate-outbox-variant)), and starts the harness in its own Herdr space there with the usual labels plus `fleet.machine=<name>`, and no WIKI.md.
- Its parent is the coordinator, as for a local delegate, only when `coordinate delegate` runs in the coordinator's own terminal: Herdr links a terminal on another machine only to the terminal that starts it, so a launch from anywhere else has no parent. The link runs one way, and the delegate cannot address its parent from that machine.
- The launch counts against that machine's budget, and `--queue-if-full` queues for that machine; on its capacity wake, retry with the same `--machine` ([capacity.md](capacity.md)).
- The item's delegate record carries `machine`, and its worktree, brief and report paths are on that machine.

## Status and follow-ups

The watcher follows it like a local delegate. `coordinate status` shows `[<machine>]` after its name, with its branch alone in place of PR state, since the branch lives on that machine; `status --json` gives `machine`, null for this machine. The Backlog panel shows the machine name beside it. `coordinate send`, `end`, `verify`, `item attach` and `item detach` take its name or its `<machine>/tN` address (two live terminals with one name are refused; give the address).

## Verify

Its REPORT.md is on that machine. At settle the watcher copies its `.scratch` to `<repo>/.scratch/parked/<name>/.scratch/` on this machine, where `<repo>` is the owned path whose checkout there holds its worktree: read the REPORT.md there first. A `<copy-back>` child on the `settled` event says why nothing was copied; then read it with `hc file read --on <machine> <report path>`. A remote delegate's `settled` event carries no `<wiki>` children.

Its branch is on that machine, so before you verify the diff, run `coordinate fetch <name>` (live or ended): git there bundles the branch past its base, Herdr reads the bundle here, and git fetches it into the repo here under the same branch name, fast-forward only, refreshing the parked copy too. Nothing is pushed and no forge is called. Verify and land that local branch exactly as a local delegate's; after more commits there, fetch again. fetch refuses when the repo here lacks the branch's base commit, or the branch has no commits past it.

## Delegate outbox

That machine has no coordinate CLI, so the delegate appends finding and notify lines to its delegate outbox, `.scratch/OUTBOX.jsonl`, instead ([brief.md](brief.md#remote-delegates-the-delegate-outbox-variant) has the line shapes). The watcher drains it each tick, applying each line once even across restarts and resumes: a finding lands as an open finding with source `delegate:<name>`, and a notify arrives as a `notify` event.

## Events

| Event                     | What you do                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `machine-unreachable`     | Names a `machine` hosting one of this domain's delegates that is not connected, once per outage. Its delegates keep their last state, so they fire no `gone` while it is down, and their `settled` or `gone` events arrive after it reconnects. Tell the user, and if it stays down, file the repair in that machine's own domain. |
| `notify`                  | (`delegate`, `address`) carries a remote delegate's notify line as its text: handle it as that delegate's own notify.                                                                                                                                                                                                              |
| `delegate-outbox-invalid` | (`delegate`, `address`, `line`, `<error>`) names a delegate outbox line the watcher skipped: tell the delegate with `coordinate send` to append a corrected line.                                                                                                                                                                  |

## End and resume

`end` stops what the delegate left running on its own machine, its terminal's process tree and the orphans left in its worktree there, and prints each under `processes of <name> on <machine>:`. Its ended record keeps `machine`, the worktree path on that machine as `cwd`, and that machine's main checkout as `repo`. `coordinate resume <name>` starts it again on that machine, in that worktree and its own space there, under the same parent rule (`--no-space` does not apply), and refuses when the folder is gone there or the same preflight fails. Its worktrees are swept as [sweep.md](sweep.md#remote-worktrees) says.
