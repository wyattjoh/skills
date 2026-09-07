<!-- source: https://devenv.sh/services/varnish/
     upstream: docs/src/content/docs/services/varnish.md
     llms-full.txt lines 26523-26656 -->

# varnish

## Options

### services.varnish.enable

Whether to enable Varnish process and expose utilities.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/services/varnish.nix>

### services.varnish.package

Which Varnish package to use.

*Type:* package

*Default:*

```nix
pkgs.varnish
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/varnish.nix>

### services.varnish.extraModules

Varnish modules (except ‘std’).

*Type:* list of package

*Default:*

```nix
[ ]
```

*Example:*

```nix
[ pkgs.varnish73Packages.modules ]
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/varnish.nix>

### services.varnish.listen

Which address to listen on.

*Type:* string

*Default:*

```nix
"127.0.0.1:6081"
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/varnish.nix>

### services.varnish.memorySize

How much memory to allocate to Varnish.

*Type:* string

*Default:*

```nix
"64M"
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/varnish.nix>

### services.varnish.vcl

Varnish VCL configuration.

*Type:* strings concatenated with “\n”

*Default:*

```nix
''
  vcl 4.0;

  backend default {
    .host = "127.0.0.1";
    .port = "80";
  }
''
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/varnish.nix>
