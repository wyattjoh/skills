<!-- source: https://alchemy.run/getting-started
     upstream: website/src/content/docs/getting-started.mdx
     alchemy 2.0.0-beta.75 @ 808ef69 -->

# Getting started

> Install Alchemy and create your first Stack in under two minutes.

## Prerequisites

- [Bun](https://bun.sh) (recommended) or Node.js 22+
- A [Cloudflare](https://dash.cloudflare.com/sign-up) account

## Create a project

```sh
mkdir my-app && cd my-app && bun init -y
```

## Install

```sh
bun add "alchemy@latest" "effect@rc" "@effect/platform-bun@rc" "@effect/platform-node@rc"
```

## Create your Stack

Every Alchemy program starts with a Stack — create `alchemy.run.ts`:

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.Bucket("Bucket");

    return {
      bucketName: bucket.bucketName,
    };
  }),
);
```

## Deploy

Run `alchemy deploy` to create the Bucket on Cloudflare:

```sh
bun alchemy deploy
```

The first time you deploy, Alchemy walks each provider in your stack
(here, Cloudflare) through an interactive login and saves the
credentials to your **`default`** [profile](/environments/profiles) at
`~/.alchemy/profiles.json`. For Cloudflare you can sign in with
OAuth in the browser or paste an API token — no environment
variables required.

Once you're authenticated, Alchemy shows a plan, asks for
confirmation, and provisions the resource:

```text
Plan: 1 to create
+ Bucket (Cloudflare.R2.Bucket)

Proceed?
◉ Yes ○ No
✓ Bucket (Cloudflare.R2.Bucket) created
{
  bucketName: "myapp-bucket-a1b2c3d4e5",
}
```

That's it — you have a live R2 Bucket on Cloudflare.

Full command reference: [CLI](/cli).

:::tip
To re-run the credential prompt later (e.g. to switch from OAuth to
an API token, or to add a `prod` profile) use
`alchemy login --configure` or `alchemy login --profile prod --configure`.
See [Profiles](/environments/profiles) for the full picture.
:::

## Where next

<div class="next-steps">

<a href="/cloudflare/tutorial/part-1" class="next-card">
  <strong>Tutorial — recommended</strong>
  <span>Adds a Worker to this Stack and covers the core concepts.</span>
</a>

<a href="/cloudflare" class="next-card">
  <strong>Cloudflare</strong>
  <span>Pick your provider — Workers, R2, KV, D1, and more.</span>
</a>

<a href="/aws" class="next-card">
  <strong>AWS</strong>
  <span>Pick your provider — Lambda, S3, SQS, DynamoDB, and more.</span>
</a>

<a href="/migrating-from-v1" class="next-card">
  <strong>Migrating from v1</strong>
  <span>Upgrading from async/await Alchemy? Start here.</span>
</a>

<a href="/cli" class="next-card">
  <strong>CLI</strong>
  <span>Every command — deploy, destroy, dev, tail, state.</span>
</a>

</div>
