# Integrations Index

| Integration | File | What it does | Load when... |
| --- | --- | --- | --- |
| **CI/CD & containers** | | | |
| GitHub Actions | [github-actions.md](./github-actions.md) | Reuses a devenv shell inside GitHub Actions jobs (`devenv test`, `devenv shell <cmd>`, or setting `devenv shell bash` as the step/job default shell) | Setting up or debugging a devenv-powered CI workflow on GitHub Actions |
| Codespaces / Devcontainer | [codespaces-devcontainer.md](./codespaces-devcontainer.md) | `devcontainer.enable = true` autogenerates `.devcontainer/devcontainer.json` from the devenv config for GitHub Codespaces | Enabling Codespaces or VS Code devcontainer support for a devenv project |
| devenv container | [devenv-container.md](./devenv-container.md) | Official `ghcr.io/cachix/devenv/devenv` OCI image for running devenv commands in Docker, GitLab CI, or Kubernetes jobs | Running devenv itself inside a container-based CI/CD or orchestration system |
| **Shell & activation** | | | |
| direnv | [direnv.md](./direnv.md) | Auto-loads/unloads the devenv shell on `cd` via `.envrc` + `eval "$(devenv direnvrc)"`; devenv 2.0+'s native `devenv shell`/`devenv hook` covers most of this without direnv | Wiring up per-directory auto-activation, or the user specifically wants in-place env mutation (no subshell) instead of native activation |
| dotenv | [dotenv.md](./dotenv.md) | Loads `.env` file(s) into `config.env` via `dotenv.enable = true` | Working with an existing `.env`-based project; note it's **deprecated** — the file's secrets get copied into the world-readable Nix store, so steer new projects to SecretSpec instead |
| **Secrets** | | | |
| SecretSpec | [secretspec.md](./secretspec.md) | Declares required secrets in `secretspec.toml`, resolves them from a pluggable provider at runtime | Any task involving secret declaration, provisioning, or runtime loading — see dedicated section below |
| **Tooling** | | | |
| treefmt | [treefmt.md](./treefmt.md) | Universal code formatter orchestrator (`treefmt-nix` input) wired into `devenv.nix` and optionally into `git-hooks.hooks.treefmt` | Configuring multi-language formatting or a custom formatter definition |
| delta | [delta.md](./delta.md) | `delta.enable = true` turns on a syntax-highlighting pager for `git`/`diff`/`grep` output | Improving readability of git diff output in the shell |
| difftastic | [difftastic.md](./difftastic.md) | `difftastic.enable = true` swaps in a syntax-aware structural diff for `git diff` | User wants AST-aware diffs instead of line-based diffs |
| **AI** | | | |
| Claude Code | [claude-code.md](./claude-code.md) | `claude.code.enable = true` generates Claude Code hooks, commands, skills, agents, and MCP server config from `devenv.nix` | Any task configuring Claude Code behavior from within a devenv project — see dedicated section below |
| **Platform / App** | | | |
| Android | [android.md](./android.md) | `android.enable = true` provisions the Android SDK (platforms, build-tools, NDK, emulator, cmdline-tools) via `androidenv`/`android-nixpkgs`, plus React Native and Flutter presets | Setting up a native Android, React Native, or Flutter dev environment |
| WordPress | [wordpress.md](./wordpress.md) | Full local WordPress stack: Caddy + PHP-FPM + MariaDB + wp-cli, auto-provisioned via `devenv up` and devenv tasks | Building or troubleshooting a devenv-based WordPress dev environment |

## SecretSpec

[SecretSpec](https://secretspec.dev) separates *declaring* secrets from *provisioning* them: an app lists the secrets it needs in `secretspec.toml`, and each environment (a developer's machine, CI, production) supplies those values from its own preferred provider (keyring, 1Password, dotenv, env, lastpass, etc.) — no secret values live in the declaration file itself.

**Profiles** (e.g. `default`, `dev`, `prod`) select environment-specific sets of secret values from the same `secretspec.toml`; the active profile is set via `devenv.yaml`'s `secretspec.profile`, the `--secretspec-profile` CLI flag, or `SECRETSPEC_PROFILE`.

**Providers** are the pluggable backends that actually resolve secret values (keyring, 1Password, dotenv, env, lastpass, ...). devenv only exports `SECRETSPEC_PROVIDER` when a provider is *explicitly* selected (via `devenv.yaml` or CLI flag) — otherwise `secretspec.toml`'s own per-secret provider/fallback chain is left in control. `secretspec.cachix_auth_token` can additionally register the Cachix token as a built-in required secret without listing it in `secretspec.toml`.

Best-practice usage is runtime loading: `secretspec run -- <cmd>` (or the Rust SDK) so secret values never sit in the shell environment; `secretspec.secrets.<NAME>` in `devenv.nix` is available but exposes values into the Nix evaluation/build environment.

## Claude Code integration

`claude.code.enable = true` generates Claude Code project config (hooks, commands, skills, agents, MCP servers, `.mcp.json`) from `devenv.nix` declarations — it's a config generator, not a runtime agent itself.

- **Hooks**: `claude.code.hooks.<name>` defines shell commands for `PreToolUse`, `PostToolUse`, `Notification`, `Stop`, and `SubagentStop` events; hooks receive tool-call JSON (e.g. `file_path`) on stdin. Enabling git-hooks alongside this wires automatic `pre-commit run --files <edited-file>` formatting after edits.
- **Commands**: `claude.code.commands.<name>` defines custom `/name` slash commands as markdown+code blocks.
- **Skills**: `claude.code.skills.<name>` writes `.claude/skills/<name>/SKILL.md` with `description`, `content`, `resources`, and access-control fields (`allowedTools`/`disallowedTools`), plus routing knobs (`disableModelInvocation`, `userInvocable`, `model`, `effort`, `context = "fork"`).
- **Agents**: `claude.code.agents.<name>` defines sub-agents (description, tools, model, effort, prompt, permissionMode); `claude.code.agent` can promote one to the primary agent.
- **MCP servers**: `claude.code.mcpServers.<name>` configures `stdio` or `http` MCP servers, rendered into a generated `.mcp.json`.

## Process managers

Devenv's [native](../process-managers/native.md) process manager is the default and recommended implementation, supporting the full process feature set (dependencies, readiness probes, restart policies, socket activation, file watching, automatic port allocation). The others are compatibility options for projects with an existing dependency on a specific external manager — see [_overview.md](../process-managers/_overview.md).

| Manager | File | Notes |
| --- | --- | --- |
| native | [native.md](../process-managers/native.md) | Default, built-in, recommended — full feature support |
| process-compose | [process-compose.md](../process-managers/process-compose.md) | Pick for feature-rich supervision with a TUI, dependency conditions, and restart policies via a `process-compose.yaml`-style `settings` block |
| overmind | [overmind.md](../process-managers/overmind.md) | Pick for Procfile-based workflows that want tmux-backed process attach/control |
| mprocs | [mprocs.md](../process-managers/mprocs.md) | Pick for a cross-platform TUI process runner configured via `mprocs.yaml`-style `settings` |
| hivemind | [hivemind.md](../process-managers/hivemind.md) | Pick for a minimal, small-footprint Procfile process manager |
| honcho | [honcho.md](../process-managers/honcho.md) | Pick for teams standardized on Foreman-style tooling in a Python-based stack |
