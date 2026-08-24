---
name: raycast-dev
description: This skill should be used when the user asks to "create a Raycast extension", "build a Raycast plugin", "add a command to Raycast", "implement List/Detail/Form/Grid component", "use useFetch/useForm/usePromise hook", "debug Raycast error", "publish to Raycast Store", "create AI-powered Raycast extension", or mentions "@raycast/api" or "@raycast/utils". Provides expert guidance for building, maintaining, and publishing Raycast extensions with React and TypeScript.
allowed-tools: Read, Grep, Glob, Bash(ls:*), Bash(npm:*), Bash(ray:*)
effort: medium
---

# Authoring Raycast Extensions

## Overview

Provide expert guidance for building, maintaining, and publishing Raycast extensions using React, TypeScript, and the Raycast API. Support all extension types including standard commands, AI extensions, menu bar extensions, and script commands.

## Initial Discovery

Before beginning work, determine the current context by following this workflow:

### 1. Detect Current Working Directory

Check if currently in a Raycast extension directory:

```bash
# Look for Raycast extension indicators
ls -la package.json src/ assets/ 2>/dev/null
```

Indicators of a Raycast extension:

- `package.json` with `@raycast/api` dependency
- `src/` directory with `.tsx` files
- `assets/` directory with icon.png
- Commands defined in package.json

### 2. Identify Extension Type

If in an existing extension, analyze `package.json` to determine extension type:

**Standard Command Extension:**

```json
{
  "commands": [
    {
      "name": "search",
      "mode": "view", // ← Indicates standard command
      "title": "Search Items"
    }
  ]
}
```

**AI Extension:**

```json
{
  "ai": { "instructions": "..." },  // ← Indicates AI extension
  "tools": [...]  // top-level, not nested inside "ai"
}
```

**Menu Bar Extension:**

```json
{
  "commands": [
    {
      "name": "status",
      "mode": "menu-bar", // ← Indicates menu bar extension
      "interval": "5m"
    }
  ]
}
```

**No-View Command:**

```json
{
  "commands": [
    {
      "name": "action",
      "mode": "no-view" // ← Background command
    }
  ]
}
```

### 3. Understand User Intent

When the user requests changes, clarify:

- **For new extensions**: Ask about extension type if not specified
- **For existing extensions**: Analyze current structure and propose changes
- **For feature additions**: Determine if adding new command or enhancing existing one
- **For debugging**: Identify error messages and relevant code sections

## Core Workflows

### Creating a New Extension

When creating a new extension from scratch:

#### Step 1: Initialize Extension

Use the Raycast CLI to scaffold the extension:

```bash
npm create raycast-extension@latest
```

This prompts for:

- Extension name
- Extension description
- Author information
- Initial command name
- Template type (TypeScript, AI extension, etc.)

**Alternative: Manual setup** for more control over structure.

#### Step 2: Configure Manifest

Edit `package.json` to define extension metadata, commands, and preferences. Reference `references/manifest-schema.md` for complete manifest documentation.

**Key sections:**

- Extension metadata (name, title, description, icon, categories)
- Commands array (define entry points)
- Preferences (user configuration)
- Dependencies (@raycast/api, @raycast/utils)
- AI configuration (if building AI extension)

#### Step 3: Implement Commands

Create command files in `src/` directory:

**For List-based commands:**

```typescript
import { List } from "@raycast/api";

export default function Command() {
  return (
    <List>
      <List.Item title="Item 1" />
      <List.Item title="Item 2" />
    </List>
  );
}
```

See `references/api-components.md` for all available components (List, Detail, Form, Grid).

**For data fetching:**

```typescript
import { List } from "@raycast/api";
import { useFetch } from "@raycast/utils";

export default function Command() {
  const { data, isLoading } = useFetch("https://api.example.com/data");

  return (
    <List isLoading={isLoading}>
      {data?.map(item => (
        <List.Item key={item.id} title={item.title} />
      ))}
    </List>
  );
}
```

See `references/api-hooks.md` for all available hooks (useFetch, useForm, usePromise, etc.).

#### Step 4: Test Locally

Run the development server:

```bash
npm run dev
```

This launches the extension in Raycast for immediate testing.

### Adding Features to Existing Extensions

