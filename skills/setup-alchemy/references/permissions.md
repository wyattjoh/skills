# Permissions

The CI token gets exactly the grants the stack's resources need, plus what Alchemy itself needs to run. `tokenPlan` resolves every name against Cloudflare's live permission catalog and stops before minting on a name the catalog lacks, so a wrong guess fails safely. Treat the table as a starting point and the catalog as the authority.

## Always

| Group                   | Why                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Account Settings Read` | Alchemy reads the account, and the bootstrap verifies the new token with it. Use `Account Settings Write` only when the stack changes account settings. |
| `Workers Scripts Write` | Deploying Workers, including the `Cloudflare.state()` state-store worker.                                                                               |
| `Secrets Store Write`   | `Cloudflare.state()` binds its bearer secret into a short-lived preview worker on every run; `Read` is not enough.                                      |
| `Workers Tail Read`     | Part of Alchemy's recommended CI policy; lets CI tail Worker logs (for example, `alchemy logs`).                                                        |

## By resource

Add a group for each resource kind the stack declares:

| Stack declares                     | Group                                                               |
| ---------------------------------- | ------------------------------------------------------------------- |
| KV namespaces                      | `Workers KV Storage Write`                                          |
| R2 buckets                         | `Workers R2 Storage Write`                                          |
| D1 databases                       | `D1 Write`                                                          |
| Queues                             | `Queues Write`                                                      |
| Pages projects                     | `Pages Write`                                                       |
| Hyperdrive configs                 | `Hyperdrive Write`                                                  |
| Access applications and policies   | `Access: Apps and Policies Write`                                   |
| Access service tokens              | `Access: Service Tokens Write`                                      |
| A custom domain or route on a zone | A `zone` entry with `Zone Read`, plus any zone write the stack does |

For a resource kind not listed, read its provider page through the alchemy skill, then confirm the group's exact catalog name. The bootstrap's error names the missing group.

## Zone grants

Set `zone` only when the stack touches a zone. The grant is restricted to that one zone, which must already exist and be active in the same account. `zone.groups` must include `Zone Read`, because the bootstrap proves the new token can resolve the zone before installing it. Keep DNS and route write grants out unless the stack itself creates DNS records or routes.

## Grants that stay out

Token management, billing, membership, and identity-provider permissions never belong in a CI token. The Global API key that mints the token is the only credential with those powers, and it stays on the operator's machine.

## When the stack changes

Adding a resource kind usually means adding a group. Update `CONFIG.accountGroups` (or `zone`) in the same change as the stack, then hand the operator `bun run bootstrap:ci --rotate`. A plain rerun leaves the old secrets in place and cannot detect the missing scope. The symptom is a deploy that fails on the first call the new grant was for.
