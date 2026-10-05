# Verification and activation

## Local, without forge writes

Bound local/remote probes with explicit timeouts and report timeouts as pending evidence.

Run the copied trigger tests and the target's relevant formatter, lint, and typecheck commands. Confirm a registered runner label, no unresolved `__MARKERS__`, and no PR checkout or event-body interpolation in any secret-bearing shell step.

Use the workflow's exact nixpkgs source and tools for these commands:

```sh
renovate --version
renovate-config-validator --strict renovate.json5
LOG_LEVEL=debug renovate --platform=local --dry-run=extract --require-config=required --onboarding=false
actionlint .forgejo/workflows/renovate.yml
bun test ./scripts/renovate-workflow.test.ts
```

Local extraction discovers files through Git, so add newly created config/workflow files to the index before running it. An exit-zero extraction that says no Renovate config was found does not validate your proposed manager policy.

Check the extraction statistics for Cargo and Actions, inspect exclusions, and distinguish a missing GitHub-token warning in an unauthenticated local run from a successful authenticated run. This dry run proves extraction, not registry lookup, Cargo lock generation, PR publication, or secrets.

Actionlint understands the compatibility `github` context. When linting existing Forgejo workflows with URL-form actions, distinguish pre-existing GitHub-only diagnostics from new failures by comparing the baseline. Preserve unrelated failures as evidence rather than weakening checks.

## Live, after approval

After the workflow is merged into the default branch and credentials are available:

1. With operator authorization, manually dispatch Renovate on the default branch. Require a successful authenticated run, correctly generated lockfiles, and the expected dashboard/PR author.
2. Have the approved maintainer toggle a real Renovate action checkbox in an open dashboard or bot PR. Capture the edited-event run and its result. A box checked before merge does not replay itself; uncheck/recheck to create a fresh event.
3. Verify the bot's subsequent dashboard/PR edits skip the Renovate job instead of recursively running it. Unrelated and unauthorized edits must also skip the job.

The actual event check is the acceptance test. The local guard fixtures cannot prove the forge's notifier, actor mapping, default-branch routing, secret injection, or runner availability.

## Recovery

| Observation                         | Check                                                                                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Checkbox changes but no run appears | Default-branch workflow contains edited triggers; correct human actor and bot author; expected open dashboard/PR body; generate a fresh edit |
| Run appears with Renovate skipped   | Compare event name/action, actor, author, issue title/state, PR base/state, and checked body against the guard                               |
| Job remains waiting                 | Registered label, available runner slots, and existing concurrency-group run                                                                 |
| Missing-secret message              | Repository/inherited scope and exact secret name, without reading values                                                                     |
| Authentication/author failure       | Real bot identity, token scopes, repository write access, and forge endpoint                                                                 |
| Lockfile update failure             | Provisioned Cargo/rustup, toolchain pin/MSRV, registry access, and artifact-update logs                                                      |

Report the changed files, prepared versus operational status, check results, and any operator steps still required. Preserve a blocked activation as pending, not a successful setup.
