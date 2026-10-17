# Jobs & Scheduling

## Components

- **`node-server/src/admin/adminWorker.ts`** is a standalone process (the `admin-worker` compose service, a **separate image** built from `Dockerfile.worker`). It polls `admin.import_jobs` to claim queued jobs, runs the matching load stage, and writes `admin.import_job_steps` / `admin.import_job_logs`.
- **`node-server/src/admin/adminJobs.ts`** provides the job API (create / query / cancel / pause) and the execution logic for every job type.
- **`node-server/src/admin/adminJobStaging.ts`** provides the staging / promote mechanism for heavy imports (write to `admin.stage_*` tables first, then swap atomically in one transaction; each terminology's edition row is written in the same promote transaction).
- **`node-server/src/admin/adminSchedule.ts`** manages schedules (`admin.module_schedules`); the worker checks `next_run_at` every `ADMIN_SCHEDULE_SCAN_INTERVAL_SECONDS` (default 60 s) to trigger periodic imports.
- **`node-server/src/admin/adminWs.ts`** pushes live logs and progress to the UI over WebSocket (`/admin/ws`).

!!! warning "Changing job / loader code means rebuilding the worker too"
    `admin-worker` and `app` are two images. After changing `adminJobs.ts`, `*Service.ts` or `loaders/*`,
    rebuilding only `app` leaves the worker running stale code with no error:

    ```bash
    docker compose build admin-worker && docker compose up -d --no-deps admin-worker
    ```

## Job types

| Job type | Module | Description |
|----------|--------|-------------|
| `icd_import` / `loinc_import` / `snomed_import` / `rxnorm_import` / `ig_import` | Matching module | Imports from source files uploaded through the admin console (source files live in MinIO and are fetched when the job runs). `ig_import` also downloads missing dependency packages from the FHIR package registry and records each package's `install_origin` (`manual` / `dependency`). |
| `health_supplements_sync` / `food_nutrition_sync` | Matching module | Fetched from the TFDA Open Data API. |
| `drug_index_import` | `drug` | Imports the `36_2.csv` license index into `drug.licenses` and queues enrichment. |
| `drug_enrichment` | `drug` | Crawls the TFDA site for insert / label / appearance assets and uploads them to MinIO. |
| `drug_analysis` | `drug` | Insert PDF → MinerU OCR → analysis LLM → `drug.insert_analysis`. |
| `icd_embed` / `loinc_embed` / `snomed_embed` / `health_supplements_embed` / `food_nutrition_embed` | Matching module | Backfills the `*_embeddings` vector tables (needs a usable profile on the embedding role). |
| `system_backup` | — | System backup (see [Admin Console](index.md#system-backups)). |

All three drug stages run natively in TypeScript (`node-server/src/loaders/drugIndex.ts`, `drugEnrichment.ts`, `drugAnalysis.ts`).

## Control and concurrency

- **Pause / cancel**: checkpoint-based — the worker checks `admin.job_control_requests` at safe points, so a pause never leaves half-written data.
- **Heartbeat**: the worker writes `admin.worker_heartbeats` periodically; after `ADMIN_WORKER_STALE_AFTER_SECONDS` (default 45 s) without an update it is considered lost and its running jobs are reclaimed and re-queued. On startup the worker also reclaims `running` jobs left under its own name.
- **Concurrency limit**: `ADMIN_MAX_CONCURRENT_JOBS` (default 4) bounds how many jobs run at once; per-module resource slots additionally prevent concurrent writes to the same module.

## Self-healing when the analysis LLM is unavailable

When a `drug_analysis` job pauses because every profile on the analysis role failed (`last_error_code = 'llm_unavailable'`),
the worker re-claims it automatically once `admin.import_jobs.next_retry_at` passes; the backoff doubles per attempt (2 min → 30 min cap),
and a manual resume skips it. A `paused` job that a human paused, or whose error code is not `llm_unavailable`, is **never** auto-resumed.

A single LLM call times out after 600 s by default, with 3 transport retries; override it per member with the `timeout_ms` parameter on the model endpoints page.

## Auto-chaining (drug pipeline)

The three drug stages chain automatically: when `drug_index_import` completes it queues `drug_enrichment`, and when that completes it queues `drug_analysis`.

Jobs created by auto-chaining carry a batch cap, `DRUG_AUTOCHAIN_BATCH_LIMIT` (default 200 licenses),
and re-chain the next batch from their own completion. This drains the backlog gradually
while still giving the operator a chance to stop between batches.

!!! warning "Manually queued jobs are not protected by the batch cap"
    The batch cap only applies to jobs created by **auto-chaining**. If you manually
    queue `drug_enrichment` through the API or UI without specifying a `limit`, that job
    processes the entire backlog in one go (potentially tens of thousands of crawls
    against the TFDA site). Pass an explicit `limit` when you need to bound it.

## Monitoring

Job progress, the step timeline, and live logs are available on the admin console's **Jobs** page (`/admin/jobs`); each module page also lists that module's jobs.
