# VHS Tape Syntax Reference

Complete reference for `.tape` file directives. See [SKILL.md](../SKILL.md) for workflow guidance.

## Tape Structure

```elixir
# 1. Output targets (one or more)
Output demo.gif
Output demo.mp4

# 2. Dependency assertions (optional)
Require gum

# 3. Settings — must precede first input command
Set Shell "zsh"
Set FontSize 14
Set Width 1200
Set Height 800
Set Theme "Catppuccin Mocha"

# 4. Hidden setup (optional)
Hide
Type "cd ~/project && clear"
Enter
Show

# 5. Recorded interaction
Type "command"
Enter
Wait /done/
Sleep 1s
```

## Output

| Form                  | Result                                                 |
| --------------------- | ------------------------------------------------------ |
| `Output demo.gif`     | Animated GIF                                           |
| `Output demo.mp4`     | H.264 MP4                                              |
| `Output demo.webm`    | WebM                                                   |
| `Output frames/`      | PNG sequence in `frames/` (trailing slash is required) |
| `Output golden.ascii` | Text/ASCII snapshot (useful for CI diffing)            |
| `Output golden.txt`   | Same as `.ascii`                                       |

Stack multiple `Output` lines in one tape to emit several formats from a single render.

## Require

Asserts a program is on `PATH` before rendering. Must appear before any input command, alongside `Output` and `Set`.

```elixir
Require gum
Require glow
```

If any required program is missing, VHS exits before starting the recording.

## Set Options

All `Set` directives must appear before the first input command. **Exception:** `Set TypingSpeed` may be re-applied mid-tape.

### Terminal

| Option       | Type      | Default     | Notes                                                                    |
| ------------ | --------- | ----------- | ------------------------------------------------------------------------ |
| `Shell`      | string    | `bash`      | `bash`, `zsh`, `fish`, `nu`, `osh`, `powershell`, `pwsh`, `cmd`, `xonsh` |
| `Width`      | pixels    | `1200`      |                                                                          |
| `Height`     | pixels    | `600`       |                                                                          |
| `Padding`    | pixels    | `60`        | Space between terminal edge and content                                  |
| `Margin`     | pixels    | `0`         | Space outside the terminal (use with `MarginFill`)                       |
| `MarginFill` | hex color | `"#1e1e2e"` | Background behind the terminal                                           |

### Typography

| Option          | Type    | Default            | Notes                                 |
| --------------- | ------- | ------------------ | ------------------------------------- |
| `FontSize`      | number  | `22`               |                                       |
| `FontFamily`    | string  | `"JetBrains Mono"` | Quoted; must be installed on the host |
| `LetterSpacing` | pixels  | `0`                |                                       |
| `LineHeight`    | decimal | `1.0`              | e.g. `1.2`, `1.8`                     |

### Theme

