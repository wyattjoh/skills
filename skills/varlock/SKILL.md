---
name: varlock
description: 'Kickstart `varlock`, the schema-driven, encrypted, AI-safe replacement for dotenv. Triggers on "varlock", ".env.schema", "env-spec", "varlock run", "varlock load", "varlock init", "@sensitive", "@type", "@required decorator", "load and validate .env", "encrypted .env file", "inject env vars into a command".'
allowed-tools: Bash, Read, Write, Edit
effort: low
---

# varlock

`varlock` loads, validates, and injects environment variables from `.env` files
against a committed **`.env.schema`**. The schema is an ordinary dotenv file whose
comments carry a decorator DSL (**`@env-spec`**): each variable declares its type,
whether it is required, whether it is sensitive, and how its value is resolved
(references, functions, plugins). varlock coerces and validates every value, marks
secrets `@sensitive` (redacting them from logs and output), can encrypt them
device-locally, and injects the resolved env three ways: via `varlock run -- <cmd>`,
a JS/TS auto-load import, or a framework integration. The schema exposes variable
_names, types, and descriptions_ without their secret _values_, which is what makes
it safe to hand to an AI agent.

## Local setup

- Binary: `/opt/homebrew/bin/varlock` (on `PATH` as `varlock`; installed via `brew install dmno-dev/tap/varlock`).
- **Pinned version explored: `varlock 1.10.0`.** Every command and flag below is
  verified against that binary's `--help`. Docs were read at the same 1.10.0.
- Config files read:
  - **`.env.schema`** — the committed source-of-truth schema (see [`references/env-schema.md`](references/env-schema.md)).
  - Value files layered over it, lowest to highest precedence: `.env` -> `.env.local`
    -> `.env.[env]` -> `.env.[env].local`. `.local` files are gitignored.
