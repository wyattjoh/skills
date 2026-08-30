# prisma index

9 pages. Prisma Postgres and Prisma Compute — projects, databases, connections, and deployed apps as Stack resources, with a zero-config local database in dev.

| Page | File | Covers |
| --- | --- | --- |
| Prisma | `_overview.md` | Prisma Postgres and Prisma Compute — projects, databases, connections, and deployed apps as Stack resources, with a zero-config local database in dev. |
| Setup | `setup.md` | Connect alchemy to Prisma — account, service tokens, and profiles. |

## compute/

| Page | File | Covers |
| --- | --- | --- |
| Apps | `compute/apps.md` | Prisma Compute apps as Stack resources — framework builds or Effect-native services, env wiring, custom domains, and a local dev command. |
| Deployments | `compute/deployments.md` | The fail-closed Compute deployment lifecycle — health-checked promotion, rollback recovery, old-generation cleanup, and env-only redeploys. |

## data/

| Page | File | Covers |
| --- | --- | --- |
| Branches | `data/branches.md` | Prisma branches group databases under git-style names — preview branches per stage, default-branch promotion, and database attachment. |
| Buckets | `data/buckets.md` | Prisma Buckets provision S3-compatible object storage inside a project, and Bucket access keys mint the S3 credentials — access key, one-time secret, endpoint, and the provider-side bucket name. |
| Connections | `data/connections.md` | Prisma Connections materialize database credentials — a conventional databaseUrl, direct and pooled connection strings, parsed origins for Hyperdrive, and the Connect runtime binding. |
| Postgres | `data/postgres.md` | Prisma Postgres as Stack resources — projects, databases, branch attachment, and a zero-config local database under alchemy dev. |

## guides/

| Page | File | Covers |
| --- | --- | --- |
| Connect from Cloudflare Workers | `guides/cloudflare-workers.md` | Two ways to reach Prisma Postgres from a Worker — the Connect binding for credentials, or Hyperdrive in front of the direct origin for edge-pooled SQL. |
