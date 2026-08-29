# Services Reference Index

Index of devenv `services.<name>.*` option references. See [_overview](_overview.md) for the services mental model: service state persists to directories under `$DEVENV_STATE`, services start with `devenv up`, and `-d` runs them in the background.

## Relational DB

| Service | File | What it's for | Key options |
| --- | --- | --- | --- |
| postgres | [postgres](postgres.md) | Postgres RDBMS | `initialDatabases`, `initialScript`, `extensions`, `listen_addresses`, `settings` |
| mysql | [mysql](mysql.md) | MySQL/MariaDB RDBMS | `initialDatabases`, `ensureUsers`, `settings`, `importTimeZones` |
| cockroachdb | [cockroachdb](cockroachdb.md) | Distributed SQL DB | `listen_addr`, `http_addr` |
| sqld | [sqld](sqld.md) | libSQL/Turso server | `port`, `extraArgs` |

## NoSQL / KV

| Service | File | What it's for | Key options |
| --- | --- | --- | --- |
| mongodb | [mongodb](mongodb.md) | Document DB | `additionalArgs`, `initDatabaseUsername`, `replication.enable` |
| redis | [redis](redis.md) | In-memory KV store/cache | `port`, `bind`, `extraConfig` |
| memcached | [memcached](memcached.md) | In-memory cache | `port`, `bind`, `startArgs` |
| cassandra | [cassandra](cassandra.md) | Wide-column store | `clusterName`, `listenAddress`, `seedAddresses`, `extraConfig` |
| couchdb | [couchdb](couchdb.md) | Document DB w/ HTTP API | `settings`, `settings.chttpd.port` |
| dynamodb-local | [dynamodb-local](dynamodb-local.md) | Local DynamoDB emulator | `port`, `sharedDb` |
| influxdb | [influxdb](influxdb.md) | Time-series DB | `port`, `extraArgs` |
| clickhouse | [clickhouse](clickhouse.md) | Columnar analytics DB | `httpPort`, `port`, `keeper.enable`, `usersConfig` |

## Search

| Service | File | What it's for | Key options |
| --- | --- | --- | --- |
| elasticsearch | [elasticsearch](elasticsearch.md) | Search/analytics engine | `port`, `cluster_name`, `single_node`, `plugins` |
| opensearch | [opensearch](opensearch.md) | Elasticsearch fork | `settings."http.port"`, `settings."discovery.type"`, `settings."plugins.security.disabled"` |
| meilisearch | [meilisearch](meilisearch.md) | Lightweight search engine | `listenPort`, `environment`, `noAnalytics` |
| typesense | [typesense](typesense.md) | Typo-tolerant search engine | `port`, `apiKey`, `searchOnlyKey` |

## Messaging / Streaming

| Service | File | What it's for | Key options |
| --- | --- | --- | --- |
| kafka | [kafka](kafka.md) | Distributed event streaming | `settings.listeners`, `defaultMode`, `connect.enable`, `settings."log.dirs"` |
| rabbitmq | [rabbitmq](rabbitmq.md) | AMQP message broker | `port`, `listenAddress`, `managementPlugin.enable`, `configItems` |
| nats | [nats](nats.md) | Lightweight pub/sub messaging | `port`, `jetstream.enable`, `authorization.enable`, `settings` |
| mosquitto | [mosquitto](mosquitto.md) | MQTT broker | `port`, `bind`, `extraConfig` |
| elasticmq | [elasticmq](elasticmq.md) | SQS-compatible queue emulator | `settings` |

## Object Storage

| Service | File | What it's for | Key options |
| --- | --- | --- | --- |
| minio | [minio](minio.md) | S3-compatible object storage | `accessKey`, `secretKey`, `buckets`, `listenAddress`, `consoleAddress` |
| garage | [garage](garage.md) | S3-compatible object storage | `s3Address`, `buckets`, `adminToken`, `rpcSecret`, `ui.enable` |
| rustfs | [rustfs](rustfs.md) | S3-compatible object storage | `accessKey`, `secretKey`, `port`, `consoleEnable` |

## Observability

| Service | File | What it's for | Key options |
| --- | --- | --- | --- |
| prometheus | [prometheus](prometheus.md) | Metrics collection/monitoring | `port`, `scrapeConfigs`, `globalConfig`, `storage.retentionTime` |
| opentelemetry-collector | [opentelemetry-collector](opentelemetry-collector.md) | Telemetry pipeline | `settings`, `configFile` |
| blackfire | [blackfire](blackfire.md) | PHP profiler agent | `client-id`, `client-token`, `socket` |
| tideways | [tideways](tideways.md) | PHP profiler daemon | `apiKey`, `environment`, `service` |
| nixseparatedebuginfod | [nixseparatedebuginfod](nixseparatedebuginfod.md) | Debuginfo server for Nix builds | `port`, `substituters`, `cache.expiration` |

