---
name: setup-alchemy
description: Set up a repository to deploy its Alchemy stack to Cloudflare from Forgejo or GitHub CI, with a stateless scoped-token bootstrap (`bun run bootstrap:ci`, `--rotate` to replace).
disable-model-invocation: true
argument-hint: "[init | bootstrap | workflow]"
---

# Setup Alchemy

**Goal:** every push to `main` deploys the repository's Alchemy stack to Cloudflare from CI. CI deploys with a least-privilege, expiring Cloudflare token that the operator installs with `bun run bootstrap:ci` and replaces with `bun run bootstrap:ci --rotate`.

For any Alchemy API, CLI, state-store, or stage question, call the Skill tool with "alchemy" and read the topic it routes to. This skill holds only what the Alchemy docs do not: the bootstrap contract, the forge differences, and the deploy job's shape.

Work in the order **explore, present, confirm, write**. `$ARGUMENTS` can name a single branch; otherwise run every branch the exploration shows is missing.

## Explore

Read the repository before asking anything:

- The stack entrypoint (`alchemy.run.ts` or another default-exported `Alchemy.Stack`), its providers, state store, and every resource it deploys.
- `package.json` scripts and dependencies (the `alchemy` version, the test runner), and the workspace layout if it is a monorepo.
- The Git remote, which gives the forge kind, host, and `owner/repo`. Workflows live in `.forgejo/workflows/` or `.github/workflows/`. Collect every `secrets.*` reference.
- Any existing bootstrap: a `bootstrap:ci` script, `alchemy.ci.ts`, or `stacks/github.ts`. An Alchemy-stack bootstrap keeps the minted token in plaintext under local `.alchemy/state`; propose replacing it with the stateless script and removing the old stack once the new secrets are installed.

Done when you can name which branches apply, the forge target, and every resource kind the stack deploys.

## Present and confirm

Summarize what exists and what is missing, then confirm, leading each item with the recommended answer:

- The forge target (`kind`, `host`, `owner/repo`) and the token prefix (`<project>-ci`).
- The account permission groups and any zone grant, derived from the stack (see [permissions](references/permissions.md)).
- The deploy trigger, plus whether PR previews are in scope (they are not by default).

## Branches

### Init: the repository has no Alchemy stack

Scaffold the stack from the Alchemy docs (getting started, project structure, state store, stages) through the alchemy skill. Done when:

- `alchemy.run.ts` default-exports a Stack whose `state` is `Cloudflare.state()`, so a laptop and a CI runner agree on what is deployed;
- `alchemy` is a dependency, `.alchemy/` is gitignored, and `prod` is the stage CI deploys;
- the stack typechecks and `alchemy plan --stage <personal stage>` runs locally.

The first deploy that uses `Cloudflare.state()` creates the state store. Hand the operator that step, or `alchemy provider cloudflare bootstrap` when a previous attempt was interrupted.

### Bootstrap: CI has no Cloudflare credential, or its scopes changed

Copy `$SKILL_DIR/scripts/bootstrap-ci.ts` and `$SKILL_DIR/scripts/bootstrap-ci.test.ts` into the repository (for example under `scripts/ci/`). This template is the canonical implementation; adapt it in place without rewriting its flow:

- Set `CONFIG`. Delete the unused forge adapter, its tests, and `forgeFor`, then call the remaining adapter directly.
- Switch the test import to the repository's runner (`vitest` and `bun:test` share this API).
- Add `"bootstrap:ci": "bun <path>/bootstrap-ci.ts"` to the **root** `package.json`, so `bun run bootstrap:ci --rotate` forwards its flags from the repository root.
- Record both commands and their meaning in the repository's agent guidance (`AGENTS.md` or `CLAUDE.md`), next to the other operator commands.

The template's contract, which an adaptation keeps intact:

- **Stateless.** Credentials stay in memory. Nothing writes state, `.env`, or token metadata, and the forge CLI runs with Cloudflare variables stripped from its environment.
- **Idempotent rerun.** With both secrets present, a plain run changes nothing and collects no credentials. Partial secrets, or an active `<prefix>-*` token without secrets, stop the run until the operator passes `--rotate`.
- **Least privilege, verified.** Grants resolve against Cloudflare's live permission catalog. The new token's identity, exact policy, expiry, account access, and zone lookup are verified before any secret is written.
- **Explicit and bounded.** The operator confirms the printed target, grants, and expiry before minting. Every network call, CLI call, and prompt has a timeout. Old tokens are never revoked.

Done when the copied tests pass, `bun run bootstrap:ci --help` names the right repository and grants, and the repository's lint, typecheck, and format checks pass. Forge-specific details are in [forges](references/forges.md).

### Workflow: no CI job deploys the stack

Write or extend the deploy job following [deploy workflow](references/deploy-workflow.md). Done when the job runs only on pushes to `main` after the required checks, every `secrets.*` it reads is either installed by the bootstrap or listed for the operator to set, and the workflow passes `actionlint` when it is available.

## Boundaries

- Token values and the Global API key reach only memory and the forge's stdin. Keep them out of argv, logs, files, and your own output.
- Leave minting, secret writes, state-store creation, and production deploys to the operator. Hand over the exact command, and run the bootstrap only with `--help` yourself.

## Done

Every branch you ran meets its criteria, and the operator has the ordered commands still to run with a way to check each one:

1. The state-store bootstrap, for a new stack only.
2. `bun run bootstrap:ci`. Check by listing the repository's secret **names** on the forge.
3. A push to `main`. Check that the deploy job is green and the deployed URL serves the new commit.
