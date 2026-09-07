<!-- source: https://devenv.sh/services/mailhog/
     upstream: docs/src/content/docs/services/mailhog.md
     llms-full.txt lines 21694-21821 -->

# mailhog

## Options

### services.mailhog.enable

Whether to enable mailhog process.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/services/mailhog.nix>

### services.mailhog.package

Which package of mailhog to use

*Type:* package

*Default:*

```nix
pkgs.mailhog
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/mailhog.nix>

### services.mailhog.additionalArgs

Additional arguments passed to `mailhog`.

*Type:* list of strings concatenated with “\n”

*Default:*

```nix
[ ]
```

*Example:*

```nix
[
  "-invite-jim"
]
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/mailhog.nix>

### services.mailhog.apiListenAddress

Listen address for API.

*Type:* string

*Default:*

```nix
"127.0.0.1:8025"
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/mailhog.nix>

### services.mailhog.smtpListenAddress

Listen address for SMTP.

*Type:* string

*Default:*

```nix
"127.0.0.1:1025"
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/mailhog.nix>

### services.mailhog.uiListenAddress

Listen address for UI.

*Type:* string

*Default:*

```nix
"127.0.0.1:8025"
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/mailhog.nix>
