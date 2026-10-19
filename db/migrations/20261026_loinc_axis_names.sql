-- LOINC axis vocabulary for search (2026-10-26). Idempotent; apply by hand after
-- 20261025_loinc_component_names.sql, then re-run the LOINC import (admin → 醫療術語 → LOINC)
-- so the table is filled from the release zip (Part.csv part / display names + Loinc.csv
-- RELATEDNAMES2; written after the promote). Until then search_loinc ranks without axis
-- constraints (as before).

BEGIN;

-- Names of the values of the SYSTEM / TIME / METHOD / PROPERTY / SCALE axes: "Venous blood"
-- / "Venous" for SYSTEM BldV, "24 hours" / "24HR" for TIME 24H, "Dipstick" for METHOD
-- Test strip, "Percent" for the fraction properties. Built by loincAxisNames.ts; search
-- reads the whole table into memory (a few thousand rows) and matches query words against
-- name_key.
CREATE TABLE IF NOT EXISTS loinc.axis_names (
    axis         TEXT NOT NULL,             -- system | time | method | property | scale
    value        TEXT NOT NULL,             -- the loinc.concepts column value ("BldV", "24H")
    name         TEXT NOT NULL,
    name_key     TEXT NOT NULL,             -- normalised lookup key (loincAxisNames.axisKey)
    source       TEXT NOT NULL,             -- part | display | related | word
    PRIMARY KEY (axis, value, name_key)
);

COMMIT;
