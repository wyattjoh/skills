# Sweep verdicts

`coordinate sweep report` reads every linked worktree of the domain's repos (`.claude/worktrees` included), landed branches, processes in deleted worktree folders, stale `.scratch` entries, and base checkouts ahead of their remote. It changes nothing. Herdr core's own processes (`hc` or `herdr-core` run with `--hc-launchd`, `hold` or `connect`, and the launchd server's ssh children) hold live terminals, so the report never counts or lists them.

| Verdict | Meaning                                                                                                                 | What you do                                                                                                                                                                               |
| ------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SAFE    | Work is on a base (fast-forward, merge, rebase or squash) or its PR merged; nothing uncommitted, no session, no process | Remove it in the same turn: `coordinate sweep remove <worktree>` (or `--all-safe`); `prune-branches <repo> <branch>...` for landed branch rows; `kill <pids>` for its own stray processes |
| CLOSE   | Finished, but a session still runs there                                                                                | `coordinate end <name>` for your delegate, then remove; a session the user started is theirs: tell them                                                                                   |
| ASK     | Work would be lost: uncommitted files, unpushed unlanded commits, a detached head, processes, stale scratch             | One ask per row in the next batch, naming what would be lost; never remove on your own                                                                                                    |
| KEEP    | In use: an open PR, a live session with changes, a base branch, unfinished work                                         | Nothing                                                                                                                                                                                   |
| INFO    | A base checkout ahead of its remote, or PRs that could not be read                                                      | Mention it when it matters to the user's next decision                                                                                                                                    |

`remove` recomputes the verdict and keeps anything not SAFE. It parks `.scratch/` under `<main>/.scratch/parked/<name>`, drops build output and other ignored files, deletes the branch with `git branch -d`, closes the delegate's space and prunes its ended record. It prints "removed N of M" with why each was kept.

When `git branch -d` refuses (a squash or rebase merge), the output prints the `git branch -D` command: give it to the user to run, and run nothing stronger yourself.

`coordinate sweep prune-ended` deletes ended-delegate records whose worktree is gone.
