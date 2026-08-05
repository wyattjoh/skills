# Invalid Mermaid examples

The surrounding Markdown is valid, but every Mermaid block contains a syntax error.

```mermaid
flowchart TD
  Start -->
```

Some prose between diagrams.

```mermaid
sequenceDiagram
  Alice->>Bob: hello; world
```

```mermaid
stateDiagram-v2
  [*] -->
```
