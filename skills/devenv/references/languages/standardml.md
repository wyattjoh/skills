<!-- source: https://devenv.sh/languages/standardml/
     upstream: docs/src/content/docs/languages/standardml.md
     llms-full.txt lines 15111-15200 -->

# standardml

## Options

### languages.standardml.enable

Whether to enable tools for Standard ML development.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/standardml.nix>

### languages.standardml.package

The Standard ML package to use.

*Type:* package

*Default:*

```nix
pkgs.mlton
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/standardml.nix>

### languages.standardml.lsp.enable

Whether to enable Standard ML Language Server.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/standardml.nix>

### languages.standardml.lsp.package

The Standard ML language server package to use.

*Type:* package

*Default:*

```nix
pkgs.millet
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/standardml.nix>
