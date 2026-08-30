# better-auth index

3 pages. Typed authentication as an Effect — one BetterAuth() call, a database Layer per platform, and schema migrations that run themselves at deploy.

| Page | File | Covers |
| --- | --- | --- |
| Better Auth | `_overview.md` | Typed authentication as an Effect — one BetterAuth() call, a database Layer per platform, and schema migrations that run themselves at deploy. |
| Database layers | `database-layers.md` | One Layer per environment → database pair — HTTP and serverless drivers where they exist, TCP drivers as the fallback, all routed through alchemy's binding system. |
| Migrations | `migrations.md` | Better Auth's schema is applied automatically at deploy by an internal alchemy Action — input-hash diffed, dead-code-eliminated from runtime bundles, opt-out with migrate false. |
