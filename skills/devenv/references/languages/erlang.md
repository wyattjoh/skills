<!-- source: https://devenv.sh/languages/erlang/
     upstream: docs/src/content/docs/languages/erlang.md
     llms-full.txt lines 9360-9449 -->

# erlang

## Options

### languages.erlang.enable

Whether to enable tools for Erlang development.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/erlang.nix>

### languages.erlang.package

Which Erlang package to use.

*Type:* package

*Default:*

```nix
pkgs.beamPackages.erlang
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/erlang.nix>

### languages.erlang.lsp.enable

Whether to enable Erlang Language Server.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/erlang.nix>

### languages.erlang.lsp.package

The Erlang language server package to use.

*Type:* package

*Default:*

```nix
pkgs.erlang-language-platform
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/erlang.nix>
