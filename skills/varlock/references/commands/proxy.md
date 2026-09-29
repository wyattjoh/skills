# Credential proxy: proxy

`varlock proxy` (added in 1.12.0) runs an agent or other untrusted tool through a
local MITM proxy so the child only ever sees **placeholder** secrets. Real values
are injected into matching outbound requests at the wire (bound to a verified
upstream TLS identity), responses are scrubbed back to placeholders, and every
request is policy-checked and audited. Verified against `varlock 1.21.0` `--help`.

> **Preview.** Upstream docs still mark the credential proxy as an early preview:
> its flags, decorators, and behavior may change (including breaking changes) in
> minor releases, so pin your varlock version if you depend on it. On its own it
> runs as the same user as the agent, so it raises the bar rather than being a
> hard boundary; `--sandbox` (or a container) is what makes it one. Source:
> [proxy guide](https://varlock.dev/guides/proxy/).

Route a secret by adding `@proxy(domain=...)` to the item (implies `@sensitive`);
set proxy-wide policy with the `@proxyConfig={egress=..., reload=...}` root
decorator. See [`../env-schema.md`](../env-schema.md).

```env-spec
# @proxy(domain="api.stripe.com") @placeholder=sk_test_00000000000000000000000000
STRIPE_SECRET_KEY=yourPreferredPlugin()
```

```
varlock proxy <SUBCOMMAND> [OPTIONS] [-- <command> [args...]]
```

Every subcommand operates on a session. Target one with `-s/--session <id>`, or
let it auto-resolve: `run` attaches to the daemon for the current directory (else
starts its own), and the others use the single active session.

## Subcommands

| Subcommand | Purpose                                                                                                     | Flags (from `varlock proxy <sub> --help`)                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `run`      | Run a command through the proxy: attach to this directory's session, start one, or `--url` a remote broker. | See the table below.                                                                                  |
| `start`    | Start a proxy daemon with a live request log that `proxy run` can attach to.                                | `-p/--path`, `--allow-reload`/`--no-allow-reload`, `--port`, `--cert-dir`, `--persist-ca`, `--expose` |
| `rules`    | Summarize the effective `@proxy` config for this schema (no proxy started).                                 | `-p/--path`                                                                                           |
| `env`      | Print a running session's proxy env (shell exports or json).                                                | `-s`, `-f/--format <shell\|json>`, `--full`, `--proxy-url <url>`, `--cert-dir <dir>`                  |
| `token`    | Print a session's data-plane token (for `proxy run --url`).                                                 | `-s`                                                                                                  |
| `status`   | Show proxy session status.                                                                                  | `-s`, `--all` (include ended), `-f/--format` (json), `--watch`, `--interval <ms>`                     |
| `audit`    | Show a proxy session's audit log.                                                                           | `-s`, `-f/--format <text\|json>`                                                                      |
| `reload`   | Re-resolve the schema and hot-swap a running session's policy.                                              | `-s`, `-p/--path`                                                                                     |
| `stop`     | Stop one or all proxy sessions.                                                                             | `-s`, `--all`                                                                                         |
| `prune`    | Delete ended session records (and their audit logs).                                                        | `-s`, `-y/--yes`                                                                                      |

`reload` must be run from a trusted terminal; a reload requested from inside the
proxied agent is refused.

### `proxy run` flags

| Flag                                     | Short | Purpose                                                                                                       |
| ---------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------- |
| `--session <session>`                    | `-s`  | Proxy session ID/alias to attach to.                                                                          |
| `--path <path>`                          | `-p`  | Entry-point `.env` file/dir. Repeatable.                                                                      |
| `--new`                                  |       | Start a fresh proxy instead of attaching to a running one for this directory.                                 |
| `--allow-reload` / `--no-allow-reload`   |       | Force the reload posture (`manual` / `off`); otherwise `@proxyConfig={reload=...}` applies (default `auto`).  |
| `--port <port>`                          |       | Fixed loopback port (else ephemeral). Fails if in use.                                                        |
| `--cert-dir <cert-dir>`                  |       | Write the CA cert (`ca-cert.pem` + `combined-ca.pem`) into a known directory.                                 |
| `--persist-ca`                           |       | Keep the CA (including `ca-key.pem`) in `--cert-dir` and reuse it across restarts. For long-lived brokers.    |
| `--expose <expose>`                      |       | Bind off-loopback (bare = `0.0.0.0`) and serve the WebSocket tunnel; mints a data-plane token.                |
| `--url <url>`                            |       | Run through a remote broker started with `--expose` (`wss://...` or `ws://...`). Requires a token.            |
| `--token <token>`                        |       | Data-plane token for `--url` (prefer `VARLOCK_PROXY_TOKEN`, which keeps it out of process listings).          |
| `--sandbox <sandbox>`                    |       | Run the child in a sandbox whose only egress is the proxy: bare = macOS `sandbox-exec`, or `docker`/`podman`. |
| `--sandbox-image <sandbox-image>`        |       | Container image for `--sandbox=docker\|podman` (must contain your command).                                   |
| `--inject <inject>`                      | `-i`  | What gets injected: `all` (default), `vars`, or `blob`.                                                       |
| `--redact-stdout` / `--no-redact-stdout` |       | Force or disable redaction of piped/redirected output (same as `varlock run`).                                |

`EXAMPLES:` (verbatim from `varlock proxy --help`):

```
varlock proxy run -- claude                   # attaches to a running proxy for this dir, else starts one
varlock proxy run --session abc12 -- claude   # attach to a specific session (approvals prompt in its terminal)
varlock proxy run --new -- claude             # force a fresh, separate proxy
varlock proxy run --sandbox -- claude         # run the child in a minimal OS sandbox (macOS)
varlock proxy run --sandbox=docker --sandbox-image my-agent -- claude   # run the child in a container
varlock proxy start
varlock proxy rules                           # summarize the effective @proxy config (no proxy started)
varlock proxy env --session abc12             # this session's wiring env (source locally)
varlock proxy env --full --proxy-url http://127.0.0.1:8888 --cert-dir /home/user/certs --format json   # full env for a remote sandbox
varlock proxy start --expose                  # broker: reachable off-loopback, serving the WS tunnel
varlock proxy token                           # read the broker's data-plane token
varlock proxy run --url wss://8000-abc.e2b.app -- claude   # guest: run through a remote broker (token via VARLOCK_PROXY_TOKEN)
varlock proxy status
varlock proxy audit --session abc12
varlock proxy reload --session abc12
varlock proxy stop --session abc12
varlock proxy stop --all
varlock proxy prune                           # delete ALL ended session records (+ audit logs)
varlock proxy prune --session abc12           # delete one session's record
```

Source: [proxy command](https://varlock.dev/reference/cli/proxy/);
[proxy guide](https://varlock.dev/guides/proxy/).
