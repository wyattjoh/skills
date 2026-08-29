<!-- source: https://devenv.sh/languages/nim/
     upstream: docs/src/content/docs/languages/nim.md
     llms-full.txt lines 11214-11303 -->

# nim

## Options

### languages.nim.enable

Whether to enable tools for Nim development.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/nim.nix>

### languages.nim.package

The Nim package to use.

*Type:* package

*Default:*

```nix
pkgs.nim
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/nim.nix>

### languages.nim.lsp.enable

Whether to enable Nim Language Server.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/nim.nix>

### languages.nim.lsp.package

The Nim language server package to use.

*Type:* package

*Default:*

```nix
pkgs.nimlangserver
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/nim.nix>
