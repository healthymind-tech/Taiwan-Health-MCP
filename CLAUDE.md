# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Language
用台灣正體中文回答, 程式碼和註解使用英文

### 文件網站是雙語的 —— 改內容時兩份一起改

`docs/` 底下的 MkDocs 網站（發佈於 GitHub Pages）為**繁體中文 + 英文**雙語。
每一頁都以兩個檔案存在：

| 檔案 | 語言 | 發佈路徑 |
|------|------|----------|
| `docs/<path>/<page>.md` | 繁體中文（預設） | `/<path>/<page>/` |
| `docs/<path>/<page>.en.md` | 英文 | `/en/<path>/<page>/` |

**任何文件內容變更都必須同時套用到兩個檔案，並放在同一個 commit 裡。**
只改一邊會讓兩種語言悄悄發散——`mkdocs-static-i18n` 的 `fallback_to_default` 會讓
缺漏的翻譯默默顯示中文版而不報錯，問題會被隱藏很久。

新增頁面時：一次建立 `.md` 與 `.en.md`，在 `mkdocs.yml` 的 `nav` 加入口，
並在 `plugins.i18n` 的 `nav_translations` 補上英文標題。

檢查漏翻：

```bash
comm -23 \
  <(find docs -name '*.md' ! -name '*.en.md' | sed 's/\.md$//' | sort) \
  <(find docs -name '*.en.md' | sed 's/\.en\.md$//' | sort)
```

（目前預期輸出：`docs/datasets`、`docs/MinerU-vs-OpenAI`、`docs/ocr-test-setup` —— 這三頁
不在 `nav` 內、無任何連結指向，尚未翻譯。其餘任何項目出現都代表漏翻。）

細節見 `docs/WEBSITE.md`。

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

> **Backend runtime — READ FIRST.** The backend is **100% Node.js / TypeScript**, under
> `node-server/`. There is **no Python anywhere in this repository** — `src/*.py`,
> `loader/` and `requirements.txt` were deleted when the drug pipeline was ported in
> 2026-07. Two compose services run from `node-server/`: `app` (`node dist/server.js` —
> MCP + admin REST) and `admin-worker` (`node dist/admin/adminWorker.js` — every job
> type, including the three drug stages). The `web` service is the Next.js front-end.
> OCR is an external **MinerU** HTTP service (Settings → OCR Server), not an in-process
> model. Make backend changes in `node-server/src/`.
>
> The only remaining thing under `src/` is `src/prompts/` — the Analysis-LM system
> prompt, read at runtime by `drugAnalysisService.ts`. Do not delete it.
>
> **Dead files that look live — do not edit, do not "fix":** root `pyproject.toml`,
> `pytest.ini`, `requirements-dev.txt` (Python-era leftovers; `requirements-docs.txt`
> is the live one — `deploy-docs.yml` installs from it, so any plugin enabled in
> `mkdocs.yml` must be listed there or the build fails), root `admin-ui/` (old Vite
> SPA — the real admin UI is `web/admin-app/`), and `config/datasets.yaml` (read by no code).

Taiwan Health MCP Server — a Model Context Protocol server (Node MCP SDK,
`@modelcontextprotocol/sdk`) exposing **49 tools** across 11 tool groups for Taiwan
medical and health data. Designed for production SaaS deployment with hundreds of
requests/second throughput.

**Modules**: ICD-10-CM/PCS 2025, LOINC 2.80, SNOMED CT International, Taiwan FDA (TFDA) drugs, Taiwan FDA health supplements, Taiwan FDA food nutrition, FHIR R4 IG authoring (multi-IG, default TWCore v1.0.0), FHIR Condition/Medication generation, and an external FHIR server registry. RxNorm is loaded as concept-only reference terminology (used for IG ValueSet expansion, not a standalone drug tool).