When enhancing an existing extension:

#### Step 1: Analyze Current Structure

Examine the existing codebase:

```bash
# Read package.json to understand commands and configuration
cat package.json

# List source files
ls -la src/

# Check for utilities, components, hooks
ls -la src/utils/ src/components/ src/hooks/ 2>/dev/null
```

#### Step 2: Determine Change Type

**Adding a New Command:**

1. Create new file in `src/`: `src/new-command.tsx`
2. Add command to `package.json`:

```json
{
  "commands": [
    {
      "name": "new-command",
      "title": "New Command",
      "description": "Description of what this does",
      "mode": "view"
    }
  ]
}
```

3. Implement command following existing patterns
4. Share utilities/components with existing commands

**Enhancing Existing Command:**

1. Locate the command file (e.g., `src/search.tsx`)
2. Read the existing implementation
3. Propose changes that maintain consistency with existing code
4. Preserve existing functionality unless explicitly asked to change it

**Adding AI Tools (for AI extensions):**

1. Create tool file in `src/tools/`: `src/tools/new-tool.ts`
2. Add tool to the manifest's top-level `tools` array (not nested inside
   `ai`); `name` implicitly maps to `src/tools/<name>.ts`, so no `file`
   property is needed:

```json
{
  "tools": [
    {
      "name": "new-tool",
      "title": "New Tool",
      "description": "What this tool does"
    }
  ]
}
```

3. Implement tool function with proper TypeScript types
4. Add eval tests for the new tool

See `references/ai-extensions.md` for comprehensive AI extension documentation.

#### Step 3: Follow Existing Patterns

Maintain consistency:

- **Code style**: Match existing formatting, naming conventions
- **Component patterns**: Use same UI components as existing commands
- **Data fetching**: Use same hooks and patterns
- **Error handling**: Follow existing error handling approach
- **TypeScript types**: Add to existing types files or create new ones

#### Step 4: Test Changes

```bash
npm run dev
```

Verify:

- New features work as expected
- Existing features still work
- No TypeScript errors
- No linting errors (`npm run lint`)

### Debugging and Fixing Issues

When resolving errors:

#### Step 1: Identify Error Type

**TypeScript Errors:**

- Check type definitions
- Verify imports from @raycast/api
- Ensure proper typing of LaunchProps, preferences, arguments

**Runtime Errors:**

- Check console output in Raycast
- Verify API responses
- Check async/await usage
- Validate data transformations

**Build Errors:**

- Run `npm run build` to see detailed errors
- Check for missing dependencies
- Verify tsconfig.json configuration

#### Step 2: Common Issues and Solutions

**Hook Errors:**

```typescript
// ❌ Problem: Hooks in conditional
if (condition) {
  const { data } = useFetch(url); // Error!
}

// ✅ Solution: Hooks at top level
const { data } = useFetch(url, { execute: condition });
```

**Form Validation:**

```typescript
// Use useForm hook for validation
import { useForm, FormValidation } from "@raycast/utils";

const { handleSubmit, itemProps } = useForm({
  onSubmit: async (values) => {
    /* ... */
  },
  validation: {
    email: FormValidation.Required,
    name: (value) => (value ? undefined : "Required"),
  },
});
```

**Error Handling:**

```typescript
// Always show errors to users via Toast
useEffect(() => {
  if (error) {
    showToast({
      style: Toast.Style.Failure,
      title: "Failed to load",
      message: error.message,
    });
  }
}, [error]);
```

See `references/best-practices.md` for comprehensive patterns and solutions.

### Publishing Extensions

When preparing for publication:

#### Step 1: Pre-Publication Checklist

- [ ] Run `npm run build` successfully
- [ ] Run `npm run lint` with no errors
- [ ] Test all commands thoroughly
- [ ] Add README.md with setup instructions
- [ ] Add CHANGELOG.md with version history
- [ ] Verify icon is 512x512 PNG
- [ ] Remove console.log statements
- [ ] Set required preferences appropriately
- [ ] Test with empty/invalid preferences

#### Step 2: Publish Command

For public extensions:

```bash
npm run publish
```

This will:

1. Validate extension
2. Build extension
3. Create pull request to raycast/extensions repository

