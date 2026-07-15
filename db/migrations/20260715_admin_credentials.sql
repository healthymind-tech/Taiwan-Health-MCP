BEGIN;

CREATE TABLE IF NOT EXISTS admin.admin_credentials (
    username       TEXT PRIMARY KEY,
    password_hash  TEXT NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by     TEXT NOT NULL
);

COMMIT;