Three surfaces ship in one codebase:
- **MCP server** (`node-server/src/server.ts` + `mcp.ts`) — the tool surface consumed by LLM clients (also exposes the admin REST API, `/admin/ws`, `/mcp`, `/openapi.json`, `POST /tools/<name>`).
- **Admin console** (`node-server/src/admin/*.ts` backend + the `web/admin-app/` SPA) — an operator UI for uploading source files, running/scheduling data imports, managing settings and external FHIR servers, and monitoring jobs. Disabled by default (`ADMIN_ENABLED=false`).
- **Next.js front-end** (`web/`) — serves the admin SPA only (mounted via a `/admin` catch-all route). nginx (`nginx/nginx.conf`) is the single front door: it routes API/MCP/WebSocket to `app` and everything else to `web`. The public landing/status/privacy/dpa pages were removed from this repo and now live in a standalone marketing-site project; `nginx.conf` carries a TODO for the 301 redirects.

**Entry point (ports).** nginx publishes `${WEB_PORT:-8080}` and is the **only** service
reachable from the host. `app` merely `expose`s `MCP_PORT` (8000) on the compose network —
`http://<host>:8000` does **not** reach this system. Always use `:8080`.

## Commands

```bash
# --- Node backend (app + admin-worker both build from node-server/) ---------
cd node-server
npm install
npm run build                                 # tsc -> dist/
npm run typecheck                             # tsc --noEmit
npm test                                      # node --import tsx --test src/**/*.test.ts
npm run dev                                   # tsx watch src/server.ts (no build step)

# Run a single test file (npm test has no path passthrough — call node directly):
node --import tsx --test src/loaders/loinc.test.ts
# Run a single test case by name (matches the string passed to `test(...)`):
node --import tsx --test --test-name-pattern "padded headers" src/loaders/loinc.test.ts

# Run the MCP/admin server locally (HTTP mode):
MCP_TRANSPORT=streamable-http DATABASE_URL=postgresql://... node dist/server.js

# --- Web front-end (admin SPA) ---------------------------------------------
cd web
npm install
npm run dev                                   # next dev -p 3000 (copies pdf.worker first)
npm run build && npm run start                # production build / serve
npm run typecheck                             # tsc --noEmit (no web test suite)

# --- Docker (production — recommended) -------------------------------------
cp .env.example .env                          # then edit .env (set POSTGRES_PASSWORD, ADMIN_*)
docker compose up -d                          # nginx (:8080), web, app, admin-worker, postgres, pgbouncer, redis, minio
docker compose build app web && docker compose up -d --no-deps app web   # redeploy after code changes

# `admin-worker` is a SEPARATE image (Dockerfile.worker) built from the same
# node-server/ source. Any change to job/loader code (adminJobs.ts, *Service.ts,
# loaders/*) must be deployed to it too — rebuilding only `app` leaves the
# worker executing stale code with no error:
docker compose build admin-worker && docker compose up -d --no-deps admin-worker

# Data loading is done through the admin console (Modules tab) and executed by
# the admin-worker in the background. Every job type — file loaders, embeddings,
# and the three drug stages — runs natively in Node. There is no loader CLI and
# no standalone data-loader container.
```

**There is no linter or formatter** — no ESLint, Prettier or Biome config in either
package. `tsc --noEmit` (`npm run typecheck`) is the only static gate; don't add
lint commands to a task's "done" checklist expecting one to exist.

## Architecture

### Infrastructure stack
| Component | Purpose |
|-----------|---------|
| nginx | Single front door on `${WEB_PORT:-8080}`; routes `/mcp`, `/openapi.json`, `/tools/*`, `/admin/api/*`, `/admin/ws`, `/fhir-client/*`, `/fhir-oauth/*` to `app`, everything else to `web` |
| PostgreSQL 16 (`pgvector/pgvector:pg16`) | Primary data store + `vector` columns for semantic search |
| pgBouncer | Connection pooler (transaction mode, 500 client → 30 PG connections) |
| Redis 7 | Connected at boot and health-pinged, but **no tool response is cached today** — `cached()` in `cache.ts` has zero call sites (see "Cross-cutting concerns") |
| MinIO | Object storage for admin source uploads and drug assets (inserts, labels, pill images); presigned download links |
| Embedding endpoint (external) | Semantic / hybrid search vectors (default Ollama `qwen3-embedding`). Configured in `admin.llm_profiles`, **not** env. Unavailable → keyword-only fallback |
| MinerU (external) | OCR for drug insert PDFs (`POST /file_parse`). Configured in Settings → OCR Server |
| Analysis LM (external) | Drug insert extraction. Configured in `admin.llm_profiles` |
| Prometheus | Metrics on `METRICS_PORT` (default 9090, bound to localhost) |

