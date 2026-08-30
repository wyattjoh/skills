<!-- source: https://alchemy.run/fly/tutorial/part-1
     upstream: website/src/content/docs/fly/tutorial/part-1.mdx
     alchemy 2.0.0-beta.75 @ 808ef69 -->

# Part 1: Your First App

> Install Alchemy, create a Stack with a Fly App, and deploy it.

Install Alchemy and Effect, create a Stack with a Fly App, and
deploy it. An App is the parent for Machines, Services, Secrets,
and disks.

## Prerequisites

- [Bun](https://bun.sh) (recommended) or Node.js 22+
- A Fly organization and an API token — see [Setup](/fly/setup) if
  you haven't created those yet

:::note[Costs]
A Fly App is free. Compute (Machines / Services) is billed by the
second starting in [Part 2](/fly/tutorial/part-2). `alchemy destroy`
tears everything down when you're done.
:::

## Create a project

Start with an empty directory and initialize a `package.json`:

```sh
mkdir my-app && cd my-app && bun init -y
```

## Install dependencies

Install <code>alchemy@latest</code> and <code>effect@{effectVersion}</code>:

```sh
bun add "alchemy@latest" "effect@rc" "@effect/platform-bun@rc" "@effect/platform-node@rc"
```

## Create the Stack

Every Alchemy program starts with a `Stack` — a collection of
Resources managed by Providers with state tracked between deploys.

Create an `alchemy.run.ts` file:

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Alchemy.Stack(
  "MyApp",
  {
  // @error: ts(2345) Argument of type '{ providers: Layer.Layer<never, never, never>; }' is not assignable to parameter of type 'StackProps<never>'.
  // @error:   Property 'state' is missing in type '{ providers: Layer.Layer<never, never, never>; }' but required in type 'StackProps<never>'.
    providers: Layer.empty,
  },
  Effect.gen(function* () {
    // we'll add resources here next
  }),
);
```

TypeScript is unhappy: the `state` property is required. Every Stack
needs a **state store** so Alchemy can persist resource state between
deploys and compute diffs against your infrastructure.

## Configure state

Fly has no state backend of its own, so we'll keep state on disk
with `Alchemy.localState()` — it writes to `.alchemy/` next to your
code, no setup required:

```diff lang="typescript"
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Layer.empty,
+    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    // we'll add resources here next
  }),
);
```

:::note[Other state stores]
Local state is perfect for a solo project. When you need state your
team and CI can share, swap in `Cloudflare.state()` or `AWS.state()`
— see [State Store](/state-store).
:::

## Add an App

Resources represent cloud infrastructure. Each resource is
`yield*`-ed inside the Stack's Effect generator.

Let's declare a Fly App and observe the type error:

```diff lang="typescript"
// alchemy.run.ts
import * as Alchemy from "alchemy";
+import * as Fly from "alchemy/Fly";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Layer.empty,
    // @error: ts(2322) Type 'Layer<never, never, never>' is not assignable to type 'Layer<NoInfer<Providers>, never, StackServices>'.
    // @error:   Type 'Providers' is not assignable to type 'never'.
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
+    const site = yield* Fly.App("Site");
  }),
);
```

Omit `name` and Alchemy generates a globally unique, DNS-safe App
name (max 30 characters, leading letter). The org defaults to
whatever org your token belongs to.

TypeScript is telling us that `Layer.empty` doesn't provide
`Fly.Providers` — the layer required by `App`.

## Fix the Providers

Replace `Layer.empty` with `Fly.providers()` to resolve the type
error:

```diff lang="typescript"
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Fly from "alchemy/Fly";
import * as Effect from "effect/Effect";
-import * as Layer from "effect/Layer";

export default Alchemy.Stack(
  "MyApp",
  {
+    providers: Fly.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Fly.App("Site");
  }),
);
```

Now the program type-checks. The providers layer tells Alchemy how to
talk to the Fly Machines API, and the type system ensures you never
forget to wire it up.

## Return Stack outputs

Stack outputs let you see important values after a deploy. Return an
object from the generator to expose the App's name and public URL:

```typescript
  Effect.gen(function* () {
    const site = yield* Fly.App("Site");

    return {
      appName: site.appName,
      url: site.url,
    };
  }),
```

`url` is `https://{appName}.fly.dev`. Nothing is listening there yet
— that's [Part 2](/fly/tutorial/part-2).

## Deploy

Run `alchemy deploy` to create the App:

```sh
bun alchemy deploy
```

The first time you deploy, Alchemy prompts for Fly credentials —
paste the API token you generated in [Setup](/fly/setup). The token
is verified and saved to your **`default`**
[profile](/environments/profiles), so you won't be asked again.

```text
Plan: 1 to create

+ Site (Fly.App)

Proceed?
◉ Yes ○ No
✓ Site (Fly.App) created
{
  appName: "myapp-site-dev-a1b2c3d4",
  url: "https://myapp-site-dev-a1b2c3d4.fly.dev",
}
```

Alchemy shows a plan, asks for confirmation, creates the App, and
prints the stack outputs.

## Verify it worked

The App is listed in your org in the
[Fly dashboard](https://fly.io/dashboard). Run `alchemy deploy`
again. Because nothing changed, the App shows as a no-op:

```text
Plan: no changes

{
  appName: "myapp-site-dev-a1b2c3d4",
  url: "https://myapp-site-dev-a1b2c3d4.fly.dev",
}
```

This is the core loop — declare resources in code, deploy, and
Alchemy figures out what changed.

## Recap

You now have:

- An `alchemy.run.ts` with a Stack and a Fly App
- A live App in your org with a generated globally unique name
- Stack outputs showing `appName` and `https://{appName}.fly.dev`

In [Part 2](/fly/tutorial/part-2), you'll deploy code to this App —
a `Fly.Service` that bundles an Effect HTTP handler into a Machine.
