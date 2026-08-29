<!-- source: .claude/references/devenv-full.md lines 15201-15290 -->

# swift

## Options

### languages.swift.enable

Whether to enable tools for Swift development.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/swift.nix>

### languages.swift.package

The Swift package to use.

*Type:* package

*Default:*

```nix
pkgs.swift
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/swift.nix>

### languages.swift.lsp.enable

Whether to enable Swift Language Server.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/swift.nix>

### languages.swift.lsp.package

The Swift language server package to use.

*Type:* package

*Default:*

```nix
pkgs.sourcekit-lsp
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/swift.nix>
