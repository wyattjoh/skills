# Token Strategy

Choosing the right auth mechanism for each job in a release pipeline. Wrong choice leads to permission errors, security exposure, or workflows that silently fail.

## Decision Tree

```
Is this job operating only on the current repo?
├── Yes: Does it publish to npm/JSR/PyPI?
│   ├── Yes: Use OIDC (id-token: write). No token needed.
│   └── No: Use GITHUB_TOKEN.
└── No (cross-repo work): Is this org-scoped automation?
    ├── Yes: Use GitHub App token (create-github-app-token).
    └── No (personal/single-repo): Use fine-grained PAT.
```

## `GITHUB_TOKEN`

Default token, injected automatically. Scoped to the current repo.

**Use for:**

- All release-please work within the repo.
- Uploading release assets (`gh release upload`).
- Reading workflow state, labels, PRs.

**Cannot:**

- Push to other repos.
- Trigger workflows in the current repo when it creates commits/releases (by design, to prevent loops).
- Access org-level resources beyond the current repo.

**Permissions** are set per-job and per-workflow:

```yaml
permissions:
  contents: write # push tags, create releases
  pull-requests: write # open PRs
  id-token: write # OIDC
```

Be explicit. Default permissions changed across GitHub versions; assume nothing.

## OIDC (`id-token: write`)

Short-lived JWT issued by GitHub at job start. Used by registries that trust GitHub's OIDC provider.

**Supported registries:**

- **npm** — `npm publish --provenance --access public`. Requires account-level opt-in on npmjs.com.
- **JSR** — `deno publish` (and `npx jsr publish`). Uses OIDC automatically when running in GitHub Actions.
- **PyPI** — Trusted publishing. Configure publisher in PyPI project settings.
- **crates.io** — Trusted publishing (newer; check current support).
- **AWS, GCP, Azure** — For cloud ops. Not release-please concerns, but same mechanism.

**Advantages:**

- No long-lived secret to rotate or leak.
- Attestations/provenance for free on supported registries.
- Provably published from CI (not a developer laptop).

**Requires:** `permissions: id-token: write` at the job level.

## Fine-Grained PAT

Personal access token scoped to specific repos and narrow permissions.

**Use for:**

- Cross-repo work when a GitHub App is overkill.
- Personal automation (one developer's projects).

**Setup:**

1. GitHub Settings > Developer Settings > Personal Access Tokens > Fine-grained.
2. Select target repos (not "All repositories").
3. Grant only needed permissions: typically `Contents: Read and Write` and `Pull requests: Read and Write`.
4. Set expiration; calendar a rotation reminder.

**Storage:** In the source repo's secrets, not at the org level (unless shared across multiple release pipelines).

## Classic PAT

Broad-scope token. Older mechanism. Avoid when possible.

**Only use when:**

- Fine-grained PATs don't support a needed API endpoint.
- Interacting with GitHub APIs that predate the fine-grained model.

**Scopes:** `repo` gives full access to all your repos, public and private. Consider this a blast-radius risk.

## GitHub App Token

Issued per installation. Preferred for org-owned automation.

**Setup:**

1. Create a GitHub App in org settings.
2. Define permissions (e.g., `Contents: Read and Write`, `Pull requests: Read and Write`).
3. Install on target repos.
4. Store app ID in repo vars; private key in secrets.

**Use in workflows:**

```yaml
- uses: actions/create-github-app-token@v1
  id: app-token
  with:
    app-id: ${{ vars.BOT_APP_ID }}
    private-key: ${{ secrets.BOT_PRIVATE_KEY }}
    owner: ${{ github.repository_owner }}
    repositories: |
      downstream-one
      downstream-two

- env:
    GH_TOKEN: ${{ steps.app-token.outputs.token }}
  run: gh api ...
```

**Advantages over PAT:**

- Not tied to a person; doesn't break when they leave.
- Short-lived tokens (1 hour); no manual rotation.
- Installation-scoped; visible and auditable in org settings.
- Commits attributed to "App-name[bot]".

**When to use:**

- Multiple repos need the same bot.
- Org has compliance requirements around non-personal automation.
- PAT rotation has been a pain point.

## Bypassing the GITHUB_TOKEN Trigger Limit

`GITHUB_TOKEN`-created events (release, push, PR merge) don't trigger other workflows. Workarounds:

1. **Keep dependent jobs in the same workflow.** The simplest solution; works for most release-please setups.
2. **Use a PAT for the commit/release.** Events from PAT-authored actions _do_ trigger workflows. Pass the PAT to the release-please-action's `token:` input. Caveat: all bot commits now appear as that PAT's owner.
3. **Use a GitHub App token.** Same behavior as PAT (events trigger workflows), with better auditability.

For most projects, option 1 is correct. Only move to 2 or 3 if you have a strong reason (e.g., downstream repos that must react to the release event type specifically).

## Secrets Hygiene

- **Never print tokens.** Use `env:` for secrets, avoid `run: echo $TOKEN`.
- **Don't commit `.env` files** with tokens; use repo secrets.
- **Minimum permissions.** Start from zero and grant only what's needed.
- **Rotate on staff changes.** PATs are tied to individuals; plan for departures.
- **Monitor usage.** GitHub shows token usage in the UI; review periodically.
