# node-server — the Taiwan Health MCP backend

TypeScript implementation of the **entire** Taiwan Health MCP backend. Two compose
services run from this one build:

| Service | Entry point | Role |
|---------|-------------|------|
| `app` | `dist/server.js` | MCP server (`/mcp`), OpenAPI bridge (`/openapi.json`, `/tools/*`), `/health` (compose-internal — nginx does not route it), admin REST API (`/admin/api/*`), admin WebSocket (`/admin/ws`), FHIR OAuth/JWKS endpoints |
| `admin-worker` | `dist/admin/adminWorker.js` | Background job runner: every import, the embedding backfill, and the three-stage drug pipeline |

This replaced the original Python backend in 2026-07. **No Python remains in the
repository.**

## Commands

```bash
npm install
npm run build        # tsc -> dist/
npm run dev          # tsx watch src/server.ts
npm run typecheck    # tsc -p tsconfig.dev.json --noEmit (also checks the test-only helpers the build excludes)
npm test             # node --test over src/**/*.test.ts
```

Run the server locally in HTTP mode:

```bash
DATABASE_URL=postgresql://... node dist/server.js
```

Docker images: `app` builds from `node-server/Dockerfile`, `admin-worker` from the root
`Dockerfile.worker` — a change to job / loader code must be rebuilt into **both**.
`node-server/Dockerfile` takes `--build-arg BUILD_SHA=$(git rev-parse --short HEAD)`, which
`health_check` reports as `build` (`dev` when not given; `compose.yaml` does not pass it).

In Docker, `app` is only reachable through the nginx front door (`:8080` by default) —
it does not publish port 8000 to the host.

## Layout

| Path | Contents |
|------|----------|
| `src/server.ts` | HTTP surface + process initialization (pool, Redis, MinIO, services, metrics) |
| `src/mcp.ts` | MCP tool registration — all 63 tools, grouped; module-backed groups are added/removed dynamically by `moduleStatus.ts` |
| `src/toolVersions.ts` | `SERVER_VERSION`, `BUILD` (from `BUILD_SHA`) and the per-tool `TOOLS_VERSION` map reported by `health_check` — bump a tool's entry whenever its output for the same input changes |
| `src/*Service.ts` | Domain services (ICD, drug, lab, SNOMED, FHIR Condition/Medication/IG, FHIR servers, embeddings) |
| `src/fhir*.ts` | In-process FHIR R4 machinery: snapshot generation, terminology (incl. CVX, ISO 3166, UCUM), validation (parity target: HL7 `validator_cli` 7.0.1 — see `scripts/validator-audit/`), FHIRPath, reference resolution, required elements, authoring |
| `src/grounding/`, `src/groundingTools.ts` | Deterministic (no-LLM) record-faithfulness engines behind `fhir_check_grounding`, `fhir_check_completeness` and the optional `source_text` grounding of the validate tools. `source_text` is clinical data — it is never logged (only its SHA-256) |
| `src/providers/` | LLM / embedding provider adapters (24, incl. ChatGPT sign-in) and the registry (`registry.ts`) used by the model routes |
| `src/admin/` | Admin console backend: routing (`adminApp.ts`), jobs (`adminJobs.ts`), worker (`adminWorker.ts`), settings + export/import (`adminSettings.ts`), model routing (`llmRouting.ts`, `adminLlmApi.ts`, `chatgptOAuth.ts`, `embeddingIdentity.ts`), sources, schedules, IG import / dependencies / removal, MCP tool catalog + playground (`adminMcp.ts`), terminology explorer API (`termViz/`), FHIR servers, backups, WebAuthn |
| `src/loaders/` | Dataset loaders: `icd.ts`, `loinc.ts`, `snomed.ts`, `rxnorm.ts`, `ig.ts`, `healthSupplements.ts`, `foodNutrition.ts`, `embeddings.ts`, and the drug pipeline (`drugIndex.ts`, `drugEnrichment.ts`, `drugAnalysis.ts`, `tfdaCrawler.ts`, `drugRecordBuilder.ts`) |
| `src/{db,cache,config,logger,metrics,moduleStatus,minioService}.ts` | Cross-cutting infrastructure |

## Things that must not change

- **The Python-semantics helpers in `src/loaders/drugRecordBuilder.ts`** (`pick`,
  `dictGet`, and the quirks they deliberately reproduce). Their output is persisted as
  `normalized_records.normalized_json`; "cleaning them up" changes stored data.
- **The UUIDv5 namespaces** in `drugEnrichment.ts` / `drugAnalysis.ts`. Asset IDs and
  MinIO object keys derive from them; changing them orphans every stored object.
- **The single transaction in `loadDrugIndex`.** Its chunking exists for JS memory, not
  to relax atomicity — a partial index must never land.
- **`NODE_OPTIONS=--max-old-space-size=8192`** on the worker. The IG import holds whole
  dependency packages in memory; Node's ~4 GB default is not enough. Do not lower it.

## Configuration

See [`docs/deployment/configuration.md`](../docs/deployment/configuration.md). In short:
bootstrap vars in `.env`; infrastructure settings seeded once into `admin.app_settings`
and then managed in the admin console (外部服務 page); model endpoints (embedding /
Analysis LM) **only** as provider accounts + routes (`admin.llm_providers`,
`admin.llm_routes`, `admin.llm_route_members`, `admin.llm_role_routes`) and the OCR server
in `admin.app_settings` — never from env.
