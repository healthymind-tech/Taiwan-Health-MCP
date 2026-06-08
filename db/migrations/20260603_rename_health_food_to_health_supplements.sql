-- Rename the Taiwan FDA Health Food dataset to Health Supplements.
-- Idempotent: safe to run on a fresh database or one already migrated.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.schemata WHERE schema_name = 'health_food'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.schemata WHERE schema_name = 'health_supplements'
    ) THEN
        ALTER SCHEMA health_food RENAME TO health_supplements;
    ELSIF NOT EXISTS (
        SELECT 1 FROM information_schema.schemata WHERE schema_name = 'health_supplements'
    ) THEN
        CREATE SCHEMA health_supplements;
    END IF;
END $$;

ALTER INDEX IF EXISTS health_supplements.idx_hf_fts RENAME TO idx_hs_fts;
ALTER INDEX IF EXISTS health_supplements.idx_hf_emb_hnsw RENAME TO idx_hs_emb_hnsw;

UPDATE admin.dataset_schedules
SET dataset_key = 'health_supplements',
    fetch_url = 'https://data.fda.gov.tw/data/opendata/export/19/json',
    updated_at = NOW()
WHERE dataset_key = 'health_food'
  AND NOT EXISTS (
      SELECT 1 FROM admin.dataset_schedules WHERE dataset_key = 'health_supplements'
  );

DELETE FROM admin.dataset_schedules
WHERE dataset_key = 'health_food'
  AND EXISTS (
      SELECT 1 FROM admin.dataset_schedules WHERE dataset_key = 'health_supplements'
  );

UPDATE admin.dataset_load_log
SET dataset_key = 'health_supplements'
WHERE dataset_key = 'health_food'
  AND NOT EXISTS (
      SELECT 1 FROM admin.dataset_load_log WHERE dataset_key = 'health_supplements'
  );

DELETE FROM admin.dataset_load_log
WHERE dataset_key = 'health_food'
  AND EXISTS (
      SELECT 1 FROM admin.dataset_load_log WHERE dataset_key = 'health_supplements'
  );

UPDATE admin.import_jobs
SET dataset_key = 'health_supplements'
WHERE dataset_key = 'health_food';

UPDATE admin.import_jobs
SET job_type = CASE job_type
    WHEN 'health_food_sync' THEN 'health_supplements_sync'
    WHEN 'health_food_embed' THEN 'health_supplements_embed'
    ELSE job_type
END
WHERE job_type IN ('health_food_sync', 'health_food_embed');

