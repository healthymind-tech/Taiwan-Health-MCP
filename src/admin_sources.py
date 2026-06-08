"""
Admin source upload and activation helpers.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import asyncpg

from database import PoolLike
from minio_service import MinioService

logger = logging.getLogger(__name__)

_SAFE_FILENAME_RE = re.compile(r"[^A-Za-z0-9._-]+")

# ---------------------------------------------------------------------------
# Magika — lazy singleton
# ---------------------------------------------------------------------------
# Magika loads an ONNX model on first use (~0.5 s).  We initialise it once
# and reuse across requests.  If the package is missing or the model fails to
# load we log a warning and fall back to extension-only validation so existing
# deployments don't break on upgrade; set MAGIKA_REQUIRED=true to make the
# absence a hard error.

_magika_instance: Any = None
_magika_lock = asyncio.Lock()
_magika_available: bool | None = None  # None = not yet attempted


async def _get_magika() -> Any:
    """Return a shared Magika instance (lazy-initialised, thread-safe)."""
    global _magika_instance, _magika_available
    async with _magika_lock:
        if _magika_available is None:
            try:
                from magika import Magika  # type: ignore[import-untyped]

                _magika_instance = Magika()
                _magika_available = True
                logger.info("Magika file-type detector initialised")
            except Exception as exc:
                _magika_available = False
                logger.warning(
                    "Magika not available — falling back to extension-only validation",
                    exc_info=exc,
                )
        return _magika_instance


@dataclass(frozen=True)
class SourceCatalogEntry:
    module_key: str
    source_role: str
    label: str
    description: str
    accepted_extensions: tuple[str, ...]
    # Magika content-type labels accepted for this source.  The check is
    # skipped when Magika is unavailable (graceful degradation).
    allowed_magika_labels: tuple[str, ...]
    # When True, multiple active uploads are allowed simultaneously for this
    # role.  The job runner merges all active files before passing to the loader.
    multi_source: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "module_key": self.module_key,
            "source_role": self.source_role,
            "label": self.label,
            "description": self.description,
            "accepted_extensions": list(self.accepted_extensions),
            "multi_source": self.multi_source,
        }


# Magika label sets used across multiple entries
_ZIP_LABELS = ("zip",)
_GZIP_LABELS = ("gzip",)  # .tgz / .tar.gz — gzip magic bytes
_XLSX_LABELS = ("xlsx",)  # Magika distinguishes xlsx from generic zip
_CSV_LABELS = ("csv", "txt", "tsv")  # plain-text CSV may be detected as txt


SOURCE_CATALOG: tuple[SourceCatalogEntry, ...] = (
    SourceCatalogEntry(
        module_key="icd",
        source_role="icd10cm",
        label="ICD-10-CM 2025 ZIP",
        description="Main ICD-10-CM release archive used for diagnosis import.",
        accepted_extensions=(".zip",),
        allowed_magika_labels=_ZIP_LABELS,
    ),
    SourceCatalogEntry(
        module_key="icd",
        source_role="icd10pcs",
        label="ICD-10-PCS 2025 ZIP",
        description="Procedure code archive for ICD-10-PCS import.",
        accepted_extensions=(".zip",),
        allowed_magika_labels=_ZIP_LABELS,
    ),
    SourceCatalogEntry(
        module_key="icd",
        source_role="icd_zh_tw",
        label="Taiwan ICD bilingual XLSX",
        description="Optional MOHW bilingual ICD Excel for Chinese names.",
        accepted_extensions=(".xlsx",),
        allowed_magika_labels=_XLSX_LABELS,
    ),
    SourceCatalogEntry(
        module_key="loinc",
        source_role="loinc",
        label="LOINC ZIP",
        description="Primary LOINC release ZIP.",
        accepted_extensions=(".zip",),
        allowed_magika_labels=_ZIP_LABELS,
    ),
    SourceCatalogEntry(
        module_key="loinc",
        source_role="loinc_taiwan_mapping",
        label="LOINC Taiwan mapping CSV",
        description="Optional Taiwan mapping file for local names.",
        accepted_extensions=(".csv",),
        allowed_magika_labels=_CSV_LABELS,
    ),
    SourceCatalogEntry(
        module_key="loinc",
        source_role="loinc_reference_ranges",
        label="LOINC reference ranges CSV",
        description="Optional age/gender reference ranges.",
        accepted_extensions=(".csv",),
        allowed_magika_labels=_CSV_LABELS,
    ),
    SourceCatalogEntry(
        module_key="snomed",
        source_role="snomed_ct",
        label="SNOMED CT RF2 ZIP",
        description="International RF2 release archive.",
        accepted_extensions=(".zip",),
        allowed_magika_labels=_ZIP_LABELS,
    ),
    SourceCatalogEntry(
        module_key="rxnorm",
        source_role="rxnorm_full",
        label="RxNorm Full Release ZIP",
        description="RxNorm_full_<date> archive — concept-only import (RXNCONSO.RRF) so IG ValueSets can expand RxNorm TTY filters into real codes.",
        accepted_extensions=(".zip",),
        allowed_magika_labels=_ZIP_LABELS,
    ),
    SourceCatalogEntry(
        module_key="ig",
        source_role="ig",
        label="FHIR IG package.tgz",
        description="FHIR NPM package (package.tgz) for any Implementation Guide — its resources, profiles, terminology, and examples. Declared dependency IGs are auto-fetched from the FHIR registry; upload one here only when the registry cannot supply it.",
        accepted_extensions=(".tgz", ".tar.gz"),
        allowed_magika_labels=_GZIP_LABELS,
        multi_source=True,
    ),
    SourceCatalogEntry(
        module_key="drug",
        source_role="drug_index_csv",
        label="Drug index CSV (36_2.csv)",
        description="Authoritative Taiwan drug index snapshot for drug Phase 1 index import.",
        accepted_extensions=(".csv",),
        allowed_magika_labels=_CSV_LABELS,
        multi_source=True,
    ),
)

CATALOG_BY_KEY: dict[tuple[str, str], SourceCatalogEntry] = {
    (entry.module_key, entry.source_role): entry for entry in SOURCE_CATALOG
}


def catalog_entry(module_key: str, source_role: str) -> SourceCatalogEntry:
    key = (module_key.strip(), source_role.strip())
    entry = CATALOG_BY_KEY.get(key)
    if entry is None:
        raise ValueError(f"Unsupported module source: {module_key}/{source_role}")
    return entry


def safe_source_filename(filename: str) -> str:
    value = Path(filename or "upload.bin").name.strip() or "upload.bin"
    normalized = _SAFE_FILENAME_RE.sub("-", value)
    normalized = normalized.strip(".-") or "upload.bin"
    return normalized[:180]


def validate_source_filename(filename: str, entry: SourceCatalogEntry) -> str:
    safe_name = safe_source_filename(filename)
    lowered = safe_name.lower()
    if not any(lowered.endswith(ext.lower()) for ext in entry.accepted_extensions):
        accepted = ", ".join(entry.accepted_extensions)
        raise ValueError(
            f"File type not allowed for {entry.source_role}. Accepted: {accepted}"
        )
    return safe_name


async def validate_source_content(data: bytes, entry: SourceCatalogEntry) -> None:
    """Verify file content matches the expected type using Magika.

    Runs Magika in a thread executor so it doesn't block the event loop.
    Raises ``ValueError`` if the detected type is not in
    ``entry.allowed_magika_labels``.

    If Magika is not installed or fails to initialise, logs a warning and
    returns without error (extension-only validation already ran before this).
    Set ``MAGIKA_REQUIRED=true`` to turn degradation into a hard error.
    """
    import os

    magika = await _get_magika()
    if magika is None:
        if os.getenv("MAGIKA_REQUIRED", "").strip().lower() == "true":
            raise RuntimeError(
                "Magika is required (MAGIKA_REQUIRED=true) but is not available"
            )
        return  # graceful degradation

    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(None, magika.identify_bytes, data)
    except Exception as exc:
        logger.warning("Magika identify_bytes failed: %s", exc)
        return  # non-fatal: fall back to extension-only check

    # Magika returns a ContentTypeLabel enum; .value gives the lowercase string
    try:
        detected = str(result.output.ct_label.value).lower()
    except AttributeError:
        # Older Magika versions may expose the label differently
        detected = str(result.output.ct_label).lower()

    allowed = entry.allowed_magika_labels
    if detected not in allowed:
        allowed_str = ", ".join(allowed)
        raise ValueError(
            f"File content type rejected: Magika detected '{detected}' "
            f"but {entry.source_role} requires one of [{allowed_str}]. "
            "Upload a valid file."
        )

    logger.debug(
        "Magika validation passed: detected=%s role=%s",
        detected,
        entry.source_role,
    )


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# Columns the drug index CSV must contain for the import to produce anything.
# 許可證字號 is the primary key (rows without it are skipped by the loader);
# 中文品名/英文品名 are core identity columns of the Taiwan FDA drug module.
_DRUG_CSV_REQUIRED_COLUMNS = ("許可證字號", "中文品名", "英文品名")


def validate_drug_index_csv(data: bytes) -> None:
    """Validate an uploaded drug index CSV immediately on upload: it must be
    UTF-8 text with the required columns and at least one data row carrying a
    license number. Raises ValueError (→ HTTP 400) on any problem."""
    import csv
    import io

    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise ValueError("File is not valid UTF-8 text — expected a CSV export.")
    reader = csv.reader(io.StringIO(text))
    try:
        header = [h.strip() for h in next(reader)]
    except StopIteration:
        raise ValueError("CSV is empty — no header row found.")
    missing = [c for c in _DRUG_CSV_REQUIRED_COLUMNS if c not in header]
    if missing:
        raise ValueError(
            "CSV is missing required column(s): "
            + ", ".join(missing)
            + ". Expected the Taiwan FDA drug index columns (許可證字號, 中文品名, 英文品名)."
        )
    license_idx = header.index("許可證字號")
    has_data = False
    for row in reader:
        if len(row) > license_idx and row[license_idx].strip():
            has_data = True
            break
    if not has_data:
        raise ValueError("CSV has no data rows with a 許可證字號 value.")


def source_object_key(
    module_key: str,
    source_role: str,
    sha256: str,
    filename: str,
) -> str:
    return f"admin-sources/{module_key}/{source_role}/{sha256}/{safe_source_filename(filename)}"


def _uploaded_file_dict(row: asyncpg.Record | dict[str, Any]) -> dict[str, Any]:
    item = dict(row)
    if item.get("uploaded_at") is not None and hasattr(
        item["uploaded_at"], "isoformat"
    ):
        item["uploaded_at"] = item["uploaded_at"].isoformat()
    return item


async def _next_version_num(
    conn: asyncpg.Connection,
    module_key: str,
    source_role: str,
) -> int:
    """Return MAX(version_num) + 1 for the given (module_key, source_role) pair.
    Always returns at least 1."""
    result = await conn.fetchval(
        """
        SELECT COALESCE(MAX(version_num), 0) + 1
        FROM admin.module_sources
        WHERE module_key = $1 AND source_role = $2
        """,
        module_key,
        source_role,
    )
    return int(result or 1)


async def ensure_version_num_column(pool: PoolLike) -> None:
    """Idempotent startup migration: add version_num column if absent, then backfill.

    Fresh installs get the column from schema.sql; existing installs hit this path.
    Backfill assigns sequential version numbers per (module_key, source_role) ordered
    by activated_at so historical activations get meaningful version labels.
    """
    async with pool.acquire() as conn:
        exists = await conn.fetchval("""
            SELECT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'admin'
                  AND table_name = 'module_sources'
                  AND column_name = 'version_num'
            )
            """)
        if not exists:
            await conn.execute(
                "ALTER TABLE admin.module_sources ADD COLUMN version_num INT"
            )
            logger.info("Added version_num column to admin.module_sources")
        # Backfill any rows that have been activated but still lack a version_num
        updated = await conn.execute("""
            UPDATE admin.module_sources ds
            SET version_num = sub.rn
            FROM (
                SELECT module_source_id,
                       ROW_NUMBER() OVER (
                           PARTITION BY module_key, source_role
                           ORDER BY COALESCE(activated_at, NOW()), module_source_id
                       ) AS rn
                FROM admin.module_sources
                WHERE version_num IS NULL
                  AND activated_at IS NOT NULL
            ) sub
            WHERE ds.module_source_id = sub.module_source_id
            """)
        if updated != "UPDATE 0":
            logger.info(
                "Backfilled version_num for existing module_sources: %s", updated
            )


async def ensure_ig_artifact_tables(pool: PoolLike) -> None:
    """Create the multi-IG ``fhir.*`` tables on existing deployments.

    Fresh installs get these from ``schema.sql``. This startup migration lets the
    admin UI roll forward to the package-scoped schema (Phase 0) without a manual
    DB rebuild. The package columns are added to the (job-internal) staging tables
    idempotently; the authoritative shape — including the widened staging primary
    keys — comes from ``schema.sql`` on a clean re-init / re-import.
    """
    async with pool.acquire() as conn:
        # --- staging tables (job-internal) --------------------------------- #
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS admin.stage_twcore_artifacts (
                job_id           UUID NOT NULL REFERENCES admin.import_jobs (job_id) ON DELETE CASCADE,
                package_id       TEXT NOT NULL DEFAULT '',
                package_version  TEXT NOT NULL DEFAULT '',
                artifact_key     TEXT NOT NULL,
                resource_type    TEXT NOT NULL,
                artifact_id      TEXT,
                canonical_url    TEXT,
                name             TEXT,
                title            TEXT,
                status           TEXT,
                kind             TEXT,
                base_type        TEXT,
                derivation       TEXT,
                grouping_id      TEXT,
                grouping_name    TEXT,
                description      TEXT,
                package_path     TEXT,
                child_count      INTEGER NOT NULL DEFAULT 0,
                concept_count    INTEGER NOT NULL DEFAULT 0,
                raw_json         JSONB,
                PRIMARY KEY (job_id, package_id, package_version, artifact_key)
            )
            """)
        # Roll forward staging tables that predate the package columns.
        for stage_table in (
            "admin.stage_twcore_codesystems",
            "admin.stage_twcore_concepts",
            "admin.stage_twcore_artifacts",
        ):
            await conn.execute(
                f"ALTER TABLE {stage_table} ADD COLUMN IF NOT EXISTS package_id TEXT NOT NULL DEFAULT ''"
            )
            await conn.execute(
                f"ALTER TABLE {stage_table} ADD COLUMN IF NOT EXISTS package_version TEXT NOT NULL DEFAULT ''"
            )

        # --- live multi-IG schema ----------------------------------------- #
        await conn.execute("CREATE SCHEMA IF NOT EXISTS fhir")
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS fhir.ig_packages (
                package_id      TEXT NOT NULL,
                version         TEXT NOT NULL,
                canonical       TEXT,
                fhir_version    TEXT,
                title           TEXT,
                status          TEXT,
                is_default      BOOLEAN NOT NULL DEFAULT FALSE,
                dependencies    JSONB,
                imported_at     TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (package_id, version)
            )
            """)
        await conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_fhir_ig_packages_one_default "
            "ON fhir.ig_packages ((is_default)) WHERE is_default"
        )
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS fhir.codesystems (
                package_id      TEXT NOT NULL,
                package_version TEXT NOT NULL,
                cs_id           TEXT NOT NULL,
                name            TEXT,
                category        TEXT,
                fetched_at      TIMESTAMPTZ,
                concept_count   INTEGER,
                PRIMARY KEY (package_id, package_version, cs_id),
                FOREIGN KEY (package_id, package_version)
                    REFERENCES fhir.ig_packages (package_id, version) ON DELETE CASCADE
            )
            """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS fhir.concepts (
                id              BIGSERIAL PRIMARY KEY,
                package_id      TEXT NOT NULL,
                package_version TEXT NOT NULL,
                cs_id           TEXT NOT NULL,
                code            TEXT NOT NULL,
                display         TEXT,
                definition      TEXT,
                FOREIGN KEY (package_id, package_version, cs_id)
                    REFERENCES fhir.codesystems (package_id, package_version, cs_id) ON DELETE CASCADE
            )
            """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS fhir.artifacts (
                package_id      TEXT NOT NULL,
                package_version TEXT NOT NULL,
                artifact_key    TEXT NOT NULL,
                resource_type   TEXT NOT NULL,
                artifact_id     TEXT,
                canonical_url   TEXT,
                name            TEXT,
                title           TEXT,
                status          TEXT,
                kind            TEXT,
                base_type       TEXT,
                derivation      TEXT,
                grouping_id     TEXT,
                grouping_name   TEXT,
                description     TEXT,
                package_path    TEXT,
                child_count     INTEGER NOT NULL DEFAULT 0,
                concept_count   INTEGER NOT NULL DEFAULT 0,
                raw_json        JSONB,
                imported_at     TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (package_id, package_version, artifact_key),
                FOREIGN KEY (package_id, package_version)
                    REFERENCES fhir.ig_packages (package_id, version) ON DELETE CASCADE
            )
            """)
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_admin_stage_twcore_artifacts_job ON admin.stage_twcore_artifacts (job_id)"
        )
        for ddl in (
            "CREATE INDEX IF NOT EXISTS idx_fhir_concepts_cs ON fhir.concepts (package_id, package_version, cs_id)",
            "CREATE INDEX IF NOT EXISTS idx_fhir_concepts_code ON fhir.concepts (code)",
            "CREATE INDEX IF NOT EXISTS idx_fhir_artifacts_resource_type ON fhir.artifacts (resource_type)",
            "CREATE INDEX IF NOT EXISTS idx_fhir_artifacts_base_type ON fhir.artifacts (base_type)",
            "CREATE INDEX IF NOT EXISTS idx_fhir_artifacts_grouping ON fhir.artifacts (grouping_id)",
            "CREATE INDEX IF NOT EXISTS idx_fhir_artifacts_canonical ON fhir.artifacts (canonical_url)",
        ):
            await conn.execute(ddl)
        await conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_fhir_concepts_fts ON fhir.concepts
            USING GIN (to_tsvector('simple',
                COALESCE(code,'') || ' ' || COALESCE(display,'')))
            """)
        await conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_fhir_artifacts_fts
            ON fhir.artifacts
            USING GIN (to_tsvector('simple',
                COALESCE(artifact_id,'') || ' ' || COALESCE(canonical_url,'') || ' ' ||
                COALESCE(name,'') || ' ' || COALESCE(title,'') || ' ' ||
                COALESCE(description,'')))
            """)


