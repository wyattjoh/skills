---
name: vhs
description: Runs an interactive interview to author and render a Charmbracelet VHS tape, producing a terminal screencast as GIF, MP4, WebM, PNG, or ASCII. Walks through identifying the CLI, discovering its flow from source or `--help`, scripting interactive/TUI navigation, and confirming output formats, then renders into the CWD. Triggers on "VHS", "charmbracelet vhs", ".tape file", "tape file", "record terminal", "terminal GIF", "terminal recording", "make a demo gif", "screencast", "CLI demo", "demo a CLI", "record a demo", "walk me through recording", "interview me for a demo", "animate terminal". Use for the guided interview, direct tape authoring, debugging keystroke/prompt desync, choosing output formats, styling the captured terminal, or troubleshooting failed renders.
argument-hint: "[cli and flow | existing .tape]"
effort: medium
---

# VHS: Terminal Screencasts as Code

VHS turns a `.tape` script into a GIF/MP4/WebM/PNG recording of a real terminal session. The tape lists settings (`Set …`), input events (`Type`, `Enter`, `Down`, `Ctrl+C`, …), and timing (`Sleep`, `Wait`); `vhs file.tape` spawns a headless terminal (ttyd), replays the events, and encodes the result.

`vhs` requires `ttyd` and `ffmpeg` on `PATH`. On macOS: `brew install vhs ttyd ffmpeg`. Verify with `which vhs ttyd ffmpeg` before authoring if the user hasn't run VHS before.

## Two ways to use this skill

- **Interview Mode (guided)** — the user wants to be walked through recording a demo, says something like "record a demo of X", "walk me through this", or runs `/vhs <cli> <flow>` without a finished tape. Drive the interview below.
- **Direct authoring** — the user hands you concrete specs or an existing `.tape`, or asks a focused syntax/timing/styling question. Skip the interview and use the reference sections (Authoring a Tape onward).

When unsure which the user wants, ask. Don't force the interview on someone who already knows exactly what they want.

## Interview Mode

Two phases: an interview that produces a `.tape`, then an optional render. **Ask one question at a time** — each answer shapes the next question.

### Phase 1 — Interview → `.tape`

1. **Identify the tool.** What command is being demoed (`clerk`, `gh`, your own binary)? Is the CLI's source available? Ask for a path, or look in the CWD. Source is optional — `--help` and the user's description are enough.

2. **Discover the flow (read-only).** Build an accurate mental model of the exact prompt/screen sequence before scripting anything:
   - Read the CLI source if a path is given (find the prompt strings, default answers, and which selects need arrow navigation).
   - Run `<cli> --help` and `<cli> <subcommand> --help` directly — these are read-only.
   - Ask the user to describe the interactive flow in their words.
   - **Never auto-run the real command** to observe it. The real command only executes in the Phase 2 render, behind confirmation. If the flow can't be pinned down without running it, say so and let the user decide.

3. **Invocation.** The exact command and flags, the working directory, and any setup to bracket in `Hide`/`Show` (`cd …`, `clear`, building a binary). Setup runs but isn't captured.

4. **Interactive / TUI navigation.** Walk every prompt or screen in order. For each, capture: the default answer, which selects need arrow keys (`Down N` then `Enter`), text inputs (`Type "…"`), and any special keystrokes (`Tab`, `Ctrl+C`, `Space` to toggle). Map each transition to a `Wait /anchor/` where the next state prints predictable output, or a `Sleep` for a purely visual pause. Prefer `Wait` over guessed `Sleep`s — this is where tapes desync.

5. **Styling.** Theme, dimensions, font size, typing speed, window bar. Reasonable defaults: `Set Shell "zsh"`, `Set FontSize 14`, `Set Width 1400`, `Set Height 900`, `Set Theme "catppuccin-mocha"`, `Set TypingSpeed 100ms`. Confirm or adjust. Use `vhs themes` to verify a theme name.

