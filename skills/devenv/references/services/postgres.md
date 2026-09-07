<!-- source: https://devenv.sh/services/postgres/
     upstream: docs/src/content/docs/services/postgres.md
     llms-full.txt lines 24082-24546 -->

# postgres

## Options

### services.postgres.enable

Whether to enable Add PostgreSQL process. .

*Type:* boolean

*Default:*

```nix
false
```

*Example:*

```nix
true
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/postgres.nix>

### services.postgres.package

The PostgreSQL package to use. Use this to override the default with a specific version.

*Type:* package

*Default:*

```nix
pkgs.postgresql
```

*Example:*

```nix
pkgs.postgresql_15
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/postgres.nix>

### services.postgres.createDatabase

Create a database named like current user on startup. Only applies when initialDatabases is an empty list.

*Type:* boolean

*Default:*

```nix
true
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/postgres.nix>

### services.postgres.extensions

Additional PostgreSQL extensions to install.

The available extensions are:

* age
* anonymizer
* apache\_datasketches
* callPackage
* citus
* cstore\_fdw
* h3-pg
* hypopg
* ip4r
* jsonb\_deep\_sum
* lantern
* omnigres
* periods
* pg-gvm
* pg-semver
* pg\_auto\_failover
* pg\_background
* pg\_bigm
* pg\_byteamagic
* pg\_cron
* pg\_csv
* pg\_ed25519
* pg\_embedding
* pg\_graphql
* pg\_hint\_plan
* pg\_hll
* pg\_ivm
* pg\_libversion
* pg\_net
* pg\_partman
* pg\_rational
* pg\_relusage
* pg\_repack
* pg\_roaringbitmap
* pg\_safeupdate
* pg\_search
* pg\_similarity
* pg\_squeeze
* pg\_tle
* pg\_topn
* pg\_uuidv7
* pgaudit
* pgddl
* pgjwt
* pgmq
* pgroonga
* pgrouting
* pgsodium
* pgsql-http
* pgtap
* pgvecto-rs
* pgvector
* pgvectorscale
* pgx\_ulid
* plperl
* plpgsql\_check
* plpython3
* plr
* pltcl
* plv8
* pointcloud
* postgis
* repmgr
* rum
* smlar
* sqlite\_fdw
* system\_stats
* tds\_fdw
* temporal\_tables
* timescaledb
* timescaledb-apache
* timescaledb\_toolkit
* tsja
* vectorchord
* wal2json

*Type:* null or (function that evaluates to a(n) list of package)

*Default:*

```nix
null
```

*Example:*

```nix
extensions: [
  extensions.pg_cron
  extensions.postgis
  extensions.timescaledb
];
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/postgres.nix>

### services.postgres.hbaConf

The contents of a custom pg\_hba.conf file to copy into the postgres installation. This allows for custom connection rules that you want to establish on the server.

*Type:* null or string

*Default:*

```nix
null
```

*Example:*

```nix
builtins.readFile ./my-custom/directory/to/pg_hba.conf
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/postgres.nix>

### services.postgres.initdbArgs

Additional arguments passed to `initdb` during data dir initialisation.

*Type:* list of strings concatenated with “\n”

*Default:*

```nix
[
  "--locale=C"
  "--encoding=UTF8"
]
```

*Example:*

```nix
[
  "--data-checksums"
  "--allow-group-access"
]
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/postgres.nix>

### services.postgres.initialDatabases

List of database names and their initial schemas that should be used to create databases on the first startup of Postgres. The schema attribute is optional: If not specified, an empty database is created.

*Type:* list of (submodule)

*Default:*

```nix
[ ]
```

*Example:*

```nix
[
  {
    name = "foodatabase";
    schema = ./foodatabase.sql;
  }
  { name = "bardatabase"; }
]
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/postgres.nix>

### services.postgres.initialDatabases.\*.initialSQL

SQL commands to run on this specific database during it’s initialization. Multiple SQL expressions can be separated by semicolons.

*Type:* null or string

*Default:*

```nix
null
```

*Example:*

```nix
CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT);
INSERT INTO users (name) VALUES ('admin');
CREATE EXTENSION IF NOT EXISTS pg_uuidv7;
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/postgres.nix>

### services.postgres.initialDatabases.\*.name

The name of the database to create.

*Type:* string

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/postgres.nix>

### services.postgres.initialDatabases.\*.pass

Password of the database owner role. Requires `user` to be set.

*Type:* null or string

*Default:*

```nix
null
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/postgres.nix>

### services.postgres.initialDatabases.\*.schema

The initial schema of the database; if null (the default), an empty database is created.

*Type:* null or absolute path

*Default:*

```nix
null
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/postgres.nix>

### services.postgres.initialDatabases.\*.user

Username of owner of the database. If set, a role with this name is created and the database is owned by it. If null, the default $USER is used.

*Type:* null or string

*Default:*

```nix
null
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/postgres.nix>

### services.postgres.initialScript

Initial SQL commands to run during database initialization. This can be multiple SQL expressions separated by a semi-colon. Use `initialScript` for server-wide setup, such as creating roles or configuring global settings. For database-specific initialization, use `initialSQL` within `initialDatabases`. `initialScript` is executed after the `initialDatabases` setup is done.

*Type:* null or string

*Default:*

```nix
null
```

*Example:*

```nix
CREATE ROLE postgres SUPERUSER;
CREATE ROLE bar;
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/postgres.nix>

### services.postgres.listen\_addresses

A comma-separated list of TCP/IP address(es) on which the server should listen for connections.

By default, the server only accepts connections over unix sockets.

This option is parsed to set the `PGHOST` environment variable.

Special values:

* ‘\*’ to listen on all available network interfaces.
* ‘0.0.0.0’ to listen on all available IPv4 network interfaces.
* ‘::’ to listen on all available IPv6 network interfaces.
* ‘localhost’ to listen only on the loopback interface.
* ‘’ (empty string) disables TCP/IP connections and listens only on the unix socket.

*Type:* string

*Default:*

```nix
""
```

*Example:*

```nix
"127.0.0.1"
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/postgres.nix>

### services.postgres.port

The TCP port to accept connections.

*Type:* 16 bit unsigned integer; between 0 and 65535 (both inclusive)

*Default:*

```nix
5432
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/postgres.nix>

### services.postgres.settings

PostgreSQL configuration. Refer to <https://www.postgresql.org/docs/11/config-setting.html#CONFIG-SETTING-CONFIGURATION-FILE> for an overview of `postgresql.conf`.

String values will automatically be enclosed in single quotes. Single quotes will be escaped with two single quotes as described by the upstream documentation linked above.

*Type:* attribute set of (boolean or floating point number or signed integer or string)

*Default:*

```nix
{ }
```

*Example:*

```nix
{
  log_connections = true;
  log_statement = "all";
  logging_collector = true
  log_disconnections = true
  log_destination = lib.mkForce "syslog";
}
```

*Declared by:*

* <https://github.com/cachix/devenv/blob/main/src/modules/services/postgres.nix>
