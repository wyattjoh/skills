# Schema patterns and gotchas

Battle-tested `.env.schema` patterns that the decorator reference
([`env-schema.md`](env-schema.md)) does not imply. Each states the underlying
varlock semantics first, then the pattern that follows from it.

## 1. `@optional` does not make a secret reference optional

**Semantics:** `@optional` governs **validation of a resolved value**. It does not
govern **resolution**. A resolver that points at a field the secret store does not
have (`op(...)`, `pass(...)`, `protonPass(...)`, a Kubernetes key) is a _hard
resolution error_: it fails the whole config, so every command behind
`varlock run --` dies, not just the one feature that wanted the value.

This bites exactly when a config is at its most fragile: a new contributor clones
the repo, their vault item has none of the optional fields provisioned, and the dev
server refuses to boot over a feature they were never going to use.

**Pattern:** wrap the resolver so an unprovisioned field degrades to a value the
application already treats as "off".

```env-spec
# @optional @sensitive
OPTIONAL_API_KEY=fallback(secretFn(ref://vault/item/field, allowMissing=true), "")
```

- `allowMissing=true` turns the missing-field throw into `undefined`. It is a
  per-call resolver argument on most plugins; a few expose it only as an
  `@init<Plugin>(allowMissing=true)` root option, so check the plugin's option list.
- `fallback(..., "")` then pins the result to the empty string rather than
  `undefined`. Pick whichever of the two your application's off-switch actually
  tests for, and make sure that gate is a real check (see pattern 4).
- Keep `@optional` as well. `allowMissing` fixes resolution; `@optional` is still
  what makes the resolved-to-nothing value pass validation.

**Invariant to hold:** every var using this shape must have a corresponding
application-side default and an emptiness check that selects a no-op
implementation. If the app throws on an empty value instead, this pattern only
moves the failure from load time to request time.

## 2. Unset a variable in an environment overlay with `undefined`

**Semantics:** an environment overlay (`.env.<env>`) layers over the schema by
precedence, so it can _replace_ a value, not just add one. Assigning the bare
keyword `undefined` clears the variable for that environment.

```env-spec
# .env.production — committed, secret-free
DATABASE_URL=secretFn(ref://vault/prod-item/database_url)

# Explicitly unset the vars this environment must never resolve.
THIRD_PARTY_SECRET_KEY=undefined
WEBHOOK_SIGNING_SECRET=undefined
```

Pair it with a conditional requirement in the schema, or validation fails the
moment you clear the value:

```env-spec
# @type=string(startsWith=sk_) @required=forEnv(development) @sensitive
THIRD_PARTY_SECRET_KEY=secretFn(ref://vault/dev-item/secret_key)
```

`@required=forEnv(development)` makes `undefined` legal in every _other_
environment. Without it, `@required` would reject the overlay's own unset.

This is stronger than simply omitting the var from the overlay: omission inherits
the schema's value (the dev secret), whereas `undefined` guarantees a
higher-privilege environment cannot silently resolve lower-privilege credentials.

## 3. Scope an environment overlay to the tasks that actually need it

An overlay named `production` is not obliged to describe the production
_application_. A deployed app normally receives its runtime secrets from the host
(platform env, build args, an injected secret mount) and never runs varlock at all.

The useful role for a `production` overlay is **local operator tasks** — database
migrations, a schema studio, one-off scripts — that must target production
infrastructure from a workstation. Scoped that way, the overlay only needs the two
or three variables those tasks read, and pattern 2 clears everything else.

State the scope in a comment at the top of the overlay. Without it, the next reader
assumes the file is the deployed app's config and starts adding runtime vars to it,
at which point the file has quietly become a second source of truth for production.

Two things to verify when you set this up:

- The overlay's connection string points at genuinely different infrastructure from
  the default environment. If both resolve to the same host, a "production" task
  hits development data (or worse, the reverse) with no visible signal.
- Nothing in the overlay is required by a command a person runs casually. The
  selection mechanism is an environment variable (`@currentEnv=$APP_ENV`, then
  `APP_ENV=production varlock run -- <cmd>`), which is easy to set and easy to
  forget.

## 4. Absent and empty are different; a commented-out item is how you get absent

**Semantics:** an item declared in the schema is _injected_. `FOO=` injects an
empty string — the variable is present in `process.env` with a falsy value. An item
that is not declared at all is _absent_, and the application's own default applies.

These diverge whenever the consuming code parses rather than merely tests. A config
layer that reads an integer sees `""` as **present but malformed** and throws,
where absent would have cleanly selected the default.

**Pattern:** when the intended off state is "let the application default win", leave
the item commented out, and say why:

```env-spec
# # Optional tuning knob. Left commented so varlock does NOT inject it: an empty
# # string parses as present-but-malformed, so absent-and-defaulted is the off
# # state. Uncomment with a real value to override.
# # @type=number @optional
# TUNING_KNOB_MS=5000
```

The doubled `# #` keeps the decorator comments commented out along with the item;
a single `#` on the `@type` line would leave a decorator attached to whatever item
follows it.

Choose per variable, and let the consuming code decide:

| Consuming code                             | Off state    | Shape                           |
| ------------------------------------------ | ------------ | ------------------------------- |
| Tests emptiness, has a `""` default        | empty string | pattern 1's `fallback(..., "")` |
| Parses/coerces the value (number, enum, …) | absent       | commented-out item              |

## 5. Pin the plugin version; prefer desktop-app auth over a token on disk

```env-spec
# @plugin(@some/secrets-plugin@2.0.0)
# @initSecrets(allowAppAuth=true, account=my)
# ---
```

- **Pin the version.** `@plugin(@some/secrets-plugin)` floats. A plugin is
  arbitrary code in the resolution path of every secret in the project; a floating
  major can change resolver argument names or auth behavior and break every
  developer at once.
- **`allowAppAuth=true`** authenticates through the local desktop app (biometric
  unlock) instead of a service-account token. That removes the bootstrap paradox of
  the token itself being a secret that has to live in plaintext somewhere. It
  requires the app running and unlocked, so CI still needs a token — express that
  conditionally rather than switching the schema by hand:

  ```env-spec
  # @initSecrets(token=$CI_TOKEN, allowAppAuth=not($CI), account=my)
  ```

- **Standalone binary installs need the plugin cached once per machine:**
  `varlock install-plugin @some/secrets-plugin@2.0.0`. A project-dependency install
  resolves it from `node_modules` instead. Put whichever applies in the onboarding
  steps; a missing plugin fails at load with an error that reads like a schema
  problem.

## 6. Write the rationale into the schema

The schema is committed and secret-free, so it is the one file that can hold the
_why_ next to the variable it governs and still be safe to read, diff, and hand to
an agent. Prefer a prose comment above each item over the same sentence in a README
that drifts out of sync.

Worth recording per item, when non-obvious:

- What the variable turns on, and what happens when it is absent (which no
  decorator can express).
- Why it is `@optional` rather than `@required`, or why its requirement is
  conditional.
- Why it is wrapped in `fallback(...)` / left commented out — patterns 1 and 4 both
  look like clutter to a reader who does not know the failure they prevent, and get
  "cleaned up" without one.
- For a `@sensitive` item, where the value comes from and who can provision it.

Record file-wide facts in the header block above the `# ---` divider: which
environments exist, what each overlay is scoped to, and how to select one.
