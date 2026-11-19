---
name: publish-npm
description: Set up npm trusted publishing from GitHub Actions for a package, or publish its next version.
disable-model-invocation: true
argument-hint: "[setup|publish] [package-path]"
---

# Publish to npm

**Goal:** the package publishes to npm from CI through trusted publishing (OIDC, no stored token, provenance attached), and the requested version is live on the registry.

Resolve the optional package path, otherwise use the current repository. Without `setup` or `publish`, pick from the evidence: `setup` when the package is missing from npm or no workflow publishes it, `publish` otherwise.

Work **explore, present, confirm, write**. Read `package.json`, `.github/workflows/`, any release-please files, `git log` (conventional commits?), `npm view <name>` and `npm whoami` before asking anything, then present the plan with the recommended answers first.

## Setup

**Package metadata.** `name` is the intended (usually scoped) name and is free or already owned; `private` is gone; `license` matches a `LICENSE` file; `repository.url` is `git+https://github.com/<owner>/<repo>.git`, which provenance checks against the workflow's repository; `files` limits the tarball to what runs. Scoped packages carry `publishConfig.access: public`. Bun-only packages (bin points at `.ts`, `bun:` imports) declare `engines.bun` and say so in the README. Confirm the tarball with `npm pack --dry-run`.

**Release workflow.** When the project uses release-please or wants it, call the Skill tool with `"release-please"` for the release config and workflow, then put publishing in the same workflow (see [publish job](references/publish-job.md)). Without release-please, use the tag-triggered variant in the same reference. The repository setting "Allow GitHub Actions to create and approve pull requests" is on when release-please opens PRs (`gh api repos/<owner>/<repo>/actions/permissions/workflow`).

**First publish and trust.** Trusted publishing attaches only to a package that exists, so the first version is published by hand. Follow [first publish](references/first-publish.md); it covers the interactive login, 2FA, the trust link, and registry lag.

Setup is done when:

- `npm pack --dry-run` lists only intended files and the package's checks pass.
- The publish job pins every action to a commit SHA, runs the checks, and skips versions already on npm.
- `npm view <name> version` returns the first version, and the trust link names the exact workflow filename with publish permission.

## Publish

- **release-please:** the open release PR proposes the version the user expects (a first release defaults to `1.0.0` unless `initial-version` is set). Merge it with the repository's merge rules, then watch the run until the publish job finishes.
- **Tag workflow:** bump with `npm version <patch|minor|major>`, push the commit and tag, then watch the run.
- **No CI path yet:** run setup first.

Publish is done when the workflow run succeeded, `npm view <name>@<version>` resolves, and the GitHub release (if any) carries the same tag. A fresh package or version can return 404 to anonymous reads for several minutes; `npm access get status <name>` with the user's login confirms it exists meanwhile.

## Boundaries

- Publishing is irreversible after npm's short unpublish window. Confirm the package name, version, and tarball contents before every publish, and confirm each remote write (push, merge, repository setting, trust link) under the target tree's rules.
- The user completes every interactive login and 2FA prompt themselves; keep tokens out of chat, argv, logs, and repository files.
- Leave a long-lived `NPM_TOKEN` secret out of the workflow. If one already exists, recommend removing it once trusted publishing has shipped a release.
