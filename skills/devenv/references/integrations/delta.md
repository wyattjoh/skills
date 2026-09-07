<!-- source: https://devenv.sh/integrations/delta/
     upstream: docs/src/content/docs/integrations/delta.md
     llms-full.txt lines 7447-7461 -->

# Delta

To get started using [Delta, a syntax-highlighting pager for git, diff, and grep output](https://dandavison.github.io/delta/), flip a toggle:

devenv.nix

```nix
{ pkgs, ... }:

{
    delta.enable = true;
}
```