### Entry point
`node-server/src/server.ts` — Express app + MCP streamable-http transport. Process startup
(`main()`) initializes once: Postgres pool (through pgBouncer), Redis, MinIO, metrics,
each service (a failing service degrades gracefully), and the module-status sync that
registers only tools whose modules meet the row-count threshold. MCP sessions each get a
transport but share those process-wide singletons.

HTTP surface exposed by `app`:
- `/mcp` — MCP streamable-http endpoint (`MCP_PATH`).
- **OpenAPI bridge**: `GET /openapi.json` advertises the currently-registered tools as an OpenAPI 3.1 doc, and `POST /tools/<name>` invokes a tool with a JSON body of arguments. Lets OpenAPI-only clients (e.g. Open WebUI) call the tools without an mcpo proxy.
- **Public-tools auth** (`publicToolsSecurity.ts`) guards `/mcp`, `/openapi.json` and `/tools/*` as one group: `PUBLIC_TOOLS_AUTH_MODE=none` (default — open) or `bearer` (requires `PUBLIC_TOOLS_BEARER_TOKEN`, compared with `timingSafeEqual`). `PUBLIC_TOOLS_CORS_ORIGINS` is a comma-separated allow-list; it defaults to `*` in `none` mode and **may not** contain `*` in `bearer` mode (startup throws). The admin surface has its own session auth and is unaffected.
- `/admin/api/*` + `/admin/ws` — admin console backend (when enabled).
- `/fhir-client/<id>/jwks.json` — public JWKS for FHIR OAuth clients; `/fhir-oauth/callback` — OAuth2 Authorization Code callback.
- `/health` exists on the app but nginx does **not** route it. There is no front-door health endpoint; hit `/openapi.json` to check liveness.

### Services (all `node-server/src/`)

| Service | File | Data source | Populated by |
|---------|------|-------------|--------------|
| ICD Service | `icdService.ts` | `icd.diagnoses` / `icd.procedures` | `icd_import` job |
| Drug Service | `drugService.ts` | `drug.*` tables | `drug_index_import` / `drug_enrichment` / `drug_analysis` jobs |
| Drug Analysis Service | `drugAnalysisService.ts` | `drug.insert_analysis` | MinerU OCR + Analysis-LM stage |
| Supplements Service | `supplementsService.ts` | `health_supplements.items` | `health_supplements_sync` (TFDA Open Data) |
| Food Service | `foodService.ts` | `food_nutrition.*` | `food_nutrition_sync` (TFDA Open Data) |
| Lab Service | `labService.ts` | `loinc.*` | `loinc_import` |
| FHIR Condition Service | `fhirConditionService.ts` | reads `icd.*` | — (derives from ICD) |
| FHIR Medication Service | `fhirMedicationService.ts` | reads drug service | — (derives from Drug) |
| FHIR IG Service | `fhirIgService.ts` | `fhir.*` (multi-IG, package-scoped) | `ig_import` + admin IG gallery |
| FHIR Server Service | `fhirServerService.ts` | `admin.fhir_servers` | admin console **FHIR Servers** wizard (always-on tools) |
| SNOMED Service | `snomedService.ts` | `snomed.*` | `snomed_import` |
| Embedding Service | `embeddingService.ts` | external embedding endpoint | — (cross-cutting) |
| MinIO helper | `minioService.ts` | MinIO bucket | — (source files + drug assets) |

Periodic re-imports are **not** scheduled inside the services. Scheduling is centralized in the admin worker via `admin.module_schedules` (see `admin/adminSchedule.ts`).

