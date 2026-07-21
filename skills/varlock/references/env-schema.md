# The `.env.schema` format (`@env-spec`)

`.env.schema` is an ordinary dotenv file whose **comments carry a schema**. The
comment DSL is called `@env-spec`. varlock reads the schema, layers value files
over it, then coerces and validates each item. The schema is committed and exposes
variable _names, types, and descriptions_ but not secret _values_ — which is what
makes it safe to share with AI agents.

Decorator, type, and function lists below are drawn from the vendored docs at
`.claude/references/varlock/` (varlock 1.10.0):
[item-decorators](https://varlock.dev/reference/item-decorators/),
[root-decorators](https://varlock.dev/reference/root-decorators/),
[data-types](https://varlock.dev/reference/data-types/),
[functions](https://varlock.dev/reference/functions/).

## File shape

A schema has a **header** of root (file-wide) decorators, a `# ---` divider, then
**items**, each preceded (or followed inline) by its own decorators.

```env-spec
# Root decorators apply to the whole file
# @envFlag=APP_ENV
# @defaultSensitive=false @defaultRequired=infer
# @generateTypes(lang=ts, path=./env.d.ts)
# ---

# A description comment (no leading @) becomes the item's docs.
# @type=enum(development, staging, production)
APP_ENV=development

# @type=url @required
DATABASE_URL=

# @type=string(startsWith=sk-) @sensitive
API_KEY=
```

Source: [schema guide](https://varlock.dev/guides/schema/).

## Decorator comment syntax

- A decorator line starts with `@` (after the `#`). A `#` comment that does **not**
  start with `@` is plain description text and becomes the item's docs.
- Multiple decorators may share one line: `# @sensitive=false @required`.
- A decorator line may end in a trailing `#` comment: `# @required # must be set`.
- Item decorators may sit on the line(s) above an item, or inline after the value:
  `APP_ENV=development # @type=enum(development, staging, production)`.
- `@flag` with no value means `@flag=true` (e.g. `@required` == `@required=true`).

Source: [env-spec reference](https://varlock.dev/env-spec/reference/).

## Root decorators (header, file-wide)

| Decorator                                                                                             | Purpose                                                                   |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `@envFlag=<KEY>` / `@currentEnv=$KEY`                                                                 | Which item selects the active environment.                                |
| `@defaultRequired=true\|false\|infer`                                                                 | Default required-ness (`infer` = required if a value is present).         |
| `@defaultSensitive=true\|false`                                                                       | Default sensitivity for all items.                                        |
| `@import(<path>)`                                                                                     | Compose another schema file in.                                           |
| `@setValuesBulk(...)`                                                                                 | Bulk-set values from a source.                                            |
| `@plugin(<pkg>)`                                                                                      | Load a provider plugin (e.g. `@varlock/1password-plugin`).                |
| `@cache`                                                                                              | Configure the value cache.                                                |
| `@redactLogs` / `@preventLeaks`                                                                       | Log redaction and leak prevention toggles.                                |
| `@encryptInjectedEnv`                                                                                 | Encrypt the injected env blob.                                            |
| `@disableProcessEnvInjection`                                                                         | Do not inject into `process.env`.                                         |
| `@disable`                                                                                            | Disable an item/section.                                                  |
| `@auditIgnorePaths(...)`                                                                              | Paths for `varlock audit` to skip.                                        |
| `@generateTypes(lang=ts, path=...)`                                                                   | Generic typed-accessor generation.                                        |
| `@generateTsTypes` / `@generatePythonEnv` / `@generateRustEnv` / `@generateGoEnv` / `@generatePhpEnv` | Per-language generators (add `auto=false` to defer to `varlock codegen`). |

Source: [root-decorators](https://varlock.dev/reference/root-decorators/).

## Item decorators

| Decorator                 | Purpose                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `@type=<type>`            | Type + coercion + validation (see below).                                                    |
| `@required` / `@optional` | Presence rules. Conditional forms: `@required=forEnv(prod)`, `@required=eq($OTHER, foo)`.    |
| `@sensitive` / `@public`  | Mark (or unmark) a secret. `@public` is the opposite of `@sensitive`.                        |
| `@internal`               | Used only by varlock/other items; excluded from injected env, the blob, and generated types. |
| `@example`                | An example value for docs/tooling.                                                           |
| `@docs` / `@docsUrl`      | Attach documentation text or a URL.                                                          |
| `@icon`                   | An icon (for UI/tooling).                                                                    |
| `@auditIgnore`            | Exclude this item from `varlock audit`.                                                      |

Source: [item-decorators](https://varlock.dev/reference/item-decorators/).

## `@type` — data types

Built-in base types (each coerces + validates; many take parameters):

`string` (params like `startsWith`, `minLength`, …), `number`, `boolean`, `enum`
(e.g. `enum(development, staging, production)`), `url`, `email`, `port`, `ip`,
`semver`, `isoDate`, `uuid`, `duration`, plus `md` and `simple`.

```env-spec
# @type=string(startsWith=pk-)
PUBLISHABLE_KEY=
# @type=enum(development, staging, production)
APP_ENV=development
# @type=port
PORT=3000
# @type=url @required
DATABASE_URL=
```

Plugins add provider-specific token types (used with `@type=`), e.g.
`opServiceAccountToken` (1Password), `awsAccessKey` / `awsSecretKey`,
`azureClientId` / `azureClientSecret` / `azureTenantId`, `gcpServiceAccountJson`,
`vaultToken`, `dopplerServiceToken`, `bitwardenAccessToken`, `infisicalClientId`,
and more.

Source: [data-types](https://varlock.dev/reference/data-types/).

## Values, quoting, and expansion

```env-spec
NO_VALUE=                       # resolves to undefined
EMPTY_STRING_VALUE=""           # empty string
STATIC_VALUE_UNQUOTED=hello     # quotes optional
STATIC_VALUE_QUOTED="#hashtag"  # quotes required for special chars
BOOLEAN_VALUE=true
NUMERIC_VALUE=123.456
EXPANSION_VALUE=${OTHER_VAR}-suffix   # ${ITEM} or $ITEM expands another item
MULTILINE_VALUE="""
multiple
lines
"""
```

Source: [env-spec reference](https://varlock.dev/env-spec/reference/).

## Functions

Values can call functions instead of holding a literal. Key ones:

| Function                                                                 | Purpose                                                                                                                                     |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `ref(OTHER)`                                                             | Reference another item (shorthand: `$OTHER` / `${OTHER}`).                                                                                  |
| `concat("pre-", ref(X), "-post")`                                        | Concatenate (same as `"pre-${X}-post"`).                                                                                                    |
| `fallback($A, foo)`                                                      | First non-empty value (shell `${A:-foo}` also works).                                                                                       |
| `remap($VAR, "main", production, /.*/, preview, undefined, development)` | Lookup/map; keys may be strings, `undefined`, or regex literals.                                                                            |
| `ifs(cond1, val1, cond2, val2, default)`                                 | Ordered conditional pairs.                                                                                                                  |
| `if(cond, a, b)` / `not(x)` / `eq($X, v)` / `isEmpty(x)`                 | Boolean/conditional helpers.                                                                                                                |
| `forEnv(prod)`                                                           | True in the named environment (used with `@required`, `@sensitive`, plugin init).                                                           |
| `exec("my-cli --arg")`                                                   | Run a CLI and use its stdout. Sugar: `$(my-cli --arg)` == `exec("my-cli --arg")`. Backticks allowed: `exec(\`op read "op://app/db/url"\`)`. |
| `randomNum` / `randomUuid` / `randomHex` / `randomString`                | Generate random values.                                                                                                                     |
| `cache(...)`                                                             | Cache an expensive/secret resolution.                                                                                                       |
| `keychain(...)`                                                          | Read from the macOS Keychain (see the `keychain` command).                                                                                  |
| `varlock("local:...")`                                                   | A device-local encrypted value (produced by `varlock encrypt`).                                                                             |
| plugin functions, e.g. `op(op://vault/item/field)`                       | Resolve a secret from a provider at load time.                                                                                              |

Source: [functions](https://varlock.dev/reference/functions/);
[secrets guide](https://varlock.dev/guides/secrets/).

## Environments and file layering

Set `@envFlag` / `@currentEnv` in the header to the item that names the active
environment; varlock then auto-loads the matching `.env.[env]` files.

Value files apply in **increasing** precedence (process env always wins):

1. `.env.schema` defaults
2. `.env` (committed; discouraged for real values)
3. `.env.local` — local overrides _(gitignored)_
4. `.env.[currentEnv]` — environment-specific values (e.g. `.env.production`)
5. `.env.[currentEnv].local` — env-specific local overrides _(gitignored)_

Note: varlock matches Vite/dotenv-flow ordering; **Next.js swaps** `.env.local`
vs `.env.[currentEnv]`. Source: [environments](https://varlock.dev/guides/environments/).

## Plugins (external secret managers)

```env-spec
# @plugin(@varlock/1password-plugin)
# @initOp(token=$OP_TOKEN, allowAppAuth=forEnv(dev), account=acmeco)
# ---
# @type=opServiceAccountToken @sensitive
OP_TOKEN=
DB_PASS=op(op://my-vault/database-password/password)
```

Pre-download plugins for CI with `varlock install-plugin <name@version>`.
Documented providers include 1Password, AWS Secrets Manager, Azure Key Vault, GCP
Secret Manager, HashiCorp Vault, Bitwarden, Doppler, Infisical, and more.
Source: [plugins overview](https://varlock.dev/plugins/overview/).
