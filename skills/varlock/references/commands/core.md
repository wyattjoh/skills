# Core commands: load, run, printenv, explain

The daily-driver resolution commands. Each accepts a subset of the [common
resolution flags](../../SKILL.md#common-resolution-flags) (`-p/--path`, `--env`,
`--clear-cache`, `--skip-cache`, `--filter`); the per-command tables below list
exactly which. Verified against `varlock 1.21.0` `--help`.

## `load`

Load env according to the schema, resolve + validate values, and print them.
Sensitive values are redacted. The primary local-debug and CI-summary command.

```
varlock load [OPTIONS]
```

| Flag                    | Short | Purpose                                                                              |
| ----------------------- | ----- | ------------------------------------------------------------------------------------ |
| `--format [format]`     | `-f`  | Output format: `pretty` (default), `json`, `env`, `shell`, `json-full`.              |
| `--agent`               |       | Agent-safe mode: redact sensitive values (defaults to JSON if `--format` unset).     |
| `--compact`             |       | Compact output (json-full: no indentation; env/shell: skip undefined values).        |
| `--show-all`            |       | When load is failing, show all items, not only failing ones.                         |
| `--include-internal`    |       | Include `@internal` items in `--format json-full` output (excluded by default).      |
| `--filter <filter>`     |       | Filter shown items (keys/globs, `!KEY`, `@sensitive`, `#tag`). Or `_VARLOCK_FILTER`. |
| `--env <env>`           |       | Set the environment (overridden by `@currentEnv` if present).                        |
| `--path <path>`         | `-p`  | Entry-point `.env` file/dir. Repeatable.                                             |
| `--summary-stderr`      |       | Also write the pretty (redacted) summary to stderr.                                  |
| `--summary-file <file>` |       | Also write the pretty summary to a file (e.g. `$GITHUB_STEP_SUMMARY`).               |
| `--clear-cache`         |       | Clear cache and re-resolve.                                                          |
| `--skip-cache`          |       | Skip cache for this invocation.                                                      |

`EXAMPLES:` (verbatim from `varlock load --help`):

```
varlock load                    # Load and validate with pretty output
varlock load --format json      # Output in JSON format
eval "$(varlock load --format shell)"  # Load vars into current shell (useful with direnv)
varlock load --show-all         # Show all items when validation fails
varlock load --path .env.prod   # Load from a specific .env file
varlock load -p ./envs -p ./overrides  # Load from multiple directories
varlock load --compact          # Use compact format - skips undefined values, no indentation for json-full
varlock load --env production   # Load for a specific environment (⚠️ ignored if using @currentEnv!)
varlock load --format json-full --summary-stderr   # JSON on stdout + redacted human summary on stderr
varlock load --format json-full --summary-file /tmp/summary.txt   # JSON on stdout + redacted human summary written to file
varlock load --agent            # Agent-safe JSON output with sensitive values redacted
varlock load --format json-full --include-internal   # Include @internal items for local debugging
varlock load --filter="STRIPE_*,!STRIPE_DEBUG_KEY"  # Only STRIPE_* keys, excluding one
varlock load --filter="@sensitive"  # Only items marked @sensitive
varlock load --filter="#billing"    # Only items tagged @tag(billing)
```

