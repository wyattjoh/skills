# Template adaptation

This bundle targets Rust/Cargo and Forgejo Actions. For another ecosystem, expand the design with the operator rather than silently adding managers or replacing an existing setup.

## Bindings

Replace these markers consistently in the workflow, dependency policy, and copied tests. Derive values from the target repository, then confirm them.

| Marker                 | Meaning                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `__FORGEJO_ORIGIN__`   | Reachable forge origin, without a trailing slash; prefer HTTPS |
| `__REPOSITORY__`       | Exact `owner/repo`                                             |
| `__DEFAULT_BRANCH__`   | Actual default branch, also the only allowed PR target         |
| `__AUTHORIZED_ACTOR__` | Approved human maintainer login, not the bot                   |
| `__BOT_LOGIN__`        | Real Forgejo Renovate account login                            |
| `__RUNNER_LABEL__`     | A registered label that supports job-level containers          |
| `__TIMEZONE__`         | Confirmed IANA timezone, such as `Etc/UTC`                     |
| `__WEEKLY_CRON__`      | Confirmed five-field weekly cron expression                    |

Keep replacements as YAML/JSON/string data with correct escaping. Reject multiline or shell-bearing identity values. The repository is passed through `RENOVATE_REPOSITORY`, not interpolated into shell source. Require a human actor distinct from the bot so the loop guard remains effective.

## Runner and tools

The workflow uses the Nix image index and immutable nixpkgs/Renovate pins characterized by the working setup. These are a reproducible baseline, not automatically current versions. Verify the resolved binary matches `RENOVATE_VERSION`; move its package source and expected version together when updating.

The job provisions Node, Git, and rustup, and uses `RENOVATE_BINARY_SOURCE=global`. rustup follows the cloned repository's checked-in `rust-toolchain.toml`. If the target has no toolchain pin, confirm either adding one or provisioning compatible Cargo/Rust directly from nixpkgs after checking the MSRV. Lock updates do not compile the application.

An otherwise valid job can remain queued forever on an unregistered label. Check DNS, TLS trust, and forge connectivity from inside the job container, not only from the laptop or runner daemon. Private/tailnet forges may need a runner hosts entry and a narrow egress allowance.

## Dependency policy

The template enables only `cargo` and `github-actions`; the latter also scans `.forgejo/workflows/` and local action definitions. It groups compatible updates, ages Cargo releases, and bounds PR creation. The workflow owns run cadence, so manual and checkbox requests are not blocked by a second repository schedule.

Inventory manual/source-reference coupling before applying it. Add an explicit disabled Cargo package rule for the target's coupled crates, for example:

```json
{
  "description": "Keep source-reference-coupled crates manual",
  "matchManagers": ["cargo"],
  "matchPackageNames": ["gpui-kit", "gpui-pre*", "toml_edit"],
  "enabled": false
}
```

Those names are examples, not universal exclusions. Add the target's actual crates or omit the rule when none apply. Whole-lock maintenance stays disabled because it can advance transitive snapshots outside individually approved updates. Keep reference submodules, devenv inputs, toolchain pins, and agent/model catalogs on their existing update paths.

## Edit events

`issues: edited` handles the bot's open Dependency Dashboard. `pull_request_target: edited` uses the trusted base branch and repository secrets for bot-owned open PRs targeting the default branch. Both require the approved human actor and a checked box in the body. Bot edits and unrelated edits skip the job.

The `github` expression context is Forgejo's compatibility alias and works with Actionlint. Maintain the actor, author, state, branch, and checked-body guard as one policy. A second approved maintainer requires an explicit allowlist change and matching tests.

Runs share one concurrency group. A fresh checkbox request can queue behind an existing run; it is not an interrupt. Comments are not checkbox triggers in this template.

The copied tests evaluate the exact workflow guard's boolean/string-contains subset and exercise both missing-secret paths. Keep their target-specific constants aligned with the workflow. The subset evaluator is not a replacement for post-merge Forgejo event verification.

Primary references: [Forgejo workflow events](https://forgejo.org/docs/latest/user/actions/reference/), [Cargo manager](https://docs.renovatebot.com/modules/manager/cargo/), [Actions manager](https://docs.renovatebot.com/modules/manager/github-actions/).