- Alternate installs (no brew): `npx varlock init` (adds it as a project dep),
  `curl -sSfL https://varlock.dev/install.sh | sh -s`, or `ghcr.io/dmno-dev/varlock`.
  Source: [installation](https://varlock.dev/getting-started/installation/).

## Common resolution flags

varlock's only true global flags are `-h, --help` and `-v, --version`. The
value-resolving commands don't all share the same flag set — each flag below
is scoped to the commands that actually accept it (verified against each
command's own `--help`; see the per-command reference files for the full
tables):

| Flag                           | Short | Commands                                                                           | Purpose                                                                                                  |
| ------------------------------ | ----- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `--path <path>`                | `-p`  | all 8 (`load`, `run`, `printenv`, `explain`, `reveal`, `scan`, `audit`, `codegen`) | Use a specific `.env` file or directory as the entry point. Repeatable; later paths take precedence.     |
| `--env <env>`                  |       | `load`, `explain`, `reveal`                                                        | Resolve as a named environment (e.g. `production`). **Ignored when `@currentEnv` is set** in the schema. |
| `--clear-cache`/`--skip-cache` |       | `load`, `run`, `printenv`                                                          | Clear the cache and re-resolve, or bypass the cache entirely, for this run.                              |
| `--agent`                      |       | `init`, `load`                                                                     | Non-interactive / redacted mode for AI agents and CI.                                                    |

## Anatomy

```
varlock <command> [options] [-- <child command and args>]
```

- Only `run` uses the `--` separator, to fence varlock's options off from the
  command it executes.
- Several commands are interactive by default (`init`, `encrypt`, `reveal`, `cache`)
  but expose a non-interactive path (`--agent`, stdin piping, `--copy`, `cache status`).

## Commands

18 top-level commands, grouped below. Full per-command flag tables and verbatim
`EXAMPLES:` blocks live in the linked reference files.

| Command          | Purpose                                                             | Reference                                   |
| ---------------- | ------------------------------------------------------------------- | ------------------------------------------- |
| `load`           | Load + validate env, print resolved values (✓/✗, secrets redacted). | [core](references/commands/core.md)         |
| `run`            | Run a child command with the resolved env injected.                 | [core](references/commands/core.md)         |
| `printenv`       | Print one resolved variable's value.                                | [core](references/commands/core.md)         |
| `explain`        | Show how a single item's value was resolved (debug).                | [core](references/commands/core.md)         |
| `init`           | Interactive onboarding: scaffold `.env.schema`, add the dep.        | [project](references/commands/project.md)   |
| `codegen`        | Generate typed env accessors (ts/py/rust/go/php).                   | [project](references/commands/project.md)   |
| `install-plugin` | Pre-download a plugin from npm for the standalone binary.           | [project](references/commands/project.md)   |
| `complete`       | Emit a shell completion script.                                     | [project](references/commands/project.md)   |
| `telemetry`      | Opt in/out of anonymous usage analytics.                            | [project](references/commands/project.md)   |
| `help`           | Print the top-level command list.                                   | [project](references/commands/project.md)   |
| `encrypt`        | Encrypt a value (or a file's `@sensitive` values) device-locally.   | [secrets](references/commands/secrets.md)   |
| `reveal`         | Securely view / copy a sensitive value.                             | [secrets](references/commands/secrets.md)   |
| `lock`           | Lock the encryption daemon (next decrypt needs biometric).          | [secrets](references/commands/secrets.md)   |
| `generate-key`   | Generate an encryption key for deployments.                         | [secrets](references/commands/secrets.md)   |
| `keychain`       | Manage macOS Keychain items used by `keychain()`. Has subcommands.  | [secrets](references/commands/secrets.md)   |
| `cache`          | Manage the encrypted value cache. Has subcommands.                  | [secrets](references/commands/secrets.md)   |
| `scan`           | Detect plaintext secrets in files; install as a git hook.           | [security](references/commands/security.md) |
| `audit`          | Compare code env-var references against the schema.                 | [security](references/commands/security.md) |

The **`.env.schema` format** (decorators, types, functions, environments, plugins)
is documented in full in [`references/env-schema.md`](references/env-schema.md).
Read [`references/patterns.md`](references/patterns.md) before authoring or
debugging a real schema — it covers the semantics the decorator list does not imply
(`@optional` governs validation, not resolution; absent vs empty; unsetting a var in
an overlay).

## Common workflows

### Set up varlock in a project

```bash
varlock init            # interactive wizard: scans .env files, writes .env.schema, adds the dep
varlock init --agent    # non-interactive (AI agent / CI)
```

Run it in a directory that already has `.env` or `.env.*` files.
Source: `varlock init --help` (v1.10.0); [installation](https://varlock.dev/getting-started/installation/).

### Load and validate (the debug loop)

```bash
varlock load                    # pretty output, ✓/✗ per item, secrets redacted
varlock load --show-all         # when validation fails, show passing items too
varlock load --format json      # machine-readable
varlock load --agent            # agent-safe JSON, sensitive values redacted
varlock load --env production    # validate a named environment (unless @currentEnv is set)
```

Source: `varlock load --help` (v1.10.0).

### Run a command with the env injected

```bash
varlock run -- node app.js
varlock run -- python script.py
varlock run -- sh -c 'echo $MY_VAR'          # shell expansion needs sh -c
varlock run --inject vars -- node app.js      # inject individual vars only, no __VARLOCK_ENV blob
```

Use `--` to separate varlock's flags from the child command. Output is redacted
automatically when piped/redirected (e.g. CI logs); interactive terminals get raw
pass-through. Source: `varlock run --help` (v1.10.0).

### Auto-load env in a Node.js / TypeScript app

```javascript
import "varlock/auto-load"; // loads + injects into process.env, sets up redaction + leak detection
import { ENV } from "varlock/env";

const key = ENV.MY_CONFIG_ITEM; // typed accessor (recommended)
```

Recommended for Node v22+. Source: [usage](https://varlock.dev/getting-started/usage/).

### Export the resolved env into your shell (direnv / eval)

```bash
eval "$(varlock load --format shell)"
```

Source: `varlock load --help` (v1.10.0) — `--format shell` emits `export` statements.

### Read a single value inline

```bash
sh -c 'do-something --token $(varlock printenv MY_TOKEN)'
varlock explain DATABASE_URL          # debug why a value is not what you expect
```

Unlike `varlock run -- echo $MY_VAR`, `printenv` works inline because shell
expansion happens after varlock prints. Source: `varlock printenv --help`,
`varlock explain --help` (v1.10.0).

### Multi-environment with `@currentEnv`

```env-spec
# @currentEnv=$APP_ENV
# @defaultSensitive=false @defaultRequired=infer
# ---
# @type=enum(development, preview, production)
APP_ENV=remap($CI_BRANCH, "main", production, /.*/, preview, undefined, development)
```

`.env.development`, `.env.preview`, `.env.production` then auto-load based on the
resolved `APP_ENV`. `--env` is ignored once `@currentEnv` is set.
Source: [environments](https://varlock.dev/guides/environments/).

### Keep plaintext secrets out of files (scan as a git hook)

```bash
varlock scan                  # scan the project for plaintext secrets
varlock scan --staged         # only staged files (pre-commit)
varlock scan --install-hook   # install as a git pre-commit hook
```

Source: `varlock scan --help` (v1.10.0).

### Pull secrets from an external manager (plugin, e.g. 1Password)

```env-spec
# @plugin(@varlock/1password-plugin)
# @initOp(token=$OP_TOKEN, allowAppAuth=forEnv(dev), account=acmeco)
# ---
# @type=opServiceAccountToken @sensitive
OP_TOKEN=
DB_PASS=op(op://my-vault/database-password/password)
```

Pre-download the plugin in CI with
`varlock install-plugin @varlock/1password-plugin@<version>` (an exact version
is required). Or, with no plugin, resolve a
secret from any CLI with `exec()`: `MY_SECRET=exec(\`./scripts/fetch-secret.sh\`)`.
Source: [secrets guide](https://varlock.dev/guides/secrets/); [plugins](https://varlock.dev/plugins/overview/).

### Generate typed accessors

```env-spec
# @generateTypes(lang=ts, path=./env.d.ts)
```

```bash
varlock codegen                 # deterministic; run when @generate*=auto=false
```

Source: `varlock codegen --help` (v1.10.0); [item decorators](https://varlock.dev/reference/item-decorators/).

## References

- [`references/commands/core.md`](references/commands/core.md) — `load`, `run`, `printenv`, `explain` (the daily resolution commands).
- [`references/commands/secrets.md`](references/commands/secrets.md) — `encrypt`, `reveal`, `lock`, `generate-key`, `keychain`, `cache`.
- [`references/commands/security.md`](references/commands/security.md) — `scan`, `audit`.
- [`references/commands/project.md`](references/commands/project.md) — `init`, `codegen`, `install-plugin`, `complete`, `telemetry`, `help`.
- [`references/env-schema.md`](references/env-schema.md) — the `.env.schema` / `@env-spec` format: decorators, types, functions, environments, file layering, plugins.
- [`references/patterns.md`](references/patterns.md) — schema patterns and gotchas: optional secret refs (`allowMissing` + `fallback`), unsetting vars per environment with `undefined`, operator-scoped overlays, absent vs empty, plugin pinning and app auth.