`json-full` excluding `@internal` items by default is a 1.11.0 fix: framework
integrations consume this output, so an internal secret-zero credential could
leak into client/SSR code. `--format shell` skips items that resolve to
`undefined` (1.18.0). Source: [load](https://varlock.dev/reference/cli/load-and-run/#load).

## `run`

Execute a command in a child process with the resolved + validated env injected.
Use `--` to separate varlock's flags from the child command.

```
varlock run [OPTIONS] -- <command> [args...]
```

| Flag                 | Short | Purpose                                                                                                      |
| -------------------- | ----- | ------------------------------------------------------------------------------------------------------------ |
| `--redact-stdout`    |       | Force redaction of piped/redirected output. Also settable via `_VARLOCK_REDACT_STDOUT` (flag wins).          |
| `--no-redact-stdout` |       | Disable redaction entirely.                                                                                  |
| `--inject <mode>`    | `-i`  | What is injected: `all` (default), `vars` (individual vars only, no blob), or `blob` (`__VARLOCK_ENV` only). |
| `--include-internal` |       | Pass `@internal` items through to the child (stripped by default).                                           |
| `--filter <filter>`  |       | Filter injected items; excluded keys are also stripped from the blob and child env. Or `_VARLOCK_FILTER`.    |
| `--path <path>`      | `-p`  | Entry-point `.env` file/dir. Repeatable.                                                                     |
| `--clear-cache`      |       | Clear cache and re-resolve.                                                                                  |
| `--skip-cache`       |       | Skip cache for this invocation.                                                                              |

Redaction applies automatically when output is piped/redirected (e.g. CI logs);
interactive terminals get raw TTY pass-through, so tools like `psql` just work.

`EXAMPLES:` (verbatim from `varlock run --help`):

```
varlock run -- node app.js                    # Run a Node.js application
varlock run -- python script.py               # Run a Python script
varlock run -- sh -c 'echo $MY_VAR'           # Use shell expansion for env vars
varlock run --inject vars -- sh               # Inject only individual vars, no blob
varlock run --inject blob -- node app.js      # Inject only the blob, no individual vars
varlock run --path .env.prod -- node app.js   # Use a specific .env file
varlock run --path ./config/ -- node app.js   # Use a specific directory
varlock run -p ./envs -p ./overrides -- node app.js  # Use multiple directories
varlock run --filter="STRIPE_*,!STRIPE_DEBUG_KEY" -- node app.js  # Only inject STRIPE_* keys, excluding one
```

> 📍 Use `--` to separate varlock options from your command.

## `printenv`

Print the resolved value of a single variable, or (with `--template`, added in
1.17.0) a rendered string template referencing several. Useful inside larger
shell commands.

```
varlock printenv [OPTIONS] [<key>]
```

| Flag                    | Short | Purpose                                                                   |
| ----------------------- | ----- | ------------------------------------------------------------------------- |
| `--template <template>` | `-t`  | Print a rendered template; `{{KEY}}` placeholders become resolved values. |
| `--escape <escape>`     |       | Escape substituted values (only with `--template`). Choices: `json`.      |
| `--path <path>`         | `-p`  | Entry-point `.env` file/dir (trailing slash for a dir). Repeatable.       |
| `--clear-cache`         |       | Clear cache and re-resolve.                                               |
| `--skip-cache`          |       | Skip cache for this invocation.                                           |

`EXAMPLES:` (verbatim from `varlock printenv --help`):

```
varlock printenv MY_VAR                    # Print the value of MY_VAR
varlock printenv --path .env.prod MY_VAR   # Use a specific .env file
varlock printenv --path ./config/ MY_VAR   # Use a specific directory
varlock printenv -p ./envs -p ./overrides MY_VAR  # Use multiple directories
varlock printenv --template '{"Authorization": "Bearer {{MY_TOKEN}}"}' --escape json  # Render a template
```

> 📍 Embed in shell commands with `sh -c`, e.g. `sh -c 'do-something --token $(varlock printenv MY_TOKEN)'`.
> 💡 Unlike `varlock run -- echo $MY_VAR`, this works because shell expansion happens after varlock prints the value.
> 💡 Use `--escape json` when a template emits JSON (e.g. headers for an MCP `headersHelper`) so values cannot break out of their string literals.

## `explain`

Show every definition, source, and override that feeds into one config item.
Use it to debug why a value is not what you expect.

```
varlock explain [OPTIONS] [<key>]
```

| Flag            | Short | Purpose                                  |
| --------------- | ----- | ---------------------------------------- |
| `--env <env>`   |       | Set the environment.                     |
| `--path <path>` | `-p`  | Entry-point `.env` file/dir. Repeatable. |

`EXAMPLES:` (verbatim from `varlock explain --help`):

```
varlock explain DATABASE_URL          # Explain how DATABASE_URL is resolved
varlock explain --env production API_KEY  # Explain in production context
```
