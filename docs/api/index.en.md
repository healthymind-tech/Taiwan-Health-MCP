# API Reference

The system exposes three interfaces, all served through the nginx front door (`:8080` by default).

## HTTP endpoint overview

| Endpoint | Method | Authentication | Description |
|----------|--------|----------------|-------------|
| `/mcp` | `POST` / `GET` / `DELETE` | Optional bearer | The MCP streamable-http endpoint (path set by `MCP_PATH`). |
| `/openapi.json` | `GET` | Optional bearer | An OpenAPI 3.1 spec generated dynamically from the **currently registered tools**. |
| `/tools/<tool_name>` | `POST` | Optional bearer | OpenAPI bridge: invoke a single tool with the arguments as a JSON body. |
| `/status.json` | `GET` | None | Per-module row counts and service health (the data source for the public status page). |
| `/admin/api/*` | Varies | Session cookie | Admin console REST API (present only when `ADMIN_ENABLED=true`). |
| `/admin/ws` | WebSocket | Session cookie | Live job logs and progress. |
| `/fhir-client/<id>/jwks.json` | `GET` | None | Public JWKS for external FHIR OAuth clients. |
| `/fhir-oauth/callback` | `GET` | — | OAuth2 Authorization Code callback endpoint. |

`PUBLIC_TOOLS_AUTH_MODE=bearer` protects `/mcp`, `/openapi.json`, and `/tools/*` together. The token is set by `PUBLIC_TOOLS_BEARER_TOKEN`; cross-origin browser calls additionally require the origin to be listed in `PUBLIC_TOOLS_CORS_ORIGINS`. `none` is only suitable for trusted local or private networks.

> The backend also has a `/health` endpoint, but nginx does not proxy it (reaching it through the front door returns 404). Use `/status.json` instead.

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

The tool list grows and shrinks with each module's data-load status (see the `SERVICE_MODULES` thresholds in `moduleStatus.ts`), so the content of `/openapi.json` differs according to the deployment's data state.

A registered tool only means the required source data exists — it does **not** mean semantic embeddings have been fully backfilled. When vectors are incomplete, the related search falls back to, or mixes in, keyword/BM25. Check each module's Embeddings count under Admin → Modules and run or schedule the corresponding `*_embed` job.

## Admin console REST API

Every path starts with `/admin/api/` and requires the `tw_health_admin_session` cookie. The main endpoints:

| Group | Endpoints |
|-------|-----------|
| Authentication | `POST /admin/api/login`, `POST /admin/api/logout`, `/admin/api/passkeys/*`, `POST /admin/api/privacy/password` |
| Overview and health | `GET /admin/api/overview`, `GET /admin/api/health`, `GET /admin/api/services`, `POST /admin/api/services/probe`, `GET /admin/api/workers` |
| Modules and sources | `GET /admin/api/modules`, `POST /admin/api/uploads`, `/admin/api/module-sources/{activate,deactivate,delete}`, `POST /admin/api/module-maintenance` |
| Jobs | `GET|POST /admin/api/jobs` (create, query, pause / cancel) |
| Settings | `GET|POST /admin/api/settings`, `GET /admin/api/settings/export`, `POST /admin/api/settings/import`, `/admin/api/llm-profiles/*` |
| Backups | `GET /admin/api/backups`, `GET /admin/api/backups/{job_id}/download`; create a `system_backup` job with `POST /admin/api/jobs` |
| Drug pipeline | `GET /admin/api/drug/pipeline-status`, `/admin/api/drug/{status,details,assets,asset-content,events}` |
| FHIR servers | `GET|POST /admin/api/fhir-servers`, `/admin/api/fhir-servers/{discover,test,test-request,generate-key,export}` |
| IG | `GET /admin/api/igs`, `POST /admin/api/igs/import`, `GET /admin/api/registry/search` |
| Embeddings | `GET /admin/api/embedding/status` |

## Service layer (TypeScript)

The domain services live in `node-server/src/`; each constructor takes a `pg.Pool` and each service offers `async initialize()`:

| Class | File | Data |
|-------|------|------|
| `ICDService` | `icdService.ts` | `icd.*` |
| `DrugService` | `drugService.ts` | `drug.*` |
| `DrugAnalysisService` | `drugAnalysisService.ts` | `drug.insert_analysis` (including MinerU OCR and analysis-LLM calls) |
| `SupplementsService` | `supplementsService.ts` | `health_supplements.*` |
| `FoodService` | `foodService.ts` | `food_nutrition.*` |
| `LabService` | `labService.ts` | `loinc.*` |
| `FhirConditionService` | `fhirConditionService.ts` | reads `icd.*` |
| `FhirMedicationService` | `fhirMedicationService.ts` | reads the drug service |
| `FhirIgService` | `fhirIgService.ts` | `fhir.*` (multi-IG) |
| `FhirServerService` | `fhirServerService.ts` | `admin.fhir_servers` |
| `SnomedService` | `snomedService.ts` | `snomed.*` |
| `EmbeddingService` | `embeddingService.ts` | External embedding endpoint (configuration stored in `admin.llm_profiles`) |
| MinIO helper | `minioService.ts` | MinIO bucket (drug assets) |

## Related documents

- [FHIR Services API](fhir-services.md)
- [Module overview](../modules/icd-service.md)
- For each service's public MCP tools, see the [tool reference](../tools/icd-tools.md).
