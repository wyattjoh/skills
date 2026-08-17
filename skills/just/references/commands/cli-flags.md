# just — CLI flag reference

`just` is a single command with no subcommands. Every "mode" is a flag. This table
is transcribed from `just --help` on the **pinned local binary, v1.57.0**
(spellings, short forms, argument placeholders, and `[env: ...]` / `[default: ...]` /
`[possible values: ...]` annotations are authoritative). Explanations are drawn from
the [just manual](https://just.systems/man/en/command-line-options.html).

Source of truth: `just --help` (v1.57.0). The reviewed upstream manual snapshot also
contains newer, version-gated features; the binary wins when they disagree.

## Invocation

```
just [OPTIONS] [ARGUMENTS]...
```

`[ARGUMENTS]...` — "Overrides and recipe(s) to run, defaulting to the first recipe in
the justfile." It carries `VAR=value` overrides, recipe names, and each recipe's own
arguments, in order.

## Action flags (mode switches)

Listed under `Commands:` in the help. **Several produce side effects — do not run
them blindly.**

| Flag            | Short | Arg                  | Purpose                                                                                      | Effect                     |
| --------------- | ----- | -------------------- | -------------------------------------------------------------------------------------------- | -------------------------- |
| `--list`        | `-l`  | `[<MODULE>...]`      | List recipes in `<MODULE>` (root if omitted), with doc comments.                             | read-only                  |
| `--summary`     |       |                      | Space-separated recipe names on one line.                                                    | read-only                  |
| `--groups`      |       |                      | List recipe groups (see `[group(...)]`).                                                     | read-only                  |
| `--choose`      |       |                      | Pick recipe(s) via a chooser (`$JUST_CHOOSER`, default `fzf`).                               | **runs recipes**           |
| `--show`        | `-s`  | `<RECIPE_PATH>...`   | Print a recipe's source.                                                                     | read-only                  |
| `--usage`       |       | `<RECIPE_PATH>...`   | Print usage info (args + doc) for a recipe.                                                  | read-only                  |
| `--dump`        |       |                      | Print the parsed justfile.                                                                   | read-only                  |
| `--json`        |       |                      | Print the justfile as JSON.                                                                  | read-only                  |
| `--variables`   |       |                      | List variable names.                                                                         | read-only                  |
| `--evaluate`    |       |                      | Print all variables and values; with a name arg, just that one.                              | read-only (runs backticks) |
| `--fmt`         |       |                      | **Format and overwrite** the justfile.                                                       | **writes justfile**        |
| `--init`        |       |                      | Create a new justfile in the project root.                                                   | **writes justfile**        |
| `--edit`        | `-e`  |                      | Open the justfile in `$VISUAL`/`$EDITOR` (falls back to `vim`).                              | **opens editor**           |
| `--command`     | `-c`  | `<COMMAND>...`       | Run an arbitrary command with the working dir, `.env`, overrides, and exports set.           | **executes a command**     |
| `--clean`       |       | `[<RECIPE_PATH>...]` | Clear the recipe cache (optionally by path prefix).                                          | **mutates cache**          |
| `--completions` |       | `<SHELL>`            | Print a completion script. `[possible values: bash, elvish, fish, nushell, powershell, zsh]` | read-only                  |
| `--changelog`   |       |                      | Print the changelog.                                                                         | read-only                  |
| `--man`         |       |                      | Print the man page.                                                                          | read-only                  |

## Option flags

### Listing / discovery display

| Flag                 | Short | Arg             | Notes                                                                        |
| -------------------- | ----- | --------------- | ---------------------------------------------------------------------------- |
| `--unsorted`         | `-u`  |                 | List/summary in source order instead of alphabetical. `[env: JUST_UNSORTED]` |
| `--list-heading`     |       | `<TEXT>`        | Override the list heading. `[default: "Available recipes:\n"]`               |
| `--list-prefix`      |       | `<TEXT>`        | Override each list item's prefix. `[default: "    "]`                        |
| `--list-submodules`  |       |                 | Include submodule recipes in the list.                                       |
| `--group`            |       | `<GROUP>`       | Only list recipes in `<GROUP>`.                                              |
| `--no-aliases`       |       |                 | Hide aliases in the list.                                                    |
| `--alias-style`      |       | `<ALIAS_STYLE>` | `[default: right]` `[possible values: left, right, separate]`                |
| `--complete-aliases` |       |                 | Auto-complete recipe aliases.                                                |
| `--default-list`     |       |                 | List recipes when no arguments are given (instead of running the default).   |
| `--chooser`          |       | `<CHOOSER>`     | Override the chooser command used by `--choose`. `[env: JUST_CHOOSER]`       |

### Inspection / debugging

| Flag                 | Short | Arg          | Notes                                                                                                      |
| -------------------- | ----- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| `--dry-run`          | `-n`  |              | Print what `just` would do without doing it.                                                               |
| `--dump-format`      |       | `<FORMAT>`   | `[default: just]` `[possible values: json, just]`                                                          |
| `--evaluate-format`  |       | `<FORMAT>`   | `[default: just]` `[possible values: just, shell]`                                                         |
| `--explain`          |       |              | Print a recipe's doc comment before running it.                                                            |
| `--check`            |       |              | Run `--fmt` in check mode: exit 0 if formatted, exit 1 + diff otherwise. **Only meaningful with `--fmt`.** |
| `--time`             |       |              | Print recipe execution time.                                                                               |
| `--timestamp`        |       |              | Prefix recipe command output with timestamps.                                                              |
| `--timestamp-format` |       | `<FMT>`      | `[default: %H:%M:%S]`                                                                                      |
| `--verbose`          | `-v`  | (repeatable) | Verbose output.                                                                                            |
| `--quiet`            | `-q`  |              | Suppress all output.                                                                                       |

### File / working directory selection

| Flag                  | Short | Arg          | Notes                                                                               |
| --------------------- | ----- | ------------ | ----------------------------------------------------------------------------------- |
| `--justfile`          | `-f`  | `<JUSTFILE>` | Use this justfile, or `-` to read from stdin. `[env: JUST_JUSTFILE]`                |
| `--justfile-name`     |       | `<NAME>`     | Search for a justfile with this name (comma-separated list accepted, since 1.58.0). |
| `--working-directory` | `-d`  | `<DIR>`      | Working dir for recipes. **`--justfile` must also be set.**                         |
| `--global-justfile`   | `-g`  |              | Use the global justfile (`$XDG_CONFIG_HOME/just/justfile`, `~/.justfile`, ...).     |
| `--ceiling`           |       | `<CEILING>`  | Do not ascend above `<CEILING>` when searching upward.                              |
| `--allow-missing`     |       |              | Ignore missing recipe and module errors.                                            |

### Execution control

| Flag                 | Short | Arg             | Notes                                                          |
| -------------------- | ----- | --------------- | -------------------------------------------------------------- |
| `--set`              |       | `<VAR> <VALUE>` | Override a variable (takes two values).                        |
| `--shell`            |       | `<SHELL>`       | Shell used to run recipes.                                     |
| `--shell-arg`        |       | `<ARG>`         | Argument passed to the shell (repeatable).                     |
| `--shell-command`    |       |                 | Invoke `<COMMAND>` with the recipe shell.                      |
| `--clear-shell-args` |       |                 | Clear shell arguments.                                         |
| `--one`              |       |                 | Forbid invoking more than one recipe on the command line.      |
| `--no-deps`          |       |                 | Don't run recipe dependencies.                                 |
| `--jobs`             |       | `<N>`           | Limit simultaneous dependencies of `[parallel]` recipes.       |
| `--no-cache`         |       |                 | Bypass the recipe cache.                                       |
| `--yes`              |       |                 | Auto-confirm `[confirm]` recipes. `[env: JUST_YES]`            |
| `--tempdir`          |       | `<TEMPDIR>`     | Directory for shebang/script temp files.                       |
| `--unstable`         |       |                 | Enable unstable features. `[env: JUST_UNSTABLE]`               |
| `--indentation`      |       | `<INDENTATION>` | Indent recipe bodies with `<INDENTATION>`. `[default: "    "]` |
| `--cygpath`          |       | `<CYGPATH>`     | Binary to convert unix/Windows paths. `[default: cygpath]`     |

`--jobs` was added in v1.56.0. It only limits dependencies that are eligible to run
concurrently, such as dependencies of a recipe with `[parallel]`.

### Dotenv

| Flag                | Short | Arg         | Notes                                                    |
| ------------------- | ----- | ----------- | -------------------------------------------------------- |
| `--no-dotenv`       |       |             | Don't load a `.env` file. `[env: JUST_NO_DOTENV]`        |
| `--dotenv-filename` | `-F`  | `<NAME>`    | Search for an env file named `<NAME>` instead of `.env`. |
| `--dotenv-path`     | `-E`  | `<PATH>`    | Load `<PATH>` as the env file instead of searching.      |
| `--dotenv-command`  |       | `<COMMAND>` | Run `<COMMAND>` and load its stdout as environment.      |

### Color / output styling

| Flag              | Short | Arg       | Notes                                                                                               |
| ----------------- | ----- | --------- | --------------------------------------------------------------------------------------------------- |
| `--color`         |       | `<COLOR>` | `[default: auto]` `[possible values: always, auto, never]`                                          |
| `--command-color` |       | `<COLOR>` | Echo recipe lines in this color. `[possible values: black, blue, cyan, green, purple, red, yellow]` |
| `--highlight`     |       |           | Highlight echoed recipe lines in bold.                                                              |
| `--no-highlight`  |       |           | Don't highlight echoed lines.                                                                       |

### Meta

| Flag        | Short | Notes                          |
| ----------- | ----- | ------------------------------ |
| `--help`    | `-h`  | Print help.                    |
| `--version` | `-V`  | Print version (`just 1.57.0`). |

## Notes

- **No per-flag help pages.** `just` is a single clap command; `just --completions
--help` does not print sub-help (it errors that a `<SHELL>` value is required).
- **No `EXAMPLES:` block** is printed by `just --help`.
- Almost every flag has a matching `JUST_*` environment variable (shown inline as
  `[env: ...]`), so behavior can be set via env instead of flags.
- With no arguments, `just` runs the **first** recipe (or the one marked `[default]`).
  `--default-list` / `JUST_DEFAULT_LIST` makes a bare `just` list recipes instead.
