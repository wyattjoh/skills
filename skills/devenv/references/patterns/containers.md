<!-- source: https://devenv.sh/recipes/containers/
     upstream: docs/src/content/docs/recipes/containers.md
     llms-full.txt lines 17896-17917 -->

# Containers

## Container patterns

### Exclude packages from a container

devenv.nix

```nix
{ pkgs, lib, config, ... }: {
  packages = [
    pkgs.git
  ] ++ lib.optionals (!config.container.isBuilding) [
    pkgs.haskell-language-server
  ];
}
```
