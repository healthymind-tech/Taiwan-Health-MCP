# Code Style

Code and comments in this project are always written in **English**; user-facing documentation is bilingual, in Traditional Chinese and English (see [Docs Site Maintenance](../WEBSITE.md)).

## TypeScript (`node-server/`, `web/`)

- **Format**: TypeScript 5.7, ESM (`"type": "module"`); relative imports must carry the `.js` extension (matching the compiled output).
- **Naming**: files in camelCase (`drugService.ts`, `adminJobs.ts`); types and classes in PascalCase; functions and variables in camelCase.
- **Types**: annotate parameter and return types on public functions. Avoid `any`; when unavoidable, note why.
- **Validation**: MCP tool input schemas are defined with `zod`.
- **Logging**: always go through `logger.ts` (`logInfo` / `logWarning` / `logError`), which writes structured JSON to **stderr**.
  **Never write to stdout** — that channel belongs to the MCP stdio transport.
- **Database**: loaders take a `pg.Pool` and follow the existing `batchInsert` pattern in that file.

## Comments

Comments explain **why**, or record constraints the code itself cannot express; they should not restate what the next line does.

Quirks deliberately preserved during the Python → Node migration for value-for-value behavioural parity all carry a comment explaining which behaviour they replicate and what breaks if it changes (for example `pick()` / `dictGet()` in `drugRecordBuilder.ts`, whose output is persisted as `normalized_records.normalized_json`). **Do not "tidy these up" in passing.**

## Import rules (important)

Bulk imports follow "fetch everything first, then write atomically":

1. Complete the entire network phase first (fetch all the data back).
2. Then write inside a single transaction (`TRUNCATE` / `UPSERT`).
3. Deduplicate the source data before inserting (TFDA Open Data occasionally has duplicate primary keys).

**Never** interleave HTTP fetches with database writes inside a transaction.

## Commits

Follow Conventional Commits: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`.
Keep subjects short and specific; describe in the PR what changed, the related issue, any data or schema impact, and the testing evidence.
