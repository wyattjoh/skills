---
name: herdr-gpui-kit
description: Applies GPUI Kit's official Coding and Design Guides, translated to Herdr mods written in TypeScript or JavaScript on the gpui-shell runtime. Use when writing, structuring, refactoring, or reviewing a Herdr mod's `main.js`/`src/*.ts` (View classes, gpui-kit builder chains, `herdr` module calls), when splitting a large mod into modules, or when designing a mod's extension points such as props-driven slots.
---

# Herdr mods to GPUI Kit standards

GPUI Kit's guides are written for Rust apps. A Herdr mod runs the same GPUI through gpui-shell's JavaScript bridge, inside Herdr's copy-per-block host. This skill carries the guides' intent across that gap so mod code has explicit owners, stable identity, theme-driven looks and testable seams.

**Goal:** the mod's code reads as a GPUI Kit application would: each piece of state has one named owner, `render` only describes, side effects start from events and owned tasks, visuals come from `theme()` and named constants, and pure logic sits in modules a plain test runner can import.

## Ground truth first

The installed files outrank this skill and any recalled GPUI, React or web pattern:

- Herdr's mod manual: `~/.config/herdr-app/AGENTS.md` (or `$HERDR_APP_HOME/AGENTS.md`). Load it through `herdr-app --skill` and read the Mods section before editing.
- API truth: `gpui-kit.d.ts` (in the app home and each mod folder) and `herdr.d.ts`. Herdr regenerates both on every start for the running gpui-shell version; search them for a method's signature instead of inferring it by analogy.
- Upstream intent, when a rule here needs its reasoning: the Coding Guides (https://gpui-kit.com/docs/coding-guides.md), the Design Guides (https://gpui-kit.com/docs/design-guides.md) and the runtime architecture (`docs/gpui-shell.md` in `longbridge/gpui-kit`). If the `gpui-kit` or `gpui-kit-design-guides` skills are installed, call the Skill tool with that name instead of fetching.

## Completion criteria

A change is done when you can name, for every region you touched:

1. **Owner.** Each value lives in exactly one place: a View field, a copy-owned state class, `localStorage`, a `shared()` key, a terminal label, or Herdr's live data. Nothing caches Herdr data that `render` can read directly.
2. **Phase.** `render` reads and builds only. Mutation, `cx.notify()`, `openOverlay`, `setShared`, `run` and `exec` happen in callbacks, `cx.spawn` tasks or `cx.timer` callbacks, each using the `cx` it was handed.
3. **Identity.** Every interactive or repeated element has an `.id()` derived from a domain ID (terminal address, space ID, tab ID, item ID), namespaced by its region; none comes from an index of a reorderable list or a label.
4. **Look.** Colors are `theme()` names; sizes, gaps, radii and durations are named constants; any literal color has a comment saying why no theme role fits.
5. **Seams.** Parsing, ordering, layout-tree reads and `shared()`/`props()` validation live in pure modules with no `gpui-kit` or `herdr` import, and each has a test. Values from `props()`, `shared()`, `localStorage` and labels are checked, never cast.
6. **Proof.** The project's typecheck and tests pass and `herdr-app check <mod dir>` passes (in an isolated `HERDR_APP_HOME` when the project stages builds). For a visible change, a screenshot of the running app (`herdr-app shot`) confirms it, reported separately from the automated checks.

## Boundaries

- Edit the project's sources and build output only. Herdr's shipped mods and layouts are read-only: work on a `mod.clone` / `layout.clone` copy, and leave the generated `.d.ts`, `jsconfig.json` and `AGENTS.md` untouched.
- Install into the live app or switch its layout only after the user confirms; a check passing in isolation is the default stopping point.
- Follow the project's existing structure, naming and test harness where it already answers a question; this skill fills gaps, it does not override a project's `AGENTS.md` or rules.

## Pointers

- Writing or reviewing behavior (phases, callbacks, state, tasks, timers, copies, cleanup): [runtime model](references/runtime.md).
- Splitting a mod into modules, choosing between an element function, a state class and a nested View, IDs, naming, extension points and tests: [structure](references/structure.md).
- Anything visible (colors, spacing, states, popups, motion, copy): [design](references/design.md).