6. **Verify output formats.** Default offer: **GIF + MP4**. Offer to add WebM, a PNG sequence (`Output frames/`), or ASCII (`.ascii`). Confirm before writing the tape.

Then **synthesize the tape** and write it to the **CWD** as `<cli>-<flow>.tape` (see Naming). Include a short comment header describing the flow and any baked-in parameters. Show the full tape contents and get explicit confirmation before rendering.

### Phase 2 — Render (on confirmation)

1. Confirm `vhs`/`ttyd`/`ffmpeg` are present.
2. Run `vhs validate <cli>-<flow>.tape` first — cheapest way to catch syntax errors.
3. **Side-effect gate.** Rendering runs every command the tape types, for real, every render. Before rendering, surface any mutation risk (deploys, writes, auth, network calls) and confirm the baked-in parameters (domains, IDs, file paths) are intentional. Get a clear go-ahead.
4. Run `vhs <cli>-<flow>.tape`. Outputs land in the CWD as `<cli>-<flow>.{gif,mp4,…}`.
5. Offer to scrub the result. Desyncs almost always mean an input fired before the program reached the expected state — replace the preceding `Sleep` with a `Wait` or extend it, then re-render.

### Naming

`cli` = the binary name, `flow` = the subcommand or a short kebab-case slug describing the demo. `clerk deploy` → `clerk-deploy.tape` / `clerk-deploy.gif` / `clerk-deploy.mp4`. Ask the user for the flow slug when it isn't obvious from the command.

### Safety boundary

