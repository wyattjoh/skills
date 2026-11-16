# Runtime model

What gpui-shell and Herdr do underneath a mod, and the rule each fact implies. Source: `docs/gpui-shell.md` (§8–12) in `longbridge/gpui-kit`, and the Mods section of Herdr's `AGENTS.md`.

Contents: [Elements](#elements-are-consumed-values) · [Phases](#phases) · [Callbacks](#callbacks) · [State](#state-has-no-automatic-tracking) · [Tasks and timers](#tasks-and-timers) · [Copies and module scope](#copies-and-module-scope) · [Lifecycle](#lifecycle)

## Elements are consumed values

An element is used exactly once: `.child(el)` and `render` consume it. Build a fresh element each time it is placed; an element stored in a field, reused across two parents, or built once for two branches renders once or throws. Store data and rebuild, as a Rust `RenderOnce` would.

## Phases

| Phase                                  | Allowed                                                                  | Refused                                    |
| -------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------ |
| Render (`render(cx)`)                  | read state, `theme()`, Herdr data; build elements; register callbacks    | `cx.notify()`, overlays, creating entities |
| Event (`on_click`, `on_mouse_down`, …) | everything: mutate, `notify`, `spawn`, `openOverlay`, `setShared`, `run` | blocking                                   |
| Task (`cx.spawn`, `cx.timer`)          | same as Event                                                            | blocking                                   |

Herdr re-renders a copy whenever its live data changes (spaces, agents, terminals, focus, theme, `shared()`), so read those in `render` instead of polling or caching them. A sync that must react to that data (restoring a panel, publishing an order) compares against the last value it acted on and issues commands only on change; an unconditional `run` or `setShared` from `render` is a redraw loop.

## Callbacks

- Handlers are arrow functions so `this` stays the View; a `function () {}` handler gets the wrong `this`.
- **A `cx` belongs to one call.** Use the one each callback receives; never keep one in a field or closure for later. Keep typed handles instead: `ScrollHandle`, a focus handle, a `Task`, a domain ID.
- A handler belongs to the render that registered it; late events against an old frame are dropped. Read current state inside the handler instead of trusting values captured several renders ago when correctness depends on them (a fold toggle flips the stored state, not the render's copy).
- Stop propagation only where a nested control must keep its parent from acting: a button inside a `window_drag` bar or a clickable row. Blanket stops break drag, menus and window commands.

## State has no automatic tracking

There are no signals, hooks or dependency arrays. Change state, then call `cx.notify()` once after the coherent change. The three layers:

| Layer           | Lives in                                                           | Use for                                          |
| --------------- | ------------------------------------------------------------------ | ------------------------------------------------ |
| View-local      | fields on the View or a state class it owns                        | folds, hover, drafts, drag, pending restores     |
| Copy-persistent | `localStorage` (per copy)                                          | what this copy should remember across restarts   |
| Shared          | `shared(key)` / `setShared` (persisted JSON, every mod re-renders) | settings and contracts other copies or mods read |

Plus two Herdr-owned sources: live data (`spaces()`, `panes()`, `agents()`, `layout()`, `focused()`) and terminal labels (`hc label`, visible to every client). Controlled values follow GPUI: pass the current value in, receive a requested change, update the owner, render again; a callback reports intent and never becomes a second source of truth.

## Tasks and timers

- Start async work from `init`, an event or a named method, as `cx.spawn(async (cx) => …)`; never from `render`.
- Timers are `cx.timer.after` / `cx.timer.every`; `setTimeout` and `setInterval` do not exist. Each task is owned by the View that started it and stops resuming when that View goes. `{ owner: null }` is the deliberate opt-out for work that must outlive a popup (a move that continues after dismissal); say why at the call site.
- Model async results as explicit states (idle, loading, loaded, failed), keep previous data while refreshing, and drop a result whose request identity no longer matches current state.
- Cancellation stops resuming the continuation; a started `exec` keeps running.
- Animate with native `.transition()`, `.loop()`, `.frames()` and `svg().spin()`; a timer that only calls `notify` redraws the whole window. Timers are for data, as often as the data changes.

## Copies and module scope

- Every block, pane or overlay naming the mod runs its own copy (instance, tasks, `localStorage`). Module scope runs once per source version and is shared by all copies, even after they close: keep it to constants and pure functions.
- Classify a copy's role from `props()` once in `init` (titlebar, list, popup, …) and render only that role's delegate, so auxiliary copies never build list state or start list tasks.
- `<mod>.<command>` reaches shown copies only; `shared()` reaches everyone; prefer `shared()` for state and commands for one-shot intents.

## Lifecycle

- `init(props, cx)` runs once; create handles (`ScrollHandle.new()`, focus handles) and start owned tasks there. Guard side effects that must not run under `herdr-app check` with `checking()`.
- `close(cx)` gets one bounded call (250 ms, shared across copies on quit) when the block, pane or overlay goes; start cleanup there. Hot reload cancels tasks and timers without calling the old copy's `close`, so correctness never depends on finalizers.
- A failed save keeps the old build running and reports in `herdr-app status`; a working screen is not proof the edit loaded.
