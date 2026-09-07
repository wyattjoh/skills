<!-- source: https://devenv.sh/supported-process-managers/process-compose/
     upstream: docs/src/content/docs/supported-process-managers/process-compose.md
     llms-full.txt lines 27569-27808 -->

# process-compose

## Options

### process.managers.process-compose.package

The process-compose package to use.

*Type:* package

*Default:*

```nix
pkgs.process-compose
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/process-managers/process-compose.nix>

### process.managers.process-compose.adapter.client

Client protocol used for attach, readiness, and individual process control.

*Type:* one of “none”, “native-api”

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/process-managers/process-compose.nix>

### process.managers.process-compose.adapter.stop

Adapter used to stop the running manager.

*Type:* one of “native-api”, “command”, “process-scope”

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/process-managers/process-compose.nix>

### process.managers.process-compose.adapter.terminal

Terminal required by the manager launcher.

*Type:* one of “none”, “controlling”

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/process-managers/process-compose.nix>

### process.managers.process-compose.capabilities.background\_start

Whether the manager can remain running after the launching client exits.

*Type:* boolean

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/process-managers/process-compose.nix>

### process.managers.process-compose.capabilities.cold\_start\_subset

Whether the manager can initially start a named subset of processes.

*Type:* boolean

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/process-managers/process-compose.nix>

### process.managers.process-compose.capabilities.devenv\_attach

Whether devenv can attach its interactive client to an existing manager.

*Type:* boolean

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/process-managers/process-compose.nix>

### process.managers.process-compose.capabilities.individual\_control

Whether devenv can start, stop, and restart individual processes through the manager.

*Type:* boolean

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/process-managers/process-compose.nix>

### process.managers.process-compose.capabilities.wait\_ready

Whether devenv can wait for process readiness through the manager.

*Type:* boolean

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/process-managers/process-compose.nix>

### process.managers.process-compose.port

The port to bind the process-compose server to.

Not used when `unixSocket.enable` is true.

*Type:* signed integer

*Default:*

```nix
8080
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/process-managers/process-compose.nix>

### process.managers.process-compose.settings

Top-level process-compose.yaml options

Example: <https://github.com/F1bonacc1/process-compose/blob/main/process-compose.yaml>

*Type:* YAML 1.1 value

*Default:*

```nix
{ }
```

*Example:*

```nix
{
  availability = {
    backoff_seconds = 2;
    max_restarts = 5;
    restart = "on_failure";
  };
  depends_on = {
    some-other-process = {
      condition = "process_completed_successfully";
    };
  };
  environment = [
    "ENVVAR_FOR_THIS_PROCESS_ONLY=foobar"
  ];
}
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/process-managers/process-compose.nix>

### process.managers.process-compose.tui.enable

Enable the TUI (Terminal User Interface)

*Type:* boolean

*Default:*

```nix
true
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/process-managers/process-compose.nix>

### process.managers.process-compose.unixSocket.enable

Whether to enable running the process-compose server over unix domain sockets instead of tcp.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/process-managers/process-compose.nix>

### process.managers.process-compose.unixSocket.path

Override the path to the unix socket.

*Type:* string

*Default:*

```nix
${config.devenv.runtime}/pc.sock
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/process-managers/process-compose.nix>
