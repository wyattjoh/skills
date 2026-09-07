<!-- source: https://devenv.sh/languages/c/
     upstream: docs/src/content/docs/languages/c.md
     llms-full.txt lines 8566-8655 -->

# c

## Options

### languages.c.enable

Whether to enable tools for C development.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/c.nix>

### languages.c.debugger

An optional debugger package to use with c. The default is `lldb` on macOS, `gdb` on Linux (if supported), or `null` otherwise.

*Type:* null or package

*Default:*

```nix
pkgs.gdb
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/c.nix>

### languages.c.lsp.enable

Whether to enable C Language Server.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/c.nix>

### languages.c.lsp.package

The C language server package to use.

*Type:* package

*Default:*

```nix
pkgs.ccls
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/c.nix>
