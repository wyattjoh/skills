# Prereleases

Alpha, beta, rc, and other pre-stable release tags. Release-please supports these via the `prerelease` config and commit-type conventions.

## Enabling Prereleases

In `release-please-config.json`:

```json
{
  "packages": {
    ".": {
      "release-type": "node",
      "prerelease": true,
      "prerelease-type": "alpha"
    }
  }
}
```

With `prerelease: true`, release-please produces versions like `1.0.0-alpha.1`, `1.0.0-alpha.2`, etc.

`prerelease-type` values: `alpha`, `beta`, `rc`, or any custom string. The identifier appears in the version string.

## Branch-Based Prereleases

A common pattern: use a separate branch for prereleases (e.g., `next`, `beta`) while `main` cuts stable releases.

```yaml
# .github/workflows/release-next.yml
on:
  push:
    branches:
      - next

jobs:
  release-please:
    runs-on: ubuntu-latest
    steps:
      - uses: googleapis/release-please-action@v4
        with:
          target-branch: next
          config-file: release-please-config-next.json
          manifest-file: .release-please-manifest-next.json
```

With a parallel config file:

```json
{
  "packages": {
    ".": {
      "release-type": "node",
      "prerelease": true,
      "prerelease-type": "next"
    }
  }
}
```

Produces `1.1.0-next.1`, `1.1.0-next.2`, etc. Merges from `next` to `main` later cut the stable `1.1.0`.

## npm Dist Tags

Publish prereleases to a non-default npm dist tag so `npm install mypackage` doesn't pick them up:

```yaml
publish:
  steps:
    - run: |
        if [[ "${{ needs.release-please.outputs.tag_name }}" =~ -(alpha|beta|rc|next) ]]; then
          npm publish --provenance --access public --tag ${BASH_REMATCH[1]}
        else
          npm publish --provenance --access public
        fi
```

Users opt in with `npm install mypackage@next`.

## JSR and Prereleases

JSR supports prerelease versions (SemVer-compatible) but does not have a dist-tag equivalent. Users must explicitly depend on the prerelease version:

```json
{ "imports": { "mypackage": "jsr:@org/mypackage@^1.0.0-alpha.1" } }
```

No special publish config required beyond the normal `deno publish`.

## Promoting a Prerelease to Stable

When a prerelease is ready to become stable:

1. Merge the prerelease branch to `main`.
2. Release-please on `main` sees the accumulated commits and cuts `1.1.0` (stable).
3. The prerelease versions (`1.1.0-alpha.N`) remain published on the registry for consumers who pinned to them.

Alternatively, force a specific version via commit footer:

```
chore: promote to stable

Release-As: 1.1.0
```

## Gotchas

1. **Prerelease versions count as released.** They can't be un-published (beyond the registry's short grace window). Treat them as public.
2. **Two-branch setup means two manifests.** `main` and `next` each have their own `.release-please-manifest.json`. Keep them in sync carefully; drift leads to version conflicts.
3. **`bump-minor-pre-major` still applies** to the stable version. Prerelease configuration doesn't override it.
4. **Changelog section** for prereleases mixes with stable by default. Consumers reading the CHANGELOG see `1.1.0-alpha.1` entries above `1.0.0`. Use `changelog-path` to split if this is a problem.
5. **Prerelease tags don't always satisfy range requirements.** `^1.0.0` does _not_ match `1.1.0-alpha.1` in most package managers (npm, JSR, cargo). Consumers must opt in explicitly.
