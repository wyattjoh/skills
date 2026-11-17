# Structure

How the Coding Guides' architecture, unit choice, identity, naming and testing rules land in a TypeScript project that bundles one or more mods, each to its own `main.js`.

Contents: [Project layout](#project-layout) · [Layers](#layers) · [Choosing the unit](#choosing-the-unit) · [Identity](#identity) · [Checked inputs](#checked-inputs) · [Extension points](#extension-points) · [Naming](#naming) · [Testing](#testing)

## Project layout

One repository can ship several mod folders (a panel, its toggle, a menu). Give each deployed mod its own source folder whose `index.ts` is the bundle entry, and share code between them only through tiers that no mod owns:

```
<project>/
├── <piece>.mod.json        # one manifest per deployed folder, copied by the build
├── src/
│   ├── mods/<piece>/       # one folder per deployed mod
│   │   ├── index.ts        # bundle entry and composition root
│   │   └── *.ts, *.test.ts # that mod's regions, state classes and models, by capability
│   ├── components/         # shared controls used by more than one mod
│   ├── lib/                # shared pure models and host adapters, no gpui-kit runtime import
│   ├── theme/              # shared theme derivations
│   └── test/               # renderer harness and cross-mod suites
├── scripts/                # build, typecheck and check scripts
└── tests/                  # tests for scripts/ only
```

- Code starts in its mod's folder and moves to `components/`, `lib/` or `theme/` when a second mod imports it. A one-mod project uses the same shape with one `mods/<piece>/` folder, so a second mod lands without moving files.
- Deployed folder names (`<project>-<piece>`) live in one inventory that the build, the checks and any code finding its own layout block all read.
- Code that runs outside Herdr (a compiled helper, a CLI the mod spawns) gets its own source root beside `src/`. Mods reach it only through its command line or wire protocol, never by importing its modules.
- Tests sit beside their module as `<module>.test.ts`. The test script preloads `src/test/`'s harness so every suite sees the same `gpui-kit`/`gpui-base`/`herdr` mocks regardless of run order. Bundles reach only what the entries import, so tests never ship.
- The build stages every folder (bundle, manifest, assets) into an ignored output tree, and the check runs `herdr-app check` on each with that tree as `HERDR_APP_HOME`. One `check` command runs format, lint, tests, typecheck and build; installing into the live app is a separate command.

## Layers

Dependencies point downward. Inside a mod's folder, organize by capability (the toolbar, the tab strip, panel memory), not by role folders (`views/`, `models/`); the shared tiers above are the only cross-mod folders.

| Layer                         | Holds                                                                                                                                                 | Imports                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Composition root (`index.ts`) | the exported `View`: classifies the copy, owns state instances and handles, composes regions                                                          | everything below                                |
| Region modules                | element functions for one capability, their small state classes                                                                                       | controls, models, adapters, `gpui-kit`, `herdr` |
| Shared controls               | the few repeated shapes (a chip, an icon button, a fold card) with their states                                                                       | `gpui-kit`, theme type                          |
| Host adapters                 | the seam around `exec`, `fetch`, timers and other host calls: a service or function that takes the host function as a parameter, so tests pass a fake | `herdr` types only, models                      |
| Pure models                   | parsing, ordering, item unions, layout-tree reads, protocol helpers                                                                                   | nothing from `gpui-kit` or `herdr`              |

`render` reads like the screen: `.child(tabStrip(...)).child(newTabButton(...)).children(toolbar(...))`. Move domain operations and non-trivial mutation into named methods or model functions. Extract a helper when it names a region and shrinks what a reader must hold; extract a control only when it has its own contract (several callers, shared states), not because a chain is long.

## Choosing the unit

| Need                                                                           | Unit                                                                                         | Rust analogue                   |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------- |
| All inputs come from the caller; nothing survives the frame                    | function `(opts) => Element` taking one options object                                       | `RenderOnce` component          |
| Behavior spans frames (drag, pending restore, retry cooldown, motion tracking) | small class owned by the View, constructed in a field or `init`, with methods the root calls | `Entity<State>` owned by a view |
| A retained child view with its own lifecycle                                   | a nested `View` / state entity passed to `.child(handle)`                                    | `Entity<V>` child               |
| Built-in behavior (input, editor, button, lists)                               | `gpui-base` / `gpui-kit` components, styled from `theme()`                                   | the component crate             |

Prefer the platform component over a hand-built `div` whenever one exists (`Button`, `Checkbox`, `Input`, virtual lists): it keeps focus, keyboard and disabled behavior. `gpui-base` controls are unstyled; style them, do not rebuild them.

## Identity

- IDs come from domain IDs and are namespaced by region: `tab-${tab.id}`, `panel-${item.id}`, `close-${tab.id}`.
- Two regions that can show the same entity use different prefixes (`shortcut-` vs canonical rows) so hover, motion and transition state cannot collide.
- An ID that encodes configuration (a resizable split keyed by its panes and folds) resets deliberately when that configuration changes; document it where the ID is built.
- Persisted keys (fold IDs, `localStorage` keys, `shared()` keys) are API: rename them only with a migration or fallback.

## Checked inputs

`props()` is user JSON from the layout; `shared()`, `localStorage` and labels can be written by other mods, older versions or Herdr. Read each through a checked reader that returns a typed value or a fallback, so one malformed entry degrades a single control instead of throwing in `render`. Keep readers and key constants in one module per contract, and type the result (`ToolbarItem[]`, `Record<string, string>`), not the raw value.

## Extension points

A mod owns its rectangle; other code reaches inside it only through seams the mod declares.

- **Props as slots.** Read a typed list from `props()` (e.g. `toolbar: ToolbarItem[]`) and render it through one switch over item kinds. A layout entry, not a source patch, adds the button. Built-ins and layout items share one union and one renderer.
- **Shared registries.** For contributions from other mods, each contributor files entries under its own name in one `shared()` key; the owner validates and renders them. Data only: functions and elements cannot cross mods.
- **Build-time fills.** Inside one bundle, a typed slot (key plus context type) can accept render functions that return any element; enabled fills are imported by a single list module.
- Name a contract once (the key constant, the item type, the stack child ID it targets) and document which layout node or key it binds to.

## Naming

| Concept                       | Pattern                                 | Example                                         |
| ----------------------------- | --------------------------------------- | ----------------------------------------------- |
| Element function for a region | noun phrase                             | `tabStrip`, `toolbar`, `windowControls`         |
| Shared control                | noun                                    | `chip`, `iconButton`, `foldCard`                |
| Copy-owned state class        | `<Thing>` or `<Thing>State` / `Tracker` | `PanelMemory`, `TabDrag`, `RowMotionTracker`    |
| Checked reader                | the value's noun                        | `resolveToolbar`, `spaceGroups`, `stringRecord` |
| Boolean                       | `is`/`has`                              | `isShowing`, `hasSelection`                     |
| Event handler / method        | intent                                  | `toggleFold`, `showPanel`, `openRowMenu`        |
| Constants                     | upper snake with unit or role           | `AGENT_ROW`, `RESTORE_GRACE_MS`, `PANEL_STACK`  |

Use one word per concept across the mod (panel vs dock vs drawer), matching Herdr's and GPUI's established terms.

## Testing

Test at the lowest layer that proves the behavior (placement is in [Project layout](#project-layout)):

1. Pure models with the project's test runner (`bun test`): parsing, ordering, protocol decisions, malformed input.
2. Views through the project's renderer harness when it has one (a fake `herdr` host recording `run`/`setShared` effects), asserting element IDs, geometry and effects.
3. `herdr-app check <mod dir>`: loads, renders once, exits nonzero with the error.
4. The running app: `herdr-app status` for reload errors, `herdr-app shot` for the visible result.

Add the failing test before fixing a reproducible bug.
