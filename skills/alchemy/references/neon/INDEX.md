# neon index

7 pages. Serverless Postgres with copy-on-write branching — projects and branches as Stack resources, with built-in SQL migrations.

| Page | File | Covers |
| --- | --- | --- |
| Neon | `_overview.md` | Serverless Postgres with copy-on-write branching — projects and branches as Stack resources, with built-in SQL migrations. |
| Setup | `setup.md` | Connect alchemy to Neon — account, credentials, and profiles. |

## data/

| Page | File | Covers |
| --- | --- | --- |
| Branching | `data/branching.md` | Neon branches are copy-on-write forks of a parent branch — create them per stage or preview, pin them to a point in time, copy schema only, and let them expire on their own. |
| Connections | `data/connections.md` | Every Neon project and branch exposes direct and pooled connection URIs plus pre-parsed origin outputs — feed the direct origin to Hyperdrive and the pooled one to everything else. |
| Migrations | `data/migrations.md` | Apply SQL migrations and seed data to Neon projects and branches as part of every deploy — ordered, hashed, and tracked in Alchemy's __alchemy_migrations table. |

## guides/

| Page | File | Covers |
| --- | --- | --- |
| Drizzle ORM with Neon | `guides/drizzle.md` | Manage your Drizzle schema as a resource — alchemy regenerates migration SQL on deploy and Neon applies it transactionally on the project or branch. |
| Preview branches per PR | `guides/preview-branches.md` | Keep one long-lived Neon project in a staging stage and fork a copy-on-write branch per PR stage — isolated preview databases in seconds, destroyed with the stage. |
