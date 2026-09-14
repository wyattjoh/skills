# Starting and monitoring an implementor session

All paths below: `<repo>` is the main checkout, `<base checkout>` holds the
integration branch, `<run>` is `.scratch/<slug>`, `<prefix>` is a short run tag
(for example `dcs`), and `<ws>` is the herdr workspace id from
`herdr pane list`.

## 1. Worktree

The lifecycle follows the **coordinator's** harness, not the implementor
record bound to the ticket.

### Claude Code coordinator

With the Claude Code session rooted at `<base checkout>`, call
`EnterWorktree`. Record the generated path as `<worktree>` and its generated
`worktree-*` branch as `<branch>`. Do not assume either name, and do not run
raw `git worktree` commands or Pando from Claude Code.

Claude Code's configured `worktree.baseRef` must create the ticket from
`<base>`. Verify that `<base>` is an ancestor of `<branch>` before launching
the implementor. If it is not, exit and remove the invalid worktree, then stop
and ask the user to correct the base configuration rather than silently using
the wrong branch.

### Pi coordinator

Load the `pando` skill. From `<base checkout>`, create the ticket branch and
capture the returned worktree path:

```sh
printf '%s\n' '{"schema_version":1,"input":{"branch":"wyattjoh/<prefix>-NN-<slug>","description":"Implement ticket NN for the <slug> run"}}' \
  | pando create --input-output json
```

Use `wyattjoh/<prefix>-NN-<slug>` as `<branch>` and the response path as
`<worktree>`. Pi uses Pando for the entire worktree lifecycle, never raw
`git worktree` commands.

When `<base>` is not `main` and no checkout holds it yet, Pi uses
`pando switch <base>` and captures the printed path. Claude Code's native tool
cannot attach a new worktree to an arbitrary existing branch by name, so stop
and ask the user to provide the base checkout rather than falling back to raw
Git or Pando.

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

Build the launch line from the ticket's **table row** in RESUME.md, never from
the run-wide `Implementor:` and never from a value you remember. The row's
`harness` chooses the binary and the flag, and its `skills` render into the
prompt prefix. See [resume-format.md](resume-format.md) for the vocabulary
table.

```sh
# harness: claude
cd <worktree> && export PATH="$HOME/.cargo/bin:$PATH" XDG_DATA_HOME=<repo>/<run>/xdg-sandbox/data XDG_CONFIG_HOME=<repo>/<run>/xdg-sandbox/config && claude --model <model> --effort <effort> --permission-mode auto '/implement You are implementing ticket NN of the <slug> run. Read <repo>/<run>/briefs/common.md, <repo>/<run>/spec.md, and <repo>/<run>/issues/NN-<slug>.md first, then implement the ticket per the brief. IMPORTANT CONTEXT: <what earlier tickets already landed and what remains for this one>'
```

```sh
# harness: pi
cd <worktree> && export PATH="$HOME/.cargo/bin:$PATH" XDG_DATA_HOME=<repo>/<run>/xdg-sandbox/data XDG_CONFIG_HOME=<repo>/<run>/xdg-sandbox/config && pi --model <provider>/<model> --thinking <effort> --skill <path-to-each-skill> '/skill:implement You are implementing ticket NN of the <slug> run. Read <repo>/<run>/briefs/common.md, <repo>/<run>/spec.md, and <repo>/<run>/issues/NN-<slug>.md first, then implement the ticket per the brief. IMPORTANT CONTEXT: <what earlier tickets already landed and what remains for this one>'
```

Never pass a non-Anthropic model to `claude`.

**The two lines differ in three ways, not one.** Build each from the row's
`harness`; do not adapt one into the other by swapping the binary:

|             | `claude`                 | `pi`                           |
| ----------- | ------------------------ | ------------------------------ |
| model       | `--model <model>`        | `--model <provider>/<model>`   |
| effort      | `--effort <effort>`      | `--thinking <effort>`          |
| permissions | `--permission-mode auto` | **omit — pi has no such flag** |

A `model:` carrying a `:<level>` suffix is **split** into `--model` plus the
effort flag; a colon never reaches either CLI. See
[resume-format.md](resume-format.md).

- `PATH` must put rustup's cargo first or `just crsqlite` fails on the
  nightly override (a no-op inside the devenv shell, where cargo already
  comes from the project toolchain).
- The XDG variables sandbox any accidental binary run.
- The `IMPORTANT CONTEXT` clause matters when an earlier ticket pulled in part
  of this one: tell the session to verify-then-implement only what remains.

### pi loads no skill you do not hand it

**Check `pi --help` and the skill directories before the first pi launch of a
run.** If pi discovers no skills on this machine — no `~/.pi/skills`, no
`~/.config/pi/skills` — then `/skill:implement` in the prompt resolves to
nothing and **the session starts anyway, silently, with the brief absent**. That
is a worker implementing a ticket it never read. Nothing errors.

Pass `--skill <path>` once per entry in the row's `skills:` list, resolving each
against `~/.claude/skills/<name>`, and record the resolved paths in RESUME.md —
a successor coordinator inherits that file and nothing else. A skill whose
`SKILL.md` carries `disable-model-invocation: true` (`implement` does) must also
be invoked explicitly by its `/skill:<name>` prefix rather than relied on to
trigger.

### Validate the model before the first launch of a run

`pi --list-models` prints every model pi can resolve, as `provider  model`.
Check the row's model appears there. If it does not, **say so and ask** — a
model absent from the catalog may mean a stale catalog (pi does startup network
work; `pi update` refreshes it) or a typo, and those want opposite fixes. Do not
substitute a neighbouring model to get moving; that silent downgrade is
invisible in every artifact the run later produces.

### Implementor record

Default: `claude` / `claude-opus-5` / `high` / `[implement]`, launched with
`--permission-mode auto` (user decision 2026-09-04).

`--implementor '<model> <effort>'` on the skill invocation sets the model and
effort; you resolve the harness from the model and persist all four fields.
Worker skills are changed in prose. Either way the change is written to
RESUME.md before you reply, and it governs **the next ticket to start** only.

A launch that fails is reported and stops that ticket. Do not retry it with a
different model, a different effort, or a shorter skills list: `claude` accepts
an unknown `--effort` with only a warning and runs at its default, so a silent
substitution here is indistinguishable from success.

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

A relaunch uses the ticket's bound row, unchanged, even if the run-wide
`Implementor:` has moved on since the ticket started.

## Command-guard gotchas

The `dcg` guard blocks: heredoc `>` redirects into the repo (use the Write
tool), `git branch -d`, `git -C`, chained `sleep`. Use `cd` and `until` loops.
`herdr pane wait-output --regex` matches your own echoed prompt; use
`herdr agent wait` instead.
