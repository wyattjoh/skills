# Raycast Extension Best Practices

This reference covers patterns, conventions, and best practices for building high-quality Raycast extensions.

## Project Structure

### Recommended Layout

```
my-extension/
├── .eslintrc.json
├── .prettierrc
├── assets/
│   ├── icon.png              # 512x512 PNG
│   └── command-icon.png      # Optional command-specific icons
├── src/
│   ├── index.tsx             # Main command
│   ├── another-command.tsx   # Additional commands
│   ├── components/           # Reusable React components
│   │   ├── ItemList.tsx
│   │   └── DetailView.tsx
│   ├── hooks/                # Custom React hooks
│   │   ├── useItems.ts
│   │   └── useSearch.ts
│   ├── utils/                # Utility functions
│   │   ├── api.ts
│   │   └── storage.ts
│   ├── types/                # TypeScript type definitions
│   │   └── index.ts
│   └── tools/                # AI extension tools (if applicable)
│       ├── get-items.ts
│       └── create-item.ts
├── package.json
├── tsconfig.json
└── README.md
```

## TypeScript Best Practices

### Type Safety

Always define interfaces for your data:

```typescript
// ✅ Good: Strongly typed
interface Todo {
  id: string;
  title: string;
  completed: boolean;
  createdAt: string;
}

export default function Command() {
  const [todos, setTodos] = useState<Todo[]>([]);
  // ...
}

// ❌ Bad: Using any
const [todos, setTodos] = useState<any[]>([]);
```

### LaunchProps Typing

Properly type your command props:

```typescript
import { LaunchProps } from "@raycast/api";

interface Arguments {
  query: string;
  priority?: string;
}

interface Preferences {
  apiKey: string;
  theme: "light" | "dark";
}

export default function Command(
  props: LaunchProps<{ arguments: Arguments; preferences: Preferences }>,
) {
  const { query, priority } = props.arguments;
  const { apiKey, theme } = props.preferences;
  // ...
}
```

### Avoid Optional Chaining Abuse

```typescript
// ✅ Good: Handle undefined explicitly
const title = item?.title || "Untitled";

// ❌ Bad: Excessive optional chaining
const value = obj?.prop1?.prop2?.prop3?.prop4;
```

## Error Handling

### Toast Notifications

Show errors gracefully to users:

```typescript
import { showToast, Toast, List } from "@raycast/api";
import { useEffect, useState } from "react";

export default function Command() {
  const [error, setError] = useState<Error>();
  const [items, setItems] = useState<Item[]>([]);

  useEffect(() => {
    fetchItems()
      .then(setItems)
      .catch(setError);
  }, []);

  useEffect(() => {
    if (error) {
      showToast({
        style: Toast.Style.Failure,
        title: "Failed to load items",
        message: error.message,
      });
    }
  }, [error]);

  return <List isLoading={!items.length && !error}>...</List>;
}
```

### Try-Catch in Actions

```typescript
import { Action, showToast, Toast } from "@raycast/api";

<Action
  title="Delete Item"
  onAction={async () => {
    try {
      await deleteItem(item.id);
      await showToast({
        style: Toast.Style.Success,
        title: "Item deleted",
      });
      revalidate(); // Refresh data
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to delete",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }}
/>
```

### Validation

Validate user input in forms:

```typescript
import { useForm, FormValidation } from "@raycast/utils";

const { handleSubmit, itemProps } = useForm<FormValues>({
  onSubmit: async (values) => {
    // Process form
  },
  validation: {
    email: (value) => {
      if (!value) return "Email is required";
      if (!value.includes("@")) return "Invalid email format";
    },
    age: (value) => {
      const num = parseInt(value || "");
      if (isNaN(num)) return "Must be a number";
      if (num < 0 || num > 150) return "Invalid age";
    },
  },
});
```

## React Patterns

### Hooks Rules

Follow React hooks rules:

```typescript
// ✅ Good: Hooks at top level
export default function Command() {
  const [state, setState] = useState();
  const { data, isLoading } = useFetch(url);

  return <List>...</List>;
}

// ❌ Bad: Conditional hooks
export default function Command() {
  if (condition) {
    const [state, setState] = useState(); // ❌ Never do this
  }
}
```

### Custom Hooks

Extract reusable logic:

```typescript
// hooks/useItems.ts
function useItems() {
  const { data, isLoading, error, revalidate } = useFetch<Item[]>(API_URL);

  const deleteItem = async (id: string) => {
    await fetch(`${API_URL}/${id}`, { method: "DELETE" });
    await revalidate();
  };

  return {
    items: data || [],
    isLoading,
    error,
    deleteItem,
    refresh: revalidate,
  };
}

// In component
export default function Command() {
  const { items, isLoading, deleteItem } = useItems();
  // ...
}
```

