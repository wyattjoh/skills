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

Load the `pando` skill. Render `Branch template:` from RESUME.md by replacing
`<prefix>`, `NN`, and `<slug>`, then create that exact branch from
`<base checkout>` and capture the returned worktree path:

```sh
printf '%s\n' '{"schema_version":1,"input":{"branch":"<rendered-branch>","description":"Implement ticket NN for the <slug> run"}}' \
  | pando create --input-output json
```

Use the response branch as `<branch>` and response path as `<worktree>`. Pi
uses Pando for the entire worktree lifecycle, never raw `git worktree`
commands.

When `<base>` is not `main` and no checkout holds it yet, Pi uses
`pando switch <base>` and captures the printed path. Claude Code's native tool
cannot attach a new worktree to an arbitrary existing branch by name, so stop
and ask the user to provide the base checkout rather than falling back to raw
Git or Pando.

## 2. Tab

```sh
herdr tab create --workspace <ws> --label "claude <prefix> NN <slug>" --no-focus
```

Parse `root_pane.pane_id` from the JSON result.

## 3. Launch

Write the launch line to `<run>/briefs/launch-NN.sh` with the Write tool (a
full inline line overflows the pane). Before running it, set the ticket row to
`working` and create its `## Active tickets` block with the actual worktree,
branch, session name, tab label, pane id, `Phase: launching`, the launch-script
path, and `Monitor: not-armed`. Update RESUME.md and the coordinator registry
before `herdr pane run <pane> "bash <repo>/<run>/briefs/launch-NN.sh"`. This
write-before-launch order ensures a successor can recover every worker even if
the coordinator exits during a parallel batch.

Build the launch line from the ticket's **table row** in RESUME.md, never from
the run-wide `Implementor:` and never from a value you remember. The row's
`harness` chooses the binary and flag, and its `skills` render into the prompt
prefix. The list must begin with `implement`, so every worker prompt begins
with `/implement` for Claude or `/skill:implement` for Pi, followed by any
additional skill prefixes and only then the prose prompt. See
[resume-format.md](resume-format.md) for the vocabulary table. Prepend
environment setup only when the resolved shared brief explicitly requires it.
Otherwise launch with the worktree as the only environment assumption.

```sh
# harness: claude
cd <worktree> && claude --model <model> --effort <effort> --permission-mode auto '/implement You are implementing ticket NN of the <slug> run. Read <repo>/<run>/briefs/common.md, <repo>/<run>/spec.md, and <repo>/<run>/issues/NN-<slug>.md first, then implement the ticket per the brief. Other unblocked tickets may be running in parallel. Work only in this worktree, do not depend on unlanded changes from another ticket, and stay within this ticket scope. IMPORTANT CONTEXT: <what earlier tickets already landed and what remains for this one>'
```

```sh
# harness: pi
cd <worktree> && pi --approve --model <provider>/<model> --thinking <effort> --skill <path-to-implement> '/skill:implement You are implementing ticket NN of the <slug> run. Read <repo>/<run>/briefs/common.md, <repo>/<run>/spec.md, and <repo>/<run>/issues/NN-<slug>.md first, then implement the ticket per the brief. Other unblocked tickets may be running in parallel. Work only in this worktree, do not depend on unlanded changes from another ticket, and stay within this ticket scope. IMPORTANT CONTEXT: <what earlier tickets already landed and what remains for this one>'
```

For each additional recorded skill, append its `--skill <path>` flag to the Pi
command and its harness-specific prefix after the `implement` prefix. Keep the
recorded order.

Never pass a non-Anthropic model to `claude`.

**The two lines differ in three ways, not one.** Build each from the row's
`harness`; do not adapt one into the other by swapping the binary:

|             | `claude`                 | `pi`                                                        |
| ----------- | ------------------------ | ----------------------------------------------------------- |
| model       | `--model <model>`        | `--model <provider>/<model>`                                |
| effort      | `--effort <effort>`      | `--thinking <effort>`                                       |
| permissions | `--permission-mode auto` | no permission-mode flag; pass `--approve` for project trust |

