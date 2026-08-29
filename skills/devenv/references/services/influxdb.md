<!-- source: .claude/references/devenv-full.md lines 20614-20705 -->

# influxdb

## Options

### services.influxdb.enable

Whether to enable influxdb.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/services/influxdb.nix>

### services.influxdb.package

Which package of InfluxDB server to use

*Type:* package

*Default:*

```nix
pkgs.influxdb2-server
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/influxdb.nix>

### services.influxdb.extraArgs

Additional arguments passed to `influxd` during startup.

*Type:* list of string

*Default:*

```nix
[ ]
```

*Example:*

```nix
[
  "--flux-log-enabled"
]
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/influxdb.nix>

### services.influxdb.port

The TCP port for the InfluxDB HTTP API.

*Type:* 16 bit unsigned integer; between 0 and 65535 (both inclusive)

*Default:*

```nix
8086
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/influxdb.nix>
