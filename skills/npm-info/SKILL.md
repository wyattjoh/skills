---
name: npm-info
description: |
  Looks up npm package metadata, readmes, and maintainer info. Triggers on "look up npm package", "what does [package] do", "npm package info", "show me the readme for", "who maintains [package]", or mentions needing information about a specific npm package.
effort: low
argument-hint: "[package-name]"
allowed-tools: Bash(bun:*), Read, Glob
---

# Fetching npm Package Info

**NEVER** use WebFetch to fetch npmjs.com — use the bundled script instead. The npmjs.com website is blocked by DNS filtering, but the registry API at `registry.npmjs.org` works directly.

## Script Location

The info script is located at:
`$SKILL_DIR/scripts/npm-info.ts`

## Quick Start

Run the script to get structured JSON about any npm package:

```bash
bun $SKILL_DIR/scripts/npm-info.ts <package-name>
```

Example output:

```json
{
  "name": "express",
  "description": "Fast, unopinionated, minimalist web framework",
  "version": "5.2.1",
  "license": "MIT",
  "homepage": "https://expressjs.com/",
  "repository": "https://github.com/expressjs/express",
  "maintainers": ["wesleytodd", "ulisesgascon", "jonchurch", "..."],
  "keywords": ["framework", "sinatra", "web", "http"],
  "readme": "# Express\n\nFast, unopinionated...",
  "deprecated": false,
  "engines": { "node": ">= 18" },
  "dependencies": { "accepts": "~2.0.0" },
  "distTags": { "latest": "5.2.1", "latest-4": "4.22.2" }
}
```

The `readme` field can legitimately come back as an empty string for some
packages (a known registry quirk where README extraction fails at publish
time) — fall back to `homepage`/`repository` in that case rather than
treating it as "this package has no documentation."

## Usage

1. Run the script with the package name
2. Parse the JSON output for the fields you need
3. Present the relevant information to the user

The `readme` field contains the full package README as a markdown string — useful for understanding what a package does, its API, and usage examples.
