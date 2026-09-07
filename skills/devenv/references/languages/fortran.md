<!-- source: https://devenv.sh/languages/fortran/
     upstream: docs/src/content/docs/languages/fortran.md
     llms-full.txt lines 9450-9539 -->

# fortran

## Options

### languages.fortran.enable

Whether to enable tools for Fortran Development…

*Type:* boolean

*Default:*

```nix
false
```

*Example:*

```nix
true
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/fortran.nix>

### languages.fortran.package

The Fortran package to use.

*Type:* package

*Default:*

```nix
pkgs.gfortran
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/fortran.nix>

### languages.fortran.lsp.enable

Whether to enable Fortran Language Server.

*Type:* boolean

*Default:*

```nix
true
```

*Example:*

```nix
true
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/fortran.nix>

### languages.fortran.lsp.package

The Fortran language server package to use.

*Type:* package

*Default:*

```nix
pkgs.fortls
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/fortran.nix>
