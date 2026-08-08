# Performance & Monitoring

## Startup speed

The system connects to PostgreSQL directly at server startup; the data is pre-loaded, so no ETL runs on each boot.

- **First deployment**: terminology data must first be imported through the admin console (Admin → Modules) — roughly 1 minute for ICD, 5–15 minutes for SNOMED CT.
- **Subsequent starts**: the service connects straight to PostgreSQL and starts within seconds.
- **Initialisation model**: the Node server creates the connection pool, Redis, and each service exactly once at process start (`main()` in `node-server/src/server.ts`); each MCP session holds its own transport but shares these process-level singletons. (The old Python `mcp` SDK's lifespan-per-session problem no longer exists.)

**Recommendation**: keep the PostgreSQL data volume persistent (already configured by default in `compose.yaml`) so loaded terminology data survives restarts.

## Query performance

- **pgBouncer connection pool**: transaction mode, mapping 500 client connections onto 30 PG connections, supporting high concurrency.
- **Redis cache**: `cached()` wraps common queries with a TTL-based cache (`node-server/src/cache.ts`), failing open on cache errors (the query runs against the DB, so availability is unaffected).
- **FTS indexes**: every major search column has a PostgreSQL full-text search index.
- **`pg` driver**: uses unnamed prepared statements for compatibility with pgBouncer transaction mode.

## Handling concurrency

The MCP server is implemented in Node.js (Express + `@modelcontextprotocol/sdk`). For high request volumes:

1. Tune pgBouncer's `MAX_CLIENT_CONN` (500 by default) and `DEFAULT_POOL_SIZE` (30 by default).
2. Monitor the Redis cache hit rate through Prometheus (`mcp_cache_operations_total`).
3. Multiple container instances can share one PostgreSQL and one Redis.

## Background jobs

- `ADMIN_MAX_CONCURRENT_JOBS` bounds how many jobs `admin-worker` runs at once (4 by default in compose); per-module resource slots additionally prevent parallel imports of the same module.
- The worker's `NODE_OPTIONS=--max-old-space-size=8192` is necessary: IG imports load whole dependency packages (such as `hl7.fhir.r4.examples`) into memory. **Do not lower it.**

## Monitoring

The Prometheus metrics endpoint is on `METRICS_PORT` (9090 by default, bound to `127.0.0.1` only).