### Memoization

Use useMemo for expensive computations:

```typescript
import { useMemo } from "react";

export default function Command() {
  const [searchText, setSearchText] = useState("");
  const { data: items } = useFetch<Item[]>(API_URL);

  const filteredItems = useMemo(() => {
    if (!searchText) return items;
    return items?.filter((item) =>
      item.title.toLowerCase().includes(searchText.toLowerCase())
    );
  }, [items, searchText]);

  return <List searchText={searchText} onSearchTextChange={setSearchText}>
    {filteredItems?.map((item) => (
      <List.Item key={item.id} title={item.title} />
    ))}
  </List>;
}
```

## Performance

### Loading States

Always show loading indicators:

```typescript
const { data, isLoading } = useFetch(url);

return <List isLoading={isLoading}>
  {data?.map((item) => <List.Item key={item.id} title={item.title} />)}
</List>;
```

### Pagination

For large lists, use the built-in `pagination` prop on `List`/`Grid` paired with `usePromise`'s pagination support (added v1.69.0):

```typescript
import { List } from "@raycast/api";
import { usePromise } from "@raycast/utils";

async function fetchPage(options: { page: number }) {
  const res = await fetch(`${API_URL}?page=${options.page}&limit=50`);
  const data = await res.json();
  return { data: data.items, hasMore: data.hasMore };
}

export default function Command() {
  const { data, isLoading, pagination } = usePromise(fetchPage, [], {
    keepPreviousData: true,
  });

  return (
    <List isLoading={isLoading} pagination={pagination}>
      {data?.map((item) => (
        <List.Item key={item.id} title={item.title} />
      ))}
    </List>
  );
}
```

### Debouncing Search

Use the built-in `throttle` prop on `List` (or `Grid`) to debounce `onSearchTextChange`. This avoids hand-rolling timers:

```typescript
export default function Command() {
  const [searchText, setSearchText] = useState("");

  const { data, isLoading } = useFetch(
    `${API_URL}?q=${encodeURIComponent(searchText)}`
  );

  return (
    <List
      isLoading={isLoading}
      throttle
      searchText={searchText}
      onSearchTextChange={setSearchText}
    >
      {/* items */}
    </List>
  );
}
```

## Data Management

### Local Storage

Use LocalStorage for persistence:

```typescript
import { LocalStorage } from "@raycast/api";

// Save
await LocalStorage.setItem("todos", JSON.stringify(todos));

// Load
const stored = await LocalStorage.getItem<string>("todos");
const todos = stored ? JSON.parse(stored) : [];

// Remove
await LocalStorage.removeItem("todos");

// Clear all
await LocalStorage.clear();
```

### Caching

Leverage useCachedState for automatic caching:

```typescript
import { useCachedState } from "@raycast/utils";

export default function Command() {
  const [favorites, setFavorites] = useCachedState<string[]>("favorite-items", []);

  // State persists across launches
}
```

## API Integration

### Authentication

Handle API tokens securely:

```typescript
import { getPreferenceValues } from "@raycast/api";

interface Preferences {
  apiToken: string;
}

async function fetchData() {
  const { apiToken } = getPreferenceValues<Preferences>();

  const response = await fetch(API_URL, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Invalid API token. Please check your preferences.");
    }
    throw new Error(`API error: ${response.statusText}`);
  }

  return response.json();
}
```

### Rate Limiting

Respect API rate limits:

```typescript
class RateLimiter {
  private lastRequest = 0;
  private minInterval = 1000; // 1 second between requests

  async throttle() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequest;

    if (timeSinceLastRequest < this.minInterval) {
      await new Promise((resolve) => setTimeout(resolve, this.minInterval - timeSinceLastRequest));
    }

    this.lastRequest = Date.now();
  }
}

const limiter = new RateLimiter();

async function fetchData() {
  await limiter.throttle();
  return fetch(API_URL);
}
```

## UI/UX Best Practices

### Empty States

Provide helpful empty states:

```typescript
<List isLoading={isLoading}>
  {items.length === 0 ? (
    <List.EmptyView
      icon={Icon.Document}
      title="No Items Found"
      description="Try adding a new item to get started"
      actions={
        <ActionPanel>
          <Action.Push title="Add Item" target={<AddItemForm />} />
        </ActionPanel>
      }
    />
  ) : (
    items.map((item) => <List.Item key={item.id} title={item.title} />)
  )}
</List>
```

### Keyboard Shortcuts

Add intuitive shortcuts:

```typescript
<ActionPanel>
  <Action.Push
    title="View Details"
    target={<DetailView item={item} />}
    shortcut={{ modifiers: ["cmd"], key: "d" }}
  />
  <Action.CopyToClipboard
    content={item.url}
    shortcut={{ modifiers: ["cmd"], key: "c" }}
  />
  <Action
    title="Refresh"
    onAction={refresh}
    shortcut={{ modifiers: ["cmd"], key: "r" }}
  />
</ActionPanel>
```

