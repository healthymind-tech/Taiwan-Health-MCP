# node-server — the Taiwan Health MCP backend

TypeScript implementation of the **entire** Taiwan Health MCP backend. Two compose
services run from this one build:

| Service | Entry point | Role |
|---------|-------------|------|
| `app` | `dist/server.js` | MCP server (`/mcp`), OpenAPI bridge (`/openapi.json`, `/tools/*`), `/status.json`, admin REST API (`/admin/api/*`), admin WebSocket (`/admin/ws`), FHIR OAuth/JWKS endpoints |
| `admin-worker` | `dist/admin/adminWorker.js` | Background job runner: every import, the embedding backfill, and the three-stage drug pipeline |

This replaced the original Python backend in 2026-07. **No Python remains in the
repository.**

## Commands

```bash
npm install
npm run build        # tsc -> dist/
npm run dev          # tsx watch src/server.ts
npm run typecheck    # tsc --noEmit
npm test             # node --test over src/**/*.test.ts
```

Run the server locally in HTTP mode:

```bash
MCP_TRANSPORT=streamable-http DATABASE_URL=postgresql://... node dist/server.js
```

In Docker, `app` is only reachable through the nginx front door (`:8080` by default) —
it does not publish port 8000 to the host.

## Layout

| Path | Contents |
|------|----------|
| `src/server.ts` | HTTP surface + process initialization (pool, Redis, MinIO, services, metrics) |
| `src/mcp.ts` | MCP tool registration — all 51 tools, grouped; groups are added/removed dynamically by `moduleStatus.ts` |
| `src/*Service.ts` | Domain services (ICD, drug, lab, guideline, SNOMED, FHIR Condition/Medication/IG, FHIR servers, embeddings) |
| `src/fhir*.ts` | In-process FHIR R4 machinery: snapshot generation, terminology, validation, reference resolution, authoring |
| `src/admin/` | Admin console backend: routing (`adminApp.ts`), jobs (`adminJobs.ts`), worker (`adminWorker.ts`), settings, sources, schedules, IG import, FHIR servers, WebAuthn |
| `src/loaders/` | Dataset loaders: `icd.ts`, `loinc.ts`, `snomed.ts`, `rxnorm.ts`, `ig.ts`, `healthSupplements.ts`, `foodNutrition.ts`, `guideline.ts`, `embeddings.ts`, and the drug pipeline (`drugIndex.ts`, `drugEnrichment.ts`, `drugAnalysis.ts`, `tfdaCrawler.ts`, `drugRecordBuilder.ts`) |
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
and then managed in Admin → Settings; model endpoints (embedding / OCR / Analysis LM)
**only** in `admin.llm_profiles`, never from env.
