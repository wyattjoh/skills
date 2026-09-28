# Security commands: scan, audit

Guardrails that compare your resolved config and code against the schema.
Verified against `varlock 1.21.0` `--help`.

## `scan`

Load your varlock config, resolve all sensitive values, then scan files to ensure
none of those sensitive values appear in plaintext. Can install itself as a
pre-commit hook.

```
varlock scan [OPTIONS] [<targets> ...]
```

| Arg / Flag          | Short | Purpose                                                                  |
| ------------------- | ----- | ------------------------------------------------------------------------ |
| `targets`           |       | Files, dirs, or globs to scan (defaults to the current directory).       |
| `--staged`          |       | Only scan staged git files.                                              |
| `--include-ignored` |       | Include git-ignored files in the scan.                                   |
| `--install-hook`    |       | Set up `varlock scan` as a git pre-commit hook.                          |
| `--path <path>`     | `-p`  | `.env` file or dir (trailing `/`) as the schema entry point. Repeatable. |

`EXAMPLES:` (verbatim from `varlock scan --help`):

```
varlock scan                    # Scan non-git-ignored files in current directory
varlock scan --staged           # Only scan staged git files
varlock scan --include-ignored  # Scan all files, including git-ignored ones
varlock scan --path .env.prod   # Use a specific .env file as the schema entry point
varlock scan -p ./envs -p ./overrides  # Use multiple schema entry points
varlock scan --install-hook     # Set up as a git pre-commit hook
varlock scan ./dist             # Scan a specific directory (e.g. a build output folder)
varlock scan ./dist ./public    # Scan multiple directories
varlock scan './dist/**/*.js'   # Scan files matching a glob pattern
```

## `audit`

Scan source code for environment-variable references and compare them to the keys
defined in your schema (surfaces undeclared or unused vars).

```
varlock audit [OPTIONS] [<targets> ...]
```

| Arg / Flag       | Short | Purpose                                                                       |
| ---------------- | ----- | ----------------------------------------------------------------------------- |
| `targets`        |       | Directories to scan for env-var references (defaults to the current project). |
| `--path <path>`  | `-p`  | A specific `.env` file or directory as the schema entry point (single path).  |
| `--ignore <dir>` | `-i`  | Directory to exclude from code scanning. Repeatable.                          |

Since 1.19.0, `--ignore` (and `@auditIgnorePaths()`) accept either a bare
directory name (matches everywhere) or a path starting with `./`, `../`, `~/`, or
`/` (matches that one directory). Tune the scanner from the schema with
`@auditIgnoreKeys(KEY, PREFIX_*)` (1.21.0: never report these keys as missing,
for false positives) and `@auditExtraPatterns(regex(...), fileTypes=[...])`
(1.19.0: extra access idioms; first capture group is the key). Since 1.21.0 the
scanner no longer lexes string literals, so references inside strings are
reported too. Source: [audit decorators](https://varlock.dev/reference/root-decorators/#audit);
[changelog](https://github.com/dmno-dev/varlock/blob/varlock%401.21.0/packages/varlock/CHANGELOG.md).

`EXAMPLES:` (verbatim from `varlock audit --help`):

```
varlock audit                          # Audit current project
varlock audit --path .env.prod         # Audit using a specific env entry point
varlock audit ./src ./lib              # Only scan specific directories
varlock audit --ignore vendor          # Exclude a directory from scanning
varlock audit -i vendor -i generated   # Exclude multiple directories
```
