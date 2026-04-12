-- No-data-loss migration for drug domain hardening.
-- Goals:
-- 1) Merge legacy rxnorm.* data into drug.rx_* tables (idempotent).
-- 2) Preserve any rows that would violate new constraints in migration_backup.*
-- 3) Add integrity constraints / indexes without losing recoverability.
--
-- Run with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/2026-04-12_drug_schema_no_loss.sql

BEGIN;

CREATE SCHEMA IF NOT EXISTS migration_backup;

-- ---------------------------------------------------------------------------
-- Ensure target RxNorm tables exist under drug schema.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS drug.rx_concepts (
    rxcui       TEXT PRIMARY KEY,
    name        TEXT,
    tty         TEXT,
    suppress    TEXT
);

CREATE TABLE IF NOT EXISTS drug.rx_relationships (
    rxcui1      TEXT,
    rel         TEXT,
    rxcui2      TEXT,
    rela        TEXT
);

CREATE TABLE IF NOT EXISTS drug.rx_atc_map (
    rxcui       TEXT NOT NULL,
    atc_code    TEXT NOT NULL,
    atc_name    TEXT,
    source_sab  TEXT DEFAULT 'ATC',
    suppress    TEXT,
    PRIMARY KEY (rxcui, atc_code)
);

-- ---------------------------------------------------------------------------
-- Backup tables (append-only) for migration-side removals/normalizations.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS migration_backup.drug_appearance_removed (
    backup_id    BIGSERIAL PRIMARY KEY,
    license_id   TEXT,
    shape        TEXT,
    color        TEXT,
    marking      TEXT,
    image_url    TEXT,
    reason       TEXT NOT NULL,
    removed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS migration_backup.drug_ingredients_removed (
    backup_id         BIGSERIAL PRIMARY KEY,
    license_id        TEXT,
    ingredient_name   TEXT,
    ingredient_qty    TEXT,
    ingredient_unit   TEXT,
    reason            TEXT NOT NULL,
    removed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS migration_backup.drug_atc_removed (
    backup_id    BIGSERIAL PRIMARY KEY,
    license_id   TEXT,
    atc_code     TEXT,
    atc_name     TEXT,
    reason       TEXT NOT NULL,
    removed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS migration_backup.drug_documents_removed (
    backup_id    BIGSERIAL PRIMARY KEY,
    license_id   TEXT,
    doc_type     TEXT,
    doc_url      TEXT,
    reason       TEXT NOT NULL,
    removed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS migration_backup.drug_rx_relationships_removed (
    backup_id      BIGSERIAL PRIMARY KEY,
    rxcui1         TEXT,
    rel            TEXT,
    rxcui2         TEXT,
    rela           TEXT,
    source_table   TEXT NOT NULL,
    reason         TEXT NOT NULL,
    removed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Normalize child-table license IDs (trim whitespace), then create placeholders
-- for orphan license IDs so foreign keys can be enforced without dropping rows.
-- ---------------------------------------------------------------------------

UPDATE drug.appearance
SET license_id = btrim(license_id)
WHERE license_id IS NOT NULL AND license_id <> btrim(license_id);

UPDATE drug.ingredients
SET license_id = btrim(license_id)
WHERE license_id IS NOT NULL AND license_id <> btrim(license_id);

UPDATE drug.atc
SET license_id = btrim(license_id)
WHERE license_id IS NOT NULL AND license_id <> btrim(license_id);

UPDATE drug.documents
SET license_id = btrim(license_id)
WHERE license_id IS NOT NULL AND license_id <> btrim(license_id);

CREATE TEMP TABLE tmp_missing_drug_license_ids ON COMMIT DROP AS
SELECT DISTINCT license_id
FROM (
    SELECT license_id FROM drug.appearance
    UNION ALL
    SELECT license_id FROM drug.ingredients
    UNION ALL
    SELECT license_id FROM drug.atc
    UNION ALL
    SELECT license_id FROM drug.documents
) src
WHERE license_id IS NOT NULL
  AND btrim(license_id) <> ''
EXCEPT
SELECT license_id FROM drug.licenses;

INSERT INTO drug.licenses (
    license_id,
    name_zh,
    name_en,
    indication,
    form,
    package,
    category,
    manufacturer,
    valid_date,
    usage
)
SELECT
    m.license_id,
    '[MIGRATION PLACEHOLDER]',
    '',
    '',
    '',
    '',
    '',
    '[AUTO-CREATED FOR FK INTEGRITY]',
    '',
    ''
FROM tmp_missing_drug_license_ids m
ON CONFLICT (license_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Backup+remove rows with blank/null license_id (cannot satisfy NOT NULL + FK).
-- ---------------------------------------------------------------------------

WITH invalid AS (
    SELECT ctid, license_id, shape, color, marking, image_url
    FROM drug.appearance
    WHERE license_id IS NULL OR btrim(license_id) = ''
)
INSERT INTO migration_backup.drug_appearance_removed
    (license_id, shape, color, marking, image_url, reason)
SELECT license_id, shape, color, marking, image_url, 'missing_license_id'
FROM invalid;

WITH invalid AS (
    SELECT ctid
    FROM drug.appearance
    WHERE license_id IS NULL OR btrim(license_id) = ''
)
DELETE FROM drug.appearance a
USING invalid i
WHERE a.ctid = i.ctid;

WITH invalid AS (
    SELECT ctid, license_id, ingredient_name, ingredient_qty, ingredient_unit
    FROM drug.ingredients
    WHERE license_id IS NULL OR btrim(license_id) = ''
)
INSERT INTO migration_backup.drug_ingredients_removed
    (license_id, ingredient_name, ingredient_qty, ingredient_unit, reason)
SELECT license_id, ingredient_name, ingredient_qty, ingredient_unit, 'missing_license_id'
FROM invalid;

WITH invalid AS (
    SELECT ctid
    FROM drug.ingredients
    WHERE license_id IS NULL OR btrim(license_id) = ''
)
DELETE FROM drug.ingredients t
USING invalid i
WHERE t.ctid = i.ctid;

WITH invalid AS (
    SELECT ctid, license_id, atc_code, atc_name
    FROM drug.atc
    WHERE license_id IS NULL OR btrim(license_id) = ''
)
INSERT INTO migration_backup.drug_atc_removed
    (license_id, atc_code, atc_name, reason)
SELECT license_id, atc_code, atc_name, 'missing_license_id'
FROM invalid;

WITH invalid AS (
    SELECT ctid
    FROM drug.atc
    WHERE license_id IS NULL OR btrim(license_id) = ''
)
DELETE FROM drug.atc t
USING invalid i
WHERE t.ctid = i.ctid;

WITH invalid AS (
    SELECT ctid, license_id, doc_type, doc_url
    FROM drug.documents
    WHERE license_id IS NULL OR btrim(license_id) = ''
)
INSERT INTO migration_backup.drug_documents_removed
    (license_id, doc_type, doc_url, reason)
SELECT license_id, doc_type, doc_url, 'missing_license_id'
FROM invalid;

WITH invalid AS (
    SELECT ctid
    FROM drug.documents
    WHERE license_id IS NULL OR btrim(license_id) = ''
)
DELETE FROM drug.documents t
USING invalid i
WHERE t.ctid = i.ctid;

-- ---------------------------------------------------------------------------
-- Normalize documents.doc_type to 'insert' (backup rows that were normalized).
-- ---------------------------------------------------------------------------

INSERT INTO migration_backup.drug_documents_removed
    (license_id, doc_type, doc_url, reason)
SELECT
    license_id,
    doc_type,
    doc_url,
    'doc_type_normalized_to_insert'
FROM drug.documents
WHERE COALESCE(NULLIF(btrim(doc_type), ''), 'insert') <> 'insert';

UPDATE drug.documents
SET doc_type = 'insert'
WHERE doc_type IS NULL
   OR btrim(doc_type) = ''
   OR btrim(doc_type) <> 'insert';

-- ---------------------------------------------------------------------------
-- Deduplicate child tables against the new unique-index identity.
-- ---------------------------------------------------------------------------

WITH ranked AS (
    SELECT
        ctid,
        license_id,
        shape,
        color,
        marking,
        image_url,
        ROW_NUMBER() OVER (
            PARTITION BY license_id, COALESCE(shape, ''), COALESCE(color, ''),
                         COALESCE(marking, ''), COALESCE(image_url, '')
            ORDER BY ctid
        ) AS rn
    FROM drug.appearance
)
INSERT INTO migration_backup.drug_appearance_removed
    (license_id, shape, color, marking, image_url, reason)
SELECT license_id, shape, color, marking, image_url, 'duplicate_exact'
FROM ranked
WHERE rn > 1;

WITH dup AS (
    SELECT ctid
    FROM (
        SELECT
            ctid,
            ROW_NUMBER() OVER (
                PARTITION BY license_id, COALESCE(shape, ''), COALESCE(color, ''),
                             COALESCE(marking, ''), COALESCE(image_url, '')
                ORDER BY ctid
            ) AS rn
        FROM drug.appearance
    ) q
    WHERE rn > 1
)
DELETE FROM drug.appearance t
USING dup
WHERE t.ctid = dup.ctid;

WITH ranked AS (
    SELECT
        ctid,
        license_id,
        ingredient_name,
        ingredient_qty,
        ingredient_unit,
        ROW_NUMBER() OVER (
            PARTITION BY license_id, COALESCE(ingredient_name, ''),
                         COALESCE(ingredient_qty, ''), COALESCE(ingredient_unit, '')
            ORDER BY ctid
        ) AS rn
    FROM drug.ingredients
)
INSERT INTO migration_backup.drug_ingredients_removed
    (license_id, ingredient_name, ingredient_qty, ingredient_unit, reason)
SELECT license_id, ingredient_name, ingredient_qty, ingredient_unit, 'duplicate_exact'
FROM ranked
WHERE rn > 1;

WITH dup AS (
    SELECT ctid
    FROM (
        SELECT
            ctid,
            ROW_NUMBER() OVER (
                PARTITION BY license_id, COALESCE(ingredient_name, ''),
                             COALESCE(ingredient_qty, ''), COALESCE(ingredient_unit, '')
                ORDER BY ctid
            ) AS rn
        FROM drug.ingredients
    ) q
    WHERE rn > 1
)
DELETE FROM drug.ingredients t
USING dup
WHERE t.ctid = dup.ctid;

WITH ranked AS (
    SELECT
        ctid,
        license_id,
        atc_code,
        atc_name,
        ROW_NUMBER() OVER (
            PARTITION BY license_id, COALESCE(atc_code, ''), COALESCE(atc_name, '')
            ORDER BY ctid
        ) AS rn
    FROM drug.atc
)
INSERT INTO migration_backup.drug_atc_removed
    (license_id, atc_code, atc_name, reason)
SELECT license_id, atc_code, atc_name, 'duplicate_exact'
FROM ranked
WHERE rn > 1;

WITH dup AS (
    SELECT ctid
    FROM (
        SELECT
            ctid,
            ROW_NUMBER() OVER (
                PARTITION BY license_id, COALESCE(atc_code, ''), COALESCE(atc_name, '')
                ORDER BY ctid
            ) AS rn
        FROM drug.atc
    ) q
    WHERE rn > 1
)
DELETE FROM drug.atc t
USING dup
WHERE t.ctid = dup.ctid;

WITH ranked AS (
    SELECT
        ctid,
        license_id,
        doc_type,
        doc_url,
        ROW_NUMBER() OVER (
            PARTITION BY license_id, doc_type, COALESCE(doc_url, '')
            ORDER BY ctid
        ) AS rn
    FROM drug.documents
)
INSERT INTO migration_backup.drug_documents_removed
    (license_id, doc_type, doc_url, reason)
SELECT license_id, doc_type, doc_url, 'duplicate_exact'
FROM ranked
WHERE rn > 1;

WITH dup AS (
    SELECT ctid
    FROM (
        SELECT
            ctid,
            ROW_NUMBER() OVER (
                PARTITION BY license_id, doc_type, COALESCE(doc_url, '')
                ORDER BY ctid
            ) AS rn
        FROM drug.documents
    ) q
    WHERE rn > 1
)
DELETE FROM drug.documents t
USING dup
WHERE t.ctid = dup.ctid;

-- ---------------------------------------------------------------------------
-- Migrate legacy rxnorm.* into drug.rx_* (if legacy schema is present).
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'rxnorm' AND table_name = 'concepts'
    ) THEN
        INSERT INTO drug.rx_concepts (rxcui, name, tty, suppress)
        SELECT
            btrim(rxcui),
            name,
            tty,
            suppress
        FROM rxnorm.concepts
        WHERE rxcui IS NOT NULL AND btrim(rxcui) <> ''
        ON CONFLICT (rxcui) DO UPDATE
        SET name = EXCLUDED.name,
            tty = EXCLUDED.tty,
            suppress = EXCLUDED.suppress;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'rxnorm' AND table_name = 'relationships'
    ) THEN
        INSERT INTO migration_backup.drug_rx_relationships_removed
            (rxcui1, rel, rxcui2, rela, source_table, reason)
        SELECT
            rxcui1,
            rel,
            rxcui2,
            rela,
            'rxnorm.relationships',
            'missing_required_field'
        FROM rxnorm.relationships
        WHERE rxcui1 IS NULL OR btrim(rxcui1) = ''
           OR rel IS NULL OR btrim(rel) = ''
           OR rxcui2 IS NULL OR btrim(rxcui2) = '';

        INSERT INTO drug.rx_relationships (rxcui1, rel, rxcui2, rela)
        SELECT
            btrim(rxcui1),
            btrim(rel),
            btrim(rxcui2),
            COALESCE(btrim(rela), '')
        FROM rxnorm.relationships
        WHERE rxcui1 IS NOT NULL AND btrim(rxcui1) <> ''
          AND rel IS NOT NULL AND btrim(rel) <> ''
          AND rxcui2 IS NOT NULL AND btrim(rxcui2) <> ''
        ON CONFLICT DO NOTHING;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Clean and deduplicate drug.rx_relationships before NOT NULL + unique index.
-- ---------------------------------------------------------------------------

UPDATE drug.rx_relationships
SET
    rxcui1 = btrim(rxcui1),
    rel = btrim(rel),
    rxcui2 = btrim(rxcui2),
    rela = COALESCE(btrim(rela), '');

INSERT INTO migration_backup.drug_rx_relationships_removed
    (rxcui1, rel, rxcui2, rela, source_table, reason)
SELECT
    rxcui1,
    rel,
    rxcui2,
    rela,
    'drug.rx_relationships',
    'missing_required_field'
FROM drug.rx_relationships
WHERE rxcui1 IS NULL OR btrim(rxcui1) = ''
   OR rel IS NULL OR btrim(rel) = ''
   OR rxcui2 IS NULL OR btrim(rxcui2) = '';

WITH invalid AS (
    SELECT ctid
    FROM drug.rx_relationships
    WHERE rxcui1 IS NULL OR btrim(rxcui1) = ''
       OR rel IS NULL OR btrim(rel) = ''
       OR rxcui2 IS NULL OR btrim(rxcui2) = ''
)
DELETE FROM drug.rx_relationships t
USING invalid i
WHERE t.ctid = i.ctid;

WITH ranked AS (
    SELECT
        ctid,
        rxcui1,
        rel,
        rxcui2,
        rela,
        ROW_NUMBER() OVER (
            PARTITION BY rxcui1, rel, rxcui2, COALESCE(rela, '')
            ORDER BY ctid
        ) AS rn
    FROM drug.rx_relationships
)
INSERT INTO migration_backup.drug_rx_relationships_removed
    (rxcui1, rel, rxcui2, rela, source_table, reason)
SELECT
    rxcui1,
    rel,
    rxcui2,
    rela,
    'drug.rx_relationships',
    'duplicate_exact'
FROM ranked
WHERE rn > 1;

WITH dup AS (
    SELECT ctid
    FROM (
        SELECT
            ctid,
            ROW_NUMBER() OVER (
                PARTITION BY rxcui1, rel, rxcui2, COALESCE(rela, '')
                ORDER BY ctid
            ) AS rn
        FROM drug.rx_relationships
    ) q
    WHERE rn > 1
)
DELETE FROM drug.rx_relationships t
USING dup
WHERE t.ctid = dup.ctid;

UPDATE drug.rx_relationships
SET rela = ''
WHERE rela IS NULL;

-- ---------------------------------------------------------------------------
-- Add constraints safely (idempotent checks guard existing fresh installs).
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE contype = 'f'
          AND conrelid = 'drug.appearance'::regclass
          AND confrelid = 'drug.licenses'::regclass
    ) THEN
        ALTER TABLE drug.appearance
        ADD CONSTRAINT fk_drug_appearance_license
        FOREIGN KEY (license_id) REFERENCES drug.licenses (license_id) ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE contype = 'f'
          AND conrelid = 'drug.ingredients'::regclass
          AND confrelid = 'drug.licenses'::regclass
    ) THEN
        ALTER TABLE drug.ingredients
        ADD CONSTRAINT fk_drug_ingredients_license
        FOREIGN KEY (license_id) REFERENCES drug.licenses (license_id) ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE contype = 'f'
          AND conrelid = 'drug.atc'::regclass
          AND confrelid = 'drug.licenses'::regclass
    ) THEN
        ALTER TABLE drug.atc
        ADD CONSTRAINT fk_drug_atc_license
        FOREIGN KEY (license_id) REFERENCES drug.licenses (license_id) ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE contype = 'f'
          AND conrelid = 'drug.documents'::regclass
          AND confrelid = 'drug.licenses'::regclass
    ) THEN
        ALTER TABLE drug.documents
        ADD CONSTRAINT fk_drug_documents_license
        FOREIGN KEY (license_id) REFERENCES drug.licenses (license_id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'drug.documents'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%doc_type = ''insert''%'
    ) THEN
        ALTER TABLE drug.documents
        ADD CONSTRAINT chk_drug_documents_doc_type_insert
        CHECK (doc_type = 'insert');
    END IF;
