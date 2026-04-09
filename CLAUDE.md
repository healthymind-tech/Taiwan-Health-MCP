# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Taiwan Health MCP Server — a Model Context Protocol server built on the official **`mcp` SDK** (`mcp.server.fastmcp.FastMCP`) providing **56 tools** for Taiwan medical and health data. Designed for production SaaS deployment with hundreds of requests/second throughput.

**Datasets**: ICD-10-CM 2025, LOINC 2.80, SNOMED CT International, RxNorm, Taiwan FDA drugs/health foods/nutrition, TWCore IG v1.0.0, Taiwan clinical guidelines.

## Commands

```bash
# Install dependencies
pip install -r requirements.txt

# Run server locally (stdio mode for Claude Desktop)
DATABASE_URL=postgresql://mcp:pass@localhost:5432/taiwan_health python src/server.py

# Run server (HTTP mode)
MCP_TRANSPORT=streamable-http DATABASE_URL=postgresql://... python src/server.py

# Docker (production — recommended)
cp .env.example .env   # then edit .env
docker compose up -d

# Run data-loader (populate all terminology datasets)
docker compose --profile loader run --rm data-loader --all

# Run specific loaders
docker compose --profile loader run --rm data-loader --icd
docker compose --profile loader run --rm data-loader --loinc
docker compose --profile loader run --rm data-loader --twcore
docker compose --profile loader run --rm data-loader --guideline
docker compose --profile loader run --rm data-loader --snomed   # large, 5-15 min
docker compose --profile loader run --rm data-loader --rxnorm
docker compose --profile loader run --rm data-loader --fda          # all Taiwan FDA API datasets
docker compose --profile loader run --rm data-loader --drug
docker compose --profile loader run --rm data-loader --health-food
docker compose --profile loader run --rm data-loader --food-nutrition

# Run tests
pip install pytest pytest-asyncio
pytest tests/ -v
```

## Architecture

### Infrastructure stack
| Component | Purpose |
|-----------|---------|
| PostgreSQL 16 | Primary data store — all terminology data |
| pgBouncer 1.23 | Connection pooler (transaction mode, 500 client → 30 PG connections) |
| Redis 7 | Response cache (TTL-based, `@cached` decorator) |
| Prometheus | Metrics on `METRICS_PORT` (default 9090) |

### Entry point
`src/server.py` — `DynamicFastMCP` server (subclass of FastMCP) with up to 56 tool definitions. Startup uses `asynccontextmanager lifespan`:
1. Start Prometheus metrics server
2. Init asyncpg pool through pgBouncer (`statement_cache_size=0` required for transaction mode)
3. Init Redis client
4. Start DB pool stats collector (background task)
5. Initialize each service in try/except — failing service degrades gracefully
6. Run Redis warm-up cache for common queries
7. Run initial dataset status sync — registers only tools whose datasets meet the row-count threshold

### Services

| Service | File | Data source | Sync |
|---------|------|-------------|------|
| ICD Service | `icd_service.py` | `icd.diagnoses` / `icd.procedures` | data-loader (static) |
| Drug Service | `drug_service.py` | `drug.*` tables | FDA Open Data, every Tuesday 02:00 UTC |
| Health Food Service | `health_food_service.py` | `health_food.items` | FDA Open Data, every Monday 02:30 UTC |
| Food Nutrition Service | `food_nutrition_service.py` | `food_nutrition.*` | FDA Open Data, every Monday 03:00 UTC |
| Lab Service | `lab_service.py` | `loinc.*` | data-loader (LOINC 2.80 zip) |
| Clinical Guideline Service | `clinical_guideline_service.py` | `guideline.*` | data-loader (seed data) |
| FHIR Condition Service | `fhir_condition_service.py` | reads `icd.diagnoses` | — |
| FHIR Medication Service | `fhir_medication_service.py` | reads `drug_service` | — |
| TWCore Service | `twcore_service.py` | `twcore.*` | data-loader (package.tgz) + live fetch fallback |
| SNOMED Service | `snomed_service.py` | `snomed.*` | data-loader (RF2 zip) |
| Drug Interaction Service | `drug_interaction_service.py` | `rxnorm.*` | data-loader (RxNorm zip) |

