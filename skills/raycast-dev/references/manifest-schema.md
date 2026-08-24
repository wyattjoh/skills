# Raycast Extension Manifest (package.json)

This reference covers the structure and configuration of a Raycast extension's `package.json` manifest file.

## Basic Structure

```json
{
  "$schema": "https://www.raycast.com/schemas/extension.json",
  "name": "my-extension",
  "title": "My Extension",
  "description": "A brief description of what the extension does",
  "icon": "icon.png",
  "author": "github-username",
  "owner": "organization-name",
  "platforms": ["macOS", "Windows"],
  "categories": ["Productivity", "Developer Tools"],
  "license": "MIT",
  "commands": [
    {
      "name": "main-command",
      "title": "Main Command",
      "description": "Description of what this command does",
      "mode": "view"
    }
  ],
  "dependencies": {
    "@raycast/api": "^2.0.5",
    "@raycast/utils": "^2.3.0"
  },
  "devDependencies": {
    "@raycast/eslint-config": "^2.2.0",
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "eslint": "^9.0.0",
    "prettier": "^3.0.0",
    "typescript": "^5.0.0"
  },
  "scripts": {
    "build": "ray build -e dist",
    "dev": "ray develop",
    "fix-lint": "ray lint --fix",
    "lint": "ray lint",
    "publish": "npx @raycast/api@latest publish"
  }
}
```

## Required Fields

### name

**Type:** `string`
**Description:** Unique identifier for the extension (lowercase, hyphens allowed)
**Example:** `"my-awesome-extension"`

### title

**Type:** `string`
**Description:** Human-readable extension name shown in Raycast
**Example:** `"My Awesome Extension"`

### description

**Type:** `string`
**Description:** Brief description of what the extension does
**Example:** `"Quickly search and manage your todos"`

### icon

**Type:** `string`
**Description:** Path to extension icon (512x512 PNG, in `assets/` folder)
**Example:** `"icon.png"`

### author

**Type:** `string`
**Description:** GitHub username of the primary author
**Example:** `"github-username"`

### platforms

