<!-- source: https://devenv.sh/languages/solidity/
     upstream: docs/src/content/docs/languages/solidity.md
     llms-full.txt lines 15021-15110 -->

# solidity

## Options

### languages.solidity.enable

Whether to enable tools for Solidity development.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/solidity.nix>

### languages.solidity.package

Which compiler of Solidity to use.

*Type:* package

*Default:*

```nix
pkgs.solc
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/solidity.nix>

### languages.solidity.foundry.enable

Whether to enable install Foundry.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/solidity.nix>

### languages.solidity.foundry.package

Which Foundry package to use.

*Type:* package

*Default:*

```nix
foundry.defaultPackage.$${pkgs.stdenv.system}
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/solidity.nix>
