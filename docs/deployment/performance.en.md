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

### Concurrency cap for heavy tools (ops-v1 O4)

`fhir_validate_bundle`, `fhir_validate_resource`, `fhir_finalize_bundle`, `fhir_finalize_resource`, `fhir_author_resources`, `fhir_assemble_bundle`, `fhir_check_grounding` and `fhir_check_completeness` share one in-process concurrency gate (`node-server/src/toolConcurrency.ts`; MCP, `POST /tools/<name>` and the admin playground all pass through it):

| Variable | Default | Meaning |
|---|---|---|
| `MCP_HEAVY_TOOL_CONCURRENCY` | `4` | Heavy calls running at once; `0` = no cap |
| `MCP_HEAVY_TOOL_QUEUE_TIMEOUT_MS` | `60000` | Calls over the cap wait in FIFO order for at most this long |
| `MCP_HEAVY_TOOL_MAX_QUEUE` | `32` | Waiting calls; beyond it a call is answered at once |

A call that cannot start in time gets an `isError` result with `error.code = "BUSY"`, `retry_after_s` and `concurrency_limit` instead of dragging the whole service down; other tools never wait. Clients (e.g. evaluation harnesses) should keep at most `MCP_HEAVY_TOOL_CONCURRENCY` such calls in flight. Prometheus `mcp_heavy_tools_running` / `mcp_heavy_tools_queued` show the gate's state.

### Memory caps (ops-v1 O3)

Every container has a `mem_limit` (with an equal `memswap_limit` — no swap use), overridable by environment: Postgres `PG_MEM_LIMIT` (6g; `PG_SHARED_BUFFERS` 2560MB, `PG_MAINTENANCE_WORK_MEM` 512MB, `PG_EFFECTIVE_CACHE_SIZE` 6GB, set with `-c` on the `command`, which wins over `postgresql.auto.conf`), `app` `APP_MEM_LIMIT` (5g, V8 heap `APP_MAX_OLD_SPACE_MB` 3584), `admin-worker` `WORKER_MEM_LIMIT` (9g, heap `WORKER_MAX_OLD_SPACE_MB` 8192), Redis 768m, MinIO 1g, pgBouncer / nginx / web-v2 256m, ocr-indra 2g. A container over its cap is OOM-killed alone and `restart: unless-stopped` brings it back, instead of the whole host stalling. A Node heap limit must stay below its container's cap.

### Memory safety net (v22)

The app's memory figure is always the live heap after the last major GC ÷ the heap limit (Prometheus `mcp_heap_live_ratio`).

| Variable | Default | Meaning |
|---|---|---|
| `MCP_HEAVY_TOOL_HEAP_RATIO` / `MCP_TOOL_HEAP_RATIO` | `0.8` / `0.9` | Above it heavy / other tools do not start and answer `BUSY` (`reason: "memory"`) |
| `MCP_CACHE_SHED_RATIO` | `0.7` | Above it every cross-request cache drops its least recently used half (at most once a minute) |
| `MCP_BUILD_ADMIT_RATIO` | `0.85` | A large in-memory build (the concept index of a big IG CodeSystem) states its need first; if it does not fit the caches are emptied, and if it still does not fit it is refused and the whole tool call answers `BUSY` (memory) |
| `MCP_HEAP_ALERT_RATIO` / `MCP_HEAP_ALERT_MINUTES` | `0.75` / `10` | Sustained above it: one error log line, `mcp_heap_alert = 1` |
| `MCP_HEAP_ROTATE_RATIO` / `MCP_HEAP_ROTATE_MINUTES` / `MCP_HEAP_EMERGENCY_RATIO` | `0.85` / `5` / `0.95` | Self-rotation: caches emptied, new connections and calls get 503 + `Retry-After`, calls in flight finish (at most `MCP_ROTATE_DRAIN_MS` 330 s), the process exits 75 and the restart policy starts a fresh one |
| `MCP_SESSION_IDLE_MS` / `MCP_MAX_SESSIONS` | `3600000` / `500` | Idle MCP sessions are closed; an unknown session id answers 404 and the client initialises again |
| `OFFICIAL_VALIDATOR_RECYCLE_HOURS` | `24` | Each resident validator is drained and restarted after this much service (`0` = never) |
| `OFFICIAL_VALIDATOR_KEEPALIVE_MS` | `1200000` | How often each validator sends a tiny request that needs the terminology server: tx.fhir.org closes a session idle for 30 minutes, and a validator answering from its local cache never contacts it, so the session expires anyway (`0` = off) |

Clients should retry a 503 after `Retry-After`; a rotation can last until the longest call in flight ends (about 5 minutes). The validator JVM defaults to `-Xmx2048m` (`VALIDATOR_JAVA_XMX`, 3 GB container: under load the JVM commits its whole heap and needs ~0.6 GB more); its GC log is `/tmp/gc.log` in the container. `app` and `admin-worker` run with `init: true` (tini) and write no core dumps.

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
| `mcp_heavy_tools_running` / `mcp_heavy_tools_queued` | Gauge | Heavy-tool gate: calls running / waiting (ops-v1) |
| `nodejs_heap_size_used_bytes`, `process_resident_memory_bytes`, … | Gauge | prom-client default process metrics (memory, CPU, event-loop lag, GC; ops-v1) |
| `mcp_cache_operations_total{prefix,result}` | Counter | Increments only when `cached()` is used; it currently has no call site |
