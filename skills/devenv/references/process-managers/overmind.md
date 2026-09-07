<!-- source: https://devenv.sh/supported-process-managers/overmind/
     upstream: docs/src/content/docs/supported-process-managers/overmind.md
     llms-full.txt lines 27449-27568 -->

# overmind

## Options

### process.managers.overmind.package

The overmind package to use.

*Type:* package

*Default:*

```nix
pkgs.overmind
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/process-managers/overmind.nix>

### process.managers.overmind.adapter.client

Client protocol used for attach, readiness, and individual process control.

*Type:* one of “none”, “native-api”

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/process-managers/overmind.nix>

### process.managers.overmind.adapter.stop

Adapter used to stop the running manager.

*Type:* one of “native-api”, “command”, “process-scope”

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/process-managers/overmind.nix>

### process.managers.overmind.adapter.terminal

Terminal required by the manager launcher.

*Type:* one of “none”, “controlling”

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/process-managers/overmind.nix>

### process.managers.overmind.capabilities.background\_start

Whether the manager can remain running after the launching client exits.

*Type:* boolean

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/process-managers/overmind.nix>

### process.managers.overmind.capabilities.cold\_start\_subset

Whether the manager can initially start a named subset of processes.

*Type:* boolean

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/process-managers/overmind.nix>

### process.managers.overmind.capabilities.devenv\_attach

Whether devenv can attach its interactive client to an existing manager.

*Type:* boolean

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/process-managers/overmind.nix>

### process.managers.overmind.capabilities.individual\_control

Whether devenv can start, stop, and restart individual processes through the manager.

*Type:* boolean

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/process-managers/overmind.nix>

### process.managers.overmind.capabilities.wait\_ready

Whether devenv can wait for process readiness through the manager.

*Type:* boolean

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/process-managers/overmind.nix>
