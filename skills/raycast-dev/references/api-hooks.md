# Raycast API Hooks

This reference covers React hooks provided by `@raycast/utils` for common extension tasks.

## Data Fetching Hooks

### useFetch

Simplifies HTTP requests with automatic loading and error states.

```typescript
import { useFetch } from "@raycast/utils";
import { List } from "@raycast/api";

interface Post {
  id: number;
  title: string;
}

export default function Command() {
  const { data, isLoading, error, revalidate } = useFetch<Post[]>(
    "https://api.example.com/posts",
    {
      headers: { "Authorization": "Bearer token" },
      // Optional configuration:
      parseResponse: async (response) => {
        const json = await response.json();
        return json.data;
      },
      initialData: [],
      keepPreviousData: true,
    }
  );

  if (error) {
    return <List><List.Item title={`Error: ${error.message}`} /></List>;
  }

  return (
    <List isLoading={isLoading}>
      {data?.map((post) => (
        <List.Item key={post.id} title={post.title} />
      ))}
    </List>
  );
}
```

**Return Values:**

- `data`: T | undefined - Fetched data
- `isLoading`: boolean - Loading state
- `error`: Error | undefined - Error if request failed
- `revalidate`: () => Promise<void> - Manually refresh data
- `mutate`: (data: T) => void - Update data optimistically

**Options:**

- `method`: string - HTTP method (default: "GET")
- `headers`: Record<string, string> - Request headers
- `body`: string | FormData - Request body
- `parseResponse`: (response: Response) => Promise<T> - Custom parser
- `keepPreviousData`: boolean - Keep previous data while revalidating
- `initialData`: T - Initial data before fetch
- `execute`: boolean - Whether to execute immediately (default: true)

### usePromise

Handle any async operation with loading and error states.

```typescript
import { usePromise } from "@raycast/utils";
import { List } from "@raycast/api";

async function fetchItems(query: string): Promise<string[]> {
  const response = await fetch(`https://api.example.com/search?q=${query}`);
  return response.json();
}

export default function Command() {
  const [searchText, setSearchText] = useState("");

  const { data, isLoading, error } = usePromise(
    fetchItems,
    [searchText],
    {
      // Optional configuration:
      execute: searchText.length > 0,
      onData: (data) => console.log("Fetched:", data),
      onError: (error) => console.error("Failed:", error),
    }
  );

  return (
    <List
      isLoading={isLoading}
      searchText={searchText}
      onSearchTextChange={setSearchText}
    >
      {data?.map((item, i) => (
        <List.Item key={i} title={item} />
      ))}
    </List>
  );
}
```

**Parameters:**

- `fn`: (...args: Args) => Promise<T> - Async function
- `args`: Args - Arguments to pass to function
- `options`: Options object

**Return Values:**

- `data`: T | undefined
- `isLoading`: boolean
- `error`: Error | undefined
- `revalidate`: () => Promise<void>
- `mutate`: (data: T) => void

### useCachedPromise

Like `usePromise` but with automatic caching across sessions.

```typescript
import { useCachedPromise } from "@raycast/utils";

const { data, isLoading } = useCachedPromise(fetchExpensiveData, [], {
  // Data cached and restored on next launch
  keepPreviousData: true,
});
```

## State Management Hooks

### useCachedState

State that persists across extension launches.

```typescript
import { useCachedState } from "@raycast/utils";

export default function Command() {
  const [count, setCount] = useCachedState<number>("counter", 0);

  return (
    <Detail
      markdown={`Count: ${count}`}
      actions={
        <ActionPanel>
          <Action
            title="Increment"
            onAction={() => setCount(count + 1)}
          />
        </ActionPanel>
      }
    />
  );
}
```

**Signature:**

```typescript
useCachedState<T>(
  key: string,
  initialValue: T
): [T, (value: T | ((prev: T) => T)) => void]
```

### useLocalStorage

Direct access to local storage with async operations.

```typescript
import { useLocalStorage } from "@raycast/utils";

const { value, setValue, isLoading, removeValue } = useLocalStorage<string>(
  "my-key",
  "default-value",
);
```

## Form Hooks

### useForm

Comprehensive form state management with validation.

```typescript
import { Form, ActionPanel, Action, showToast, Toast } from "@raycast/api";
import { useForm, FormValidation } from "@raycast/utils";

interface FormValues {
  name: string;
  email: string;
  age: string;
}

export default function Command() {
  const { handleSubmit, itemProps, values, setValue, focus, reset } = useForm<FormValues>({
    onSubmit: async (values) => {
      await showToast({ style: Toast.Style.Success, title: "Submitted!", message: values.name });
    },
    initialValues: {
      name: "",
      email: "",
      age: "",
    },
    validation: {
      name: FormValidation.Required,
      email: (value) => {
        if (!value) return "Required";
        if (!value.includes("@")) return "Invalid email";
      },
      age: (value) => {
        const num = parseInt(value || "");
        if (isNaN(num)) return "Must be a number";
        if (num < 0 || num > 120) return "Invalid age";
      },
    },
  });

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Submit" onSubmit={handleSubmit} />
          <Action title="Reset" onAction={() => reset()} />
        </ActionPanel>
      }
    >
      <Form.TextField title="Name" {...itemProps.name} />
      <Form.TextField title="Email" {...itemProps.email} />
      <Form.TextField title="Age" {...itemProps.age} />
    </Form>
  );
}
```

**Return Values:**

- `handleSubmit`: (values: T) => void - Submit handler
- `itemProps`: Props for form fields with validation
- `values`: T - Current form values
- `setValue`: (field: keyof T, value: any) => void - Update single field
- `setValidationError`: (field: keyof T, error: string) => void - Set error
- `focus`: (field: keyof T) => void - Focus field
- `reset`: (values?: Partial<T>) => void - Reset form

**Validation Utilities:**

- `FormValidation.Required` - Field must have value
- Custom functions: `(value) => string | undefined | null`

## System Integration Hooks

### useExec

Execute shell commands and capture output.

```typescript
import { useExec } from "@raycast/utils";
import { List } from "@raycast/api";

