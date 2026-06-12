# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Language
用台灣正體中文回答, 文件和註解使用英文

## gstack

Use gstack’s `/browse` skill for all web browsing.

Never use `mcp__claude-in-chrome__*` tools.

Available gstack skills:

* `/office-hours`
* `/plan-ceo-review`
* `/plan-eng-review`
* `/plan-design-review`
* `/design-consultation`
* `/design-shotgun`
* `/design-html`
* `/review`
* `/ship`
* `/land-and-deploy`
* `/canary`
* `/benchmark`
* `/browse`
* `/connect-chrome`
* `/qa`
* `/qa-only`
* `/design-review`
* `/setup-browser-cookies`
* `/setup-deploy`
* `/setup-gbrain`
* `/retro`
* `/investigate`
* `/document-release`
* `/document-generate`
* `/codex`
* `/cso`
* `/autoplan`
* `/plan-devex-review`
* `/devex-review`
* `/careful`
* `/freeze`
* `/guard`
* `/unfreeze`
* `/gstack-upgrade`
* `/learn`

## Project Overview

Taiwan Health MCP Server — a Model Context Protocol server built on the official **`mcp` SDK** (`mcp.server.fastmcp.FastMCP`) exposing **~51 tools** across 12 tool groups for Taiwan medical and health data. Designed for production SaaS deployment with hundreds of requests/second throughput.

**Modules**: ICD-10-CM/PCS 2025, LOINC 2.80, SNOMED CT International, Taiwan FDA (TFDA) drugs, Taiwan FDA health supplements, Taiwan FDA food nutrition, Taiwan clinical guidelines, FHIR R4 IG authoring (multi-IG, default TWCore v1.0.0), FHIR Condition/Medication generation, and an external FHIR server registry. RxNorm is loaded as concept-only reference terminology (used for IG ValueSet expansion, not a standalone drug tool).

Three surfaces ship in one codebase:
- **MCP server** (`src/server.py`) — the read-only tool surface consumed by LLM clients (also exposes the admin REST API, `/admin/ws`, `/status.json`, `/mcp`, `/openapi.json`).
- **Admin console** (`src/admin_*.py` backend + the `web/` Next.js front-end) — an operator UI for uploading source files, running/scheduling data imports, managing settings and external FHIR servers, and monitoring jobs. Disabled by default (`ADMIN_ENABLED=false`).
- **Next.js front-end** (`web/`) — a single Node.js app serving every web page: the public landing/status/privacy/dpa pages **and** the admin SPA (the old `admin-ui/` Vite app is merged in under `web/admin-app/`, mounted via a `/admin` catch-all route). nginx (`nginx/nginx.conf`) is the single front door: it routes API/MCP/WebSocket to the Python `app` and everything else to `web`. The legacy inlined HTML in `src/server.py` is gated behind `LEGACY_HTML=true` (default off).

## Commands

```bash
# Install dependencies
pip install -r requirements.txt

# Run server locally (stdio mode for Claude Desktop)
DATABASE_URL=postgresql://mcp:pass@localhost:5432/taiwan_health python src/server.py

# Run server (HTTP mode)
MCP_TRANSPORT=streamable-http DATABASE_URL=postgresql://... python src/server.py

# Docker (production — recommended)
cp .env.example .env                          # then edit .env (set POSTGRES_PASSWORD, ADMIN_*)
docker compose up -d                          # postgres, pgbouncer, redis, minio, app, admin-worker, web (Next.js), nginx (front door :8080)

# Data loading is done through the admin console (Modules tab) and executed by
# the admin-worker in the background — there is NO standalone CLI data-loader
# container (the old `docker compose --profile loader run …` path was removed).
# The loader stages still live in loader/main.py and are invoked by the worker:
#   --icd  --loinc  --twcore  --guideline  --snomed  --health-supplements
#   --food-nutrition  --drug-index / --drug-enrich / --drug-analysis  --drug
#   --embed   (embeddings auto-run after each import)

# Run tests
pip install pytest pytest-asyncio
python -m pytest tests/ -v
```

## Architecture