END $$;

ALTER TABLE drug.appearance   ALTER COLUMN license_id SET NOT NULL;
ALTER TABLE drug.ingredients  ALTER COLUMN license_id SET NOT NULL;
ALTER TABLE drug.atc          ALTER COLUMN license_id SET NOT NULL;
ALTER TABLE drug.documents    ALTER COLUMN license_id SET NOT NULL;
ALTER TABLE drug.documents    ALTER COLUMN doc_type SET NOT NULL;

ALTER TABLE drug.rx_relationships ALTER COLUMN rxcui1 SET NOT NULL;
ALTER TABLE drug.rx_relationships ALTER COLUMN rel SET NOT NULL;
ALTER TABLE drug.rx_relationships ALTER COLUMN rxcui2 SET NOT NULL;
ALTER TABLE drug.rx_relationships ALTER COLUMN rela SET NOT NULL;

-- ---------------------------------------------------------------------------
-- Add/align indexes with schema.sql.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_drug_app_lid  ON drug.appearance (license_id);
CREATE INDEX IF NOT EXISTS idx_drug_ing_lid  ON drug.ingredients (license_id);
CREATE INDEX IF NOT EXISTS idx_drug_ing_name ON drug.ingredients (ingredient_name);
CREATE INDEX IF NOT EXISTS idx_drug_atc_lid  ON drug.atc (license_id);
CREATE INDEX IF NOT EXISTS idx_drug_atc_code ON drug.atc (atc_code);
CREATE INDEX IF NOT EXISTS idx_drug_atc_fts  ON drug.atc
    USING GIN (to_tsvector('simple', COALESCE(atc_name,'')));
