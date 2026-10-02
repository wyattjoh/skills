# Deploy workflow

The deploy job's required properties, then a skeleton. For PR preview stages and their cleanup job, read the Alchemy CI guide through the alchemy skill (`environments/ci`); this file covers the production deploy only.

## Properties

- **Trigger.** Runs on pushes to `main`, after the job that gates merges (`needs:` the aggregate CI job), never on pull requests.
- **Serialized.** A `concurrency` group with `cancel-in-progress: false`, so two merges never apply at once and a running deploy is never killed halfway.
- **Bounded.** A job `timeout-minutes`, plus step timeouts on anything that waits on the network.
- **Secrets as env.** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and every other value the stack reads through `Config` are mapped into the job's `env`. A name the stack reads but the job does not map fails at deploy time, so diff the two lists.
- **Fail fast.** After install, run `alchemy provider check-env --provider Cloudflare`. It exits 1 naming each missing credential before any build work starts.
- **Apply.** `alchemy deploy --stage prod --yes`, through the repository's package script when one exists.
- **Prove it.** A last, read-only step checks that production serves the commit just deployed (for example, read the stack's `url` output and compare a version tag). A green apply proves only that the provider accepted the change.

## Skeleton

GitHub Actions (`.github/workflows/deploy.yml`):

```yaml
name: deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    concurrency:
      group: deploy-prod
      cancel-in-progress: false
    env:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      CI: "true"
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - name: Check provider credentials
        run: bunx alchemy provider check-env --provider Cloudflare
      - name: Deploy
        run: bunx alchemy deploy --stage prod --yes
```

When the repository already has a CI workflow, add this as a job in it with `needs:` on the aggregate check and `if: github.event_name == 'push' && github.ref == 'refs/heads/main'`, rather than as a separate workflow that races it.

## Forgejo Actions

The same job works in `.forgejo/workflows/` with these differences:

- Reference actions by full URL: `https://data.forgejo.org/actions/checkout@v4`, `https://github.com/oven-sh/setup-bun@v2`. A bare `owner/action` resolves against the instance's default action host, which may not mirror it.
- `runs-on` names a label your runner registers (often `ubuntu-latest` or `docker`); check the instance's runner configuration.
- `${{ secrets.GITHUB_TOKEN }}` is the run's automatic Forgejo token, for steps that call the forge API.
