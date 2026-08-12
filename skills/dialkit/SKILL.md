---
name: dialkit
description: Live parameter tweaking and design exploration for React projects using the dialkit npm package. Triggers on "design with dialkit", "live parameter tweaking", "interactive design exploration", "tweak parameters", "tune values", "explore design directions", "dial in this component", "design exploration", or invokes /dialkit. Installs dialkit temporarily, instruments components with sliders, colors, toggles, and spring editors, supports multi-preset comparison for exploring distinct design directions, then fully removes dialkit and bakes the chosen values into source as inline literals.
effort: high
argument-hint: "[component-name]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - AskUserQuestion
---

# DialKit

## Overview

This skill walks the user through a **temporary, exploratory** integration of
the [`dialkit`](https://www.npmjs.com/package/dialkit) npm package: a
real-time parameter-tweaking panel for React. The user instruments one or more
components with `useDialKit` calls, tweaks values live in the browser via a
floating panel (sliders, color pickers, selects, spring editors, toggles),
then **the skill fully removes dialkit** and bakes the chosen values into the
source as inline literals.

> dialkit is **never** committed to source control. It exists only for the
> duration of an exploration session.

## Two Modes

### Exploration Mode (primary)

The user has a vague idea or wants to discover. Instrument the component(s)
with a wide set of controls, then **explicitly guide the user to save 2 to 4
named presets** ("Compact", "Bold", "Airy") using dialkit's "+" button. Once
presets are saved, help them compare, pick a winner, or **merge across
presets** ("I like Bold's color but Airy's spacing, synthesize").

### Tweak Mode

The user has a specific component and a few specific knobs to dial in. Skip
the multi-preset workflow. Instrument, let the user dial, capture the JSON,
integrate.

When unsure, ask which mode. Default to Exploration.

## Workflow

### Phase 0: Setup detection

Before installing anything, gather:

1. **Confirm React project**: read `package.json`, look for `react`. dialkit
   itself also ships Solid, Svelte, and Vue integrations, but this skill's
   workflow only covers React. If `react` is absent, stop and explain that
   this skill's workflow is React-only.
2. **Check for `motion`**: dialkit requires `motion` (formerly
   `framer-motion`) for spring controls. Record one of:
   - `motion` already in `package.json`: don't reinstall, don't remove on
     cleanup.
   - `framer-motion` only: still install `motion` (spring config is
     interoperable). Do not remove `framer-motion` on cleanup.
   - Neither: install `motion` alongside dialkit. **Must remove on cleanup.**
3. **Look for design tokens** (see [Design Token Detection](#design-token-detection)).
4. **Confirm dev server is running**: ask the user. If not, ask them to start
   it before instrumenting. The skill does **not** start it.

### Phase 1: Mode + target selection

1. Ask: Exploration or Tweak mode? Default to Exploration.
2. Identify target component(s). Multiple components are supported; each gets
   its own `useDialKit('ComponentName', {...})` call and appears as a folder
   in the panel.
3. **Read each target component** so you know its current values, what is
   styling vs structural, and what already comes from tokens.

### Phase 2: Property selection and preset directions

For each target, **ask the user what aspects they want to tweak or explore**.
Don't infer aggressively. Surface candidates only after they answer.

If design tokens were found in Phase 0, **seed defaults from them**:

> "Your theme defines `spacing.lg = 16` and `colors.primary = #6366f1`. I'll
> use those as starting values, so the slider center is your existing design
> language."

Translate each aspect to the appropriate dialkit control type using
[Control Selection](#control-selection).

**Always brainstorm 3 to 5 named design directions** before instrumenting.
The skill seeds these as presets so the panel opens with a comparison set
ready in the dropdown. Names should match the exploration:

| Mode        | Direction-name patterns that work well                             |
| ----------- | ------------------------------------------------------------------ |
| Exploration | Compact / Bold / Airy / Playful / Restrained / Dramatic            |
| Tweak       | Subtle / Default / Strong (or Conservative / Default / Aggressive) |

For each direction, propose concrete values for the panel's controls (anchor
to design tokens when they exist). Even in Tweak mode, generate at least 3
seeds so the user can A/B/C compare instead of dialing from scratch. These
become the panel's `seedPresets` argument in Phase 3.

### Phase 3: Instrument

Make these edits in this order:

1. **Install dependencies**:

   ```bash
   npm install dialkit motion
   ```

   Skip `motion` if already present.

2. **Mount `<DialRoot />`** once at the app root. Locations vary:

   | Setup                | File                             |
   | -------------------- | -------------------------------- |
   | Next.js App Router   | `app/layout.tsx` inside `<body>` |
   | Next.js Pages Router | `pages/_app.tsx`                 |
   | Vite / CRA           | `src/main.tsx` or `src/App.tsx`  |
   | Remix                | `app/root.tsx` inside `<body>`   |

   ```tsx
   import { DialRoot } from "dialkit";
   import "dialkit/styles.css";
   // ...
   <DialRoot />;
   ```

   **Never set `productionEnabled`.** dialkit auto-hides in prod builds, which
   guarantees the panel never ships.

3. **Add `<DialKitPersistence />`** next to `<DialRoot />` to survive HMR and
   page refreshes. dialkit has no built-in persistence; values and presets live
   in a module-level singleton (`DialStore`) that wipes on full reloads. See
   [Persistence](#persistence) for the snippet to drop in.

4. **Instrument target components** with `useDialKit`. Replace the values the
   user wants to vary with `p.<name>` references. Leave other values
   untouched. Each component gets its own panel folder via the `name`
   argument:

   ```tsx
   const p = useDialKit("Card", {
     shadow: {
       blur: [12, 0, 60],
       offsetY: [4, 0, 24],
       opacity: [0.1, 0, 0.4],
     },
   });
   ```

5. **Tell the user where to look**:

   > "The panel is at the top-right of your dev server. Open the disclosure to
   > see the controls. Tweak as long as you like. Refreshes and HMR reloads
   > preserve your values and presets via sessionStorage."

### Phase 4A: Exploration loop (presets-as-design-directions)

This is the killer pattern for exploration mode. The panel ships **already
populated** with the seeded presets from Phase 3.

1. Tell the user: "The dropdown at the top of the panel has the directions we
   pre-seeded ('Compact', 'Bold', 'Airy', etc.). Click each to switch in the
   live preview. Drag any control to refine within a preset (auto-saves to
   the active one). Click **+** to add a new preset for any direction we
   missed."
2. When the user has narrowed down, ask them to either:
   - Tell you which preset wins ("Bold feels right"), or
   - Click **Copy** on each preset they're considering and paste the JSONs
     in chat for side-by-side comparison.
3. When you have multiple preset JSONs in chat, help with:
   - **Compare**: "Compact has 8/12/16 spacing, Bold has 4/8/12, so Bold is
     about 50% tighter overall."
   - **Pick a winner**: "Sounds like Airy is closest. Want to ship those
     values?"
   - **Merge**: "Want Bold's colors with Airy's spacing? I'll synthesize the
     blend. Paste it back into the panel as a new preset to verify."
4. Iterate until the user picks a final direction.

### Phase 4B: Tweak loop

Even in tweak mode the panel ships with the 3 seeded presets (Subtle /
Default / Strong, or whatever names you brainstormed in Phase 2), so the user
can A/B/C immediately rather than dialing from scratch.

1. User switches between seeded presets to find the closest baseline, then
   refines via the controls (auto-saves to the active preset).
2. When satisfied, user clicks **Copy** in the panel toolbar.
3. User pastes the JSON in chat.

### Phase 5: Capture final values

When the user pastes JSON:

1. **Validate the shape** matches the dialkit config you authored in Phase 3
   (same keys, same nesting). If it doesn't (e.g. partial selection), ask
   them to Copy again from the panel.
2. **Echo the values back** so the user can confirm: "Final values:
   padding=16, shadowBlur=24, ... apply?"

### Phase 6: Integrate + cleanup

This is the most important phase. The working tree must end up with **only
the design changes**, no trace of dialkit.

In order:

1. **Replace `p.<name>` references with concrete literals** at every call
   site. Inline literals (e.g. `p.shadowBlur` becomes `24`).
2. **Remove the `useDialKit(...)` call** from each instrumented component.
3. **Remove the `useDialKit` import** from each file.
4. **If no `useDialKit` call remains anywhere**:
   - Remove `<DialRoot />` and `<DialKitPersistence />` from the root layout.
   - Remove `import "dialkit/styles.css"` and
     `import { DialRoot } from "dialkit"`.
   - Remove the `import { DialKitPersistence } from "./DialKitPersistence"`.
   - **Delete `DialKitPersistence.tsx`** entirely.
5. **Uninstall**:

   ```bash
   npm uninstall dialkit
   ```

   Run `npm uninstall motion` **only if** Phase 0 recorded that we installed
   it.

6. **Verify** (run all of these, expect zero hits):

   ```bash
   grep -r "dialkit" src/ app/ pages/ components/ 2>/dev/null
   grep -r "DialRoot" src/ app/ pages/ components/ 2>/dev/null
   grep -r "useDialKit" src/ app/ pages/ components/ 2>/dev/null
   ```

   Also confirm `package.json` has no `dialkit` entry, and no `motion` entry
   if we installed it.

7. **Run typecheck/build**: `npm run typecheck` or `npm run build`. Fix any
   stragglers.
8. **Show the diff** so the user can confirm only their design values changed.
9. **Offer to commit** with a conventional commit message focused on the
   design change:

   ```
   style(card): refine shadow depth and motion timing
   ```

   Don't mention dialkit; it's an implementation detail of the exploration
   process.

See [Cleanup Verification Checklist](#cleanup-verification-checklist) for the
strict, ordered list.

## Persistence

> **Note:** dialkit (≥1.x) now ships a built-in `persist` option on
> `useDialKit`/`useDialKitController` (`persist: true` or
> `{ key, storage: 'localStorage'|'sessionStorage', presets: boolean }`) that
> covers much of what the companion component below does. Check the installed
> package version and its README before instrumenting; the built-in option
> may let you skip copying `DialKitPersistence.tsx` entirely. The workflow
> below remains a valid fallback for older versions or finer control.

Historically, dialkit had no built-in persistence: its `DialStore` is a
module-level singleton (`export const DialStore = new DialStoreClass()`)
holding panels, values, and presets in plain `Map`s. Anything that recreates
that singleton wipes state:

| Event                              | Wipes state? | Why                                                                                     |
| ---------------------------------- | ------------ | --------------------------------------------------------------------------------------- |
| Editing a consumer component (HMR) | No           | dialkit module untouched, singleton survives, React Fast Refresh keeps `useId()` stable |
| Full page refresh                  | **Yes**      | Browser drops all JS memory                                                             |
| Hard HMR / `optimize-deps` reload  | **Yes**      | Fresh module graph, fresh singleton                                                     |
| Editing dialkit itself (rare)      | **Yes**      | Module re-evaluates, fresh singleton                                                    |
| Closing the tab                    | **Yes**      | Memory gone with the document                                                           |

To survive these, mount a `<DialKitPersistence />` companion next to
`<DialRoot />` that mirrors the store to `sessionStorage`. It uses only
dialkit's public API (`DialStore.subscribe`, `subscribeGlobal`, `getPanels`,
`getValues`, `getPresets`, `getActivePresetId`, `updateValue`, `savePreset`,
`loadPreset`), so no monkey-patching.

Copy the prebuilt component from this skill's references folder into the
user's project next to where they mount `<DialRoot />`:

```bash
cp $SKILL_DIR/references/DialKitPersistence.tsx <project>/<dir-with-DialRoot>/
```

`$SKILL_DIR` resolves to `~/.claude/skills/dialkit/`. Common destinations:

| Setup                | Destination                              |
| -------------------- | ---------------------------------------- |
| Next.js App Router   | `app/DialKitPersistence.tsx`             |
| Next.js Pages Router | `pages/DialKitPersistence.tsx` or `src/` |
| Vite / CRA           | `src/DialKitPersistence.tsx`             |
| Remix                | `app/DialKitPersistence.tsx`             |

The file is a self-contained ~110-line React component using only dialkit's
public API (`subscribe`, `subscribeGlobal`, `getPanels`, `getValues`,
`getPresets`, `getActivePresetId`, `updateValue`, `savePreset`, `loadPreset`),
so no monkey-patching. It's marked `TEMPORARY` in a header comment so the
user knows to delete it during cleanup.

Mount it alongside `<DialRoot />` (after, so its effect runs after consumers
register their panels) and pass the **seedPresets** brainstormed in Phase 2.
Each key matches a `useDialKit` panel name; each entry is a list of named
directions whose values populate the panel's preset dropdown on first load:

```tsx
import { DialRoot } from "dialkit"
import "dialkit/styles.css"
import {
  DialKitPersistence,
  type DialKitSeedPresets,
} from "./DialKitPersistence"

const seedPresets: DialKitSeedPresets = {
  Card: [
    {
      name: "Compact",
      values: { "shadow.blur": 8, "shadow.offsetY": 2, "shadow.opacity": 0.05 },
    },
    {
      name: "Bold",
      values: { "shadow.blur": 32, "shadow.offsetY": 12, "shadow.opacity": 0.3 },
    },
    {
      name: "Airy",
      values: { "shadow.blur": 24, "shadow.offsetY": 8, "shadow.opacity": 0.12 },
    },
  ],
}

// in your root layout, inside <body>:
<DialRoot />
<DialKitPersistence seedPresets={seedPresets} />
```

**Path keys are dotted strings** matching the dialkit config nesting (e.g.
`shadow.blur` for `{ shadow: { blur: [...] } }`). Seeds only fire when
sessionStorage has no prior entry for the panel name; once the user has
interacted, their tweaks are preserved across reloads. To re-seed after
changing the seed values, clear `sessionStorage.dialkit:session` in devtools
and refresh.

### What this covers

- **Page refresh**: hydrates from `sessionStorage` on the next mount. Values
  and preset names/contents return.
- **Hard HMR / module-level dialkit reload**: same hydration path triggers
  whenever a panel re-registers against a fresh `DialStore`.
- **Late-mounting consumers** (lazy routes, conditional renders): hydrated on
  first registration via the `subscribeGlobal` callback.

### Caveats

- **Identity is by panel `name`**: two `useDialKit` calls with the same name
  will collide in storage. The skill already enforces unique names per
  component; keep it that way.
- **Preset ids change** across reloads (regenerated by `savePreset`). Names
  and contents survive, which is what the workflow uses. If your code reads
  preset ids directly, don't rely on stability.
- **Tab-scoped**: `sessionStorage` clears when the tab closes. This is
  intentional for ephemeral exploration. If you want presets to survive tab
  close (e.g. to resume tomorrow), swap `sessionStorage` for `localStorage`
  in the snippet (one line, two occurrences). For multi-day exploration,
  prefer the `.dialkit.notes.md` workflow described under
  [Edge Cases](#user-wants-to-keep-tweaking-in-a-future-session) instead, so
  the values land in version control as plain JSON.
- **Storage size**: typical sessions stay under a few KB; far below the ~5MB
  per-origin sessionStorage cap. If you hit the cap, you have too many panels
  with too many controls and should split them.

### Cleanup

`DialKitPersistence.tsx` is a temporary file. The
[Cleanup Verification Checklist](#cleanup-verification-checklist) below
includes deleting it. After integration, the `dialkit:session` entry in
`sessionStorage` becomes orphaned, but it's already cleared on tab close.

## Control Selection

When translating user-stated aspects to dialkit config:

| User wants to vary                            | dialkit control        | Example                                                                |
| --------------------------------------------- | ---------------------- | ---------------------------------------------------------------------- |
| Numeric value (size, blur, opacity, duration) | Slider                 | `blur: [24, 0, 100]` or `scale: 1.2` (auto-inferred)                   |
| On/off behavior                               | Toggle                 | `darkMode: true`                                                       |
| Free-form string                              | Text                   | `title: 'Hello'` or `{ type: 'text', placeholder: '...' }`             |
| Color                                         | Color                  | `accent: '#6366f1'` (hex auto) or `{ type: 'color', default: '#000' }` |
| Discrete options (layout, variant, alignment) | Select                 | `{ type: 'select', options: ['stack', 'fan', 'grid'] }`                |
| Animation feel (Motion-based)                 | Spring                 | `{ type: 'spring', visualDuration: 0.3, bounce: 0.2 }`                 |
| One-shot trigger (shuffle, reset)             | Action                 | `{ type: 'action' }` plus `onAction` callback                          |
| Group of related controls                     | Folder (nested object) | `shadow: { blur: [...], opacity: [...] }`                              |

**Auto-inference rules** (use bare values when they fit; explicit ranges only
when the inferred range is wrong):

| Bare value       | Inferred range | Step |
| ---------------- | -------------- | ---- |
| `0.5` (in 0..1)  | 0..1           | 0.01 |
| `5` (in 0..10)   | 0..15          | 0.1  |
| `60` (in 0..100) | 0..180         | 1    |
| `200` (100+)     | 0..600         | 10   |

**Use folders to group**: `shadow: { blur: [...], color: '#000', opacity: [...] }`.
Add `_collapsed: true` to start a folder closed. The `_collapsed` key is
reserved metadata and won't appear in returned values.

**Use shortcuts sparingly**: only assign keyboard shortcuts when the user
wants to tweak without taking their hands off the keyboard, e.g. for a value
they're sweeping rapidly during animation tuning.

```tsx
shortcuts: {
  blur: { key: 'b', mode: 'fine' },              // B+Scroll, fine = step/10
  scale: { key: 's', interaction: 'drag' },      // S+Drag
  'shadow.blur': { key: 'd' },                   // dot notation for nested
}
```

## Design Token Detection

Surface tokens to the user **before** authoring the dialkit config so the
panel's defaults match their existing design language.

| Source                                 | Token type                                                              | How to seed defaults                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `tailwind.config.{ts,js,cjs,mjs}`      | `theme.spacing`, `theme.colors`, `theme.borderRadius`, `theme.fontSize` | Use the closest scale value as the slider default; for color palettes, use a Select control |
| `theme.ts`, `theme.tsx`, `tokens.ts`   | TS/JS object exports                                                    | Import-trace the relevant tokens; use named values as defaults                              |
| `:root { --spacing-lg: 16px; }` in CSS | CSS custom properties                                                   | Read computed values; use as numeric defaults                                               |
| `styled-components` ThemeProvider      | Theme object                                                            | Read the theme literal in source; use values as defaults                                    |
| Component literal (no token system)    | Inline numbers/colors                                                   | Use the existing literal as the default                                                     |

If multiple sources exist, prefer in this order: explicit tokens file >
Tailwind config > CSS custom props > inline literals.

When tokens are **discrete** (e.g. Tailwind's `spacing-1`, `spacing-2`, ...,
`spacing-16`), prefer a **Select** control with the scale values as options
over a continuous slider. This guarantees the chosen value snaps back into
the design system at integration time, instead of producing an off-scale
literal like `padding: 14px`.

## Cleanup Verification Checklist

Before declaring the session complete, verify all of:

- [ ] Every `p.<name>` reference replaced with a concrete literal
- [ ] Every `useDialKit(...)` call removed
- [ ] Every `useDialKit` import removed
- [ ] `<DialRoot />` removed from root layout (if no `useDialKit` calls remain)
- [ ] `<DialKitPersistence />` removed from root layout
- [ ] `seedPresets` const removed from root layout
- [ ] `import "dialkit/styles.css"` removed (if no `useDialKit` calls remain)
- [ ] `import { DialRoot } from "dialkit"` removed (if no `useDialKit` calls remain)
- [ ] `import { DialKitPersistence, type DialKitSeedPresets } from "./DialKitPersistence"` removed
- [ ] `DialKitPersistence.tsx` file deleted
- [ ] `npm uninstall dialkit` completed
- [ ] `npm uninstall motion` completed **only if** we installed it in Phase 0
- [ ] `package.json` has no `dialkit` entry
- [ ] `package.json` has no `motion` entry **if** we installed it
- [ ] `grep -r "dialkit\|DialRoot\|useDialKit\|DialKitPersistence" src/ app/ pages/ components/` returns nothing
- [ ] `npm run typecheck` (or equivalent) passes
- [ ] `npm run build` passes (if the project has a build command)
- [ ] User has reviewed the diff and confirmed it's only design values

## Edge Cases

### Component uses Tailwind classes

Tailwind class strings (`p-4 shadow-lg`) cannot be slider-tweaked directly.
Strategy:

1. During Phase 3, **convert the relevant Tailwind classes to inline styles**
   for the values the user wants to vary. Leave other classes intact.
2. After capture, **re-convert to the closest Tailwind scale value** during
   Phase 6. E.g. user picked `padding: 14px`, snap to `p-3.5` (`14px`) or
   `p-4` (`16px`) depending on what the design system allows.
3. If the chosen value falls between scale steps and matters, either extend
   the Tailwind config or accept the inline style as the final form.

Better: in Phase 2, propose a Select control with the actual Tailwind scale
values, so the chosen value is by-construction valid.

### User wants to keep tweaking in a future session

Cleanup still happens. Then **save the chosen presets' JSON as a small
`.dialkit.notes.md` file** at the project root (gitignored). Next session,
the skill can re-instrument from that file as the starting point. Presets
themselves are saved client-side by dialkit, so keeping the dev server tab
open also preserves them across re-instruments.

### `framer-motion` is the project's animation library, not `motion`

`motion` is the successor to `framer-motion` and dialkit's spring config is
interoperable. Install `motion` alongside `framer-motion` for the duration of
the session. **Don't migrate the project to `motion`** as part of this
skill; that's a separate task. On cleanup, remove `motion` and leave
`framer-motion` alone.

### Component uses CSS-in-JS / styled-components

Same approach as Tailwind: extract the relevant numeric values to inline
styles or CSS variables for the duration of exploration, then re-merge into
the styled component at integration time.

### Multi-component session

Each `useDialKit('Name', {...})` call gets a unique `name` argument. The
panel groups them as separate folders, so a single panel can drive a Card, a
Button, and a NavBar simultaneously. At cleanup, walk each component
independently before removing `<DialRoot />`.

### `productionEnabled`

**Never set this.** dialkit's default behavior (hidden in prod builds) is
the safety net that prevents accidentally shipping the panel.

## Example Session

**User**: "I want to tweak the shadow on this Card component."

**Response**:

1. Read `Card.tsx`. Spot existing
   `boxShadow: '0 4px 12px rgba(0,0,0,0.1)'`.
2. Phase 0: confirm React + Vite project; `motion` not installed; Tailwind
   config has `theme.boxShadow.md = '0 4px 6px -1px rgba(0,0,0,0.1)...'`;
   dev server running on :5173.
3. Phase 1: ask Exploration or Tweak. User says Tweak.
4. Phase 2: ask which aspects of the shadow. User says blur, y-offset,
   opacity. Brainstorm 3 directions: **Subtle / Default / Strong**, with
   concrete values for each that span the range.
5. Phase 3:
   - `npm install dialkit motion` (record: we installed motion).
   - Copy `$SKILL_DIR/references/DialKitPersistence.tsx` to `src/`.
   - Add `<DialRoot />` and `<DialKitPersistence seedPresets={...} />` to
     `src/main.tsx` with the seeds:

     ```tsx
     const seedPresets: DialKitSeedPresets = {
       Card: [
         {
           name: "Subtle",
           values: { "shadow.blur": 6, "shadow.offsetY": 2, "shadow.opacity": 0.05 },
         },
         {
           name: "Default",
           values: { "shadow.blur": 12, "shadow.offsetY": 4, "shadow.opacity": 0.1 },
         },
         {
           name: "Strong",
           values: { "shadow.blur": 32, "shadow.offsetY": 12, "shadow.opacity": 0.3 },
         },
       ],
     };
     ```

   - Instrument `Card.tsx`:

     ```tsx
     const p = useDialKit("Card", {
       shadow: {
         blur: [12, 0, 60],
         offsetY: [4, 0, 24],
         opacity: [0.1, 0, 0.4],
       },
     });
     // ...
     style={{
       boxShadow: `0 ${p.shadow.offsetY}px ${p.shadow.blur}px rgba(0,0,0,${p.shadow.opacity})`,
     }}
     ```

   - Tell user: "Panel is top-right. Tweak the shadow folder."

6. Phase 4B: user dials, clicks Copy.
7. Phase 5: user pastes:

   ```json
   { "shadow": { "blur": 24, "offsetY": 8, "opacity": 0.18 } }
   ```

   Validate shape, confirm.

8. Phase 6:
   - Replace `p.shadow.blur` → `24`, `p.shadow.offsetY` → `8`,
     `p.shadow.opacity` → `0.18`.
   - Final inline: `boxShadow: '0 8px 24px rgba(0,0,0,0.18)'`.
   - Remove `useDialKit` call and import. No more `useDialKit` calls in the
     project, so:
     - Remove `<DialRoot />` from `src/main.tsx`.
     - Remove `import "dialkit/styles.css"` and
       `import { DialRoot } from "dialkit"`.
   - `npm uninstall dialkit motion` (we installed motion).
   - Run cleanup grep: clean.
   - Run `npm run typecheck`: passes.
   - Show diff: only `Card.tsx`'s `boxShadow` value changed.
   - Offer commit: `style(card): refine shadow depth and softness`.

## Tips

- **Default to Exploration mode** when the user is vague.
- **Save presets liberally** in Exploration mode. Comparing 3 to 4 directions
  side by side beats incremental tweaking.
- **Seed defaults from tokens** whenever they exist. Don't start from raw
  numbers when the project has a design language.
- **One `useDialKit` call per component**. Multi-component is supported and
  encouraged for related components (e.g. Card + Button on the same page).
- **Cleanup is non-negotiable.** The session is not done until
  `grep -r dialkit` returns nothing and `package.json` is clean.
- **Never set `productionEnabled`.** Let dialkit's prod-build auto-hide be
  the safety net.
- **Respect the user's design system.** When tokens are discrete, prefer
  Select controls so the final value snaps back into the scale.
- **Commit messages describe the design change**, not the tooling. dialkit
  never appears in git history.
