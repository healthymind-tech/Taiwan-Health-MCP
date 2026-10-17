-- 20261019: record how each FHIR IG package was installed.
--
--   install_origin  'manual'     — an operator imported it (registry / upload root)
--                   'dependency' — fetched to satisfy another IG's dependencies
--   installed_for   {package_id, version} of the IG that pulled a dependency in
--                   (NULL for manual installs, or when it cannot be known)
--
-- Written by the ig_import job (admin/adminJobs.ts runIgImportJob) and the CLI
-- loader (loaders/ig.ts indexPackages). "manual" is sticky on re-import.
--
-- Idempotent. Apply by hand on existing databases (there is no migration runner):
--   psql -U mcp -d taiwan_health -f db/migrations/20261019_ig_install_origin.sql

ALTER TABLE fhir.ig_packages
    ADD COLUMN IF NOT EXISTS install_origin TEXT NOT NULL DEFAULT 'manual',
    ADD COLUMN IF NOT EXISTS installed_for  JSONB;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ig_packages_install_origin_check'
    ) THEN
        ALTER TABLE fhir.ig_packages
            ADD CONSTRAINT ig_packages_install_origin_check
            CHECK (install_origin IN ('manual', 'dependency'));
    END IF;
END $$;

-- ── Backfill for rows installed before this migration ──────────────────────
-- Heuristic, in order of precedence:
--   1. Job history. Every successful / partially successful ig_import job lists
--      the packages it promoted in result_summary_json.packages ("id@ver",
--      root first).
--        manual evidence     — the job's FIRST package, for a registry/upload
--                              job that was not supplying a missing dependency
--                              (no job_options.expected_package).
--        dependency evidence — any package of an ig_source='dependencies' job,
--                              the first package of an expected_package upload,
--                              or any package after the first of a root import
--                              (installed_for = that job's first package, or
--                              job_options.requested_for for dependency jobs).
--      Manual evidence wins (manual is sticky); otherwise the LATEST
--      dependency evidence decides installed_for (a package removed and
--      re-installed later belongs to the job that re-installed it; installed
--      packages are never re-fetched as dependencies, so the latest job is the
--      one that created the current row).
--   2. No job evidence (history pruned, CLI-loaded): 'dependency' when another
--      installed package declares it as a direct dependency (hl7.fhir.r4.core
--      4.0.0 counts as 4.0.1, matching the registry alias), installed_for left
--      NULL; otherwise 'manual' (the column default).
-- Only rows still at the default ('manual' with no installed_for) are touched,
-- so re-running the migration does not undo later corrections.

WITH job_pkgs AS (
    SELECT j.created_at,
           COALESCE(j.job_options_json->>'ig_source', 'upload') AS src,
           j.job_options_json ? 'expected_package'               AS supplies_dep,
           j.job_options_json->'requested_for'                    AS requested_for,
           j.result_summary_json->'packages'->>0                  AS root_label,
           p.label,
           p.ord
      FROM admin.import_jobs j
     CROSS JOIN LATERAL jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(j.result_summary_json->'packages') = 'array'
                    THEN j.result_summary_json->'packages' ELSE '[]'::jsonb END
           ) WITH ORDINALITY AS p(label, ord)
     WHERE j.job_type = 'ig_import'
       AND j.status IN ('success', 'partial_success')
),
evidence AS (
    SELECT split_part(label, '@', 1)                              AS package_id,
           substring(label FROM position('@' IN label) + 1)       AS version,
           created_at,
           CASE WHEN src <> 'dependencies' AND ord = 1 AND NOT supplies_dep
                THEN 'manual' ELSE 'dependency' END               AS origin,
           CASE
               WHEN src = 'dependencies' OR (ord = 1 AND supplies_dep) THEN
                   CASE WHEN jsonb_typeof(requested_for) = 'object' THEN requested_for END
               WHEN ord > 1 THEN
                   jsonb_build_object(
                       'package_id', split_part(root_label, '@', 1),
                       'version',    substring(root_label FROM position('@' IN root_label) + 1))
           END                                                    AS installed_for
      FROM job_pkgs
     WHERE position('@' IN label) > 1
),
decided AS (
    SELECT DISTINCT ON (package_id, version)
           package_id, version, origin, installed_for
      FROM evidence
     ORDER BY package_id, version,
              (origin = 'manual') DESC,   -- any manual evidence wins
              created_at DESC             -- else the latest install
)
UPDATE fhir.ig_packages g
   SET install_origin = d.origin,
       installed_for  = CASE WHEN d.origin = 'dependency' THEN d.installed_for END
  FROM decided d
 WHERE g.package_id = d.package_id
   AND g.version = d.version
   AND g.install_origin = 'manual'
   AND g.installed_for IS NULL;

-- Rule 2: no job evidence, but another installed IG depends on it directly.
WITH evidenced AS (
    SELECT DISTINCT split_part(p.label, '@', 1) AS package_id,
                    substring(p.label FROM position('@' IN p.label) + 1) AS version
      FROM admin.import_jobs j
     CROSS JOIN LATERAL jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(j.result_summary_json->'packages') = 'array'
                    THEN j.result_summary_json->'packages' ELSE '[]'::jsonb END
           ) AS p(label)
     WHERE j.job_type = 'ig_import'
       AND j.status IN ('success', 'partial_success')
),
declared AS (
    SELECT d.key AS package_id,
           CASE WHEN d.key = 'hl7.fhir.r4.core' AND d.value = '4.0.0' THEN '4.0.1' ELSE d.value END AS version,
           g.package_id AS dependent_id
      FROM fhir.ig_packages g
     CROSS JOIN LATERAL jsonb_each_text(
               CASE WHEN jsonb_typeof(g.dependencies) = 'object' THEN g.dependencies ELSE '{}'::jsonb END
           ) AS d(key, value)
)
UPDATE fhir.ig_packages g
   SET install_origin = 'dependency'
 WHERE g.install_origin = 'manual'
   AND g.installed_for IS NULL
   AND NOT EXISTS (SELECT 1 FROM evidenced e WHERE e.package_id = g.package_id AND e.version = g.version)
   AND EXISTS (
       SELECT 1 FROM declared x
        WHERE x.package_id = g.package_id AND x.version = g.version AND x.dependent_id <> g.package_id
   );
