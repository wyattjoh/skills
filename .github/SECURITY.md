# Security Policy

## Scope

This repository publishes Claude Code skills and agents: Markdown instruction
files plus small Bun/TypeScript helper scripts that run locally inside your own
agent/editor. There is no hosted service and it collects no data. The relevant
security surface is:

- A defect in a helper script under `skills/*/scripts/` (for example, command
  injection or unsafe file handling).
- A skill whose instructions could steer an agent into unsafe behavior (leaking
  secrets, running destructive commands).

## Supported versions

Only the latest `main` is supported. Fixes land on `main`; there are no
maintained release branches.

## Reporting a vulnerability

Please report privately rather than opening a public issue:

- Use GitHub's private vulnerability reporting: the **Security** tab →
  **Report a vulnerability**.

Include the affected skill or script, the impact, and steps to reproduce.
This is a personal open-source project maintained on a best-effort basis, so
there is no formal response-time guarantee, but reports are read and addressed.
