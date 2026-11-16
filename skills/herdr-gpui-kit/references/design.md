# Design

The Design Guides' rules as they apply inside a Herdr window. Herdr draws the chrome around a mod; the mod should look like it belongs there in every theme.

Contents: [Theme](#theme) · [Geometry](#geometry) · [States](#states) · [Overlays](#overlays) · [Motion](#motion) · [Copy](#copy) · [Review](#review)

## Theme

- Colors come from `theme()` by role: `chrome` (sidebars, bars), `surface`, `canvas`, `popover`, `raised`, `hover`, `selected`, `border`, `input`, `foreground`, `muted`, `dim`, `accent`/`accent_foreground`, `solid`/`solid_foreground` (primary), `selection`, and agent status `working`, `blocked`, `done`, `idle`, `unknown`. `herdr.d.ts` lists the current set.
- Status colors mean status only. Do not encode meaning by color alone: pair it with an icon, label or position.
- A literal color is a review finding unless it is data (a user-picked group color) or a documented derivation (a theme color with an alpha suffix for a muted variant). Verify custom surfaces in a light and a dark theme.

## Geometry

- Herdr's manual and shipped mods use numeric pixel builders (`.h(26)`, `.gap(5)`). Keep each value a named constant shared by every region that must align, and let tests pin them. The rem helpers (`p_2()`, `text_sm()`) exist in the style surface; mix them in only after checking how they track Herdr's zoom.
- Use a small spacing scale (about 2, 4, 8, 12, 16, 24) and a few radius tiers; nested rounded surfaces read as concentric (inner ≈ outer − gap).
- Prefer construction over correction: siblings share the same inset constant instead of nudging one by a pixel.
- `h_flex` centers children on the cross axis; a row of full-height columns needs `items_stretch()` or `h_full()`. Each scroll region has one owner, and the flexible child that may shrink gets `min_w(0)`/`min_h(0)`. Virtual lists need a definite height.

## States

Design every control for rest, hover, pressed, open (while its popup is up), focus, selected, disabled, loading and error. Selection is shown by the item's own fill or weight, distinct from hover, and survives hover; no leading-edge bars. Hover is modest and never the only way to reach an essential or destructive action; offer the same command in a context menu or keyboard path. Name each action by its real result and scope.

## Overlays

Choose the smallest surface: tooltip for a missing meaning or shortcut, popup menu for actions, dialog for a decision, `notify()` for asynchronous status. Size popups from the same constants as their rows (title, row, divider counts plus frame slack); a height is a maximum that must never fall short. A popup copy closes itself with `closeOverlay(props().overlay)` and acts on the target in its props, never on whatever is focused.

## Motion

Motion explains a change (reorder, expand, attention), runs natively, and reverses from its current value when interrupted. Keep stable identities on animated wrappers, and retire motion when the region changes mode (a rail, a hidden pane).

## Copy

Labels name the action and object ("Move to…", "Copy Path"); context carries context, so a section header does not repeat in every row. Confirm only consequential, irreversible actions, naming the object and consequence; prefer reversible actions and toasts elsewhere.

## Review

Before calling a visible change done: the primary task is obvious; every control keeps its promise; strong color and emphasis stay scarce; peers share alignment and equal gaps render equal; it works in light and dark themes, narrow (rail) and wide widths, empty and failure states; and a screenshot from the running app shows it.
