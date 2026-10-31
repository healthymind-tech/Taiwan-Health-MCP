-- ISSUES_v17.3 (v17 R1.3): IG self-check results — profiles whose own example instances fail validation.
-- Written by the ig_selfcheck job (node-server/src/igKnownDefects.ts), which also creates these tables at
-- runtime when missing; keep this file, db/schema.sql and ensureKnownDefectsSchema() in step.
CREATE TABLE IF NOT EXISTS fhir.ig_selfcheck_runs (
    package_id TEXT NOT NULL,
    package_version TEXT NOT NULL,
    selfcheck_version TEXT NOT NULL,
    examples_total INTEGER NOT NULL,
    examples_valid INTEGER NOT NULL,
    defects INTEGER NOT NULL,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (package_id, package_version)
);

CREATE TABLE IF NOT EXISTS fhir.ig_known_defects (
    package_id TEXT NOT NULL,
    package_version TEXT NOT NULL,
    profile TEXT NOT NULL,
    element TEXT NOT NULL,
    rule TEXT NOT NULL,
    reason TEXT NOT NULL,
    examples JSONB NOT NULL DEFAULT '[]'::jsonb,
    failing INTEGER NOT NULL,
    total INTEGER NOT NULL,
    known_invalid BOOLEAN NOT NULL,
    PRIMARY KEY (package_id, package_version, profile, element, rule)
);
