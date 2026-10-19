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

## Project Overview

> **Backend runtime — READ FIRST.** The backend is **100% Node.js / TypeScript**, under
> `node-server/`. There is **no Python in the backend** — `src/*.py`, `loader/` and
> `requirements.txt` were deleted when the drug pipeline was ported in 2026-07. The
> **only** Python in the repository is `services/ocr-indra/` — a separate, optional OCR
> container (Indra OCR on CPU, FastAPI) that the backend calls over HTTP like MinerU; it
> is not backend code and nothing in `node-server/` imports or spawns it. Two compose services run from `node-server/`: `app` (`node dist/server.js` —
> MCP + admin REST) and `admin-worker` (`node dist/admin/adminWorker.js` — every job
> type, including the three drug stages). The admin front end is the `web-v2` service
> (static Vite + React + Mantine SPA from `web-v2/`, served by its own nginx container).
> OCR is an HTTP service, never an in-process model: provider `mineru` (external
> **MinerU**, the default) or `indra` (the bundled `ocr-indra` container), with an
> optional fallback provider — admin → 外部服務 → OCR, adapters in
> `node-server/src/ocrProviders.ts`. Make backend changes in `node-server/src/`, admin UI changes in `web-v2/src/`.
>
> The only remaining thing under `src/` is `src/prompts/` — the Analysis-LM system
> prompt, read at runtime by `drugAnalysisService.ts`. Do not delete it.
>
> **Dead files that look live — do not edit, do not "fix":** root `pyproject.toml`,
> `pytest.ini`, `requirements-dev.txt` (Python-era leftovers; `requirements-docs.txt`
> is the live one — `deploy-docs.yml` installs from it, so any plugin enabled in
> `mkdocs.yml` must be listed there or the build fails), root `admin-ui/` (old Vite
> SPA — the real admin UI is `web-v2/`), and `config/datasets.yaml` (read by no code).
> `web/` (the Next.js admin incl. `web/admin-app/`) is **legacy**: replaced by `web-v2/`
> on 2026-10-17, its compose service is in profile `legacy-web` (not started) and kept
> only for rollback — do not add features there.

Taiwan Health MCP Server — a Model Context Protocol server (Node MCP SDK,
`@modelcontextprotocol/sdk`) exposing **63 tools** across 12 tool groups for Taiwan
medical and health data. Designed for production SaaS deployment with hundreds of
requests/second throughput.

**Modules**: ICD-10-CM (complete CMS code set — the "Code Descriptions in Tabular Order" file, 2026-04-01 edition in production, incl. 7th characters) / ICD-10-PCS, optional WHO ICD-10, LOINC 2.80 (incl. answer / part / answer-list / panel / MapTo tables), SNOMED CT International (incl. inactive content and historical associations), Taiwan FDA (TFDA) drugs, Taiwan FDA health supplements, Taiwan FDA food nutrition, FHIR R4 IG authoring (multi-IG, default TWCore v1.0.0), FHIR Condition/Medication generation, and an external FHIR server registry. RxNorm is loaded as concept-only reference terminology (used for IG ValueSet expansion, not a standalone drug tool).

Three surfaces ship in one codebase:
- **MCP server** (`node-server/src/server.ts` + `mcp.ts`) — the tool surface consumed by LLM clients (also exposes the admin REST API, `/admin/ws`, `/mcp`, `/openapi.json`, `POST /tools/<name>`).
- **Admin console** (`node-server/src/admin/*.ts` backend + the `web-v2/` SPA) — an operator UI for uploading source files, running/scheduling data imports, browsing terminologies, configuring model endpoints (provider accounts + routes) and external services, managing FHIR IGs and external FHIR servers, the MCP tool catalog + playground, backups / settings export, and monitoring jobs. On by default (`ADMIN_ENABLED=true`) — it is the only way to import data; set it false after loading to shrink a public deployment's attack surface.
- **Admin front end** (`web-v2/`, compose service `web-v2`) — Vite 7 + React 19 + Mantine 8 static SPA under `/admin/`, served by the container's own nginx (which can also proxy the backend via `BACKEND_UPSTREAM`, so on staging it is the front door by itself). Root nginx (`nginx/nginx.conf`) is the single production front door: it routes API/MCP/WebSocket to `app` and `/admin` + everything else to `web-v2:80`. The old Next.js `web/` service is in compose profile `legacy-web` (not started). The public landing/status/privacy/dpa pages were removed from this repo and now live in a standalone marketing-site project; `nginx.conf` carries a TODO for the 301 redirects.

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
npm test                                      # node --import tsx --test 'src/**/*.test.ts' (node expands the glob: any depth)
npm run dev                                   # tsx watch src/server.ts (no build step)

