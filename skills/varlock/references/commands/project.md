# Project & tooling: init, codegen, flatten, install-plugin, complete, telemetry, help

Setup, code generation, plugins, and housekeeping commands. Verified against
`varlock 1.21.0` `--help`.

## `init`

Interactive onboarding: scan for `.env` files, create a `.env.schema` from an
existing `.env.example` / `.env.sample`, and add varlock to `package.json` (if
applicable). Run it in a directory containing `.env` or `.env.*` files.

```
varlock init [OPTIONS]
```

| Flag      | Purpose                                                |
| --------- | ------------------------------------------------------ |
| `--agent` | Non-interactive mode for agent / automation workflows. |

`EXAMPLES:` (verbatim from `varlock init --help`):

```
varlock init                    # Run in the current directory
varlock init --agent            # Run non-interactively (agent/automation friendly)
cd path/to/your/project && varlock init
```

## `codegen`

Generate code (types and env modules) from the schema. Uses only
non-environment-specific schema info, so output is deterministic. Add a per-language
generator decorator to the schema for each output; run `codegen` when a generator has
`auto=false` (disabling automatic generation during `load` / `run`).

```
varlock codegen [OPTIONS]
```

| Flag            | Short | Purpose                                                  |
| --------------- | ----- | -------------------------------------------------------- |
| `--path <path>` | `-p`  | `.env` file or directory as the entry point. Repeatable. |

Generator decorators (from the help text): `@generateTsTypes(path=env.d.ts)`,
`@generatePythonEnv(path=env.py)`, `@generateRustEnv(path=src/env.rs)`,
`@generateGoEnv(path=env/env.go)`, `@generatePhpEnv(path=Env.php)`. The docs also
list `@generateJavaEnv` and `@generateCsharpEnv` (added in 1.12.0, not named in
the help text). Each generator takes a `filter=` arg using the `--filter` selector
language (1.11.0), so one schema can emit several subset files, e.g.
`@generateTsTypes(path=./billing/env.d.ts, filter=#billing)`. See
[`../env-schema.md`](../env-schema.md) and
[code generation](https://varlock.dev/reference/root-decorators/#code-generation).

`EXAMPLES:` (verbatim from `varlock codegen --help`):

```
varlock codegen                    # Generate using the default schema
varlock codegen --path .env.prod   # Generate from a specific .env file
```

## `flatten`

Copy every env file reachable via `@import()` into one self-contained directory
and rewrite the `@import` paths (added in 1.14.0). Use it when only one package of
a monorepo is present at runtime, typically the final stage of a Docker build.
Values are never resolved: it is a purely structural transform, safe to run in
CI without secrets. `@plugin()` versions in copied files are pinned to what is
currently installed. Takes no `--path`; it runs from the current directory.

```
varlock flatten [OPTIONS]
```

| Flag                  | Purpose                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `--out-dir [out-dir]` | Output directory, relative to cwd unless absolute (default: `.env-flat`).                         |
| `--include-local`     | Include `.env.local` / `.env.*.local` files (excluded by default).                                |
| `--vendor-plugins`    | Copy npm plugins into the output so no runtime install is needed (shell-less/offline/distroless). |

`EXAMPLES:` (verbatim from `varlock flatten --help`):

```
varlock flatten                    # flatten env files from the current directory into .env-flat/
varlock flatten --out-dir dist/env # custom output location
varlock flatten --include-local    # also include .env.local files (careful - these often hold secrets)
varlock flatten --vendor-plugins   # also copy npm plugins into the output (self-contained, no runtime install)

Typical Dockerfile usage (builder stage has the full monorepo):
  RUN cd packages/api && varlock flatten
  # final stage:
  COPY --from=builder /repo/packages/api /app
  COPY --from=builder /repo/packages/api/.env-flat/ /app/
```

Source: [flatten](https://varlock.dev/reference/cli/project/#flatten).

## `install-plugin`

Pre-download and cache a plugin from npm so the standalone binary can use it
without an interactive confirmation prompt (useful in CI). The plugin must be
pinned to an exact version.

```
varlock install-plugin <plugin>   # name@version
```

`EXAMPLES:` (verbatim from `varlock install-plugin --help`):

```
varlock install-plugin my-plugin@1.2.3
varlock install-plugin @my-scope/my-plugin@2.0.0
```

## `complete`

Generate a shell completion script. No flags beyond `-h/--help`, `-v/--version`;
the help text prints no `EXAMPLES:` block (v1.21.0).

```
varlock complete
```

## `telemetry`

Opt in/out of anonymous usage analytics. Writes the preference to
`$XDG_CONFIG_HOME/varlock/config.json` (or `~/.config/varlock/config.json`).

```
varlock telemetry <enable|disable>
```

`EXAMPLES:` (verbatim from `varlock telemetry --help`):

```
varlock telemetry disable    # Opt out of telemetry
varlock telemetry enable     # Opt in to telemetry
```

> 💡 Temporarily opt out with `VARLOCK_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1`
> (`DO_NOT_TRACK` honored since 1.16.1). Docs:
> [telemetry](https://varlock.dev/guides/telemetry/).

## `help`

Print the top-level command list (same output as `varlock --help`).

```
varlock help
```
