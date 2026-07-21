---
name: {{WS_SLUG}}-context
description: Loads the layered context for the {{WS_NAME}} workspace. Use when starting work related to {{WS_NAME}}, when entering the {{WS_SLUG}} workspace or any of its member repositories, or when asked to "load workspace context" for this work.
---

# {{WS_NAME}} workspace context

This skill assembles the explicit, audited context for the {{WS_NAME}}
workspace hub at `{{WS_PATH}}`.

## Loading procedure

1. Print the ordered context layers and verify they exist by invoking the
   `workspaces` skill to retrieve context for `{{WS_PATH}}`.

2. Read the listed layer files top to bottom. The order is deliberate:
   constitution before specs, specs before decisions, decisions before plans.

3. Check current cross-repo state before touching any member repo by invoking
   the `workspaces` skill to get the status of `{{WS_PATH}}`.

4. Skim the newest sections of `{{WS_PATH}}/JOURNAL.md` for decisions and
   deviations more recent than the documents you just read.

## Rules

- Only documents reachable from `docs/index.md` are workspace context; do
  not treat other files as authoritative.
- If the `workspaces` skill reports a missing layer, stop and run the audit
  flow of the `workspaces` skill before proceeding.