# Run a single test file (npm test has no path passthrough — call node directly):
node --import tsx --test src/loaders/loinc.test.ts
# Run a single test case by name (matches the string passed to `test(...)`):
node --import tsx --test --test-name-pattern "padded headers" src/loaders/loinc.test.ts

# Run the MCP/admin server locally (HTTP mode):
DATABASE_URL=postgresql://... node dist/server.js

# --- Admin SPA (web-v2: Vite + React + Mantine) ----------------------------
cd web-v2
npm install
npm run dev                                   # vite on :5173/admin/, proxies the API to ADMIN_BACKEND (default http://127.0.0.1:8090 = staging)
ADMIN_BACKEND=http://127.0.0.1:8080 npm run dev   # point it at another backend
npm run build                                 # tsc -b && vite build -> dist/
npm run typecheck                             # tsc -b --noEmit (no web-v2 test suite)

# --- Docker (production — recommended) -------------------------------------
cp .env.example .env                          # then edit .env (set POSTGRES_PASSWORD, ADMIN_*)
docker compose up -d                          # nginx (:8080), web-v2, app, admin-worker, postgres, pgbouncer, redis, minio (+ minio-init), ocr-indra
docker compose build app web-v2 && docker compose up -d --no-deps app web-v2   # redeploy after code changes
# health_check reports `build` from the BUILD_SHA build arg (the worker logs it at startup).
# compose.yaml passes ${BUILD_SHA:-dev} to app and admin-worker, so set it in the environment:
#   BUILD_SHA=$(git rev-parse --short HEAD) docker compose build app admin-worker
# Before redeploying production, tag the running images (e.g. `:rollback-pre-<change>`)
# so a bad deploy can be rolled back by re-tagging; root nginx.conf is a single-file
# bind mount — after editing it run `docker compose exec nginx nginx -s reload`.
# The legacy Next.js admin (rollback only): docker compose --profile legacy-web up -d web

# `admin-worker` is a SEPARATE image (Dockerfile.worker) built from the same
# node-server/ source. Any change to job/loader code (adminJobs.ts, *Service.ts,
# loaders/*) must be deployed to it too — rebuilding only `app` leaves the
# worker executing stale code with no error:
docker compose build admin-worker && docker compose up -d --no-deps admin-worker

# ocr-indra (services/ocr-indra, the only Python; model weights baked in at build time):
docker compose build ocr-indra && docker compose up -d --no-deps ocr-indra
docker run --rm --network none taiwan-health-mcp-ocr-indra python -m unittest discover -s tests

# --- Staging (isolated stack, compose project twh-staging) ----------------
# Needs an untracked deploy/staging/.env with STAGING_DB_PASSWORD,
# STAGING_MINIO_PASSWORD and STAGING_RESTORE_DIR (host dir mounted at /restore in
# Postgres; compose refuses to start without any of them); app/worker also
# read the root .env. Front door: http://<host>:${STAGING_PORT:-8090}/admin/ (its web-v2
# container proxies the backend). Uses its own cookie name
# (ADMIN_SESSION_COOKIE=tw_health_admin_session_staging) because cookies are per host,
# not per port, and production on the same host sets a Secure cookie of the default name.
BUILD_SHA=$(git rev-parse --short HEAD) docker compose -p twh-staging -f deploy/staging/compose.yaml up -d --build

