# pi coordinator

Read this when this session runs in pi and a command reports `watcher unavailable` (Herdr cannot launch the watcher terminal).

## Watch fallback

Run one-shot `watch` unawaited (adding `--role manager` in the manager domain) and act on its output when it arrives. It exits on the first event batch, so run it again after handling that batch:

```js
$`bun $SKILL_DIR/scripts/coordinate.ts watch`
  .timeout(7_200_000)
  .nothrow()
  .then((out) => log(out.stdout));
```

Events arrive as the same `<event>` elements as from the watcher terminal, and control lines stay plain text: `alive` means nothing happened before the time limit; `blind` means Herdr, or the herdr-doc state home, could not be read three times; `owner gone` means the coordinator no longer runs. Those one-shot control lines exit the watcher.

## Watch messages mid-step

If a watch message arrives while you are working, finish the current step, then handle it.
