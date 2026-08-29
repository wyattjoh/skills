<!-- source: https://devenv.sh/services/adminer/
     upstream: docs/src/content/docs/services/adminer.md
     llms-full.txt lines 18645-18710 -->

# adminer

## Options

### services.adminer.enable

Whether to enable Adminer process.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/services/adminer.nix>

### services.adminer.package

Which package of Adminer to use.

*Type:* package

*Default:*

```nix
pkgs.adminer
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/adminer.nix>

### services.adminer.listen

Listen address for the Adminer.

*Type:* string

*Default:*

```nix
"127.0.0.1:8080"
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/adminer.nix>