# Maps (module_key, source_role) → job_type — mirrors ROLE_JOB_TYPE in admin_console.py
_ROLE_JOB_TYPE: dict[tuple[str, str], str] = {
    ("icd", "icd10cm"): "icd_import",
    ("loinc", "loinc"): "loinc_import",
    ("drug", "drug_index_csv"): "drug_index_import",
    ("ig", "ig"): "ig_import",
    ("snomed", "snomed_ct"): "snomed_import",
    ("rxnorm", "rxnorm_full"): "rxnorm_import",
}


async def list_source_catalog(pool: PoolLike) -> list[dict[str, Any]]:
    async with pool.acquire() as conn:
        uploaded_rows = await conn.fetch("""
            SELECT
                uf.uploaded_file_id::text AS uploaded_file_id,
                uf.module_key,
                uf.source_role,
                uf.original_filename,
                uf.mime_type,
                uf.size_bytes,
                uf.sha256,
                uf.bucket,
                uf.object_key,
                uf.minio_uri,
                uf.uploaded_by,
                uf.uploaded_at,
                uf.validation_status,
                uf.validation_error,
                ds.module_source_id::text AS module_source_id,
                ds.is_active,
                ds.activated_at
            FROM admin.uploaded_files uf
            LEFT JOIN admin.module_sources ds
              ON ds.uploaded_file_id = uf.uploaded_file_id
            ORDER BY uf.uploaded_at DESC
            """)
        # Latest successful import job per job_type.
        job_rows = await conn.fetch("""
            SELECT DISTINCT ON (job_type)
                job_type,
                updated_at
            FROM admin.import_jobs
            WHERE status IN ('success', 'partial_success')
            ORDER BY job_type, updated_at DESC
            """)

        # Drug index is cumulative: per-file "imported vs pending" is keyed on a
        # successful drug_index_import job bound to that uploaded file
        # (source_uploaded_file_id). The loader hashes the materialized file, so
        # index_snapshots.source_sha256 != uploaded_files.sha256 — we link via the
        # job, which records the exact uploaded_file_id it imported.
        drug_import_job_rows = await conn.fetch("""
            SELECT
                source_uploaded_file_id::text AS uploaded_file_id,
                MAX(updated_at)               AS imported_at
            FROM admin.import_jobs
            WHERE job_type = 'drug_index_import'
              AND status IN ('success', 'partial_success')
              AND source_uploaded_file_id IS NOT NULL
            GROUP BY source_uploaded_file_id
            """)
        drug_latest_job_rows = await conn.fetch("""
            SELECT DISTINCT ON (source_uploaded_file_id)
                source_uploaded_file_id::text AS uploaded_file_id,
                job_id::text                  AS job_id,
                status,
                current_step,
                created_at,
                updated_at,
                finished_at,
                last_error_message
            FROM admin.import_jobs
            WHERE job_type = 'drug_index_import'
              AND source_uploaded_file_id IS NOT NULL
            ORDER BY source_uploaded_file_id, created_at DESC
            """)
        drug_cumulative_total = await conn.fetchval(
            "SELECT COUNT(*) FROM drug.licenses WHERE is_listed"
        )

    last_import_by_job_type: dict[str, str] = {
        str(r["job_type"]): r["updated_at"].isoformat() if r["updated_at"] else ""
        for r in job_rows
    }

    drug_imported_by_file: dict[str, str] = {
        str(r["uploaded_file_id"]): (
            r["imported_at"].isoformat() if r["imported_at"] else ""
        )
        for r in drug_import_job_rows
    }
    drug_latest_job_by_file: dict[str, dict[str, Any]] = {}
    for row in drug_latest_job_rows:
        item = dict(row)
        for ts_field in ("created_at", "updated_at", "finished_at"):
            val = item.get(ts_field)
            item[ts_field] = (
                val.isoformat() if val is not None and hasattr(val, "isoformat") else ""
            )
        drug_latest_job_by_file[str(item.get("uploaded_file_id") or "")] = item

    grouped: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for row in uploaded_rows:
        item = _uploaded_file_dict(row)
        activated_at = item.get("activated_at")
        if activated_at is not None and hasattr(activated_at, "isoformat"):
            item["activated_at"] = activated_at.isoformat()
        grouped.setdefault((item["module_key"], item["source_role"]), []).append(item)

    entries: list[dict[str, Any]] = []
    for entry in SOURCE_CATALOG:
        uploads = grouped.get((entry.module_key, entry.source_role), [])
        active = next((item for item in uploads if item.get("is_active")), None)
        active_sources = [item for item in uploads if item.get("is_active")]
        job_type = _ROLE_JOB_TYPE.get((entry.module_key, entry.source_role), "")
        last_imported_at = last_import_by_job_type.get(job_type, "") if job_type else ""

        is_drug = entry.module_key == "drug"
        if is_drug:
            # Annotate each upload with its cumulative-import status (by a
            # successful drug_index_import job for that uploaded_file_id) so the
            # UI can show Imported vs Pending without an "active" concept.
            for u in uploads:
                uploaded_file_id = str(u.get("uploaded_file_id") or "")
                imported_at = drug_imported_by_file.get(uploaded_file_id)
                latest_job = drug_latest_job_by_file.get(uploaded_file_id) or {}
                latest_status = str(latest_job.get("status") or "")
                in_progress = latest_status in {"queued", "running", "paused"}
                failed = latest_status in {
                    "retryable_failed",
                    "permanent_failed",
                    "stopped",
                    "cancelled",
                }
                u["imported"] = imported_at is not None
                u["imported_at"] = imported_at or ""
                u["import_status"] = (
                    "imported"
                    if imported_at is not None
                    else (
                        "importing"
                        if in_progress
                        else "failed" if failed else "pending"
                    )
                )
                u["import_job_id"] = latest_job.get("job_id") or ""
                u["import_job_status"] = latest_status
                u["import_current_step"] = latest_job.get("current_step") or ""
                u["import_started_at"] = latest_job.get("created_at") or ""
                u["import_updated_at"] = latest_job.get("updated_at") or ""
                u["import_finished_at"] = latest_job.get("finished_at") or ""
                u["import_error"] = latest_job.get("last_error_message") or ""

        entries.append(
            {
                **entry.to_dict(),
                "active_source": active,  # backward compat: single or first
                "active_sources": active_sources,  # new: ALL active sources
                # Drug list is the source of truth for pending/imported; show all
                # (UI scroll-caps it). Other modules keep the short recent list.
                "recent_uploads": uploads[:100] if is_drug else uploads[:10],
                "last_imported_at": last_imported_at,
                **(
                    {"cumulative_total": int(drug_cumulative_total or 0)}
                    if is_drug
                    else {}
                ),
            }
        )
    return entries


