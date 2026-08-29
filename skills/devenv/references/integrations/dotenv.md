<!-- source: https://devenv.sh/integrations/dotenv/
     upstream: docs/src/content/docs/integrations/dotenv.md
     llms-full.txt lines 7681-7726 -->

# Dotenv

Why this integration is deprecated

[Where `.env` Went Wrong](https://secretspec.dev/blog/where-env-went-wrong/) explains why `.env` files are a poor fit for configuration and secret management.

The `.env` file leaks into `nix` store

When you use the `.env` file to store secrets, beware that this integration copies these secrets (the entire `.env` file actually) into the `nix` store. Depending on your threat model, this can leak your secrets publicly: anybody with read-access to your `nix` store (any user on a typical nixos setup) can read your secrets.

The new [SecretSpec](/integrations/secretspec/) integration does not suffer from this problem.

Consider SecretSpec for new projects

For new projects, consider using [SecretSpec](/integrations/secretspec/) instead of `.env` files. SecretSpec provides:

* Separation of secret declaration from provisioning
* Support for multiple secure providers (keyring, 1Password, etc.)
* Runtime secret loading (keeps secrets out of shell environment)
* Better security practices and secret rotation

See the [SecretSpec integration guide](/integrations/secretspec/) for more details.

[.env](https://github.com/motdotla/dotenv) files were introduced by Heroku in 2012.

If you have a `.env`, you’ll see instructions how to enable integration:

devenv.nix

```nix
{
  dotenv.enable = true;

  # Optionally, you can choose which filename to load.
  #
  # dotenv.filename = ".env.production";
  # or
  # dotenv.filename = [ ".env.production" ".env.development" ]
}
```

When the developer environment is loaded, environment variables from `.env` will be loaded and set into `config.env`.

Variables from `.env` are set using `lib.mkDefault`, meaning that any existing `env` variables set in `devenv.nix` will have priority over them.
