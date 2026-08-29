<!-- source: https://devenv.sh/languages/opentofu/
     upstream: docs/src/content/docs/languages/opentofu.md
     llms-full.txt lines 11574-11663 -->

# opentofu

## Options

### languages.opentofu.enable

Whether to enable tools for OpenTofu development.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/opentofu.nix>

### languages.opentofu.package

The OpenTofu package to use.

*Type:* package

*Default:*

```nix
pkgs.opentofu
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/opentofu.nix>

### languages.opentofu.lsp.enable

Whether to enable OpenTofu Language Server.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/opentofu.nix>

### languages.opentofu.lsp.package

The OpenTofu language server package to use.

*Type:* package

*Default:*

```nix
pkgs.terraform-ls
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/opentofu.nix>
