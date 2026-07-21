# Security commands: scan, audit

Guardrails that compare your resolved config and code against the schema.
Verified against `varlock 1.10.0` `--help`.

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
| `--path <path>`  | `-p`  | A specific `.env` file or directory as the schema entry point.                |
| `--ignore <dir>` | `-i`  | Directory to exclude from code scanning. Repeatable.                          |

`EXAMPLES:` (verbatim from `varlock audit --help`):

```
varlock audit                          # Audit current project
varlock audit --path .env.prod         # Audit using a specific env entry point
varlock audit ./src ./lib              # Only scan specific directories
varlock audit --ignore vendor          # Exclude a directory from scanning
varlock audit -i vendor -i generated   # Exclude multiple directories
```
