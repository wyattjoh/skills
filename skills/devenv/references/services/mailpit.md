<!-- source: .claude/references/devenv-full.md lines 21822-21931 -->

# mailpit

## Options

### services.mailpit.enable

Whether to enable mailpit process.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/services/mailpit.nix>

### services.mailpit.package

Which package of mailpit to use

*Type:* package

*Default:*

```nix
pkgs.mailpit
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/mailpit.nix>

### services.mailpit.additionalArgs

Additional arguments passed to `mailpit`.

*Type:* list of strings concatenated with “\n”

*Default:*

```nix
[ ]
```

*Example:*

```nix
[
  "--max=500"
]
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/mailpit.nix>

### services.mailpit.smtpListenAddress

Listen address for SMTP.

*Type:* string

*Default:*

```nix
"127.0.0.1:1025"
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/mailpit.nix>

### services.mailpit.uiListenAddress

Listen address for UI.

*Type:* string

*Default:*

```nix
"127.0.0.1:8025"
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/mailpit.nix>
