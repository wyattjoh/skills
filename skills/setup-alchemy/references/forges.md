# Forges

The bootstrap's `Forge` boundary has three operations: confirm the CLI is authenticated, list secret **names**, and install one secret with its value on stdin. Keep exactly one adapter in the copied script.

## GitHub (`gh`)

| Operation | Command                                                                           |
| --------- | --------------------------------------------------------------------------------- |
| Ready     | `gh auth status --hostname <host>` exits 0                                        |
| List      | `gh secret list --repo <host>/<owner>/<repo> --app actions --json name`           |
| Install   | `gh secret set <NAME> --repo <host>/<owner>/<repo> --app actions`, value on stdin |

- The operator's `gh` login needs admin on the repository (or a token with Actions secrets write).
- `--repo` takes the host prefix, so GitHub Enterprise works by changing `host`.
- Workflows read the secrets as `${{ secrets.CLOUDFLARE_API_TOKEN }}` and `${{ secrets.CLOUDFLARE_ACCOUNT_ID }}`.

## Forgejo (`forgejo` CLI)

The adapter drives the `forgejo` CLI in `--agent` mode, which returns a JSON envelope (`status`, `result`, `error`, `next_steps`) instead of free text.

| Operation | Call                                                                                      |
| --------- | ----------------------------------------------------------------------------------------- |
| Ready     | `forgejo auth status --agent --host <host>` returns `status: "success"`                   |
| List      | `GET /repos/<owner>/<repo>/actions/secrets?page=N&limit=50`, paginated until a short page |
| Install   | `PUT /repos/<owner>/<repo>/actions/secrets/<NAME>` with `{"data": "<value>"}` on stdin    |

Secret writes need an **approval round trip**. The first `PUT` returns `error.code: "approval.required"` with one `next_steps` entry whose `action` is `approve` and whose `grant` is the approval. The adapter repeats the identical `PUT` with `--approve <grant>`. Anything else (no approval request, zero or several grants, a failed second call) stops the run and reports which secrets may already be installed.

- Forgejo encrypts the plaintext server-side on `PUT`; nothing needs sealing client-side.
- Forgejo Actions exposes repository secrets with the same `${{ secrets.NAME }}` syntax as GitHub.
- Pin `host` and `repo` in `CONFIG` instead of deriving them from the Git remote. This script grants CI its credential, so which repository receives it should be a reviewed line, not an accident of the clone it ran in.

## Checking an installation

List names, never values; neither forge returns values:

```sh
gh secret list --repo <host>/<owner>/<repo> --app actions
forgejo api --agent --host <host> /repos/<owner>/<repo>/actions/secrets
```
