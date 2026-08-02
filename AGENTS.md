# Repository Guidelines

## Project Structure & Module Organization
`node-server/` contains the **entire backend** (Node.js / TypeScript): the MCP server
(`src/server.ts`, `src/mcp.ts`), the service layer (`src/*Service.ts` — ICD, drug, lab,
FHIR, SNOMED, …), the admin console backend (`src/admin/*.ts`), and every
dataset loader (`src/loaders/*.ts` — ICD, LOINC, SNOMED, RxNorm, FHIR IG, Taiwan FDA
drug/supplements/food, embeddings). `web/` is the Next.js front-end (public pages in
`app/`, the admin SPA in `admin-app/`, verbatim legacy HTML in `legacy/`). `db/` holds
`schema.sql` and `migrations/`. `docs/` is the MkDocs source for the published site.
`src/prompts/` holds runtime LLM prompts and is the only thing left under `src/`.
`fhir-code/` holds source datasets (untracked; see `docs/data-sources/test-data.md`).

**There is no Python in this repository.** The backend was fully migrated to Node in
2026-07; `src/*.py`, `loader/` and `requirements.txt` are gone. `pyproject.toml`,
`pytest.ini` and `requirements-dev.txt` are dead leftovers — ignore them.
`requirements-docs.txt` is the live one (MkDocs).

**Root `admin-ui/` is a dead leftover** (Vite React, nothing builds or references it).
The real admin SPA lives in `web/admin-app/`, mounted under the Next.js `/admin`
catch-all. Edit `web/admin-app/`, never root `admin-ui/`.

## Build, Test, and Development Commands
- `docker compose up -d`: start the full stack (`nginx`, `web`, `app`, `admin-worker`,
  `postgres`, `pgbouncer`, `redis`, `minio`). **nginx on `:8080` (`WEB_PORT`) is the only
  published entry point** — `app` is not reachable on `:8000` from the host.
- `docker compose build app web && docker compose up -d --no-deps app web`: redeploy after
  a code change.
- **`admin-worker` is a separate image (`Dockerfile.worker`) that executes all import
  jobs.** Any `node-server/` change that touches job/loader code (`adminJobs.ts`, the
  `*Service.ts` layer, `loaders/*`) must also be deployed to it:
  `docker compose build admin-worker && docker compose up -d --no-deps admin-worker`.
  Rebuilding only `app` leaves the worker running stale code.
- `cd node-server && npm run build`: compile TypeScript to `dist/`.
- `cd node-server && npm test`: run the test suite (`node --test` over `src/**/*.test.ts`).
- `cd node-server && npm run typecheck`: type-check without emitting.
- Data import: enable the admin console (`ADMIN_ENABLED=true` + credentials) and import
  modules from the **Modules** tab; `admin-worker` runs the loader stages. There is no
  standalone `data-loader` container and no loader CLI.

## Coding Style & Naming Conventions
TypeScript with ESM (`"type": "module"`); relative imports carry the `.js` extension.
Files are camelCase (`drugService.ts`, `adminJobs.ts`); types and classes PascalCase.
Annotate parameter and return types on public functions; avoid `any`. Define MCP tool
input schemas with `zod`. Log through `src/logger.ts` (structured JSON to **stderr** —
never stdout, which belongs to the MCP stdio transport). Code and comments in English.
Name services `node-server/src/<domain>Service.ts`, tests `<name>.test.ts` next to the
code, and branches `feature/short-name` or `bugfix/issue-summary`.

## Testing Guidelines
Node's built-in test runner (`node --test`, executed through `tsx`). Test files live
beside the code they cover (`src/**/*.test.ts`). Coverage is currently thin — most
migration behaviour was verified by differential runs against the old implementation
rather than by unit tests. Add tests for new tools and loaders. `web/` has **no test
suite** — typecheck only.

## Commit & Pull Request Guidelines
Git history uses Conventional Commits such as `feat:`, `fix:`, `refactor:`, `docs:` and
`chore:`. Keep commit subjects short and specific. PRs should describe the change, link
related issues, note any data or schema impact, and include test evidence. Update docs
when behavior, configuration, or loader flow changes.

## Configuration & Data Notes
Do not hardcode dataset paths. Bootstrap settings (DB / Redis / MCP transport / `ADMIN_*`
/ `WEB_PORT`) live in `.env`. Infrastructure settings (MinIO, TFDA, worker tuning) are
**seed-only** in `.env` and thereafter managed in Admin → Settings. Model endpoints
(embedding, OCR, Analysis LM) are **never** read from env — they live only in
`admin.llm_profiles`, configured in the admin console. Local loader source paths can be
overridden with `FHIR_CODE_DIR` / `*_ZIP` env vars.

> `config/datasets.yaml` is **no longer read by any code** and is a leftover from the
> Python loaders. Do not add new configuration to it.

## Operations Gotchas
- **MCP tools are module-gated**: `moduleStatus.ts` registers a tool group only when its
  schema meets a row-count threshold (refreshed on `tools/list`). FHIR Servers and System
  tools are always registered. A tool "missing" usually means the module wasn't imported.
- **`crud_fhir_server` is the only tool that can write** — it relays CUD to an external
  FHIR server and only when that server's allow-list permits it and the caller passes
  `confirm_write=true`. Every other MCP tool is read-only.
- **Drug auto-chain cap**: auto-chained `drug_index_import → drug_enrichment →
  drug_analysis` jobs are capped at `DRUG_AUTOCHAIN_BATCH_LIMIT` (default 200) licenses.
  A *manually* queued enrichment/analysis job with no `limit` crawls the **entire**
  backlog (tens of thousands of TFDA requests).
- **`llm_unavailable` pauses auto-resume**: a job paused because every Analysis LM
  profile failed is re-claimed automatically once `next_retry_at` passes (backoff
  doubles per attempt, 2min → 30min cap). Manual resume overrides the backoff. A
  `paused` job with `last_error_code != 'llm_unavailable'` (or a manual pause) is never
  auto-resumed. Per-call LM timeouts default to 600s and are retried 3× on transport
  errors; override per profile via `llm_profiles.params.timeout_ms` (admin console).
- **pgBouncer transaction mode**: never use named prepared statements (in `db.ts`, keep
  `pg` statements unnamed) and never use `LISTEN`/`NOTIFY`.
- **`/health` exists on `app` but nginx does not route it** — health checks must use
  `/status.json`.
- **Chinese keyword search without embeddings finds almost nothing** (Postgres `simple`
  tokenizer treats a whole Chinese name as one token). Vectors are the intended path —
  do not "fix" with `ILIKE`.

## Bulk-import Rule
Fetch everything first, then write atomically: complete the network phase, then write
inside one transaction (`TRUNCATE` / `UPSERT`), deduplicating source rows first. Never
interleave HTTP fetches with DB writes inside a transaction.