## Auth / Secrets

| Service | File | What it's for | Key options |
| --- | --- | --- | --- |
| keycloak | [keycloak](keycloak.md) | Identity/access management (OIDC) | `initialAdminPassword`, `realms`, `settings.hostname`, `database.type` |
| vault | [vault](vault.md) | Secrets management | `address`, `ui`, `disableClustering` |
| tailscale | [tailscale](tailscale.md) | Tailscale funnel exposure | `funnel.enable`, `funnel.target` |

## Web / Proxy

| Service | File | What it's for | Key options |
| --- | --- | --- | --- |
| caddy | [caddy](caddy.md) | Web server/reverse proxy w/ auto-TLS | `config`, `virtualHosts`, `adapter`, `ca` |
| nginx | [nginx](nginx.md) | Web server/reverse proxy | `httpConfig`, `eventsConfig` |
| varnish | [varnish](varnish.md) | HTTP cache/accelerator | `listen`, `vcl`, `memorySize` |
| trafficserver | [trafficserver](trafficserver.md) | Apache caching proxy | `remap`, `records`, `storage`, `plugins` |
| adminer | [adminer](adminer.md) | Web-based DB admin UI | `listen` |

## Mail (dev)

| Service | File | What it's for | Key options |
| --- | --- | --- | --- |
| mailpit | [mailpit](mailpit.md) | SMTP test server + web UI | `smtpListenAddress`, `uiListenAddress`, `additionalArgs` |
| mailhog | [mailhog](mailhog.md) | SMTP test server + web UI | `smtpListenAddress`, `uiListenAddress`, `apiListenAddress` |

## Dev Tools / Testing

| Service | File | What it's for | Key options |
| --- | --- | --- | --- |
| httpbin | [httpbin](httpbin.md) | HTTP request/response testing | `bind`, `extraArgs` |
| wiremock | [wiremock](wiremock.md) | HTTP API mocking/stubbing | `mappings`, `port`, `rootDir` |
| temporal | [temporal](temporal.md) | Workflow orchestration engine | `port`, `namespaces`, `ui.enable`, `state.ephemeral` |

## Common combinations

- **Web app backend:** `postgres` (or `mysql`) for primary storage + `redis` for caching/sessions/queues.
- **Local S3 workflows:** pick one of `minio`, `garage`, or `rustfs` as an S3-compatible target for app code that talks to AWS S3 APIs.
- **Event-driven systems:** `kafka` (KRaft mode by default, no separate Zookeeper needed) for the log, optionally with `services.kafka.connect.enable` for Kafka Connect pipelines.
- **Email in dev:** `mailpit` or `mailhog` as an SMTP sink so app code can "send" email without hitting a real provider.
- **Auth-gated apps:** `keycloak` for OIDC/SSO plus `postgres` if you need Keycloak's database mode instead of `dev-mem`/`dev-file`.
- **Observability stack:** `prometheus` scraping app/service metrics, paired with `opentelemetry-collector` for traces/logs ingestion.
- **API mocking for integration tests:** `wiremock` or `httpbin` to stand in for third-party HTTP dependencies.

## Choosing between similar services

- **mailhog vs mailpit:** both are SMTP catchers with a web UI on the same default ports; mailpit is the actively maintained successor with a smaller footprint — prefer it unless something specifically depends on MailHog's API.
- **minio vs garage vs rustfs:** all three speak the S3 API for local dev. MinIO is the most widely supported/documented; Garage is built for lightweight, self-hosted multi-node clusters (still fine single-node here); RustFS is a newer Rust rewrite — pick MinIO by default, Garage if you want the `afterStart` bucket/key bootstrapping idiom, RustFS if you need its specific env-var tuning knobs.
- **elasticsearch vs opensearch vs meilisearch vs typesense:** Elasticsearch/OpenSearch are heavyweight, JVM-based full clusters with rich query DSLs (OpenSearch is the open-source fork post-license-change); Meilisearch and Typesense are lightweight, single-binary, typo-tolerant search engines aimed at instant-search UX — choose Elasticsearch/OpenSearch for log/analytics workloads, Meilisearch/Typesense for app search boxes.
- **postgres vs mysql vs cockroachdb:** Postgres has the richest extension ecosystem (see the long `extensions` list) and is the default choice; MySQL/MariaDB fits when the app/ORM assumes MySQL semantics; CockroachDB is for testing distributed-SQL/horizontal-scaling behavior, not a general-purpose default.