async def create_uploaded_source(
    pool: PoolLike,
    *,
    minio_service: MinioService | None,
    module_key: str,
    source_role: str,
    original_filename: str,
    mime_type: str,
    data: bytes,
    uploaded_by: str,
    auto_activate: bool = False,
) -> dict[str, Any]:
    entry = catalog_entry(module_key, source_role)
    filename = validate_source_filename(original_filename, entry)
    digest = sha256_bytes(data)

    # Immediate content validation for the drug index CSV — reject malformed or
    # empty files before they are ever stored.
    if entry.module_key == "drug":
        validate_drug_index_csv(data)

    async with pool.acquire() as conn:
        # Drug index is cumulative: a CSV whose identical content has already
        # been imported must not be re-uploaded — re-importing the same bytes is
        # meaningless. "Already imported" is keyed on a successful
        # drug_index_import job for an uploaded file with the same sha256 (the
        # loader hashes the materialized file, so we can't match
        # index_snapshots.source_sha256 directly — link via the job instead).
        if entry.module_key == "drug":
            already_imported = await conn.fetchval(
                """
                SELECT 1
                FROM admin.import_jobs j
                JOIN admin.uploaded_files uf
                  ON uf.uploaded_file_id = j.source_uploaded_file_id
                WHERE uf.module_key = 'drug'
                  AND uf.sha256 = $1
                  AND j.job_type = 'drug_index_import'
                  AND j.status IN ('success', 'partial_success')
                LIMIT 1
                """,
                digest,
            )
            if already_imported:
                raise ValueError(
                    "This file has already been imported into the drug index."
                )

        existing = await conn.fetchrow(
            """
            SELECT
                uf.uploaded_file_id::text AS uploaded_file_id,
                uf.module_key,
                uf.source_role,
                uf.original_filename,
                uf.mime_type,
                uf.size_bytes,
                uf.sha256,
                uf.bucket,
                uf.object_key,
                uf.minio_uri,
                uf.uploaded_by,
                uf.uploaded_at,
                uf.validation_status,
                uf.validation_error,
                ds.module_source_id::text AS module_source_id,
                ds.is_active,
                ds.activated_at
            FROM admin.uploaded_files uf
            LEFT JOIN admin.module_sources ds
              ON ds.uploaded_file_id = uf.uploaded_file_id
            WHERE uf.module_key = $1
              AND uf.source_role = $2
              AND uf.sha256 = $3
            LIMIT 1
            """,
            entry.module_key,
            entry.source_role,
            digest,
        )
        if existing is not None:
            uploaded_file_id = uuid.UUID(str(existing["uploaded_file_id"]))
            if auto_activate:
                now = datetime.now(timezone.utc)
                async with conn.transaction():
                    if not entry.multi_source:
                        await conn.execute(
                            """
                            UPDATE admin.module_sources
                            SET is_active = FALSE
                            WHERE module_key = $1
                              AND source_role = $2
                              AND uploaded_file_id <> $3
                            """,
                            entry.module_key,
                            entry.source_role,
                            uploaded_file_id,
                        )
                    module_source_id = existing["module_source_id"]
                    next_ver = await _next_version_num(
                        conn, entry.module_key, entry.source_role
                    )
                    if module_source_id:
                        await conn.execute(
                            """
                            UPDATE admin.module_sources
                            SET is_active = TRUE,
                                activated_at = $2,
                                version_num = $3
                            WHERE uploaded_file_id = $1
                            """,
                            uploaded_file_id,
                            now,
                            next_ver,
                        )
                    else:
                        await conn.execute(
                            """
                            INSERT INTO admin.module_sources (
                                module_source_id,
                                module_key,
                                source_role,
                                uploaded_file_id,
                                is_active,
                                activated_at,
                                version_num,
                                notes
                            )
                            VALUES ($1, $2, $3, $4, TRUE, $5, $6, '{}'::jsonb)
                            """,
                            uuid.uuid4(),
                            entry.module_key,
                            entry.source_role,
                            uploaded_file_id,
                            now,
                            next_ver,
                        )
                    await conn.execute(
                        """
                        INSERT INTO admin.admin_audit_log (
                            admin_user,
                            action,
                            target_type,
                            target_id,
                            payload_json
                        )
                        VALUES ($1, 'activate_duplicate_source', 'uploaded_file', $2, $3::jsonb)
                        """,
                        uploaded_by,
                        str(uploaded_file_id),
                        json.dumps(
                            {
                                "module_key": entry.module_key,
                                "source_role": entry.source_role,
                                "original_filename": filename,
                            },
                            ensure_ascii=False,
                        ),
                    )
                existing = await conn.fetchrow(
                    """
                    SELECT
                        uf.uploaded_file_id::text AS uploaded_file_id,
                        uf.module_key,
                        uf.source_role,
                        uf.original_filename,
                        uf.mime_type,
                        uf.size_bytes,
                        uf.sha256,
                        uf.bucket,
                        uf.object_key,
                        uf.minio_uri,
                        uf.uploaded_by,
                        uf.uploaded_at,
                        uf.validation_status,
                        uf.validation_error,
                        ds.module_source_id::text AS module_source_id,
                        ds.is_active,
                        ds.activated_at
                    FROM admin.uploaded_files uf
                    LEFT JOIN admin.module_sources ds
                      ON ds.uploaded_file_id = uf.uploaded_file_id
                    WHERE uf.uploaded_file_id = $1
                    LIMIT 1
                    """,
                    uploaded_file_id,
                )
            item = _uploaded_file_dict(existing)
            activated_at = item.get("activated_at")
            if activated_at is not None and hasattr(activated_at, "isoformat"):
                item["activated_at"] = activated_at.isoformat()
            return {"duplicate": True, "uploaded_file": item}

    if minio_service is None or not minio_service.enabled:
        raise RuntimeError("MinIO is required for admin source uploads")

    object_key = source_object_key(
        entry.module_key, entry.source_role, digest, filename
    )
    locator = await minio_service.upload_bytes(
        object_key=object_key,
        data=data,
        content_type=mime_type or "application/octet-stream",
    )

    uploaded_file_id = uuid.uuid4()
    module_source_id = uuid.uuid4()
    now = datetime.now(timezone.utc)

    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                """
                INSERT INTO admin.uploaded_files (
                    uploaded_file_id,
                    module_key,
                    source_role,
                    original_filename,
                    mime_type,
                    size_bytes,
                    sha256,
                    bucket,
                    object_key,
                    minio_uri,
                    uploaded_by,
                    uploaded_at,
                    validation_status,
                    validation_error
                )
                VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'accepted', ''
                )
                RETURNING
                    uploaded_file_id::text AS uploaded_file_id,
                    module_key,
                    source_role,
                    original_filename,
                    mime_type,
                    size_bytes,
                    sha256,
                    bucket,
                    object_key,
                    minio_uri,
                    uploaded_by,
                    uploaded_at,
                    validation_status,
                    validation_error
                """,
                uploaded_file_id,
                entry.module_key,
                entry.source_role,
                filename,
                mime_type or "application/octet-stream",
                len(data),
                digest,
                locator["bucket"],
                locator["object_key"],
                locator["minio_uri"],
                uploaded_by,
                now,
            )
            # Deactivate any existing active source BEFORE inserting the new one
            # for single-source roles (to maintain single-active invariant).
            # Multi-source roles allow multiple concurrent active rows.
            entry_obj = CATALOG_BY_KEY.get((entry.module_key, entry.source_role))
            is_multi = entry_obj.multi_source if entry_obj else False
            if auto_activate and not is_multi:
                await conn.execute(
                    """
                    UPDATE admin.module_sources
                    SET is_active = FALSE
                    WHERE module_key = $1
                      AND source_role = $2
                    """,
                    entry.module_key,
                    entry.source_role,
                )
            next_ver = (
                await _next_version_num(conn, entry.module_key, entry.source_role)
                if auto_activate
                else None
            )
            await conn.execute(
                """
                INSERT INTO admin.module_sources (
                    module_source_id,
                    module_key,
                    source_role,
                    uploaded_file_id,
                    is_active,
                    activated_at,
                    version_num,
                    notes
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb)
                """,
                module_source_id,
                entry.module_key,
                entry.source_role,
                uploaded_file_id,
                auto_activate,
                now if auto_activate else None,
                next_ver,
            )
            await conn.execute(
                """
                INSERT INTO admin.admin_audit_log (
                    admin_user,
                    action,
                    target_type,
                    target_id,
                    payload_json
                )
                VALUES ($1, 'upload_source', 'uploaded_file', $2, $3::jsonb)
                """,
                uploaded_by,
                str(uploaded_file_id),
                json.dumps(
                    {
                        "module_key": entry.module_key,
                        "source_role": entry.source_role,
                        "original_filename": filename,
                        "auto_activate": auto_activate,
                    },
                    ensure_ascii=False,
                ),
            )
    if row is None:
        raise RuntimeError("Failed to persist uploaded source")
    item = _uploaded_file_dict(row)
    item["module_source_id"] = str(module_source_id)
    item["is_active"] = auto_activate
    item["activated_at"] = now.isoformat() if auto_activate else ""
    item["version_num"] = next_ver
    return {"duplicate": False, "uploaded_file": item}


