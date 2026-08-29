<!-- source: .claude/references/devenv-full.md lines 4929-5151 -->

# Getting Started

## Installation

### 1. Install [Nix](https://nixos.org)

* Linux

  ```plaintext
  sh <(curl -L https://nixos.org/nix/install) --daemon
  ```

* macOS

  ```plaintext
  curl -sSfL https://artifacts.nixos.org/nix-installer | sh -s -- install
  ```

  !!! note “Nix installer” We recommend using the above installer. It can handle OS upgrades and has better support for Apple silicon.

  If you’d like to stick with the classic installer, use:

  ```plaintext
  sh <(curl -L https://nixos.org/nix/install)
  ```

  **Upgrade Bash**

  macOS ships with an ancient version of Bash due to licensing reasons.

  We recommend installing a newer version from nixpkgs to avoid running into evaluation errors.

  \=== “Nix env (newcomers)”

  ```plaintext
  nix-env --install --attr bashInteractive -f https://github.com/NixOS/nixpkgs/tarball/nixpkgs-unstable
  ```

  \=== “Nix profiles (requires experimental flags)”

  ```plaintext
  nix profile install nixpkgs#bashInteractive
  ```

* Windows (WSL2)

  ```plaintext
  sh <(curl -L https://nixos.org/nix/install) --no-daemon
  ```

* Docker

  ```plaintext
  docker run -it nixos/nix
  ```

### 2. Install [devenv](https://github.com/cachix/devenv)

* Newcomers

  ```plaintext
  nix-env --install --attr devenv -f https://github.com/NixOS/nixpkgs/tarball/nixpkgs-unstable
  ```

* Nix profiles (requires experimental flags)

  ```plaintext
  nix profile install nixpkgs#devenv
  ```

* NixOS/nix-darwin

  configuration.nix

  ```nix
  environment.systemPackages = [
    pkgs.devenv
  ];
  ```

* home-manager

  home.nix

  ```nix
  home.packages = [
    pkgs.devenv
  ];
  ```

### 3. Configure a GitHub access token (optional)

The Nix ecosystem is heavily dependent on GitHub for hosting and distributing source code, like the source for nixpkgs. This means that Nix will make a lot of un-authenticated requests to the GitHub API and you may encounter rate-limiting.

To avoid being rate-limited, **we recommend providing Nix with a GitHub access token**, which will greatly increase your API limits.

Create a new token with no extra permissions at <https://github.com/settings/personal-access-tokens/new>. Add the token to your `~/.config/nix/nix.conf`:

```plaintext
access-tokens = github.com=<GITHUB_TOKEN>
```

## Initial set up

Initialize a new developer environment with `devenv init`.

```sh
$ devenv init
• Creating devenv.nix
• Creating devenv.yaml
• Creating .gitignore
```

## Commands

### Develop

* `devenv init` scaffolds a new project with `devenv.yaml`, `devenv.nix`, and `.gitignore`.
* `devenv shell` activates your developer environment.
* `devenv up` starts [processes](/processes/).
* `devenv processes down` stops background processes.
* `devenv tasks run <task>` runs [tasks](/tasks/).
* `devenv test` builds your developer environment and makes sure that all checks pass. Useful to run in your continuous integration environment.
* `devenv container build|copy|run` manages [containers](/containers/).

### Packages & Dependencies

* `devenv search <NAME>` searches packages matching NAME in Nixpkgs input.
* `devenv update` updates and pins inputs from `devenv.yaml` into `devenv.lock`.
* `devenv inputs add <name> <url>` adds an input to `devenv.yaml`.

### Inspect & Debug

* `devenv info` prints environment information.
* `devenv eval <attr>` evaluates attributes and returns JSON.
* `devenv build <attr>` builds attributes from `devenv.nix`.
* `devenv repl` launches an interactive Nix REPL for inspecting the environment.

### Maintenance & Tooling

* `devenv gc` [deletes unused environments](/garbage-collection/) to save disk space.
* `devenv lsp` starts the language server for `devenv.nix`.
* `devenv mcp` launches the MCP server for AI assistants.

## Learn more

* About `devenv.yaml` in [Inputs](/inputs/) and [Composing using imports](/composing-using-imports/).
* About `devenv.nix` in the **Writing devenv.nix** section, starting with [the basics](/basics/).

## Updating

### Update devenv CLI

* Nix env (newcomers)

  ```plaintext
  nix-env --upgrade --attr devenv -f https://github.com/NixOS/nixpkgs/tarball/nixpkgs-unstable
  ```

* Nix profiles (requires experimental flags)

  ```plaintext
  nix profile upgrade devenv
  ```

* NixOS/nix-darwin/home-manager

  Update nixpkgs to get the latest version of devenv.

  For detailed upgrade instructions specific to your setup, please refer to the documentation for your particular system: NixOS, nix-darwin (for macOS), or home-manager, as applicable.

### Update project inputs

Inputs, like nixpkgs and devenv modules, are downloaded and pinned in a `devenv.lock` lockfile.

These should be periodically updated with:

```plaintext
devenv update
```

Learn more about [Inputs](/inputs/).

## Show your support

Add a badge to your project’s README to show it’s built with devenv:

[![Built with devenv](/assets/devenv-badge.svg)](https://devenv.sh)

```markdown
[![Built with devenv](https://devenv.sh/assets/devenv-badge.svg)](https://devenv.sh)
```
