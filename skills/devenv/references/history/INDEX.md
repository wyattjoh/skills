# History index

> **This area is historical.** For how devenv works TODAY, use `references/concepts/`, `references/guides/`, `references/languages/`, `references/services/`. Load files in this `history/` directory only for migration questions, "which version added X", or design rationale.

## Chronological table

Newest first. Dates are from the post text/links where stated; `~` marks an inferred/approximate date (position in the source archive is still chronological).

| Release | File | Headline changes |
|---|---|---|
| 2.2 (~2026-08) | [devenv-2-2-attach-to-running-processes-and-persistent-out-of-tree-enviro.md](devenv-22-attach-to-running-processes-and-persistent-out-of-tree-environments.md) | Attach to running process manager, persistent `--from` binding, SecretSpec 0.17 + Cachix |
| Eng. post (~2026-06/07) | [making-devenv-start-fast-and-the-whole-nixpkgs-with-it.md](making-devenv-start-fast-and-the-whole-nixpkgs-with-it.md) | nixpkgs dynamic-loader "stat storm" analysis, static-link spike |
| 2.1 (~2026-04) | [devenv-2-1-nix-with-zsh-fish-and-nushell-via-libghostty.md](devenv-21-nix-with-zsh-fish-and-nushell-via-libghostty.md) | Native zsh/fish/nushell, `devenv hook` (no direnv needed), OTLP tracing |
| 2.0 (2026-03-05) | [devenv-2-0-a-fresh-interface-to-nix.md](devenv-20-a-fresh-interface-to-nix.md) | TUI, native shell reload, native process manager, C FFI instant eval, polyrepo, `--from` |
| SecretSpec 0.7 (~2025-12) | [secretspec-0-7-declarative-secret-generation.md](secretspec-07-declarative-secret-generation.md) | Declarative secret generation (`type` + `generate`) |
| 1.11 (~2025-11-26) | [devenv-1-11-module-changelogs-and-secretspec-0-4-0.md](devenv-111-module-changelogs-and-secretspec-040.md) | Module changelogs, `devenv.yaml` default profile, SecretSpec 0.4.0 |
| 1.10 (2025-10-07) | [devenv-1-10-monorepo-nix-support-with-devenv-yaml-imports.md](devenv-110-monorepo-nix-support-with-devenvyaml-imports.md) | `devenv.yaml` imports, absolute/parent path imports, `config.git.root` |
| 1.9 (~2025-09) | [devenv-1-9-scaling-nix-projects-using-modules-and-profiles.md](devenv-19-scaling-nix-projects-using-modules-and-profiles.md) | Profiles (`--profile`), extending modules, macOS container builds |
| Eng. post (~2025-08) | [closing-the-nix-gap-from-environments-to-packaged-applications-for-rust.md](closing-the-nix-gap-from-environments-to-packaged-applications-for-rust.md) | `languages.rust.import` packages apps via crate2nix |
| Devlog (~2025-07/08) | [devenv-devlog-processes-are-now-tasks.md](devenv-devlog-processes-are-now-tasks.md) | Processes exposed as `devenv:processes:<name>` tasks |
| 1.8 (~2025-07/08) | [devenv-1-8-progress-tui-secretspec-integration-listing-tasks-and-smaller.md](devenv-18-progress-tui-secretspec-integration-listing-tasks-and-smaller-containers.md) | Progress TUI, async core, SecretSpec integration, `devenv tasks list`, smaller containers |
| SecretSpec announcement (2025-07-21) | [announcing-secretspec-declarative-secrets-management.md](announcing-secretspec-declarative-secrets-management.md) | SecretSpec launched as standalone declarative secrets tool |
| 1.7 (~2025-05/06) | [devenv-1-7-cuda-support-enhanced-tasks-and-mcp-support.md](devenv-17-cuda-support-enhanced-tasks-and-mcp-support.md) | CUDA support, `devenv mcp`, `execIfModified` tasks, Snix groundwork |
| 1.6 (~2025-04) | [devenv-1-6-extensible-ad-hoc-nix-environments.md](devenv-16-extensible-ad-hoc-nix-environments.md) | `--option`/`-O` ad-hoc environments without `devenv.nix` |
| 1.5 (~2025-02/03) | [devenv-1-5-overlays-support-and-performance-improvements.md](devenv-15-overlays-support-and-performance-improvements.md) | `overlays` option, native TLS certs, Apple SDK selection, shell perf |
| 1.4 (~2024-11/12) | [devenv-1-4-generating-nix-developer-environments-using-ai.md](devenv-14-generating-nix-developer-environments-using-ai.md) | `devenv generate`, devenv.new AI scaffolding |
| Eng. post (2024-10-22) | [devenv-is-switching-its-nix-implementation-to-tvix.md](devenv-is-switching-its-nix-implementation-to-tvix.md) | Rationale for adopting Tvix (Rust Nix reimplementation) |
| 1.3 (2024-10-03) | [devenv-1-3-instant-developer-environments-with-nix-caching.md](devenv-13-instant-developer-environments-with-nix-caching.md) | Nix eval caching (SQLite, log-parsed file/dir access) |
| 1.2 (2024-09-24) | [devenv-1-2-tasks-for-convergent-configuration-with-nix.md](devenv-12-tasks-for-convergent-configuration-with-nix.md) | Tasks introduced, Task Server Protocol |
| 1.1 (~2024-06/07) | [devenv-1-1-nested-nix-outputs-using-the-module-system.md](devenv-11-nested-nix-outputs-using-the-module-system.md) | Nested Nix `outputs`, `devenv build` |
| 1.0 (~2024-05) | [devenv-1-0-rewrite-in-rust.md](devenv-10-rewrite-in-rust.md) | CLI rewritten in Rust, `enterTest`/`devenv test`, process-compose default |
| 0.6 (2023-03-02) | [devenv-0-6-generating-containers-and-instant-shell-activation.md](devenv-06-generating-containers-and-instant-shell-activation.md) | `devenv container`, instant shell activation, hosts/certs, overlays input |
| 0.5 (~2022-12) | [devenv-0-5.md](devenv-05.md) | Flakes support, nix-direnv, `services.*` namespace, many language/service additions |
| 0.4 (~2022-11/12) | [devenv-0-4.md](devenv-04.md) | `devenv info`, `process.implementation` (overmind/process-compose), `inputs` argument |
| 0.3 (~2022-11-17) | [devenv-0-3.md](devenv-03.md) | New languages (OCaml, Clojure, PureScript, Lua, CUE), roadmap published |
| 0.2 (2022-11-14) | [devenv-0-2.md](devenv-02.md) | `devenv search`, `devenv.local.nix` overrides, options-as-input |
| 0.1 (2022-11-11) | [hello-world-devenv-0-1.md](hello-world-devenv-01.md) | Initial announcement of devenv |

