# Raycast API Components

This reference covers the core UI components available in the Raycast API.

## Core Components

### List

The most common component for displaying searchable, filtable items.

```typescript
import { List } from "@raycast/api";

export default function Command() {
  return (
    <List>
      <List.Item
        title="Item Title"
        subtitle="Optional subtitle"
        accessories={[{ text: "Accessory" }]}
        icon="icon.png"
      />
    </List>
  );
}
```

**Key Props:**

- `isLoading`: boolean - Show loading indicator
- `searchBarPlaceholder`: string - Placeholder text for search
- `filtering`: boolean | { keepSectionOrder: boolean } - Enable/configure filtering
- `navigationTitle`: string - Title shown in navigation
- `searchText`: string - Controlled search text
- `onSearchTextChange`: (text: string) => void - Search change handler
- `throttle`: boolean - Adds 200ms debounce to `onSearchTextChange` (avoids hand-rolling timers)
- `pagination`: { onLoadMore: () => void; hasMore: boolean; pageSize?: number } - Enables infinite scroll (pair with `usePromise` pagination support)

**List.Item Props:**

- `title`: string (required) - Main text
- `subtitle`: string - Secondary text
- `accessories`: List.Item.Accessory[] - Right-aligned metadata
- `icon`: Image.ImageLike - Left icon
- `keywords`: string[] - Additional search keywords
- `actions`: ActionPanel - Available actions

**List Sections:**

```typescript
<List>
  <List.Section title="Section Title">
    <List.Item title="Item 1" />
    <List.Item title="Item 2" />
  </List.Section>
</List>
```

### Detail

Component for displaying rich markdown content and metadata.

```typescript
import { Detail } from "@raycast/api";

export default function Command() {
  return (
    <Detail
      markdown="# Hello World\n\nThis is **markdown** content."
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="Name" text="John Doe" />
          <Detail.Metadata.Link title="Website" text="example.com" target="https://example.com" />
          <Detail.Metadata.TagList title="Tags">
            <Detail.Metadata.TagList.Item text="Important" color="#FF0000" />
          </Detail.Metadata.TagList>
          <Detail.Metadata.Separator />
        </Detail.Metadata>
      }
    />
  );
}
```

**Key Props:**

- `markdown`: string - Markdown content to display (supports CommonMark, GFM, and LaTeX math via `$...$` / `$$...$$` syntax as of v1.81.0)
- `isLoading`: boolean - Show loading indicator
- `metadata`: Detail.Metadata - Structured metadata panel
- `navigationTitle`: string - Title shown in navigation
- `actions`: ActionPanel - Available actions

**Metadata Components:**

- `Detail.Metadata.Label` - Key-value pair
- `Detail.Metadata.Link` - Clickable link
- `Detail.Metadata.TagList` - Collection of colored tags
- `Detail.Metadata.Separator` - Visual separator

### Form

Component for collecting user input with validation.

```typescript
import { Form, Action, ActionPanel } from "@raycast/api";
import { useForm, FormValidation } from "@raycast/utils";

interface FormValues {
  name: string;
  email: string;
  message: string;
}

export default function Command() {
  const { handleSubmit, itemProps } = useForm<FormValues>({
    onSubmit(values) {
      console.log("Submitted:", values);
    },
    validation: {
      name: FormValidation.Required,
      email: (value) => {
        if (!value?.includes("@")) {
          return "Invalid email";
        }
      },
    },
  });

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Submit" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        title="Name"
        placeholder="Enter name"
        {...itemProps.name}
      />
      <Form.TextField
        title="Email"
        placeholder="user@example.com"
        {...itemProps.email}
      />
      <Form.TextArea
        title="Message"
        placeholder="Your message"
        {...itemProps.message}
      />
      <Form.Dropdown title="Priority" {...itemProps.priority}>
        <Form.Dropdown.Item value="low" title="Low" />
        <Form.Dropdown.Item value="high" title="High" />
      </Form.Dropdown>
      <Form.DatePicker title="Due Date" {...itemProps.dueDate} />
      <Form.Checkbox
        label="Agree to terms"
        {...itemProps.agreed}
      />
    </Form>
  );
}
```

**Form Field Components:**

- `Form.TextField` - Single-line text input
- `Form.TextArea` - Multi-line text input
- `Form.PasswordField` - Password input (obscured)
- `Form.Dropdown` - Select from options
- `Form.DatePicker` - Date/time selection
- `Form.Checkbox` - Boolean checkbox
- `Form.Separator` - Visual separator
- `Form.Description` - Help text