CREATE INDEX IF NOT EXISTS idx_drug_doc_lid_insert ON drug.documents (license_id)
    WHERE doc_type = 'insert';

CREATE UNIQUE INDEX IF NOT EXISTS uidx_drug_appearance_exact ON drug.appearance (
    license_id, COALESCE(shape,''), COALESCE(color,''), COALESCE(marking,''), COALESCE(image_url,'')
);
CREATE UNIQUE INDEX IF NOT EXISTS uidx_drug_ingredients_exact ON drug.ingredients (
    license_id, COALESCE(ingredient_name,''), COALESCE(ingredient_qty,''), COALESCE(ingredient_unit,'')
);
CREATE UNIQUE INDEX IF NOT EXISTS uidx_drug_atc_exact ON drug.atc (
    license_id, COALESCE(atc_code,''), COALESCE(atc_name,'')
);
CREATE UNIQUE INDEX IF NOT EXISTS uidx_drug_documents_exact ON drug.documents (
    license_id, doc_type, COALESCE(doc_url,'')
);

CREATE INDEX IF NOT EXISTS idx_drug_rx_rel_cui1 ON drug.rx_relationships (rxcui1);
CREATE INDEX IF NOT EXISTS idx_drug_rx_rel_cui2 ON drug.rx_relationships (rxcui2);
CREATE INDEX IF NOT EXISTS idx_drug_rx_rel_rela ON drug.rx_relationships (rela);
CREATE UNIQUE INDEX IF NOT EXISTS uidx_drug_rx_rel_exact ON drug.rx_relationships
    (rxcui1, rel, rxcui2, rela);
CREATE INDEX IF NOT EXISTS idx_drug_rx_fts      ON drug.rx_concepts
    USING GIN (to_tsvector('english', COALESCE(name,'')));
CREATE INDEX IF NOT EXISTS idx_drug_rx_atc_code ON drug.rx_atc_map (atc_code);
CREATE INDEX IF NOT EXISTS idx_drug_rx_atc_cui  ON drug.rx_atc_map (rxcui);

COMMIT;