### MCP tool groups (`node-server/src/mcp.ts`)
| Group | Tools |
|-------|-------|
| ICD-10 | `search_medical_codes`, `infer_complications`, `get_nearby_codes`, `check_medical_conflict`, `browse_icd_category` |
| Drug / TFDA | `search_drug`, `identify_unknown_pill`, `get_drug_details`, `get_drug_asset_links` |
| Lab / LOINC | `search_loinc`, `query_loinc`, `interpret_lab_result`, `batch_interpret_lab_results` |
| SNOMED CT | `search_snomed_concept`, `query_snomed_concept`, `get_snomed_relationships`, `query_snomed_mapping` |
| FHIR R4 (Condition) | `query_fhir_condition`, `validate_fhir_condition` |
| FHIR R4 (Medication) | `query_fhir_medication`, `validate_fhir_medication` |
| FHIR IG | `fhir_list_igs`, `fhir_get_ig`, `fhir_list_artifacts`, `fhir_search_artifacts`, `fhir_list_resource_profiles`, `fhir_rank_resource_profiles`, `fhir_get_profile`, `fhir_get_profile_elements`, `fhir_get_valueset`, `fhir_expand_valueset`, `fhir_lookup_code`, `fhir_validate_code`, `fhir_normalize_code`, `fhir_resolve_reference`, `fhir_build_bundle`, `fhir_validate_resource`, `fhir_validate_bundle`, `fhir_get_resource_skeleton`, `fhir_finalize_resource` |
| Health Supplements | `search_health_supplements` |
| Food Nutrition | `query_food_nutrition`, `query_food_ingredient`, `search_foods_by_nutrient`, `analyze_meal_nutrition` |
| FHIR Servers | `list_fhir_servers`, `get_fhir_server_status`, `crud_fhir_server` (always registered) |
| System | `health_check` (always registered) |

Module-gated groups are dynamically added/removed by `moduleStatus.ts` (`SERVICE_MODULES` row-count thresholds). FHIR Servers and System tools are always registered.

**`crud_fhir_server` is the only tool that can write.** It relays create/update/patch/delete to an *external* FHIR server, and only when that server's allow-list permits the operation and the caller passes `confirm_write=true`. Every other tool is read-only.

### Data loaders
`node-server/src/loaders/` — one module per dataset, invoked by the admin worker.
- File-based imports (ICD / LOINC / SNOMED / RxNorm / FHIR IG) consume source files **uploaded via the admin console**, staged through MinIO; API-based imports (drug / health-supplements / food-nutrition) fetch from upstream APIs.
- For local development the source-file locations fall back to `fhir-code/` and can each be overridden by env (`FHIR_CODE_DIR`, `ICD_CM_ZIP`, `LOINC_ZIP_PATH`, `SNOMED_ZIP`, `RXNORM_ZIP`, `IG_TGZ`, …). `fhir-code/` is **not in git** — see `docs/data-sources/test-data.md`. `config/datasets.yaml` is a Python-era leftover and is read by **no code**.
- Drug pipeline: `drugIndex.ts` (the TFDA `36_2.csv` license index) → `drugEnrichment.ts` (TFDA crawl → MinIO) → `drugAnalysis.ts` (insert PDF → MinerU OCR → Analysis LM). Shared: `tfdaCrawler.ts`, `tfdaParserUtils.ts`, `drugRecordBuilder.ts`.
- Embedding stage (`embeddings.ts`) backfills `*_embeddings` vector tables as separate `*_embed` jobs.