async def list_source_versions(
    pool: PoolLike,
    module_key: str,
) -> list[dict[str, Any]]:
    """Return the full version history for all source_roles of a module.

    Results are grouped implicitly by source_role and ordered newest-first
    within each role (highest version_num first, then by activated_at DESC).
    Only source_roles present in SOURCE_CATALOG for this module are included.
    """
    if module_key == "drug":
        return []

    valid_roles = {
        entry.source_role for entry in SOURCE_CATALOG if entry.module_key == module_key
    }
    if not valid_roles:
        return []

    # Collect role → label mapping for display purposes
    role_labels: dict[str, str] = {
        entry.source_role: entry.label
        for entry in SOURCE_CATALOG
        if entry.module_key == module_key
    }

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT
                ds.module_source_id::text  AS module_source_id,
                ds.module_key,
                ds.source_role,
                ds.is_active,
                ds.activated_at,
                ds.version_num,
                uf.uploaded_file_id::text   AS uploaded_file_id,
                uf.original_filename,
                uf.size_bytes,
                uf.sha256,
                uf.uploaded_at,
                uf.uploaded_by,
                uf.validation_status
            FROM admin.module_sources ds
            JOIN admin.uploaded_files uf
              ON uf.uploaded_file_id = ds.uploaded_file_id
            WHERE ds.module_key = $1
            ORDER BY
                ds.source_role,
                COALESCE(ds.version_num, 0) DESC,
                ds.activated_at DESC NULLS LAST
            """,
            module_key,
        )

    result: list[dict[str, Any]] = []
    for row in rows:
        if row["source_role"] not in valid_roles:
            continue
        item: dict[str, Any] = {
            "module_source_id": row["module_source_id"],
            "module_key": row["module_key"],
            "source_role": row["source_role"],
            "role_label": role_labels.get(row["source_role"], row["source_role"]),
            "is_active": bool(row["is_active"]),
            "version_num": row["version_num"],
            "uploaded_file_id": row["uploaded_file_id"],
            "original_filename": row["original_filename"] or "",
            "size_bytes": row["size_bytes"],
            "sha256": row["sha256"] or "",
            "uploaded_by": row["uploaded_by"] or "",
            "validation_status": row["validation_status"] or "",
        }
        for ts_field in ("activated_at", "uploaded_at"):
            val = row[ts_field]
            item[ts_field] = val.isoformat() if val is not None else None
        result.append(item)
    return result


async def activate_source(
    pool: PoolLike,
    *,
    uploaded_file_id: str,
    activated_by: str,
) -> dict[str, Any]:
    target_uuid = uuid.UUID(uploaded_file_id)
    now = datetime.now(timezone.utc)
    async with pool.acquire() as conn:
        async with conn.transaction():
            target = await conn.fetchrow(
                """
                SELECT uploaded_file_id, module_key, source_role
                FROM admin.uploaded_files
                WHERE uploaded_file_id = $1
                """,
                target_uuid,
            )
            if target is None:
                raise ValueError("Uploaded source not found")
            module_key = target["module_key"]
            source_role = target["source_role"]
            entry = CATALOG_BY_KEY.get((str(module_key), str(source_role)))
            is_multi = entry.multi_source if entry else False
            if not is_multi:
                await conn.execute(
                    """
                    UPDATE admin.module_sources
                    SET is_active = FALSE
                    WHERE module_key = $1
                      AND source_role = $2
                    """,
                    module_key,
                    source_role,
                )
            next_ver = await _next_version_num(conn, str(module_key), str(source_role))
            row = await conn.fetchrow(
                """
                UPDATE admin.module_sources
                SET is_active = TRUE,
                    activated_at = $2,
                    version_num = $3
                WHERE uploaded_file_id = $1
                RETURNING
                    module_source_id::text AS module_source_id,
                    module_key,
                    source_role,
                    uploaded_file_id::text AS uploaded_file_id,
                    is_active,
                    activated_at,
                    version_num
                """,
                target_uuid,
                now,
                next_ver,
            )
            if row is None:
                raise RuntimeError("Module source row not found for uploaded file")
            await conn.execute(
                """
                INSERT INTO admin.admin_audit_log (
                    admin_user,
                    action,
                    target_type,
                    target_id,
                    payload_json
                )
                VALUES ($1, 'activate_source', 'uploaded_file', $2, $3::jsonb)
                """,
                activated_by,
                uploaded_file_id,
                json.dumps(
                    {"module_key": module_key, "source_role": source_role},
                    ensure_ascii=False,
                ),
            )
    item = dict(row)
    if item.get("activated_at") is not None and hasattr(
        item["activated_at"], "isoformat"
    ):
        item["activated_at"] = item["activated_at"].isoformat()
    return item


async def deactivate_source(
    pool: PoolLike,
    *,
    uploaded_file_id: str,
    deactivated_by: str,
) -> dict[str, Any]:
    target_uuid = uuid.UUID(uploaded_file_id)
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                """
                UPDATE admin.module_sources
                SET is_active = FALSE
                WHERE uploaded_file_id = $1
                RETURNING
                    module_source_id::text AS module_source_id,
                    module_key,
                    source_role,
                    uploaded_file_id::text AS uploaded_file_id,
                    is_active
                """,
                target_uuid,
            )
            if row is None:
                raise ValueError("Module source not found for uploaded file")
            await conn.execute(
                """
                INSERT INTO admin.admin_audit_log
                    (admin_user, action, target_type, target_id, payload_json)
                VALUES ($1, 'deactivate_source', 'uploaded_file', $2, $3::jsonb)
                """,
                deactivated_by,
                uploaded_file_id,
                json.dumps(
                    {
                        "module_key": row["module_key"],
                        "source_role": row["source_role"],
                    },
                    ensure_ascii=False,
                ),
            )
    return dict(row)


async def delete_uploaded_source(
    pool: PoolLike,
    *,
    uploaded_file_id: str,
    deleted_by: str,
    minio_service: "MinioService | None" = None,
) -> dict[str, Any]:
    """Delete an uploaded source file (its uploaded_files row — module_sources
    cascades, import_jobs.source_uploaded_file_id is set NULL) and remove the
    stored object. For drug, refuses deletion once the file has been imported
    (cumulative data cannot be cleanly un-merged)."""
    target_uuid = uuid.UUID(uploaded_file_id)
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT uploaded_file_id::text AS uploaded_file_id, module_key,
                   source_role, original_filename, object_key
            FROM admin.uploaded_files WHERE uploaded_file_id = $1
            """,
            target_uuid,
        )
        if row is None:
            raise ValueError("Uploaded file not found")
        if row["module_key"] == "drug":
            importing = await conn.fetchval(
                """
                SELECT 1 FROM admin.import_jobs
                WHERE job_type = 'drug_index_import'
                  AND source_uploaded_file_id = $1
                  AND status IN ('queued', 'running', 'paused')
                LIMIT 1
                """,
                target_uuid,
            )
            if importing:
                raise ValueError(
                    "Cannot delete: this file is already queued or importing."
                )
            imported = await conn.fetchval(
                """
                SELECT 1 FROM admin.import_jobs
                WHERE job_type = 'drug_index_import'
                  AND status IN ('success', 'partial_success')
                  AND source_uploaded_file_id = $1
                LIMIT 1
                """,
                target_uuid,
            )
            if imported:
                raise ValueError(
                    "Cannot delete: this file has already been imported into the drug index."
                )
        else:
            allow_pending_module_delete = False
            if row["module_key"] == "icd":
                module_count = await conn.fetchval("""
                    SELECT
                        (SELECT COUNT(*) FROM icd.diagnoses)
                      + (SELECT COUNT(*) FROM icd.procedures)
                    """)
                allow_pending_module_delete = int(module_count or 0) == 0
            elif row["module_key"] == "loinc":
                module_count = await conn.fetchval(
                    "SELECT COUNT(*) FROM loinc.concepts"
                )
                allow_pending_module_delete = int(module_count or 0) == 0
            elif row["module_key"] == "snomed":
                module_count = await conn.fetchval(
                    "SELECT COUNT(*) FROM snomed.concepts"
                )
                allow_pending_module_delete = int(module_count or 0) == 0
            elif row["module_key"] == "ig":
                module_count = await conn.fetchval("""
                    SELECT
                        (SELECT COUNT(*) FROM fhir.codesystems)
                      + (SELECT COUNT(*) FROM fhir.artifacts)
                    """)
                allow_pending_module_delete = int(module_count or 0) == 0

            # Single-source modules: a file is "imported" once it has been
            # activated (activation now happens on a successful import). Imported
            # versions back the data currently in the DB, so they can't be deleted.
            imported = None
            if not allow_pending_module_delete:
                imported = await conn.fetchval(
                    """
                    SELECT 1 FROM admin.module_sources
                    WHERE uploaded_file_id = $1 AND activated_at IS NOT NULL
                    LIMIT 1
                    """,
                    target_uuid,
                )
            if imported:
                raise ValueError("Cannot delete: this file has already been imported.")
        async with conn.transaction():
            await conn.execute(
                "DELETE FROM admin.uploaded_files WHERE uploaded_file_id = $1",
                target_uuid,
            )
            await conn.execute(
                """
                INSERT INTO admin.admin_audit_log
                    (admin_user, action, target_type, target_id, payload_json)
                VALUES ($1, 'delete_source', 'uploaded_file', $2, $3::jsonb)
                """,
                deleted_by,
                uploaded_file_id,
                json.dumps(
                    {
                        "module_key": row["module_key"],
                        "source_role": row["source_role"],
                        "original_filename": row["original_filename"],
                    },
                    ensure_ascii=False,
                ),
            )
    object_key = row["object_key"] or ""
    if object_key and minio_service is not None:
        try:
            await minio_service.remove_object(object_key)
        except Exception:
            pass
    return {"uploaded_file_id": uploaded_file_id, "module_key": row["module_key"]}


