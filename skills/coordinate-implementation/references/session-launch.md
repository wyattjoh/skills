# Starting and monitoring an implementor session

All paths below: `<repo>` is the main checkout, `<run>` is `.scratch/<slug>`,
`<prefix>` is a short run tag (for example `dcs`), `<ws>` is the herdr
workspace id from `herdr pane list`.

## 1. Worktree

```sh
cd <repo>
git worktree add .claude/worktrees/wyattjoh/<prefix>-NN-<slug> -b wyattjoh/<prefix>-NN-<slug> <base>
```

When `<base>` is not `main` and no worktree holds it yet, create the base
worktree first (once per base, shared by every run on it):

```sh
git show-ref --verify --quiet refs/heads/<base> || git branch <base> main
git worktree add .claude/worktrees/wyattjoh/<base> <base>
```

If `just crsqlite` fails inside the new worktree, copy `.crsqlite/` from the
main checkout instead of rebuilding (see the project memory on archive reuse).

## 2. Tab

```sh
herdr tab create --workspace <ws> --label "claude <prefix> NN <slug>" --no-focus
```

Parse `root_pane.pane_id` from the JSON result.

## 3. Launch

Write the launch line to `<run>/briefs/launch-NN.sh` with the Write tool (a
full inline line overflows the pane), then `herdr pane run <pane> "bash
<repo>/<run>/briefs/launch-NN.sh"`.

Use `claude` only for Anthropic models. For a non-Anthropic request such as
`openai-codex/gpt-5.6-luna`, use `pi` instead:

```sh
cd <worktree> && export PATH="$HOME/.cargo/bin:$PATH" XDG_DATA_HOME=<repo>/<run>/xdg-sandbox/data XDG_CONFIG_HOME=<repo>/<run>/xdg-sandbox/config && pi --model openai-codex/gpt-5.6-luna --thinking max '/skill:implement You are implementing ticket NN of the <slug> run. Read <repo>/<run>/briefs/common.md, <repo>/<run>/spec.md, and <repo>/<run>/issues/NN-<slug>.md first, then implement the ticket per the brief. IMPORTANT CONTEXT: <what earlier tickets already landed and what remains for this one>'
```

Never pass a non-Anthropic model to `claude`.

- `PATH` must put rustup's cargo first or `just crsqlite` fails on the
  nightly override (a no-op inside the devenv shell, where cargo already
  comes from the project toolchain).
- The XDG variables sandbox any accidental binary run.
- The `IMPORTANT CONTEXT` clause matters when an earlier ticket pulled in part
  of this one: tell the session to verify-then-implement only what remains.

### Implementor override

Default: `claude --model claude-opus-5 --effort high --permission-mode auto` for Anthropic; non-Anthropic overrides use `pi --model <model> --thinking <effort>`.
(user decision 2026-09-04). `--implementor '<model> <effort>'` on the skill
invocation, or an `Implementor:` line in `<run>/RESUME.md`, replaces the
`--model`/`--effort` pair for new sessions. pi is not a fallback; a worker
that fails restarts as a fresh Claude session in the same worktree (edits are
kept) with the partial work described in the `IMPORTANT CONTEXT` clause.

## 4. Monitor

Run as a background Bash (`run_in_background: true`, timeout 600000):

```sh
until [ "$(herdr pane list | python3 -c "import json,sys; print([p['agent_status'] for p in json.load(sys.stdin)['result']['panes'] if p['pane_id']=='<pane>'][0])")" = working ]; do sleep 5; done
herdr agent wait <pane> --until idle --until done --until blocked --timeout 3600000
```

When it fires:

- If the worktree has uncommitted changes, the worker likely went idle while
  its own test run continued: re-arm the same wait.
- If `git log <base>..HEAD` shows one commit, proceed to review.
- If a compaction just happened and there are no edits after two ticks, send
  one prompt: "Continue implementing ticket NN from where you left off."

## 5. Resuming a lost session

`cd <worktree> && claude --resume` in the worker's pane picks the ticket's
session back up. If no transcript is available (a new machine, a wiped
config dir), relaunch step 3 as a fresh session whose `IMPORTANT CONTEXT`
clause describes the edits and commits already in the worktree.

## Command-guard gotchas

The `dcg` guard blocks: heredoc `>` redirects into the repo (use the Write
tool), `git branch -d`, `git -C`, chained `sleep`. Use `cd` and `until` loops.
`herdr pane wait-output --regex` matches your own echoed prompt; use
`herdr agent wait` instead.
