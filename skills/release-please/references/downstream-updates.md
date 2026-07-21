# Downstream Post-Release Updates

Common need: after a release is cut, update something outside the source repo. Examples:

- Bump a formula in a Homebrew tap repo.
- Update an entry in a marketplace/catalog repo.
- Trigger a rebuild on a docs site.
- Push a Docker image tag.
- Notify a Slack channel.

## The Core Constraint

`GITHUB_TOKEN` is scoped to the current repository. It cannot push commits, open PRs, or trigger workflows in _other_ repos. Cross-repo work needs one of:

1. **Fine-grained PAT** — A personal access token scoped to the target repo(s).
2. **Classic PAT** — Broad scope (`repo`), less precise, easier to set up.
3. **GitHub App token** — Issued per installation, rotates automatically, scoped via the app's permissions. Preferred for org-owned automation.

See [token-strategy.md](token-strategy.md) for the decision tree.

## Three Transports

### 1. Direct File Commit via PAT

Check out the target repo, modify a file, commit, push.

```yaml
update-downstream:
  needs: release-please
  if: ${{ needs.release-please.outputs.releases_created == 'true' }}
  runs-on: ubuntu-latest
  steps:
    - name: Checkout target repo
      uses: actions/checkout@v4
      with:
        repository: org/downstream-repo
        token: ${{ secrets.DOWNSTREAM_PAT }}
        path: downstream

    - name: Update version in manifest
      working-directory: downstream
      env:
        VERSION: ${{ needs.release-please.outputs.version }}
      run: |
        jq --arg v "$VERSION" '.packages.mypackage.version = $v' manifest.json > tmp
        mv tmp manifest.json

    - name: Commit and push
      working-directory: downstream
      env:
        VERSION: ${{ needs.release-please.outputs.version }}
      run: |
        git config user.name "release-bot"
        git config user.email "release-bot@users.noreply.github.com"
        git add manifest.json
        git commit -m "chore: bump mypackage to $VERSION"
        git push
```

Best for: simple file updates where you control both repos.

### 2. `repository_dispatch`

Fire a custom event in the target repo, which runs its own workflow in response.

```yaml
- name: Trigger downstream rebuild
  env:
    GH_TOKEN: ${{ secrets.DOWNSTREAM_PAT }}
  run: |
    gh api repos/org/downstream-repo/dispatches \
      -f event_type=release-published \
      -f client_payload[version]=${{ needs.release-please.outputs.version }}
```

Target repo listens with:

```yaml
on:
  repository_dispatch:
    types: [release-published]
```

Best for: decoupling release from downstream logic; target repo owns how it reacts.

### 3. `workflow_dispatch`

Invoke a specific workflow by name.

```yaml
- name: Invoke downstream workflow
  env:
    GH_TOKEN: ${{ secrets.DOWNSTREAM_PAT }}
  run: |
    gh workflow run publish.yml \
      --repo org/downstream-repo \
      --field version=${{ needs.release-please.outputs.version }}
```

Target workflow needs `workflow_dispatch:` in its `on:` config.

Best for: triggering a specific known workflow with structured inputs.

## GitHub App Tokens

For org-owned automation, a GitHub App is cleaner than a PAT:

```yaml
- uses: actions/create-github-app-token@v1
  id: app-token
  with:
    app-id: ${{ vars.RELEASE_BOT_APP_ID }}
    private-key: ${{ secrets.RELEASE_BOT_PRIVATE_KEY }}
    owner: ${{ github.repository_owner }}
    repositories: |
      downstream-repo
      another-repo

- name: Use the app token
  env:
    GH_TOKEN: ${{ steps.app-token.outputs.token }}
  run: gh api ...
```

Advantages:

- Installation-scoped (not tied to a person).
- Rotates automatically; tokens are short-lived.
- Auditable as "Bot: X" in commit logs.

## Choosing Between Transports

| Need                                                   | Transport             |
| ------------------------------------------------------ | --------------------- |
| Simple file update, you own both repos                 | Direct file commit    |
| Downstream owns its release logic, pluggable reactions | `repository_dispatch` |
| Invoke one specific workflow with typed inputs         | `workflow_dispatch`   |
| Trigger any known workflow; want visibility in UI      | `workflow_dispatch`   |

## Security Considerations

- **Scope tokens narrowly.** Prefer fine-grained PAT or GitHub App over classic `repo`-scoped PAT.
- **Never echo tokens.** Use `env:` with secrets, never `run: echo $TOKEN`.
- **Rotate on compromise.** Keep a runbook for rotating each downstream token.
- **Audit trail.** Commits made via PAT appear as that user; App tokens appear as the app. Bots clearly labeled are easier to triage.