async def clear_icd_module(
    pool: PoolLike,
    *,
    cleared_by: str,
    minio_service: "MinioService | None" = None,
) -> dict[str, Any]:
    """Wipe ICD back to its initial empty state: truncate the imported tables AND
    delete every uploaded ICD source file (all roles) plus its stored object.

    This is the destructive "start over" action exposed only while ICD is in
    maintenance mode (the endpoint enforces that gate). Unlike
    ``delete_uploaded_source`` it deliberately ignores the "already imported"
    guard — wiping the data is the whole point — and removes all roles at once;
    single-file deletion is intentionally not offered for ICD.
    """
    async with pool.acquire() as conn:
        # Capture object keys before the rows are gone, so we can purge MinIO.
        file_rows = await conn.fetch("""
            SELECT uploaded_file_id::text AS uploaded_file_id, object_key,
                   original_filename, source_role
            FROM admin.uploaded_files
            WHERE module_key = 'icd'
            """)
        async with conn.transaction():
            diag_count = await conn.fetchval("SELECT COUNT(*) FROM icd.diagnoses")
            proc_count = await conn.fetchval("SELECT COUNT(*) FROM icd.procedures")
            await conn.execute("TRUNCATE icd.diagnoses")
            await conn.execute("TRUNCATE icd.procedures")
            # module_sources cascades; import_jobs.source_uploaded_file_id is set NULL.
            deleted = await conn.execute(
                "DELETE FROM admin.uploaded_files WHERE module_key = 'icd'"
            )
            await conn.execute(
                """
                INSERT INTO admin.admin_audit_log
                    (admin_user, action, target_type, target_id, payload_json)
                VALUES ($1, 'clear_module', 'module', 'icd', $2::jsonb)
                """,
                cleared_by,
                json.dumps(
                    {
                        "diagnoses_truncated": int(diag_count or 0),
                        "procedures_truncated": int(proc_count or 0),
                        "files_deleted": [r["original_filename"] for r in file_rows],
                    },
                    ensure_ascii=False,
                ),
            )
    # Best-effort object purge outside the transaction.
    if minio_service is not None:
        for r in file_rows:
            object_key = r["object_key"] or ""
            if object_key:
                try:
                    await minio_service.remove_object(object_key)
                except Exception:
                    pass
    logger.info(
        "Cleared ICD module: %s diagnoses, %s procedures, %s file(s) removed by %s",
        diag_count,
        proc_count,
        len(file_rows),
        cleared_by,
    )
    return {
        "module_key": "icd",
        "diagnoses_truncated": int(diag_count or 0),
        "procedures_truncated": int(proc_count or 0),
        "files_deleted": len(file_rows),
    }


