# Performance & Monitoring

## Startup speed

The system connects to PostgreSQL directly at server startup; the data is pre-loaded, so no ETL runs on each boot.

- **First deployment**: terminology data must first be imported from the admin console's module pages (Terminology etc.) — roughly 1 minute for ICD, 5–15 minutes for SNOMED CT.
- **Subsequent starts**: the service connects straight to PostgreSQL and starts within seconds.
- **Initialisation model**: the Node server creates the connection pool, Redis, and each service exactly once at process start (`main()` in `node-server/src/server.ts`); each MCP session holds its own transport but shares these process-level singletons. (The old Python `mcp` SDK's lifespan-per-session problem no longer exists.)

**Recommendation**: make sure the PostgreSQL data volume is persistent (`compose.yaml` sets this up by default) so the loaded terminology data survives.

## Query performance

- **pgBouncer connection pool**: transaction mode, 500 client connections mapped onto 30 PG connections, for high concurrency.
- **Redis cache (not in use today)**: `node-server/src/cache.ts` provides `cached(ttl, prefix)` — a Redis-backed, fail-open memoizer (on a cache error the function simply runs) — but **no service or tool calls it yet**, so every tool call hits PostgreSQL. Wrapping a hot read path in `cached()` is the intended way to add caching.
- **FTS indexes**: every major search column has a PostgreSQL Full-Text Search index.
- **Vector search**: the `*_embeddings` tables use pgvector. ICD semantic search deliberately **bypasses the HNSW index** with an exact scan (`ORDER BY (embedding <=> …) + 0`): the ~50k near-duplicate 7th-character codes make HNSW recall collapse, and the exact scan over ~98k rows takes about 0.35 s.
- **`pg` driver**: uses unnamed prepared statements to stay compatible with pgBouncer transaction mode.

## Concurrency

The MCP server is implemented in Node.js (Express + `@modelcontextprotocol/sdk`). To handle heavy request volumes:

1. Tune pgBouncer's `MAX_CLIENT_CONN` (default 500) and `DEFAULT_POOL_SIZE` (default 30).
2. Watch pool usage through Prometheus (`mcp_db_pool_size` / `mcp_db_pool_checked_out`).
3. Multiple container instances can share one PostgreSQL and one Redis.

## Background jobs

- `ADMIN_MAX_CONCURRENT_JOBS` bounds how many jobs `admin-worker` runs at once (4 by default in compose); per-module resource slots additionally prevent parallel imports of the same module.
- The worker's `NODE_OPTIONS=--max-old-space-size=8192` is necessary: IG imports load whole dependency packages (such as `hl7.fhir.r4.examples`) into memory. **Do not lower it.**
- On a memory-constrained host, avoid running several large imports at once (e.g. SNOMED CT and an IG); an idle worker may also retain gigabytes of heap, so restarting it before a large import can help.

## Monitoring

The Prometheus metrics endpoint is `/metrics` on `METRICS_PORT` (9090 by default, bound to `127.0.0.1` only). `node-server/src/metrics.ts` defines:

| Metric | Type | Status |
|--------|------|--------|
| `mcp_db_pool_size` / `mcp_db_pool_checked_out` | Gauge | Updated periodically by the DB stats collector |
| `mcp_tool_requests_total{tool,status}` / `mcp_tool_duration_seconds{tool}` | Counter / Histogram | Recorded on every tool call (MCP, `POST /tools/<name>` and the admin playground share one dispatch point, `withToolMetrics` in `mcp.ts`). Labels are only the tool name and `status` (`success` / `error`; a throw or an `isError` result counts as `error`) — arguments are never recorded; calls rejected by argument validation before reaching the handler are not counted |
| `mcp_cache_operations_total{prefix,result}` | Counter | Increments only when `cached()` is used; it currently has no call site |
