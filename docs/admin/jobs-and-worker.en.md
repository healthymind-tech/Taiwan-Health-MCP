# Jobs & Scheduling

## Components

- **`node-server/src/admin/adminWorker.ts`** is a standalone process (the `admin-worker` compose service). It polls `admin.import_jobs` to claim queued jobs, runs the corresponding loader stage, and writes `admin.import_job_steps` / `admin.import_job_logs`.
- **`node-server/src/admin/adminJobs.ts`** provides the job API (create / query / cancel / pause) and the execution logic for every job type.
- **`node-server/src/admin/adminJobStaging.ts`** provides the staging / promote mechanism for heavyweight imports (write to a staging table first, then swap atomically).
- **`node-server/src/admin/adminSchedule.ts`** manages schedules (`admin.module_schedules`); each worker round checks `next_run_at` to trigger periodic imports.
- **`node-server/src/admin/adminWs.ts`** pushes live logs and progress to the UI over WebSocket (`/admin/ws`).

## Job types

| Job type | Module | Description |
|----------|--------|-------------|
| `icd_import` / `loinc_import` / `snomed_import` / `rxnorm_import` / `ig_import` | The corresponding module | Import from source files uploaded through the admin console (stored in MinIO and fetched back when the job runs). |
| `health_supplements_import` / `food_nutrition_import` | The corresponding module | Fetched from the TFDA Open Data API. |
| `drug_index_import` | `drug` | Import the license index from `36_2.csv` into `drug.licenses` and queue enrichment. |
| `drug_enrichment` | `drug` | Crawl the TFDA site for insert / label / appearance assets and upload them to MinIO. |
| `drug_analysis` | `drug` | Insert PDF → MinerU OCR → analysis LLM → `drug.insert_analysis`. |
| `*_embed` | The corresponding module | Backfill the `*_embeddings` vector tables (requires the embedding service to be available). |

All three drug stages run natively in TypeScript (`node-server/src/loaders/drugIndex.ts`, `drugEnrichment.ts`, `drugAnalysis.ts`).

## Control and concurrency

- **Pause / cancel**: checkpoint-based — the worker checks `admin.job_control_requests` at safe points, so pausing never leaves half-written data.
- **Heartbeat**: the worker writes `admin.worker_heartbeats` periodically; no update for longer than `ADMIN_WORKER_STALE_AFTER_SECONDS` (45 seconds by default) counts as lost.
- **Concurrency cap**: `ADMIN_MAX_CONCURRENT_JOBS` (4 by default) bounds how many jobs run at once; per-module resource slots additionally prevent parallel writes to the same module.

## Auto-chaining (the drug pipeline)

The three drug stages chain automatically: a completed `drug_index_import` queues `drug_enrichment`, whose completion queues `drug_analysis`.

Auto-chained jobs carry the batch cap `DRUG_AUTOCHAIN_BATCH_LIMIT` (200 licenses by default) and re-chain from their own completion, draining the backlog gradually while leaving the operator a chance to stop between batches.

!!! warning "Manually queued jobs are not protected by the batch cap"
    The batch cap applies only to **auto-chained** jobs. A `drug_enrichment` queued by hand
    through the API or UI without a `limit` processes the entire pending queue in one go
    (potentially tens of thousands of crawls against the TFDA site). Pass `limit` explicitly
    when you need it bounded.

## Monitoring

Job progress, the step timeline, and live logs are visible on the **Tasks** tab of the admin console.
