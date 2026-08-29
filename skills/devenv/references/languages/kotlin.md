<!-- source: .claude/references/devenv-full.md lines 10956-11027 -->

# kotlin

## Options

### languages.kotlin.enable

Whether to enable tools for Kotlin development.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/kotlin.nix>

### languages.kotlin.lsp.enable

Whether to enable Kotlin Language Server.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/kotlin.nix>

### languages.kotlin.lsp.package

The Kotlin language server package to use.

*Type:* package

*Default:*

```nix
pkgs.kotlin-language-server
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/kotlin.nix>
