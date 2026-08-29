<!-- source: .claude/references/devenv-full.md lines 8728-8799 -->

# cplusplus

## Options

### languages.cplusplus.enable

Whether to enable tools for C++ development.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/cplusplus.nix>

### languages.cplusplus.lsp.enable

Whether to enable C++ Language Server.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/cplusplus.nix>

### languages.cplusplus.lsp.package

The C++ language server package to use.

*Type:* package

*Default:*

```nix
pkgs.ccls
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/cplusplus.nix>
