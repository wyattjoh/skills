# Secrets & encryption: encrypt, reveal, lock, generate-key, keychain, cache

Commands for handling `@sensitive` values: device-local encryption, secure
viewing, the encryption daemon, deployment keys, macOS Keychain, and the value
cache. Verified against `varlock 1.21.0` `--help`.

## `encrypt`

Encrypt a value using device-local encryption (Secure Enclave / TPM / file-based),
producing a `varlock("local:...")` reference that is safe to commit. Single-value
mode reads from stdin (or prompts) so secrets stay out of shell history.

```
varlock encrypt [OPTIONS]
```

| Flag            | Purpose                                                               |
| --------------- | --------------------------------------------------------------------- |
| `--file <file>` | Encrypt all `@sensitive` plaintext values in a `.env` file, in place. |

`EXAMPLES:` (verbatim from `varlock encrypt --help`):

```
echo "$MY_SECRET" | varlock encrypt    # Encrypt a value from stdin (non-interactive, agent-friendly)
varlock encrypt                        # Prompt interactively for a value
varlock encrypt --file .env.local      # Encrypt @sensitive plaintext values in a file in-place
```

## `reveal`

Securely view the plaintext of sensitive variables. Values are shown in an
alternate screen buffer so they do not persist in scrollback.

```
varlock reveal [OPTIONS] [<key>]
```

| Flag                   | Purpose                                                                           |
| ---------------------- | --------------------------------------------------------------------------------- |
| `--copy`               | Copy the value to the clipboard instead of displaying it (auto-clears after 10s). |
| `--path <path>` / `-p` | Entry-point `.env` file/dir. Repeatable.                                          |
| `--env <env>`          | Set the environment.                                                              |

`EXAMPLES:` (verbatim from `varlock reveal --help`):

```
varlock reveal                  # Interactive picker to select and reveal values
varlock reveal MY_SECRET        # Reveal a specific variable
varlock reveal MY_SECRET --copy # Copy value to clipboard (auto-clears after 10s)
```

## `lock`

Lock the encryption daemon, requiring biometric auth for the next decrypt. No
flags beyond `-h/--help`, `-v/--version`.

```
varlock lock
```

## `generate-key`

Generate a random 256-bit hex key for `_VARLOCK_ENV_KEY`, which encrypts the
injected env blob in deployments.

```
varlock generate-key [OPTIONS]
```

| Flag      | Purpose                                                               |
| --------- | --------------------------------------------------------------------- |
| `--plain` | Print only the key, for piping into other commands (added in 1.13.0). |

`EXAMPLES:` (verbatim from `varlock generate-key --help`):

```
varlock generate-key              # Human-readable output
varlock generate-key --plain      # Key only, for piping
```

## `keychain`

Manage macOS Keychain items used by the `keychain()` function.

```
varlock keychain <SUBCOMMAND> [OPTIONS]
```

| Subcommand      | Purpose                                                        | Flags (from `varlock keychain <sub> --help`)                                                  |
| --------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `list [query]`  | List matching Keychain items (metadata only).                  | `--keychain <name>` (e.g. Login, System)                                                      |
| `set <key>`     | Store a secret and optionally write a `keychain()` ref.        | `--service`, `--account`, `--profile` (default `local`), `--project`, `--write-to`, `--force` |
| `import <file>` | Migrate `@sensitive` plaintext from an env file into Keychain. | `--write-to`, `--service`, `--profile`, `--project`, `--force`                                |
| `fix-access`    | Grant varlock's helper access to existing `keychain()` items.  | `--service`, `--account`, `--keychain`, `--path <env file>`                                   |

`--service` defaults to `varlock`; `--account` defaults to `<project>:<profile>:<KEY>`,
where `--project` defaults to the current directory name.

`EXAMPLES:` (verbatim from `varlock keychain --help`):

```
varlock keychain list
varlock keychain fix-access --account "my-project:jb:API_KEY"
varlock keychain fix-access --path .env.jb
varlock keychain import .env --profile jb            # migrate .env in place
varlock keychain import .env --profile jb --write-to .env.jb
varlock keychain set API_KEY --profile jb --write-to .env.jb
```

## `cache`

Manage the encrypted value cache used by the `cache()` function and plugin authors.
With no subcommand it opens an interactive browser (or prints the status summary
when non-TTY).

```
varlock cache [SUBCOMMAND] [OPTIONS]
```

| Subcommand | Purpose                                         | Flags (from `varlock cache <sub> --help`)                       |
| ---------- | ----------------------------------------------- | --------------------------------------------------------------- |
| `status`   | Print a cache status summary (non-interactive). | None.                                                           |
| `clear`    | Clear cache entries (and, since 1.14.0, locks). | `--plugin <plugin>`, `-y/--yes` (required when non-interactive) |

`EXAMPLES:` (verbatim from `varlock cache --help`):

```
varlock cache                                   # Interactive cache browser (or status summary if non-TTY)
varlock cache status                            # Print cache status summary (non-interactive)
varlock cache clear --yes                       # Clear all entries (no prompt)
varlock cache clear --plugin 1password --yes    # Clear cache for a specific plugin
```
