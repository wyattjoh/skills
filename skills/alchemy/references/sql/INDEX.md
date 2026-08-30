# sql index

10 pages. One home for SQL in alchemy — low-level effect-sql clients, Drizzle ORM, schema migrations in the deploy graph, and the per-execution connection lifecycle.

| Page | File | Covers |
| --- | --- | --- |
| SQL | `_overview.md` | One home for SQL in alchemy — low-level effect-sql clients, Drizzle ORM, schema migrations in the deploy graph, and the per-execution connection lifecycle. |

## drizzle/

| Page | File | Covers |
| --- | --- | --- |
| D1 | `drizzle/d1.md` | Drizzle on Cloudflare D1 — declare the schema, generate and apply migrations on deploy, and query from a Worker with Drizzle.D1. |
| Migrations | `drizzle/migrations.md` | Drizzle.Schema runs drizzle-kit generate as part of deploy — unambiguous schema changes regenerate automatically, ambiguous ones stop and ask you. |
| MySQL | `drizzle/mysql.md` | Drizzle on MySQL — declare the schema, generate and apply migrations on deploy, and query from a Worker with Drizzle.MySQL over Hyperdrive. |
| Postgres | `drizzle/postgres.md` | Drizzle on Postgres — declare the schema, generate and apply migrations on deploy, and query with Drizzle.Postgres. |

## effect-sql/

| Page | File | Covers |
| --- | --- | --- |
| D1 | `effect-sql/d1.md` | SQL.D1 wraps a bound D1 database in an @effect/sql-d1 client — tagged-template queries with typed errors over the native binding. |
| Connection lifecycle | `effect-sql/lifecycle.md` | SQL clients build lazily on first query, memoize per execution, and tear down when the event settles — why, and what that means on workerd and Lambda. |
| Migrations | `effect-sql/migrations.md` | Commit a directory of ordered .sql files and point a database resource's migrations prop at it — pending files apply as part of every deploy, tracked in one Alchemy-owned table. |
| MySQL | `effect-sql/mysql.md` | SQL.MySQL turns a connection string into an @effect/sql-mysql2 client — tagged-template queries with typed errors, one pool per execution, Workers-safe defaults for Hyperdrive. |
| Postgres | `effect-sql/postgres.md` | SQL.Postgres turns a connection string into an @effect/sql-pg client — tagged-template queries with typed errors, one pool per execution. |