# Data loading is done through the admin console (module pages) and executed by
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
| nginx | Single front door on `${WEB_PORT:-8080}`; routes `/mcp`, `/openapi.json`, `/tools/*`, `/admin/api/*`, `/admin/ws`, `/fhir-client/*`, `/fhir-oauth/*` to `app`, `/admin` and everything else to `web-v2` |
| web-v2 | nginx serving the static admin SPA (`web-v2/dist`) |
| PostgreSQL 16 (`pgvector/pgvector:pg16`) | Primary data store + `vector` columns for semantic search |
| pgBouncer | Connection pooler (transaction mode, 500 client → 30 PG connections) |
| Redis 7 | Pub/sub relay for admin live events (`adminWs.ts`: worker + app `broadcast()` → `/admin/ws`) and health pings, but **no tool response is cached today** — `cached()` in `cache.ts` has zero call sites (see "Cross-cutting concerns") |
| MinIO | Object storage for admin source uploads and drug assets (inserts, labels, pill images); presigned download links |
| Embedding endpoint (external) | Semantic / hybrid search vectors (default Ollama `qwen3-embedding`). Configured as the **embedding** role's route (provider accounts + routes, admin → 模型端點), **not** env. Unavailable → keyword-only fallback |
| MinerU (external) | Default OCR provider for drug insert PDFs (`POST /file_parse`). Configured in admin → 外部服務 → OCR (`admin.app_settings` group `ocr`) |
| ocr-indra | Optional CPU OCR provider (`services/ocr-indra/`, Indra OCR, `POST /ocr`, `GET /health`) at `http://ocr-indra:8000`. On the compose network `ocr` (`internal: true` — no route out; `app` + `admin-worker` also join it), no host port, 2 CPU / 2 GB. Used only when the `ocr` group's `provider` or `fallback_provider` is `indra`. Model weights are modified-OpenRAIL-M (commercial restrictions) — see its README |
| Analysis LM (external) | Drug insert extraction. Configured as the **analysis** role's route (admin → 模型端點) |
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
| Drug Analysis Service | `drugAnalysisService.ts` | `drug.insert_analysis` | OCR (`ocrProviders.ts`: MinerU / Indra + fallback) + Analysis-LM stage |
| Supplements Service | `supplementsService.ts` | `health_supplements.items` | `health_supplements_sync` (TFDA Open Data) |
| Food Service | `foodService.ts` | `food_nutrition.*` | `food_nutrition_sync` (TFDA Open Data) |
| Lab Service | `labService.ts` | `loinc.*` | `loinc_import` |
| FHIR Condition Service | `fhirConditionService.ts` | reads `icd.*` | — (derives from ICD) |
| FHIR Medication Service | `fhirMedicationService.ts` | reads drug service | — (derives from Drug) |
| FHIR IG Service | `fhirIgService.ts` | `fhir.*` (multi-IG, package-scoped) | `ig_import` + admin IG gallery |
| IG Concept Search | `conceptSearch/` (`service.ts`, `engine.ts`, `indexBuilder.ts`, `assemble.ts`, `thesaurus.ts`, `text.ts`) | `fhir.concept_index_*`, `fhir.concept_embeddings`, `fhir.term_thesaurus`, `fhir.codesystem_supplements`, optional `fhir.umls_terms` | `ig_import` / `ig_concept_index` / `ig_embed` / `umls_import` |
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
| FHIR IG | `fhir_list_igs`, `fhir_get_ig`, `fhir_list_artifacts`, `fhir_search_artifacts`, `fhir_list_resource_profiles`, `fhir_rank_resource_profiles`, `fhir_get_profile`, `fhir_get_profile_elements`, `fhir_get_profile_required_elements`, `fhir_get_valueset`, `fhir_expand_valueset`, `fhir_lookup_code`, `fhir_validate_code`, `fhir_normalize_code`, `fhir_resolve_reference`, `fhir_build_bundle`, `fhir_validate_resource`, `fhir_validate_bundle`, `fhir_get_resource_skeleton`, `fhir_finalize_resource`, `fhir_check_grounding`, `fhir_check_completeness` |
| Health Supplements | `search_health_supplements` |
| Food Nutrition | `query_food_nutrition`, `query_food_ingredient`, `search_foods_by_nutrient`, `analyze_meal_nutrition` |
| FHIR Servers | `list_fhir_servers`, `get_fhir_server_status`, `crud_fhir_server` (always registered) |
| Clinical Calculators | `calculate_chads2_vasc`, `calculate_wells_pe`, `calculate_wells_dvt`, `calculate_das28`, `calculate_cdai`, `calculate_bmi`, `calculate_egfr`, `calculate_has_bled`, `calculate_curb65`, `calculate_qsofa`, `calculate_gcs` (always registered, stateless) |
| System | `health_check` (always registered; reports `version` (`SERVER_VERSION`), `build` (`BUILD_SHA`), `tools_version`, `lexicon_version` / `lexicon_sha256`, loaded `terminology` editions, `ig_packages`, `default_ig`) |

Module-gated groups are dynamically added/removed by `moduleStatus.ts` (`REQUIREMENTS` / `MODULE_REQUIREMENTS` row-count thresholds). FHIR Servers, Clinical Calculators and System tools are always registered. So `/openapi.json` lists fewer than 63 when a module is empty (production on 2026-10-17: 58 — health supplements and food nutrition not loaded). The admin **MCP 工具** page (`/admin/mcp`, API `/admin/api/mcp/*`) lists every tool in `mcp.ts`, registered or not and why, and has a playground that invokes a registered tool exactly like `POST /tools/<name>`.

**`crud_fhir_server` is the only tool that can write.** It relays create/update/patch/delete to an *external* FHIR server, and only when that server's allow-list permits the operation and the caller passes `confirm_write=true`. Every other tool is read-only.

