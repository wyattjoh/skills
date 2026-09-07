<!-- source: https://devenv.sh/languages/clojure/
     upstream: docs/src/content/docs/languages/clojure.md
     llms-full.txt lines 8656-8727 -->

# clojure

## Options

### languages.clojure.enable

Whether to enable tools for Clojure development.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/clojure.nix>

### languages.clojure.lsp.enable

Whether to enable Clojure Language Server.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/clojure.nix>

### languages.clojure.lsp.package

The Clojure language server package to use.

*Type:* package

*Default:*

```nix
pkgs.clojure-lsp
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/clojure.nix>
