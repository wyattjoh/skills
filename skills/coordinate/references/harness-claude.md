# Claude Code coordinator

Read this when this session runs in Claude Code and a command reports `watcher unavailable` (Herdr cannot launch the watcher terminal), or before you put a backlog ask to the user in a question tool.

## Watch fallback

Run `bun $SKILL_DIR/scripts/coordinate.ts watch --follow --replace 2>&1` in the Monitor tool with `timeout_ms: 1800000`, adding `--role manager` in the manager domain.

- On Monitor expiry, run `coordinate status --resume`; if it still cannot launch a child watcher, re-arm the Monitor.
- Re-arm after `blind`, `owner gone`, or an exit with no line. `stopped` means it was replaced or stopped on purpose.
- An expiry with no events does not mean idle delegates are fine: run `coordinate status` before re-arming.

Events arrive as the same `<event>` elements as from the watcher terminal, and control lines stay plain text: `alive` means nothing happened before the time limit; `blind` means Herdr, or the herdr-doc state home, could not be read three times; `owner gone` means the coordinator no longer runs. Those one-shot control lines exit the watcher.

## Questions

The question tool for a backlog ask you need answered now is `AskUserQuestion`.
