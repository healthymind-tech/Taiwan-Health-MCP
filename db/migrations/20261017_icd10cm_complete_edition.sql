-- ICD-10-CM complete code set (2026-10).
--
-- The ICD-10-CM loader now imports the full CMS code set — header codes plus
-- billable codes including 7th characters / placeholder X (S93.411A, S06.0X0A) —
-- from the CMS "Code Descriptions in Tabular Order" zip. It keeps the CMS short
-- title (tx.fhir.org accepts it as a synonym display) and the header flag, and
-- records which edition is loaded so the FHIR validator only reports
-- "Unknown code" errors when the local table is the complete, current edition.

BEGIN;

ALTER TABLE icd.diagnoses
    ADD COLUMN IF NOT EXISTS short_name_en TEXT,
    ADD COLUMN IF NOT EXISTS is_header     BOOLEAN;

ALTER TABLE admin.stage_icd_diagnoses
    ADD COLUMN IF NOT EXISTS short_name_en TEXT,
    ADD COLUMN IF NOT EXISTS is_header     BOOLEAN;

CREATE TABLE IF NOT EXISTS icd.editions (
    code_system   TEXT PRIMARY KEY,            -- 'icd-10-cm'
    edition       TEXT NOT NULL,               -- '2026-04-01' (tx.fhir.org style) or 'FY2026'
    source_format TEXT NOT NULL,               -- 'cms-order' | 'tabular-xml'
    complete      BOOLEAN NOT NULL,            -- exact CMS code set (order file, >= 90k rows)
    code_count    INTEGER NOT NULL,
    loaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
