# Guides Index

## Start here

Read in this order if you're new to devenv:

1. [getting-started.md](./getting-started.md) — install Nix + devenv, `devenv init`, and the full command reference (`shell`, `up`, `test`, `gc`, etc). The map of every other doc.
2. [basics.md](./basics.md) — anatomy of `devenv.nix` (it's a Nix function returning an attrset), `env`, `packages`, `enterShell`, and `devenv info`.
3. [files-and-variables.md](./files-and-variables.md) — what each project file does (`devenv.nix`, `devenv.yaml`, `devenv.lock`, `.local` overrides, `.envrc`) so later guides' file references make sense.
4. [auto-activation.md](./auto-activation.md) — set up `devenv hook` (or direnv) so the shell activates automatically on `cd`; the natural next step once a project exists.

## All guides

| Guide | File | What it covers | Load when... |
|---|---|---|---|
| **Getting started** | | | |
| Getting Started | [getting-started.md](./getting-started.md) | Install Nix/devenv, `devenv init`, full CLI command reference | setting up devenv for the first time, or need a command reference |
| Basics | [basics.md](./basics.md) | `devenv.nix` structure, `env`, `packages`, `enterShell`, `devenv info` | writing your first `devenv.nix` |
| Ad-hoc Developer Environments | [ad-hoc-developer-environments.md](./ad-hoc-developer-environments.md) | `--option`/`-O` flag for config-file-free temporary shells | need a throwaway env or CLI-only override without a `devenv.nix` |
| Auto Activation | [auto-activation.md](./auto-activation.md) | `devenv hook` shell integration, `devenv allow`/`revoke`, comparison with direnv | wiring up automatic shell activation on `cd` |
| **Project structure & composition** | | | |
| Composing using imports | [composing-using-imports.md](./composing-using-imports.md) | `imports:` in `devenv.yaml`, local vs. input-based imports, sharing config across repos | splitting one project into composable pieces, or importing a shared base config |
| Monorepo with Shared Configurations | [monorepo-with-shared-configurations.md](./monorepo-with-shared-configurations.md) | Structuring a monorepo with a `shared/devenv.nix`, absolute `/shared` imports, `config.git.root` | multiple services in one repo need a common base config |
| Polyrepos | [polyrepos.md](./polyrepos.md) | Composing across separate repos: full merge via imports vs. narrow access via `inputs.<name>.devenv.config` | need to consume config/outputs from another repo's devenv project |
| Inputs | [inputs.md](./inputs.md) | `devenv.yaml` inputs, default nixpkgs/git-hooks, supported URI schemes, `follows`, `devenv inputs add`, locking | adding/pinning a dependency, or understanding `devenv.lock` |
| **Nix interop** | | | |
| Using devenv with Nix Flakes | [using-devenv-with-nix-flakes.md](./using-devenv-with-nix-flakes.md) | `devenv.lib.mkShell` in a raw `flake.nix`, feature comparison table vs. devenv CLI, multiple/external shells | integrating devenv into an existing flake-based project without flake-parts |
| Using devenv with flake-parts | [using-devenv-with-flake-parts.md](./using-devenv-with-flake-parts.md) | `flake-parts` + `devenv.flakeModule`, `perSystem.devenv.shells`, importing modules, multiple shells | same as above but using the flake-parts framework (recommended flake integration) |
| Extending devenv | [extending-devenv.md](./extending-devenv.md) | Writing custom option modules with `lib.mkEnableOption`, distributing best-practices modules, `disabledModules` for replacing built-ins | building an org-wide shared module or overriding a built-in language/service module |
| **Operations** | | | |
| Containers | [containers.md](./containers.md) | `devenv container build/copy/run`, packaging shells/processes/artifacts as OCI images, registry push | shipping a devenv environment or process as a container |
| Binary Caching | [binary-caching.md](./binary-caching.md) | Cachix setup (SecretSpec-based and legacy token), `cachix.pull`/`cachix.push`, conditional pushing | avoiding rebuilds from source / setting up a team binary cache |
| Garbage collection | [garbage-collection.md](./garbage-collection.md) | How GC roots work under `$DEVENV_HOME/gc/`, running `devenv gc` | reclaiming Nix store disk space |
| Git Hooks | [git-hooks.md](./git-hooks.md) | `git-hooks.hooks` (via git-hooks.nix), built-in hooks, custom hooks, CI verification with `devenv test` | adding linters/formatters that run at commit time and in CI |
| Declarative files | [declarative-files.md](./declarative-files.md) | `files.*` option: generating json/yaml/toml/ini/text files, executable files, `copyMode` (symlink/seed/copy), nested paths | generating config files or scripts from Nix data instead of hand-writing them |
| Files And Variables | [files-and-variables.md](./files-and-variables.md) | Purpose of every project file (`devenv.nix/.yaml/.lock`, `.local` variants, `.envrc`) and environment variables | orienting on what each file in a devenv project is for |
| **Migration** | | | |
| Migrating to devenv 2.0 | [migrating-to-devenv-2-0.md](./migrating-to-devenv-2-0.md) | Breaking changes: native process manager, `git-hooks` input now optional, `pre-commit`→`prek`, `devenv build` JSON output, `container --copy` removal | upgrading a project from devenv 1.x to 2.0 — see callout below |
| **Meta** | | | |
| Cloud | [cloud.md](./cloud.md) | cloud.devenv.sh (private beta): basic config, `config.cloud.enable` conditionals, GitHub CI context access | evaluating or configuring devenv Cloud / CI-specific behavior |
| Contributing | [contributing.md](./contributing.md) | Repo layout (Cargo workspace crates), build/test/lint commands, adding `changelogs`, service/language module conventions | contributing code to the devenv project itself |
| Get Involved | [get-involved.md](./get-involved.md) | Discord/Matrix community links | looking for community/help channels (very short stub) |
| Examples | [examples.md](./examples.md) | Flat list of ~70 example projects in the devenv repo (postgres, rust, django, terraform, etc.) | looking for a working example close to your stack |

## Editors

| Editor | File | Note |
|---|---|---|
| IntelliJ | [../editors/intellij.md](../editors/intellij.md) | One real tip: symlink `.devenv/state/venv/` into the project root so IntelliJ's Python interpreter detection works. |
| VS Code | [../editors/vscode.md](../editors/vscode.md) | Very short stub — just points to the third-party `datakurre.devenv` marketplace extension and its issue tracker. No devenv-specific setup content. |
| Zed | [../editors/zed.md](../editors/zed.md) | Very short stub — one-liner ("run `devenv shell` then `zeditor`") plus a link to an open GitHub discussion requesting first-class support. |

## Migration to 2.0 — breaking changes

Source: [migrating-to-devenv-2-0.md](./migrating-to-devenv-2-0.md)

- **Native process manager replaces process-compose as the default.** Plain `processes.*` configs keep working unmodified; set `process.manager.implementation = "process-compose";` to opt back in during transition.
- **`depends_on` conditions → `after` with lifecycle suffixes**, e.g. `process_healthy` → `"devenv:processes:X"` (or `@ready`), `process_completed_successfully` → `@succeeded`, `process_completed` → `@completed`.
- **Restart policy**: `process-compose.availability.{restart,backoff_seconds,max_restarts}` → `processes.<name>.restart = { on; max; window; }`. `backoff_seconds` has no native equivalent (restarts are immediate).
- **Env/cwd**: `process-compose.{environment,working_dir}` → `processes.<name>.{env,cwd}` (env becomes an attrset, not a list of `KEY=VAL` strings).
- **Readiness probes**: `process-compose.readiness_probe` → `processes.<name>.ready` (same shape, `period_seconds`→`period`). Native manager adds HTTP probes and `ready.notify` (sd_notify) as new options.
- **No native liveness probe** — replace `process-compose.liveness_probe` with `ready.notify = true` + `watchdog` (requires the process to send `WATCHDOG=1` heartbeats).
- **Shutdown signal**: `process-compose.shutdown.signal` → `processes.<name>.shutdown.signal` (same value, new location; requires devenv ≥2.2.3).
- **Elevated processes**: `process-compose.is_elevated` → `processes.<name>.linux.capabilities = [ "net_bind_service" ... ]`.
- **`git-hooks` input is no longer included by default** — must be added explicitly in `devenv.yaml` if `git-hooks.hooks` is used. The `pre-commit-hooks` alias for `git-hooks` was also removed (add it as a `follows` if you switch between 1.x/2.x).
- **`pre-commit` CLI renamed to `prek`** (Rust rewrite) — update any scripts invoking `pre-commit run ...` directly.
- **`devenv build` now outputs JSON** instead of a bare store path — scripts parsing its stdout need `jq -r '.["<attr>"]'`.
- **`devenv container --copy <name>` removed** — use the subcommand form `devenv container copy <name>`.
