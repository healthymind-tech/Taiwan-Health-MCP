# API Reference

The system exposes three interfaces, all served through the nginx front door (`:8080` by default).

## HTTP endpoint overview

| Endpoint | Method | Authentication | Description |
|----------|--------|----------------|-------------|
| `/mcp` | `POST` / `GET` / `DELETE` | Optional bearer | The MCP streamable-http endpoint (path set by `MCP_PATH`). |
| `/openapi.json` | `GET` | Optional bearer | An OpenAPI 3.1 spec generated dynamically from the **currently registered tools**. |
| `/tools/<tool_name>` | `POST` | Optional bearer | OpenAPI bridge: invoke a single tool with the arguments as a JSON body. |
| `/admin/api/*` | Varies | Session cookie | Admin console REST API (present only when `ADMIN_ENABLED=true`). |
| `/admin/ws` | WebSocket | Session cookie | Live job logs and progress. |
| `/fhir-client/<id>/jwks.json` | `GET` | None | Public JWKS for external FHIR OAuth clients. |
| `/fhir-oauth/callback` | `GET` | — | OAuth2 Authorization Code callback endpoint. |

`PUBLIC_TOOLS_AUTH_MODE=bearer` protects `/mcp`, `/openapi.json`, and `/tools/*` together. The token is set by `PUBLIC_TOOLS_BEARER_TOKEN`; cross-origin browser calls additionally require the origin to be listed in `PUBLIC_TOOLS_CORS_ORIGINS`. `none` is only suitable for trusted local or private networks.

> The backend also has a `/health` endpoint, but nginx does not proxy it (reaching it through the front door returns 404). To check from the front door whether `app` is alive, hit `/openapi.json` instead. Per-module row counts are on the admin console's dashboard; `health_check` (`POST /tools/health_check`) also reports module status, server version, build sha and loaded terminology editions.

## OpenAPI bridge

