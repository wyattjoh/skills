# Raycast AI Extensions

This reference covers building AI-powered extensions with tools, evals, and agent capabilities.

## Overview

AI Extensions allow you to create natural language interfaces for your commands. Instead of clicking through UI, users can describe what they want in plain English, and the AI agent uses your tools to accomplish the task.

**Example:**

```
User: "@todo-list Mark 'Buy groceries' as done"
AI: Uses the `mark-todo-complete` tool with the correct todo ID
```

## Core Concepts

### 1. Tools

Tools are functions that the AI can call to interact with your system. Each tool is a TypeScript file that exports a function.

**Basic Tool Structure:**

```typescript
// src/tools/get-todos.ts
export default async function getTodos() {
  const todos = await fetchTodosFromStorage();
  return todos;
}
```

**Tool with Input:**

```typescript
// src/tools/mark-complete.ts
type Input = {
  /** The ID of the todo to mark as complete */
  todoId: string;
};

export default async function markComplete(input: Input) {
  await updateTodo(input.todoId, { completed: true });
  return { success: true, message: `Todo ${input.todoId} marked complete` };
}
```

**Tool with Confirmation:**

```typescript
// src/tools/delete-todo.ts
import { Tool } from "@raycast/api";

type Input = {
  todoId: string;
};

export const confirmation: Tool.Confirmation<Input> = (input) => {
  return {
    message: `Are you sure you want to delete todo ${input.todoId}?`,
  };
};

export default async function deleteTodo(input: Input) {
  await removeTodo(input.todoId);
  return { success: true };
}
```

### 2. Instructions

Provide context and guidance to the AI about how to use your extension.

**In package.json:**

```json
{
  "ai": {
    "instructions": "When the user asks about todos, use the get-todos tool. When marking a todo complete, always confirm you have the right todo ID first."
  }
}
```

**In separate file (ai.yaml):**

```yaml
instructions: |
  You are a todo management assistant. When the user asks about their todos:
  - Use get-todos to fetch the current list
  - Always show the user which todos you found
  - When marking complete, confirm you have the correct todo ID first

  If the user doesn't provide enough information to identify a specific todo,
  ask them to clarify which one they mean.
```

