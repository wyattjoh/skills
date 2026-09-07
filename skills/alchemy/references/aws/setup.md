<!-- source: https://alchemy.run/aws/setup
     upstream: website/src/content/docs/aws/setup.mdx
     alchemy 2.0.0-beta.75 @ 808ef69 -->

# Setup

> Install Alchemy and connect it to your AWS account — SSO, environment variables, or stored access keys.

## Prerequisites

- [Bun](https://bun.sh) (recommended) or Node.js 22+
- An AWS account and an IAM identity with permission to create
  the resources you plan to deploy

## Create a project

```sh
mkdir my-app && cd my-app && bun init -y
```

## Install

```sh
bun add "alchemy@latest" "effect@rc" "@effect/platform-bun@rc" "@effect/platform-node@rc"
```

## How Alchemy gets AWS credentials

The first time you `alchemy deploy` (or `plan`, `dev`,
`destroy`) a stack that uses `AWS.providers()`, Alchemy prompts
you to pick an authentication method. The choice is saved to
your **`default`** [profile](/environments/profiles) and reused on
every subsequent command.

There are three methods:

### SSO (recommended)

Alchemy runs `aws sso login --profile <name>` for you and loads
credentials from the AWS SSO cache. You pick which profile from
`~/.aws/config` to use; the account ID and region come from that
profile. When the SSO session expires, run `alchemy login` to
refresh it.

### Environment variables

Alchemy reads the standard AWS variables from the environment on
every run:

```sh
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_SESSION_TOKEN=...   # optional
export AWS_REGION=us-east-1    # or AWS_DEFAULT_REGION
```

The region is required. The account ID is taken from
`AWS_ACCOUNT_ID` if set, otherwise resolved once via STS
`GetCallerIdentity`. This is the method to use in CI — when
Alchemy detects `CI=true` it skips the interactive prompt and
uses environment variables automatically.

### Stored access keys

Paste an access key ID, secret access key, optional session
token, and region into the interactive prompt. Alchemy verifies
them against STS and saves them under
`~/.alchemy/credentials/<profile>/` for future runs.

## Managing credentials

Re-run the setup at any time (e.g. to switch from stored keys to
SSO, or to configure a separate `prod` profile):

```sh
alchemy login --configure
alchemy login --profile prod --configure
```

Inspect what's stored (secrets are redacted):

```sh
alchemy profile show
```

See [Profiles](/environments/profiles) for switching between
profiles with `--profile` or `$ALCHEMY_PROFILE`.

## State storage

For AWS stacks, pass `AWS.state()` as the Stack's `state`
option. Deploy state is stored in an account-regional S3 bucket
(`alchemy-state-{accountId}-{region}-an`), created lazily on the
first deploy — the same configuration works locally and in CI
with no extra setup. For purely local iteration,
`Alchemy.localState()` writes state under `.alchemy/` next to
your code instead.

## Next steps

- [AWS overview](/aws) — pick a runtime and resources.
- [Lambda](/aws/compute/lambda) — deploy your first function with a
  public URL.
- [Secrets & env](/aws/security/secrets-env) — profile credentials
  deploy the stack; app secrets are bindings on the function.