| Option  | Type         | Notes                                                                                                                                                                                                 |
| ------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Theme` | name or JSON | `Set Theme "Dracula"`, `Set Theme "Catppuccin Mocha"`, or inline `Set Theme { "background": "#000", "foreground": "#fff", "cursor": "#fff", "selection": "#444", "black": "#000", "red": "#f00", … }` |

Run `vhs themes` for the full installed list. Names are case- and space-sensitive.

### Window Chrome

| Option         | Type   | Values                                             |
| -------------- | ------ | -------------------------------------------------- |
| `WindowBar`    | enum   | `Colorful`, `ColorfulRight`, `Rings`, `RingsRight` |
| `BorderRadius` | pixels | e.g. `10`                                          |
| `CursorBlink`  | bool   | `true`, `false`                                    |

### Timing & Playback

| Option          | Type           | Default | Notes                                                                                          |
| --------------- | -------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `TypingSpeed`   | duration       | `50ms`  | Per-keystroke delay; may be changed mid-tape                                                   |
| `Framerate`     | number         | `50`    | Frames per second of the encoded output                                                        |
| `PlaybackSpeed` | multiplier     | `1.0`   | `0.5` = 2× slower, `2.0` = 2× faster                                                           |
| `LoopOffset`    | frames or `N%` | `0`     | For GIFs: skip the first N frames on loop (useful to drop intro setup from the looped portion) |
| `WaitTimeout`   | duration       | `15s`   | Default upper bound on `Wait`                                                                  |
| `WaitPattern`   | regex          | `/>$/`  | Default regex used by bare `Wait`                                                              |

## Input Commands

### Text

| Command                  | Notes                                                                       |
| ------------------------ | --------------------------------------------------------------------------- |
| `Type "text"`            | Standard typing. Use backticks `` Type `say "hi"` `` to embed double quotes |
| `Type@<duration> "text"` | Override `TypingSpeed` for this one line: `Type@500ms "slow"`               |
| `Copy "text"`            | Place text on the simulated clipboard                                       |
| `Paste`                  | Paste the last `Copy`ed value                                               |

### Keys

All key commands accept an optional repeat count, and most accept a `@<duration>` per-keystroke delay.

| Command                                          | Examples                          |
| ------------------------------------------------ | --------------------------------- |
| `Enter [N]`                                      | `Enter`, `Enter 3`                |
| `Backspace [N]`                                  | `Backspace 12`                    |
| `Tab[@<dur>] [N]`                                | `Tab@200ms`, `Tab 2`              |
| `Space [N]`                                      |                                   |
| `Escape [N]`                                     |                                   |
| `Up`, `Down`, `Left`, `Right` `[N]`              | `Down 3`                          |
| `PageUp [N]`, `PageDown [N]`                     |                                   |
| `ScrollUp[@<dur>] [N]`, `ScrollDown[@<dur>] [N]` | Wheel events                      |
| `Ctrl+<key>`                                     | `Ctrl+C`, `Ctrl+L`, `Ctrl+R`      |
| `Alt+<key>`                                      | `Alt+.`                           |
| `Shift+<key>`                                    | `Shift+Tab`                       |
| Combined modifiers                               | `Ctrl+Shift+R`, `Ctrl+Alt+Delete` |

### Timing

| Command               | Notes                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------- |
| `Sleep <duration>`    | Fixed pause. `Sleep 0.5`, `Sleep 500ms`, `Sleep 2s`                                   |
| `Wait`                | Block until last line matches `WaitPattern` (default `/>$/`) or `WaitTimeout` elapses |
| `Wait /regex/`        | Same as `Wait+Line` — matches only the last line, not the whole screen                |
| `Wait+Screen /regex/` | Search the full visible screen                                                        |
| `Wait+Line /regex/`   | Search only the last line                                                             |
| `Wait@<poll> /regex/` | Override poll interval, e.g. `Wait@10ms /ready/`                                      |

### Recording Control

| Command                    | Effect                                         |
| -------------------------- | ---------------------------------------------- |
| `Hide`                     | Stop capturing frames (commands still execute) |
| `Show`                     | Resume capturing frames                        |
| `Screenshot path/file.png` | Save a single frame at this point              |

### Other

| Command             | Notes                                                                |
| ------------------- | -------------------------------------------------------------------- |
| `Env KEY "value"`   | Set an env var before running the shell                              |
| `Source other.tape` | Inline the contents of another tape — useful for shared header/setup |
| `#`                 | Comment to end of line                                               |

## CLI

| Command                  | Effect                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `vhs file.tape`          | Render to all `Output` targets in the tape                                                                         |
| `vhs validate file.tape` | Parse only; no render                                                                                              |
| `vhs record > out.tape`  | Capture keystrokes from an interactive session into a tape                                                         |
| `vhs publish file.gif`   | Upload to vhs.charm.sh, return shareable URL                                                                       |
| `vhs themes`             | List installed themes                                                                                              |
| `vhs serve`              | Run a VHS server; clients submit tapes over SSH. Env: `VHS_PORT`, `VHS_HOST`, `VHS_UID`, `VHS_GID`, `VHS_KEY_PATH` |
| `vhs new file.tape`      | Scaffold a new tape from the built-in template                                                                     |

## Dependencies

- **`ttyd`** — VHS spawns ttyd to run the recorded shell. Without it: `exec: "ttyd": executable file not found in $PATH`.
- **`ffmpeg`** — Used for video/GIF encoding.

macOS: `brew install vhs ttyd ffmpeg`. Linux: distribution package or download from each project's releases.

## Common Pitfalls

- `Set` after the first input is silently ignored (except `TypingSpeed`).
- `Require` after any input is silently ignored.
- Default `Wait` regex `/>$/` does not match prompts that end in other characters (fish, starship, custom PS1). Pass an explicit regex or override `PS1` in `Hide` setup.
- `Output frames` without trailing slash writes a single file literally named `frames`, not a PNG sequence.
- `Type` reproduces typos. Quote carefully; backticks escape internal double quotes.
- `Hide` does **not** prevent the shell from executing the typed command — it only suppresses frame capture. Side effects (filesystem writes, network calls) still happen.
