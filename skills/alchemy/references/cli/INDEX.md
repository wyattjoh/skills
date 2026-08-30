# cli index

15 pages. Every alchemy command at a glance — the command map, common options, and how the interactive TUI decides when to render.

| Page | File | Covers |
| --- | --- | --- |
| CLI | `_overview.md` | Every alchemy command at a glance — the command map, common options, and how the interactive TUI decides when to render. |
| Adopting Resources | `adopting-resources.md` | How alchemy takes ownership of pre-existing cloud resources — recovery by default, --adopt for foreign resources, and the programmatic AdoptPolicy. |
| aws | `aws.md` | AWS provider commands — bootstrap the per-account assets bucket that Lambda deployments rely on. |
| cloudflare | `cloudflare.md` | Cloudflare provider commands — bootstrap the state-store worker, mint API tokens, and inspect state-store logs. |
| deploy | `deploy.md` | Compute a plan, ask for approval, and create/update/delete resources to match the desired state. |
| destroy | `destroy.md` | Delete every resource in a stack — plan all existing resources for deletion, ask for approval, and remove them in dependency order. |
| dev | `dev.md` | Run your stack in development mode with hot reloading — resources deploy to the cloud while Workers run in the local dev runtime. |
| Inspecting State | `inspecting-state.md` | See what alchemy thinks is deployed, debug a bad diff, and recover from bad state. |
| login | `login.md` | Configure and log in to each cloud provider used by your stack. |
| logs | `logs.md` | Fetch historical logs from deployed resources — a batch of past entries, merged and sorted by timestamp. |
| nuke | `nuke.md` | Enumerate and delete every live resource across the stack's providers. |
| plan | `plan.md` | Preview what would change without applying anything. Equivalent to alchemy deploy --dry-run. |
| profile | `profile.md` | Inspect or clear credentials stored in ~/.alchemy/profiles.json. |
| state | `state.md` | Inspect and manage the state store — list stacks, stages, and resources, print persisted state, and clear entries. |
| tail | `tail.md` | Stream live logs from deployed resources in real time, interleaved and color-coded by resource. |
