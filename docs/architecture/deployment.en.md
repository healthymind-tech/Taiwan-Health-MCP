# Deployment Architecture

```mermaid
graph TD
    User[End User] --> Client[MCP Client / Browser]

    subgraph "Docker Compose Stack"
        NGX["nginx (single front door, :8080 = WEB_PORT)"]
        WEB["web (Next.js) — public pages + /admin SPA"]
        Server["app (Node MCP server + admin REST API, internal :8000)"]
        Worker["admin-worker (Node — imports, embeddings, drug pipeline)"]
        PGB["pgbouncer (transaction mode, :5432)"]
        PG["postgres:16 + pgvector"]
        RD["redis:7 (:6379)"]
        MN["minio (object storage, :9000)"]
        PM["Prometheus metrics (:9090, localhost only)"]
    end

    Client -- "HTTP :8080" --> NGX
    NGX -- "/mcp, /openapi.json, /tools/*, /status.json, /admin/api/*, /admin/ws" --> Server
    NGX -- "everything else" --> WEB
    Server --> PGB --> PG
    Server --> RD
    Server --> MN
    Server --> PM
    Worker --> PGB
    Worker --> MN
    Worker -. "OCR (MinerU) / Analysis LM / Embeddings" .-> Ext[External model endpoints]
```

## Key considerations

1. **Single entry point**: nginx is the only service intended for host access (`WEB_PORT`, 8080 by default). `app` only has `expose`, no `ports`, so `:8000` cannot be reached from the host.
2. **Data persistence**: PostgreSQL and MinIO data live in Docker volumes, so the data survives container restarts and needs no re-import.
3. **Transport**: production uses `streamable-http` (through nginx's `/mcp`). `MCP_TRANSPORT=stdio` is for launching the process directly on a local machine.
4. **pgBouncer transaction mode**: incompatible with `LISTEN/NOTIFY` and named prepared statements; the Node side uses `pg`'s unnamed statements for compatibility.
5. **Data imports**: triggered from the admin console and executed in the background by `admin-worker` (there is no longer a standalone data-loader container). Source files are uploaded to MinIO through the admin console and fetched back when a job runs.
6. **MinIO**: stores drug document assets (inserts / labels / pill images); the tools return time-limited presigned download links.
7. **External model endpoints**: embeddings, OCR (MinerU), and the analysis LLM are all external HTTP services. Their endpoints live in `admin.llm_profiles` and are configured in the admin console's Settings tab; when unavailable, the system degrades (search falls back to keywords, and analysis jobs fail without affecting queries).