## Feature introduction timeline

- **Basic containerless dev environments** — 0.1
- **`devenv search`** — 0.2
- **`devenv.local.nix` overrides** — 0.2
- **Flakes support, nix-direnv, `services.*` namespace** — 0.5
- **Containers (`devenv container`)** — 0.6
- **Instant shell activation (direnv caching)** — 0.6
- **`allowUnfree` / `overlays` in `devenv.yaml`** — 0.6
- **Rust rewrite of the CLI** — 1.0
- **Testing infra (`enterTest`, `devenv test`)** — 1.0
- **process-compose as default process manager** — 1.0
- **Nested Nix outputs (`devenv build`)** — 1.1
- **Tasks + Task Server Protocol** — 1.2
- **Nix evaluation caching (SQLite)** — 1.3
- **AI-generated environments (`devenv generate`, devenv.new)** — 1.4
- **`overlays` package-set customization, Apple SDK option** — 1.5
- **Ad-hoc Nix environments (`--option`/`-O`)** — 1.6
- **CUDA support** — 1.7
- **MCP server (`devenv mcp`)** — 1.7
- **Task `execIfModified` / namespace execution** — 1.7
- **Snix backend groundwork** — 1.7
- **SecretSpec (standalone tool)** — announced 2025-07-21
- **SecretSpec integration in devenv, Progress TUI/async core** — 1.8
- **Processes exposed as tasks (`devenv:processes:<name>`)** — devlog "processes are now tasks"
- **`languages.<lang>.import` Nix packaging (crate2nix)** — "Closing the Nix Gap" post
- **Profiles & extensible team modules (`--profile`)** — 1.9
- **Monorepo `devenv.yaml` imports, `config.git.root`, `devenv.local.yaml`** — 1.10
- **Module changelogs (`changelogs` option, `devenv changelogs`)** — 1.11
- **SecretSpec 0.4.0 (multi-provider, file-based secrets)** — 1.11
- **SecretSpec declarative secret generation (`type`+`generate`)** — SecretSpec 0.7
- **The 2.0 interface**: TUI, native shell reload, native process manager (default, replaces process-compose), C FFI instant eval, polyrepo (`inputs.<name>.devenv.config`), out-of-tree `--from`, automatic port allocation, bundled SecretSpec, `devenv mcp --http`, `lsp.enable`, `devenv eval`, JSON `devenv build` — 2.0
- **Non-bash shells (native zsh/fish/nushell), `devenv hook` auto-activation without direnv** — 2.1
- **Attach to running processes (`devenv up` attaches), persistent out-of-tree envs (`devenv allow` + `--from`)** — 2.2

