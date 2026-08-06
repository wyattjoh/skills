# The `justfile` format

A `justfile` is a line-oriented file of variable assignments, settings, aliases,
imports, module declarations, and recipes. Comments start with `#`. Recipe bodies are
**indented** (consistent tabs or spaces). `just` finds it by searching the current
directory and walking up to the root; filenames `justfile` and `.justfile` (any
casing) match.

All syntax below is from the [just manual](https://just.systems/man/en/). The
reviewed upstream snapshot includes features annotated through 1.58.0.
Attribute/setting availability is annotated with the version it was introduced
("since"); the pinned local binary is **1.57.0**, so verify newer features with `just
--version` before relying on them.

## Recipes and dependencies

Source: [manual introduction](https://just.systems/man/en/) and
[recipe-parameters](https://just.systems/man/en/recipe-parameters.html).

```just
# a comment directly above a recipe becomes its --list doc string
build:
    cc *.c -o main

# dependencies run first, left to right
test-all: build
    ./test --all

# multiple dependencies
default: build test-all
```

- The **first** recipe is the default (run by bare `just`) unless a recipe carries the
  `[default]` attribute.
- Line prefixes: `@` suppresses echoing a line; `-` ignores that line's error;
  `@-` combines both. `@` before the **recipe name** makes the whole recipe quiet.
- Each recipe line runs in its own shell invocation (state does not carry between
  lines) unless the recipe is a shebang/script recipe.

## Parameters

Source: [recipe-parameters](https://just.systems/man/en/recipe-parameters.html).

```just
# positional parameter, interpolated with {{...}}
build target:
    cd {{target}} && make

# default value
tests := 'all'
test target suite=tests:
    ./test --suite {{suite}} {{target}}
# just test server        -> suite defaults to 'all'
# just test server unit   -> overrides

# variadic + : one or more args, space-joined
backup +FILES:
    scp {{FILES}} me@server.com:

# variadic * : zero or more args (empty string if none)
commit MESSAGE *FLAGS:
    git commit {{FLAGS}} -m "{{MESSAGE}}"
```

### Passing arguments to dependencies

```just
# dependency with a literal argument
default: (build "main")

build target:
    @echo 'Building {{target}}…'

# forward this recipe's own argument to a dependency
release version: (build version)
    @echo 'Releasing {{version}}'
```

## Variables and assignments

Source: [variables-and-assignments](https://just.systems/man/en/variables-and-assignments.html),
[functions](https://just.systems/man/en/functions.html).

```just
name := "app"                        # := assignment; RHS is an expression
commit := `git rev-parse --short HEAD`  # backtick: command substitution at parse time
target := "build" / name             # + concatenates; / joins paths
greeting := "hello " + name
```

Override from the command line with `just name=value RECIPE` or
`just --set name value RECIPE`.

## String types

Source: [strings](https://just.systems/man/en/strings.html).

- `'single'` — raw, no escape processing.
- `"double"` — supports escapes (`\n`, `\t`, `\"`, ...).
- `` `backtick` `` — runs the command in the shell; value is its stdout (trailing
  newline trimmed). Triple ` ``` ` ``` allowed for multi-line.
- Indented triple-quoted `'''...'''` / `"""..."""` — strip a leading newline and common
  leading indentation. Single-quote triple ignores escapes; double-quote triple
  processes them.

```just
x := '''
  foo
  bar
'''   # => "foo\nbar\n"
```

## Interpolation and expressions

Source: [functions](https://just.systems/man/en/functions.html),
[conditional expressions](https://just.systems/man/en/conditional-expressions.html).

```just
# {{ }} interpolates expressions into recipe lines and strings
sh := if os() == "windows" { "cmd" } else { "sh" }   # if / else if / else
is_abs := if path =~ '^/' { "yes" } else { "no" }    # =~ regex match in a condition
```

## Built-in functions

Source: [functions](https://just.systems/man/en/functions.html).

- **System:** `os()`, `os_family()`, `arch()`, `num_cpus()`.
- **Env:** `env(key)` (aborts if unset), `env(key, default)`; deprecated aliases
  `env_var(key)`, `env_var_or_default(key, default)`.
- **Invocation / paths:** `invocation_directory()`, `justfile()`,
  `justfile_directory()`, `source_file()`, `source_directory()`, `just_executable()`,
  `just_pid()`, `just_version()`, `home_directory()`.
- **Strings:** `uppercase`, `lowercase`, `trim`, `trim_start`, `trim_end`, `replace`,
  `replace_regex`, `append`, `prepend`, `quote`, `shell(command, args...)`.
- **Paths:** `absolute_path`, `canonicalize`, `extension`, `file_name`, `file_stem`,
  `parent_directory`, `without_extension`, `join`, `clean`, `path_exists`.
- **Hash / uuid:** `sha256`, `sha256_file`, `blake3`, `blake3_file`, `uuid`.
- **Control:** `error(message)`, `assert(condition, message)`.

Note: backticks evaluate at parse/assignment time; `shell(...)` is a function call
evaluated where it appears.

## Lists (unstable)

Source: [lists](https://just.systems/man/en/lists.html).

Lists were introduced in 1.53.0 but remain unstable. Enable both gates before using
them:

```just
set unstable
set lists

sources := ["lib.c", "main.c"]
more := sources ++ ["platform.c"]

[script]
show *ARGS:
    printf '%s\n' {{ARGS}}
```

List literals contain strings and flatten nested lists. With `set lists`, variadic
parameters are lists instead of space-separated strings. Interpolation joins a list
with spaces, `++` concatenates lists, and `join_list()` converts a list for built-in
functions that do not yet accept one. List behavior may still change incompatibly.

## Settings

Source: [settings](https://just.systems/man/en/settings.html). Written
`set NAME := VALUE`; boolean settings may be written bare (`set export` ==
`set export := true`).

| Setting                     | Type           | Default        | Purpose                                               |
| --------------------------- | -------------- | -------------- | ----------------------------------------------------- |
| `allow-duplicate-recipes`   | bool           | false          | Later recipe overrides an earlier same-named one.     |
| `allow-duplicate-variables` | bool           | false          | Later variable overrides an earlier same-named one.   |
| `dotenv-load`               | bool           | false          | Load a `.env` file if present.                        |
| `dotenv-filename`           | string/list    | –              | Name(s) of the dotenv file to load.                   |
| `dotenv-path`               | string/list    | –              | Explicit dotenv path (error if missing).              |
| `dotenv-override`           | bool           | false          | Dotenv values override existing env vars.             |
| `dotenv-required`           | bool           | false          | Error if no dotenv file is found.                     |
| `dotenv-command`            | string         | –              | Run a command, load its stdout as env.                |
| `export`                    | bool           | false          | Export all justfile variables as env vars.            |
| `fallback`                  | bool           | false          | Defer unknown recipes to a parent-directory justfile. |
| `ignore-comments`           | bool           | false          | Drop recipe lines that start with `#`.                |
| `positional-arguments`      | bool           | false          | Pass args as `$0`, `$1`, ... inside recipes.          |
| `quiet`                     | bool           | false          | Don't echo recipe lines.                              |
| `shell`                     | `[cmd, args…]` | platform sh    | Shell for recipes and backticks.                      |
| `windows-shell`             | `[cmd, args…]` | –              | Shell on Windows (overrides `shell` there).           |
| `script-interpreter`        | `[cmd, args…]` | `['sh','-eu']` | Interpreter for empty `[script]`.                     |
| `tempdir`                   | string         | –              | Directory for script temp files.                      |
| `working-directory`         | string         | –              | Working dir for recipes and backticks.                |
| `unstable`                  | bool           | false          | Enable unstable features.                             |
| `no-exit-message`           | bool           | false          | Suppress the "recipe failed" message.                 |
| `minimum-version`           | string         | –              | Error if `just` is older than the given version.      |

```just
set shell := ["zsh", "-cu"]
set windows-shell := ["powershell.exe", "-NoProfile", "-Command"]
set dotenv-load
set export
set positional-arguments
```

Put a minimum-version guard at the top of a justfile before syntax that older versions
may not understand:

```just
set minimum-version := "1.55.0"
```

`minimum-version` was added in 1.55.0. It produces a clear version error when the
file can be parsed, but lexer-level syntax changes may fail before the guard is
reached.

Advanced settings such as `default-script`, `guards`, `lazy`, `lists`, and
`indentation` may be unstable or version-gated. Verify them against the target `just`
version.

## Attributes

Source: [attributes](https://just.systems/man/en/attributes.html). Attributes go in
`[brackets]` on the line(s) above a recipe (or module/alias/variable where noted).
"Since" is the minimum `just` version. **The local binary is 1.57.0**; verify
anything newer against the target environment.

| Attribute                                | Since       | Purpose                                                                     |
| ---------------------------------------- | ----------- | --------------------------------------------------------------------------- |
| `[private]`                              | 1.10        | Hide the recipe/alias/variable from `--list`.                               |
| `[default]`                              | 1.43        | Mark as the default recipe.                                                 |
| `[doc(DOC)]` / `[doc]`                   | 1.27        | Set (or, bare, suppress) the doc string.                                    |
| `[group(NAME)]`                          | 1.27        | Assign to a group (shown by `--groups`).                                    |
| `[confirm]` / `[confirm(PROMPT)]`        | 1.17 / 1.23 | Prompt before running (bypass with `--yes`).                                |
| `[no-cd]`                                | 1.9         | Don't cd into the justfile dir before running.                              |
| `[working-directory(PATH)]`              | 1.38        | Run the recipe in `PATH`.                                                   |
| `[no-exit-message]` / `[exit-message]`   | 1.7 / 1.39  | Hide / force the failure message.                                           |
| `[no-quiet]`                             | 1.23        | Echo this recipe even under global `quiet`.                                 |
| `[positional-arguments]`                 | 1.29        | Expose args as `$0`, `$1`, ... for this recipe only.                        |
| `[script]` / `[script(COMMAND)]`         | 1.33 / 1.32 | Run the whole body as one script via the interpreter (or `COMMAND`).        |
| `[extension(EXT)]`                       | 1.32        | Temp-file extension for shebang/script recipes.                             |
| `[env(NAME, VALUE)]`                     | 1.47        | Set an env var for the recipe.                                              |
| `[metadata(VALUES...)]`                  | 1.42        | Attach string metadata exposed by JSON dumps.                               |
| `[parallel]`                             | 1.42        | Run the recipe's dependencies in parallel.                                  |
| `[linux]` `[macos]` `[windows]` `[unix]` | 1.8         | Recipe runs only on the matching OS; same-named recipes select by platform. |
| `[cache(...)]`                           | 1.54        | Cache a script recipe by invocation, inputs, outputs, and extra data.       |
| `[continue(SIGNALS)]`                    | 1.54        | Continue running after selected signals.                                    |
| `[arg(ARG, ...)]` (min= / max=)          | 1.56.0      | Add per-argument constraints.                                               |

```just
[private]
_helper:
    @echo internal

[confirm("Deploy to prod?")]
[group('deploy')]
deploy:
    ./deploy.sh
```

## Aliases

Source: [aliases](https://just.systems/man/en/aliases.html).

```just
alias b := build
build:
    echo 'Building!'
# just b   ->  runs build
```

## Shebang / script recipes

Source: [shebang recipes](https://just.systems/man/en/shebang-recipes.html). A recipe
whose first body line is a `#!` shebang is written to a temp file and run as one whole
script (normal multi-line shell/python/etc. works, no per-line shell):

```just
polyglot:
    #!/usr/bin/env python3
    import sys
    print("hello from python", sys.version)
```

Alternatively use `[script('python3')]`, `set script-interpreter`, and
`[extension('.py')]` to control the interpreter and temp-file extension without a
shebang.

## Cached recipes

Source: [cached recipes](https://just.systems/man/en/cached-recipes.html),
[input files](https://just.systems/man/en/input-files.html), and
[output files](https://just.systems/man/en/output-files.html).

`[cache]` was introduced in 1.54.0, remains unstable, and is only valid on script
recipes:

```just
set unstable
set lists

[script]
[cache(inputs = ["lib.c", "main.c"], outputs = "main", extra = `cc --version`)]
build:
    cc lib.c main.c -o main
```

- Inputs are BLAKE3-hashed into the cache key. Missing inputs and directories are
  errors. Relative paths start at the recipe's working directory.
- Outputs are not part of the cache key. Every output must exist to skip the recipe,
  and a successful run that does not create every declared output is an error.
- `extra` adds strings, such as a compiler version, to the cache key.
- `just --no-cache build` bypasses the cache. `just --clean [RECIPE_PATH...]` deletes
  cache entries and is a mutating operation.

Caching is inherently fragile. Cache entries do not make outputs portable, inspect
undeclared dependencies, or replace a build system's dependency graph. Declare every
relevant input and output, and use it only when those limitations are acceptable.

## Recipe metadata

Source: [metadata](https://just.systems/man/en/metadata.html).

Attach string metadata for tooling and agents, then inspect it in the JSON dump:

```just
[metadata("category", "release")]
deploy:
    ./deploy
```

```bash
just --dump --dump-format json
```

## Modules and imports

Source: [modules](https://just.systems/man/en/modules.html) and
[imports](https://just.systems/man/en/imports.html).

```just
# modules stay nested — invoke as `just MODULE RECIPE` or `just MODULE::RECIPE`
mod frontend           # loads frontend.just / frontend/mod.just / frontend/justfile
mod backend 'path'     # explicit path
mod? optional          # no error if the module file is missing

# imports splice another file's recipes/vars into THIS namespace (flat)
import 'common.just'
import? 'optional.just'  # no error if missing
```

## Dotenv and exported variables

Source: [settings](https://just.systems/man/en/settings.html).

```just
set dotenv-load     # load ./.env if present; its vars become recipe env vars
set export          # export all justfile vars as env vars

a := "hello"
@greet b:
    echo $a         # justfile var (exported)
    echo $b         # recipe parameter
```

Per-variable export also works: `export name := "value"`. Control dotenv loading with
`dotenv-filename`, `dotenv-path`, `dotenv-required`, `dotenv-override`, or the
`--dotenv-*` / `--no-dotenv` CLI flags.
