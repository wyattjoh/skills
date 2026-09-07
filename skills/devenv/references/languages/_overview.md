<!-- source: https://devenv.sh/languages/
     upstream: docs/src/content/docs/languages/index.md
     llms-full.txt lines 8439-8475 -->

# Overview

# Languages

What if you could have the tooling for any programming language by flipping a toggle?

devenv.nix

```nix
{ pkgs, ... }:

{
  languages.python.enable = true;
  languages.python.version = "3.11.3";

  languages.rust.enable = true;
  # https://devenv.sh/reference/options/#languagesrustchannel
  languages.rust.channel = "stable";
}
```

`devenv` will provide executables for both languages:

```sh
$ devenv shell
Building shell ...
Entering shell ...

(devenv) $ python --version
Python 3.11.3
```
