<!-- source: .claude/references/devenv-full.md lines 18369-18412 -->

# REPL

`devenv repl` opens an interactive Nix REPL with your devenv environment fully loaded.

## Usage

```sh
$ devenv repl
```

This assembles your devenv configuration and drops you into a Nix REPL where you can explore:

* `devenv` — the evaluated devenv attribute set:

  * `devenv.config` — the final resolved configuration (options like `languages`, `packages`, `services`).
  * `devenv.options` / `devenv.optionsJSON` — option definitions and their JSON-serialized form.
  * `devenv.shell` — the dev shell derivation.
  * `devenv.build` — declared `outputs.*` derivations.

* `pkgs` — the nixpkgs package set as configured by your project (same as `devenv.pkgs`).

* `inputs` — the resolved inputs declared in `devenv.yaml` (e.g. `inputs.nixpkgs`).

## Examples

```nix
nix-repl> devenv.config.packages
[ «derivation /nix/store/...» ]

nix-repl> devenv.config.languages.python.enable
true

nix-repl> pkgs.hello.version
"2.12.1"
```

The REPL is useful for debugging configuration, inspecting option values, and exploring what is available in your inputs.
