<!-- source: https://devenv.sh/services/sqld/
     upstream: docs/src/content/docs/services/sqld.md
     llms-full.txt lines 25385-25450 -->

# sqld

## Options

### services.sqld.enable

Whether to enable sqld.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/services/sqld.nix>

### services.sqld.extraArgs

Add other sqld flags.

*Type:* list of string

*Default:*

```nix
[ ]
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/sqld.nix>

### services.sqld.port

Port number to listen on.

*Type:* 16 bit unsigned integer; between 0 and 65535 (both inclusive)

*Default:*

```nix
8080
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/sqld.nix>
