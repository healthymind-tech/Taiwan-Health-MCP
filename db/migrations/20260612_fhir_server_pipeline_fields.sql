-- FHIR server registration pipeline: optional metadata fields.
-- environment drives Production safety prompts in the admin UI (test
-- confirmation, DELETE disabled by default); display_name and tags are
-- operator conveniences. All nullable/defaulted so existing rows are unaffected.
ALTER TABLE admin.fhir_servers
    ADD COLUMN IF NOT EXISTS display_name TEXT,
    ADD COLUMN IF NOT EXISTS environment TEXT,
    ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb;
