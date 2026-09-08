# Theme and available markup

## Contents

- The two-layer token system
- Accent jobs
- Classes available in beat bodies
- Classes available in intro/outro bands
- Contrast rules and the two measured decisions
- Changing the theme

## The two-layer token system

`assets/template.html` follows the Catppuccin semantic-token discipline.

**Layer 1** — the palette adapter on `<html data-catppuccin-flavor="mocha">` holds
canonical Mocha values as `--ctp-*` and is the only place a flavor value appears.

**Layer 2** — `:root` maps those to product semantics (`--ui-*`, `--syn-*`).
Everything in the stylesheet consumes layer 2 only. No component contains a hex
value.

Neutrals carry structure using adjacent steps of the ramp, never a jump:

| Token                 | Mocha label | Role                                  |
| --------------------- | ----------- | ------------------------------------- |
| `--ui-canvas`         | `base`      | Page background                       |
| `--ui-canvas-sunken`  | `mantle`    | Panels, cards, the pane title bar     |
| `--ui-canvas-deep`    | `crust`     | The code pane itself, table headers   |
| `--ui-panel`          | `surface0`  | Inline code background, quiet borders |
| `--ui-border`         | `surface1`  | Ordinary borders                      |
| `--ui-border-strong`  | `overlay0`  | Emphasised dividers                   |
| `--ui-text`           | `text`      | Body text                             |
| `--ui-text-secondary` | `subtext1`  | Beat prose                            |
| `--ui-text-muted`     | `subtext0`  | Notes, table cells                    |
| `--ui-text-faint`     | `overlay2`  | Chips, footers, labels                |

## Accent jobs

Each accent has one job and keeps it. The important rule:

> **Mauve is reserved for UI state** — links, active nav, the spotlight rail, the
> line-range chip — and never appears inside the code pane. That is what lets the
> spotlight read unambiguously as "you are here" against coloured syntax. A test
> asserts no syntax token is mauve.

| Token               | Label    | Job                                     |
| ------------------- | -------- | --------------------------------------- |
| `--ui-action`       | mauve    | Links, active state, spotlight          |
| `--ui-focus`        | lavender | Focus rings, hover preview, inline code |
| `--ui-info`         | sapphire | Decision records, references            |
| `--ui-success`      | green    | Measurements, verified claims           |
| `--ui-caution`      | peach    | Deviations from spec or convention      |
| `--ui-danger`       | maroon   | Traps, defects, hazards                 |
| `--ui-quiet-accent` | teal     | Structural properties, directives       |

Syntax is a separate vocabulary: keywords pink, types yellow, functions blue,
strings green, numbers peach, identifiers teal, comments overlay2, punctuation
overlay1.

## In beat bodies

| Markup                                         | Renders as                               |
| ---------------------------------------------- | ---------------------------------------- |
| `<p>` `<ul>` `<ol>` `<strong>` `<em>` `<code>` | Styled prose                             |
| `<div class="note">`                           | Neutral aside with a left rule           |
| `<div class="note trap">` / `danger`           | Red rule — what breaks if edited naively |
| `<div class="note caution">` / `dev`           | Peach rule — a deviation                 |
| `<div class="note good">` / `perf`             | Green rule — a measurement or proof      |
| `<div class="note info">`                      | Blue rule — points at a decision record  |

Inside a note, `<b>` renders in the note's accent colour — use it for the lead-in
(`<b>Trap:</b> …`).

Tag classes, used as `[class, label]` in `tags`:

`info` · `caution` · `danger` (alias `trap`) · `accent` (alias `authz`) ·
`good` (alias `perf`) · `quiet` (alias `audit`)

## In intro/outro bands

```html
<!-- numbered concept grid -->
<div class="ideas">
  <div class="idea">
    <span class="num">01</span>
    <h4>Heading</h4>
    <p>Body.</p>
  </div>
</div>

<!-- table -->
<div class="tblwrap">
  <table>
    <thead>
      <tr>
        <th>Change</th>
        <th>Verdict</th>
        <th>Why</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>…</td>
        <td class="verdict good">kept</td>
        <td>…</td>
      </tr>
    </tbody>
  </table>
</div>

<!-- side-by-side cards -->
<div class="pair">
  <div>
    <h4>Heading</h4>
    <p>Body.</p>
  </div>
  <div>
    <h4>Heading</h4>
    <p>Body.</p>
  </div>
</div>
```

`.verdict` takes `good` · `warn` · `info` · `bad` (aliases `kept` · `rev` ·
`add` · `fix`).

## Contrast

`scripts/build.test.ts` asserts 23 foreground/background pairs against WCAG AA
(4.5:1 for text, 3:1 for the focus ring) by parsing the template, so editing a
token cannot silently drop a pair below target. Run `bun test` after any theme
change.

Two values were set by measurement rather than taste, and reverting them
reintroduces a real failure:

- **`--ui-text-faint` is `overlay2`, not `overlay1`.** `overlay1` on `base` is
  4.44:1 — just under AA.
- **Line numbers are `overlay1`, not `overlay0`.** `overlay0` on `crust` is
  3.84:1, fine for a graphic but not for text.

Catppuccin targets a comfortable middle contrast, not automatic compliance. Treat
any new pair as needing measurement.

State is never signalled by colour alone: the spotlit block gains a background,
a left rail, and recoloured line numbers together; folds carry `aria-expanded`;
`prefers-reduced-motion` disables the smooth scroll, dimming, and transitions.

## The two block states

Both columns light as one object, so a beat and its code read as linked.

| State             | Colour                  | Trigger                                                       |
| ----------------- | ----------------------- | ------------------------------------------------------------- |
| **Active**        | mauve (`--ui-action`)   | Scrolling — this is the beat you are reading                  |
| **Hover preview** | lavender (`--ui-focus`) | Pointing at any line in a beat's range, or at the beat itself |

Hovering either side lights both: the beat's full line range in the pane, and
the beat's rail and range chip in the narrative. It previews the click target
before you commit to it, and makes it obvious which lines a beat owns.

Two rules hold this together, both asserted by tests:

- **`.row.hov` is declared before `.row.on`.** They have identical specificity,
  so source order decides a row that is both hovered and active — and active
  must win, or scrolling loses its "you are here" marker under the pointer.
- **Hover never uses mauve.** If it did, pointing at a block would be
  indistinguishable from having scrolled to it.

Hover is gated behind `@media (hover: hover)` in JS, because on touch devices
`mouseover` fires on tap and would leave the highlight stuck on. The beat rail is
an absolutely positioned `::before`, so lighting it never reflows the prose.

Dimmed context sits at 34% opacity and lifts to 82% on hover, so the surrounding
code stays readable on demand rather than being locked out.

## Changing the theme

To move to another Catppuccin flavor, replace the whole `--ctp-*` block with that
flavor's canonical values and change `data-catppuccin-flavor`. Do not swap
individual colours, and re-run `bun test` — a pair that clears AA in Mocha can
fail in Latte.
