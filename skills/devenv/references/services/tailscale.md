<!-- source: https://devenv.sh/services/tailscale/
     upstream: docs/src/content/docs/services/tailscale.md
     llms-full.txt lines 25451-25492 -->

# tailscale

## Options

### services.tailscale.funnel.enable

Whether to enable Tailscale funnel.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/services/tailscale.nix>

### services.tailscale.funnel.target

Target host or host:port for Tailscale funnel

*Type:* string

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/tailscale.nix>
