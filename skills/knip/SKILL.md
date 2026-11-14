---
name: knip
description: 'Kickstart `knip`, the finder (and fixer) of unused files, dependencies, and exports in JavaScript and TypeScript projects, and author its `knip.json` config. Triggers on "knip", "knip --fix", "knip --production", "knip --workspace", "knip --reporter", "knip-bun", "knip.json", "knip.jsonc", "knip.ts", "knip.config.ts", "package.json#knip", "find unused exports", "find unused dependencies", "remove dead code", "unlisted dependencies".'
allowed-tools: Bash, Read
effort: low
---

# knip

`knip` finds unused files, dependencies, and exports in JavaScript and TypeScript
projects, and can remove them with `--fix`. It builds a module graph from entry
files (defaults, `package.json` fields, and ~200 auto-enabled tool plugins) and
reports everything in `project` scope that the graph never reaches. It is
**flag-driven**: there are no subcommands, and bare `knip` runs a full analysis.

## Local setup

- Installed per project as a devDependency, alongside `typescript` and
  `@types/node`. Run it through the package manager (`npm run knip`, `bun run knip`,
  `pnpm knip`) or `npx knip` / `bunx knip`. Here it is
  `node_modules/.bin/knip` (this repo's own `bun run knip`).
- **Pinned version explored: `knip 6.41.0`.** CLI details are verified against that
  binary's `--help`. The docs reviewed describe 6.45.1; features added since 6.41.0
  are marked with a "since" version.
- Requires Node.js `^20.19.0 || >=22.12.0`, or Bun (`knip-bun`). Needs a
  `package.json` in the directory it runs in.
- Config file read: the first of **`knip.json`**, `knip.jsonc`, `.knip.json`,
  `.knip.jsonc`, `knip.ts`, `knip.js`, `knip.config.ts`, `knip.config.js`, or the
  `"knip"` key in `package.json`. Format in
  [`references/knip-config.md`](references/knip-config.md).

## Global flags

Most-used flags. Full table in
[`references/commands/cli-flags.md`](references/commands/cli-flags.md).

| Flag                    | Short | Purpose                                                                                 |
| ----------------------- | ----- | --------------------------------------------------------------------------------------- |
| `--production`          | `-p`  | Production files only (no tests, configs, `devDependencies`).                           |
| `--strict`              | `-s`  | Only direct deps per workspace; implies `--production`.                                 |
| `--workspace <f>`       | `-W`  | Filter workspaces by name, dir, or glob; repeatable; `!` excludes.                      |
| `--include <types>`     |       | Report only these issue types (`--files`, `--dependencies`, `--exports` are shortcuts). |
| `--exclude <types>`     |       | Drop these issue types.                                                                 |
| `--fix`                 | `-f`  | **Modify files** to remove unused exports and deps.                                     |
| `--allow-remove-files`  |       | Let `--fix` delete unused files.                                                        |
| `--reporter <name>`     |       | `symbols` (default), `compact`, `json`, `markdown`, `github-actions`, `sarif`, ...      |
| `--max-show-issues <n>` |       | Cap displayed issues per type.                                                          |
| `--max-issues <n>`      |       | Issues tolerated before exiting non-zero (default `0`).                                 |
| `--no-exit-code`        |       | Exit 0 despite issues.                                                                  |
| `--config <file>`       | `-c`  | Use a specific config file.                                                             |
| `--directory <dir>`     | `-D`  | Run from another directory.                                                             |
| `--cache`               |       | Cache analysis between runs.                                                            |
| `--debug`               | `-d`  | Show workspaces, plugins, globs, and matched files.                                     |
| `--trace-export <n>`    |       | Show where an export is (or isn't) imported.                                            |

Exit codes: `0` clean, `1` issues found, `2` Knip failed to run.

## Anatomy

```
knip [options]
```

```bash
knip                                   # full report: files, deps, exports, ...
knip --production                      # production code only
knip --workspace packages/client --include files,dependencies
knip -c ./config/knip.json --reporter compact
```

## Commands

`knip` has no subcommands. Its modes are flag groups; full detail in
[`references/commands/cli-flags.md`](references/commands/cli-flags.md).

| Group        | Flags                                                            | Purpose                                          |
| ------------ | ---------------------------------------------------------------- | ------------------------------------------------ |
| Analyze      | `knip`, `--production`, `--strict`, `--watch`, `--cache`         | Run the analysis and choose what counts as used. |
| Scope        | `--workspace`, `--directory`, `--include`, `--exclude`, `--tags` | Narrow workspaces and issue types.               |
| Fix          | `--fix`, `--fix-type`, `--allow-remove-files`, `--format`        | **Rewrite files** to remove unused code.         |
| Output       | `--reporter`, `--max-issues`, `--no-exit-code`, hint flags       | Shape the report and the exit code.              |
| Troubleshoot | `--debug`, `--trace*`, `--performance`, `--memory`               | Explain false positives and slow runs.           |
| Bun runtime  | `knip-bun`                                                       | Same CLI under Bun (`bunx --bun knip`).          |

## Common workflows

### Install and first run

```shell
npm init @knip/config    # or: pnpm create / bun create / yarn create @knip/config
npm run knip
```

Manual install: `npm install -D knip typescript @types/node`, then add
`"knip": "knip"` to `package.json` `scripts`.
Source: [getting started](https://knip.dev/overview/getting-started).

### Triage a large first report

```shell
npm run knip -- --max-show-issues 5
npm run knip -- --include files
```

Address configuration hints first, then work the report top-down (unused files
come first). Findings come in chains: removing one unused file can clear the
exports and dependencies only it used.
Source: [first cleanup](https://knip.dev/overview/first-cleanup),
[handling issues](https://knip.dev/guides/handling-issues).

### Adopt one issue type at a time

```shell
knip --files
knip --dependencies
knip --exports
```

Ratchet with `rules` (`"warn"` to `"error"`) and gate CI with `--max-issues` while
the backlog shrinks.
Source: [adopt gradually](https://knip.dev/guides/adopt-gradually).

### Fix false positives in config

```json
{
  "$schema": "https://unpkg.com/knip@6/schema.json",
  "entry": ["src/index.ts", "scripts/{build,create}.js"],
  "project": ["src/**/*.ts", "scripts/**/*.js"]
}
```

Custom `entry`/`project` replace the defaults. Exclude generated code with negated
`project` globs rather than `ignore`; keep tests in scope and use `--production` to
check production code. All keys in
[`references/knip-config.md`](references/knip-config.md).
Source: [configuration](https://knip.dev/overview/configuration#customize),
[configuring project files](https://knip.dev/guides/configuring-project-files).

### Check production code

```shell
knip --production
knip --production --strict
```

Mark production entries with a `!` suffix (`"entry": ["src/index.ts!"]`). Default
mode covers all code, so a test can keep an export from being reported; production
mode excludes tests to catch that. Both modes share one config, and running both is
common.
Source: [production mode](https://knip.dev/features/production-mode).

### Auto-fix

```shell
git status                          # start from a clean tree
knip --fix
knip --fix-type exports,types
knip --fix --allow-remove-files
knip --fix --format
```

`--fix` never deletes files without `--allow-remove-files`, and never adds unlisted
dependencies. Reinstall packages after it edits `package.json`, then review the diff.
Source: [auto-fix](https://knip.dev/features/auto-fix).

### Monorepos

```shell
knip --workspace packages/my-lib
knip --workspace @myorg/* --workspace '!@myorg/legacy'
knip --workspace './apps/*' --workspace '@shared/utils'
```

Configure per-workspace `entry`/`project` under `workspaces`, with the root as `"."`.
Add `--strict` to lint a workspace in isolation.
Source: [monorepos and workspaces](https://knip.dev/features/monorepos-and-workspaces#filter-workspaces),
`knip --help`.

### Run in CI

```yaml
- name: Install dependencies
  run: npm install --ignore-scripts
- name: Run knip
  run: npm run knip
```

Exit code 1 fails the job. Add `--reporter github-actions` for PR annotations,
`--cache` for speed, and `--treat-config-hints-as-errors` to keep config tidy.
Source: [using Knip in CI](https://knip.dev/guides/using-knip-in-ci),
[reporters](https://knip.dev/features/reporters#github-actions).

### Machine-readable output

```shell
knip --reporter json
knip --reporter markdown
knip --reporter codeowners --reporter-options '{"path":".github/CODEOWNERS"}'
knip --reporter ./my-reporter.ts
```

To write a report to a file, redirect stdout on v6.41.0
(`knip --reporter json > knip.json`, inferred). `--output-file [reporter=]path` does
this directly **since 6.44.0**.
Source: [reporters](https://knip.dev/features/reporters), `knip --help`.

### Trace a false positive

```shell
knip --debug                         # which plugins, globs, and files were used
knip --trace-export myExport         # (inferred argument value)
knip --trace-file src/utils.ts       # (inferred argument value)
knip --trace-dependency lodash       # (inferred argument value)
```

Scope traces with `--workspace`. Legend: `✓` referenced, `✗` unused, `⎆` entry file.
The docs show trace output only as screenshots, so the argument values are
illustrative.
Source: [troubleshooting](https://knip.dev/guides/troubleshooting#trace).

### Suppress a justified exception

```ts
/** @lintignore */
export const keptForConsumers = 1;
```

```shell
knip --tags=-lintignore
```

Use `@public` for exports kept on purpose, `ignoreDependencies` for packages Knip
cannot see, and `ignoreIssues` for generated files. A tag or config hint appears
once the exception is no longer needed.
Source: [JSDoc and TSDoc tags](https://knip.dev/reference/jsdoc-tsdoc-tags),
`knip --help`.

### Circular dependencies

```shell
knip --cycles --reporter cycles
```

Cycles are a `warn` rule by default; set `"rules": { "cycles": "error" }` to fail on
them, and list known cycles in `cycles.allow`.
Source: [reporters: cycles](https://knip.dev/features/reporters#cycles).

## References

- [`references/commands/cli-flags.md`](references/commands/cli-flags.md): every flag
  in the v6.41.0 `--help` by group, issue types, reporters, exit codes, env vars,
  `knip-bun`, flags added after 6.41.0, and the verbatim help examples.
- [`references/knip-config.md`](references/knip-config.md): config file names and
  lookup, defaults, every top-level key, workspaces, plugins, the production `!`
  suffix, dynamic `knip.ts` config, and JSDoc tags.
