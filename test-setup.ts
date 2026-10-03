// `bun test --parallel` sets FORCE_COLOR=1 in its workers when the parent has a
// TTY. Tests that spawn a CLI with `...process.env` would pass it along, and the
// child's console.error would wrap stderr in ANSI codes, breaking exact-string
// assertions only when run interactively. Children should see a plain pipe.
delete process.env.FORCE_COLOR;
