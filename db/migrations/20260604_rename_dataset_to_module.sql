-- Rename the runtime "dataset" registry concept to "module" across the admin
-- control plane. Data-preserving: ALTER ... RENAME keeps all rows, FKs, and
-- index contents. Run once against an existing database; db/schema.sql already
-- carries the new names for fresh installs.
--
-- Scope: admin.* tables/columns/indexes/constraints only. The loader's source
-- config concept (DATASETS_CONFIG env var, config/datasets.yaml,
-- loader/dataset_config.py) is intentionally NOT renamed.

BEGIN;

-- ── tables ──────────────────────────────────────────────────────────────────
ALTER TABLE admin.dataset_sources    RENAME TO module_sources;
ALTER TABLE admin.dataset_load_log   RENAME TO module_load_log;
ALTER TABLE admin.dataset_schedules  RENAME TO module_schedules;

-- ── columns ─────────────────────────────────────────────────────────────────
ALTER TABLE admin.module_sources  RENAME COLUMN dataset_key       TO module_key;
ALTER TABLE admin.module_sources  RENAME COLUMN dataset_source_id TO module_source_id;
ALTER TABLE admin.module_load_log RENAME COLUMN dataset_key       TO module_key;
ALTER TABLE admin.module_schedules RENAME COLUMN dataset_key      TO module_key;
ALTER TABLE admin.uploaded_files  RENAME COLUMN dataset_key       TO module_key;
ALTER TABLE admin.import_jobs     RENAME COLUMN dataset_key              TO module_key;
ALTER TABLE admin.import_jobs     RENAME COLUMN source_dataset_source_id TO source_module_source_id;

-- ── standalone indexes ──────────────────────────────────────────────────────
ALTER INDEX admin.idx_admin_dataset_sources_lookup        RENAME TO idx_admin_module_sources_lookup;
ALTER INDEX admin.idx_admin_dataset_schedules_enabled_next RENAME TO idx_admin_module_schedules_enabled_next;
ALTER INDEX admin.idx_admin_import_jobs_dataset           RENAME TO idx_admin_import_jobs_module;

-- ── named constraints (cosmetic parity with a fresh schema.sql install) ──────
ALTER TABLE admin.module_load_log  RENAME CONSTRAINT dataset_load_log_pkey                 TO module_load_log_pkey;
ALTER TABLE admin.module_schedules RENAME CONSTRAINT dataset_schedules_pkey                TO module_schedules_pkey;
ALTER TABLE admin.module_schedules RENAME CONSTRAINT dataset_schedules_dataset_key_key     TO module_schedules_module_key_key;
ALTER TABLE admin.module_schedules RENAME CONSTRAINT dataset_schedules_last_run_job_id_fkey TO module_schedules_last_run_job_id_fkey;
ALTER TABLE admin.module_sources   RENAME CONSTRAINT dataset_sources_pkey                  TO module_sources_pkey;
ALTER TABLE admin.module_sources   RENAME CONSTRAINT dataset_sources_uploaded_file_id_fkey TO module_sources_uploaded_file_id_fkey;
ALTER TABLE admin.import_jobs      RENAME CONSTRAINT import_jobs_source_dataset_source_id_fkey TO import_jobs_source_module_source_id_fkey;

COMMIT;
