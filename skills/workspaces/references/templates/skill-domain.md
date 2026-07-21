---
name: {{WS_SLUG}}-domain
description: Domain model and ubiquitous language for the {{WS_NAME}} workspace. Use when discussing, designing, or naming anything in the {{WS_NAME}} problem space, or when domain terms from this workspace appear, such as {{DOMAIN_TERMS}}.
---

# {{WS_NAME}} domain

The domain model for {{WS_NAME}}, seeded from the workspace scoping session
and maintained with the `domain-modeling` skill.

## Sources of truth

- `{{WS_PATH}}/CONTEXT.md` — the glossary / ubiquitous language. Use these
  terms exactly; if a needed term is missing, add it there (via
  domain-modeling), never invent a synonym.
- `{{WS_PATH}}/docs/adr/` — decisions that shaped the model. ADRs are
  superseded, never edited.

## Core model summary

<!-- Seed from the grill-with-docs session: the 3-6 central concepts, their
     relationships, and the boundaries between member repositories. Keep this
     a summary; CONTEXT.md holds the full glossary. -->

{{DOMAIN_SUMMARY}}

## Evolving the model

Model changes are Decisions: record an ADR via the `domain-modeling` skill,
journal the decision (`just journal decision "..." "adr/NNNN"`), and update
CONTEXT.md in the same change.
