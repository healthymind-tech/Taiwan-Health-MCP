# Taiwan Health MCP Server

An MCP server for Taiwan medical and health data — a Node.js service built on the official TypeScript MCP SDK (`@modelcontextprotocol/sdk`), exposing **68 tools** across 12 tool groups covering international terminologies, Taiwan-local datasets, clinical calculators, and FHIR R4 IG authoring / validation.

## Current capabilities

- **ICD-10** (the complete ICD-10-CM 2026-04-01 CMS edition with 7th characters, ICD-10-PCS; FHIR validation can also use WHO ICD-10): diagnosis and procedure code search, nearby codes, category browsing, complication inference, diagnosis / procedure conflict checks.
- **LOINC**: lab test search, reference range lookup, single and batch lab result interpretation.
- **SNOMED CT**: concept search, concept details, relationship (hierarchy / attribute) queries, SNOMED ↔ ICD-10 mapping.
- **Drugs (Taiwan FDA / TFDA)**: drug search (name / ingredient / license number / ATC), pill identification, drug details, document asset download links.
- **Health supplements (Taiwan FDA)**: search by keyword, license number, or disease mapping.
- **Food nutrition (Taiwan FDA)**: nutrient lookup, ingredient lookup, find foods by nutrient, meal nutrition analysis.
- **FHIR R4**: Condition / Medication generation and validation.
- **FHIR IG (multi-IG)**: profile / ValueSet lookup and expansion, terminology lookup and validation, reference resolution, Bundle assembly, skeleton-fill resource generation and validation, plus checking a Bundle against the source record for faithfulness (grounding) and gaps (completeness).
- **FHIR servers**: external FHIR server registration, status queries, and CRUD operations.
- **Clinical calculators**: validated clinical scores common in Taiwan practice (CHA₂DS₂-VASc, Wells, DAS28, BMI, eGFR, HAS-BLED, CURB-65, qSOFA, GCS, etc.) — pure functions, always registered.

## Architecture at a glance

- **Runtime**: the backend is entirely Node.js / TypeScript (`node-server/`); the admin front-end is `web-v2/` (a static Vite + React + Mantine SPA served by the `web-v2` container's nginx). The old Next.js `web/` is kept only in the compose profile `legacy-web` for rollback.
- **Front door**: a single nginx entry point (default `:8080`) routes `/mcp`, `/openapi.json`, `/tools/*`, `/admin/api/*`, `/admin/ws`, `/fhir-client/*` and `/fhir-oauth/*` to `app`, and everything else (the `/admin` pages) to `web-v2`.
- **Infrastructure**: PostgreSQL 16 (pgvector), pgBouncer, Redis, MinIO, Prometheus, plus an optional embedding service (Ollama by default).
- **Dynamic tool registration**: of the 68 tools, the module-gated ones are enabled / disabled automatically according to each module's data-load status (row-count thresholds); FHIR servers, clinical calculators and `health_check` are always registered. The registered set is whatever `GET /openapi.json` or the console's MCP tools page shows.
- **Semantic / hybrid search**: embedding vectors strengthen search, with a keyword-only fallback when embeddings are unavailable.
- **Admin console and background worker**: the Admin Console (on by default — the only way to import data) and `admin-worker` handle data imports, scheduling, model endpoints (provider accounts + profiles) and the MCP tool catalog / playground.

## Quick links

- [Getting Started](getting-started.md)
- [Modules](modules/icd-service.md)
- [MCP Tools](tools/icd-tools.md)
- [Data Sources](data-sources/index.md)
- [Deployment](deployment/index.md)
- [Admin Console](admin/index.md)
- [Development](development/index.md)
