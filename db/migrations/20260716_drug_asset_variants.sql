-- Web-ready derivatives of immutable crawler assets. The source image remains
-- in drug.assets; variants can be rebuilt without changing its identity.

CREATE TABLE IF NOT EXISTS drug.asset_variants (
    variant_id         UUID PRIMARY KEY,
    source_asset_id    UUID NOT NULL REFERENCES drug.assets (asset_id) ON DELETE CASCADE,
    variant_kind       TEXT NOT NULL,
    mime_type          TEXT,
    width_px           INTEGER,
    height_px          INTEGER,
    size_bytes         BIGINT,
    sha256             TEXT,
    bucket             TEXT,
    object_key         TEXT,
    minio_uri          TEXT,
    etag               TEXT,
    version_id         TEXT,
    storage_status     TEXT NOT NULL DEFAULT 'pending',
    last_error_message TEXT,
    stored_at          TIMESTAMPTZ,
    UNIQUE (source_asset_id, variant_kind)
);

CREATE INDEX IF NOT EXISTS idx_drug_asset_variant_source
    ON drug.asset_variants (source_asset_id);
