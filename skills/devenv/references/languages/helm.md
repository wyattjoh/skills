<!-- source: .claude/references/devenv-full.md lines 10014-10133 -->

# helm

## Options

### languages.helm.enable

Whether to enable tools for Helm development.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/helm.nix>

### languages.helm.package

The Helm package to use.

*Type:* package

*Default:*

```nix
pkgs.kubernetes-helm
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/helm.nix>

### languages.helm.lsp.enable

Whether to enable Helm Language Server.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/helm.nix>

### languages.helm.lsp.package

The Helm language server package to use.

*Type:* package

*Default:*

```nix
pkgs.helm-ls
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/helm.nix>

### languages.helm.plugins

List of Helm plugin names to include from pkgs.kubernetes-helmPlugins.

They will be symlinked into one directory and exposed via HELM\_PLUGINS.

*Type:* list of string

*Default:*

```nix
[ ]
```

*Example:*

```nix
[
  "helm-secrets"
  "helm-diff"
  "helm-unittest"
]
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/helm.nix>
