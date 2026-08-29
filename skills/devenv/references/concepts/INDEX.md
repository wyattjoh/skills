# Concepts index

## Topics

| Topic | File | What it covers | Load when... |
|---|---|---|---|
| devenv.yaml | `devenv-yaml.md` | Full `devenv.yaml` option reference: `backend`, `clean.*`, `imports`, `impure`, `inputs.*`, `nixpkgs.*` (allow_broken/allow_unfree/cuda/rocm/per_platform/licenses), `profile`, `reload`, `require_version`, `secretspec.*`, `shell`, `strict_ports` | Editing `devenv.yaml`, declaring/following inputs, toggling unfree/broken/insecure package policy, setting a default profile or shell |
| environment-variables | `environment-variables.md` | devenv-defined vars (`DEVENV_ROOT`, `DEVENV_DOTFILE`, `DEVENV_STATE`, `DEVENV_RUNTIME`, `DEVENV_PROFILE`, `DEVENV_HOME`, `DEVENV_MAX_JOBS`, `DEVENV_CORES`, `DEVENV_SHELL_TYPE`, `DEVENV_TUI`, `DEVENV_TRACE_TO`, `DEVENV_TRACE_DEFAULT_TO`, `DEVENV_INCLUDE_ENVRC`, `DEVENV_NO_AI_AGENT`) and externally-read vars (`SHELL`, `HOME`, `XDG_*`, `TMPDIR`, `CI`, `RUST_LOG`, `NO_COLOR`, `TERM`, `*_PROXY`, `CACHIX_AUTH_TOKEN`, `SECRETSPEC_PROVIDER/PROFILE`) | Referencing `$DEVENV_*` paths from scripts/tasks, debugging proxy/cache/shell-detection/tracing behavior |
| language-server | `language-server.md` | `devenv lsp` — bundled `nixd` LSP for `devenv.nix`, `--print-config` | Wiring editor LSP/autocomplete support for devenv config files |
| mcp-server | `mcp-server.md` | `devenv mcp` — MCP server exposing `search_packages`/`search_options` to AI assistants, stdio vs `--http` mode | Setting up devenv's own MCP server for Claude Code or other AI tools |
| outputs | `outputs.md` | `outputs` attribute for defining Nix derivations/packages; per-language `import` functions (Rust via crate2nix, Python via uv2nix); `devenv build` | Packaging an app as a distributable derivation; building specific outputs |
| overlays | `overlays.md` | `overlays` list (`final: prev: {...}`) to patch existing packages, add custom packages, or pull a package from a second nixpkgs input | Patching a package, overriding a package version, adding a custom derivation to `pkgs` |
| packages | `packages.md` | `packages` list, package outputs (`dev`/`bin`/`lib` vs `out`), pinning one exact package version via `nixpkgs-multiverse` (`multiverse.<pkg>."<ver>"`, `multiverse.pins {...}`), `devenv search` | Adding executables/libraries to the shell, pinning a single package to an exact version, searching for a package/file |
| pinning | `pinning.md` | `devenv.lock` mechanics, how `?rev=`/`?ref=` resolve, `devenv update [input]`, `devenv inputs add`, multiverse per-package pin workflow | Explaining reproducibility, refreshing/locking inputs, pinning a specific nixpkgs revision |
| processes | `processes.md` | `processes.<name>` option; `devenv up`/`down`; native process manager attach/background start; `after`/`before` deps with `@started`/`@ready`/`@completed` states; ready probes (exec/http/notify); restart & shutdown policies; file watching; socket activation; watchdog; automatic port allocation & strict-port mode; alternative process manager comparison table | Defining background daemons/dev servers, wiring service readiness/dependencies, choosing or comparing process-manager backends |
| profiles | `profiles.md` | `profiles.<name>.module`/`extends`, `--profile` CLI flag, deterministic priority order (base < hostname < user < manual, extends resolves parent-first), `profiles.hostname.<host>`, `profiles.user.<name>`, referencing `config` inside a profile | Creating environment variants (backend/frontend/testing), machine- or user-specific auto-activated config |
| repl | `repl.md` | `devenv repl` — interactive Nix REPL exposing `devenv.config`, `devenv.options`, `devenv.shell`, `devenv.build`, `pkgs`, `inputs` | Interactively inspecting resolved config/options/packages/inputs for debugging |
| scripts | `scripts.md` | `scripts.<name>.exec`, per-script `packages` (runtime-only deps), pinning package paths inline, running a script via another language's `package`/`binary` | Defining custom shell helper commands exposed on `devenv shell` entry |
| tasks | `tasks.md` | `tasks."ns:name"` option; dependency DAG via `before`/`after`; dependency states (`@started`/`@ready`/`@succeeded`/`@completed`) and failure propagation; execution modes (`single`/`before`/`after`/`all`); `devenv:enterShell`/`devenv:enterTest` lifecycle hooks; `status` short-circuit and `execIfModified` caching; task inputs/outputs (`$DEVENV_TASK_INPUT`, `$DEVENV_TASKS_OUTPUTS`, `$DEVENV_TASK_OUTPUT_FILE`, `$DEVENV_TASK_EXPORTS_FILE`); shell messages; "processes as tasks" (`devenv:processes:<name>`) | Wiring build/setup steps with dependencies, hooking setup work into shell/test entry, passing data between tasks, running per-process setup/cleanup |
| tests | `tests.md` | `enterTest`, `devenv test`, auto-detected `.test.sh`, processes started/stopped around tests, `config.devenv.isTesting`, `wait_for_port` helper | Writing environment validation tests, testing against processes/services |

