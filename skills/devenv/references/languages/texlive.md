<!-- source: .claude/references/devenv-full.md lines 15405-15527 -->

# texlive

## Options

### languages.texlive.enable

Whether to enable TeX Live.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/texlive.nix>

### languages.texlive.packages

Extra packages to add to the base TeX Live set

*Type:* list of string

*Default:*

```nix
[ ]
```

*Example:*

```nix
[
  "algorithms"
  "latexmk"
]
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/texlive.nix>

### languages.texlive.base

TeX Live package set to use

*Type:* unspecified value

*Default:*

```nix
pkgs.texliveSmall
```

*Example:*

```nix
pkgs.texliveBasic
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/texlive.nix>

### languages.texlive.lsp.enable

Whether to enable TeX Live Language Server.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/texlive.nix>

### languages.texlive.lsp.package

The TeX Live language server package to use.

*Type:* package

*Default:*

```nix
pkgs.texlab
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/texlive.nix>
