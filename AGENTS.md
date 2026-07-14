# Repository Guidelines

## Project Structure & Module Organization
`node-server/` contains the **entire backend** (Node.js / TypeScript): the MCP server
(`src/server.ts`, `src/mcp.ts`), the service layer (`src/*Service.ts` — ICD, drug, lab,
guideline, FHIR, SNOMED, …), the admin console backend (`src/admin/*.ts`), and every
dataset loader (`src/loaders/*.ts` — ICD, LOINC, SNOMED, RxNorm, FHIR IG, Taiwan FDA
drug/supplements/food, embeddings). `web/` is the Next.js front-end (public pages in
`app/`, the admin SPA in `admin-app/`, verbatim legacy HTML in `legacy/`). `db/` holds
`schema.sql` and `migrations/`. `docs/` is the MkDocs source for the published site.
`src/prompts/` holds runtime LLM prompts and is the only thing left under `src/`.
`fhir-code/` holds source datasets (untracked; see `docs/data-sources/test-data.md`).

**There is no Python in this repository.** The backend was fully migrated to Node in
2026-07; `src/*.py`, `loader/` and `requirements.txt` are gone.

## Build, Test, and Development Commands
- `docker compose up -d`: start the full stack (`nginx`, `web`, `app`, `admin-worker`,
  `postgres`, `pgbouncer`, `redis`, `minio`). **nginx on `:8080` (`WEB_PORT`) is the only
  published entry point** — `app` is not reachable on `:8000` from the host.
- `docker compose build app web && docker compose up -d --no-deps app web`: redeploy after
  a code change.
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
rather than by unit tests. Add tests for new tools and loaders.

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

## Bulk-import Rule
Fetch everything first, then write atomically: complete the network phase, then write
inside one transaction (`TRUNCATE` / `UPSERT`), deduplicating source rows first. Never
interleave HTTP fetches with DB writes inside a transaction.
