<!-- source: https://devenv.sh/supported-process-managers/native/
     upstream: docs/src/content/docs/supported-process-managers/native.md
     llms-full.txt lines 27345-27448 -->

# native

The native process manager is built into devenv, enabled by default, and is the recommended way to run processes. See the [Processes guide](/processes/) for configuration, dependencies, readiness probes, restart policies, socket activation, file watching, and automatic port allocation.

## Options

### process.managers.native.adapter.client

Client protocol used for attach, readiness, and individual process control.

*Type:* one of “none”, “native-api”

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/process-managers/native.nix>

### process.managers.native.adapter.stop

Adapter used to stop the running manager.

*Type:* one of “native-api”, “command”, “process-scope”

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/process-managers/native.nix>

### process.managers.native.adapter.terminal

Terminal required by the manager launcher.

*Type:* one of “none”, “controlling”

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/process-managers/native.nix>

### process.managers.native.capabilities.background\_start

Whether the manager can remain running after the launching client exits.

*Type:* boolean

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/process-managers/native.nix>

### process.managers.native.capabilities.cold\_start\_subset

Whether the manager can initially start a named subset of processes.

*Type:* boolean

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/process-managers/native.nix>

### process.managers.native.capabilities.devenv\_attach

Whether devenv can attach its interactive client to an existing manager.

*Type:* boolean

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/process-managers/native.nix>

### process.managers.native.capabilities.individual\_control

Whether devenv can start, stop, and restart individual processes through the manager.

*Type:* boolean

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/process-managers/native.nix>

### process.managers.native.capabilities.wait\_ready

Whether devenv can wait for process readiness through the manager.

*Type:* boolean

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/process-managers/native.nix>