## Core mental model

- **`devenv.nix`** is the module-system config for one project: `packages`, `env`, `scripts`, `processes`, `services`, `languages`, `tasks`, `enterShell`, `enterTest`, `outputs`, `profiles`, etc. It's evaluated with Nix.
- **`devenv.yaml`** configures the *inputs* to that evaluation: which `inputs` (nixpkgs and others) to use, `imports` of other devenv.nix/yaml files, nixpkgs policy (`allow_unfree`, `allow_broken`, licenses...), and CLI-adjacent defaults (`profile`, `shell`, `reload`, `strict_ports`, `secretspec.*`).
- **`devenv.lock`** is the resolved-input lockfile (like package-lock/poetry.lock): every `devenv.yaml` input is pinned to an exact revision here. `devenv update [name]` is the only thing that intentionally moves it forward; day-to-day commands never silently pull newer commits. Commit it.
- **`packages`**: executables/libs on PATH. **`scripts`**: user-defined CLI helper commands (optionally with their own runtime `packages`). **`env`**: environment variables for the shell. **`enterShell`/`enterTest`**: shell hooks (docs recommend preferring tasks with `before = ["devenv:enterShell"/"devenv:enterTest"]` over raw hook scripts for setup ordering).
- **`outputs`**: declares buildable Nix derivations (`devenv build`) for packaging/distribution, distinct from the dev shell itself.
- **`profiles`**: named config overlays merged on top of the base config, selectable via `--profile`, or auto-activated by hostname/username, composable via `extends`, resolved with deterministic priority (base → hostname → user → manual/`--profile`, last flag wins).
- **Processes, services, and tasks are unified through one dependency graph**: every `processes.<name>` is automatically also a task under the `devenv:processes:<name>` name, so `before`/`after` edges connect tasks and processes interchangeably. `services.*` (documented separately) are pre-configured processes with health checks. `devenv up` schedules a process's *upstream* deps only (`--mode all` needed to also run downstream setup/cleanup tasks); `devenv tasks run` defaults to upstream (`before` mode) too; `devenv test` runs the full graph (`all` mode), and starts/stops declared processes automatically around `enterTest`.

## patterns/

| File | Trigger |
|---|---|
| `patterns/containers.md` | Excluding dev-only packages from a container image via `config.container.isBuilding` |
| `patterns/cross-platform.md` | Conditionally configuring packages/services by OS/arch (`stdenv.isLinux`/`isDarwin`/`isAarch64`/`isx86_64`); avoiding the `//`+`optionalAttrs` "infinite recursion" trap with `lib.mkIf`/`lib.mkMerge` |
| `patterns/macos.md` | Linking macOS system frameworks via `apple.sdk`; running/compiling x86 binaries on Apple Silicon via Rosetta (`pkgs.pkgsx86_64Darwin`) |
| `patterns/nix.md` | Misc Nix-level tricks: pulling a package from `nixpkgs-unstable`, contributing fixes upstream, adding a dir to `$PATH`, dropping the C toolchain with `stdenvNoCC`, escaping `${...}` inside Nix-quoted shell scripts |

## Command surface

Core lifecycle:
- `devenv shell` — enter the dev environment
- `devenv up` / `devenv up -d` — start processes (foreground / background); `devenv up <name>` starts/attaches to a subset; `devenv up --mode all` also runs downstream setup tasks; `devenv up --strict-ports` / `--no-strict-ports`
- `devenv down` — shorthand for `devenv processes down`
- `devenv test` — build env, start/stop processes, run `enterTest`
- `devenv build [outputs.<name>]` — build declared `outputs`
- `devenv repl` — interactive Nix REPL over the evaluated config
- `devenv info` — shows locked inputs (among other info)
- `devenv search <NAME>` — search packages/options in the pinned nixpkgs
- `devenv lsp` / `devenv lsp --print-config` — nixd language server
- `devenv mcp` / `devenv mcp --http [port]` — MCP server (default HTTP port 8080)

Processes:
- `devenv processes wait --timeout 120` (default timeout 120s)
- `devenv processes stop <name>`
- `devenv processes start <name>`
- `devenv processes down`
- `devenv processes attach`

Tasks:
- `devenv tasks run <ns:name>` / `devenv tasks run <namespace>` (runs all tasks in namespace)
- `devenv tasks run <task> --mode single|before|after|all`
- `devenv tasks run <task> --input key=value` / `--input-json '{"k":"v"}'`

Inputs/pins:
- `devenv inputs add <name> <url>` / `devenv inputs add <name> <url> --follows nixpkgs`
- `devenv update` / `devenv update <name>`

Profiles:
- `devenv --profile <name> shell` (repeatable; last flag wins on conflicts)

Other flags seen in docs: `--reload` / `--no-reload`, `--shell`, `--secretspec-provider`, `--secretspec-profile`, `--verbose`, `--trace-to`, `--tui` / `--no-tui`.
