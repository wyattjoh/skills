---
name: just
description: 'Kickstart the `just` command runner and author `justfile`s. Triggers on "just", "justfile", "Justfile", "just recipe", "just --list", "run a just task", "just command runner", "just --fmt", "just --init".'
allowed-tools: Bash, Read
effort: low
---

# just

`just` is a command runner: a saner `make` for saving and running project-scoped
commands (called **recipes**) from a `justfile`. Unlike `make`, ordinary recipes do
not infer builds from file targets or timestamps; they just run commands. Unstable
cached recipes can explicitly track input contents and required outputs. It is
**flag-driven** — there are
no subcommands. The first non-flag argument is a recipe name; everything else is a
recipe argument, a `VAR=value` override, or a mode-switch flag (`--list`, `--fmt`,
`--init`, ...).

## Local setup

- Binary: typically installed via mise at `~/.local/share/mise/installs/just/latest/just` (on `PATH` as `just`).
- **Pinned version explored: `just 1.57.0`.** CLI details are verified against that
  binary's `--help`. The upstream manual snapshot reviewed includes features annotated
  through 1.58.0; version-gated items are marked with a "since" version.
- Config file read: **`justfile`** (or `.justfile`; casing like `Justfile` also works).
  `just` searches the current directory and walks **up** to the filesystem root, so
  you can run it from any subdirectory of a project.

## Global flags

Most-used flags. Full verbatim table in
[`references/commands/cli-flags.md`](references/commands/cli-flags.md). Nearly every
flag has a matching `JUST_*` env var (e.g. `JUST_UNSTABLE`, `JUST_NO_DOTENV`).

| Flag                        | Short | Purpose                                                                       |
| --------------------------- | ----- | ----------------------------------------------------------------------------- |
| `--list`                    | `-l`  | List recipes with their doc comments.                                         |
| `--summary`                 |       | One-line, space-separated recipe names.                                       |
| `--choose`                  |       | Interactively pick a recipe to run (uses `$JUST_CHOOSER`, default `fzf`).     |
| `--show <RECIPE>`           | `-s`  | Print a recipe's source.                                                      |
| `--usage <RECIPE>`          |       | Print a recipe's arguments and documentation.                                 |
| `--dump`                    |       | Print the parsed justfile (`--json` / `--dump-format json` for machine form). |
| `--evaluate [VAR]`          |       | Print all variable values, or one variable's value.                           |
| `--fmt`                     |       | Format and **overwrite** the justfile (add `--check` for check-only).         |
| `--init`                    |       | Scaffold a starter `justfile` in the project root.                            |
| `--dry-run <RECIPE>`        | `-n`  | Print what would run without executing.                                       |
| `--jobs <N>`                |       | Limit simultaneous dependencies of `[parallel]` recipes.                      |
| `--set <VAR> <VALUE>`       |       | Override a variable for this invocation.                                      |
| `--justfile <FILE>`         | `-f`  | Use a specific justfile (`-` reads stdin).                                    |
| `--working-directory <DIR>` | `-d`  | Working dir for recipes (**requires `--justfile` too**).                      |
| `--no-dotenv`               |       | Don't load a `.env` file this run.                                            |
| `--yes`                     |       | Auto-confirm `[confirm]` recipes.                                             |
| `--completions <SHELL>`     |       | Emit completions: `bash`, `elvish`, `fish`, `nushell`, `powershell`, `zsh`.   |

## Anatomy

```
just [OPTIONS] [ARGUMENTS]...
```

`[ARGUMENTS]` is a catch-all carrying `VAR=value` overrides, recipe names, and each
recipe's own arguments:

```bash
just                       # run the default recipe (first in file, or [default])
just RECIPE arg1 arg2      # run a recipe with arguments
just lint test build       # run several recipes in order (blocked by --one)
just target=release build  # positional VAR=value override, then a recipe
just MODULE RECIPE          # or  just MODULE::RECIPE  — run a submodule recipe
```

## Commands

`just` has no subcommands. Its "commands" are mode-switch flags. Full detail
(spellings, args, effects) in
[`references/commands/cli-flags.md`](references/commands/cli-flags.md).

| Mode              | Invocation                                                | Purpose                                      |
| ----------------- | --------------------------------------------------------- | -------------------------------------------- |
| Run recipe        | `just RECIPE [args]`                                      | Execute a recipe.                            |
| Discover          | `just --list` / `--summary` / `--groups` / `--choose`     | See what a project can do.                   |
| Inspect           | `just --show R` / `--dump` / `--evaluate` / `--dry-run R` | Read source / variables without running.     |
| Author            | `just --init` / `--fmt` / `--edit`                        | Create, format, or open the justfile.        |
| Configure run     | `just --set V X` / `--justfile F` / `--no-dotenv`         | Override variables, file, or dotenv loading. |
| Shell integration | `just --completions SHELL`                                | Generate shell completion scripts.           |

