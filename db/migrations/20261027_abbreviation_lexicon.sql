-- Abbreviation lexicon (2026-10-27) for the IG concept search — optional. Idempotent; apply
-- by hand after 20261023_umls_terms.sql. Filled by the umls_import job when the uploaded UMLS
-- file carries the SPECIALIST Lexicon's LRABR table (a subset written with
-- `node dist/loaders/umls.js --subset <umls.zip> <out.rrf.gz> <LRABR>`, or a full UMLS
-- release zip that contains LEX/LRABR).

BEGIN;

-- General biomedical abbreviations → expansions (SPECIALIST Lexicon LRABR). Only steers
-- matching: when a query abbreviation is unknown to the CodeSystem and the thesaurus, its
-- senses are ranked by how well the CodeSystem names them; never returned by a tool.
CREATE TABLE IF NOT EXISTS fhir.abbreviation_lexicon (
    key       TEXT NOT NULL,          -- abbreviation lower-cased (NFKC), punctuation kept
    abbr      TEXT NOT NULL,          -- as written in the source ("LP", "chole")
    expansion TEXT NOT NULL,
    kind      TEXT NOT NULL,          -- acronym | abbreviation
    source    TEXT NOT NULL DEFAULT 'LRABR',
    PRIMARY KEY (key, abbr, expansion)
);

COMMIT;
