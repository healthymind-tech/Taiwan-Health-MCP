-- Clinical Guideline PDF import / Analysis LM extraction pipeline.
-- Mirrors the drug pipeline's insert_analysis staging shape, plus a
-- mandatory human-review gate: extracted data never reaches the live
-- disease_guidelines/* tables until review_status is flipped to 'approved'
-- via the admin review endpoints (unlike the drug pipeline, which
-- auto-commits LLM output).
--
-- The Analysis LM determines the disease(s)/ICD-10-CM code(s) itself from
-- the document content — a source document is a pure upload record with no
-- declared ICD code, and one document can fan out into multiple
-- document_analysis rows (one per disease the LLM identified). Review/
-- approve/reject operate on analysis_id (one disease), not document_id
-- (one PDF).

CREATE TABLE IF NOT EXISTS guideline.source_documents (
    document_id       UUID PRIMARY KEY,
    uploaded_file_id  UUID NOT NULL REFERENCES admin.uploaded_files (uploaded_file_id) ON DELETE CASCADE,
    source_filename   TEXT NOT NULL,
    bucket            TEXT,
    object_key        TEXT,
    minio_uri         TEXT,
    sha256            TEXT,
    size_bytes        BIGINT,
    -- queued|ocr_running|ocr_failed|analysis_running|analysis_failed|pending_review|approved|rejected
    pipeline_stage    TEXT NOT NULL DEFAULT 'queued',
    uploaded_by       TEXT,
    uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gl_source_docs_stage ON guideline.source_documents (pipeline_stage);

CREATE TABLE IF NOT EXISTS guideline.document_analysis (
    analysis_id            UUID PRIMARY KEY,
    document_id            UUID NOT NULL REFERENCES guideline.source_documents (document_id) ON DELETE CASCADE,
    ocr_object_key         TEXT,
    analysis_object_key    TEXT,
    ocr_provider           TEXT,
    analysis_provider      TEXT,
    ocr_status             TEXT NOT NULL DEFAULT 'pending',
    analysis_status        TEXT NOT NULL DEFAULT 'pending',
    normalized_json        JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Denormalized from normalized_json.disease_info for listing/sorting without
    -- unpacking JSONB, and to know before opening a row whether disease_info.icd_code
    -- exact-matched icd.diagnoses at extraction time (a display hint only — approval
    -- re-checks the resolved code server-side regardless of this flag).
    extracted_icd_code     TEXT,
    extracted_disease_name TEXT,
    icd_code_known         BOOLEAN,
    last_error_code        TEXT,
    last_error_message     TEXT,
    last_attempt_at        TIMESTAMPTZ,
    completed_at           TIMESTAMPTZ,
    -- pending_review|approved|rejected
    review_status          TEXT NOT NULL DEFAULT 'pending_review',
    reviewed_by            TEXT,
    reviewed_at            TIMESTAMPTZ,
    review_notes           TEXT,
    edited_json            JSONB,
    produced_guideline_id  INTEGER REFERENCES guideline.disease_guidelines (id) ON DELETE SET NULL,
    -- A previously-approved row for the same resolved icd_code, superseded by this one.
    superseded_by          UUID REFERENCES guideline.document_analysis (analysis_id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_gl_doc_analysis_document ON guideline.document_analysis (document_id);
CREATE INDEX IF NOT EXISTS idx_gl_doc_analysis_review   ON guideline.document_analysis (review_status);
CREATE INDEX IF NOT EXISTS idx_gl_doc_analysis_icd      ON guideline.document_analysis (extracted_icd_code);

ALTER TABLE guideline.disease_guidelines
    ADD COLUMN IF NOT EXISTS source_analysis_id UUID REFERENCES guideline.document_analysis (analysis_id) ON DELETE SET NULL;

-- Enforce one live row per ICD code (see guidelineService.ts::getCompleteGuideline,
-- which takes rows[0] and would silently serve stale data if duplicates existed).
-- Verify no duplicates exist before this runs against an existing deployment:
--   SELECT icd_code, COUNT(*) FROM guideline.disease_guidelines GROUP BY icd_code HAVING COUNT(*) > 1;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_gl_disease_icd'
    ) THEN
        ALTER TABLE guideline.disease_guidelines ADD CONSTRAINT uq_gl_disease_icd UNIQUE (icd_code);
    END IF;
END $$;
