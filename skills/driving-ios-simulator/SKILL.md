---
name: driving-ios-simulator
description: Use when an agent needs to drive a booted iOS Simulator programmatically - tap, scroll/swipe, type text, press hardware buttons, read on-screen elements, or screenshot - especially for SwiftUI apps. Also use when simulator taps silently do nothing or fail with "SimulatorKit is required for HID interactions".
---

# Driving the iOS Simulator

## Overview

Drive a booted iOS Simulator from the shell to exercise a real app's UI. Two tools
do everything:

- **`xcrun simctl`** — boot/launch/terminate apps, screenshot, open deep links. Ships with Xcode. Reliable. **Has no tap/swipe** of its own.
- **`idb`** (Facebook iOS Development Bridge) — the actual UI driver: read the accessibility tree and perform `tap`, `swipe`, `text`, `button`, `key`. Needs a running **`idb_companion`** per simulator.

**Core workflow:** read the screen with `describe-ui.ts` → get an element's `(centerX, centerY)` in points → `idb ui tap centerX centerY`. Never guess coordinates from a screenshot; query the tree.

`$SKILL_DIR` below resolves to `~/.claude/skills/driving-ios-simulator/`.

## ⚠️ Do this FIRST, every session

The single most common failure: actions silently no-op or error with
`SimulatorKit is required for HID interactions ... SimulatorKit.framework ... does not exist`.
Cause: the **active Xcode is a beta that ships without `SimulatorKit.framework`**, but
`idb_companion` needs it for HID (tap/swipe/text). Accessibility _queries_ still work,
so you can read the screen yet every tap does nothing — sneaky.

**Always bootstrap the companion before interacting:**

```bash
bun $SKILL_DIR/scripts/idb-bootstrap.ts
```

It kills stale companions, finds an Xcode that _has_ `SimulatorKit.framework` (falls
back to `/Applications/Xcode.app` when the active one is a beta), respawns the
companion with the right `DEVELOPER_DIR`, and connects. Re-run it any time taps stop
landing or after rebooting the simulator.

## Quick Reference

`UDID` = booted device id (`xcrun simctl list devices booted`). All `idb` coords are
**points**, not pixels — the PNG screenshot is 2×–3× larger than the point grid
(device dependent). `describe-ui.ts` reports point coordinates directly, so prefer it
over measuring a screenshot.

| Goal                        | Command                                                                           |
| --------------------------- | --------------------------------------------------------------------------------- |
| List booted sims            | `xcrun simctl list devices booted`                                                |
| Launch app                  | `xcrun simctl launch booted <bundleid>`                                           |
| Relaunch clean              | `xcrun simctl terminate booted <bundleid>; xcrun simctl launch booted <bundleid>` |
| Open deep link              | `xcrun simctl openurl booted "<scheme>://<path>"`                                 |
| Screenshot                  | `xcrun simctl io booted screenshot /tmp/shot.png`                                 |
| **List tappable elements**  | `bun $SKILL_DIR/scripts/describe-ui.ts`                                           |
| Raw accessibility tree      | `idb ui describe-all --udid <UDID>`                                               |
| Element under a point       | `idb ui describe-point --udid <UDID> X Y`                                         |
| **Tap**                     | `idb ui tap --udid <UDID> X Y`                                                    |
| Scroll up (swipe finger up) | `idb ui swipe --udid <UDID> 220 800 220 300`                                      |
| Scroll down                 | `idb ui swipe --udid <UDID> 220 300 220 800`                                      |
| Type into focused field     | `idb ui text --udid <UDID> "Hello"`                                               |
| Hardware button             | `idb ui button --udid <UDID> HOME` (also `LOCK`, `SIRI`, `APPLE_PAY`)             |
| Keycode press               | `idb ui key --udid <UDID> 40` (40 = Return)                                       |

## The find-then-tap loop