### Admin console & background worker
- **`admin/adminApp.ts`** is the session-authenticated admin backend mounted at `/admin/api/*`. Feature modules: `adminSources.ts` (uploads + source roles), `adminJobs.ts` (import jobs + all job handlers), `adminJobStaging.ts` (staging/promote), `adminSchedule.ts` (cron schedules), `adminServices.ts` (module/service probes), `adminSettings.ts` + `llmProfiles.ts` (DB-backed settings & model endpoints), `adminMaintenance.ts` (per-module maintenance mode), `adminDrug.ts` (drug pipeline control), `adminIg.ts` (FHIR IG gallery/import), `adminPreview.ts`, `adminEmbedding.ts`, `adminWs.ts` (WebSocket live logs), `webauthn.ts` (passkeys), `ocrProbe.ts`.
- **`admin/adminWorker.ts`** is a standalone process (the `admin-worker` compose service). It claims queued jobs from `admin.import_jobs`, runs the loaders, writes `admin.import_job_steps` / `admin.import_job_logs`, honors checkpoint-based pause/cancel via `admin.job_control_requests`, and emits `admin.worker_heartbeats`. `ADMIN_MAX_CONCURRENT_JOBS` (default 4) bounds parallelism, with per-module resource slots.
- **Drug auto-chain**: `drug_index_import` → `drug_enrichment` → `drug_analysis` chain automatically, each auto-chained job capped at `DRUG_AUTOCHAIN_BATCH_LIMIT` (default 200) licenses and re-chaining from its own completion. **The cap only applies to auto-chained jobs** — a manually queued `drug_enrichment` with no `limit` will crawl the entire backlog (tens of thousands of TFDA requests).
- **`llm_unavailable` pause is self-healing**: a job paused because every Analysis LM profile failed is re-claimed automatically once `admin.import_jobs.next_retry_at` passes (backoff doubles per attempt, 2min → 30min cap); manual resume overrides the backoff. A `paused` job whose `last_error_code != 'llm_unavailable'` (or that a human paused) is **never** auto-resumed. Per-call LM timeouts default to 600s with 3 transport retries; override per profile via `llm_profiles.params.timeout_ms`.
- **`web/admin-app/`** is the React SPA admin UI, mounted client-side under the Next.js `/admin` catch-all route; `web/middleware.ts` gates `/admin/*` on the `tw_health_admin_session` cookie. (The old `admin-ui/` directory is a dead leftover — nothing builds it.)
- **`dbHealth.ts`** is a central DB-health gate: when Postgres is unreachable it locks mutating operations and surfaces an overlay in the UI.

