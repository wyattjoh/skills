# Secrets & encryption: encrypt, reveal, lock, generate-key, keychain, cache

Commands for handling `@sensitive` values: device-local encryption, secure
viewing, the encryption daemon, deployment keys, macOS Keychain, and the value
cache. Verified against `varlock 1.10.0` `--help`.

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

Generate an encryption key for encrypting the env blob in deployments. No flags
beyond `-h/--help`, `-v/--version`.

```
varlock generate-key
```

## `keychain`

Manage macOS Keychain items used by the `keychain()` function.

```
varlock keychain <SUBCOMMAND> [OPTIONS]
```

| Subcommand   | Purpose                                                        | Key flags (from parent `EXAMPLES:`)     |
| ------------ | -------------------------------------------------------------- | --------------------------------------- |
| `list`       | List matching Keychain items (metadata only).                  |                                         |
| `set`        | Store a secret and optionally write a `keychain()` ref.        | `--profile <name>`, `--write-to <file>` |
| `import`     | Migrate `@sensitive` plaintext from an env file into Keychain. | `--profile <name>`, `--write-to <file>` |
| `fix-access` | Grant varlock's helper access to existing `keychain()` items.  | `--account <name>`, `--path <file>`     |

Subcommand flag lists are `not fully expanded (depth-2 limit)` — run
`varlock keychain <sub> --help` on the machine to confirm exact spellings.

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

| Subcommand | Purpose                                         | Key flags (from parent `EXAMPLES:`) |
| ---------- | ----------------------------------------------- | ----------------------------------- |
| `status`   | Print a cache status summary (non-interactive). |                                     |
| `clear`    | Clear cache entries.                            | `--yes`, `--plugin <name>`          |

Subcommand flag lists are `not fully expanded (depth-2 limit)`.

`EXAMPLES:` (verbatim from `varlock cache --help`):

```
varlock cache                                   # Interactive cache browser (or status summary if non-TTY)
varlock cache status                            # Print cache status summary (non-interactive)
varlock cache clear --yes                       # Clear all entries (no prompt)
varlock cache clear --plugin 1password --yes    # Clear cache for a specific plugin
```