```bash
UDID=$(xcrun simctl list devices booted | grep -Eo '[0-9A-Fa-f-]{36}' | head -1)

bun $SKILL_DIR/scripts/idb-bootstrap.ts   # 1. ensure companion is healthy
bun $SKILL_DIR/scripts/describe-ui.ts     # 2. read the screen -> labels + center coords
# ( 43, 385) [Button] 'All'
# (220, 454) [Button] 'Row label, subtitle, 5'
idb ui tap --udid $UDID 220 454           # 3. tap the element's center
bun $SKILL_DIR/scripts/describe-ui.ts     # 4. confirm the UI changed
```

A successful `idb ui tap`/`swipe`/`text` prints **nothing** and returns exit 0 — silence
means success, not failure. Always confirm by re-running `describe-ui.ts` and checking
the UI actually changed (step 4 above).

`describe-ui.ts` prints `(centerX,centerY) [Type] 'label' = value`. Elements with
`y` outside `0..screenHeight` are marked `(offscreen - scroll to reach)`: swipe to
bring them on-screen, then re-describe to get fresh on-screen coordinates before tapping.
Screen height is detected automatically from the root window, so the script works on
any simulator size.

## Scrolling

`idb ui swipe X1 Y1 X2 Y2` drags a finger from start to end. To scroll the list
**up** (reveal lower items), drag the finger **upward** (`220 800 → 220 300`). Add
`--duration 0.3` for a slower, more controlled drag; a fast short swipe flings/momentum-scrolls.
After any scroll, re-run `describe-ui.ts` — coordinates of on-screen elements change.

## Typing text

`idb ui text "..."` types into **whatever field is currently focused**. It does not
focus a field for you. Tap the text field first, confirm it is focused (keyboard up /
caret), then type. If text seems to vanish, the field wasn't focused — tap it and retry.
For special keys use `idb ui key <keycode>` (e.g. 42 = Backspace, 40 = Return).

## App-specific tips

These apply to most apps and are worth checking for the one you're driving:

- **Prefer deep links over tapping** to jump straight to a destination:
  `xcrun simctl openurl booted "<scheme>://<path>"` is faster and less brittle than
  navigating the UI. Check the app's URL scheme and whether the link identity is an
  internal id (e.g. a UUID) rather than the short code shown in the UI.
- **Read rich accessibility labels** instead of screenshotting — rows often expose
  composite labels like `'CODE, name, count'` you can assert against directly.
- **Hidden controls**: some actions (e.g. search) live behind an icon button rather
  than a visible field. Tap the button to reveal/focus the field before `idb ui text`.

## Common mistakes

| Symptom                                            | Cause / fix                                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Tap errors `SimulatorKit ... does not exist`       | Active Xcode is a beta without SimulatorKit. Run `idb-bootstrap.ts`.                              |
| `describe-all` works but taps do nothing           | Same as above — queries don't need SimulatorKit, HID does. Bootstrap.                             |
| `Failed to describe CompanionInfo ... removing it` | Stale `/tmp/idb/*.sock`. `idb-bootstrap.ts` clears them.                                          |
| Tap lands in the wrong place                       | Used screenshot **pixels**. idb uses **points** (≈ pixels ÷ scale). Use `describe-ui.ts` centers. |
| `idb ui tap: invalid int value: '43 385'`          | x and y are **separate args**: `tap 43 385`, not `tap "43 385"`.                                  |
| Typed text vanished                                | No field focused. Tap the field first, then `idb ui text`.                                        |
| Element listed but tap misses                      | It's `(offscreen)`. Swipe to reveal, then re-describe for current coords.                         |

## Setup notes (one-time)

- Install the tooling: `brew tap facebook/fb && brew install idb-companion` (not in
  homebrew-core, the tap is required) and `pip3 install fb-idb` (requires Python 3.11+).
  This puts `idb` on your PATH (commonly `~/.local/bin/idb`) and `idb_companion` in
  Homebrew's bin. The scripts prepend `~/.local/bin` to `PATH` so `idb` resolves
  regardless of shell.
- A booted simulator and an installed build of the target app must already exist. To
  build/install, use the project's Xcode build commands, then
  `xcrun simctl install booted <path>/YourApp.app`.
