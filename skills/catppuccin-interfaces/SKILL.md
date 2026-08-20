---
name: catppuccin-interfaces
description: Applies Catppuccin colors to interfaces with semantic tokens, hierarchy, states, and contrast checks. Triggers on "Catppuccin UI", "Catppuccin theme", "use Catppuccin colors", or mentions Latte, Frappe, Macchiato, or Mocha.
user-invocable: false
---

# Catppuccin Interfaces

Use Catppuccin as a semantic color system, not as a bag of hex values. Preserve the palette's calm, pastel character while making hierarchy, state, and accessibility explicit.

## Workflow

1. Inspect the project's existing theme, token, and color-scheme conventions.
2. Choose the supported flavor or light/dark flavor pair.
3. Source exact palette values from the project's Catppuccin package or canonical palette data.
4. Map Catppuccin labels to semantic interface tokens in one theme adapter.
5. Make components consume semantic tokens only.
6. Verify contrast, focus, interaction states, and every supported flavor.

The work is complete when palette values are centralized, components contain no stray Catppuccin hex values, states remain distinguishable without color alone, and supported flavors pass the project's visual and accessibility checks.

## Choose Flavors Deliberately

| Flavor    | Use                                                |
| --------- | -------------------------------------------------- |
| Latte     | Light interfaces and light system appearance       |
| Frappé    | Soft, muted dark interfaces                        |
| Macchiato | Balanced dark interfaces with moderate depth       |
| Mocha     | Deepest dark interfaces and low-light environments |

For automatic light and dark themes, pair Latte with one dark flavor. Keep the selected dark flavor stable unless the product intentionally offers all flavors. Flavor switching must replace the complete palette adapter, never individual colors.

## Build a Two-Layer Token System

Keep canonical palette labels separate from product semantics:

```css
/* Palette adapter: the only layer containing flavor-specific values. */
[data-catppuccin-flavor="mocha"] {
  --ctp-base: /* canonical Mocha base */;
  --ctp-surface-0: /* canonical Mocha surface0 */;
  --ctp-text: /* canonical Mocha text */;
  --ctp-blue: /* canonical Mocha blue */;
  /* Define every label used by the semantic layer. */
}

/* Semantic layer: stable across every flavor. */
:root {
  --ui-canvas: var(--ctp-base);
  --ui-canvas-sunken: var(--ctp-mantle);
  --ui-panel: var(--ctp-surface-0);
  --ui-panel-hover: var(--ctp-surface-1);
  --ui-panel-active: var(--ctp-surface-2);
  --ui-border: var(--ctp-surface-1);
  --ui-border-strong: var(--ctp-overlay-0);
  --ui-text: var(--ctp-text);
  --ui-text-secondary: var(--ctp-subtext-1);
  --ui-text-muted: var(--ctp-subtext-0);
  --ui-action: var(--ctp-blue);
  --ui-focus: var(--ctp-lavender);
  --ui-info: var(--ctp-sapphire);
  --ui-success: var(--ctp-green);
  --ui-warning: var(--ctp-yellow);
  --ui-danger: var(--ctp-red);
}
```

Adapt the syntax to the platform's token system, such as CSS custom properties, Tailwind theme keys, SwiftUI colors, Android resources, or design-tool variables. Keep the two layers intact.

## Use the Neutral Ramp for Structure

The neutral labels already encode interface depth. Preserve their order across flavors:

| Labels                 | Interface role                                            |
| ---------------------- | --------------------------------------------------------- |
| `base`                 | Main content canvas                                       |
| `mantle`, `crust`      | Recessed regions, app chrome, sidebars, and outer shells  |
| `surface0`             | Cards, inputs, menus, and raised containers               |
| `surface1`             | Hovered containers and subtle borders                     |
| `surface2`             | Active, pressed, or more strongly separated surfaces      |
| `overlay0`             | Disabled controls, quiet dividers, and low-emphasis icons |
| `overlay1`, `overlay2` | Stronger secondary lines, icons, and overlays             |
| `subtext0`, `subtext1` | Muted and secondary text                                  |
| `text`                 | Primary text and high-emphasis icons                      |

Use adjacent steps for most boundaries. Skipping several neutral steps makes the interface harsher and loses Catppuccin's restrained hierarchy.

## Give Accents Jobs

Choose one primary action accent, usually `blue` or `mauve`, and use it consistently. Add only the accents needed for product meaning.

| Intent                       | Good candidates                                           |
| ---------------------------- | --------------------------------------------------------- |
| Primary action and links     | `blue` or `mauve`                                         |
| Keyboard focus               | `lavender`, `blue`, or the primary action accent          |
| Information                  | `sapphire` or `sky`                                       |
| Success                      | `green` or `teal`                                         |
| Warning                      | `yellow` or `peach`                                       |
| Error and destructive action | `red` or `maroon`                                         |
| Decorative highlights        | `rosewater`, `flamingo`, `pink`, or another unused accent |

Candidate labels are starting points, not guaranteed accessible foreground/background pairs. Keep meaning stable throughout the product. Avoid rotating accents merely for variety, and avoid putting every accent on one screen.

## Compose Common Components

### App shell

Use `base` for the main canvas. Use `mantle` or `crust` for recessed navigation and outer chrome. Use `surface0` for floating regions rather than inventing shadows from unrelated colors.

### Cards and rows

Use `surface0` for the resting background, `surface1` for hover, and `surface2` for pressed or selected states. Add an accent edge, icon, or marker when selection needs stronger emphasis.

### Inputs

Use a surface background, a neutral border, and `text` for input content. Use `subtext0` or `subtext1` for placeholders only after checking contrast. Focus needs a visible ring plus another cue such as border weight or shape.

### Buttons

Reserve solid accent fills for primary actions. Secondary buttons should use neutral surfaces with a clear border. Destructive buttons use `red` consistently. Derive `on-accent` text per flavor and verify it against every accent background instead of assuming one neutral label works everywhere.

### Status and badges

Prefer a neutral surface with a colored icon, edge, or label. If using tinted accent backgrounds, derive the tint from the same accent and test the resulting contrast. Pair status color with text or an icon.

## Accessibility Guardrails

- Measure the final rendered pair, including opacity, blending, gradients, and state overlays.
- Target at least 4.5:1 for normal text and 3:1 for large text under WCAG AA unless the project specifies a stricter standard.
- Check focus indicators and meaningful non-text boundaries at 3:1 where WCAG requires it.
- Add labels, icons, patterns, or shape changes so color is never the only signal.
- Verify hover, active, selected, disabled, error, and focus states independently.
- Respect forced-colors and platform accessibility modes rather than overriding them with palette values.
- Recheck every flavor. A pairing that works in Mocha may fail in Latte.

Catppuccin aims for a comfortable middle contrast, not automatic compliance for every composition. Treat contrast testing as part of implementation.

## Preserve the Palette

Use canonical labeled colors from one source of truth. Keep the four flavors internally complete. Prefer palette labels and semantic aliases over copied hex literals, manually lightened accents, or colors borrowed from another flavor.

The Catppuccin palette contains a monochromatic ramp for interface structure and an analogous accent set for emphasis and syntax. Let that division drive the design: neutrals establish hierarchy, accents communicate meaning.
