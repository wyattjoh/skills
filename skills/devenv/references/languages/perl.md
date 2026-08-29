<!-- source: .claude/references/devenv-full.md lines 11718-11815 -->

# perl

## Options

### languages.perl.enable

Whether to enable tools for Perl development.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/perl.nix>

### languages.perl.packages

Perl packages to include

*Type:* list of string

*Default:*

```nix
[ ]
```

*Example:*

```nix
[
  "Mojolicious"
]
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/perl.nix>

### languages.perl.lsp.enable

Whether to enable Perl Language Server.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/perl.nix>

### languages.perl.lsp.package

The Perl language server package to use.

*Type:* package

*Default:*

```nix
pkgs.perlnavigator
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/perl.nix>
