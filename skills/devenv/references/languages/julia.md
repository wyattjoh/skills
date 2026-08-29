<!-- source: https://devenv.sh/languages/julia/
     upstream: docs/src/content/docs/languages/julia.md
     llms-full.txt lines 10908-10955 -->

# julia

## Options

### languages.julia.enable

Whether to enable tools for Julia development.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/julia.nix>

### languages.julia.package

The Julia package to use.

*Type:* package

*Default:*

```nix
pkgs.julia-bin
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/julia.nix>
