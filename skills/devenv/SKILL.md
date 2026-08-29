---
name: devenv
description: Answers devenv.sh questions from an indexed local copy of the full devenv documentation. Covers devenv.nix and devenv.yaml options, 58 languages, 42 services, processes, tasks, profiles, containers, outputs, overlays, pinning, SecretSpec, direnv, and GitHub Actions. Use when the user mentions "devenv", "devenv.nix", "devenv.yaml", "devenv up", "devenv shell", "devenv test", or asks how to add a language, database, service, background process, or task to a Nix-based developer environment.
argument-hint: "[topic]"
context: fork
agent: Explore
background: false
---

# devenv documentation index

Answer the devenv question in `$ARGUMENTS` (or, if empty, the request that
triggered this skill) using the indexed corpus below.

All paths are relative to this skill's directory. The corpus is a split,
de-noised copy of the complete devenv.sh documentation: **191 topic files**
across 9 areas.

## Task

1. **Classify** the question against the routing tables below.
2. **Read** at most **1-3** topic files. Prefer one exact file over many.
3. **Answer** from what you read, with concrete `devenv.nix` / `devenv.yaml`
   snippets and exact option names.
4. **Cite** each reference file you used by path.

If the answer is already covered by *Core mental model* or *Command surface*
below, answer directly and read nothing.

## Routing

### Fast path — languages and services

Filenames are the topic name, so the path is derivable without searching:

- a programming language -> `references/languages/<name>.md`
- a database/daemon/server -> `references/services/<name>.md`

Resolve common aliases first: `postgresql`/`pg` -> `postgres`, `node`/`nodejs`
-> `javascript`, `golang` -> `go`, `c++`/`cpp` -> `cplusplus`, `c#`/`.net` ->
`dotnet`, `tf` -> `terraform`, `k8s helm` -> `helm`, `es` -> `elasticsearch`,
`rabbit` -> `rabbitmq`, `mongo` -> `mongodb`.

