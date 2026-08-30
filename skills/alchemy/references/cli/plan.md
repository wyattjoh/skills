<!-- source: https://alchemy.run/cli/plan
     upstream: website/src/content/docs/cli/plan.mdx
     alchemy 2.0.0-beta.75 @ 808ef69 -->

# plan

> Preview what would change without applying anything. Equivalent to alchemy deploy --dry-run.

```sh
alchemy plan [file] [options]
```

`plan` previews what would change without applying anything — it is equivalent to `alchemy deploy --dry-run`.

```text
Plan: 1 to create, 1 to update

+ Queue (AWS.SQS.Queue)
~ Worker (Cloudflare.Worker)
```

The plan uses `+` for creates, `~` for updates, `-` for deletes,
and `•` for no-ops. No approval prompt is shown and no changes are
made.

## Flags

| Option              | Description                                                       |
| ------------------- | ----------------------------------------------------------------- |
| `[file]`            | Stack file to plan (defaults to `alchemy.run.ts`)                 |
| `--stage <name>`    | Stage to plan against (defaults to `dev_$USER`)                   |
| `--profile <name>`  | Auth profile to use (defaults to `default` or `$ALCHEMY_PROFILE`) |
| `--env-file <path>` | Load environment variables from a file                            |

## Where next

- [deploy](/cli/deploy) — apply the plan
- [destroy](/cli/destroy) — delete everything in a stack
- [Inspecting State](/cli/inspecting-state) — examine what the plan diffs against
