# Publish job

Pin each action to a commit SHA with its tag as a comment. Resolve current releases with `gh api repos/<owner>/<action>/releases/latest --jq .tag_name` and the SHA with `gh api repos/<owner>/<action>/commits/<tag> --jq .sha`. Trusted publishing needs npm CLI 11.5.1 or later on Node 22.14.0 or later; the `npm install -g npm@latest` step covers older bundled npm.

## Inside a release-please workflow

`GITHUB_TOKEN` releases do not trigger other workflows, so this job lives in the release-please workflow file and gates on its output.

```yaml
publish:
  needs: release-please
  if: ${{ needs.release-please.outputs.releases_created == 'true' }}
  runs-on: ubuntu-latest
  permissions:
    contents: read
    id-token: write # trusted publishing (OIDC) and provenance
  steps:
    - uses: actions/checkout@<sha> # vX.Y.Z
    # the project's own setup, install and checks (release PRs skip PR CI)
    - uses: actions/setup-node@<sha> # vX.Y.Z
      with:
        node-version: 24
        registry-url: https://registry.npmjs.org
    - run: npm install -g npm@latest
    # Skip versions already on npm, so a hand-published first release
    # and reruns stay green.
    - name: Publish to npm
      run: |
        NAME=$(node -p "require('./package.json').name")
        VERSION=$(node -p "require('./package.json').version")
        if npm view "$NAME@$VERSION" version >/dev/null 2>&1; then
          echo "$NAME@$VERSION is already published"
          exit 0
        fi
        npm publish --access public
```

## Tag-triggered variant

Use `on: push: tags: ["v*"]` with the same job body minus `needs` and `if`, and check that the tag matches `package.json` before publishing:

```yaml
- run: test "v$(node -p "require('./package.json').version")" = "$GITHUB_REF_NAME"
```

## Trust link

The trust link names the workflow by filename only (`release-please.yml`), so renaming the workflow file breaks publishing until the link is recreated. A GitHub environment in the link must match the job's `environment:`.
