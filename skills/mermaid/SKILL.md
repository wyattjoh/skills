---
name: mermaid
description: |
  Creates, validates, and renders Mermaid diagrams as interactive HTML. MUST be used to validate written Mermaid syntax, including Mermaid code fences in Markdown. Triggers on "validate mermaid", "create a diagram", "draw a flowchart", "sequence diagram", "visualize architecture", "class diagram", "ER diagram", "Gantt chart", "mindmap", or mentions "mermaid syntax", "mermaid.js", "flowchart TD", "graph LR".
effort: low
allowed-tools: Bash(bun:*), Bash(open:*), Read, Glob
---

# Mermaid Diagram Renderer

Validate Mermaid syntax, then generate interactive HTML diagrams and open them in the browser. Rendering always validates first and exits without creating HTML when the syntax is invalid.

## Quick Start

Pipe mermaid code to the render script:

```bash
echo 'flowchart TD
  A[Start] --> B{Decision}
  B -->|Yes| C[OK]
  B -->|No| D[Cancel]' | bun $SKILL_DIR/scripts/render.ts
```

### Options

| Flag             | Description                                           |
| ---------------- | ----------------------------------------------------- |
| `--theme <name>` | Mermaid theme: `default`, `dark`, `forest`, `neutral` |
| `--no-open`      | Write HTML file without opening in browser            |

The renderer validates Mermaid syntax before writing or opening the HTML file. Invalid input produces a JSON validation report and a nonzero exit code.

### Examples

```bash
# Dark theme
echo '...' | bun $SKILL_DIR/scripts/render.ts --theme dark

# Write file only (no browser)
echo '...' | bun $SKILL_DIR/scripts/render.ts --no-open
```

## Validate Mermaid Syntax

Use [`scripts/validate.ts`](scripts/validate.ts) when syntax validation is needed without rendering. It accepts explicit Mermaid or Markdown file paths, or reads Mermaid or Markdown from stdin when no paths are supplied.

```bash
# Validate Mermaid source from stdin
echo 'flowchart TD
  A --> B' | bun $SKILL_DIR/scripts/validate.ts

# Validate Mermaid fences in Markdown
bun $SKILL_DIR/scripts/validate.ts README.md docs/architecture.md

# Validate a Mermaid file
bun $SKILL_DIR/scripts/validate.ts diagram.mmd
```

The validator writes JSON containing overall validity, detected input files, source types, diagrams, source line ranges, detected diagram types, and normalized errors with line and column locations. It exits `0` when every detected diagram is valid and `1` for syntax or input errors. Markdown files without Mermaid fences are valid and report no diagrams.

## Critical Syntax Rules

**NEVER use literal newlines inside node labels.** Mermaid's parser is line-based — a node definition must be on a single line. Use `<br/>` for line breaks within labels.

```mermaid
%% ❌ WRONG — causes "Syntax error in text"
SWR1["Fresh
30 min"]

%% ✅ CORRECT
SWR1["Fresh<br/>30 min"]
```

## Mermaid Syntax Quick Reference

### Flowchart

```mermaid
flowchart TD
  A[Rectangle] --> B(Rounded)
  B --> C{Diamond}
  C -->|One| D[Result 1]
  C -->|Two| E[Result 2]
```

Direction: `TD` (top-down), `LR` (left-right), `BT` (bottom-top), `RL` (right-left)

### Sequence Diagram

```mermaid
sequenceDiagram
  participant A as Alice
  participant B as Bob
  A->>B: Hello
  B-->>A: Hi back
  A->>B: Request
  Note over A,B: Shared note
```

### Class Diagram

```mermaid
classDiagram
  class Animal {
    +String name
    +makeSound() void
  }
  Animal <|-- Dog
  Animal <|-- Cat
```

### State Diagram

```mermaid
stateDiagram-v2
  [*] --> Idle
  Idle --> Processing : start
  Processing --> Done : finish
  Done --> [*]
```

### Entity Relationship

```mermaid
erDiagram
  CUSTOMER ||--o{ ORDER : places
  ORDER ||--|{ LINE-ITEM : contains
  PRODUCT ||--o{ LINE-ITEM : "is in"
```

### Gantt Chart

```mermaid
gantt
  title Project Plan
  dateFormat YYYY-MM-DD
  section Phase 1
    Task A :a1, 2024-01-01, 30d
    Task B :after a1, 20d
```

### Pie Chart

```mermaid
pie title Distribution
  "A" : 40
  "B" : 35
  "C" : 25
```

### Git Graph

```mermaid
gitGraph
  commit
  branch feature
  checkout feature
  commit
  commit
  checkout main
  merge feature
```

### Mindmap

```mermaid
mindmap
  root((Central))
    Topic A
      Subtopic 1
      Subtopic 2
    Topic B
      Subtopic 3
```

### Timeline

```mermaid
timeline
  title History
  2020 : Event A
  2021 : Event B
       : Event C
  2022 : Event D
```
