<!-- source: .claude/references/devenv-full.md lines 7500-7518 -->

# Difftastic

To get started using [Difftastic, a structural diff that understands syntax for over 30 languages](https://difftastic.wilfred.me.uk/), flip a toggle:

devenv.nix

```nix
{ pkgs, ... }:

{
    difftastic.enable = true;
}
```

When you run `devenv shell` using `git diff`, you should see the following output:

![Screenshot of difftastic and JS](https://github.com/Wilfred/difftastic/raw/master/img/js.png)
