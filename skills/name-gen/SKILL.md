---
name: name-gen
description: |
  Guides structured naming workflows with brainstorming, domain availability checking, and conflict research. Triggers on "name a project", "brainstorm names", "find a name for", "check domain availability", "what should I call", or "suggest names".
effort: medium
argument-hint: "[project description]"
allowed-tools: Bash(bun:*), WebSearch, WebFetch, Read, Glob
---

# Project Name Generator

Guide the user through a structured naming workflow with four phases.

## Phase 1: Brainstorm

Gather context from the user:

- What does the project do?
- Who is the target audience?
- What tone/vibe? (playful, professional, technical, minimal)
- Any constraints? (max length, must be pronounceable, etc.)

Then generate **10–15 candidate names** across these categories:

| Category    | Description                   | Example                   |
| ----------- | ----------------------------- | ------------------------- |
| Descriptive | Says what it does             | `FastBuild`, `CodeLint`   |
| Abstract    | Evocative, no literal meaning | `Zephyr`, `Aura`          |
| Compound    | Two words merged              | `CloudForge`, `DataWeave` |
| Portmanteau | Blended words                 | `Docktor` (doc + doctor)  |
| Metaphor    | Conceptual parallel           | `Lighthouse`, `Compass`   |

Present names in a table and ask the user to **shortlist 3–5 favorites**.

## Phase 2: Check Domains

Run the domain checker for each shortlisted name:

```bash
bun $SKILL_DIR/scripts/check-domains.ts --json <name1> <name2> <name3> --tlds=com,dev,io,app
```

Present domain availability results in a clear table. Highlight names with `.com` available.

## Phase 3: Research Conflicts

For each name that has available domains, use **WebSearch** to check:

1. **npm registry** — search `site:npmjs.com "<name>"`
2. **GitHub** — search `site:github.com "<name>"`
3. **General web presence** — search `"<name>" software OR library OR framework`
4. **Trademarks** — search `"<name>" trademark software`

Summarize findings per name with a conflict level:

- **None** — No existing usage found
- **Low** — Minor/unrelated usage exists
- **Medium** — Similar projects exist but in different domains
- **High** — Direct conflict with established project

## Phase 4: Recommend

Present a final comparison table:

| Name | .com | .dev | .io | npm | GitHub | Conflicts | Recommendation |
| ---- | ---- | ---- | --- | --- | ------ | --------- | -------------- |

Rank names by overall viability and give a clear top recommendation with reasoning.