### Data loaders
`node-server/src/loaders/` — one module per dataset, invoked by the admin worker.
- File-based imports (ICD / LOINC / SNOMED / RxNorm / FHIR IG) consume source files **uploaded via the admin console**, staged through MinIO; API-based imports (drug / health-supplements / food-nutrition) fetch from upstream APIs.
- For local development the source-file locations fall back to `fhir-code/` and can each be overridden by env (`FHIR_CODE_DIR`, `ICD_CM_ZIP`, `LOINC_ZIP_PATH`, `SNOMED_ZIP`, `RXNORM_ZIP`, `IG_TGZ`, …). `fhir-code/` is **not in git** — see `docs/data-sources/test-data.md`. `config/datasets.yaml` is a Python-era leftover and is read by **no code**.
- ICD-10-CM (`icd.ts`) accepts the CMS "Code Descriptions in Tabular Order" zip (`icd10cm_order_<FY>.txt`, `source_format = cms-order`) or the older tabular XML zip; only an order file with ≥ 90,000 rows (headers + 7th characters) is recorded as `complete` in `icd.editions`, and the FHIR validator reports ICD-10-CM "Unknown code" errors only against a complete edition. WHO ICD-10 (`icd.icd10_who`, source role `icd10_who`) is optional. LOINC (`loinc.ts`) also loads the AccessoryFiles: answer / part / answer-list / group codes (`loinc.other_codes`), part links, answer lists, panels and MapTo. SNOMED (`snomed.ts`) keeps inactive concepts / descriptions, `first_released` dates and historical associations.
- Drug pipeline: `drugIndex.ts` (the TFDA `36_2.csv` license index) → `drugEnrichment.ts` (TFDA crawl → MinIO) → `drugAnalysis.ts` (insert PDF → OCR → Analysis LM). OCR goes through `ocrProviders.ts` (`runOcr`: primary provider, then the optional `fallback_provider` once unless the input itself is unreadable); `drug.insert_analysis.ocr_provider` records the provider that answered. Shared: `tfdaCrawler.ts`, `tfdaParserUtils.ts`, `drugRecordBuilder.ts`.
- Embedding stage (`embeddings.ts`) backfills `*_embeddings` vector tables as separate `*_embed` jobs (`ig_embed` → `fhir.concept_embeddings`, content-addressed by sha256 of the name, exact scan only — no HNSW).
- **Bundled reference data** (`node-server/data/`, ~2.6 MB, tracked): CodeSystem supplements (`data/supplements/*.json.gz` — NHI payment English names / LOINC links / claim volume, NHI drug names + ATC, all for TW Core) and the SPECIALIST LRABR abbreviation lexicon (`data/abbreviations/lrabr-<release>.tsv.gz`). `conceptSearch/bundled.ts` applies them before every concept-index build (`ig_import` + `ig_concept_index`): supplements whose target CodeSystem is installed go into `fhir.codesystem_supplements` as `uploaded_by = 'system:bundled'` (idempotent; never overwrites an operator's other version; an admin deletion is an opt-out in `admin.app_settings` group `bundled_supplements`, restorable in the UI); the lexicon loads only while `fhir.abbreviation_lexicon` is empty. Both images COPY the dir (resolved as `dist/../data`, override `BUNDLED_DATA_DIR`) — a new runtime data file needs no Dockerfile change, but a new data *directory* outside `node-server/data/` does. Sources / licences / regeneration: `node-server/data/README.md`; generators (TS, tsx): `node-server/scripts/supplements/`.
- UMLS (`umls.ts`, optional, needs a UMLS licence): streams `MRCONSO.RRF` / `MRSAB.RRF` out of the Metathesaurus zip (ZIP64, no extraction) or reads the compact subset it writes (`node dist/loaders/umls.js --subset <zip> <out.rrf.gz>`, ~36 MB — upload that, not the 4 GB zip); SABs = SRL 0 + SNOMEDCT_US minus non-clinical sources (`EXCLUDED_SABS`). Source role `ig/umls_metathesaurus`, job `umls_import`.

### Admin console & background worker
- **`admin/adminApp.ts`** is the session-authenticated admin backend mounted at `/admin/api/*`. Feature modules: `adminSources.ts` (uploads + source roles), `adminJobs.ts` (import jobs + all job handlers), `adminJobStaging.ts` (staging/promote), `adminSchedule.ts` (cron schedules), `adminServices.ts` (module/service probes), `adminSettings.ts` (DB-backed settings, settings export/import — format version 3), `adminLlmApi.ts` + `llmRouting.ts` + `llmProfiles.ts` (model endpoints: provider accounts and routes), `chatgptOAuth.ts` (ChatGPT sign-in), `embeddingIdentity.ts` (embedding fingerprint + guarded model switch), `llmCallLog.ts` / `llmProfileStats.ts`, `adminMaintenance.ts` (per-module maintenance mode — gates that module's MCP tools, see "Cross-cutting concerns"), `adminDrug.ts` (drug pipeline control), `adminIg.ts` + `igDependencies.ts` / `igOrigin.ts` / `igRemoval.ts` (FHIR IG gallery/import, missing-dependency download, `install_origin`, deletion protection), `adminMcp.ts` + `adminMcpDeps.ts` + `mcpToolExamples.ts` (`/admin/api/mcp/*`: overview, tool catalog, playground invoke), `termViz/` (`/admin/api/terminology/*`: ICD-10-CM / WHO tree, PCS axes, SNOMED graph, LOINC axes, RxNorm, IG CodeSystem tree), `adminDrugExplorer.ts`, `adminFhirServers.ts` + `fhirOauthService.ts`, `adminBackup.ts`, `adminModuleClear.ts`, `adminOverview.ts`, `adminPreview.ts`, `adminEmbedding.ts`, `adminWs.ts` (WebSocket live logs), `webauthn.ts` (passkeys), `ocrProbe.ts`.
- **`admin/adminWorker.ts`** is a standalone process (the `admin-worker` compose service). It claims queued jobs from `admin.import_jobs`, runs the loaders, writes `admin.import_job_steps` / `admin.import_job_logs`, honors checkpoint-based pause/cancel via `admin.job_control_requests`, and emits `admin.worker_heartbeats`. `ADMIN_MAX_CONCURRENT_JOBS` (default 4) bounds parallelism, with per-module resource slots.
- **Drug auto-chain**: `drug_index_import` → `drug_enrichment` → `drug_analysis` chain automatically, each auto-chained job capped at `DRUG_AUTOCHAIN_BATCH_LIMIT` (default 200) licenses and re-chaining from its own completion. **The cap only applies to auto-chained jobs** — a manually queued `drug_enrichment` with no `limit` will crawl the entire backlog (tens of thousands of TFDA requests).
- **`llm_unavailable` pause is self-healing**: a job paused because every member of the analysis route failed is re-claimed automatically once `admin.import_jobs.next_retry_at` passes (backoff doubles per attempt, 2min → 30min cap); manual resume overrides the backoff. A `paused` job whose `last_error_code != 'llm_unavailable'` (or that a human paused) is **never** auto-resumed. Per-call LM timeouts default to 600s with 3 transport retries; override per route member via its `params.timeout_ms` (an analysis member knob, `llmRouting.ts`).
- **Model endpoints** (migration `20261016`): `admin.llm_providers` (provider accounts — several per provider type; `api_key`, `oauth` or `none` auth), `admin.llm_routes` (named profiles: a strategy `single` / `fallback` / `round_robin` / `load_balance` over members), `admin.llm_route_members` (a member is a model on an account **or** another route — routes nest), `admin.llm_role_routes` (which route the `analysis` / `embedding` role uses). The old `admin.llm_profiles` table was renamed `admin.llm_profiles_legacy`. Provider adapters live in `node-server/src/providers/` (24 in `registry.ts`, incl. `chatgpt` sign-in; legacy ids `vllm` / `google` / `azure` / `claude` are aliased). Embedding identity: `admin.embedding_identity` / `admin.embedding_fingerprints` (created at runtime by `embeddingIdentity.ts`, not in `db/schema.sql`) — an endpoint may join the embedding route only if it reproduces the stored probe vectors (cosine ≥ 0.95); switching models re-indexes in a guarded order (role off → stop embed jobs → wipe vectors → adopt identity → re-queue).
- **`web-v2/`** is the admin SPA (Vite + React + Mantine; routes under `/admin/`, sidebar in `web-v2/src/layout/nav.ts`: 儀表板, 背景工作, 醫療術語, 藥品, 健康食品, 食品營養, IG 套件庫, FHIR 伺服器, 模型端點, MCP 工具, 外部服務, 服務健康, 備份與設定, 帳號安全). Auth is the backend session cookie (`tw_health_admin_session`, overridable via `ADMIN_SESSION_COOKIE`); a 401 from any API call sends the SPA to its login page. It has no test suite. (`web/` + `web/admin-app/` is the legacy Next.js admin, `admin-ui/` an even older dead leftover.)
- **`dbHealth.ts`** is a central DB-health gate: when Postgres is unreachable it locks mutating operations and surfaces an overlay in the UI.

### Cross-cutting concerns
- **`audit.query_log`** — the table exists in `db/schema.sql` (SHA-256(params), tool name, duration, status — raw parameter values are never stored, for HIPAA), but **the Node backend does not write to it**: nothing under `node-server/src/` references `audit.query_log`. The writer was not carried over in the Python→Node port. Treat per-tool audit logging as unimplemented, not as something to read from.
- **`cache.ts`** — `cached(ttl, prefix)` is a Redis-backed, fail-open memoizer (cache error → the function just executes) that records hit/miss metrics. It is **currently unused** — no service or tool calls it, so every tool call hits Postgres. Elsewhere Redis carries the admin WebSocket pub/sub relay (`adminWs.ts`) and is `ping`ed for health (`mcp.ts`, `adminServices.ts`, `adminOverview.ts`). Wrapping a hot read path in `cached()` is the intended way to add caching.
- **Maintenance gate** (`withMaintenanceGate` in `mcp.ts`, composed inside `withToolMetrics` at the single dispatch point, so `/mcp`, `POST /tools/<name>` and the admin playground are all covered) — while a module is in maintenance (`admin/adminMaintenance.ts` `getStates`, 5 s cache) its tools return an `isError` result with `error.code = "MODULE_MAINTENANCE"` (en `message` + zh-TW `message_zh`) without running. Group → module map: `GROUP_MAINTENANCE_MODULE` (ICD + FHIR Condition → `icd`, Drug + FHIR Medication → `drug`, Lab → `loinc`, SNOMED → `snomed`, FHIR IG → `ig`; `rxnorm` gates no tool; always-on and TFDA Open Data groups are never gated). `tools/list` is deliberately unchanged (no tool-list churn); a failing state lookup fails open.
- **`moduleStatus.ts`** — queries each schema's row count against a minimum threshold and adds/removes tools accordingly, refreshed on `tools/list`.
- **`embeddingService.ts`** — embeddings for semantic / hybrid search; fails open to keyword-only when unavailable. The endpoint is the embedding role's route (`admin.llm_role_routes` → `llm_routes`), so failover / round-robin / load-balance follow that route's strategy.
- **IG concept search** (`conceptSearch/`, docs `docs/modules/ig-concept-search.md`) — free text → codes of any installed IG CodeSystem, used by `fhir_normalize_code` (IG targets) and `search_medical_codes(system=…)`. Index built per CodeSystem from the raw CodeSystem JSON (all designation languages — `fhir.concepts` keeps display only), merged CodeSystem supplements (`content=supplement`, uploaded via `/admin/api/igs/supplements` or shipped in packages), names borrowed through Coding properties / IG ConceptMaps, and optional UMLS CUI synonyms (kind `umls`, match-only). Query side: normalisation + clinical-noise stripping, data-derived abbreviation / zh↔en thesaurus (`fhir.term_thesaurus`: SNOMED / LOINC / IG-name acronyms, mined bilingual pairs, the grounding lexicon), optional UMLS phrase synonyms, BM25-like lexical + exact-scan semantic fusion, `clauses` for multi-item text. **UMLS strings must never appear in tool output** (`matched_term` is always the IG's own name). Rebuilt by `ig_concept_index` (signature-skipped); vectors by `ig_embed` (CodeSystems ≤ 20k concepts).
- **`hybridRank.ts` + `terminologyRanking.ts`** — the hybrid ranking shared by `search_medical_codes` (ICD-10-CM), `search_loinc`, `search_snomed_concept` and the SNOMED / LOINC / ICD branches of `fhir_normalize_code`: candidate pool = full-text matches ∪ nearest vectors, ordered by score-aware fusion (lexical name coverage + pool-rescaled cosine + small priors: ICD code depth, LOINC `common_test_rank` / status, SNOMED inactive / name length), and the two nearest vectors always stay in the top-k. Not RRF — do not reintroduce rank-only fusion. The IG CodeSystem engine (`conceptSearch/`) has its own `fuse()`.
- **Query instructions** (`providers/queryInstruction.ts`) — search-query embeddings carry a per-module task instruction for instruction-aware models (Qwen3-Embedding: `Instruct: …\nQuery: …`); pass the `QueryTask` to `EmbeddingService.embed(text, task)`. Documents / stored vectors / identity probes are never instructed, so changing it needs no re-index. Per-member override: `params.query_instruction` (`off` / custom text).
- **`searchQuality.ts`** — decides when a hybrid search has degraded (embedding provider returned nothing, or the module's `*_embeddings` table is empty) and stamps `search_mode: "keyword_only"` on the response so the calling LLM knows results are literal matches. Any new hybrid-search tool should go through it rather than silently returning BM25 hits.
- **`grounding/` + `groundingTools.ts`** — deterministic record-faithfulness engines (no LLM): `fhir_check_grounding`, `fhir_check_completeness`, and the optional `source_text` grounding of `fhir_validate_bundle` / `fhir_validate_resource` (without it their output must stay byte-identical). Spec: `mcp_proposal/MCP_GROUNDING_SPEC.md` — `mcp_proposal/` is **private and untracked** (it holds clinical evaluation fixtures); never commit it or copy its data into docs. Acceptance gates: `node-server/scripts/grounding-acceptance/run_gates.py` (tracked, but needs those private fixtures and a deployed server — without them it exits 2 with "private CARVE fixtures not present"); the public unit tests are `node-server/src/grounding/*.test.ts` and `groundingTools.test.ts`. `source_text` is clinical data — never log it (only `sourceSha256`). Tool versions live in `toolVersions.ts`; bump one whenever its output for the same input changes. Test-only helpers (`grounding/testkit.ts`, `pas*.ts`, `grounding/scripts/`) are excluded from the build by `tsconfig.json`; `npm run typecheck` uses `tsconfig.dev.json` to still check them.
- **`fhirSuggestions/`** — additive fix-it layer for `fhir_validate_resource` / `fhir_validate_bundle` / `fhir_finalize_resource`: after the validator runs, each issue may get ranked `suggestions` (UCUM repairs, closest canonical / CodeSystem, rename / move property, allowed codes of the bound ValueSet, codes matching the display, valid displays) and reference-chain errors a `caused_by`. It dispatches on HL7-style message text, so new validator messages should keep validator_cli wording. Never changes the issue set, severities, messages or `valid`; fail-open; per-call budget for normalize / expand lookups. Eval: `node-server/scripts/suggestions-eval/`.
- **`publicToolsSecurity.ts`** — bearer/CORS policy for the public `/mcp` + `/tools/*` surface (see "HTTP surface" above).
- **`fhirValidator.ts` / `fhirTerminology.ts` / `fhirSnapshot.ts` / `fhirReference.ts` / `fhirAuthoring.ts`** (+ `fhirPath.ts`, `fhirRequiredElements.ts`, `fhirValidationResolver.ts`, `fhirCodeSystem.ts`, `fhirCvx.ts`, `fhirIso3166.ts`, `fhirUcum.ts`, `fhirExternalTerminology.ts`) — in-process FHIR R4 profile snapshot generation, terminology validation, reference resolution, and skeleton-fill authoring used by the FHIR IG tools. The validator's parity target is HL7 `validator_cli` 7.0.1 + tx.fhir.org (`|version` canonicals resolved like the HL7 validator; code-system "Unknown code" errors only when the local table is a complete edition, e.g. `icd.editions.complete`). The audit harness and rounds v1–v6 are in `node-server/scripts/validator-audit/` (`REPORT.md`).
- **IG version resolution** (`fhirIg.ts`): precedence is an explicit `|version` on a canonical → `package_id` / `version` → the package owning the `meta.profile` / canonical arguments → the default IG → the only manually-installed IG; otherwise `NO_DEFAULT_IG` (never an arbitrary package). Responses carry `provenance.resolved_by` / `closure_versions` and `data.deps_missing`.
- **`metrics.ts`** — Prometheus counters/histograms. `mcp_tool_requests_total{tool,status}` / `mcp_tool_duration_seconds{tool}` are recorded by `withToolMetrics` in `mcp.ts`, which wraps every registered handler (so MCP, `/tools/*` and the admin playground all count); labels are tool name + `success`/`error` only — never arguments.
- **`logger.ts`** — structured JSON logging to stderr (never stdout, which belongs to the MCP stdio transport). Level via `LOG_LEVEL`.
- **`db.ts`** — `pg` pool singleton; unnamed prepared statements to stay pgBouncer-transaction-mode safe.

### PostgreSQL schemas
`audit` | `admin` | `icd` | `drug` | `health_supplements` | `food_nutrition` | `loinc` | `fhir` (multi-IG: `ig_packages` / `codesystems` / `concepts` / `artifacts`, package-scoped) | `snomed` | `rxnorm`

Full schema: `db/schema.sql` — auto-applied by the PostgreSQL container **only on first init** (empty data volume). Incremental changes live in `db/migrations/`, named `YYYYMMDD_description.sql`. There is **no migration runner**: nothing in the code applies them, and they are not tracked in a versions table. On an existing database they must be applied by hand, in filename-date order. A new migration must therefore also be folded into `db/schema.sql` so fresh installs get it. Latest migrations: `20261015_llm_provider_registry` (data-only provider-id rewrite), `20261016_llm_providers_and_routes`, `20261017_icd10cm_complete_edition` (`icd.editions`, short titles, header flag), `20261018_terminology_completeness_v4` (LOINC LA/LP/LL/LG `other_codes`, SNOMED inactive content + `first_released` + editions, `icd.icd10_who`), `20261019_ig_install_origin`, `20261020_loinc_structure` (part links, answer lists, panels, MapTo), `20261021_embedding_identity`, `20261022_ig_concept_search` (IG concept-search index, term vectors, thesaurus, uploaded CodeSystem supplements), `20261023_umls_terms` (optional UMLS synonym store), `20261024_loinc_common_rank` (`loinc.concepts.common_test_rank` / `common_order_rank`, filled by the next LOINC import — a weak prior in `search_loinc` ranking), `20261025_loinc_component_names` (LOINC analyte synonyms), `20261026_loinc_axis_names` (`loinc.axis_names`: SYSTEM / TIME / METHOD / PROPERTY / SCALE vocabulary for query-axis matching, filled by the LOINC import), `20261027_abbreviation_lexicon` (`fhir.abbreviation_lexicon`: optional SPECIALIST LRABR abbreviations, loaded by `umls_import`, match-only), `20261028_snomed_concept_ancestors` (`snomed.concept_ancestors`: is-a ancestor arrays per concept, built from relationships by the migration and rebuilt on every SNOMED import — fast `hierarchy_filter` membership), `20261029_pg_prewarm` (`CREATE EXTENSION pg_prewarm`; with `shared_preload_libraries=pg_prewarm` + `pg_prewarm.autoprewarm` set via the postgres `command:` in compose, the buffer cache survives restarts, and `admin/prewarm.ts` loads the SNOMED search relations — HNSW index, FTS, ancestors — when the worker starts), `20261030_rxnorm_display_names` (`rxnorm.concepts.alt_names` + `rxnorm.editions`, filled by the next `rxnorm_import` — the validator checks RxNorm displays against them).

## Settings precedence (important)

Bootstrap variables (DB / Redis / MCP transport / `ADMIN_*` auth / `WEB_PORT`) live only in `.env`.

Infrastructure settings (MinIO, TFDA base URL, worker tuning) are **seed-only** in `.env`: read once on first boot to seed `admin.app_settings`, then managed (and hot-reloaded) from the admin console → 外部服務 (`/admin/integrations`). Editing those `.env` keys has no effect on an already-seeded database.

Model endpoints (embedding, Analysis LM, OCR) are **never** read from env. Embedding / Analysis LM live only in the provider-account + route tables (admin → 模型端點, `/admin/models`); the OCR server in `admin.app_settings` (admin → 外部服務). Use 備份與設定 (`/admin/system`) → settings Export/Import (format version 3; v1/v2 files still import) to move a working configuration between installs.

## Adding a New Service

1. Create `node-server/src/<name>Service.ts` — class with a `pg.Pool` constructor arg and `async initialize()`.
2. Instantiate it in `server.ts`'s startup sequence (wrap in try/catch so a failure degrades gracefully).
3. Register its tools in `mcp.ts` (input schemas with `zod`) and add them to the right tool group.
4. For module-gated availability, add an entry to `REQUIREMENTS` in `moduleStatus.ts` and guard each tool with an availability check.

## Coding style & conventions

- TypeScript with ESM (`"type": "module"`) in both `node-server/` and `web-v2/`. In
  `node-server/` relative imports must carry the `.js` extension even though the source
  is `.ts`; `web-v2/` uses Vite's bundler resolution (no extension, `@/` = `web-v2/src/`).
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
61 test files today — most of the Python→Node migration was verified by differential
runs against the old implementation rather than by unit tests. Add tests for new tools and
loaders. `web-v2/` has no test suite (`typecheck` + `build` only). A few tests read
fixtures from the private, untracked `mcp_proposal/` directory and are skipped when it is
absent.

Tests are pure unit tests: no Postgres, Redis or MinIO is started for them, so anything
new must be written against injected/faked collaborators rather than a live pool.

**CI does not run tests.** The only GitHub Actions workflow is `deploy-docs.yml`, which
builds and publishes MkDocs on pushes to `main` that touch `docs/`, `mkdocs.yml`, `requirements-docs.txt` or the workflow itself.
Nothing gates a merge on `npm test` / `npm run typecheck` — run them locally
(`node-server/`: test + typecheck; `web-v2/`: typecheck + build) before committing.

## Sync correctness rule

Bulk imports follow this pattern to prevent partial-state corruption:
1. **Fetch all data first** (outside the DB transaction, full network phase)
2. **Then write atomically** (one transaction: `TRUNCATE`/`UPSERT`)
3. **Deduplicate source data** before insert — TFDA Open Data occasionally has duplicate primary keys (e.g. duplicate `license_id`).

Never interleave HTTP fetches with DB writes inside a transaction.

## Key Limitations

- **Health supplements disease mappings** are developer-curated and not medically validated — not suitable for patient-facing use without expert review
- **Clinical calculators** implement published scoring formulas for decision support only — they are not a validated medical device, and every result carries a disclaimer. Any change to a formula, weight or cutoff must cite its source literature (see the References table in `docs/tools/clinical-calculator-tools.md`) and keep the input bounds in the `*InputShape` exports in step
- **FHIR validation** is in-process and profile-driven (snapshot + terminology binding checks); it is not a substitute for the official HL7 FHIR Validator for conformance certification
- **SNOMED CT** requires an active SNOMED International license (free for most uses)
- **Drug analysis** (MinerU / Indra OCR + LLM extraction of TFDA inserts) is machine-generated and must be verified by a clinician; it depends on external OCR/LLM endpoints being configured
- **Embeddings** require a reachable embedding endpoint; without it, search degrades to keyword-only and a `keyword_only` signal is returned
- **Chinese keyword search without embeddings finds almost nothing** — Postgres' `simple` tokenizer treats a whole Chinese product name as one token. Vectors are the intended path; this is by design, not a bug to patch with `ILIKE`
- **pgBouncer transaction mode** is incompatible with `LISTEN/NOTIFY` and named prepared statements
