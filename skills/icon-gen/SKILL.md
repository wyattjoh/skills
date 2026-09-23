---
name: icon-gen
description: |
  Generates app icons with OpenRouter, Google Gemini, and varlock-managed
  configuration. Orchestrates project discovery, style refinement, icon
  generation, review, and multi-platform resizing. Triggers on "generate app
  icon", "create an icon", "make an app icon", "icon for my project", "app
  icon design", "generate icons", "app store icon", or "icon set".
allowed-tools:
  - Bash(varlock:*)
  - Bash(magick:*)
  - Bash(mkdir:*)
  - Bash(ls:*)
  - Read
  - Glob
  - Grep
  - AskUserQuestion
argument-hint: "[project-path]"
disable-model-invocation: true
effort: high
compatibility: Requires varlock 1.10+, Bun 1.1+, Node.js 22+, the 1Password CLI and desktop app integration, ImageMagick, and OpenRouter access.
---

# App Icon Generator

Generate polished app icons with OpenRouter's dedicated Images API and a
varlock-managed model, then resize them for target platforms with ImageMagick.

## Prerequisites

- **varlock 1.10+**: installed (`varlock` on PATH)
- **Bun 1.1+**: installed (`bun` on PATH) to run the bundled generator
- **Node.js 22+**: required by the pinned 1Password plugin
- **1Password**: CLI installed, desktop app running, and CLI integration enabled
- **ImageMagick**: installed (`magick` on PATH) for resizing
- **OpenRouter access**: an API key stored in 1Password

Install the schema's pinned plugin once per machine:

```bash
varlock install-plugin @varlock/1password-plugin@1.2.0
```

The committed `$SKILL_DIR/.env.schema` declares `OPENROUTER_API_KEY` and
`OPENROUTER_MODEL` without values. Configure the ignored
`$SKILL_DIR/.env.local` before generating:

```dotenv
OPENROUTER_API_KEY=op(op://VAULT/ITEM/FIELD)
OPENROUTER_MODEL=google/gemini-3.1-flash-image
```

Replace the placeholder reference with the API key field's exact 1Password
secret reference. Never put the API key value in either file.

## Workflow

Run the phases in order. Phases 2, 3, 5, and 6 are user checkpoints, and Phase 4
makes billed API requests, so reach each checkpoint unless the user asks to skip
it.

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

**Question 1: Visual Style:**

| Option        | Description                                            |
| ------------- | ------------------------------------------------------ |
| Let AI decide | Gemini chooses the best style from the project context |
| Minimalist    | Clean, simple shapes with minimal detail               |
| Glassy        | Glossy, reflective surfaces                            |
| Neon          | Vibrant, glowing outlines                              |

The user can type a custom style description.

**Question 2: Color Palette:**

| Option         | Description                               |
| -------------- | ----------------------------------------- |
| Let AI decide  | Colors chosen to match the prompt context |
| Vibrant        | Bold, saturated colors                    |
| Muted / Pastel | Soft, understated tones                   |
| Monochrome     | Single color or grayscale                 |

The user can type specific color values (e.g., "brand blue #2563EB").

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

Run the bundled generator through varlock. It validates and resolves the local
configuration, injects only the declared variables, creates the output directory,
and requests a 1K, 1:1 image from OpenRouter:

```bash
varlock run --path "$SKILL_DIR/" --inject vars -- \
  bun "$SKILL_DIR/scripts/generate.ts" \
  --prompt "<approved-prompt>" \
  --output-dir <output-dir>
```

A single generation writes `<output-dir>/icon.png`. After generation completes,
**show the generated icon to the user** by reading the output file with the Read
tool.

### Phase 5: Review & Iterate

Present the generated icon and ask the user via `AskUserQuestion`:

| Option                 | Description                                      |
| ---------------------- | ------------------------------------------------ |
| Keep it                | Accept this icon and proceed to resizing         |
| Tweak it               | Modify the prompt slightly and regenerate        |
| Different concept      | Return to Phase 3 for a new concept              |
| Generate more variants | Run with `--count 3` to produce multiple options |

**Behavior per choice:**

- **Keep it** → proceed to Phase 6
- **Tweak it** → ask what to change, update the prompt, re-run Phase 4
- **Different concept** → return to Phase 3
- **Generate more variants** → re-run the bundled generator with `--count 3`,
  show `icon-1.png`, `icon-2.png`, and `icon-3.png`, ask the user to pick one,
  then offer the same review options again. Gemini supports one image per API
  request, so the script makes and bills three separate requests.

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
| Raycast       | Raycast extension icons (512px)                  |

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

- **Lead with the subject**: "A [object/symbol] representing [concept]"
- **Describe at icon scale**: single focal element, no text, no fine detail
- **Specify background treatment**: solid color or gradient
- **Include material/texture**: matte, glossy, metallic, flat
- **State color explicitly**: even if Phase 2 chose "Let AI decide", mention
  dominant colors

**Example prompt:**

> A stylized mountain peak with aurora borealis ribbons, matte finish, deep
> navy background with teal and purple accents, minimal detail, app icon
> composition

## Tips

- **Configuration stays out of the project**: `$SKILL_DIR/.env.schema` is
  committed with empty declarations, while `$SKILL_DIR/.env.local` is ignored
  and holds the 1Password reference and model slug.
- **The model is configurable**: varlock validates and injects
  `OPENROUTER_MODEL`; the local configuration uses
  `google/gemini-3.1-flash-image`.
- **Validate without exposing secrets**: run
  `varlock load --path "$SKILL_DIR/" --agent` to inspect redacted resolution.
- **Prompts are sent as written**: include the chosen style, palette,
  composition, and mood in the approved prompt.
- **Variants are separate requests**: `--count 3` makes three sequential,
  separately billed requests because this model only supports one image per
  request.
- **Transparent backgrounds are unsupported**: this model does not expose a
  background transparency parameter through OpenRouter. Mention this if the
  user asks for transparency.
- **Icon composition**: icons read best as a single, recognizable element without
  text or complex scenes. Point this out when a requested concept includes either.
