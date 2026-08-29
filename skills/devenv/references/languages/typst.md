<!-- source: https://devenv.sh/languages/typst/
     upstream: docs/src/content/docs/languages/typst.md
     llms-full.txt lines 15600-15713 -->

# typst

## Options

### languages.typst.enable

Whether to enable tools for Typst development.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/typst.nix>

### languages.typst.package

Which package of Typst to use.

*Type:* package

*Default:*

```nix
pkgs.typst
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/typst.nix>

### languages.typst.fontPaths

Directories to be searched for fonts.

*Type:* list of string

*Default:*

```nix
[]
```

*Example:*

```nix
[ "${pkgs.roboto}/share/fonts/truetype" ]
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/typst.nix>

### languages.typst.lsp.enable

Whether to enable Typst Language Server.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/typst.nix>

### languages.typst.lsp.package

The Typst language server package to use.

*Type:* package

*Default:*

```nix
pkgs.tinymist
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/typst.nix>