async def clear_loinc_module(
    pool: PoolLike,
    *,
    cleared_by: str,
    minio_service: "MinioService | None" = None,
) -> dict[str, Any]:
    """Wipe LOINC back to its initial empty state.

    This truncates imported concepts, reference ranges, and embeddings, then
    removes every uploaded LOINC source file. The endpoint enforces maintenance
    mode before calling this helper.
    """
    async with pool.acquire() as conn:
        file_rows = await conn.fetch("""
            SELECT uploaded_file_id::text AS uploaded_file_id, object_key,
                   original_filename, source_role
            FROM admin.uploaded_files
            WHERE module_key = 'loinc'
            """)
        async with conn.transaction():
            concept_count = await conn.fetchval("SELECT COUNT(*) FROM loinc.concepts")
            range_count = await conn.fetchval(
                "SELECT COUNT(*) FROM loinc.reference_ranges"
            )
            embedding_count = await conn.fetchval(
                "SELECT COUNT(*) FROM loinc.concept_embeddings"
            )
            await conn.execute("TRUNCATE loinc.concept_embeddings")
            await conn.execute(
                "TRUNCATE loinc.reference_ranges, loinc.concepts CASCADE"
            )
            await conn.execute(
                "DELETE FROM admin.uploaded_files WHERE module_key = 'loinc'"
            )
            await conn.execute(
                """
                INSERT INTO admin.admin_audit_log
                    (admin_user, action, target_type, target_id, payload_json)
                VALUES ($1, 'clear_module', 'module', 'loinc', $2::jsonb)
                """,
                cleared_by,
                json.dumps(
                    {
                        "concepts_truncated": int(concept_count or 0),
                        "reference_ranges_truncated": int(range_count or 0),
                        "embeddings_truncated": int(embedding_count or 0),
                        "files_deleted": [r["original_filename"] for r in file_rows],
                    },
                    ensure_ascii=False,
                ),
            )
    if minio_service is not None:
        for r in file_rows:
            object_key = r["object_key"] or ""
            if object_key:
                try:
                    await minio_service.remove_object(object_key)
                except Exception:
                    pass
    logger.info(
        "Cleared LOINC module: %s concepts, %s ranges, %s embeddings, %s file(s) removed by %s",
        concept_count,
        range_count,
        embedding_count,
        len(file_rows),
        cleared_by,
    )
    return {
        "module_key": "loinc",
        "concepts_truncated": int(concept_count or 0),
        "reference_ranges_truncated": int(range_count or 0),
        "embeddings_truncated": int(embedding_count or 0),
        "files_deleted": len(file_rows),
    }