For private/team extensions, follow team-specific workflow documented in Raycast Teams documentation.

## Extension Type Patterns

### Standard Command Extensions

Most common type. Uses React components to render UI.

**Key Components:**

- `List` - For searchable, filterable lists
- `Detail` - For rich content with markdown
- `Form` - For user input with validation
- `Grid` - For image/icon grids

**Common Hooks:**

- `useFetch` - HTTP requests
- `usePromise` - Async operations
- `useForm` - Form state and validation
- `useCachedState` - Persistent state

**Typical Structure:**

```typescript
import { List, ActionPanel, Action } from "@raycast/api";
import { useFetch } from "@raycast/utils";

export default function Command() {
  const { data, isLoading } = useFetch<Item[]>(API_URL);

  return (
    <List isLoading={isLoading}>
      {data?.map(item => (
        <List.Item
          key={item.id}
          title={item.title}
          actions={
            <ActionPanel>
              <Action.OpenInBrowser url={item.url} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
```

### AI Extensions

Natural language interface powered by AI tools.

**Key Concepts:**

- **Tools**: Functions the AI can call (e.g., get-todos, create-item)
- **Instructions**: Context for the AI about how to behave
- **Evals**: Test cases to verify AI behavior

**Typical Tool:**

```typescript
// src/tools/get-items.ts
type Input = {
  /** Filter items by status */
  status?: "active" | "archived";
};

export default async function getItems(input: Input) {
  const items = await fetchItems(input.status);
  return { items, total: items.length };
}
```

**Manifest Configuration:**

```json
{
  "ai": {
    "instructions": "Help users manage their items. Always confirm before deleting.",
    "evals": [...]
  },
  "tools": [
    {
      "name": "get-items",
      "title": "Get Items",
      "description": "Fetch items with optional status filter"
    }
  ]
}
```

See `references/ai-extensions.md` for complete AI extension documentation.

### Menu Bar Extensions

Persistent icons in the macOS menu bar with dropdown content.

**Key Properties:**

- `mode: "menu-bar"` in manifest
- `interval` for periodic updates
- Lightweight, efficient rendering

**Typical Structure:**

```typescript
import { MenuBarExtra } from "@raycast/api";

export default function Command() {
  return (
    <MenuBarExtra icon="icon.png" tooltip="Status">
      <MenuBarExtra.Item title="Item 1" onAction={() => {}} />
      <MenuBarExtra.Item title="Item 2" onAction={() => {}} />
    </MenuBarExtra>
  );
}
```

### No-View Commands

Background commands that execute without UI (show HUD instead).

**Use Cases:**

- Quick actions (copy to clipboard, trigger automation)
- Background processing
- System integrations

**Typical Structure:**

```typescript
import { showHUD } from "@raycast/api";

export default async function Command() {
  await performAction();
  await showHUD("Action completed!");
}
```

## References

See `references/` for detailed documentation:

- `api-components.md` - UI components (List, Detail, Form, Grid)
- `api-hooks.md` - React hooks from @raycast/utils
- `manifest-schema.md` - package.json configuration
- `ai-extensions.md` - AI extension tools and evals
- `best-practices.md` - Patterns and publishing checklist

## Development Commands

Standard Raycast extension commands:

```bash
# Development mode (live reload)
npm run dev

# Build for production
npm run build

# Lint code
npm run lint

# Fix lint issues
npm run fix-lint

# Publish to store
npm run publish

# Run AI extension evals
npm run evals
```

## Tips for Effective Extension Development

1. **Start with templates**: Use `npm create raycast-extension` for best practices out of the box

2. **Follow existing patterns**: When adding to existing extensions, match the current code style

3. **Use TypeScript strictly**: Define interfaces for all data structures

4. **Handle errors gracefully**: Always show Toast notifications for errors

5. **Test incrementally**: Use `npm run dev` frequently to catch issues early

6. **Leverage hooks**: Use @raycast/utils hooks instead of reinventing state management

7. **Read the references**: Load reference docs when implementing specific features

8. **Keep it simple**: Start with basic functionality, iterate based on user feedback

9. **Follow the checklist**: Use the publishing checklist before submitting extensions

10. **For AI extensions**: Start with simple tools, add evals early, iterate on instructions
