# First-Release Bootstrap

Adopting release-please in an existing project is the most error-prone step. Once the first release PR is merged cleanly, subsequent releases are automatic. Getting there depends on the project's history.

## Scenario A: Greenfield Project (No Tags)

Easiest case. Set the manifest to your starting version:

```json
{ ".": "0.1.0" }
```

On the first `feat:` or `fix:` commit after setup, release-please opens a PR bumping to the next version. Merge it; you get `v0.2.0` (with `bump-minor-pre-major`) or `v0.1.1`.

**Tip:** If you want your first release to be `0.1.0` itself rather than `0.2.0`, set manifest to `0.0.0` and add `"release-as": "0.1.0"` to the config temporarily. Remove `release-as` after the first release.

## Scenario B: Existing Project with Matching Tags

Your tag history already looks like `v1.2.3`, `v1.2.4`. Set the manifest to the latest version:

```json
{ ".": "1.2.4" }
```

Release-please will pick up any commits since the most recent tag and propose the next version. **Check the proposed CHANGELOG carefully on the first PR** — it may include older commits that predate your conventional-commit adoption.

## Scenario C: Existing Project with Non-Matching History

Your tags don't match release-please's format (e.g., plain `1.2.3` without `v`, or idiosyncratic like `release-2024-01-15`). Two options:

**Option 1: Configure tag format to match history.**

```json
{
  "include-v-in-tag": false,
  "packages": {
    ".": {
      "tag-separator": "-",
      "include-component-in-tag": false
    }
  }
}
```

**Option 2: Set `bootstrap-sha` and start fresh.**

```json
{
  "bootstrap-sha": "abc123def456",
  "packages": { ".": { "release-type": "node" } }
}
```

Release-please only considers commits after this SHA. Use this when:

- Old commit history doesn't follow conventional commits.
- You're adopting release-please mid-project and want a clean slate.

Choose a SHA roughly where your team started using conventional commits.

## Scenario D: Pre-1.0 Project with Active 0.x Development

Set `bump-minor-pre-major: true`:

```json
{
  "packages": {
    ".": {
      "release-type": "node",
      "bump-minor-pre-major": true,
      "bump-patch-for-minor-pre-major": true
    }
  }
}
```

Without these:

- `feat:` commits stay on patch (0.1.0 -> 0.1.1) until you manually cut 1.0.0.
- You lose the "minor = breaking is OK in 0.x" convention.

With both flags:

- `feat:` -> minor bump (0.1.0 -> 0.2.0)
- `fix:` -> patch bump (0.1.0 -> 0.1.1)
- `feat!:` / `BREAKING CHANGE:` -> still only minor in 0.x

## Verifying the First Release PR

Before merging the first release PR, check:

1. **Version number** is what you expected.
2. **CHANGELOG entries** only include commits after the last release or bootstrap SHA.
3. **`extra-files` targets** are updated (deno.json version, plugin.json, etc.).
4. **Tag format** in the PR description matches your intent.

If the PR is wrong, delete the release branch (release-please will recompute on the next push) or close the PR. Do not merge and try to patch afterward.

## Recovering from a Bad First Release

If you merged a bad release:

1. Delete the bad tag locally and remotely: `git tag -d v1.0.0 && git push origin :refs/tags/v1.0.0`.
2. Delete the GitHub release via `gh release delete v1.0.0`.
3. Revert the release PR's commit (or manually fix the manifest/CHANGELOG).
4. Push. Release-please will compute the next release from the corrected state.

This is survivable but disruptive if the release was already published to npm/JSR/crates.io (which cannot be un-published after a short window).
