# knip: CLI flag reference

`knip` is a single command with no subcommands. Every mode is a flag. Spellings,
short forms, and argument placeholders below are transcribed from `knip --help` on
the **pinned local binary, v6.41.0**. Explanations come from the
[CLI reference](https://knip.dev/reference/cli), which documents v6.45.1. Flags added
after 6.41.0 are listed in [Newer flags](#newer-flags-not-in-v6410) and are absent
from the pinned binary.

## Invocation

```
knip [options]
```

Bare `knip` analyzes the project in the current directory (or `--directory`). It
needs a `package.json` there, and reads at most one config file from that directory
(see [`../knip-config.md`](../knip-config.md#file-names-and-lookup)).

`knip-bun` is the same CLI entry point run by Bun instead of Node.js; its `--help` is
byte-identical in v6.41.0. The docs call it "equivalent to `bunx --bun knip`"
([knip-bun](https://knip.dev/reference/cli#knip-bun)). It is slower than Node on
large projects, and `--performance` does not work under Bun
([performance](https://knip.dev/guides/performance#bun)).

## General

| Flag                   | Short | Arg      | Purpose                                                                                                                                                      |
| ---------------------- | ----- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--help`               | `-h`  |          | Print help text.                                                                                                                                             |
| `--version`            | `-V`  |          | Print version.                                                                                                                                               |
| `--no-progress`        | `-n`  |          | No dynamic progress updates (automatic in CI).                                                                                                               |
| `--config`             | `-c`  | `[file]` | Config file path. Default: `[.]knip.json[c]`, `knip.(js\|ts)`, `knip.config.(js\|ts)`, or `package.json#knip`.                                               |
| `--use-tsconfig-files` |       |          | Take each workspace's project files from `tsconfig.json` (`files` + `include`, minus `exclude`, `node_modules`, `outDir`) instead of the `project` patterns. |
| `--tsConfig`           | `-t`  | `[file]` | TypeScript config path (default `tsconfig.json`). Note the camelCase spelling; `-t jsconfig.json` works.                                                     |

Environment variables ([CLI reference](https://knip.dev/reference/cli#no_color)):

| Variable                      | Effect                                                                                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NO_COLOR=1`                  | Disable colors in built-in reporters.                                                                                                                          |
| `KNIP_DISABLE_RAW_TRANSFER=1` | Use the normal oxc-parser path instead of raw transfer (works around raw-transfer memory errors, see [known issues](https://knip.dev/reference/known-issues)). |

## Mode

| Flag                      | Short | Purpose                                                                                                                                          |
| ------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--cache`                 |       | Cache file analysis (mtime + size); repeat runs are 10-40% faster. Can go stale after config, path-alias, or new `.gitignore` changes.           |
| `--cache-location`        |       | Cache directory (default `node_modules/.cache/knip`).                                                                                            |
| `--include-entry-exports` |       | Also report unused exports in entry files (config: `includeEntryExports`).                                                                       |
| `--no-gitignore`          |       | Don't respect `.gitignore`.                                                                                                                      |
| `--production`            | `-p`  | Production files only: drops plugin entry files (tests, configs, stories) and `devDependencies`.                                                 |
| `--strict`                | `-s`  | Only direct dependencies of each workspace (not `devDependencies`, not other workspaces). Implies `--production`.                                |
| `--watch`                 | `-w`  | Watch mode. In v6.41.0, `package.json` changes may not refresh the report; 6.44.0 added config reloading. `node_modules` changes need a restart. |

Sources: [CLI reference: mode](https://knip.dev/reference/cli#mode),
[production mode](https://knip.dev/features/production-mode),
[known issues](https://knip.dev/reference/known-issues#stale-cache-results).

## Scope

| Flag             | Short | Arg        | Purpose                                                                                                                                                              |
| ---------------- | ----- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--workspace`    | `-W`  | `[filter]` | Filter workspaces by package name, directory, or glob of either. Repeatable; a `!` prefix excludes. Ancestor, dependency, and dependent workspaces are included too. |
| `--directory`    | `-D`  | `[dir]`    | Run from a different directory (default cwd).                                                                                                                        |
| `--include`      |       | types      | Report only these [issue types](#issue-types). Comma-separated or repeated.                                                                                          |
| `--exclude`      |       | types      | Exclude these issue types. Comma-separated or repeated.                                                                                                              |
| `--dependencies` |       |            | Shortcut for `--include dependencies,unlisted,binaries,unresolved,catalog,catalogReferences`.                                                                        |
| `--exports`      |       |            | Shortcut for `--include exports,nsExports,types,nsTypes,enumMembers,namespaceMembers,duplicates`.                                                                    |
| `--files`        |       |            | Shortcut for `--include files`.                                                                                                                                      |
| `--cycles`       |       |            | Shortcut for `--include cycles` (circular dependencies).                                                                                                             |
| `--tags`         |       | tags       | Include (`+`, default) or exclude (`-`) tagged exports: `--tags=-lintignore,-internal`, `--tags=+custom`. The `@` prefix is optional.                                |

`nsExports` and `nsTypes` are off by default, so `--include nsExports` _adds_ them to
the default report rather than narrowing it
([`--include`](https://knip.dev/reference/cli#--include)).

Discrepancy: the [rules and filters](https://knip.dev/features/rules-and-filters#shorthands)
page lists `--exports` without `nsExports`/`nsTypes`. The v6.41.0 `--help` and the CLI
reference both include them; this file follows the binary.

## Issue types

Keys accepted by `--include`, `--exclude`, `rules`, and `ignoreIssues`. Source:
[issue types](https://knip.dev/reference/issue-types) and the `--help` footnote.

| Key                 | Title                                                                    | Fixable | Default                       |
| ------------------- | ------------------------------------------------------------------------ | ------- | ----------------------------- |
| `files`             | Unused files                                                             | yes     | on                            |
| `dependencies`      | Unused dependencies (also `devDependencies`, `optionalPeerDependencies`) | yes     | on                            |
| `unlisted`          | Unlisted dependencies                                                    | no      | on                            |
| `binaries`          | Unlisted binaries                                                        | no      | on                            |
| `unresolved`        | Unresolved imports                                                       | no      | on                            |
| `catalog`           | Unused catalog entries                                                   | yes     | on                            |
| `catalogReferences` | Unresolved catalog references                                            | no      | on                            |
| `exports`           | Unused exports                                                           | yes     | on                            |
| `types`             | Unused exported types (`enum`, `interface`, `type`)                      | yes     | on                            |
| `nsExports`         | Exports in used namespace                                                | yes     | off                           |
| `nsTypes`           | Exported types in used namespace                                         | yes     | off                           |
| `enumMembers`       | Unused exported enum members                                             | yes     | on                            |
| `namespaceMembers`  | Unused exported namespace members                                        | yes     | on                            |
| `duplicates`        | Duplicate exports                                                        | no      | on                            |
| `cycles`            | Circular dependencies                                                    | no      | off (rule defaults to `warn`) |

Discrepancy: the v6.41.0 `--help` footnote omits `binaries`, yet its own
`--dependencies` shortcut expands to it and the docs list it. Treat it as valid.
The `subpaths` type exists only from 6.45.0.

## Fix

**These flags modify files in the repository.** Commit first and review the result
with git.

| Flag                   | Short | Arg   | Purpose                                                                                                         |
| ---------------------- | ----- | ----- | --------------------------------------------------------------------------------------------------------------- |
| `--fix`                | `-f`  |       | Remove `export` keywords, unused enum/namespace members, unused deps in `package.json`, unused catalog entries. |
| `--fix-type`           |       | types | Fix only these: `dependencies`, `exports`, `types`, `files`, `catalog`. Comma-separated or repeated.            |
| `--allow-remove-files` |       |       | Let `--fix` delete unused files (never deleted otherwise).                                                      |
| `--format`             | `-F`  |       | Format modified files after `--fix` with the project's formatter (Biome, deno fmt, dprint, Prettier).           |

Auto-fix does not add unlisted dependencies or binaries, and does not fix duplicate
exports. Re-run the package manager's install afterwards
([auto-fix](https://knip.dev/features/auto-fix#post-fix)).

## Output

| Flag                             | Arg    | Purpose                                                                                     |
| -------------------------------- | ------ | ------------------------------------------------------------------------------------------- |
| `--reporter`                     | name   | Reporter; repeatable. Built-ins below, or a local file (`./my-reporter.ts`) or npm package. |
| `--reporter-options`             | JSON   | Options for the reporter, e.g. `'{"path":".github/CODEOWNERS"}'`.                           |
| `--preprocessor`                 | name   | Preprocess results before reporting; repeatable; local file or package.                     |
| `--preprocessor-options`         | JSON   | Options for the preprocessor.                                                               |
| `--no-config-hints`              |        | Suppress configuration hints.                                                               |
| `--no-tag-hints`                 |        | Suppress tag hints.                                                                         |
| `--treat-config-hints-as-errors` |        | Exit 1 if there are configuration hints.                                                    |
| `--treat-tag-hints-as-errors`    |        | Exit 1 if there are tag hints.                                                              |
| `--max-issues`                   | number | Total issues allowed before a non-zero exit (default `0`).                                  |
| `--max-show-issues`              | number | Issues displayed per type; does not affect the exit code.                                   |
| `--no-exit-code`                 |        | Exit 0 despite lint issues. Config load failures and internal errors still exit 2.          |

Built-in reporters (v6.41.0 `--help`): `symbols` (default), `compact`, `codeowners`,
`cycles`, `json`, `codeclimate`, `markdown`, `disclosure`, `github-actions`, `sarif`.
The CLI reference page omits `cycles`; the binary and the
[reporters page](https://knip.dev/features/reporters) include it.

The `json` reporter prints one line:
`{ "issues": [ { "file", "owners"?, <issueType>: [{ name, line?, col?, pos? }] } ] }`,
with every enabled issue type key present on every entry
([JSON reporter](https://knip.dev/features/reporters#json)).

## Exit codes

| Code | Meaning                                                                                  |
| ---- | ---------------------------------------------------------------------------------------- |
| `0`  | No lint issues (or within `--max-issues`, or `--no-exit-code`).                          |
| `1`  | At least one lint issue; also config or tag hints under the `--treat-*-as-errors` flags. |
| `2`  | Did not run: bad input, plugin config load error, or internal error.                     |

Source: [CLI reference](https://knip.dev/reference/cli#--no-exit-code),
[troubleshooting](https://knip.dev/guides/troubleshooting).

## Troubleshooting

| Flag                 | Short | Arg      | Purpose                                                                                                   |
| -------------------- | ----- | -------- | --------------------------------------------------------------------------------------------------------- |
| `--debug`            | `-d`  |          | Workspaces, per-workspace config, enabled plugins, globs and matched files, plugin config files and deps. |
| `--trace`            |       |          | Show where exports are imported.                                                                          |
| `--trace-export`     |       | `[name]` | Trace a named export. Implies `--trace`.                                                                  |
| `--trace-file`       |       | `[file]` | Trace the exports of one file. Implies `--trace`; combine with `--trace-export` for one export.           |
| `--trace-dependency` |       | `[name]` | Show files that import a package or binary. Implies `--trace`.                                            |
| `--memory`           |       |          | Memory usage table after the run.                                                                         |
| `--memory-realtime`  |       |          | Log memory usage live (useful when Knip crashes).                                                         |
| `--performance`      |       |          | Count and timing of key internal functions (Node only).                                                   |
| `--performance-fn`   |       | `[name]` | Limit `--performance` to one function, e.g. `resolveSync`, `hasRefsInFile`.                               |
| `--duration`         | `-u`  |          | Print total running time, no instrumentation.                                                             |

Trace legend: `✓` referenced, `✗` reported as unused, `⎆` entry file.
Source: [troubleshooting](https://knip.dev/guides/troubleshooting#trace).

## Newer flags (not in v6.41.0)

| Flag                            | Since  | Purpose                                                                                                      |
| ------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| `--output-file [reporter=]path` | 6.44.0 | Write reporter output to a file (no ANSI codes); prefix the reporter name when several are used; repeatable. |
| `--include-subpath-exports`     | 6.45.0 | Report unused subpaths in `package.json#exports` (config: `includeSubpathExports`).                          |

Source: knip GitHub release notes for 6.44.0 and 6.45.0. On v6.41.0, redirect stdout
instead of using `--output-file`.

## Examples (verbatim from `knip --help`, v6.41.0)

```
$ knip
$ knip --production
$ knip --workspace packages/client --include files,dependencies
$ knip --workspace @myorg/* --workspace '!@myorg/legacy'
$ knip --workspace './apps/*' --workspace '@shared/utils'
$ knip -c ./config/knip.json --reporter compact
$ knip --reporter codeowners --reporter-options '{"path":".github/CODEOWNERS"}'
$ knip --tags=-lintignore
```