For clients that cannot speak MCP natively and only connect to OpenAPI tool servers (such as Open WebUI's External Tools).

```bash
# Fetch the current tool list
curl -H 'Authorization: Bearer <token>' http://localhost:8080/openapi.json

# Invoke a tool
curl -X POST http://localhost:8080/tools/search_medical_codes \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"keyword": "diabetes", "limit": 3}'
```

The tool list grows and shrinks with each module's data-load status (row-count thresholds in `REQUIREMENTS`, exported as `MODULE_REQUIREMENTS`, in `moduleStatus.ts`), so the content of `/openapi.json` differs according to the deployment's data state. `mcp.ts` defines **63 tools** in 12 groups; the FHIR Servers, Clinical Calculators and System groups (15 tools) are always registered. The admin console's **MCP tools** page (`/admin/mcp`) shows the full catalog, why each unregistered tool is missing, and a playground for calling registered tools.

A registered tool only means the required source data exists — it does **not** mean semantic embeddings have been fully backfilled. When vectors are incomplete, the related search falls back to, or mixes in, keyword/BM25. Check each module's embedding count on its page in the admin console and run or schedule the corresponding `*_embed` job.

## Maintenance mode {#maintenance}

The admin console can switch the `icd`, `loinc`, `drug`, `snomed`, `ig` and `rxnorm` modules into maintenance mode (`POST /admin/api/module-maintenance`). While a module is in maintenance, calls to its tools (over `/mcp`, `POST /tools/<name>` and the admin playground alike) return an `isError` result immediately, before the tool runs:

```json
{"ok": false, "data": null, "warnings": [],
 "error": {"code": "MODULE_MAINTENANCE", "module": "loinc", "tool": "query_loinc", "retryable": true,
           "message": "Module 'loinc' is under maintenance (data is being updated); query_loinc is temporarily unavailable. Retry later.",
           "message_zh": "模組「loinc」維護中（資料更新中），query_loinc 暫時無法使用，請稍後再試。"}}
```

`POST /tools/<name>` returns this JSON with HTTP 200 (like every other tool error). Mapping: ICD-10 and FHIR Condition → `icd`; Drug / TFDA and FHIR Medication → `drug`; Lab / LOINC → `loinc`; SNOMED CT → `snomed`; FHIR IG (including grounding / completeness) → `ig`. `rxnorm` has no tool group of its own, so its flag gates no tool; Health Supplements, Food Nutrition, FHIR Servers, Clinical Calculators and System are never affected. To avoid tool-list churn for clients, tools under maintenance **stay in `tools/list` / `/openapi.json`**. The state is cached for 5 seconds, so a toggle takes effect within about 5 seconds; a failing state lookup fails open.

## `health_check` (System group)

Always registered, no arguments. Call it before any workflow to confirm the modules you need are online. Returns JSON:

| Field | Description |
|-------|-------------|
| `status` | `ok` when the database is reachable, otherwise `degraded` |
| `database` / `cache` | `ok` / `error` (Postgres query, Redis ping) |
| `db_health` | Snapshot of the DB health monitor (`state`, `healthy`, `since`, `last_ok_at`, `last_error` …) |
| `services` | Whether each module meets its registration threshold: `icd`, `drug`, `health_supplements`, `food_nutrition`, `fhir_condition`, `fhir_medication`, `lab`, `ig`, `snomed` |
| `version` | Server version (`SERVER_VERSION` in `toolVersions.ts`, currently `1.1.0`), same as MCP `initialize` `serverInfo.version` |
| `build` | Git sha baked in at image build time (`BUILD_SHA` build arg); `dev` when unset |
| `tools_version` | Tools that carry their own version, and those versions (see [FHIR IG Tools → Tool versions](../tools/fhir-ig-tools.md#tool-versions)) |
| `lexicon_version` / `lexicon_sha256` | Version and hash of the Taiwan clinical-record lexicon used by grounding |
| `terminology` | Loaded terminology editions, e.g. `icd10cm` (`2026-04-01`), `icd10` (WHO ICD-10, optional), `loinc` (`2.80`), `snomed` (`<module>/<YYYYMMDD>`); read from `icd.editions`, `loinc.editions`, `snomed.editions` |
| `ig_packages` | Installed IG packages (`package_id#version`), default IG first |
| `default_ig` | The default IG (`package_id#version`), or `null` when none is set |

## Admin console REST API

Every path starts with `/admin/api/` and requires the session cookie (named `tw_health_admin_session` by default; `ADMIN_SESSION_COOKIE` renames it). The main endpoints:

| Group | Endpoints |
|-------|-----------|
| Authentication | `POST /admin/api/login`, `POST /admin/api/logout`, `GET /admin/api/me`, `/admin/api/passkeys/*` (incl. `login/options`, `login/verify`, `register/options`, `register/verify`), `POST /admin/api/privacy/password` |
| Overview and health | `GET /admin/api/overview`, `GET /admin/api/health`, `GET /admin/api/services`, `POST /admin/api/services/probe`, `GET /admin/api/workers` |
| Modules and sources | `GET /admin/api/modules`, `GET|POST /admin/api/modules/{key}/clear`, `GET /admin/api/modules/{key}/versions`, `GET /admin/api/modules/{key}/preview`, `POST /admin/api/modules/{key}/schedule/trigger`, `POST /admin/api/uploads`, `POST /admin/api/module-sources/{activate,deactivate,delete}`, `POST /admin/api/module-maintenance` |
| Jobs | `GET|POST /admin/api/jobs`, `GET /admin/api/jobs/{id}`, `GET /admin/api/jobs/{id}/{steps,logs}`, `POST /admin/api/jobs/{id}/{pause,resume,stop,restart}` |
| Settings | `GET /admin/api/settings`, `POST /admin/api/settings/{group}[/{action}]`, `GET /admin/api/settings/export`, `POST /admin/api/settings/import` (export format v3; v1/v2 files still import) |
| Model endpoints | `GET /admin/api/llm-providers` (provider adapter catalog); `/admin/api/llm/accounts[/{id}][/models]`, `POST /admin/api/llm/accounts/test`, `POST /admin/api/llm/models/test`, `/admin/api/llm/routes[/{id}][/test]`, `PUT /admin/api/llm/roles`, `POST /admin/api/llm/oauth/chatgpt/{start,complete}` |
| MCP tools | `GET /admin/api/mcp/overview`, `GET /admin/api/mcp/tools`, `POST /admin/api/mcp/tools/{name}/invoke` |
| Terminology explorer (read-only) | `GET /admin/api/terminology/icd/{cm,who}/{children,path,search}`, `GET /admin/api/terminology/icd/pcs/{browse,table,codes,code,search}`, `GET /admin/api/terminology/snomed/{concept,children,search}`, `GET /admin/api/terminology/loinc/{facets,facet-values,term,code}`, `GET /admin/api/terminology/rxnorm/{summary,search,concept}`, `GET /admin/api/terminology/ig/{codesystems,codesystem,codesystem/children,codesystem/search}` |
| Backups | `GET /admin/api/backups`, `GET /admin/api/backups/{job_id}/download`; create a `system_backup` job with `POST /admin/api/jobs` |
| Drug pipeline | `GET /admin/api/drug/pipeline-status`, `/admin/api/drug/{status,details,assets,asset-content,events}` |
| Drug explorer | `GET /admin/api/drug/explorer`, `GET /admin/api/drug/explorer-detail`, `GET /admin/api/drug/llm-calls`, `GET /admin/api/drug/llm-call` |
| OCR | `GET /admin/api/ocr/samples[/{id}]`, `POST /admin/api/ocr/test` |
| FHIR servers | `GET|POST /admin/api/fhir-servers`, `/admin/api/fhir-servers/{discover,test,test-request,generate-key,export}`, `POST /admin/api/fhir-servers/{id}/{probe,set-default}`, `POST /admin/api/fhir-servers/{id}/oauth/{authorize,refresh,clear-cache}` |
| IG | `GET /admin/api/igs`, `GET|DELETE /admin/api/igs/{package_id}/{version}`, `GET /admin/api/igs/{package_id}/{version}/removal-impact`, `POST /admin/api/igs/{package_id}/{version}/{default,fill-dependencies}`, `POST /admin/api/igs/import`, `POST /admin/api/igs/inspect-upload`, `GET /admin/api/igs/dependencies`, `POST /admin/api/igs/dependencies/{download,download-all}`, `GET /admin/api/igs/unused-dependencies`, `POST /admin/api/igs/unused-dependencies/remove`, `GET /admin/api/registry/search` |
| Embeddings | `GET /admin/api/embedding/status` |

## Service layer (TypeScript)

The domain services live in `node-server/src/`. Each offers `async initialize()`; database access goes through the shared `pg` pool in `db.ts` (not a constructor argument), and search services take the shared `EmbeddingService` in their constructor. `mcp.ts` creates each one as a lazy singleton; a service that fails to initialise only removes its own tools.

| Class | File | Data |
|-------|------|------|
| `IcdService` | `icdService.ts` | `icd.*` |
| `DrugService` | `drugService.ts` | `drug.*` |
| `DrugAnalysisService` | `drugAnalysisService.ts` | `drug.insert_analysis` (including MinerU OCR and analysis-LLM calls) |
| `HealthSupplementsService` | `supplementsService.ts` | `health_supplements.*` |
| `FoodNutritionService` | `foodService.ts` | `food_nutrition.*` |
| `LabService` | `labService.ts` | `loinc.*` |
| `FHIRConditionService` | `fhirConditionService.ts` | reads `icd.*` |
| `FHIRMedicationService` | `fhirMedicationService.ts` | reads `drug.*` |
| `FHIRIGService` | `fhirIgService.ts` | `fhir.*` (multi-IG) |
| `FHIRServerService` | `fhirServerService.ts` | `admin.fhir_servers` |
| `SnomedService` | `snomedService.ts` | `snomed.*` |
| `EmbeddingService` | `embeddingService.ts` | External embedding endpoint — the route assigned to the `embedding` role (`admin.llm_routes` / `admin.llm_role_routes` over provider accounts in `admin.llm_providers`) |
| MinIO helper | `minioService.ts` | MinIO bucket (drug assets) |

## Related documents

- [FHIR Services API](fhir-services.md)
- [Module overview](../modules/icd-service.md)
- For each service's public MCP tools, see the [tool reference](../tools/icd-tools.md).
