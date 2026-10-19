-- LOINC common-test / common-order ranks (2026-10-24). Idempotent; apply by hand after
-- 20261023_umls_terms.sql, then re-run the LOINC import (admin → 醫療術語 → LOINC) so the
-- ranks are filled from Loinc.csv. Until then the columns stay NULL and search_loinc
-- simply ranks without the prior.

BEGIN;

-- Regenstrief usage ranks (Loinc.csv COMMON_TEST_RANK / COMMON_ORDER_RANK; 1 = most
-- common, NULL = not ranked). search_loinc / fhir_normalize_code use the test rank as a
-- weak prior so a short query ("hemoglobin") prefers the commonly resulted term.
ALTER TABLE loinc.concepts ADD COLUMN IF NOT EXISTS common_test_rank INTEGER;
ALTER TABLE loinc.concepts ADD COLUMN IF NOT EXISTS common_order_rank INTEGER;

ALTER TABLE admin.stage_loinc_concepts ADD COLUMN IF NOT EXISTS common_test_rank INTEGER;
ALTER TABLE admin.stage_loinc_concepts ADD COLUMN IF NOT EXISTS common_order_rank INTEGER;

COMMIT;
