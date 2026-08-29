<!-- source: .claude/references/devenv-full.md lines 7447-7461 -->

# Delta

To get started using [Delta, a syntax-highlighting pager for git, diff, and grep output](https://dandavison.github.io/delta/), flip a toggle:

devenv.nix

```nix
{ pkgs, ... }:

{
    delta.enable = true;
}
```
