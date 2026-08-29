<!-- source: https://devenv.sh/services/nginx/
     upstream: docs/src/content/docs/services/nginx.md
     llms-full.txt lines 23494-23601 -->

# nginx

## Options

### services.nginx.enable

Whether to enable nginx.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/services/nginx.nix>

### services.nginx.package

The nginx package to use.

*Type:* package

*Default:*

```nix
pkgs.nginx
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/nginx.nix>

### services.nginx.defaultMimeTypes

Default MIME types for NGINX, as MIME types definitions from NGINX are very incomplete, we use by default the ones bundled in the mailcap package, used by most of the other Linux distributions.

*Type:* absolute path

*Default:*

```nix
${pkgs.mailcap}/etc/nginx/mime.types
```

*Example:*

```nix
${pkgs.nginx}/conf/mime.types
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/nginx.nix>

### services.nginx.eventsConfig

The nginx events configuration.

*Type:* strings concatenated with “\n”

*Default:*

```nix
""
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/nginx.nix>

### services.nginx.httpConfig

The nginx configuration.

*Type:* strings concatenated with “\n”

*Default:*

```nix
""
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/nginx.nix>
