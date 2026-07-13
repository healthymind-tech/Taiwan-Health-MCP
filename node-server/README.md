# node-server — Node.js MCP backend (parity target)

TypeScript reimplementation of the Taiwan Health MCP backend, built **from
scratch** as the Python → Node refactor target. See
`../docs/node-backend-full-refactor-plan.md` for the full plan.

> Decision (2026-06-13): this is a clean rewrite. The `backup/node-gateway-origin`
> branch is **reference only** (read its SQL/logic to avoid repeating bugs); no
> code is carried over verbatim.

## Current state — Phase 0, workstream B

Base layer + an MCP stub only:

| File | Mirrors (Python) | Notes |
|------|------------------|-------|
| `src/config.ts` | `src/config.py` | same env vars + defaults |
| `src/logger.ts` | `src/utils.py` | JSON → stderr, fields `ts/level/logger/msg` |
| `src/db.ts` | `src/database.py` | `pg` pool; unnamed statements = pgBouncer-safe |
| `src/cache.ts` | `src/cache.py` | Redis; key `mcp:{ns}:{sha256[:16]}`, fail-open |
| `src/metrics.ts` | `src/metrics.py` | identical metric names/buckets |
| `src/moduleStatus.ts` | `src/module_status.py` | same `SERVICE_MODULES` thresholds |
| `src/mcp.ts` | `src/server.py::health_check` | only `health_check` registered so far |
| `src/server.ts` | `src/server.py` lifespan | `/health` + `/mcp` (streamable-http) |

`db_health` snapshot in `health_check` is a placeholder — the L2 monitor is
ported in Phase 2 (`TODO(parity, Phase 2)`).

## Develop

```bash
npm install
npm run typecheck          # tsc --noEmit
DATABASE_URL=postgresql://... npm run dev
curl localhost:8000/health # -> {"status":"ok"}
```

## Build / run

```bash
npm run build && npm start
# or
docker build -t taiwan-health-node .
```

Environment variables are the same as the Python server (`MCP_PORT`,
`MCP_PATH`, `DATABASE_URL`, `REDIS_URL`, `METRICS_PORT`, `LOG_LEVEL`, …).
