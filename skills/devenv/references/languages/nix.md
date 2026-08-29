<!-- source: .claude/references/devenv-full.md lines 11304-11375 -->

# nix

## Options

### languages.nix.enable

Whether to enable tools for Nix development.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/nix.nix>

### languages.nix.lsp.enable

Whether to enable Nix Language Server.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/nix.nix>

### languages.nix.lsp.package

The Nix language server package to use.

*Type:* package

*Default:*

```nix
pkgs.nixd
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/nix.nix>
