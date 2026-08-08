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
| `web/` | Next.js front-end: the admin console SPA (`admin-app/`), mounted through the `app/admin/` catch-all route. |
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

# Front-end
cd web
npm install
npm run dev            # next dev -p 3000
```

For the full stack use Docker: `docker compose up -d` (see [Getting Started](../getting-started.md)).
To redeploy after code changes: `docker compose build app web && docker compose up -d --no-deps app web`.

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
4. For availability driven by data-load status, add a threshold to `SERVICE_MODULES` in `moduleStatus.ts` and guard each tool with a service availability check.
