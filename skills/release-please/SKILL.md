---
name: release-please
description: Configure, operate, and debug release-please. Triggers on "release-please", "force version bump", "force release", "Release-As", "force-run label", "skip release", "release PR stale", "tag didn't fire", "trigger release", "bump version".
allowed-tools: WebFetch, Read, Write, Edit, Glob, Grep, Bash(git:*), Bash(gh:*)
effort: high
---

# Release-Please Setup

Configures [release-please](https://github.com/googleapis/release-please) in a project for automated version bumping, changelog generation, GitHub releases, and optional registry publishing.

## Before You Start

**Always fetch current documentation** before configuring release-please. The action and config schema evolve across versions.

| Resource                     | URL                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------- |
| release-please-action README | https://github.com/googleapis/release-please-action                              |
| Config schema reference      | https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md |
| Supported release types      | https://github.com/googleapis/release-please/blob/main/docs/customizing.md       |

Use `WebFetch` on these URLs to get current documentation before proceeding.

**Action version pin:** `@v5` (Apr 2026) and `@v4` are both actively maintained. v5 only changes the runner runtime from Node 20 to Node 24 — no input/output changes. v4 still receives library bumps and is the safer pin for self-hosted runners that haven't upgraded to Node 24. **Avoid `@v3`** — it's deprecated and uses a different output shape (`release_created` singular instead of `releases_created` plural).

**Library version:** release-please-action v5.0.0 bundles release-please library v17.6.0. The library is actively maintained (monthly releases) as of May 2026.

## Quick Start

1. **Detect project type** (package.json, deno.json, Cargo.toml, pyproject.toml, etc.)
2. **Check for existing release workflows** in `.github/workflows/`
3. **Create release-please config files** at project root
4. **Create or update the release workflow** (single workflow containing release + publish jobs)
5. **Verify** the project uses conventional commits (check git log)

## Detailed Workflow

### Step 1: Detect Project Type and Registry

Read the project's manifest file to determine:

- **Language/ecosystem**: Node (npm), Deno (JSR), Rust (crates.io), Python (PyPI), Go, etc.
- **Package name**: From the manifest (package.json `name`, deno.json `name`, etc.)
- **Current version**: From the manifest
- **Monorepo or single package**: Check for workspaces, multiple package dirs

Map to the correct `release-type`:

| Ecosystem     | release-type | Version file                                    |
| ------------- | ------------ | ----------------------------------------------- |
| Node.js (npm) | `node`       | `package.json`                                  |
| Deno (JSR)    | `node`       | Use `extra-files` with jsonpath for `deno.json` |
| Rust          | `rust`       | `Cargo.toml`                                    |
| Python        | `python`     | `pyproject.toml` or `setup.py`                  |
| Go            | `go`         | No version file (tag-based)                     |
| Simple/other  | `simple`     | `version.txt`                                   |

For Deno/JSR projects, use `release-type: node` with `extra-files` to update `deno.json`:

```json
{
  "extra-files": [{ "type": "json", "path": "deno.json", "jsonpath": "$.version" }]
}
```

**Pre-1.0 projects:** add `"bump-minor-pre-major": true` so `feat:` bumps minor (0.2.0 -> 0.3.0) and `fix:` bumps patch. Without this, 0.x projects stay flat because feat-to-minor only applies at >= 1.0.

### Step 2: Check Existing Workflows

Read `.github/workflows/` for existing publish/release workflows. Common patterns:

- **Publish on push to main**: Should be changed to publish conditionally via release-please.
- **Publish on release event**: Can be kept as a manual fallback, but will not auto-fire from release-please (see Gotchas).
- **No existing workflow**: Create a single release workflow with both jobs.

### Step 3: Create Config Files

**`release-please-config.json`** (project root):

```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "packages": {
    ".": {
      "package-name": "<package-name>",
      "release-type": "<type>",
      "extra-files": []
    }
  }
}
```

For monorepos, add each package under `packages` with its relative path as the key. See [references/monorepo.md](references/monorepo.md).

**`.release-please-manifest.json`** (project root):

```json
{ ".": "<current-version>" }
```

Bootstrap with the current version from the project manifest. For projects with pre-existing history that doesn't match release-please's expectations, see [references/first-release-bootstrap.md](references/first-release-bootstrap.md).

### Step 4: Create GitHub Actions Workflow

The publish job **MUST** live in the same workflow file as release-please. A separate workflow triggered by `on: release` will not fire because GitHub prevents `GITHUB_TOKEN`-created events from triggering other workflows.

```yaml
name: Release Please

on:
  push:
    branches:
      - main

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: false

jobs:
  release-please:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    outputs:
      releases_created: ${{ steps.release.outputs.releases_created }}
      tag_name: ${{ steps.release.outputs.tag_name }}
    steps:
      - uses: googleapis/release-please-action@v4
        id: release
        with:
          token: ${{ secrets.GITHUB_TOKEN }}

  publish:
    needs: release-please
    if: ${{ needs.release-please.outputs.releases_created == 'true' }}
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write # Required for OIDC (npm provenance, JSR)
    steps:
      - uses: actions/checkout@v4
      # Add setup, quality checks, and publish steps here
```

### Step 5: Add CI Workflow for PRs

Release-please PRs created with `GITHUB_TOKEN` do not trigger `pull_request` workflows automatically. A CI workflow on PRs is still valuable for human-authored PRs:

```yaml
name: CI

on:
  pull_request:
    branches:
      - main

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # Add linting, type checking, test steps
```

Because release PRs skip this workflow, repeat the same quality checks inside the `publish` job before the actual publish step.

### Step 6: Handle Formatter Conflicts

Release-please generates `CHANGELOG.md` with its own formatting (e.g., `*` for list markers). If the project uses a formatter that enforces different conventions, exclude `CHANGELOG.md` from formatting:

- **Deno**: Add `"exclude": ["CHANGELOG.md"]` to the `fmt` section in `deno.json`
- **Prettier**: Add `CHANGELOG.md` to `.prettierignore`
- **ESLint**: Add `CHANGELOG.md` to `.eslintignore` or `ignorePatterns`

### Step 7: Update Existing Publish Workflows

If the project has an existing publish workflow triggered on `push: main`:

1. Remove the `push` trigger (publishing now runs inside the release workflow).
2. Optionally keep `release: types: [published]` as a manual fallback (it will not auto-fire from release-please, but works for `gh release create`).

## Common Patterns

### OIDC-Authenticated Publishing

npm (with provenance) and JSR both support OIDC. Skip long-lived API tokens entirely:

```yaml
permissions:
  contents: read
  id-token: write
steps:
  - uses: actions/checkout@v4
  # npm with provenance:
  - run: npm publish --provenance --access public
  # OR JSR:
  - run: deno publish
```

No `NPM_TOKEN` or JSR auth secret required. See [references/token-strategy.md](references/token-strategy.md) for when OIDC is insufficient.

### Syncing Version Across Multiple Files

Use `extra-files` with jsonpath to keep version in sync across `deno.json`, plugin manifests, README badges, etc:

```json
{
  "extra-files": [
    { "type": "json", "path": "deno.json", "jsonpath": "$.version" },
    { "type": "json", "path": "plugin.json", "jsonpath": "$.version" },
    { "type": "json", "path": "plugin.json", "jsonpath": "$.mcpServers[*].version" }
  ]
}
```

Supported types: `json`, `yaml`, `toml`, `generic` (regex-based). See [manifest-releaser.md](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md) for full syntax.

### Floating Major-Version Tag

Consumers of reusable GitHub Actions often pin to `@v1`. Maintain a floating major tag with a post-release job:

```yaml
major-tag:
  needs: release-please
  if: ${{ needs.release-please.outputs.releases_created == 'true' }}
  runs-on: ubuntu-latest
  permissions:
    contents: write
  steps:
    - uses: actions/checkout@v4
      with:
        fetch-depth: 0
    - name: Update major version tag
      env:
        TAG: ${{ needs.release-please.outputs.tag_name }}
      run: |
        MAJOR=$(echo "$TAG" | sed -E 's/^v?([0-9]+).*/v\1/')
        git tag -f "$MAJOR" "$TAG"
        git push origin "$MAJOR" --force
```

### Concurrency Control

Prevent overlapping release runs when multiple commits land in quick succession:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: false # Let in-flight releases finish rather than kill them
```

### Downstream Post-Release Updates

Common need: after release, update a Homebrew tap, docs site, catalog, Docker Hub, etc. See [references/downstream-updates.md](references/downstream-updates.md) for the general pattern. Short version: `GITHUB_TOKEN` cannot cross repo boundaries; use a PAT or GitHub App token.

### Binary Release Artifacts

For projects that ship compiled binaries (Go, Rust, Deno compile, Bun compile), see [references/binary-artifacts.md](references/binary-artifacts.md) for the multi-target build + checksum + release upload pattern.

## Manual Overrides

Day-to-day, you'll often need to force a version bump, skip a release, or recover from a stuck release pipeline. Release-please supports several override mechanisms — pick the most local one for the job.

### Force a specific version

**Via commit footer** (most common, no config change):

```
chore: release 2.0.0

Release-As: 2.0.0
```

Or as an empty commit:

```bash
git commit --allow-empty -m "chore: release 2.0.0" -m "Release-As: 2.0.0"
git push
```

The footer is case-insensitive (`Release-As:` / `release-as:`). When present, release-please uses the footer value instead of computing a bump from commits.

**Via config field** (sticky until removed):

```json
{ "packages": { ".": { "release-as": "2.0.0" } } }
```

Remove `release-as` after the release is cut, or every subsequent PR keeps forcing 2.0.0.

**Via action input** (added in `release-please-action@v4.4.0`):

```yaml
- uses: googleapis/release-please-action@v4
  with:
    release-as: 2.0.0
```

Useful when paired with `workflow_dispatch` for ad-hoc releases triggered from the GitHub UI.

### Force a bump direction (always-bump-\*)

`versioning-strategy` overrides Conventional Commits parsing entirely. Set in config or as an action input (action input added in v4.4.0):

| Strategy            | Effect                                                           |
| ------------------- | ---------------------------------------------------------------- |
| `default`           | Conventional Commits (feat -> minor, fix -> patch, `!` -> major) |
| `always-bump-patch` | Every release is a patch bump                                    |
| `always-bump-minor` | Every release is a minor bump                                    |
| `always-bump-major` | Every release is a major bump                                    |
| `service-pack`      | Increments the patch suffix (for service-pack release lines)     |
| `prerelease`        | Bumps the prerelease identifier                                  |

### Force a major bump from a single commit

Use `!` after the type, or add a `BREAKING CHANGE:` (or `BREAKING-CHANGE:`) footer:

```
feat!: rename `foo` to `bar`
```

Or:

```
feat: rename `foo` to `bar`

BREAKING CHANGE: `foo` is now `bar`
```

For pre-1.0 projects, breaking changes still only bump minor by default. Set `"bump-patch-for-minor-pre-major": true` to instead bump patch on breaking changes pre-1.0.

### Force release-please to re-run

If a release PR didn't open after qualifying commits, or didn't tag after merge, apply the **`release-please:force-run`** label to the merged release PR (or the latest merged PR with qualifying commits). Release-please picks this up on its next workflow run and reprocesses the release. This is the canonical fix for "release PR stale" and "tag workflow didn't fire" states.

You can also push an empty commit to kick the workflow:

```bash
git commit --allow-empty -m "chore: trigger release-please"
git push
```

### Skip a release

- **Per-commit**: use a non-releasable type (`chore:`, `docs:`, `ci:`, `style:`, `test:`, `refactor:`, `build:`). These are excluded from version bumps by default.
- **Per-workflow run**: set `skip-github-release: true` and/or `skip-github-pull-request: true` on the action.
- **Skip changelog only** (cut the release tag, don't touch CHANGELOG): `"skip-changelog": true` in config (release-please v17.1+).

### Skip CI labeling

Set `skip-labeling: true` on the action (added in v4.2.0) if branch protection rules or repo policies make the auto-applied labels (`autorelease: pending`, `autorelease: tagged`) inconvenient. The state machine still works because release-please reads commit + PR metadata too, but recovery via the `force-run` label still expects labels to be writable.

### Prereleases

Alpha, beta, rc, and custom prerelease identifiers are a dedicated topic. See [references/prereleases.md](references/prereleases.md).

## Troubleshooting

The single most useful debugging signal is the PR label: `autorelease: pending` vs `autorelease: tagged`. Pending means the release PR exists and is awaiting merge. Tagged means the release has been cut (post-merge state).

| Symptom                                             | Likely cause                                                                      | Fix                                                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| No release PR created                               | No qualifying commits since last release (all `docs:`/`chore:`/`ci:`)             | Check `git log` since last tag. Add a `feat:` or `fix:`.                                         |
| No release PR despite qualifying commits            | Branch protection blocks GITHUB_TOKEN PRs                                         | Allow Actions to open PRs in repo settings (Settings > Actions > General).                       |
| Release PR stale / state machine stuck              | Race or transient API failure left release-please mid-state                       | Apply the `release-please:force-run` label to the merged release PR, then re-run the workflow.   |
| Tag wasn't created after release PR merge           | Release-please missed the tag step (workflow killed, API timeout, label mishap)   | Apply `release-please:force-run` to the merged release PR. Re-run the workflow.                  |
| Version didn't bump as expected                     | `bump-minor-pre-major` missing on 0.x project                                     | Add the flag.                                                                                    |
| Release PR shows stale forced version               | Old `release-as` still in config                                                  | Remove after use.                                                                                |
| Tag format wrong (missing `v`, missing component)   | Missing `include-v-in-tag` or `component` config                                  | See customizing docs.                                                                            |
| Release PR merged but no GitHub release             | Workflow failed after release-please step, or `skip-github-release: true`         | Check workflow run logs.                                                                         |
| Publish job didn't run on merge                     | Wrong output name in `if:`                                                        | v4 manifest mode uses `releases_created` (plural).                                               |
| Version in manifest but not in `extra-files` target | Wrong `type` or `jsonpath`                                                        | Test jsonpath against the file; `json` type requires valid JSON.                                 |
| Release PR body shows old version/changelog         | PR description stale after force-push; the release branch has the correct content | Inspect the release branch's `CHANGELOG.md` directly, not the PR body.                           |
| Cannot manually rerun the release workflow          | No `workflow_dispatch:` trigger                                                   | Add `workflow_dispatch:` to the workflow's `on:` block.                                          |
| New `fix:` commit not in the open release PR        | Release-please folds new commits into the in-flight PR on the next workflow run   | Expected behavior. Wait for the next push to `main`, or push an empty commit to force a refresh. |

## Gotchas

1. **`GITHUB_TOKEN` releases don't trigger other workflows.** The publish job MUST live in the same workflow file as release-please. A separate `publish.yml` with `on: release` will not fire from release-please automation.

   **Caveat:** `on: release` _does_ fire for manually-created releases (via `gh release create` or the GitHub UI). A few projects rely on this for a one-time bootstrap, then depend on in-workflow publish thereafter. This is fragile; prefer the unified-workflow approach unless there's a compelling reason.

   **Workaround when chaining is required:** Pass a PAT or GitHub App token to the action's `token:` input. Events from those identities _do_ trigger downstream workflows. See [token-strategy.md § Bypassing the GITHUB_TOKEN Trigger Limit](references/token-strategy.md).

2. **Release-please PRs don't trigger PR workflows.** Pushes made with `GITHUB_TOKEN` don't create `pull_request` events. Repeat quality checks inside the publish job.

3. **Formatter conflicts with CHANGELOG.md.** Release-please uses `*` for list items. Most formatters rewrite to `-`. Exclude `CHANGELOG.md` from formatting or CI will fail.

4. **Deno projects use `node` release-type, not `simple`.** `simple` only manages `version.txt`. `node` generates proper changelogs. Use `extra-files` with jsonpath for `deno.json`.

5. **After merging a release PR, pull locally.** The PR modifies the manifest and `CHANGELOG.md`. Pull before pushing new commits.

6. **Conventional commits are required.** `feat:` = minor, `fix:` = patch, `feat!:` or `BREAKING CHANGE:` = major. Default releasable types are `feat`, `fix`, `perf`, and `deps`. Everything else (`chore`, `build`, `docs`, `style`, `test`, `ci`, `refactor`) is non-releasable by default — customize via `changelog-sections`.

7. **The config JSON schema lags reality.** Upstream tracks this in [release-please#2518](https://github.com/googleapis/release-please/issues/2518). Verify config field support against the library version your action pin bundles, not against the schema alone.

## Known Upstream Issues (verify if affected)

Spot-checked against open issues as of May 2026. Re-check before recommending workarounds.

- **`separate-pull-requests: true` with Go monorepos** can fail with "A pull request already exists" on release-please library v17.6.0. Pin the action to a v4.x release that bundles v17.5.x if affected.
- **`include-commit-authors`** (v17.5.0) is currently a no-op — author metadata is dropped.
- **`chore(deps)` commits** are recognized by the dependency manifest plugin but don't trigger releases. Use `fix(deps):` to trigger a patch release from a dependency bump.
- **Label-application races**: occasional 422s when release-please tries to label a freshly created PR. Workflow retry usually clears it.

## References

Focused reference docs:

- **[First-release bootstrap](references/first-release-bootstrap.md)** — Adopting release-please in a project with existing history.
- **[Monorepo setup](references/monorepo.md)** — Multi-package configs, `separate-pull-requests`, linked versions.
- **[Downstream updates](references/downstream-updates.md)** — Post-release jobs that touch other repos.
- **[Binary artifacts](references/binary-artifacts.md)** — Multi-target compile + checksum + release upload.
- **[Token strategy](references/token-strategy.md)** — `GITHUB_TOKEN` vs OIDC vs PAT vs GitHub App token.
- **[Prereleases](references/prereleases.md)** — Alpha/beta/rc configurations.

Upstream:

- [release-please-action README](https://github.com/googleapis/release-please-action)
- [Manifest config docs](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md)
- [Customizing release-please](https://github.com/googleapis/release-please/blob/main/docs/customizing.md)
