<!-- source: https://devenv.sh/reference/yaml-options/
     upstream: docs/src/content/docs/reference/yaml-options.md
     llms-full.txt lines 18059-18368 -->

# devenv.yaml

## backend

Select the Nix backend used to evaluate `devenv.nix`.

*Type:* `nix` · *Default:* `nix`

## clean.enabled

Added in `1.0`

Clean the environment when entering the shell.

*Type:* `boolean` · *Default:* `false`

## clean.keep

Added in `1.0`

A list of environment variables to keep when cleaning the environment.

*Type:* `list of string` · *Default:* `[]`

## imports

A list of relative paths, absolute paths, or references to inputs to import `devenv.nix` and `devenv.yaml` files. See [Composing using imports](/composing-using-imports/).

*Type:* `list of string` · *Default:* `[]`

## impure

Added in `1.0`

Relax the hermeticity of the environment.

*Type:* `boolean` · *Default:* `false`

## inputs

Map of Nix inputs. See [Inputs](/inputs/).

*Type:* `attribute set of input` · *Default:* `inputs.nixpkgs.url: github:cachix/devenv-nixpkgs/rolling`

## inputs.\<name>.flake

Does the input contain `flake.nix` or `devenv.nix`.

*Type:* `boolean` · *Default:* `true`

## inputs.\<name>.follows

Another input to “inherit” from by name. See [Following inputs](/inputs/#following-inputs).

*Type:* `string`

## inputs.\<name>.inputs

Override nested inputs by name. See [Following inputs](/inputs/#following-inputs).

*Type:* `attribute set of input`

## inputs.\<name>.overlays

A list of overlays to include from the input. See [Overlays](/overlays/).

*Type:* `list of string` · *Default:* `[]`

## inputs.\<name>.url

URI specification of the input. See [Supported URI formats](/inputs/#supported-uri-formats).

*Type:* `string`

## nixpkgs.allow\_broken

Added in `1.7`

Allow packages marked as broken.

*Type:* `boolean` · *Default:* `false`

## nixpkgs.allow\_non\_source

Allow packages not built from source.

*Type:* `boolean` · *Default:* `true` (nixpkgs default)

## nixpkgs.allow\_unfree

Added in `1.7`

Allow unfree packages.

*Type:* `boolean` · *Default:* `false`

## nixpkgs.allow\_unsupported\_system

Added in `2.0.5`

Allow packages that are not supported on the current system.

*Type:* `boolean` · *Default:* `false`

## nixpkgs.allowlisted\_licenses

A list of license names to allow. Uses nixpkgs license attribute names (e.g. `gpl3Only`, `mit`, `asl20`). See [nixpkgs license list](https://github.com/NixOS/nixpkgs/blob/master/lib/licenses.nix).

*Type:* `list of string` · *Default:* `[]`

## nixpkgs.android\_sdk.accept\_license

Accept the Android SDK license. Can also be set via the `NIXPKGS_ACCEPT_ANDROID_SDK_LICENSE=1` environment variable.

*Type:* `boolean` · *Default:* `false`

## nixpkgs.blocklisted\_licenses

A list of license names to block. Uses nixpkgs license attribute names (e.g. `unfree`, `bsl11`). See [nixpkgs license list](https://github.com/NixOS/nixpkgs/blob/master/lib/licenses.nix).

*Type:* `list of string` · *Default:* `[]`

## nixpkgs.cuda\_capabilities

Added in `1.7`

Select CUDA capabilities for nixpkgs.

*Type:* `list of string` · *Default:* `[]`

## nixpkgs.cuda\_support

Added in `1.7`

Enable CUDA support for nixpkgs.

*Type:* `boolean` · *Default:* `false`

## nixpkgs.per\_platform

Added in `1.7`

Per-platform nixpkgs configuration. Accepts the same options as `nixpkgs`.

*Type:* `attribute set of nixpkgs config`

## nixpkgs.permitted\_insecure\_packages

Added in `1.7`

A list of insecure permitted packages.

*Type:* `list of string` · *Default:* `[]`

## nixpkgs.permitted\_unfree\_packages

Added in `1.9`

A list of unfree packages to allow by name.

*Type:* `list of string` · *Default:* `[]`

## nixpkgs.rocm\_support

Added in `2.0.7`

Enable ROCm support for nixpkgs.

*Type:* `boolean` · *Default:* `false`

## profile

Added in `1.11`

Default profile to activate. Can be overridden by `--profile` CLI flag. See [Profiles](/profiles/).

*Type:* `string`

## reload

Added in `2.0`

Enable auto-reload of the shell when files change. Can be overridden by `--reload` or `--no-reload` CLI flags.

*Type:* `boolean` · *Default:* `true`

## require\_version

Added in `2.1`

Version requirement for the devenv CLI. Set to `true` to enforce that the CLI version matches the modules version (from the `devenv` input), or use a constraint string with operators (`>=`, `<=`, `>`, `<`, `=`, or a bare version for an exact match).

*Type:* `boolean | string`

## secretspec.cachix\_auth\_token

Added in `2.2`

Require the Cachix auth token through SecretSpec when `CACHIX_AUTH_TOKEN` is not set in the environment.

Set to `true` to use the built-in `CACHIX_AUTH_TOKEN` secret name, `false` to disable SecretSpec lookup, or a string to use a custom secret name. No declaration in `secretspec.toml` is required.

*Type:* `boolean | string` · *Default:* unset

## secretspec.enable

Added in `1.8`

Enable [secretspec integration](/integrations/secretspec/).

*Type:* `boolean` · *Default:* `false`

## secretspec.profile

Added in `1.8`

Secretspec profile name to use.

*Type:* `string`

## secretspec.provider

Added in `1.8`

Secretspec provider to use.

*Type:* `string`

## shell

Added in `2.1`

Default interactive shell to use when entering the devenv environment. Can be overridden by the `--shell` CLI flag. Falls back to the `$SHELL` environment variable, then `bash`.

Supported values: `bash`, `zsh`, `fish`, `nu`. Any other value falls back to `bash`.

*Type:* `string` · *Default:* `$SHELL` or `bash`

## strict\_ports

Error if a port is already in use instead of auto-allocating the next available port. Can be overridden by `--strict-ports` or `--no-strict-ports` CLI flags.

*Type:* `boolean` · *Default:* `false`