async def clear_snomed_module(
    pool: PoolLike,
    *,
    cleared_by: str,
    minio_service: "MinioService | None" = None,
) -> dict[str, Any]:
    """Wipe SNOMED CT back to its initial empty state.

    This truncates imported concepts, descriptions, relationships, ICD maps, and
    embeddings, then removes every uploaded SNOMED source file. The endpoint
    enforces maintenance mode before calling this helper.
    """
    async with pool.acquire() as conn:
        file_rows = await conn.fetch("""
            SELECT uploaded_file_id::text AS uploaded_file_id, object_key,
                   original_filename, source_role
            FROM admin.uploaded_files
            WHERE module_key = 'snomed'
            """)
        async with conn.transaction():
            concept_count = await conn.fetchval("SELECT COUNT(*) FROM snomed.concepts")
            description_count = await conn.fetchval(
                "SELECT COUNT(*) FROM snomed.descriptions"
            )
            relationship_count = await conn.fetchval(
                "SELECT COUNT(*) FROM snomed.relationships"
            )
            icd_map_count = await conn.fetchval("SELECT COUNT(*) FROM snomed.icd10_map")
            embedding_count = await conn.fetchval(
                "SELECT COUNT(*) FROM snomed.concept_embeddings"
            )
            await conn.execute("TRUNCATE snomed.concept_embeddings")
            await conn.execute(
                "TRUNCATE snomed.icd10_map, snomed.relationships, snomed.descriptions, snomed.concepts CASCADE"
            )
            await conn.execute(
                "DELETE FROM admin.uploaded_files WHERE module_key = 'snomed'"
            )
            await conn.execute(
                """
                INSERT INTO admin.admin_audit_log
                    (admin_user, action, target_type, target_id, payload_json)
                VALUES ($1, 'clear_module', 'module', 'snomed', $2::jsonb)
                """,
                cleared_by,
                json.dumps(
                    {
                        "concepts_truncated": int(concept_count or 0),
                        "descriptions_truncated": int(description_count or 0),
                        "relationships_truncated": int(relationship_count or 0),
                        "icd_maps_truncated": int(icd_map_count or 0),
                        "embeddings_truncated": int(embedding_count or 0),
                        "files_deleted": [r["original_filename"] for r in file_rows],
                    },
                    ensure_ascii=False,
                ),
            )
    if minio_service is not None:
        for r in file_rows:
            object_key = r["object_key"] or ""
            if object_key:
                try:
                    await minio_service.remove_object(object_key)
                except Exception:
                    pass
    logger.info(
        "Cleared SNOMED module: %s concepts, %s descriptions, %s relationships, %s maps, %s embeddings, %s file(s) removed by %s",
        concept_count,
        description_count,
        relationship_count,
        icd_map_count,
        embedding_count,
        len(file_rows),
        cleared_by,
    )
    return {
        "module_key": "snomed",
        "concepts_truncated": int(concept_count or 0),
        "descriptions_truncated": int(description_count or 0),
        "relationships_truncated": int(relationship_count or 0),
        "icd_maps_truncated": int(icd_map_count or 0),
        "embeddings_truncated": int(embedding_count or 0),
        "files_deleted": len(file_rows),
    }


async def clear_rxnorm_module(
    pool: PoolLike,
    *,
    cleared_by: str,
    minio_service: "MinioService | None" = None,
) -> dict[str, Any]:
    """Wipe RxNorm back to its initial empty state.

    Truncates the single ``rxnorm.concepts`` table and removes every uploaded
    RxNorm source file. The endpoint enforces maintenance mode before calling
    this helper. RxNorm is concept-only — no relationships or embeddings.
    """
    async with pool.acquire() as conn:
        file_rows = await conn.fetch("""
            SELECT uploaded_file_id::text AS uploaded_file_id, object_key,
                   original_filename, source_role
            FROM admin.uploaded_files
            WHERE module_key = 'rxnorm'
            """)
        async with conn.transaction():
            concept_count = await conn.fetchval("SELECT COUNT(*) FROM rxnorm.concepts")
            await conn.execute("TRUNCATE rxnorm.concepts")
            await conn.execute(
                "DELETE FROM admin.uploaded_files WHERE module_key = 'rxnorm'"
            )
            await conn.execute(
                """
                INSERT INTO admin.admin_audit_log
                    (admin_user, action, target_type, target_id, payload_json)
                VALUES ($1, 'clear_module', 'module', 'rxnorm', $2::jsonb)
                """,
                cleared_by,
                json.dumps(
                    {
                        "concepts_truncated": int(concept_count or 0),
                        "files_deleted": [r["original_filename"] for r in file_rows],
                    },
                    ensure_ascii=False,
                ),
            )
    if minio_service is not None:
        for r in file_rows:
            object_key = r["object_key"] or ""
            if object_key:
                try:
                    await minio_service.remove_object(object_key)
                except Exception:
                    pass
    logger.info(
        "Cleared RxNorm module: %s concepts, %s file(s) removed by %s",
        concept_count,
        len(file_rows),
        cleared_by,
    )
    return {
        "module_key": "rxnorm",
        "concepts_truncated": int(concept_count or 0),
        "files_deleted": len(file_rows),
    }


