-- LOINC structure for the admin terminology visualisation (2026-10).
--
-- Axis part links (LoincPartLink_Primary), answer lists (AnswerList +
-- LoincAnswerListLink), panel membership (PanelsAndForms; parent = immediate
-- parent panel) and MapTo replacements. Loaded by the staged loinc_import job
-- in the same promote transaction as loinc.concepts. Apply by hand on existing DBs.

BEGIN;

-- LOINC structure (20261020): part links per axis, answer lists, panels, MapTo.
-- Read by the admin terminology visualisation; loaded by the staged loinc_import.
CREATE TABLE IF NOT EXISTS loinc.part_links (
    loinc_num    TEXT NOT NULL,
    part_type    TEXT NOT NULL,             -- COMPONENT | PROPERTY | TIME | SYSTEM | SCALE | METHOD
    part_number  TEXT NOT NULL,             -- LP…
    part_name    TEXT,
    PRIMARY KEY (loinc_num, part_type, part_number)
);
CREATE INDEX IF NOT EXISTS idx_loinc_part_links_part ON loinc.part_links (part_number);

CREATE TABLE IF NOT EXISTS loinc.answer_list_items (
    list_id      TEXT NOT NULL,             -- LL…
    seq          INTEGER,
    answer_code  TEXT NOT NULL,             -- LA…
    display      TEXT,
    score        TEXT,
    PRIMARY KEY (list_id, answer_code)
);

CREATE TABLE IF NOT EXISTS loinc.answer_list_links (
    loinc_num    TEXT NOT NULL,
    list_id      TEXT NOT NULL,
    link_type    TEXT,                      -- NORMATIVE | EXAMPLE | PREFERRED
    context      TEXT NOT NULL DEFAULT '',  -- ApplicableContext (panel LOINC) or ''
    PRIMARY KEY (loinc_num, list_id, context)
);
CREATE INDEX IF NOT EXISTS idx_loinc_answer_list_links_list ON loinc.answer_list_links (list_id);

CREATE TABLE IF NOT EXISTS loinc.panel_items (
    parent_loinc TEXT NOT NULL,             -- immediate parent panel
    seq          INTEGER NOT NULL,
    loinc_num    TEXT NOT NULL,
    display      TEXT,
    required     TEXT,                      -- ObservationRequiredInPanel: R | O | C | …
    PRIMARY KEY (parent_loinc, loinc_num)
);
CREATE INDEX IF NOT EXISTS idx_loinc_panel_items_loinc ON loinc.panel_items (loinc_num);

CREATE TABLE IF NOT EXISTS loinc.map_to (
    loinc_num    TEXT NOT NULL,             -- deprecated / discouraged term
    map_to       TEXT NOT NULL,             -- replacement
    comment      TEXT,
    PRIMARY KEY (loinc_num, map_to)
);

-- LOINC structure staging (20261020_loinc_structure.sql)
CREATE TABLE IF NOT EXISTS admin.stage_loinc_part_links (
    job_id       UUID NOT NULL REFERENCES admin.import_jobs (job_id) ON DELETE CASCADE,
    loinc_num    TEXT NOT NULL,
    part_type    TEXT NOT NULL,
    part_number  TEXT NOT NULL,
    part_name    TEXT,
    PRIMARY KEY (job_id, loinc_num, part_type, part_number)
);
CREATE TABLE IF NOT EXISTS admin.stage_loinc_answer_list_items (
    job_id       UUID NOT NULL REFERENCES admin.import_jobs (job_id) ON DELETE CASCADE,
    list_id      TEXT NOT NULL,
    seq          INTEGER,
    answer_code  TEXT NOT NULL,
    display      TEXT,
    score        TEXT,
    PRIMARY KEY (job_id, list_id, answer_code)
);
CREATE TABLE IF NOT EXISTS admin.stage_loinc_answer_list_links (
    job_id       UUID NOT NULL REFERENCES admin.import_jobs (job_id) ON DELETE CASCADE,
    loinc_num    TEXT NOT NULL,
    list_id      TEXT NOT NULL,
    link_type    TEXT,
    context      TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (job_id, loinc_num, list_id, context)
);
CREATE TABLE IF NOT EXISTS admin.stage_loinc_panel_items (
    job_id       UUID NOT NULL REFERENCES admin.import_jobs (job_id) ON DELETE CASCADE,
    parent_loinc TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    loinc_num    TEXT NOT NULL,
    display      TEXT,
    required     TEXT,
    PRIMARY KEY (job_id, parent_loinc, loinc_num)
);
CREATE TABLE IF NOT EXISTS admin.stage_loinc_map_to (
    job_id       UUID NOT NULL REFERENCES admin.import_jobs (job_id) ON DELETE CASCADE,
    loinc_num    TEXT NOT NULL,
    map_to       TEXT NOT NULL,
    comment      TEXT,
    PRIMARY KEY (job_id, loinc_num, map_to)
);

COMMIT;