**Type:** `("macOS" | "Windows")[]`
**Description:** Platforms the extension supports. Required at the top level
(in addition to the optional per-command `platforms` override documented
under [Command Properties](#platforms)).
**Example:** `["macOS", "Windows"]`

### categories

**Type:** `string[]`
**Description:** Categories for the Raycast Store. Official docs state only
"at least one category" — no documented maximum.
**Valid Values:**

- "Applications"
- "Communication"
- "Data"
- "Design Tools"
- "Developer Tools"
- "Documentation"
- "Finance"
- "Fun"
- "Media"
- "News"
- "Other"
- "Productivity"
- "Security"
- "System"
- "Web"

### license

**Type:** `string`
**Description:** Software license
**Example:** `"MIT"`

## Commands

Each command defines an entry point into your extension.

```json
{
  "commands": [
    {
      "name": "search-items",
      "title": "Search Items",
      "description": "Search through your items",
      "mode": "view",
      "arguments": [
        {
          "name": "query",
          "placeholder": "Search query",
          "type": "text",
          "required": false
        }
      ],
      "preferences": [
        {
          "name": "apiKey",
          "type": "password",
          "required": true,
          "title": "API Key",
          "description": "Your API key from the service"
        }
      ]
    }
  ]
}
```

### Command Properties

#### name (required)

**Type:** `string`
**Description:** Unique identifier matching the filename in `src/`
**Example:** `"search-items"` → `src/search-items.tsx`

#### title (required)

**Type:** `string`
**Description:** Display name in Raycast
**Example:** `"Search Items"`

#### description (required)

**Type:** `string`
**Description:** Brief description of the command
**Example:** `"Search through all your items"`

#### mode (required)

**Type:** `"view" | "no-view" | "menu-bar"`
**Description:** Command execution mode

- `"view"`: Renders a UI (List, Detail, Form, Grid)
- `"no-view"`: Background execution (shows HUD)
- `"menu-bar"`: Persistent menu bar item

#### icon

**Type:** `string`
**Description:** Command-specific icon (overrides extension icon)
**Example:** `"command-icon.png"`

#### keywords

**Type:** `string[]`
**Description:** Additional search keywords
**Example:** `["find", "lookup", "query"]`

#### interval

**Type:** `string` (for `no-view` or `menu-bar` commands)
**Description:** Update interval for the command
**Example:** `"5m"`, `"1h"`, `"30s"`

#### platforms

**Type:** `("macOS" | "Windows")[]`
**Description:** Platforms this command supports (added v1.103.0). Defaults to `["macOS"]`. Omit for macOS-only commands.
**Example:** `["macOS", "Windows"]`

## Arguments

Arguments allow users to pass data when launching commands.

```json
{
  "arguments": [
    {
      "name": "query",
      "placeholder": "Enter search term",
      "type": "text",
      "required": false
    },
    {
      "name": "priority",
      "placeholder": "Select priority",
      "type": "dropdown",
      "required": true,
      "data": [
        { "title": "Low", "value": "low" },
        { "title": "High", "value": "high" }
      ]
    }
  ]
}
```

### Argument Types

#### text

Free-form text input

```json
{
  "name": "query",
  "type": "text",
  "placeholder": "Enter text",
  "required": false
}
```

#### password

Obscured text input

```json
{
  "name": "secret",
  "type": "password",
  "placeholder": "Enter secret",
  "required": true
}
```

#### dropdown

Select from predefined options

```json
{
  "name": "option",
  "type": "dropdown",
  "required": true,
  "data": [
    { "title": "Option 1", "value": "opt1" },
    { "title": "Option 2", "value": "opt2" }
  ]
}
```

### Accessing Arguments

```typescript
import { LaunchProps } from "@raycast/api";

interface Arguments {
  query: string;
  priority: string;
}

export default function Command(props: LaunchProps<{ arguments: Arguments }>) {
  const { query, priority } = props.arguments;

  return <List searchText={query}>...</List>;
}
```

## Preferences

Preferences provide configuration options for users.

```json
{
  "preferences": [
    {
      "name": "apiKey",
      "type": "password",
      "required": true,
      "title": "API Key",
      "description": "Your API key from the service",
      "placeholder": "Enter your API key"
    },
    {
      "name": "theme",
      "type": "dropdown",
      "required": false,
      "title": "Theme",
      "description": "Color theme preference",
      "default": "light",
      "data": [
        { "title": "Light", "value": "light" },
        { "title": "Dark", "value": "dark" }
      ]
    },
    {
      "name": "enableNotifications",
      "type": "checkbox",
      "required": false,
      "title": "Enable Notifications",
      "description": "Show desktop notifications",
      "default": true,
      "label": "Enable"
    }
  ]
}
```

### Extension-Level vs Command-Level

```json
{
  "preferences": [
    // Extension-level: Available to all commands
    {
      "name": "apiToken",
      "type": "password",
      "required": true,
      "title": "API Token"
    }
  ],
  "commands": [
    {
      "name": "search",
      "title": "Search",
      "mode": "view",
      "preferences": [
        // Command-level: Only for this command
        {
          "name": "maxResults",
          "type": "textfield",
          "required": false,
          "title": "Max Results",
          "default": "10"
        }
      ]
    }
  ]
}
```

### Preference Types

- `textfield` - Single-line text
- `password` - Obscured text
- `checkbox` - Boolean toggle
- `dropdown` - Select from options
- `appPicker` - Select installed application
- `file` - File path picker
- `directory` - Directory path picker

### Accessing Preferences

```typescript
import { getPreferenceValues } from "@raycast/api";

interface Preferences {
  apiKey: string;
  theme: string;
  enableNotifications: boolean;
}

export default function Command() {
  const preferences = getPreferenceValues<Preferences>();

  console.log(preferences.apiKey);
  console.log(preferences.theme);

  return <List>...</List>;
}
```

## AI Extensions

`tools` is a **top-level manifest array**, separate from `ai` (which is
reserved for `instructions`/`evals`, optionally moved to a root `ai.yaml`).
Each tool entry needs `name` (required — maps implicitly to
`src/tools/<name>.ts`, no `file` property), `title` (required), `description`
(required), and an optional `icon`:

```json
{
  "tools": [
    {
      "name": "get-todos",
      "title": "Get Todos",
      "description": "Fetch the user's todo list"
    }
  ],
  "ai": {
    "instructions": "General instructions for the AI agent",
    "evals": [
      {
        "input": "@todo-list What are my todos?",
        "expected": [
          {
            "callsTool": "get-todos"
          }
        ]
      }
    ]
  }
}
```

See `references/ai-extensions.md` for detailed AI extension documentation.

## Contributors

For published extensions, list contributors:

```json
{
  "contributors": ["github-username-1", "github-username-2"]
}
```

## Owner

For organization-owned extensions:

```json
{
  "owner": "organization-name",
  "access": "public"
}
```

## External Dependencies

### Allowed Dependencies

List all npm dependencies:

```json
{
  "dependencies": {
    "@raycast/api": "^2.0.5",
    "@raycast/utils": "^2.3.0",
    "axios": "^1.4.0",
    "date-fns": "^2.30.0"
  }
}
```

### Binary Dependencies

If using external binaries, document download sources and verification:

```typescript
// Good: Download from official source with verification
async function ensureBinary() {
  const hash = "sha256-expected-hash";
  const url = "https://official-site.com/binary";

  // Download and verify hash
}
```

## Scripts

Standard scripts for Raycast extensions:

```json
{
  "scripts": {
    "build": "ray build -e dist",
    "dev": "ray develop",
    "fix-lint": "ray lint --fix",
    "lint": "ray lint",
    "publish": "npx @raycast/api@latest publish",
    "migrate": "npx @raycast/api@latest migrate"
  }
}
```

> `ray migrate` updates an existing extension to the latest `@raycast/api` version, applying any required code transforms automatically.

Requires Node.js ≥22.22.2, per `@raycast/api`'s `engines` field.

## Best Practices

### Naming

- Use lowercase with hyphens for `name`
- Use Title Case for `title` and command titles
- Be descriptive but concise

### Categories

- Choose the most relevant categories
- Don't use "Developer Tools" unless it's truly for developers

### Preferences

- Use `required: true` for essential configuration
- Provide clear `description` text
- Set sensible `default` values
- Use `password` type for sensitive data

### Icons

- Use 512x512 PNG format
- Place in `assets/` folder
- Use transparent background
- Follow Raycast icon guidelines

### Commands

- One command per file
- Use descriptive names
- Provide helpful descriptions
- Add relevant keywords for discoverability