## Breaking changes & migrations

- [devenv-1-0-rewrite-in-rust.md](devenv-10-rewrite-in-rust.md) — dedicated "Migration guide" section (deprecated `container --copy`/`--docker-run`, `devenv ci`→`devenv test`, `.env` prefix requirement, hermetic-by-default removes need for `--impure`, lockfile format change).
- [devenv-2-0-a-fresh-interface-to-nix.md](devenv-20-a-fresh-interface-to-nix.md) — "Breaking changes" section (git-hooks input no longer default, `container --copy` removed, `devenv build` now outputs JSON, native process manager is now default) plus a pointer to a full guide at `/guides/migrating-to-20/`.
- [devenv-2-1-nix-with-zsh-fish-and-nushell-via-libghostty.md](devenv-21-nix-with-zsh-fish-and-nushell-via-libghostty.md) — minor breaking change: `devenv tasks run` now defaults to `before` mode.
- [devenv-2-2-attach-to-running-processes-and-persistent-out-of-tree-enviro.md](devenv-22-attach-to-running-processes-and-persistent-out-of-tree-environments.md) — minor breaking changes: dropped `x86_64-darwin`, auto-activation now looks for `devenv.nix` instead of `devenv.yaml`.
- [devenv-0-6-generating-containers-and-instant-shell-activation.md](devenv-06-generating-containers-and-instant-shell-activation.md) — smaller "Migrating from an older devenv" callouts (update `.envrc`, upgrade whole team together).

## Engineering rationale

- [devenv-is-switching-its-nix-implementation-to-tvix.md](devenv-is-switching-its-nix-implementation-to-tvix.md) — why devenv moved off the Nix CLI toward a Rust-native evaluator (Tvix), and what that unlocks (incremental eval, memory safety, language-specific build system integration).
- [making-devenv-start-fast-and-the-whole-nixpkgs-with-it.md](making-devenv-start-fast-and-the-whole-nixpkgs-with-it.md) — why every Nix-built binary pays a dynamic-loader "stat storm" tax, five competing fixes compared, and devenv's static-linking spike for its own CLI.
- [closing-the-nix-gap-from-environments-to-packaged-applications-for-rust.md](closing-the-nix-gap-from-environments-to-packaged-applications-for-rust.md) — why devenv picked crate2nix (and uv2nix for Python) instead of making users choose a lang2nix tool themselves.
- [announcing-secretspec-declarative-secrets-management.md](announcing-secretspec-declarative-secrets-management.md) — why `.env` files and single-key encryption schemes fall short, and the WHAT/HOW/WHERE separation SecretSpec is built around.
- [devenv-devlog-processes-are-now-tasks.md](devenv-devlog-processes-are-now-tasks.md) — short devlog on unifying processes and tasks so `before`/`after` orchestration works uniformly.