**Languages (58)** — `references/languages/`
```
ansible c clojure cplusplus crystal cue dart deno dotnet elixir elm erlang
fortran gawk gleam go hare haskell helm idris java javascript jsonnet julia
kotlin lean4 lobster lua nim nix ocaml odin opentofu pascal perl php pkl
purescript python r racket raku robotframework ruby rust scala shell solidity
standardml swift terraform texlive typescript typst unison v vala zig
```
Deep ones with machinery beyond `enable`/`package`: **python** (venv/poetry/uv),
**rust** (channel/toolchain/fenix, mold/lld/wild linkers), **php**
(extensions/ini/composer + FPM pools), **javascript** (npm/pnpm/yarn/bun),
**haskell** (cabal/stack), **java**/**scala** (gradle/maven, sbt/mill), **go**
(delve). See `references/languages/INDEX.md` for the grouped table.

**Services (42)** — `references/services/`
```
adminer blackfire caddy cassandra clickhouse cockroachdb couchdb dynamodb-local
elasticmq elasticsearch garage httpbin influxdb kafka keycloak mailhog mailpit
meilisearch memcached minio mongodb mosquitto mysql nats nginx
nixseparatedebuginfod opensearch opentelemetry-collector postgres prometheus
rabbitmq redis rustfs sqld tailscale temporal tideways trafficserver typesense
varnish vault wiremock
```
Picking between overlapping options (full rationale in
`references/services/INDEX.md`):
- **postgres** is the default relational choice; **mysql** when the ORM assumes
  MySQL; **cockroachdb** only to test distributed-SQL behavior.
- **mailpit** over **mailhog** (maintained successor, same SMTP-catcher shape).
- **minio** is the best-documented S3-compatible option; **garage** and
  **rustfs** are alternatives.
- **elasticsearch**/**opensearch** are heavyweight JVM clusters for
  logs/analytics; **meilisearch**/**typesense** are lightweight app search.

### Concepts — `references/concepts/`

| Load when the question is about... | File |
|---|---|
| background daemons, dev servers, `devenv up`, readiness probes, restart policy, port allocation | `processes.md` |
| build/setup steps, dependency DAG, `before`/`after`, caching a step, shell/test lifecycle hooks | `tasks.md` |
| `devenv.yaml` keys: inputs, imports, `allow_unfree`, `strict_ports`, default profile/shell | `devenv-yaml.md` |
| adding executables to PATH, package outputs, pinning one package version, `devenv search` | `packages.md` |
| custom `/`-style helper commands on shell entry | `scripts.md` |
| env variants per host/user/flag, `--profile`, `extends` | `profiles.md` |
| `devenv.lock`, reproducibility, `devenv update`, pinning a nixpkgs rev | `pinning.md` |
| patching/overriding a package, adding a custom derivation to `pkgs` | `overlays.md` |
| packaging an app as a derivation, `devenv build` | `outputs.md` |
| `$DEVENV_*` variables, proxy/cache/tracing behavior | `environment-variables.md` |
| environment validation tests, `enterTest`, `devenv test` | `tests.md` |
| inspecting resolved config interactively | `repl.md` |
| editor autocomplete for `devenv.nix` (`devenv lsp`, nixd) | `language-server.md` |
| exposing devenv package/option search to an AI tool (`devenv mcp`) | `mcp-server.md` |

Grouped table with per-topic option lists: `references/concepts/INDEX.md`.

### Patterns — `references/patterns/`

| Trigger | File |
|---|---|
| keep dev-only packages out of a container image (`config.container.isBuilding`) | `containers.md` |
| branch config on OS/arch; the `//` + `optionalAttrs` infinite-recursion trap | `cross-platform.md` |
| link macOS system frameworks (`apple.sdk`); x86 via Rosetta | `macos.md` |
| pull from `nixpkgs-unstable`, extend `$PATH`, escape `${...}` in Nix strings | `nix.md` |

### Guides — `references/guides/`

Newcomer path: `getting-started.md` -> `basics.md` -> `files-and-variables.md`
-> `auto-activation.md`.

| Load when the question is about... | File |
|---|---|
| installing devenv, `devenv init`, first project | `getting-started.md` |
| anatomy of `devenv.nix` (`env`, `packages`, `enterShell`) | `basics.md` |
| what each project file is for (nix/yaml/lock/.local/.envrc) | `files-and-variables.md` |
| auto-entering the shell on `cd` (`devenv hook`, `devenv allow`) | `auto-activation.md` |
| **upgrading from 1.x to 2.0** | `migrating-to-devenv-2-0.md` |
| sharing config across many projects in one repo | `monorepo-with-shared-configurations.md` |
| sharing config across separate repos | `polyrepos.md` |
| composing config via `imports` | `composing-using-imports.md` |
| declaring external inputs | `inputs.md` |
| using devenv from a Nix flake | `using-devenv-with-nix-flakes.md` |
| flake-parts integration | `using-devenv-with-flake-parts.md` |
| writing a custom devenv module | `extending-devenv.md` |
| building/publishing OCI images | `containers.md` |
| Cachix / binary cache setup | `binary-caching.md` |
| generating files into the project tree | `declarative-files.md` |
| pre-commit hooks (`prek`) | `git-hooks.md` |
| disk usage, `devenv gc` | `garbage-collection.md` |
| running one-off envs without a `devenv.nix` | `ad-hoc-developer-environments.md` |
| example projects | `examples.md` |
| devenv Cloud, contributing | `cloud.md`, `contributing.md`, `get-involved.md` |

Full table plus the 2.0 breaking-change checklist: `references/guides/INDEX.md`.

### Integrations — `references/integrations/`

| Load when the question is about... | File |
|---|---|
| devenv in CI | `github-actions.md` |
| shell auto-activation via direnv | `direnv.md` |
| `.env` loading | `dotenv.md` |
| declarative secrets (`secretspec.toml`, profiles, providers) | `secretspec.md` |
| generating Claude Code hooks/skills/agents/MCP config from `devenv.nix` | `claude-code.md` |
| repo-wide formatting | `treefmt.md` |
| git diff tooling | `delta.md`, `difftastic.md` |
| dev containers / Codespaces | `codespaces-devcontainer.md`, `devenv-container.md` |
| Android SDK/NDK, WordPress stacks | `android.md`, `wordpress.md` |

Editors: `references/editors/intellij.md` (Python venv symlink for IDE
detection). `vscode.md` and `zed.md` are two-line link stubs — say so rather
than implying real coverage.

### Process managers — `references/process-managers/`

`native` is the default and recommended manager with full feature support. The
others are compatibility options only: `process-compose` (TUI, feature-rich),
`overmind` (Procfile + tmux), `mprocs` (cross-platform TUI), `hivemind`
(minimal Procfile), `honcho` (Python Foreman port). Start at `_overview.md`.

### History — `references/history/`

27 release notes and engineering posts, devenv 0.1 -> 2.2. **Historical only.**
Load *only* for "which version introduced X", migration questions, or design
rationale — never to answer how devenv works today. Start at
`references/history/INDEX.md`.

## Core mental model

- **`devenv.nix`** — the Nix module config for one project: `packages`, `env`,
  `scripts`, `processes`, `services`, `languages`, `tasks`, `enterShell`,
  `enterTest`, `outputs`, `profiles`.
- **`devenv.yaml`** — configures the *inputs* to that evaluation: `inputs`,
  `imports`, nixpkgs policy (`allow_unfree`, `allow_broken`, licenses), and
  CLI-adjacent defaults (`profile`, `shell`, `reload`, `strict_ports`,
  `secretspec.*`).
- **`devenv.lock`** — the resolved-input lockfile. Every input is pinned to an
  exact revision. Only `devenv update [name]` moves it forward; ordinary
  commands never silently pull newer commits. Commit it.
- **`packages`** puts executables/libs on PATH; **`scripts`** defines helper
  commands (each with optional runtime-only `packages`); **`env`** sets
  variables. For setup ordering, the docs recommend a task with
  `before = [ "devenv:enterShell" ]` over raw `enterShell` script text.
- **`outputs`** declares buildable derivations (`devenv build`) for packaging —
  distinct from the dev shell itself.
- **`profiles`** are named config overlays merged onto the base config,
  selected by `--profile` or auto-activated by hostname/username, composable
  via `extends`. Priority: base -> hostname -> user -> manual; last flag wins.
- **Processes, services, and tasks share one dependency graph.** Every
  `processes.<name>` is also a task named `devenv:processes:<name>`, so
  `before`/`after` edges connect them interchangeably. `services.*` are
  pre-configured processes with health checks. `devenv up` schedules only
  *upstream* deps (`--mode all` for downstream too); `devenv test` runs the
  full graph and starts/stops declared processes around `enterTest`.

## Command surface

```
devenv init                     scaffold devenv.nix / devenv.yaml
devenv shell                    enter the dev environment
devenv up [name] [-d]           start processes (-d = background)
devenv up --mode all            also run downstream setup tasks
devenv down                     alias for `devenv processes down`
devenv test                     build env, cycle processes, run enterTest
devenv build [outputs.<name>]   build declared outputs
devenv repl                     Nix REPL over the evaluated config
devenv info                     show locked inputs and env info
devenv search <NAME>            search packages/options in pinned nixpkgs
devenv update [name]            advance devenv.lock
devenv inputs add <name> <url>  add an input (--follows nixpkgs)
devenv gc                       collect garbage
devenv lsp [--print-config]     nixd language server
devenv mcp [--http [port]]      MCP server (default HTTP port 8080)

devenv container build <name>   build an OCI image from the environment
devenv container copy <name>    push it (--registry docker://...)
devenv container run <name>     run the built container
devenv hook <bash|zsh|fish|nu>  emit shell hook for auto-activation
devenv allow                    trust this project for auto-activation

devenv processes wait --timeout 120 | stop <n> | start <n> | down | attach
devenv tasks run <ns:name> [--mode single|before|after|all]
devenv tasks run <t> --input key=value | --input-json '{"k":"v"}'
devenv --profile <name> shell   (repeatable; last wins)
```

Other documented flags: `--reload`/`--no-reload`, `--shell`, `--impure`,
`--strict-ports`/`--no-strict-ports`, `--secretspec-provider`,
`--secretspec-profile`, `--verbose`, `--trace-to`, `--tui`/`--no-tui`.

## Rules

- **Never read `.claude/references/devenv-full.md`** — it is the 690 KB
  unsplit source and will exhaust context. Every topic file is a slice of it.
- Read the specific topic file, not an `INDEX.md`, once routing is clear.
  `INDEX.md` files are for disambiguation and comparison only.
- Option names are exact and case-sensitive (`languages.rust.channel`,
  `services.postgres.initialDatabases`). Quote them verbatim; never guess an
  option that isn't in the file you read.
- If the corpus doesn't cover something, say so plainly rather than inventing
  an option. The corpus is a point-in-time snapshot.
- Regenerate the split after refreshing the source scrape:
  `bun .claude/skills/devenv/scripts/split-corpus.ts`

## Output

Lead with the `devenv.nix` (or `devenv.yaml`) snippet that answers the
question, then explain the options used, then list the reference file paths
consulted.
