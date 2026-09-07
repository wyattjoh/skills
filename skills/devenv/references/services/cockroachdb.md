<!-- source: https://devenv.sh/services/cockroachdb/
     upstream: docs/src/content/docs/services/cockroachdb.md
     llms-full.txt lines 19560-19643 -->

# cockroachdb

## Options

### services.cockroachdb.enable

Whether to enable Add CockroachDB process. .

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

* <https://github.com/cachix/devenv/blob/main/src/modules/services/cockroachdb.nix>

### services.cockroachdb.package

The CockroachDB package to use.

*Type:* unspecified value

*Default:*

```nix
pkgs.cockroachdb
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/cockroachdb.nix>

### services.cockroachdb.http\_addr

The hostname or IP address to bind to for HTTP requests.

*Type:* string

*Default:*

```nix
"localhost:8080"
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/cockroachdb.nix>

### services.cockroachdb.listen\_addr

The address/hostname and port to listen on.

*Type:* string

*Default:*

```nix
"localhost:26257"
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/cockroachdb.nix>