### Data loader
`loader/main.py` — separate Docker container (`profiles: [loader]`, `restart: "no"`).
- Connects **directly** to PostgreSQL (bypasses pgBouncer) for bulk writes
- Source files expected at `/app/fhir-code/` (mounted read-only):
  - `icd10cm/icd10cm-table-index-2025.zip`
  - `loinc/2.80/Loinc_2.80.zip`
  - `twcoreig/package.tgz`
  - `snomed/SnomedCT_InternationalRF2_PRODUCTION_*.zip`
  - `rxnorm/RxNorm_full_*.zip`
  - `umls/umls-2024AA-metathesaurus-full.zip` *(not yet loaded — future use; excluded from git due to UMLS license — obtain from https://uts.nlm.nih.gov/uts/signup-login)*
  - `icd10pcs/icd10pcs_tables_2025.zip` *(bundled — loaded automatically by `--icd`)*

### Cross-cutting concerns
- **`src/audit.py`** — `@audited("tool_name")` decorator: logs SHA-256(params), tool name, duration, status to `audit.query_log`. Never logs raw parameter values (HIPAA).
- **`src/cache.py`** — `@cached(ttl, prefix)` decorator: Redis-backed, fail-open (cache error → function executes normally). Records hit/miss metrics.
- **`src/dataset_status.py`** — `DatasetStatusManager`: queries each schema's row count against a minimum threshold; calls `mcp.add_tool()`/`mcp.remove_tool()` to dynamically show/hide tools based on dataset availability. 5-minute TTL cache. Triggered on every `tools/list` call via `DynamicFastMCP.list_tools()` override.
- **`src/metrics.py`** — Prometheus counters/histograms. `record_tool_call()` called by `@audited`. `record_cache_op()` called by `@cached`.
- **`src/utils.py`** — Structured JSON logging to stderr (never stdout, which belongs to MCP stdio transport). Configure level via `LOG_LEVEL` env var.
- **`src/database.py`** — asyncpg pool singleton. `statement_cache_size=0` is set to support pgBouncer transaction mode.

### PostgreSQL schemas
`audit` | `icd` | `drug` | `health_food` | `food_nutrition` | `loinc` | `guideline` | `twcore` | `snomed` | `rxnorm`

Full schema: `db/schema.sql` (auto-applied by PostgreSQL container on first init).

## Adding a New Service

1. Create `src/<name>_service.py` — class with `__init__(self, pool)` and `async initialize()`
2. In `server.py` lifespan, add `("<Name>Service", lambda: <Name>Service(pool))` to the services list
3. Add the global variable and assignment in the elif chain
4. Add tools with `@mcp.tool()` + `@audited("tool_name")` decorators
5. For services with optional data (like SNOMED), add a `_svc_unavailable()` guard at the start of each tool

## Sync correctness rule

All FDA sync functions (`_sync_all`, `_sync`) follow this pattern to prevent partial-state corruption:
1. **Fetch all data first** (outside DB connection, full network phase)
2. **Then write atomically** (`async with conn.transaction(): TRUNCATE + INSERT`)
3. **Deduplicate source data** before insert — FDA API occasionally has duplicate primary keys (e.g., duplicate `license_id` in drug master). Each service deduplicates using a `seen_ids` set.

Never interleave HTTP fetches with DB writes inside a transaction.

## mcp SDK lifespan-per-session (important)

In `streamable-http` mode, the `mcp` SDK's `FastMCP` runs the `lifespan` context manager **once per MCP session**, not once per process. All one-time initialization is guarded by:
- `_init_lock: asyncio.Lock` + `_initialized: bool` in `server.py` — only the first session runs the full setup
- `database.init_pool()` and `cache.init_client()` — idempotent; return existing singleton if already created
- `metrics.start_metrics_server()` — `_metrics_server_started` flag prevents duplicate port binding
- Each sync service has `asyncio.Lock` (`_sync_lock`) — concurrent syncs skip with a log message
- Each sync service checks `if not self._scheduler.running` before calling `scheduler.start()`

Session teardown does **not** close the pool or Redis client (shared resources must survive across sessions).

## Key Limitations

- **Health food disease mappings** are developer-curated and not medically validated — not suitable for patient-facing use without expert review
- **FHIR validation** is basic (required fields only); production use requires the HL7 FHIR Validator
- **ICD-10-PCS** (procedure codes) — 2025 zip is bundled in `fhir-code/icd10pcs/`; `--icd` loads both CM and PCS automatically; graceful degradation if table is empty
- **SNOMED CT** requires an active SNOMED International license (free for most uses)
- **Drug interactions**: RxNorm `interacts_with` relationships indicate a potential interaction but do not include severity; always verified by a clinician
- **pgBouncer transaction mode** is incompatible with `LISTEN/NOTIFY` and named prepared statements — asyncpg's `statement_cache_size=0` handles this