A `model:` carrying a `:<level>` suffix is **split** into `--model` plus the
effort flag; a colon never reaches either CLI. See
[resume-format.md](resume-format.md).

The `IMPORTANT CONTEXT` clause matters when an earlier ticket pulled in part
of this one. Tell the session to verify what already landed and implement only
what remains.

### `implement` is explicit, not discoverable

Do not check whether `implement` appears in a harness's discoverable skill
listing. It is intentionally user-invoked and carries
`disable-model-invocation: true`, so absence from model discovery is expected.
Every worker still requires it as the first skill and first prompt prefix:

- **Claude:** Begin the prompt with `/implement`, then render any additional
  skills as `/<skill>`, then append the prose prompt.
- **Pi:** Pass `--skill <path-to-implement>` explicitly and begin the prompt
  with `/skill:implement`. Then pass and prefix each additional skill in row
  order before appending the prose prompt.

For Pi, resolve and record the explicit skill paths used by the launch line so
a successor can reconstruct it. Do not run an availability preflight for
`implement`; the launch itself is authoritative and a load failure stops the
ticket. Continue to validate every additional skill after `implement` against
the selected harness.

### Validate the model before the first launch of a run

`pi --list-models` prints every model pi can resolve, as `provider  model`.
Check the row's model appears there. If it does not, **say so and ask** — a
model absent from the catalog may mean a stale catalog (pi does startup network
work; `pi update` refreshes it) or a typo, and those want opposite fixes. Do not
substitute a neighbouring model to get moving; that silent downgrade is
invisible in every artifact the run later produces.

### Implementor record

The initial structured setup chooses the complete Implementor triple from
`roles.discover`, then validates it with `role.validate`. Persist harness,
model, and effort exactly as validated. Do not infer a harness from a model or
hardcode a repository-specific or machine-specific default.

`--implementor '<harness> <model> <effort>'` on the skill invocation replaces
the run-wide default after helper validation. Additional worker skills, while
they remain supported by this state schema, are changed in prose. Write the
change to RESUME.md before replying. It governs **the next ticket to start**
only; active tickets keep their table-bound record.

A launch that fails is reported and stops that ticket. Set its row to `blocked`,
keep its active runtime block with `Phase: launch failed` and `Monitor:
not-armed`, and continue scheduling other unblocked tickets in parallel mode.
Do not retry it with a different model, a different effort, or a shorter skills
list: `claude` accepts an unknown `--effort` with only a warning and runs at its
default, so a silent substitution here is indistinguishable from success.

## 4. Monitor

Run as a background Bash (`run_in_background: true`, timeout 600000):

```sh
until [ "$(herdr pane list | python3 -c "import json,sys; print([p['agent_status'] for p in json.load(sys.stdin)['result']['panes'] if p['pane_id']=='<pane>'][0])")" = working ]; do sleep 5; done
herdr agent wait <pane> --until idle --until done --until blocked --timeout 3600000
```

After arming it, set the active block to `Monitor: armed` and update `Phase:`
from the visible worker activity. When it fires, set `Monitor: settled` before
acting:

- If the worktree has uncommitted changes, the worker likely went idle while
  its own test run continued: re-arm the same wait and record `Monitor: armed`.
- If `git log <base>..HEAD` shows one commit, set the row to `review`, record
  `Phase: committed, awaiting review`, and proceed to review.
- If a compaction just happened and there are no edits after two ticks, send
  one prompt: "Continue implementing ticket NN from where you left off."

## 5. Resuming a lost session

`cd <worktree> && claude --resume` in the worker's pane picks the ticket's
session back up. If no transcript is available (a new machine, a wiped
config dir), relaunch step 3 as a fresh session whose `IMPORTANT CONTEXT`
clause describes the edits and commits already in the worktree.

A relaunch uses the ticket's bound row, unchanged, even if the run-wide
`Implementor:` has moved on since the ticket started.

## Herdr monitoring gotcha

`herdr pane wait-output --regex` can match the echoed launch prompt instead of
worker output. Use `herdr agent wait` for worker state transitions.
