# Taiwan Health MCP Server

An MCP server for Taiwan medical and health data — a Node.js service built on the official TypeScript MCP SDK (`@modelcontextprotocol/sdk`), exposing **49 tools** across 11 tool groups covering international terminologies, Taiwan-local datasets, and FHIR R4 IG authoring / validation.

## Current capabilities

- **ICD-10**: diagnosis and procedure code search, nearby codes, category browsing, complication inference, diagnosis / procedure conflict checks.
- **LOINC**: lab test search, reference range lookup, single and batch lab result interpretation.
- **SNOMED CT**: concept search, concept details, relationship (hierarchy / attribute) queries, SNOMED ↔ ICD-10 mapping.
- **Drugs (Taiwan FDA / TFDA)**: drug search (name / ingredient / license number / ATC), pill identification, drug details, document asset download links.
- **Health supplements (Taiwan FDA)**: search by keyword, license number, or disease mapping.
- **Food nutrition (Taiwan FDA)**: nutrient lookup, ingredient lookup, find foods by nutrient, meal nutrition analysis.
- **FHIR R4**: Condition / Medication generation and validation.
- **FHIR IG (multi-IG)**: profile / ValueSet lookup and expansion, terminology lookup and validation, reference resolution, Bundle assembly, skeleton-fill resource generation and validation.
- **FHIR servers**: external FHIR server registration, status queries, and CRUD operations.

## Architecture at a glance

- **Runtime**: the backend is entirely Node.js / TypeScript (`node-server/`); the front-end is Next.js (`web/`).
- **Front door**: a single nginx entry point (default `:8080`) routes `/mcp`, `/openapi.json`, `/tools/*`, `/status.json`, and `/admin/api/*` to `app`, and everything else (public pages and the `/admin` SPA) to `web`.
- **Infrastructure**: PostgreSQL 16 (pgvector), pgBouncer, Redis, MinIO, Prometheus, plus an optional embedding service (Ollama by default).
- **Dynamic tool registration**: tools are enabled / disabled automatically according to each module's data-load status.
- **Semantic / hybrid search**: embedding vectors strengthen search, with a keyword-only fallback when embeddings are unavailable.
- **Admin console and background worker**: an optional Admin Console and the `admin-worker` handle data imports and scheduling.

## Quick links

- [Getting Started](getting-started.md)
- [Modules](modules/icd-service.md)
- [MCP Tools](tools/icd-tools.md)
- [Data Sources](data-sources/index.md)
- [Deployment](deployment/index.md)
- [Admin Console](admin/index.md)
- [Development](development/index.md)
