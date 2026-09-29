# The `.env.schema` format (`@env-spec`)

`.env.schema` is an ordinary dotenv file whose **comments carry a schema**. The
comment DSL is called `@env-spec`. varlock reads the schema, layers value files
over it, then coerces and validates each item. The schema is committed and exposes
variable _names, types, and descriptions_ but not secret _values_, which is what
makes it safe to share with AI agents.

Decorator, type, and function lists below are drawn from the vendored docs at
`.claude/references/varlock/` (varlock 1.21.0):
[item-decorators](https://varlock.dev/reference/item-decorators/),
[root-decorators](https://varlock.dev/reference/root-decorators/),
[data-types](https://varlock.dev/reference/data-types/),
[functions](https://varlock.dev/reference/functions/). Behavior changes since
1.10.0 are cited from the
[changelog](https://github.com/dmno-dev/varlock/blob/varlock%401.21.0/packages/varlock/CHANGELOG.md).

## File shape

A schema has a **header** of root (file-wide) decorators, a `# ---` divider, then
**items**, each preceded (or followed inline) by its own decorators.

```env-spec
# Root decorators apply to the whole file
# @currentEnv=$APP_ENV
# @defaultSensitive=false @defaultRequired=infer
# @generateTsTypes(path=./env.d.ts)
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

| Decorator                                                                                             | Purpose                                                                                                                     |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `@currentEnv=$KEY`                                                                                    | Which item selects the active environment. (`@envFlag` is a deprecated alias, deprecated since v0.1; prefer `@currentEnv`.) |
| `@defaultRequired=true\|false\|infer`                                                                 | Default required-ness (`infer` = required if a value is present).                                                           |
| `@defaultSensitive=true\|false`                                                                       | Default sensitivity for all items.                                                                                          |
| `@defaultDynamic=true\|false\|inferFromSensitive`                                                     | Default runtime-resolved (dynamic) vs build-time (static) state; absent = follows sensitivity.                              |
| `@import(<path>, pick=[...], omit=[...])`                                                             | Compose another schema file or directory in. `pick`/`omit` take `--filter` selectors (see below).                           |
| `@setValuesBulk(...)`                                                                                 | Bulk-set values from a source.                                                                                              |
| `@plugin(<pkg>)`                                                                                      | Load a provider plugin (e.g. `@varlock/1password-plugin`).                                                                  |
| `@cache`                                                                                              | Configure the value cache.                                                                                                  |
| `@redactLogs` / `@preventLeaks`                                                                       | Log redaction and leak prevention toggles.                                                                                  |
| `@encryptInjectedEnv`                                                                                 | Encrypt the injected env blob.                                                                                              |
| `@disableProcessEnvInjection`                                                                         | Do not inject into `process.env`.                                                                                           |
| `@injectUndefinedAsEmpty`                                                                             | Inject items that resolve to `undefined` as `""` (pre-1.18.0 auto-load behavior). Default: left out of `process.env`.       |
| `@disable`                                                                                            | Disable an item/section.                                                                                                    |
| `@auditIgnorePaths(...)`                                                                              | Directories for `varlock audit` to skip (bare name, or a `./`, `../`, `~/`, absolute path).                                 |
| `@auditIgnoreKeys(KEY, PREFIX_*)`                                                                     | Keys `varlock audit` never reports as missing from the schema (scanner false positives). 1.21.0.                            |
| `@auditExtraPatterns(regex(...), fileTypes=[...])`                                                    | Extra env-access patterns for `varlock audit`; first capture group is the key. 1.19.0.                                      |
| `@proxyConfig={egress=..., reload=...}` / `@proxy(...)`                                               | Credential proxy policy and detached rules (preview; see [`commands/proxy.md`](commands/proxy.md)).                         |
| `@generateTsTypes` / `@generatePythonEnv` / `@generateRustEnv` / `@generateGoEnv` / `@generatePhpEnv` | Per-language generators (add `auto=false` to defer to `varlock codegen`, `filter=` to emit a subset).                       |
| `@generateJavaEnv` / `@generateCsharpEnv`                                                             | Java and C# env modules (1.12.0).                                                                                           |
| `@generateTypes(lang=ts, path=...)`                                                                   | Deprecated alias for `@generateTsTypes`.                                                                                    |

Source: [root-decorators](https://varlock.dev/reference/root-decorators/).

`@import` filtering: `pick` (allowlist) or `omit` (denylist), not both. Entries
use the `--filter` selector language minus decorator selectors: key names, globs,
`#tag` for items tagged with `@tag()` in the imported file, and `!selector` to
exclude (the `#tag` and `!` forms are 1.21.0; before that a `#tag` entry silently
matched nothing). Filters intersect across nested imports. Positional keys
(`@import(./.env.other, KEY1)`) are deprecated in favor of `pick=[KEY1]`.

```env-spec
# @import(./.env.other, pick=[API_*, !API_SECRET])
# @import(../shared/, pick=[#frontend, !#internal])
```

Source: [`@import()`](https://varlock.dev/reference/root-decorators/#import).

## Item decorators

| Decorator                      | Purpose                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| `@type=<type>`                 | Type + coercion + validation (see below).                                                    |
| `@required` / `@optional`      | Presence rules. Conditional forms: `@required=forEnv(prod)`, `@required=eq($OTHER, foo)`.    |
| `@sensitive` / `@public`       | Mark (or unmark) a secret. `@public` is the opposite of `@sensitive`.                        |
| `@internal`                    | Used only by varlock/other items; excluded from injected env, the blob, and generated types. |
| `@dynamic` / `@static`         | Resolve at runtime vs allow build-time replacement (default follows sensitivity).            |
| `@tag(name, ...)`              | Tag for `--filter="#name"`, `@import` `pick`/`omit`, and `@generate*` `filter=`. 1.11.0.     |
| `@example`                     | An example value for docs/tooling.                                                           |
| `@docs()`                      | Attach documentation (`@docsUrl` is deprecated in favor of `@docs(url)`).                    |
| `@deprecated`                  | Mark deprecated (`@deprecated="Use X instead"`); still resolves and validates.               |
| `@icon`                        | An icon (for UI/tooling).                                                                    |
| `@auditIgnore`                 | Suppress "unused in schema" warnings from `varlock audit` for this item.                     |
| `@proxy(...)` / `@placeholder` | Route the secret through the credential proxy (preview); set the placeholder the child sees. |

Source: [item-decorators](https://varlock.dev/reference/item-decorators/).

## `@type` — data types

Built-in base types (each coerces + validates; many take parameters):

`string` (params like `startsWith`, `minLength`, `matches`, ...), `number`,
`boolean`, `enum` (e.g. `enum(development, staging, production)`; an empty `enum`
is a schema error), `url`, `domain`, `email`, `port`, `ip`, `semver`, `isoDate`,
`uuid`, `md5`, `simple-object`, `duration`, `array`, and `record`.

Additions since 1.10.0:

- `domain` (1.18.0): a bare hostname with no protocol, port, or path. Options
  `allowWildcard`, `allowSingleLabel`, `allowIp`, `allowIpV6` (1.19.0),
  `normalize`, `matches`.
- `array(<elementType>, ...)` and `record(<valueType>, keyType=...)` (1.13.0):
  per-element validation, native `[a, b]` / `{k=v}` literals, JSON or
  separator-joined string input. `simple-object` equals a bare `record`.
- `uuid(version=N)` (1.21.0): require a specific version; versions 6-8 (incl.
  UUIDv7) and `MAX` are now accepted.
- `matches` options take a `regex("pattern", "flags")` call (1.20.0). Passing the
  pattern as a string (`"^abc$"` or `/^abc$/`) is deprecated and warns, and a
  pattern from another variable (`matches=$PATTERN`) has no replacement.

```env-spec
# @type=string(startsWith=pk-)
PUBLISHABLE_KEY=
# @type=enum(development, staging, production)
APP_ENV=development
# @type=port
PORT=3000
# @type=url @required
DATABASE_URL=
# @type=string(matches=regex("^[0-9a-f]{7,40}$", "i"))
APP_COMMIT_SHA=
# @type=domain(allowWildcard=true)
CORS_DOMAIN=*.example.com
# @type=array(email)
ALLOWED_EMAILS=[admin@example.com, ${SUPPORT_EMAIL}]
# @type=record(number, keyType=enum(us, eu))
REGION_LIMITS={us=100, eu=50}
# @type=uuid(version=7)
REQUEST_NAMESPACE=
```

Plugins add provider-specific token types (used with `@type=`), e.g.
`opServiceAccountToken` (1Password), `awsAccessKey` / `awsSecretKey`,
`azureClientId` / `azureClientSecret` / `azureTenantId`, `gcpServiceAccountJson`,
`vaultToken`, `dopplerServiceToken`, `bitwardenAccessToken`, `infisicalClientId`,
and more.

Source: [data-types](https://varlock.dev/reference/data-types/).

## Values, quoting, and expansion

```env-spec
NO_VALUE=                       # resolves to undefined (not injected into process.env, 1.18.0+)
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

| Function                                                                        | Purpose                                                                                                                                     |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `ref(OTHER)`                                                                    | Reference another item (shorthand: `$OTHER` / `${OTHER}`).                                                                                  |
| `concat("pre-", ref(X), "-post")`                                               | Concatenate (same as `"pre-${X}-post"`).                                                                                                    |
| `fallback($A, foo)`                                                             | First non-empty value (shell `${A:-foo}` also works).                                                                                       |
| `remap($VAR, "main", production, regex(".*"), preview, undefined, development)` | Lookup/map; match values may be strings, `undefined`, or `regex()` calls (bare `/.../` is deprecated).                                      |
| `regex("pattern", "flags")`                                                     | The one way to write a regex (1.20.0), for `remap()` and `matches`. No surrounding slashes.                                                 |
| `ifs(cond1, val1, cond2, val2, default)`                                        | Ordered conditional pairs.                                                                                                                  |
| `if(cond, a, b)` / `not(x)` / `eq($X, v)` / `isEmpty(x)`                        | Boolean/conditional helpers.                                                                                                                |
| `forEnv(prod)`                                                                  | True in the named environment (used with `@required`, `@sensitive`, plugin init).                                                           |
| `exec("my-cli --arg")`                                                          | Run a CLI and use its stdout. Sugar: `$(my-cli --arg)` == `exec("my-cli --arg")`. Backticks allowed: `exec(\`op read "op://app/db/url"\`)`. |
| `domainFromUrl($URL)`                                                           | Extract the host from a URL (1.19.0).                                                                                                       |
| `randomNum` / `randomUuid` / `randomHex` / `randomString`                       | Generate random values.                                                                                                                     |
| `generateOtp($SEED)`                                                            | Generate a TOTP 2FA code from a base32 seed or `otpauth://` URI (1.15.0).                                                                   |
| `cache(...)`                                                                    | Cache an expensive/secret resolution.                                                                                                       |
| `keychain(...)`                                                                 | Read from the macOS Keychain (see the `keychain` command).                                                                                  |
| `varlock("local:...")`                                                          | A device-local encrypted value (produced by `varlock encrypt`).                                                                             |
| plugin functions, e.g. `op(op://vault/item/field)`                              | Resolve a secret from a provider at load time.                                                                                              |

Source: [functions](https://varlock.dev/reference/functions/);
[secrets guide](https://varlock.dev/guides/secrets/).

## Environments and file layering

Set `@envFlag` / `@currentEnv` in the header to the item that names the active
environment; varlock then auto-loads the matching `.env.[env]` files.

Value files apply in **increasing** precedence (process env always wins):

1. `.env.schema` defaults
2. `.env` (committed; discouraged for real values)
3. `.env.local`: local overrides _(gitignored)_
4. `.env.[currentEnv]`: environment-specific values (e.g. `.env.production`)
5. `.env.[currentEnv].local`: env-specific local overrides _(gitignored)_

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