### Infrastructure stack
| Component | Purpose |
|-----------|---------|
| PostgreSQL 16 (`pgvector/pgvector:pg16`) | Primary data store + `vector` columns for semantic search |
| pgBouncer | Connection pooler (transaction mode, 500 client → 30 PG connections) |
| Redis 7 | Response cache (TTL-based, `@cached` decorator), LRU-capped |
| MinIO | Object storage for drug assets (inserts, labels, pill images); presigned download links |
| Ollama (external) | Embedding model (`qwen3-embedding:0.6b`, 1024-dim) for semantic / hybrid search. Optional — unset `OLLAMA_BASE_URL` to fall back to keyword-only |
| Prometheus | Metrics on `METRICS_PORT` (default 9090, bound to localhost) |

`docker compose up -d` starts: `postgres`, `pgbouncer`, `redis`, `minio`, `minio-init` (bucket bootstrap), `app` (MCP server + admin), and `admin-worker` (background job runner). There is no separate data-loader container — imports run inside `admin-worker`.

### Entry point
`src/server.py` — `DynamicFastMCP` server (subclass of FastMCP). Startup uses `asynccontextmanager lifespan`:
1. Start Prometheus metrics server (idempotent)
2. Init asyncpg pool through pgBouncer (`statement_cache_size=0` required for transaction mode)
3. Init Redis client
4. Init MinIO + embedding clients
5. Start DB pool stats collector (background task)
6. Initialize each service in try/except — a failing service degrades gracefully
7. Run Redis warm-up cache for common queries
8. Run initial module status sync — registers only tools whose modules meet the row-count threshold
9. Mount the admin console sub-app when `ADMIN_ENABLED=true`

