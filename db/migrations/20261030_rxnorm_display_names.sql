-- RxNorm for the FHIR validator (validator v7): every SAB=RXNORM atom string of
-- an RXCUI (PSN / SY / TMSY …, which tx.fhir.org accepts as Coding.display) and
-- the loaded release (unknown RXCUI is an error only when the local release is
-- at least the one tx.fhir.org serves). Filled by the next `rxnorm_import`;
-- until then alt_names is NULL and the validator only warns on display
-- mismatches. The rxnorm_import job also applies these statements itself
-- (idempotent), so a re-import works before this file is applied by hand.
ALTER TABLE rxnorm.concepts ADD COLUMN IF NOT EXISTS alt_names TEXT[];
ALTER TABLE admin.stage_rxnorm_concepts ADD COLUMN IF NOT EXISTS alt_names TEXT[];

CREATE TABLE IF NOT EXISTS rxnorm.editions (
    code_system    TEXT PRIMARY KEY,      -- 'rxnorm'
    version        TEXT NOT NULL,         -- 'MMDDYYYY' (as tx.fhir.org reports it)
    release_date   DATE,
    concept_count  INTEGER,
    loaded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
