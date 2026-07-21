# Monorepo Setup

Release-please handles monorepos natively. Each package gets its own entry, own version, own changelog, and independent release cadence.

## Basic Config

```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "separate-pull-requests": false,
  "packages": {
    "packages/core": {
      "package-name": "@org/core",
      "release-type": "node"
    },
    "packages/cli": {
      "package-name": "@org/cli",
      "release-type": "node"
    },
    "services/api": {
      "package-name": "api",
      "release-type": "go"
    }
  }
}
```

Manifest mirrors the same keys:

```json
{
  "packages/core": "1.0.0",
  "packages/cli": "0.3.1",
  "services/api": "2.1.0"
}
```

## `separate-pull-requests`

The single most important monorepo knob.

| Value             | Behavior                                       | When to use                                                              |
| ----------------- | ---------------------------------------------- | ------------------------------------------------------------------------ |
| `false` (default) | One PR bumping all packages that need release. | Coordinated releases; easier to review. Most projects want this.         |
| `true`            | One PR per package.                            | Packages have very independent lifecycles; reviewers rotate per package. |

Changing this mid-project requires closing in-flight PRs.

## `linked-versions` Plugin

Force multiple packages to share a version number (useful for meta-packages or tightly-coupled libraries):

```json
{
  "plugins": [
    {
      "type": "linked-versions",
      "name": "main",
      "components": ["@org/core", "@org/cli"]
    }
  ]
}
```

When any linked package changes, all linked packages bump to the same new version. Breaks independent cadence; use sparingly.

## Path Filtering for Monorepo Workflows

Release-please still watches the whole repo, but downstream publish jobs can filter:

```yaml
publish-core:
  needs: release-please
  if: ${{ needs.release-please.outputs['packages/core--release_created'] == 'true' }}
  ...

publish-cli:
  needs: release-please
  if: ${{ needs.release-please.outputs['packages/cli--release_created'] == 'true' }}
  ...
```

Note the output name format: `<path>--<output-key>`. Because these contain `/` and `--`, access them via bracket notation with the full string key.

## Component Names and Tag Formats

By default, tags include the component: `@org/core-v1.2.3`. Control this:

- `"include-component-in-tag": false` -> tag becomes `v1.2.3` (risky with multiple packages; omit for single-package repos only).
- `"component": "core"` -> explicit component override; tag becomes `core-v1.2.3`.
- `"tag-separator": "@"` -> tag becomes `@org/core@1.2.3` (common for npm-style scoped packages).

## Shared CHANGELOG vs Per-Package

Each package gets its own `CHANGELOG.md` at its path by default. This is usually what you want. A root-level changelog is not maintained by release-please in monorepo mode.

## Common Pitfalls

1. **Manifest key mismatch with config key.** They must match exactly. `packages/core` in config requires `packages/core` in manifest, not `@org/core`.
2. **Adding a new package mid-flight.** Add to both files, set manifest to a starting version, commit. The first release PR for the new package will include its entire history as the initial changelog; usually fine, occasionally needs a `bootstrap-sha` override.
3. **Path glob patterns don't work.** Each package path must be enumerated. No wildcards.
4. **`release-type: node` for a non-Node package in a monorepo.** Still valid if you just want changelog generation and manifest bumps without touching any version file; pair with `extra-files`.