### Cross-cutting concerns
- **`audit.query_log`** — the table exists in `db/schema.sql` (SHA-256(params), tool name, duration, status — raw parameter values are never stored, for HIPAA), but **the Node backend does not write to it**: nothing under `node-server/src/` references `audit.query_log`. The writer was not carried over in the Python→Node port. Treat per-tool audit logging as unimplemented, not as something to read from.
- **`cache.ts`** — `cached(ttl, prefix)` is a Redis-backed, fail-open memoizer (cache error → the function just executes) that records hit/miss metrics. It is **currently unused** — no service or tool calls it, so every tool call hits Postgres. Elsewhere Redis is only `ping`ed for health (`mcp.ts`, `adminServices.ts`, `adminOverview.ts`). Wrapping a hot read path in `cached()` is the intended way to add caching.
- **`moduleStatus.ts`** — queries each schema's row count against a minimum threshold and adds/removes tools accordingly, refreshed on `tools/list`.
- **`embeddingService.ts`** — embeddings for semantic / hybrid search; fails open to keyword-only when unavailable. Profiles come from `admin.llm_profiles`, with failover across enabled profiles.
- **`searchQuality.ts`** — decides when a hybrid search has degraded (embedding provider returned nothing, or the module's `*_embeddings` table is empty) and stamps `search_mode: "keyword_only"` on the response so the calling LLM knows results are literal matches. Any new hybrid-search tool should go through it rather than silently returning BM25 hits.
- **`publicToolsSecurity.ts`** — bearer/CORS policy for the public `/mcp` + `/tools/*` surface (see "HTTP surface" above).
- **`fhirValidator.ts` / `fhirTerminology.ts` / `fhirSnapshot.ts` / `fhirReference.ts` / `fhirAuthoring.ts`** — in-process FHIR R4 profile snapshot generation, terminology validation, reference resolution, and skeleton-fill authoring used by the FHIR IG tools.
- **`metrics.ts`** — Prometheus counters/histograms.
- **`logger.ts`** — structured JSON logging to stderr (never stdout, which belongs to the MCP stdio transport). Level via `LOG_LEVEL`.
- **`db.ts`** — `pg` pool singleton; unnamed prepared statements to stay pgBouncer-transaction-mode safe.

### PostgreSQL schemas
`audit` | `admin` | `icd` | `drug` | `health_supplements` | `food_nutrition` | `loinc` | `fhir` (multi-IG: `ig_packages` / `codesystems` / `concepts` / `artifacts`, package-scoped) | `snomed` | `rxnorm`

Full schema: `db/schema.sql` — auto-applied by the PostgreSQL container **only on first init** (empty data volume). Incremental changes live in `db/migrations/`, named `YYYYMMDD_description.sql`. There is **no migration runner**: nothing in the code applies them, and they are not tracked in a versions table. On an existing database they must be applied by hand, in filename-date order. A new migration must therefore also be folded into `db/schema.sql` so fresh installs get it.

## Settings precedence (important)

Bootstrap variables (DB / Redis / MCP transport / `ADMIN_*` auth / `WEB_PORT`) live only in `.env`.

Infrastructure settings (MinIO, TFDA base URL, worker tuning) are **seed-only** in `.env`: read once on first boot to seed `admin.app_settings`, then managed (and hot-reloaded) from the admin console → Settings tab. Editing those `.env` keys has no effect on an already-seeded database.

Model endpoints (embedding, Analysis LM, OCR) are **never** read from env. They live only in `admin.llm_profiles`, configured in the admin console; use Settings → Export/Import to move a working configuration between installs.

## Adding a New Service

1. Create `node-server/src/<name>Service.ts` — class with a `pg.Pool` constructor arg and `async initialize()`.
2. Instantiate it in `server.ts`'s startup sequence (wrap in try/catch so a failure degrades gracefully).
3. Register its tools in `mcp.ts` (input schemas with `zod`) and add them to the right tool group.
4. For module-gated availability, add an entry to `SERVICE_MODULES` in `moduleStatus.ts` and guard each tool with an availability check.

## Coding style & conventions

- TypeScript with ESM (`"type": "module"`) in both `node-server/` and `web/` — relative
  imports must carry the `.js` extension even though the source is `.ts`.
- Files: camelCase (`drugService.ts`, `adminJobs.ts`); types/classes: PascalCase. Annotate
  parameter and return types on public functions; avoid `any`.
- New service files follow `node-server/src/<domain>Service.ts` (see "Adding a New
  Service" above); MCP tool input schemas are defined with `zod`.
- Log through `logger.ts` (structured JSON to **stderr**, never stdout — stdout is
  reserved for the MCP stdio transport).
- Code and comments in English (see `## Language` above for chat responses).
- Branches: `feature/short-name` or `bugfix/issue-summary`. Commits follow Conventional
  Commits (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`), short and specific subjects.

## Testing

Node's built-in test runner via `tsx` (`node --import tsx --test`), not Jest/Vitest.
Test files live beside the code they cover (`node-server/src/**/*.test.ts`). Coverage is
currently thin (~10 files) — most of the Python→Node migration was verified by
differential runs against the old implementation rather than by unit tests. Add tests for
new tools and loaders. `web/` has no test suite (`typecheck` only).

Tests are pure unit tests: no Postgres, Redis or MinIO is started for them, so anything
new must be written against injected/faked collaborators rather than a live pool.

**CI does not run tests.** The only GitHub Actions workflow is `deploy-docs.yml`, which
builds and publishes MkDocs on pushes to `main` that touch `docs/` or `mkdocs.yml`.
Nothing gates a merge on `npm test` / `npm run typecheck` — run both locally
(in `node-server/` *and* `web/`) before committing.

## Sync correctness rule

Bulk imports follow this pattern to prevent partial-state corruption:
1. **Fetch all data first** (outside the DB transaction, full network phase)
2. **Then write atomically** (one transaction: `TRUNCATE`/`UPSERT`)
3. **Deduplicate source data** before insert — TFDA Open Data occasionally has duplicate primary keys (e.g. duplicate `license_id`).

Never interleave HTTP fetches with DB writes inside a transaction.

## Key Limitations

- **Health supplements disease mappings** are developer-curated and not medically validated — not suitable for patient-facing use without expert review
- **FHIR validation** is in-process and profile-driven (snapshot + terminology binding checks); it is not a substitute for the official HL7 FHIR Validator for conformance certification
- **SNOMED CT** requires an active SNOMED International license (free for most uses)
- **Drug analysis** (MinerU OCR + LLM extraction of TFDA inserts) is machine-generated and must be verified by a clinician; it depends on external OCR/LLM endpoints being configured
- **Embeddings** require a reachable embedding endpoint; without it, search degrades to keyword-only and a `keyword_only` signal is returned
- **Chinese keyword search without embeddings finds almost nothing** — Postgres' `simple` tokenizer treats a whole Chinese product name as one token. Vectors are the intended path; this is by design, not a bug to patch with `ILIKE`
- **pgBouncer transaction mode** is incompatible with `LISTEN/NOTIFY` and named prepared statements
