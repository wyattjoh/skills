<!-- source: https://devenv.sh/languages/idris/
     upstream: docs/src/content/docs/languages/idris.md
     llms-full.txt lines 10134-10229 -->

# idris

## Options

### languages.idris.enable

Whether to enable tools for Idris development.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/idris.nix>

### languages.idris.package

The Idris package to use.

*Type:* package

*Default:*

```nix
pkgs.idris2
```

*Example:*

```nix
pkgs.idris
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/idris.nix>

### languages.idris.lsp.enable

Whether to enable Idris Language Server.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/idris.nix>

### languages.idris.lsp.package

The Idris language server package to use.

*Type:* package

*Default:*

```nix
pkgs.idris2Packages.idris2Lsp
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/idris.nix>