The **`justfile` syntax** (recipes, parameters, variables, functions, attributes,
settings, modules, dotenv) is documented in full in
[`references/justfile.md`](references/justfile.md).

## Common workflows

### Scaffold and list a project

```bash
just --init          # writes a starter justfile with a sample recipe
just --list          # names + doc comments, alphabetical
just --list --unsorted   # in source order
just --summary       # bare space-separated names
```

Source: [command-line options](https://just.systems/man/en/command-line-options.html).

### Write a first justfile

```just
# a comment directly above a recipe becomes its --list doc string
build:
    cc *.c -o main

# dependencies run first, left to right
test-all: build
    ./test --all
```

```bash
just test-all   # runs build first, then test-all
```

Source: [just manual, introduction](https://just.systems/man/en/).

### Run a recipe with arguments

```just
build target:
    @echo 'Building {{target}}…'
    cd {{target}} && make

commit MESSAGE *FLAGS:      # * = zero-or-more variadic
    git commit {{FLAGS}} -m "{{MESSAGE}}"
```

```bash
just build my-project
just commit "fix typo" --amend
```

Source: [recipe parameters](https://just.systems/man/en/recipe-parameters.html).

### Inspect before running

```bash
just --usage deploy     # print arguments and documentation
just --show deploy      # print the recipe's source
just --dry-run deploy   # print the commands without executing them
just --dump --dump-format json  # machine-readable recipes, attributes, and metadata
just --evaluate         # dump variables; note that this evaluates backticks
```

Source: [command-line options](https://just.systems/man/en/command-line-options.html).

### Choose a recipe interactively

```bash
just --choose                  # pick via $JUST_CHOOSER (default fzf)
just --chooser fzf --choose    # explicit chooser
```

Source: [command-line options](https://just.systems/man/en/command-line-options.html).

### Format the justfile

```bash
just --fmt           # rewrite in canonical style, in place
just --fmt --check   # exit 0 if already formatted, exit 1 + diff otherwise
```

`--fmt` is **stable in v1.57.0** (no `--unstable` needed). Older releases required
`--unstable`; if a pinned older `just` errors, add it.
Source: [formatting / print](https://just.systems/man/en/print.html).

### Override a variable for one run

```bash
just --set target release build    # explicit flag (two values)
just target=release build          # positional override form
```

Source: [setting variables from the command line](https://just.systems/man/en/setting-variables-from-the-command-line.html).

### Cache an expensive script recipe

```just
set unstable
set lists

[script]
[cache(inputs = ["lib.c", "main.c"], outputs = "main")]
build:
    cc lib.c main.c -o main
```

Cached recipes are unstable and intentionally explicit: input contents are hashed,
all outputs must exist, and `[cache]` only applies to script recipes. Use `just
--no-cache build` to force a run or `just --clean build` to clear its cache entries.
Read the limitations in
[`references/justfile.md`](references/justfile.md#cached-recipes) before relying on
caching.

Source: [cached recipes](https://just.systems/man/en/cached-recipes.html).

### Load env from `.env`

```just
set dotenv-load     # load ./.env if present

serve:
    ./server --database $DATABASE_ADDRESS --port $SERVER_PORT
```

```bash
just serve              # env comes from ./.env
just --no-dotenv serve  # skip .env this run
```

`just` does not load `.env` by default. Add `set dotenv-load` (or configure an
explicit dotenv setting) when recipes should receive values from it.
Source: [settings](https://just.systems/man/en/settings.html).

### Split a large justfile into modules

```just
mod frontend      # loads frontend.just / frontend/mod.just / frontend/justfile
mod backend
```

```bash
just frontend build
just backend::test
```

Source: [modules](https://just.systems/man/en/modules.html).

### Cross-platform recipes (inferred)

```just
[unix]
open target:
    xdg-open {{target}}

[macos]
open target:
    open {{target}}

[windows]
open target:
    start {{target}}
```

`(inferred)` — assembled from the OS-attribute definitions in
[attributes](https://just.systems/man/en/attributes.html); `just` selects the recipe
matching the host OS. Not copied verbatim from a single manual code block.

## References

- [`references/commands/cli-flags.md`](references/commands/cli-flags.md) — the complete
  flag surface (v1.57.0 `--help`), grouped by mode, with args, short forms, env vars,
  and effect warnings.
- [`references/justfile.md`](references/justfile.md) — the `justfile` format: recipes,
  parameters, variables, string types, functions, attributes, settings, aliases,
  modules, imports, shebang/script recipes, and dotenv.