### Accessories

Use accessories for metadata:

```typescript
<List.Item
  title={item.title}
  subtitle={item.description}
  accessories={[
    { text: item.createdAt, icon: Icon.Calendar },
    { tag: { value: item.status, color: getStatusColor(item.status) } },
    { icon: item.isStarred ? Icon.Star : undefined },
  ]}
/>
```

## Code Quality

### Linting

Run lint before committing:

```bash
npm run lint
npm run fix-lint  # Auto-fix issues
```

### Naming Conventions

```typescript
// Components: PascalCase
function ItemList() {}

// Hooks: camelCase with 'use' prefix
function useItems() {}

// Utilities: camelCase
function formatDate() {}

// Constants: UPPER_SNAKE_CASE
const API_BASE_URL = "https://api.example.com";

// Types/Interfaces: PascalCase
interface TodoItem {}
type Status = "pending" | "completed";
```

### File Organization

```typescript
// ✅ Good: Organized imports
import { List, ActionPanel, Action } from "@raycast/api";
import { useFetch } from "@raycast/utils";
import { useState } from "react";

import { formatDate } from "./utils";
import { API_URL } from "./constants";
import type { Item } from "./types";

// ❌ Bad: Random import order
import { formatDate } from "./utils";
import { List } from "@raycast/api";
import type { Item } from "./types";
import { useState } from "react";
```

## Testing

### Manual Testing

Test these scenarios:

- Empty states
- Loading states
- Error states
- Keyboard shortcuts
- Different screen sizes
- Preferences changes

### Edge Cases

Handle edge cases:

```typescript
// Empty strings
const title = item.title?.trim() || "Untitled";

// Null/undefined
const count = items?.length ?? 0;

// Invalid dates
const date = item.date ? new Date(item.date) : null;
if (date && !isNaN(date.getTime())) {
  // Valid date
}

// Network failures
try {
  await fetch(url);
} catch (error) {
  if (error instanceof TypeError) {
    // Network error
  }
}
```

## Publishing Checklist

Before publishing:

- [ ] Run `npm run build` successfully
- [ ] Run `npm run lint` with no errors
- [ ] Test all commands
- [ ] Test with empty/invalid preferences
- [ ] Add README.md with:
  - Description
  - Setup instructions
  - Screenshots (optional but recommended)
  - Features list
- [ ] Add CHANGELOG.md
- [ ] Verify icon is 512x512 PNG
- [ ] Check all dependencies are necessary
- [ ] Remove console.log statements
- [ ] Test on a fresh install (remove from Raycast and reinstall)

## Common Pitfalls

### Don't Use Index as Key

```typescript
// ❌ Bad
{items.map((item, index) => (
  <List.Item key={index} title={item.title} />
))}

// ✅ Good
{items.map((item) => (
  <List.Item key={item.id} title={item.title} />
))}
```

### Handle Async Properly

```typescript
// ❌ Bad: Missing await
async function saveItem() {
  LocalStorage.setItem("key", "value"); // Forgot await!
}

// ✅ Good
async function saveItem() {
  await LocalStorage.setItem("key", "value");
}
```

### Cleanup Effects

```typescript
useEffect(() => {
  const timer = setTimeout(() => {
    // Do something
  }, 1000);

  // ✅ Good: Cleanup
  return () => clearTimeout(timer);
}, []);
```

### Don't Mutate State

```typescript
// ❌ Bad: Mutating state
const addItem = (item) => {
  items.push(item);
  setItems(items);
};

// ✅ Good: Immutable update
const addItem = (item) => {
  setItems([...items, item]);
};
```

## Security

### Sensitive Data

- Use `password` type for API keys in preferences
- Never log sensitive information
- Use HTTPS for all API calls
- Validate all user input

### Safe HTML/Markdown

```typescript
// Markdown in Detail is safe (automatically sanitized)
<Detail markdown={`# ${userInput}`} />

// Be careful with user-generated URLs
const url = validateURL(userInput);
<Action.OpenInBrowser url={url} />
```

## Accessibility

### Meaningful Titles

```typescript
// ✅ Good: Descriptive titles
<List.Item title="Email: user@example.com" />

// ❌ Bad: Generic titles
<List.Item title="Item 1" />
```

### Icons with Context

```typescript
// Use icons that convey meaning
<List.Item
  icon={item.completed ? Icon.Checkmark : Icon.Circle}
  title={item.title}
/>
```

### Form Labels

```typescript
// Always provide labels for form fields
<Form.TextField
  title="Email Address"  // ✅
  placeholder="user@example.com"
  {...itemProps.email}
/>
```
