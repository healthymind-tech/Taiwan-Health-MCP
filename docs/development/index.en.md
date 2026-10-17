# Development

Thank you for your interest in contributing to Taiwan Health MCP. This section helps new developers get familiar with the project structure and development workflow quickly.

## Project structure at a glance

| Path | Contents |
|------|----------|
| `node-server/` | **The entire backend** (Node.js / TypeScript): MCP server, admin REST API, background worker, and all data loaders. |
| `node-server/src/*Service.ts` | The domain services (`icdService.ts`, `drugService.ts`, `labService.ts`, `snomedService.ts`, `fhirIgService.ts`, …). |
| `node-server/src/mcp.ts` | MCP tool registration (tool groups and input schemas). |
| `node-server/src/server.ts` | Entry point: the HTTP surface (`/mcp`, `/openapi.json`, `/tools/*`) and process initialisation. |
| `node-server/src/admin/` | Admin console backend (`adminApp.ts` routing, `adminJobs.ts` jobs, `adminWorker.ts` background worker, `adminSettings.ts` settings, …). |
| `node-server/src/loaders/` | Per-module loaders (`icd.ts`, `loinc.ts`, `snomed.ts`, `rxnorm.ts`, `ig.ts`, `drug*.ts`, `embeddings.ts`, …). |
| `node-server/src/admin/termViz/` | Read-only API behind the admin terminology browser (`/admin/api/terminology/*`: ICD tree, PCS axes, SNOMED graph, LOINC axes, RxNorm, IG CodeSystem tree). |
| `node-server/src/providers/` | Model provider adapters (OpenAI, Azure OpenAI, Anthropic, Gemini, Bedrock, Ollama, OpenAI-compatible servers, ChatGPT sign-in … 24 in all), used by the embedding and analysis-LLM routes. |
| `node-server/src/grounding/` | Deterministic record-faithfulness engines (`fhir_check_grounding`, `fhir_check_completeness`). |
| `node-server/scripts/validator-audit/` | Tools and audit report (`REPORT.md`) comparing the built-in FHIR validator with HL7 validator_cli 7.0.1. |
| `web-v2/` | **The production admin console**: a static Vite + React + Mantine SPA served by its own nginx container (compose service `web-v2`), mounted at `/admin/`. |
| `web/` | The old Next.js admin console (`web/admin-app/`), replaced by `web-v2/`; the compose service `web` only starts under the `legacy-web` profile and is kept for rollback only. |
| `db/` | `schema.sql` and `migrations/`. |
| `src/prompts/` | LLM prompts read at runtime (drug analysis). **This is the only thing left under `src/`.** |
| `data/loinc/` | Hand-curated LOINC mapping tables that cannot be re-downloaded from anywhere. |
| `docs/` | The MkDocs documentation source (this site). |

> The project has no Python runtime dependency; there is no backend code outside `node-server/`.

## Local development

```bash
# Backend
cd node-server
npm install
npm run build          # tsc -> dist/
npm run dev            # tsx watch src/server.ts
npm run typecheck
npm test

# Admin console front-end (web-v2)
cd web-v2
npm install
npm run dev            # vite, http://localhost:5173/admin/, API proxied to ADMIN_BACKEND (default http://127.0.0.1:8090)
npm run typecheck      # tsc -b --noEmit
npm run build          # outputs dist/
```

For the full stack use Docker: `docker compose up -d` (see [Getting Started](../getting-started.md)).
To redeploy after code changes: `docker compose build app web-v2 && docker compose up -d --no-deps app web-v2`.
`admin-worker` is a separate image (`Dockerfile.worker`); rebuild it too whenever job / loader code changes:
`docker compose build admin-worker && docker compose up -d --no-deps admin-worker`.

## Documentation index

### [Code Style](code-style.md)
Naming, comments, and coding conventions (code and comments are written in English).

### [Testing](testing.md)
How to run the tests (`npm test`) and perform end-to-end verification.

### [Contributing](contributing.md)
Pull request conventions and code review standards.

## Adding a new service

1. Create `node-server/src/<name>Service.ts` (a class whose constructor takes a `pg.Pool` and which offers `async initialize()`).
2. Instantiate it in the startup sequence in `server.ts` (a failing service must degrade gracefully without affecting the others).
3. Add a tool registration function in `mcp.ts` (input schemas defined with `zod`) and register it in the appropriate tool group.
4. For availability driven by data-load status, add the table and minimum row count to `REQUIREMENTS` in `moduleStatus.ts` (exported as `MODULE_REQUIREMENTS`), and wrap the group's registration in `mcp.ts` in `if (status.<key>)`.
5. If the tool's output is pinned by fixtures, register its version in `TOOLS_VERSION` in `toolVersions.ts`, and bump it whenever its output for the same input changes.