**HTTP surface.** In production nginx (`:${WEB_PORT:-8080}`) is the single entry point: `/mcp`, `/openapi.json`, `/tools/*`, `/status.json`, `/admin/api/*`, `/admin/ws`, `/fhir-client/*`, `/fhir-oauth/*` proxy to the Python `app`; every other path (public pages + `/admin` SPA + `/admin/login`) is served by the `web` Next.js app. The Python ASGI app (still `PrivacyPageMiddleware` wrapping FastMCP) directly exposes:
- `/mcp` — the MCP streamable-http endpoint (`MCP_PATH`).
- `/`, `/status`, `/privacy`, `/dpa` + logo/favicon — static pages.
- `/admin` + `/admin/ws` — admin console sub-app (when enabled).
- `/fhir-client/<id>/jwks.json` — public JWKS for FHIR OAuth clients.
- **OpenAPI bridge** (`_build_openapi_spec` + `_handle_openapi_tool_call`): `GET /openapi.json` advertises the currently-registered tools as an OpenAPI 3.1 doc, and `POST /tools/<name>` invokes a tool with a JSON-body of arguments. This lets OpenAPI-only clients (e.g. Open WebUI's OpenAPI tool servers) call the tools without a separate mcpo proxy. Unauthenticated, same as `/mcp`.

### Services

| Service | File | Data source | Populated by |
|---------|------|-------------|--------------|
| ICD Service | `icd_service.py` | `icd.diagnoses` / `icd.procedures` | admin import (`--icd`) |
| Drug Service | `drug_service.py` | `drug.*` tables | admin import drug pipeline (`--drug-index/-enrich/-analysis`), run by admin worker |
| Drug Analysis Service | `drug_analysis_service.py` | `drug.insert_analysis` | OCR + LLM analysis stage |
| Health Supplements Service | `health_supplements_service.py` | `health_supplements.items` | admin import (`--health-supplements`), TFDA Open Data |
| Food Nutrition Service | `food_nutrition_service.py` | `food_nutrition.*` | admin import (`--food-nutrition`), TFDA Open Data |
| Lab Service | `lab_service.py` | `loinc.*` | admin import (`--loinc`) |
| Clinical Guideline Service | `clinical_guideline_service.py` | `guideline.*` | admin import (`--guideline`) |
| FHIR Condition Service | `fhir_condition_service.py` | reads `icd.diagnoses` | — (derives from ICD) |
| FHIR Medication Service | `fhir_medication_service.py` | reads `drug_service` | — (derives from Drug) |
| FHIR IG Service | `fhir_ig_service.py` | `fhir.*` (multi-IG, package-scoped) | admin import (`--twcore`) + admin IG import |
| FHIR Server Service | `fhir_server_service.py` | `admin.fhir_servers` | admin console **FHIR Servers** registration pipeline (always-on tools) |
| TWCore Service | `twcore_service.py` | `fhir.*` (legacy helper) | admin import (`--twcore`) |
| SNOMED Service | `snomed_service.py` | `snomed.*` | admin import (`--snomed`) |
| Embedding Service | `embedding_service.py` | Ollama `/api/embed` | — (cross-cutting) |
| MinIO Service | `minio_service.py` | MinIO bucket | — (drug assets) |

Periodic re-imports are **not** scheduled inside the services. Scheduling is centralized in the admin worker via `admin.module_schedules` (managed in the admin console; see `src/admin_schedule.py`).

### MCP tool groups (`_TOOL_GROUPS` in `server.py`)
| Group | Tools |
|-------|-------|
| ICD-10 | `search_medical_codes`, `infer_complications`, `get_nearby_codes`, `check_medical_conflict`, `browse_icd_category` |
| Drug / TFDA | `search_drug`, `identify_unknown_pill`, `get_drug_details`, `get_drug_asset_links` |
| Lab / LOINC | `search_loinc`, `query_loinc`, `interpret_lab_result`, `batch_interpret_lab_results` |
| Guidelines | `search_clinical_guideline`, `query_guideline` |
| SNOMED CT | `search_snomed_concept`, `query_snomed_concept`, `get_snomed_relationships`, `query_snomed_mapping` |
| FHIR R4 (Condition) | `query_fhir_condition`, `validate_fhir_condition` |
| FHIR R4 (Medication) | `query_fhir_medication`, `validate_fhir_medication` |
| FHIR IG | `fhir_list_igs`, `fhir_get_ig`, `fhir_list_artifacts`, `fhir_search_artifacts`, `fhir_list_resource_profiles`, `fhir_rank_resource_profiles`, `fhir_get_profile`, `fhir_get_profile_elements`, `fhir_get_valueset`, `fhir_expand_valueset`, `fhir_lookup_code`, `fhir_validate_code`, `fhir_normalize_code`, `fhir_resolve_reference`, `fhir_build_bundle`, `fhir_validate_resource`, `fhir_validate_bundle`, `fhir_get_resource_skeleton`, `fhir_finalize_resource` |
| Health Supplements | `search_health_supplements` |
| Food Nutrition | `query_food_nutrition`, `query_food_ingredient`, `search_foods_by_nutrient`, `analyze_meal_nutrition` |
| FHIR Servers | `list_fhir_servers`, `get_fhir_server_status`, `crud_fhir_server` (always registered) |
| System | `health_check` (always registered) |

Module-gated groups are dynamically added/removed by `ModuleStatusManager` based on row-count thresholds (see `src/module_status.py`, `SERVICE_MODULES`). FHIR Servers and System tools are always registered.

### Data loader
`loader/main.py` — the loader stages live here. There is **no** standalone loader
container; the `admin-worker` (and, in dev, a direct module invocation) runs these
stages. Imports are triggered/scheduled from the admin console.
- File-based imports (ICD / LOINC / SNOMED / FHIR IG) consume source files
  **uploaded via the admin console** (Sources / Modules tab); API-based imports
  (drug / health-supplements / food-nutrition) fetch from their upstream APIs;
  guidelines are seeded from the repo.
- Bulk writes go **directly** to PostgreSQL (bypassing pgBouncer).
- For local development without the admin console, source-file locations can also
  be resolved by `loader/dataset_resolver.py` from `config/datasets.yaml`
  (`DATASETS_CONFIG`), falling back to the legacy `fhir-code/` layout:
  - `icd/10/icd10cm/icd10cm-table-index-2025.zip`
  - `icd/10/icd10pcs/icd10pcs_tables_2025.zip` *(bundled — loaded automatically by `--icd`)*
  - `icd/10/*.xlsx` *(optional Taiwan ICD Chinese names)*
  - `loinc/2.80/Loinc_2.80.zip`
  - `twcoreig/package.tgz` *(primary IG; additional IG dependency packages such as `hl7.terminology.r4` / `hl7.fhir.r4.core` can be bound via Admin → Sources and are indexed as their own package-scoped IGs)*
  - `snomed/SnomedCT_InternationalRF2_PRODUCTION_*.zip`
  - `rxnorm/RxNorm_full_*.zip` *(concept-only reference)*
- Drug pipeline source: the canonical TFDA `36_2.csv` license index plus live TFDA crawling (`DRUG_TFDA_BASE_URL`), OCR (`DRUG_OCR_*`), and an analysis LLM (`DRUG_ANALYSIS_*`).
- Embedding stage (`embedding_loader.py`) backfills `*_embeddings` vector tables via Ollama.

### Admin console & background worker
- **`src/admin_console.py`** mounts a session-authenticated sub-app at `/admin` (Starlette). It composes feature modules: `admin_sources.py` (file uploads + source roles), `admin_jobs.py` (import jobs), `admin_schedule.py` (cron schedules), `admin_services.py` (module/service status), `admin_settings.py` (DB-backed settings), `admin_maintenance.py` (per-module maintenance mode + clear), `admin_drug.py` (drug pipeline control), `admin_ig.py` (FHIR IG gallery/import), `admin_preview.py`, `admin_embedding.py`, `admin_ws.py` (WebSocket live logs), `admin_html_shell.py` (server-rendered fallback shell).
- **`src/admin_worker.py`** is a standalone process (the `admin-worker` compose service). It claims queued jobs from `admin.import_jobs`, runs loader stages, writes `admin.import_job_steps` / `admin.import_job_logs`, honors checkpoint-based pause/cancel via `admin.job_control_requests`, and emits `admin.worker_heartbeats`. `ADMIN_MAX_CONCURRENT_JOBS` bounds parallelism (per-module resource slots).
- **FHIR Servers registration pipeline** (routes inline in `src/server.py` under `/admin/api/fhir-servers/*`, logic in `fhir_server_service.py`, UI in `admin-ui/.../FhirServersPage.tsx`) — registers external FHIR servers via a 6-step wizard (Basics → Authentication → Headers → Permissions → Connection test → Review) with a fixed Configuration Summary. Covers seven auth templates (No Auth / OAuth2 / SMART on FHIR / IHE IUA × Authorization Code / Client Credentials) as a derived selector over `auth_type` + `auth_profile`. Key pieces: `discover_fhir_metadata` (full endpoint + capability surface for the `/discover` panel), a dual-pane Scope Manager (discovery/preset/manual scope sources), segmented base-URL editor, and `run_fhir_test_request` (the `/test-request` route — sends one ad-hoc method/path/query/headers/body request against an **unsaved** draft, read-only by default).
- **`web/admin-app/`** is the React SPA admin UI (formerly `admin-ui/`, now merged into the `web/` Next.js app and mounted client-side under the `/admin` catch-all route). It posts to `/admin/api/login`/`/admin/api/logout` (JSON aliases) and a Next `middleware.ts` gates `/admin/*` on the `tw_health_admin_session` cookie. A server-rendered HTML shell (`admin_html_shell.py`) remains as a legacy fallback.
- **`src/db_health.py`** is a central DB-health gate: when Postgres is unreachable it locks mutating operations and surfaces an overlay in the UI.

### Cross-cutting concerns
- **`src/audit.py`** — `@audited("tool_name")` decorator: logs SHA-256(params), tool name, duration, status to `audit.query_log`. Never logs raw parameter values (HIPAA).
- **`src/cache.py`** — `@cached(ttl, prefix)` decorator: Redis-backed, fail-open (cache error → function executes normally). Records hit/miss metrics.
- **`src/module_status.py`** — `ModuleStatusManager`: queries each schema's row count against a minimum threshold; calls `mcp.add_tool()`/`mcp.remove_tool()` to dynamically show/hide tools. 5-minute TTL cache. Triggered on every `tools/list` call via `DynamicFastMCP.list_tools()` override.
- **`src/embedding_service.py`** — Ollama-backed embeddings for semantic / hybrid search; fails open to keyword-only when unavailable.
- **`src/fhir_validator.py` / `fhir_terminology.py` / `fhir_snapshot.py` / `fhir_reference.py` / `fhir_authoring.py`** — in-process FHIR R4 profile snapshot generation, terminology validation, reference resolution, and skeleton-fill authoring used by the FHIR IG tools.
- **`src/metrics.py`** — Prometheus counters/histograms. `record_tool_call()` called by `@audited`; `record_cache_op()` called by `@cached`.
- **`src/utils.py`** — Structured JSON logging to stderr (never stdout, which belongs to MCP stdio transport). Configure level via `LOG_LEVEL`.
- **`src/database.py`** — asyncpg pool singleton. `statement_cache_size=0` set to support pgBouncer transaction mode.

### PostgreSQL schemas
`audit` | `admin` | `icd` | `drug` | `health_supplements` | `food_nutrition` | `loinc` | `guideline` | `fhir` (multi-IG: `ig_packages` / `codesystems` / `concepts` / `artifacts`, package-scoped) | `snomed` | `rxnorm`

Full schema: `db/schema.sql` (auto-applied by PostgreSQL container on first init). Incremental changes live in `db/migrations/`.

## Settings precedence (important)

Bootstrap variables (DB / Redis / MCP transport / `ADMIN_*` auth) live only in `.env`. Everything else — Ollama/embedding, MinIO, drug OCR/analysis, TFDA base URL, worker tuning — is **seed-only** in `.env`: it is read once on first boot to seed `admin.app_settings`, then managed (and hot-reloaded) from the admin console → Settings tab. Editing those `.env` keys has no effect on an already-seeded database.

## Adding a New Service

1. Create `src/<name>_service.py` — class with `__init__(self, pool, ...)` and `async initialize()`
2. In `server.py` lifespan, add `("<Name>Service", lambda: <Name>Service(pool, ...))` to the services list
3. Add the global variable and assignment in the elif chain
4. Add tools with `@mcp.tool()` + `@audited("tool_name")` decorators and register them in `_TOOL_GROUPS`
5. For module-gated availability, add an entry to `SERVICE_MODULES` in `module_status.py` and a `_svc_unavailable()` guard at the start of each tool

## Sync correctness rule

Bulk imports follow this pattern to prevent partial-state corruption:
1. **Fetch all data first** (outside DB connection, full network phase)
2. **Then write atomically** (`async with conn.transaction(): TRUNCATE/UPSERT`)
3. **Deduplicate source data** before insert — TFDA Open Data occasionally has duplicate primary keys (e.g., duplicate `license_id`). Each import deduplicates using a `seen_ids` set.

Never interleave HTTP fetches with DB writes inside a transaction.

## mcp SDK lifespan-per-session (important)

In `streamable-http` mode, the `mcp` SDK's `FastMCP` runs the `lifespan` context manager **once per MCP session**, not once per process. All one-time initialization is guarded by:
- `_init_lock: asyncio.Lock` + `_initialized: bool` in `server.py` — only the first session runs the full setup
- `database.init_pool()` and `cache.init_client()` — idempotent; return the existing singleton if already created
- `metrics.start_metrics_server()` — `_metrics_server_started` flag prevents duplicate port binding

Session teardown does **not** close the pool or Redis client (shared resources must survive across sessions).

## Key Limitations

- **Health supplements disease mappings** are developer-curated and not medically validated — not suitable for patient-facing use without expert review
- **FHIR validation** is in-process and profile-driven (snapshot + terminology binding checks); it is not a substitute for the official HL7 FHIR Validator for conformance certification
- **ICD-10-PCS** (procedure codes) — 2025 zip is bundled in `fhir-code/icd/10/icd10pcs/`; `--icd` loads both CM and PCS automatically; graceful degradation if the table is empty
- **SNOMED CT** requires an active SNOMED International license (free for most uses)
- **Drug analysis** (OCR + LLM extraction of TFDA inserts) is machine-generated and must be verified by a clinician; it depends on external OCR/LLM endpoints being configured
- **Embeddings** require a reachable Ollama server; without it, search degrades to keyword-only and the `keyword_only` signal is returned
- **pgBouncer transaction mode** is incompatible with `LISTEN/NOTIFY` and named prepared statements — asyncpg's `statement_cache_size=0` handles this
