---
name: json-inspect
description: 'Generates JSON Schema from JSON files using genson to understand data structure. Triggers on "inspect JSON", "understand JSON format", "analyze JSON data shape", "generate JSON schema", or mentions "genson".'
allowed-tools: Bash(uvx:*), Read
effort: low
argument-hint: "[json-file-path]"
---

# JSON Schema Inspection

Generate JSON Schema from any JSON file to understand its structure.

## Quick Start

```bash
uvx genson <JSON_FILE>
```

This outputs a JSON Schema describing the file's structure, including:

- Required vs optional fields
- Data types for each field
- Array item types
- Nested object structures

## Example

For a file `data.json`:

```json
{ "name": "Alice", "age": 30, "tags": ["dev", "lead"] }
```

Running `uvx genson data.json` produces:

```json
{
  "type": "object",
  "properties": {
    "name": { "type": "string" },
    "age": { "type": "integer" },
    "tags": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["name", "age", "tags"]
}
```

## Use Cases

- Understanding unfamiliar JSON data structures
- Documenting API response formats
- Validating JSON against expected schema
- Generating TypeScript interfaces from JSON
