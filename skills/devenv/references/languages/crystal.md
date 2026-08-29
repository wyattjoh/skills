<!-- source: https://devenv.sh/languages/crystal/
     upstream: docs/src/content/docs/languages/crystal.md
     llms-full.txt lines 8800-8925 -->

# crystal

## Options

### languages.crystal.enable

Whether to enable Enable tools for Crystal development…

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/crystal.nix>

### languages.crystal.package

The Crystal package to use.

*Type:* package

*Default:*

```nix
pkgs.crystal
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/crystal.nix>

### languages.crystal.lsp.enable

Whether to enable Crystal Language Server.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/crystal.nix>

### languages.crystal.lsp.package

The Crystal language server package to use.

*Type:* package

*Default:*

```nix
pkgs.crystalline
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/crystal.nix>

### languages.crystal.shards

Configuration for shards

*Type:* submodule

*Default:*

```nix
{ }
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/crystal.nix>

### languages.crystal.shards.package

The Shards package to use.

*Type:* package

*Default:*

```nix
pkgs.shards
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/crystal.nix>
