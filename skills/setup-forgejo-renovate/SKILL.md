---
name: setup-forgejo-renovate
description: Set up self-hosted Renovate for Cargo and Forgejo Actions, including credentials and guarded checkbox-triggered runs.
disable-model-invocation: true
argument-hint: "[repository-path]"
---

# Setup Forgejo Renovate

**Goal:** the target repository gets review-only Cargo and Forgejo Actions updates from a real Renovate bot. Scheduled/manual runs and the approved maintainer's dashboard/PR checkbox edits process requests without bot-triggered loops.

Work **explore, present, confirm, write**. Resolve the optional repository path, otherwise use the current repository.

## Explore and confirm

Read the target's instructions, remotes, Forgejo version/event support, default branch, runner labels, Cargo/toolchain manifests, existing Renovate configuration, workflow secrets, and source-reference conventions. Inspect the existing setup before deciding what is missing.

Present the proposed forge origin, `owner/repo`, bot identity, authorized maintainer, default branch, runner label, cadence, and manual dependency exclusions. Recommend the discovered values and confirm the files and permission changes before writing. Existing manager coverage survives unless the user explicitly narrows it.

## Apply

Read [template adaptation](references/templates.md), then copy and adapt the files under `$SKILL_DIR/references/templates/`:

- [Workflow](references/templates/renovate.yml) to `.forgejo/workflows/renovate.yml`.
- [Dependency policy](references/templates/renovate.json5) to `renovate.json5`.
- [Trigger tests](references/templates/renovate-workflow.test.ts.txt) to `scripts/renovate-workflow.test.ts` for Bun targets; otherwise port the cases to the existing test runner.

Merge existing files rather than replacing their policy. Replace every template marker with the confirmed value. Keep checkbox events, owner/bot guards, serialization, and trusted-base PR execution together. Register copied tests in the existing CI test command.

Read [credentials](references/credentials.md) when bot access or either credential is missing. Document the target's cadence, permitted checkbox actor, secret names, dependency exclusions, and remaining activation steps in its existing operator docs.

## Completion criteria

Use [verification](references/verification.md) to distinguish these outcomes:

- **Prepared:** no unresolved markers; the pinned Renovate config validates; extraction selects the intended managers; trigger tests cover owner clicks and rejected edits; workflow lint and target checks pass, or unrelated baseline failures are explicitly identified.
- **Operational:** the real bot has write access; both secrets are available to the job; an authenticated run succeeds; a fresh checkbox edit on the merged default-branch configuration starts the intended run; bot updates do not start another Renovate job.

If credentials or merge access are pending, report **prepared**, list the exact operator steps, and leave live verification pending. A green manual run alone does not prove checkbox dispatch.

## Boundaries

- Preserve unrelated edits and reference-coupled dependency pins. Keep automerge and whole-lock maintenance off unless separately approved.
- Keep PAT values in the operator's password manager and forge secret storage, never in chat, argv, logs, repository files, or the Nix store. Inspect secret names only.
- Confirm bot permission changes, secret writes, workflow dispatches, and the repository's branch/PR plan under its own remote-write rules. Skill invocation does not grant forge-wide authority.
- Use the trusted default/target-branch workflow for edit events. Never check out or execute PR-controlled code in a secret-bearing job.