**`tools` is a top-level manifest array**, not nested under `ai` — see
[Manifest Configuration](#manifest-configuration) below. `ai.json`/`ai.json5`
(or `ai.yaml`) hold only `instructions` and `evals`:

```json
{
  "instructions": "Instructions for the AI agent..."
}
```

### 3. Evals

Evals are test cases that verify your AI extension works correctly. They're also used as example prompts for users.

**Structure:**

```json
{
  "ai": {
    "evals": [
      {
        "input": "@todo-list What are my todos?",
        "mocks": {
          "get-todos": [
            {
              "id": "1",
              "title": "Buy groceries",
              "completed": false
            }
          ]
        },
        "expected": [
          {
            "callsTool": "get-todos"
          }
        ],
        "usedAsExample": true
      }
    ]
  }
}
```

## Manifest Configuration

`tools` is a **top-level** manifest array, separate from `ai`. Each entry
requires `name` (implicitly maps to `src/tools/<name>.ts`, no `file`
property), `title`, and `description`:

```json
{
  "name": "todo-list",
  "title": "Todo List",
  "tools": [
    {
      "name": "get-todos",
      "title": "Get Todos",
      "description": "Fetch all todos from the user's list"
    },
    {
      "name": "add-todo",
      "title": "Add Todo",
      "description": "Add a new todo item"
    },
    {
      "name": "mark-complete",
      "title": "Mark Complete",
      "description": "Mark a todo as complete"
    },
    {
      "name": "delete-todo",
      "title": "Delete Todo",
      "description": "Delete a todo (requires confirmation)"
    }
  ],
  "ai": {
    "instructions": "You help users manage their todo list.",
    "evals": [
      {
        "input": "@todo-list Add 'Buy milk' to my list",
        "mocks": {
          "add-todo": { "success": true, "id": "123" }
        },
        "expected": [
          {
            "callsTool": "add-todo",
            "arguments": {
              "title": "Buy milk"
            }
          }
        ],
        "usedAsExample": true
      }
    ]
  }
}
```

## Writing Tools

### Tool Function Signature

```typescript
// No input
export default function myTool() {
  return result;
}

// With input
type Input = {
  param1: string;
  param2?: number;
};

export default function myTool(input: Input) {
  return result;
}

// Async
export default async function myTool(input: Input) {
  const result = await fetchData();
  return result;
}
```

### Type Annotations

Use JSDoc or TypeScript to describe inputs clearly:

```typescript
type Input = {
  /**
   * The title of the todo item to create
   * @example "Buy groceries"
   */
  title: string;

  /**
   * Optional priority level
   * @default "medium"
   */
  priority?: "low" | "medium" | "high";

  /**
   * Optional due date in ISO format
   * @example "2024-12-31"
   */
  dueDate?: string;
};

export default async function addTodo(input: Input) {
  // Implementation
}
```

### Return Values

Return structured data that's useful for the AI:

```typescript
// ✅ Good: Structured result
export default async function getTodos() {
  return {
    todos: [
      { id: "1", title: "Buy milk", completed: false },
      { id: "2", title: "Walk dog", completed: true },
    ],
    total: 2,
    incomplete: 1,
  };
}

// ❌ Bad: Just a string
export default async function getTodos() {
  return "You have 2 todos: Buy milk, Walk dog";
}
```

### Error Handling

Throw errors with helpful messages:

```typescript
export default async function markComplete(input: { todoId: string }) {
  const todo = await findTodo(input.todoId);

  if (!todo) {
    throw new Error(`Todo with ID ${input.todoId} not found`);
  }

  if (todo.completed) {
    throw new Error(`Todo "${todo.title}" is already completed`);
  }

  await updateTodo(input.todoId, { completed: true });
  return { success: true, todo };
}
```

### Tool Confirmation

For destructive actions, add confirmation:

```typescript
import { Tool } from "@raycast/api";

type Input = {
  todoId: string;
};

export const confirmation: Tool.Confirmation<Input> = async (input) => {
  const todo = await findTodo(input.todoId);

  return {
    message: `Delete "${todo.title}"? This cannot be undone.`,
    // Optional: Customize button text
    primaryActionTitle: "Delete",
    // Optional: Make it red/destructive
    primaryActionStyle: "destructive",
  };
};

export default async function deleteTodo(input: Input) {
  await removeTodo(input.todoId);
  return { success: true };
}
```

## Writing Evals

### Basic Eval Structure

```json
{
  "input": "User's natural language query",
  "mocks": {
    "tool-name": mockReturnValue
  },
  "expected": [
    {
      "callsTool": "tool-name",
      "arguments": { "param": "value" }
    }
  ],
  "usedAsExample": true
}
```

### Eval Fields

#### input (required)

The user's query with optional `@extension-name` prefix:

```json
{
  "input": "@todo-list What are my open todos?"
}
```

#### mocks (required)

Mock return values for tools:

```json
{
  "mocks": {
    "get-todos": [{ "id": "1", "title": "Buy milk", "completed": false }],
    "get-user": {
      "name": "John",
      "email": "john@example.com"
    }
  }
}
```

#### expected (required)

Expected AI behavior:

```json
{
  "expected": [
    {
      "callsTool": "get-todos"
    }
  ]
}
```

**Match specific arguments:**

```json
{
  "expected": [
    {
      "callsTool": "add-todo",
      "arguments": {
        "title": "Buy milk"
      }
    }
  ]
}
```

**Match nested arguments with dot notation:**

```json
{
  "expected": [
    {
      "callsTool": "update-user",
      "arguments": {
        "user.email": "new@example.com"
      }
    }
  ]
}
```

**Match multiple tool calls:**

```json
{
  "expected": [
    { "callsTool": "get-todos" },
    { "callsTool": "mark-complete", "arguments": { "todoId": "1" } }
  ]
}
```

#### usedAsExample

Set to `true` to show this eval as an example prompt to users:

```json
{
  "input": "@todo-list Add 'Buy milk'",
  "usedAsExample": true
}
```

### Complex Eval Examples

**Testing error handling:**

```json
{
  "input": "@todo-list Mark todo 999 as complete",
  "mocks": {
    "mark-complete": { "error": "Todo not found" }
  },
  "expected": [
    {
      "callsTool": "mark-complete",
      "arguments": { "todoId": "999" }
    }
  ]
}
```

**Testing multi-step workflows:**

```json
{
  "input": "@todo-list Show my todos and mark the first one complete",
  "mocks": {
    "get-todos": [
      { "id": "1", "title": "Buy milk", "completed": false },
      { "id": "2", "title": "Walk dog", "completed": false }
    ],
    "mark-complete": { "success": true }
  },
  "expected": [
    { "callsTool": "get-todos" },
    {
      "callsTool": "mark-complete",
      "arguments": { "todoId": "1" }
    }
  ]
}
```

## Writing Instructions

### Good Instructions

```yaml
instructions: |
  You are a todo list assistant. Follow these guidelines:

  1. When the user asks about their todos, use get-todos first
  2. Always confirm you have the correct todo before marking complete or deleting
  3. If a todo title is ambiguous, ask the user to clarify
  4. When adding a todo, extract the title from the user's message
  5. If the user says "first one" or "last one", refer to the list from get-todos
```

### Bad Instructions

```yaml
# ❌ Too vague
instructions: "Help the user with todos"

# ❌ Too prescriptive
instructions: "Always call get-todos first, then if the user wants to complete a todo, call mark-complete with the ID from the list"

# ❌ Repeating what types already say
instructions: "Use add-todo to add a todo. It takes a title parameter."
```

### Instruction Best Practices

1. **Provide context**, not step-by-step procedures
2. **Explain edge cases** the AI should handle
3. **Define terminology** specific to your domain
4. **Set tone** and personality if relevant
5. **Don't repeat** what's already in tool descriptions

## Running Evals

Evaluate your AI extension:

```bash
npm run evals
```

This will:

1. Run all evals in your manifest
2. Check if the AI calls expected tools
3. Verify arguments match expectations
4. Report pass/fail for each eval

## Testing AI Extensions

### Manual Testing

```bash
npm run dev
```

Then interact with your extension using natural language in Raycast.

### Debugging

Add logging in your tools:

```typescript
export default async function getTodos() {
  console.log("Fetching todos...");
  const todos = await fetchTodos();
  console.log("Found", todos.length, "todos");
  return todos;
}
```

View logs in the Raycast developer console.

## Best Practices

### Tool Design

1. **Keep tools focused** - One tool, one responsibility
2. **Return structured data** - Not just strings
3. **Handle errors gracefully** - Throw helpful error messages
4. **Use confirmations** - For destructive actions
5. **Document parameters** - Use JSDoc or TypeScript comments

### Instructions

1. **Be concise** - AI doesn't need verbose instructions
2. **Focus on edge cases** - Don't explain obvious behavior
3. **Test frequently** - Iterate based on eval results
4. **Use examples** - Show the AI how to handle tricky situations

### Evals

1. **Cover common use cases** - Test typical user queries
2. **Test edge cases** - Handle ambiguous or invalid inputs
3. **Mark examples** - Set `usedAsExample: true` for good prompts
4. **Keep mocks realistic** - Use data that matches your real system

### Project Structure

```
my-ai-extension/
├── src/
│   ├── tools/
│   │   ├── get-todos.ts
│   │   ├── add-todo.ts
│   │   ├── mark-complete.ts
│   │   └── delete-todo.ts
│   └── utils/
│       └── storage.ts
├── assets/
│   └── icon.png
├── package.json  (with ai config)
└── ai.yaml       (optional, for long instructions)
```

## Common Patterns

### Listing Items

```typescript
export default async function getItems() {
  const items = await fetchItems();
  return {
    items: items.map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
    })),
    total: items.length,
  };
}
```

### Creating Items

```typescript
type Input = {
  /** The title of the new item */
  title: string;
  /** Optional description */
  description?: string;
};

export default async function createItem(input: Input) {
  const newItem = await addItem({
    title: input.title,
    description: input.description || "",
    createdAt: new Date().toISOString(),
  });

  return {
    success: true,
    item: newItem,
  };
}
```

### Updating Items

```typescript
type Input = {
  /** ID of the item to update */
  itemId: string;
  /** New status */
  status: "pending" | "completed" | "archived";
};

export default async function updateItem(input: Input) {
  const item = await findItem(input.itemId);

  if (!item) {
    throw new Error(`Item ${input.itemId} not found`);
  }

  await saveItem(input.itemId, { status: input.status });

  return {
    success: true,
    item: { ...item, status: input.status },
  };
}
```

### Deleting Items (with confirmation)

```typescript
import { Tool } from "@raycast/api";

type Input = {
  itemId: string;
};

export const confirmation: Tool.Confirmation<Input> = async (input) => {
  const item = await findItem(input.itemId);
  return {
    message: `Delete "${item.title}"?`,
    primaryActionTitle: "Delete",
    primaryActionStyle: "destructive",
  };
};

export default async function deleteItem(input: Input) {
  await removeItem(input.itemId);
  return { success: true };
}
```
