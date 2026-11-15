---
name: herdr
description: "Controls Herdr terminals and agents with herdr-core (hc), and visible spaces, tabs, and panes with herdr-app. Use only when the user explicitly mentions Herdr or asks to use Herdr to inspect or control terminals, layout, commands, or another agent. Do not use merely because a task could benefit from a background terminal, delegation, or parallel work."
---

# Herdr

Carry out the requested terminal work or window change without disturbing unrelated work. Herdr Core owns persistent terminals and agent coordination; Herdr App displays spaces, tabs, and panes. A terminal can run without appearing in the window, and closing the window does not end its terminals.

Done when the requested result has been inspected, any requested layout change is confirmed in the app, and helpers you started are cleaned up once their results are accepted. Report blockers and still-running work instead of inferring completion from a successful launch or wait.

## Load the installed manual

Read the relevant embedded manual before acting. These are the authority for the installed CLI, not the older `herdr` terminal multiplexer:

| Job                                                                                          | Read first           |
| -------------------------------------------------------------------------------------------- | -------------------- |
| Start, inspect, message, wait on, or clean up agents and programs; remote commands and files | `herdr-core --skill` |
| Inspect or change the visible window, spaces, tabs, panes, settings, layouts, or mods        | `herdr-app --skill`  |

Read both when the request crosses that boundary. `hc` is the short name for `herdr-core`. Use command-specific `--help` for exact core arguments and `herdr-app commands` for app commands and their argument shapes. Do not launch bare `herdr-app` for discovery; it opens or raises the window.

## Target the right work

- `$HC_TERMINAL_ID` identifies the calling terminal, not a pane. Use returned terminal addresses for core operations and IDs from `herdr-app ls` for app operations. Inspect `herdr-app status` before changing layout or focus.
- Do not require the old `HERDR_ENV=1` flag. If caller context is absent, establish the intended target explicitly before controlling existing work; never substitute the person's focused pane for the caller.
- Keep remote addresses machine-qualified, such as `vps/t7`. Use core's `--on` selector for remote launches, commands, and file operations. Your harness's file tools still operate locally. A remote space selected in the app does not retarget CLI commands.
- Read IDs and state from responses rather than predicting them. After ambiguous delivery or a connection failure, inspect the target before retrying a mutation.

## Coordinate without changing the window

Use core for background orchestration. Read its manual's delegation, delivery, wait, and recovery sections before starting helpers.

- Check `hc templates` for a fitting role. Launch agents interactively with `--bg`, a useful name, an explicit cwd, and a bounded scope. Include the initial task in the launch, prohibit further delegation unless assigned, and request a report when done or stuck. Ask for substantial results in a file and read it before summarizing.
- Launch Codex with `--no-daemon`, including through templates, so its commands execute inside core.
- Check `first_message.sent` after a launch with a task. If delivery failed, inspect readiness before sending. A timeout or failed send is not proof of non-delivery.
- Use bounded `hc wait` calls rather than sleep loops or polling. A message, timeout, or settled status is a reason to inspect progress, not proof of success. Collect output or the actual result afterward. Report what was last observed when the time budget expires.
- On `blocked`, read the screen and ask the user about the permission or question. Never use forced delivery or key input to bypass an approval.
- Helpers are children of the launching terminal and normally end with it. Use `--outlive-parent` only when the requested lifetime requires it. Keep returned addresses for commands that time out but remain running; do not start duplicates.
- Keep background workers hidden. Adding `herdr.space` or `herdr.tab` labels changes what the person sees; use app commands when a visible tab or split is requested.

## Change the visible app only as requested

Use `herdr-app ls`, `herdr-app status`, and `herdr-app commands` to inspect the running window and choose explicit targets. Create spaces or tabs only when asked, with useful explicit names. Preserve the person's focus unless the requested change includes switching it. Confirm the returned IDs and resulting layout rather than treating terminal creation as proof its program started.

For settings, layouts, keys, or mods, first read the installed `AGENTS.md` under `$HERDR_APP_HOME` (default `~/.config/herdr-app`) and the relevant generated API declarations. Keep generated files untouched and clone shipped mods or layouts before editing. After a mod change, require a passing `herdr-app check`, inspect `status` for reload errors, and inspect a `herdr-app shot` capture before claiming visual correctness.

## Ownership and recovery

Clean up only terminals you started, after collecting their results; core's terminal list also includes the user's work. Ask before closing or terminating anything else, configuring machines, or changing unrelated settings. Never stop, restart, or update the user's app or core merely to recover from an error. Tests and experiments need an isolated core session and scratch state, not the person's real display or session.