async def clear_ig_module(
    pool: PoolLike,
    *,
    cleared_by: str,
    minio_service: "MinioService | None" = None,
) -> dict[str, Any]:
    """Wipe all Implementation Guides back to the initial empty state.

    This truncates every IG package's CodeSystems, concepts, and artifact index,
    then removes every uploaded IG package. The endpoint enforces maintenance mode
    before calling this helper.
    """
    async with pool.acquire() as conn:
        file_rows = await conn.fetch("""
            SELECT uploaded_file_id::text AS uploaded_file_id, object_key,
                   original_filename, source_role
            FROM admin.uploaded_files
            WHERE module_key = 'ig'
            """)
        async with conn.transaction():
            codesystem_count = await conn.fetchval(
                "SELECT COUNT(*) FROM fhir.codesystems"
            )
            concept_count = await conn.fetchval("SELECT COUNT(*) FROM fhir.concepts")
            artifact_count = await conn.fetchval("SELECT COUNT(*) FROM fhir.artifacts")
            # Truncating the registry cascades to codesystems / concepts /
            # artifacts (FK ON DELETE CASCADE), clearing every imported package.
            await conn.execute("TRUNCATE fhir.ig_packages RESTART IDENTITY CASCADE")
            await conn.execute(
                "DELETE FROM admin.uploaded_files WHERE module_key = 'ig'"
            )
            await conn.execute(
                """
                INSERT INTO admin.admin_audit_log
                    (admin_user, action, target_type, target_id, payload_json)
                VALUES ($1, 'clear_module', 'module', 'ig', $2::jsonb)
                """,
                cleared_by,
                json.dumps(
                    {
                        "codesystems_truncated": int(codesystem_count or 0),
                        "concepts_truncated": int(concept_count or 0),
                        "artifacts_truncated": int(artifact_count or 0),
                        "files_deleted": [r["original_filename"] for r in file_rows],
                    },
                    ensure_ascii=False,
                ),
            )
    if minio_service is not None:
        for r in file_rows:
            object_key = r["object_key"] or ""
            if object_key:
                try:
                    await minio_service.remove_object(object_key)
                except Exception:
                    pass
    logger.info(
        "Cleared IG module: %s CodeSystems, %s concepts, %s artifacts, %s file(s) removed by %s",
        codesystem_count,
        concept_count,
        artifact_count,
        len(file_rows),
        cleared_by,
    )
    return {
        "module_key": "ig",
        "codesystems_truncated": int(codesystem_count or 0),
        "concepts_truncated": int(concept_count or 0),
        "artifacts_truncated": int(artifact_count or 0),
        "files_deleted": len(file_rows),
    }


async def clear_drug_module(
    pool: PoolLike,
    *,
    cleared_by: str,
    minio_service: "MinioService | None" = None,
) -> dict[str, Any]:
    """Wipe the cumulative Drug index back to its initial empty state.

    Drug imports are additive and cannot be unmerged per uploaded file, so the
    destructive escape hatch is whole-module clearing only. This truncates the
    canonical index, enrichment/analysis tables, import pipeline state, crawler
    asset metadata, and every uploaded Drug source file. The endpoint enforces
    maintenance mode before calling this helper.
    """
    drug_job_types = ("drug_index_import", "drug_enrichment", "drug_analysis")
    async with pool.acquire() as conn:
        active_job = await conn.fetchrow(
            """
            SELECT job_id::text AS job_id, job_type, status
            FROM admin.import_jobs
            WHERE job_type = ANY($1::text[])
              AND status IN ('queued', 'running', 'paused')
            ORDER BY created_at DESC
            LIMIT 1
            """,
            list(drug_job_types),
        )
        if active_job is not None:
            raise ValueError(
                "Cannot clear Drug module while "
                f"{active_job['job_type']} is {active_job['status']}."
            )

        file_rows = await conn.fetch("""
            SELECT uploaded_file_id::text AS uploaded_file_id, object_key,
                   original_filename, source_role
            FROM admin.uploaded_files
            WHERE module_key = 'drug'
            """)
        asset_rows = await conn.fetch("""
            SELECT asset_id::text AS asset_id, object_key, source_filename, asset_group
            FROM drug.assets
            WHERE object_key IS NOT NULL AND object_key <> ''
            """)
        asset_object_keys = {
            str(r["object_key"])
            for r in asset_rows
            if str(r["object_key"] or "").strip()
        }
        async with conn.transaction():
            snapshot_count = await conn.fetchval(
                "SELECT COUNT(*) FROM drug.index_snapshots"
            )
            license_count = await conn.fetchval("SELECT COUNT(*) FROM drug.licenses")
            ingredient_count = await conn.fetchval(
                "SELECT COUNT(*) FROM drug.ingredients"
            )
            atc_count = await conn.fetchval("SELECT COUNT(*) FROM drug.atc")
            insert_count = await conn.fetchval(
                "SELECT COUNT(*) FROM drug.electronic_inserts"
            )
            appearance_count = await conn.fetchval(
                "SELECT COUNT(*) FROM drug.appearance_records"
            )
            asset_count = await conn.fetchval("SELECT COUNT(*) FROM drug.assets")
            analysis_count = await conn.fetchval(
                "SELECT COUNT(*) FROM drug.insert_analysis"
            )
            normalized_count = await conn.fetchval(
                "SELECT COUNT(*) FROM drug.normalized_records"
            )
            run_count = await conn.fetchval("SELECT COUNT(*) FROM drug.import_runs")
            state_count = await conn.fetchval(
                "SELECT COUNT(*) FROM drug.import_license_state"
            )
            event_count = await conn.fetchval(
                "SELECT COUNT(*) FROM drug.import_stage_events"
            )
            queue_count = await conn.fetchval(
                "SELECT COUNT(*) FROM drug.enrichment_queue"
            )
            await conn.execute("""
                TRUNCATE
                    drug.enrichment_queue,
                    drug.import_stage_events,
                    drug.import_license_state,
                    drug.import_runs,
                    drug.normalized_records,
                    drug.insert_analysis,
                    drug.assets,
                    drug.appearance_records,
                    drug.electronic_inserts,
                    drug.atc,
                    drug.ingredients,
                    drug.licenses,
                    drug.index_snapshots
                RESTART IDENTITY CASCADE
                """)
            await conn.execute(
                "DELETE FROM admin.uploaded_files WHERE module_key = 'drug'"
            )
            await conn.execute(
                """
                INSERT INTO admin.admin_audit_log
                    (admin_user, action, target_type, target_id, payload_json)
                VALUES ($1, 'clear_module', 'module', 'drug', $2::jsonb)
                """,
                cleared_by,
                json.dumps(
                    {
                        "snapshots_truncated": int(snapshot_count or 0),
                        "licenses_truncated": int(license_count or 0),
                        "ingredients_truncated": int(ingredient_count or 0),
                        "atc_truncated": int(atc_count or 0),
                        "electronic_inserts_truncated": int(insert_count or 0),
                        "appearance_records_truncated": int(appearance_count or 0),
                        "assets_truncated": int(asset_count or 0),
                        "insert_analysis_truncated": int(analysis_count or 0),
                        "normalized_records_truncated": int(normalized_count or 0),
                        "import_runs_truncated": int(run_count or 0),
                        "import_license_state_truncated": int(state_count or 0),
                        "import_stage_events_truncated": int(event_count or 0),
                        "enrichment_queue_truncated": int(queue_count or 0),
                        "files_deleted": [r["original_filename"] for r in file_rows],
                        "asset_objects_deleted": len(asset_object_keys),
                    },
                    ensure_ascii=False,
                ),
            )
    if minio_service is not None:
        seen_object_keys: set[str] = set()
        for row in [*file_rows, *asset_rows]:
            object_key = row["object_key"] or ""
            if not object_key or object_key in seen_object_keys:
                continue
            seen_object_keys.add(object_key)
            try:
                await minio_service.remove_object(object_key)
            except Exception:
                pass
    logger.info(
        "Cleared Drug module: %s licenses, %s assets, %s queue row(s), %s upload file(s) removed by %s",
        license_count,
        asset_count,
        queue_count,
        len(file_rows),
        cleared_by,
    )
    return {
        "module_key": "drug",
        "snapshots_truncated": int(snapshot_count or 0),
        "licenses_truncated": int(license_count or 0),
        "ingredients_truncated": int(ingredient_count or 0),
        "atc_truncated": int(atc_count or 0),
        "electronic_inserts_truncated": int(insert_count or 0),
        "appearance_records_truncated": int(appearance_count or 0),
        "assets_truncated": int(asset_count or 0),
        "insert_analysis_truncated": int(analysis_count or 0),
        "normalized_records_truncated": int(normalized_count or 0),
        "import_runs_truncated": int(run_count or 0),
        "import_license_state_truncated": int(state_count or 0),
        "import_stage_events_truncated": int(event_count or 0),
        "enrichment_queue_truncated": int(queue_count or 0),
        "files_deleted": len(file_rows),
        "asset_objects_deleted": len(asset_object_keys),
    }
