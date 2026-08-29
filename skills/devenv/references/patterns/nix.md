<!-- source: .claude/references/devenv-full.md lines 17723-17833 -->

# Nix

## Nix patterns

### Getting a recent version of a package from `nixpkgs-unstable`

By default, new devenv projects are configured to use a fork of `nixpkgs` called [`devenv-nixpkgs/rolling`](https://github.com/cachix/devenv-nixpkgs).

`devenv-nixpkgs/rolling` is tested against devenv’s test suite and receives monthly updates, as well as interim stability patches that affect devenv’s most popular services and integrations.

For some packages that are updated frequently, you may want to use a more recent version from `nixpkgs-unstable`.

devenv.yaml

```yaml
inputs:
  nixpkgs:
    url: github:cachix/devenv-nixpkgs/rolling
  nixpkgs-unstable:
    url: github:NixOS/nixpkgs/nixpkgs-unstable
```

devenv.nix

```nix
{ pkgs, inputs, ... }:
let
  pkgs-unstable = import inputs.nixpkgs-unstable { system = pkgs.stdenv.system; };
in
{
  packages = [
    pkgs-unstable.elmPackages.elm-test-rs
  ];
}
```

### How do I contribute a package or a fix to `nixpkgs`?

For temporary fixes, we recommend using either [overlays](/overlays/) or a [different nixpkgs input](#getting-a-recent-version-of-a-package-from-nixpkgs-unstable).

You can also consider contributing your changes back to [`nixpkgs`](https://github.com/NixOS/nixpkgs). Follow the [nixpkgs contributing guide](https://github.com/NixOS/nixpkgs/blob/master/pkgs/README.md) to get started.

Once you’ve forked and cloned `nixpkgs`, test your changes with devenv:

```yaml
inputs:
  nixpkgs:
    url: github:username/nixpkgs/branch
    # Or a local path to nixpkgs
    # url: path:/path/to/local/nixpkgs/clone
```

### Add a directory to `$PATH`

This example adds Elixir install scripts to `~/.mix/escripts`:

devenv.nix

```nix
{ ... }:

{
  languages.elixir.enable = true;

  enterShell = ''
    export PATH="$HOME/.mix/escripts:$PATH"
  '';
}
```

### Skip the C compiler toolchain

If your project doesn’t need a C compiler toolchain, set [`stdenv`](/reference/options/#stdenv) to `pkgs.stdenvNoCC` to drop it from the shell. This saves a few hundred MB of storage and shell startup time:

devenv.nix

```nix
{ pkgs, ... }: {
  stdenv = pkgs.stdenvNoCC;
}
```

This is equivalent to using nixpkgs’ `mkShellNoCC` instead of `mkShell`.

### Escape Nix curly braces inside shell scripts

devenv.nix

```nix
{ pkgs, ... }: {
  scripts.myscript.exec = ''
    foobar=1
    echo ''${foobar}
  '';
}
```
