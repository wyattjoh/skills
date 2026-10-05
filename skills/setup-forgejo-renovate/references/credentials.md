# Credentials

## Real bot identity

Reuse the forge's existing Renovate account when appropriate. Verify its full name and email are configured and it has repository write access. Confirm any new account or collaborator grant with the operator first.

The Forgejo built-in Actions token uses a synthetic identity, not the real bot needed by Renovate's PR-author queries. Use the bot's PAT, not the built-in token or the maintainer's personal Forgejo token.

## Operator setup

1. Sign into Forgejo as the bot, preferably in a separate browser session. Open `<forge-origin>/user/settings/applications` and generate a named PAT with repository read/write, issue read/write, and user read. Renovate also documents organization read for organization labels/teams. Select only needed scopes and restrict repository coverage when supported.
2. Save the one-time value in the operator's password manager. As the repository owner, store it as the Actions secret `RENOVATE_TOKEN`.
3. From any suitable GitHub account, create a PAT with read-only access to public repositories for GitHub-hosted Actions and changelogs. A classic token with no scopes is sufficient for this public-only setup. Choose an expiration and a renewal owner; neither `repo` nor `workflow` write scopes are needed.
4. Save that value in the password manager and install it as `RENOVATE_GITHUB_COM_TOKEN` in the target's Actions secrets.

Repository secrets live under `<forge-origin>/<owner>/<repo>/settings/actions/secrets`. Paste bare values, without quotes or a Bearer prefix. Use the forge's UI or a supported secret-safe stdin/API mechanism. Never pass PATs as CLI arguments.

## Verify availability

Classify each secret referenced by the workflow as repository-scoped, inherited and available, or pending. Read names/metadata only. A repository-secret listing can omit inherited credentials; missing from that listing alone does not prove a secret is unavailable. If an inherited scope cannot be inspected through the API, have the operator check the UI or verify availability through an authenticated workflow run.

Use `forgejo` CLI agent mode with explicit host and repository for supported operations, and follow its approval grant flow for mutations. Confirm collaborator permission separately from token scope: neither substitutes for the other.

Done when the job has both credentials at an available scope and authenticates as the confirmed bot. The workflow's empty-secret errors prove only that values were not injected, not that populated tokens have correct permissions.

Primary references: [Renovate Forgejo permissions](https://docs.renovatebot.com/modules/platform/forgejo/), [GitHub lookup token](https://docs.renovatebot.com/getting-started/running/#githubcom-token-for-changelogs-and-tools), [Forgejo token creation](https://forgejo.org/docs/latest/user/api-usage/).
