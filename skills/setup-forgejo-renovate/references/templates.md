# Template adaptation

This bundle supplies a generic, review-only policy and a Forgejo runner. Adapt dependency coverage to the target repository's manifests and existing exclusions, not the repository this template originated from.

## Bindings

Replace these markers consistently in the workflow, dependency policy, and copied tests. Derive values from the target repository, then confirm them.

| Marker                 | Meaning                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `__FORGEJO_ORIGIN__`   | Reachable forge origin, without a trailing slash; prefer HTTPS |
| `__REPOSITORY__`       | Exact `owner/repo`                                             |
| `__DEFAULT_BRANCH__`   | Actual default branch, also the only allowed PR target         |
| `__AUTHORIZED_ACTOR__` | Approved human maintainer login, not the bot                   |
| `__BOT_LOGIN__`        | Real Forgejo Renovate account login                            |
| `__RUNNER_LABEL__`     | A registered label that supports Linux job-level containers    |
| `__TIMEZONE__`         | Confirmed IANA timezone, such as `Etc/UTC`                     |
| `__WEEKLY_CRON__`      | Confirmed five-field weekly cron expression                    |

Keep replacements as YAML/JSON/string data with correct escaping. Reject multiline or shell-bearing identity values. The repository is passed through `RENOVATE_REPOSITORY`, not interpolated into shell source. Require a human actor distinct from the bot so the loop guard remains effective.

## Runner and tools

The workflow uses Renovate's official default container, pinned by version and multi-architecture image digest. The pin is a reproducible baseline, not automatically the latest release. Verify the image provenance and reported binary version; update the image's version and digest together.

`RENOVATE_BINARY_SOURCE=install` lets Renovate install tools on demand for managers that find dependencies in this repository. Keep the runtime generic instead of preinstalling another repository's language toolchain. Verify required registry/download access and any runtime constraints during artifact updates. If a target requires tools the default image cannot provision, confirm a repository-specific adjustment before adding it.

An otherwise valid job can remain queued forever on an unregistered label. Check DNS, TLS trust, and forge connectivity from inside the job container, not only from the laptop or runner daemon. Private/tailnet forges may need a runner hosts entry and a narrow egress allowance.

## Dependency policy

The template leaves `enabledManagers` unset: Renovate's default-enabled managers detect matching files, so absent ecosystems do not produce dependency updates. The `github-actions` manager also scans `.forgejo/workflows/` and local action definitions. Check the pinned version's manager support before enabling an opt-in manager or defining custom extraction; require matching repository files and operator approval.

Inventory manifests, lockfiles, CI actions/container references, generated/vendor/example files, and manual/source-reference coupling. Preserve the target's ignore paths and disabled rules; add exclusions only for paths and dependencies actually present. If the operator requests narrower coverage, derive an `enabledManagers` allowlist from this inventory rather than copying one from an example repository.

Add grouping, release-age, range, toolchain, or manual-dependency rules only for discovered ecosystems. For example, a Cargo repository may need MSRV-aware rules and coupled-crate exclusions; a JavaScript repository may need its package-manager/runtime constraints preserved. Neither policy belongs in every copied config. Whole-lock maintenance stays disabled because it can advance transitive snapshots outside individually approved updates.

The workflow owns run cadence, so manual and checkbox requests are not blocked by a second repository schedule.

## Edit events

`issues: edited` handles the bot's open Dependency Dashboard. `pull_request_target: edited` uses the trusted base branch and repository secrets for bot-owned open PRs targeting the default branch. Both require the approved human actor and a checked box in the body. Bot edits and unrelated edits skip the job.

The `github` expression context is Forgejo's compatibility alias and works with Actionlint. Maintain the actor, author, state, branch, and checked-body guard as one policy. A second approved maintainer requires an explicit allowlist change and matching tests.

Runs share one concurrency group. A fresh checkbox request can queue behind an existing run; it is not an interrupt. Comments are not checkbox triggers in this template.

The copied tests evaluate the exact workflow guard's boolean/string-contains subset and exercise both missing-secret paths. Keep their target-specific constants aligned with the workflow. The subset evaluator is not a replacement for post-merge Forgejo event verification.

Primary references: [Forgejo workflow events](https://forgejo.org/docs/latest/user/actions/reference/), [Renovate distributions](https://docs.renovatebot.com/getting-started/running/#docker-images), [Manager detection](https://docs.renovatebot.com/modules/manager/), [Actions manager](https://docs.renovatebot.com/modules/manager/github-actions/), [On-demand tools](https://docs.renovatebot.com/self-hosted-configuration/#binarysource).