export default function Command() {
  const { stdout, stderr, isLoading, error } = useExec(
    "ls",
    ["-la", "/Users"],
    {
      shell: true,
      execute: true,
    }
  );

  return (
    <List isLoading={isLoading}>
      {stdout && <List.Item title={stdout} />}
      {error && <List.Item title={`Error: ${error.message}`} />}
    </List>
  );
}
```

**Parameters:**

- `command`: string - Command to execute
- `args`: string[] - Command arguments
- `options`: { shell?: boolean, execute?: boolean, ... }

**Return Values:**

- `stdout`: string - Standard output
- `stderr`: string - Standard error
- `isLoading`: boolean
- `error`: Error | undefined
- `revalidate`: () => void

### useSQL

Query SQLite databases directly.

```typescript
import { useSQL } from "@raycast/utils";
import { List } from "@raycast/api";

interface User {
  id: number;
  name: string;
}

export default function Command() {
  const { data, isLoading, error, permissionView } = useSQL<User>(
    "/path/to/database.db",
    "SELECT id, name FROM users WHERE active = 1"
  );

  if (permissionView) {
    return permissionView;
  }

  return (
    <List isLoading={isLoading}>
      {data?.map((user) => (
        <List.Item key={user.id} title={user.name} />
      ))}
    </List>
  );
}
```

**Common Database Paths:**

- Safari History: `~/Library/Safari/History.db`
- Chrome History: `~/Library/Application Support/Google/Chrome/Default/History`

## AI Hooks

### useAI

Integrate AI capabilities for text generation and processing.

```typescript
import { useAI } from "@raycast/utils";
import { Detail, ActionPanel, Action } from "@raycast/api";

export default function Command() {
  const { data, isLoading, revalidate } = useAI(
    "Translate 'Hello, world!' to French"
  );

  return (
    <Detail
      isLoading={isLoading}
      markdown={data || "Generating..."}
      actions={
        <ActionPanel>
          <Action title="Regenerate" onAction={revalidate} />
        </ActionPanel>
      }
    />
  );
}
```

## Utility Hooks

### useFrecencySorting

Sort items by frequency and recency (frecency).

```typescript
import { useFrecencySorting } from "@raycast/utils";
import { List, ActionPanel, Action } from "@raycast/api";

interface Item {
  id: string;
  title: string;
}

export default function Command() {
  const items: Item[] = [
    { id: "1", title: "Item A" },
    { id: "2", title: "Item B" },
  ];

  const { data: sortedItems, visitItem, resetRanking } = useFrecencySorting(
    items,
    {
      key: (item) => item.id,
      namespace: "my-items",
    }
  );

  return (
    <List>
      {sortedItems.map((item) => (
        <List.Item
          key={item.id}
          title={item.title}
          actions={
            <ActionPanel>
              <Action
                title="Select"
                onAction={() => {
                  visitItem(item); // Increase frecency score
                  console.log("Selected:", item.title);
                }}
              />
              <Action
                title="Reset Ranking"
                onAction={() => resetRanking(item)}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
```

### useStreamJSON

Stream and parse large JSON data sources.

```typescript
import { useStreamJSON } from "@raycast/utils";
import { List } from "@raycast/api";

export default function Command() {
  const { data, isLoading } = useStreamJSON<{ items: string[] }>(
    "https://api.example.com/large-dataset"
  );

  return (
    <List isLoading={isLoading}>
      {data?.items?.map((item, i) => (
        <List.Item key={i} title={item} />
      ))}
    </List>
  );
}
```

## Best Practices

### Error Handling

Always handle errors gracefully:

```typescript
const { data, error, isLoading } = useFetch(url);

if (error) {
  showToast({ style: Toast.Style.Failure, title: "Failed to fetch data", message: error.message });
}
```

### Loading States

Show loading indicators for better UX:

```typescript
<List isLoading={isLoading}>
  {/* items */}
</List>
```

### Data Revalidation

Provide manual refresh when needed:

```typescript
const { data, revalidate } = useFetch(url);

<Action
  title="Refresh"
  onAction={revalidate}
  shortcut={{ modifiers: ["cmd"], key: "r" }}
/>
```

### Dependencies

Pass dependencies correctly to prevent infinite loops:

```typescript
// ✅ Correct
const { data } = usePromise(fetchData, [searchQuery]);

// ❌ Incorrect - will cause infinite loop
const { data } = usePromise(fetchData, [new Date()]);
```
