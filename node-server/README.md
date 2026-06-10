# Node Gateway Prototype

This is a TypeScript MCP gateway prototype for moving the server/control-plane
layer out of the Python monolith while keeping the existing PostgreSQL schema,
Redis cache, and Python workers/loaders intact.

## Scope

Implemented now:

- MCP `stdio` transport for local clients.
- MCP `streamable-http` transport for HTTP clients.
- `GET /healthz` runtime health endpoint.
- `GET /metrics` Prometheus endpoint.
- PostgreSQL pool with query latency metrics.
- Redis client with cache latency metrics.
- `health_check` MCP tool.
- `search_medical_codes` MCP tool backed by the existing `icd.*` tables.

Not moved yet:

- Admin Console APIs.
- Dataset loaders / `admin-worker`.
- Embedding generation pipeline.
- Non-ICD MCP tools.

## Local Run

```bash
cd node-server
cp .env.example .env
npm install
npm run dev
```

For stdio mode:

```bash
NODE_TRANSPORT=stdio npm run dev
```

For HTTP mode:

```bash
NODE_TRANSPORT=streamable-http NODE_PORT=8010 npm run dev
curl http://localhost:8010/healthz
curl http://localhost:8010/metrics
```

## Migration Strategy

Use this gateway as a strangler layer:

1. Keep Python as the source-compatible MCP implementation.
2. Move one read-only tool at a time into Node.
3. Compare outputs and latency against the Python tool.
4. Keep heavy loaders and embedding jobs in Python until instrumentation proves
   they should become separate Go/Rust workers.
