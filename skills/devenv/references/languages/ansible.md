<!-- source: .claude/references/devenv-full.md lines 8476-8565 -->

# ansible

## Options

### languages.ansible.enable

Whether to enable tools for Ansible development.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/ansible.nix>

### languages.ansible.package

The Ansible package to use.

*Type:* package

*Default:*

```nix
pkgs.ansible
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/ansible.nix>

### languages.ansible.lsp.enable

Whether to enable Ansible Language Server.

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

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/ansible.nix>

### languages.ansible.lsp.package

The Ansible language server package to use.

*Type:* null or package

*Default:*

```nix
pkgs.ansible-language-server
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/languages/ansible.nix>