**Common Field Props:**

- `id`: string - Unique identifier
- `title`: string - Field label
- `placeholder`: string - Placeholder text
- `error`: string - Validation error message
- `onChange`: (value) => void - Change handler
- `onBlur`: (event) => void - Blur handler

### Grid

Component for displaying items in a grid layout (good for images/icons).

```typescript
import { Grid } from "@raycast/api";

export default function Command() {
  return (
    <Grid columns={4}>
      <Grid.Item
        content="https://via.placeholder.com/150"
        title="Image 1"
        subtitle="Description"
      />
      <Grid.Item
        content={{ source: "local-icon.png" }}
        title="Image 2"
      />
    </Grid>
  );
}
```

**Key Props:**

- `columns`: number - Number of columns (1-8)
- `fit`: Grid.Fit - How items fit in cells ("contain" | "fill")
- `aspectRatio`: string - Aspect ratio (e.g., "16/9")
- `isLoading`: boolean - Show loading indicator

### ActionPanel

Container for actions available on selected items.

```typescript
import { ActionPanel, Action, List } from "@raycast/api";

export default function Command() {
  return (
    <List>
      <List.Item
        title="Item"
        actions={
          <ActionPanel>
            <ActionPanel.Section title="Primary Actions">
              <Action.OpenInBrowser url="https://example.com" />
              <Action.CopyToClipboard content="Text to copy" />
            </ActionPanel.Section>
            <ActionPanel.Section title="Secondary">
              <Action.Push
                title="Show Details"
                target={<DetailView />}
              />
              <Action
                title="Custom Action"
                onAction={() => console.log("Action!")}
              />
            </ActionPanel.Section>
          </ActionPanel>
        }
      />
    </List>
  );
}
```

**Built-in Actions:**

- `Action.OpenInBrowser` - Open URL in browser
- `Action.CopyToClipboard` - Copy to clipboard
- `Action.Paste` - Paste to frontmost app
- `Action.Push` - Navigate to new view
- `Action.SubmitForm` - Submit form
- `Action.OpenWith` - Open file with app
- `Action.ShowInFinder` - Reveal file in Finder
- `Action.CreateQuicklink` - Create Raycast quicklink
- `Action.InstallMCPServer` - Install an MCP server into Raycast (added v1.98.0)

> Note: Navigation back is handled via `useNavigation().pop()` or the ESC key, not a dedicated `Action.Pop`.

**Custom Actions:**

```typescript
<Action
  title="Do Something"
  icon={Icon.Star}
  shortcut={{ modifiers: ["cmd"], key: "s" }}
  onAction={async () => {
    // Perform action
    await showToast({ style: Toast.Style.Success, title: "Done!" });
  }}
/>
```

## Navigation

### useNavigation Hook

Programmatically control navigation between views.

```typescript
import { useNavigation } from "@raycast/api";

function MyComponent() {
  const { push, pop } = useNavigation();

  return (
    <Detail
      markdown="Content"
      actions={
        <ActionPanel>
          <Action
            title="Go Forward"
            onAction={() => push(<NextView />)}
          />
          <Action
            title="Go Back"
            onAction={pop}
          />
        </ActionPanel>
      }
    />
  );
}
```

## Icons and Images

### Built-in Icons

```typescript
import { Icon } from "@raycast/api";

<List.Item icon={Icon.Star} title="Item" />
```

### Custom Images

```typescript
// Local asset
<List.Item icon="icon.png" title="Item" />

// URL (cached automatically)
<List.Item
  icon={{ source: "https://example.com/icon.png" }}
  title="Item"
/>

// With tint color
<List.Item
  icon={{ source: Icon.Circle, tintColor: "#FF0000" }}
  title="Item"
/>
```

## Feedback Components

### Toast Notifications

```typescript
import { showToast, Toast } from "@raycast/api";

await showToast({
  style: Toast.Style.Success,
  title: "Success!",
  message: "Operation completed",
});

// Styles: Success, Failure, Animated (for loading)
```

### HUD (Heads-Up Display)

```typescript
import { showHUD } from "@raycast/api";

await showHUD("Copied to clipboard!");
```

### Alerts

```typescript
import { confirmAlert, Alert } from "@raycast/api";

const confirmed = await confirmAlert({
  title: "Delete Item?",
  message: "This action cannot be undone.",
  primaryAction: {
    title: "Delete",
    style: Alert.ActionStyle.Destructive,
  },
});
```