Discovery is read-only (`--help`, source, the user's description). The only place arbitrary typed commands execute is the Phase 2 render, behind the explicit confirmation gate above.

## Quick Start (direct authoring)

```bash
cat > demo.tape <<'EOF'
Output demo.gif

Set Shell "zsh"
Set FontSize 14
Set Width 1200
Set Height 800
Set Theme "Catppuccin Mocha"
Set TypingSpeed 75ms

Type "echo hello"
Sleep 500ms
Enter
Sleep 2s
EOF

vhs demo.tape
```

## Authoring a Tape

A tape is read top-to-bottom. The canonical order is:

```
Output <file>          # one or more — render targets
Set <option> <value>   # all Set lines belong here, before any input
Require <program>      # optional dependency assertions
<input + timing>       # Type / Enter / Sleep / Wait / Hide / Show / …
```

**Settings placement matters.** Every `Set` directive must sit above the first input or non-output command, or it is silently ignored. The only exception is `Set TypingSpeed`, which may be re-applied mid-tape.

**Multiple outputs in one run.** Stack `Output` lines to emit several formats from a single render:

```elixir
Output demo.gif
Output demo.mp4
Output frames/   # trailing slash = PNG sequence
```

**Hide setup, show the demo.** Use `Hide` / `Show` to bracket setup that should not appear (e.g. `cd …`, `clear`, building a binary). Frames are not captured between `Hide` and `Show`, but the shell still runs the commands.

```elixir
Hide
Type "cd ~/project && clear"
Enter
Show
```

## Driving Input

| Need                     | Command                                                        |
| ------------------------ | -------------------------------------------------------------- |
| Type literal text        | `Type "text"` (use backticks `` `…` `` to embed double quotes) |
| Type slower for one line | `Type@500ms "slow"`                                            |
| Press a key              | `Enter`, `Tab`, `Space`, `Backspace`, `Escape`                 |
| Press N times            | `Down 3`, `Backspace 12`, `Enter 2`                            |
| Arrow keys               | `Up`, `Down`, `Left`, `Right`                                  |
| Page keys                | `PageUp`, `PageDown`                                           |
| Scroll                   | `ScrollUp 5`, `ScrollDown@50ms 10`                             |
| Modifiers                | `Ctrl+C`, `Ctrl+Shift+R`, `Alt+.`                              |
| Paste from clipboard     | `Copy "text"` then `Paste`                                     |

## Timing: Sleep vs Wait

`Sleep` is dumb — it pauses for a fixed duration regardless of what the terminal is doing. `Wait` is smart — it polls the terminal output for a regex and continues as soon as it matches (default timeout 15s, override with `Set WaitTimeout 30s` or `Wait@10ms`).

```elixir
Set WaitTimeout 30s

Type "npm install"
Enter
Wait /added \d+ packages/     # blocks until npm prints success

Type "./app --help"
Enter
Wait+Line />\s*$/             # match only on the last line (the prompt)
```

Prefer `Wait` over long `Sleep`s whenever the target output is predictable. `Sleep` is fine for short visual pauses ("let the user read this for 2s") or when no stable string identifies the next state.

**Common timing failure**: VHS sends keystrokes as soon as the previous `Sleep` ends, even if the program hasn't finished printing. If the script feeds an `Enter` while a spinner is still mid-API-call, every later input is desynced. When in doubt, replace `Sleep <N>` with `Wait /<prompt-anchor>/` and bump `Set WaitTimeout`.

## Styling

Common tweaks for a polished demo:

```elixir
Set FontSize 14
Set FontFamily "JetBrains Mono"
Set Width 1400
Set Height 900
Set Padding 20
Set Margin 40
Set MarginFill "#1e1e2e"
Set Theme "Catppuccin Mocha"        # or any name from `vhs themes`
Set WindowBar Colorful              # macOS-style traffic-light bar
Set BorderRadius 10
Set Framerate 60
Set PlaybackSpeed 1.0
Set CursorBlink false
```

For the theme name, use `vhs themes` (or `vhs themes | grep -i <name>`) to confirm exact spelling — themes are name-sensitive. A custom theme can be inlined as JSON: `Set Theme { "background": "#000", "foreground": "#fff", … }`.

See [references/syntax.md](references/syntax.md) for the full list of `Set` options with valid values.

## Rendering

```bash
vhs demo.tape                 # render to whatever Output lines specify
vhs validate demo.tape        # parse only, no render
vhs record > new.tape         # interactively capture a session to a tape
vhs publish demo.gif          # upload to vhs.charm.sh
vhs themes                    # list available themes
```

If a render fails, the tape parser usually points at the line — `vhs validate` is the fastest way to surface syntax errors without paying the encoding cost.

## Important Gotchas

1. **The recording actually runs the commands.** VHS spawns a real shell and executes everything the tape types. If the tape `Type`s a destructive command — `rm -rf`, `git push`, `terraform apply`, `clerk deploy` — the side effects happen for real, every time the tape is rendered. Flag this explicitly when the tape drives anything that mutates remote state, files outside the project, or interactive auth.

2. **Hidden secrets aren't really hidden.** `Hide` only suppresses frame capture — it does not prevent the shell from running the typed command, and the command can still touch the filesystem, hit the network, or read env vars. Don't `Type` real credentials in a tape; use placeholder values or env substitution.

3. **Set must come before input.** The first `Type`/`Enter`/etc. freezes the configuration. A `Set Theme` placed below input is ignored without warning. `TypingSpeed` is the only setting safe to change mid-tape.

4. **Default `Wait` regex is `/>$/`.** That works for most prompts but breaks on shells with non-`>`-terminated prompts (e.g. starship, fish defaults). Pass an explicit regex or override the prompt for the recording.

5. **PNG sequence requires a trailing slash.** `Output frames/` emits per-frame PNGs into `frames/`; `Output frames` writes a single file literally named `frames`.

6. **`ttyd` and `ffmpeg` are mandatory.** Errors like `exec: "ttyd": executable file not found in $PATH` mean a missing dependency, not a bad tape. Install both, then re-run.

7. **GIF size grows with width × height × framerate × duration.** For large demos prefer MP4 (an order of magnitude smaller for the same fidelity); ship both if a GIF is needed for embed previews.

## References

- [references/syntax.md](references/syntax.md) — full command + `Set` reference with valid values and defaults.
- Official docs: https://github.com/charmbracelet/vhs
- Themes list: `vhs themes`
