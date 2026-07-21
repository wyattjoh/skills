---
name: icon-gen
description: |
  Generates app icons using the snapai CLI with AI-powered image generation.
  Orchestrates project discovery, style refinement, icon generation, review,
  and multi-platform resizing. Triggers on "generate app icon", "create an
  icon", "make an app icon", "icon for my project", "app icon design",
  "generate icons", "app store icon", "icon set", or mentions "snapai".
allowed-tools:
  - Bash(snapai:*)
  - Bash(magick:*)
  - Bash(mkdir:*)
  - Bash(ls:*)
  - Read
  - Glob
  - Grep
  - AskUserQuestion
argument-hint: "[project-path]"
effort: high
---

# App Icon Generator

Generate polished app icons using `snapai` with an interactive refinement loop,
then resize for target platforms with ImageMagick.

## Prerequisites

- **snapai CLI** — installed and authenticated (`snapai` on PATH)
- **ImageMagick** — installed (`magick` on PATH) for resizing
- **API key** — snapai requires an active API key (configured via `snapai auth`)

## Workflow

Follow all six phases sequentially. Do not skip phases unless the user
explicitly asks to.

### Phase 1: Project Discovery

Investigate the project to build context for prompt generation.

**If `$ARGUMENTS` contains a project path:**

1. Read project manifest files to understand what the project does:
   - `README.md`, `package.json`, `Cargo.toml`, `pubspec.yaml`, `deno.json`,
     `pyproject.toml`, `go.mod`, or similar
2. Glob for existing icons or branding assets:
   - `**/icon*`, `**/logo*`, `**/Assets.xcassets/**`, `**/mipmap-*/**`,
     `**/favicon*`
3. Synthesize a **2–3 sentence summary** covering:
   - What the project does
   - Target audience or platform
   - Any existing brand identity (colors, style, existing icon themes)

**If no path is provided:**

Ask the user to describe their project, target audience, and any brand
preferences.

### Phase 2: Style Refinement

Present **two questions in a single `AskUserQuestion` call**:

**Question 1 — Visual Style:**

| Option        | Description                                       |
| ------------- | ------------------------------------------------- |
| Let AI decide | snapai chooses the best style based on the prompt |
| Minimalist    | Clean, simple shapes with `--style minimalism`    |
| Glassy        | Glossy, reflective surfaces with `--style glassy` |
| Neon          | Vibrant, glowing outlines with `--style neon`     |

Allow "Other" for custom style descriptions.

**Question 2 — Color Palette:**

| Option         | Description                               |
| -------------- | ----------------------------------------- |
| Let AI decide  | Colors chosen to match the prompt context |
| Vibrant        | Bold, saturated colors                    |
| Muted / Pastel | Soft, understated tones                   |
| Monochrome     | Single color or grayscale                 |

Allow "Other" for specific color values (e.g., "brand blue #2563EB").

### Phase 3: Concept Proposal

Compose a detailed icon description for the `--prompt` value:

1. Incorporate project context from Phase 1
2. Apply style and color preferences from Phase 2
3. Focus on a single, recognizable visual element at icon scale
4. Describe the composition, color treatment, and mood

Present the proposed prompt to the user via `AskUserQuestion`:

| Option        | Description                                                |
| ------------- | ---------------------------------------------------------- |
| Generate this | Proceed to icon generation with this prompt                |
| Refine        | Modify the prompt (ask what to change, update, re-present) |
| Start over    | Return to concept composition from scratch                 |

**Loop** on "Refine" until the user selects "Generate this" or "Start over".

### Phase 4: Generate Icon

Determine the output directory:

1. If the project has an `assets/` directory → `<project>/assets/icons/`
2. If the project has a `Resources/` directory (Xcode) → `<project>/Resources/icons/`
3. Otherwise → `<project>/icons/`

Run the generation command:

```bash
mkdir -p <output-dir>
snapai icon --model banana --prompt "<approved-prompt>" --output <output-dir> [--style <style>]
```

After generation completes, **show the generated icon to the user** by reading
the output PNG file with the Read tool.

### Phase 5: Review & Iterate

Present the generated icon and ask the user via `AskUserQuestion`:

| Option                 | Description                                 |
| ---------------------- | ------------------------------------------- |
| Keep it                | Accept this icon and proceed to resizing    |
| Tweak it               | Modify the prompt slightly and regenerate   |
| Different concept      | Return to Phase 3 for a new concept         |
| Generate more variants | Run with `-n 3` to produce multiple options |

**Behavior per choice:**

- **Keep it** → proceed to Phase 6
- **Tweak it** → ask what to change, update the prompt, re-run Phase 4
- **Different concept** → return to Phase 3
- **Generate more variants** → re-run with `-n 3`, show all results, ask user
  to pick one, then offer the same review options again

**Loop** until the user selects "Keep it".

### Phase 6: Platform Resizing

Ask the user which platforms to resize for using `AskUserQuestion` with
`multiSelect: true`:

| Option        | Description                                      |
| ------------- | ------------------------------------------------ |
| iOS           | App Store and device icons (1024 down to 20px)   |
| Android       | Play Store and launcher icons (512 down to 48px) |
| macOS         | App and Finder icons (1024 down to 16px)         |
| Web / Favicon | PWA, favicon, and Apple touch icons              |
| Raycast       | Raycast extension icons (512 and 256px)          |

For each selected platform, create a subdirectory and resize:

```bash
mkdir -p <output-dir>/<platform>
magick <source>.png -resize NxN <output-dir>/<platform>/icon-<N>.png
```

Refer to `references/platform-sizes.md` for the complete list of sizes and
their usage annotations for each platform.

After resizing, list all generated files and report completion with a summary
table showing platform, file count, and directory path.

## Prompt Construction Guidelines

When composing the `--prompt` value:

- **Lead with the subject** — "A [object/symbol] representing [concept]"
- **Describe at icon scale** — single focal element, no text, no fine detail
- **Specify background treatment** — solid color, gradient, or transparent
- **Include material/texture** — matte, glossy, metallic, flat
- **State color explicitly** — even if Phase 2 chose "Let AI decide", mention
  dominant colors

**Example prompt:**

> A stylized mountain peak with aurora borealis ribbons, matte finish, deep
> navy background with teal and purple accents, minimal detail, app icon
> composition

## Tips

- **Banana is the default model** — it produces the best results for icons and
  is the only model that should be used unless the user explicitly requests
  otherwise
- **snapai auto-enhances prompts** — you don't need to over-specify; the CLI
  adds its own refinements
- **Use `--pro` for quality** — during iteration, if the user wants higher
  fidelity, add the `--pro` flag
- **Transparent backgrounds** — only available with `gpt-1.5` model; mention
  this if the user asks for transparency
- **Icon composition** — always remind the user that icons should have a single,
  recognizable element; avoid text or complex scenes
