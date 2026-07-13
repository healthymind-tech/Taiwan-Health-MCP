"""
Generic admin job, control, and worker-heartbeat helpers.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import logging
import os
import sys
import tarfile
import tempfile
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import asyncpg

from admin_services import get_unhealthy_dependencies
from admin_sources import safe_source_filename
from admin_ws import broadcast
from database import PoolLike
from minio_service import MinioService

PHASE2_JOB_TYPES = {"noop"}
SIMPLE_LOADER_JOB_TYPES = {
    "guideline_seed",
    "health_supplements_sync",
    "food_nutrition_sync",
}
HEAVY_LOADER_JOB_TYPES = {
    "icd_import",
    "loinc_import",
    "ig_import",
    "snomed_import",
    "rxnorm_import",
}
DRUG_JOB_TYPES = {
    "drug_index_import",
    "drug_enrichment",
    "drug_analysis",
}
EMBED_JOB_TYPES = {
    "icd_embed",
    "loinc_embed",
    "health_supplements_embed",
    "food_nutrition_embed",
    "guideline_embed",
    "snomed_embed",
}
ADMIN_JOB_TYPES = (
    PHASE2_JOB_TYPES
    | SIMPLE_LOADER_JOB_TYPES
    | HEAVY_LOADER_JOB_TYPES
    | DRUG_JOB_TYPES
    | EMBED_JOB_TYPES
)

# ── Resource-based concurrency ────────────────────────────────────────────────
# Each resource allows at most one concurrent job.  Jobs with *no* resource
# entry (e.g. "noop") can always run in parallel with everything else.
#
# Writers are slotted *per module* rather than behind one global "db_writer"
# lock: ICD / LOINC / TWCore / SNOMED write to different schemas and their own
# admin.stage_* tables, so they have no cross-module lock contention and may
# import in parallel. A job still excludes a second instance of *itself* because
# both instances need the same per-module slot. The worker additionally caps
# total concurrency via ADMIN_MAX_CONCURRENT_JOBS to bound peak memory (the
# loaders parse large modules in-process; SNOMED is the heaviest).
#
# Resources:
#   db_write_<module> — one import per module at a time (parallel across modules)
#   ollama_embed       — Ollama embedding API; single GPU queue
#   llm                — LLM / OCR inference; single GPU queue (may differ from embed)
JOB_RESOURCES: dict[str, frozenset[str]] = {
    "db_write_icd": frozenset({"icd_import"}),
    "db_write_loinc": frozenset({"loinc_import"}),
    "db_write_ig": frozenset({"ig_import"}),
    "db_write_snomed": frozenset({"snomed_import"}),
    "db_write_rxnorm": frozenset({"rxnorm_import"}),
    "db_write_guideline": frozenset({"guideline_seed"}),
    "db_write_health_supplements": frozenset({"health_supplements_sync"}),
    "db_write_food_nutrition": frozenset({"food_nutrition_sync"}),
    # Drug Phase 1/2 write the same drug.* tables (enrichment depends on the
    # index) — keep them serialised behind one drug slot.
    "db_write_drug": frozenset({"drug_index_import", "drug_enrichment"}),
    "ollama_embed": frozenset(EMBED_JOB_TYPES),
    "llm": frozenset({"drug_analysis"}),
}

# Inverted index: job_type → frozenset of resources it needs
JOB_TYPE_RESOURCES: dict[str, frozenset[str]] = {}
for _resource, _types in JOB_RESOURCES.items():
    for _jt in _types:
        JOB_TYPE_RESOURCES[_jt] = JOB_TYPE_RESOURCES.get(_jt, frozenset()) | frozenset(
            [_resource]
        )
# Clean up loop variables
del _resource, _types, _jt




CONTROL_ACTIONS = ("pause", "resume", "stop", "restart")
FINAL_JOB_STATUSES = {
    "success",
    "partial_success",
    "retryable_failed",
    "permanent_failed",
    "stopped",
    "cancelled",
}

JOB_TYPE_MODULE_KEYS = {
    "noop": "admin",
    "guideline_seed": "guideline",
    "health_supplements_sync": "health_supplements",
    "food_nutrition_sync": "food_nutrition",
    "icd_import": "icd",
    "loinc_import": "loinc",
    "ig_import": "ig",
    "snomed_import": "snomed",
    "rxnorm_import": "rxnorm",
    "drug_index_import": "drug",
    "drug_enrichment": "drug",
    "drug_analysis": "drug",
    # Embedding jobs — one per embeddable module
    "icd_embed": "icd",
    "loinc_embed": "loinc",
    "health_supplements_embed": "health_supplements",
    "food_nutrition_embed": "food_nutrition",
    "guideline_embed": "guideline",
    "snomed_embed": "snomed",
}


@dataclass(frozen=True)
class HeavyJobSourceSpec:
    module_key: str
    required_roles: tuple[str, ...]
    optional_roles: tuple[str, ...] = ()


HEAVY_JOB_SOURCE_SPECS: dict[str, HeavyJobSourceSpec] = {
    # All source files must be uploaded+active before the import can run (admin
    # decision): every role is required, none optional. _resolve_heavy_source
    # raises "Missing active uploaded source(s)" if any are absent.
    "icd_import": HeavyJobSourceSpec(
        module_key="icd",
        required_roles=("icd10cm", "icd10pcs", "icd_zh_tw"),
    ),
    "loinc_import": HeavyJobSourceSpec(
        module_key="loinc",
        required_roles=("loinc", "loinc_taiwan_mapping", "loinc_reference_ranges"),
    ),
    # NOTE: ``ig_import`` is intentionally NOT here. An IG import is driven by an
    # explicit descriptor in ``job_options`` — either a registry coordinate
    # (``{"ig_source": "registry", "package_id", "version"}``) or an uploaded
    # object key (``{"ig_source": "upload", "object_key"}``) — so it must not go
    # through the role-manifest resolver (which would require an uploaded source
    # and break registry-only imports). See ``_run_ig_import_job``.
    "snomed_import": HeavyJobSourceSpec(
        module_key="snomed",
        required_roles=("snomed_ct",),
    ),
    "rxnorm_import": HeavyJobSourceSpec(
        module_key="rxnorm",
        required_roles=("rxnorm_full",),
    ),
    "drug_index_import": HeavyJobSourceSpec(
        module_key="drug",
        required_roles=("drug_index_csv",),
    ),
}


@dataclass(frozen=True)
class AdminJob:
    job_id: str
    module_key: str
    job_type: str
    requested_by: str
    status: str
    control_state: str
    progress_current: int
    progress_total: int
    current_step: str
    worker_name: str
    created_at: str
    started_at: str
    finished_at: str
    last_error_code: str
    last_error_message: str
    job_options: dict[str, Any]
    result_summary: dict[str, Any]

    @classmethod
    def from_row(cls, row: asyncpg.Record) -> "AdminJob":
        return cls(
            job_id=str(row["job_id"]),
            module_key=row["module_key"] or "",
            job_type=row["job_type"] or "",
            requested_by=row["requested_by"] or "",
            status=row["status"] or "",
            control_state=row["control_state"] or "",
            progress_current=int(row["progress_current"] or 0),
            progress_total=int(row["progress_total"] or 0),
            current_step=row["current_step"] or "",
            worker_name=row["worker_name"] or "",
            created_at=_iso(row["created_at"]),
            started_at=_iso(row["started_at"]),
            finished_at=_iso(row["finished_at"]),
            last_error_code=row["last_error_code"] or "",
            last_error_message=row["last_error_message"] or "",
            job_options=_json_object(row["job_options_json"]),
            result_summary=_json_object(row["result_summary_json"]),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "module_key": self.module_key,
            "job_type": self.job_type,
            "requested_by": self.requested_by,
            "status": self.status,
            "control_state": self.control_state,
            "progress_current": self.progress_current,
            "progress_total": self.progress_total,
            "current_step": self.current_step,
            "worker_name": self.worker_name,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "last_error_code": self.last_error_code,
            "last_error_message": self.last_error_message,
            "job_options": self.job_options,
            "result_summary": self.result_summary,
            "available_actions": available_job_actions(
                self.status,
                self.control_state,
            ),
        }


@dataclass(frozen=True)
class WorkerHeartbeat:
    worker_name: str
    process_id: int
    status: str
    current_job_id: str
    last_heartbeat_at: str
    stale: bool
    details: dict[str, Any]

    @classmethod
    def from_row(
        cls,
        row: asyncpg.Record,
        *,
        now: datetime,
        stale_after_seconds: int,
    ) -> "WorkerHeartbeat":
        last_heartbeat = row["last_heartbeat_at"]
        stale = is_heartbeat_stale(
            last_heartbeat,
            now=now,
            stale_after_seconds=stale_after_seconds,
        )
        return cls(
            worker_name=row["worker_name"] or "",
            process_id=int(row["process_id"] or 0),
            status=row["status"] or "",
            current_job_id=str(row["current_job_id"]) if row["current_job_id"] else "",
            last_heartbeat_at=_iso(last_heartbeat),
            stale=stale,
            details=_parse_jsonb(row["details_json"]),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "worker_name": self.worker_name,
            "process_id": self.process_id,
            "status": self.status,
            "current_job_id": self.current_job_id,
            "last_heartbeat_at": self.last_heartbeat_at,
            "stale": self.stale,
            "details": self.details,
        }


def _iso(value: Any) -> str:
    if value is None:
        return ""
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _parse_jsonb(value: Any) -> dict[str, Any]:
    """asyncpg returns JSONB columns as raw JSON strings, not dicts.
    Parse them here so callers always receive a Python dict."""
    if value is None:
        return {}
    if isinstance(value, str):
        try:
            result = json.loads(value)
            return result if isinstance(result, dict) else {}
        except Exception:
            return {}
    if isinstance(value, dict):
        return value
    return {}


def _json_object(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return {}
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}








def admin_worker_stale_after_seconds() -> int:
    return int(os.getenv("ADMIN_WORKER_STALE_AFTER_SECONDS", "45"))


def admin_noop_checkpoint_delay_seconds() -> float:
    return float(os.getenv("ADMIN_NOOP_CHECKPOINT_DELAY_SECONDS", "0.35"))


def _ensure_repo_root_on_path() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    repo_root_text = str(repo_root)
    if repo_root_text not in sys.path:
        sys.path.insert(0, repo_root_text)
    # loader/main.py and its submodules use bare top-level imports
    # (`from dataset_config import ...`, `from loaders.xxx import ...`) that
    # only resolve when the loader directory itself is on sys.path — the same
    # environment as running `python loader/main.py` directly. Importing
    # `loader.main` as a package does not put loader/ on the path, so add it
    # here, otherwise every loader-backed job fails with ModuleNotFoundError.
    loader_dir_text = str(repo_root / "loader")
    if loader_dir_text not in sys.path:
        sys.path.insert(0, loader_dir_text)


def is_heartbeat_stale(
    last_heartbeat_at: datetime | None,
    *,
    now: datetime | None = None,
    stale_after_seconds: int | None = None,
) -> bool:
    if last_heartbeat_at is None:
        return True
    now = now or datetime.now(timezone.utc)
    threshold = stale_after_seconds or admin_worker_stale_after_seconds()
    return (now - last_heartbeat_at) > timedelta(seconds=threshold)


def available_job_actions(status: str, control_state: str) -> list[str]:
    status = (status or "").strip()
    control_state = (control_state or "").strip()

    if status == "queued":
        return ["pause", "stop", "restart"] if control_state == "idle" else []
    if status == "running":
        if control_state in ("idle", "resume_requested"):
            return ["pause", "stop", "restart"]
        return []
    if status == "paused":
        return ["resume", "stop", "restart"]
    if status in FINAL_JOB_STATUSES:
        return ["restart"]
    return []


def _job_expected_module(job_type: str) -> str | None:
    return JOB_TYPE_MODULE_KEYS.get((job_type or "").strip())


async def _fetch_module_source_row(
    conn: asyncpg.Connection,
    *,
    module_source_id: str = "",
    uploaded_file_id: str = "",
) -> dict[str, Any] | None:
    if module_source_id:
        row = await conn.fetchrow(
            """
            SELECT
                ds.module_source_id::text AS module_source_id,
                ds.module_key,
                ds.source_role,
                ds.is_active,
                uf.uploaded_file_id::text AS uploaded_file_id,
                uf.original_filename,
                uf.mime_type,
                uf.size_bytes,
                uf.sha256,
                uf.bucket,
                uf.object_key,
                uf.minio_uri,
                uf.uploaded_by,
                uf.uploaded_at
            FROM admin.module_sources ds
            JOIN admin.uploaded_files uf
              ON uf.uploaded_file_id = ds.uploaded_file_id
            WHERE ds.module_source_id = $1::uuid
            """,
            module_source_id,
        )
        return dict(row) if row is not None else None
    if uploaded_file_id:
        row = await conn.fetchrow(
            """
            SELECT
                ds.module_source_id::text AS module_source_id,
                ds.module_key,
                ds.source_role,
                ds.is_active,
                uf.uploaded_file_id::text AS uploaded_file_id,
                uf.original_filename,
                uf.mime_type,
                uf.size_bytes,
                uf.sha256,
                uf.bucket,
                uf.object_key,
                uf.minio_uri,
                uf.uploaded_by,
                uf.uploaded_at
            FROM admin.uploaded_files uf
            JOIN admin.module_sources ds
              ON ds.uploaded_file_id = uf.uploaded_file_id
            WHERE uf.uploaded_file_id = $1::uuid
            ORDER BY ds.is_active DESC, ds.activated_at DESC NULLS LAST
            LIMIT 1
            """,
            uploaded_file_id,
        )
        return dict(row) if row is not None else None
    return None


async def _resolve_job_source_manifest(
    conn: asyncpg.Connection,
    *,
    module_key: str,
    job_type: str,
    source_module_source_id: str = "",
    source_uploaded_file_id: str = "",
) -> dict[str, Any]:
    spec = HEAVY_JOB_SOURCE_SPECS[job_type]
    if module_key != spec.module_key:
        raise ValueError(
            f"Job type '{job_type}' must use module_key '{spec.module_key}', got '{module_key}'"
        )

    # Fetch ALL uploaded sources for the module (active and pending), newest
    # first. Activation no longer happens at upload time — it happens when an
    # import succeeds (see _activate_manifest_sources). So we must be able to
    # resolve a freshly-uploaded, not-yet-active file as the source to import.
    all_rows = await conn.fetch(
        """
        SELECT
            ds.module_source_id::text AS module_source_id,
            ds.module_key,
            ds.source_role,
            ds.is_active,
            uf.uploaded_file_id::text AS uploaded_file_id,
            uf.original_filename,
            uf.mime_type,
            uf.size_bytes,
            uf.sha256,
            uf.bucket,
            uf.object_key,
            uf.minio_uri,
            uf.uploaded_by,
            uf.uploaded_at
        FROM admin.module_sources ds
        JOIN admin.uploaded_files uf
          ON uf.uploaded_file_id = ds.uploaded_file_id
        WHERE ds.module_key = $1
        ORDER BY ds.source_role, uf.uploaded_at DESC NULLS LAST
        """,
        module_key,
    )

    # Determine which roles are multi-source from the catalog
    from admin_sources import CATALOG_BY_KEY as _CATALOG_BY_KEY

    multi_source_roles: set[str] = {
        k[1]
        for k, v in _CATALOG_BY_KEY.items()
        if v.multi_source and k[0] == module_key
    }

    # Group rows by role (already sorted newest-first within each role).
    bindings_by_role_raw: dict[str, list[dict[str, Any]]] = {}
    for row in all_rows:
        role = str(row["source_role"])
        bindings_by_role_raw.setdefault(role, []).append(dict(row))

    bindings_by_role: dict[str, Any] = {}
    for role, rows in bindings_by_role_raw.items():
        if role in multi_source_roles:
            # Multi-source (e.g. drug index): the cumulative active set is the
            # set of already-imported (active) files. Per-file imports override
            # this via explicit_source below. When nothing has been imported yet
            # (no active rows), a bulk import uses all uploaded files.
            active = [r for r in rows if r.get("is_active")]
            bindings_by_role[role] = active if active else rows
        else:
            # Single-source: import the most recently uploaded file for the
            # role, whether or not it has been activated yet.
            bindings_by_role[role] = rows[0]

    explicit_source = await _fetch_module_source_row(
        conn,
        module_source_id=source_module_source_id,
        uploaded_file_id=source_uploaded_file_id,
    )
    if explicit_source is not None:
        if explicit_source["module_key"] != module_key:
            raise ValueError(
                f"Selected source belongs to module '{explicit_source['module_key']}', not '{module_key}'"
            )
        role = str(explicit_source["source_role"])
        # An explicitly selected uploaded file means "import exactly this file" —
        # bind it as a single source even for multi-source roles, and drop the
        # role from multi_source_roles for this job so it is materialized as one
        # file (not combined with all active sources). This is what the drug
        # cumulative per-file "Import this file" action relies on.
        bindings_by_role[role] = explicit_source
        multi_source_roles.discard(role)

    # Validate required roles — for multi-source roles require at least one entry
    missing_required = []
    for role in spec.required_roles:
        binding = bindings_by_role.get(role)
        if binding is None:
            missing_required.append(role)
        elif role in multi_source_roles and len(binding) == 0:
            missing_required.append(role)
    if missing_required:
        roles = ", ".join(missing_required)
        raise ValueError(f"Missing uploaded source(s) for {module_key}: {roles}")

    def _row_to_binding(row: dict[str, Any]) -> dict[str, Any]:
        uploaded_at = row.get("uploaded_at")
        return {
            "module_source_id": row["module_source_id"],
            "module_key": row["module_key"],
            "source_role": row["source_role"],
            "uploaded_file_id": row["uploaded_file_id"],
            "original_filename": row["original_filename"],
            "mime_type": row.get("mime_type") or "",
            "size_bytes": int(row.get("size_bytes") or 0),
            "sha256": row.get("sha256") or "",
            "bucket": row.get("bucket") or "",
            "object_key": row.get("object_key") or "",
            "minio_uri": row.get("minio_uri") or "",
            "uploaded_by": row.get("uploaded_by") or "",
            "uploaded_at": _iso(uploaded_at),
            "is_active": bool(row.get("is_active")),
        }

    bound_at = datetime.now(timezone.utc).isoformat()
    roles_in_order = spec.required_roles + spec.optional_roles
    bindings: dict[str, Any] = {}
    for role in roles_in_order:
        raw = bindings_by_role.get(role)
        if raw is None:
            continue
        if role in multi_source_roles:
            bindings[role] = [_row_to_binding(r) for r in raw]
        else:
            bindings[role] = _row_to_binding(raw)

    primary_role = (
        str(explicit_source["source_role"])
        if explicit_source is not None
        else spec.required_roles[0]
    )
    primary_binding_raw = bindings[primary_role]
    # For primary, use first entry of a multi-source list
    primary_binding = (
        primary_binding_raw[0]
        if isinstance(primary_binding_raw, list)
        else primary_binding_raw
    )
    return {
        "module_key": module_key,
        "job_type": job_type,
        "bound_at": bound_at,
        "required_roles": list(spec.required_roles),
        "optional_roles": list(spec.optional_roles),
        "primary_source_role": primary_role,
        "primary_module_source_id": primary_binding["module_source_id"],
        "primary_uploaded_file_id": primary_binding["uploaded_file_id"],
        "bindings": bindings,
    }


async def create_job(
    pool: PoolLike,
    *,
    module_key: str,
    job_type: str,
    requested_by: str,
    job_options: dict[str, Any] | None = None,
    source_module_source_id: str = "",
    source_uploaded_file_id: str = "",
    parent_job_id: str = "",
) -> dict[str, Any]:
    job_type = (job_type or "").strip()
    module_key = (module_key or "").strip()
    expected_module = _job_expected_module(job_type)
    if expected_module is None:
        raise ValueError(f"Unsupported admin job type: {job_type}")
    if module_key != expected_module:
        raise ValueError(
            f"Job type '{job_type}' must use module_key '{expected_module}', got '{module_key}'"
        )

    job_id = uuid.uuid4()
    options = dict(job_options or {})
    async with pool.acquire() as conn:
        if job_type in HEAVY_JOB_SOURCE_SPECS:
            manifest = await _resolve_job_source_manifest(
                conn,
                module_key=module_key,
                job_type=job_type,
                source_module_source_id=source_module_source_id,
                source_uploaded_file_id=source_uploaded_file_id,
            )
            options["source_manifest"] = manifest
            source_module_source_id = (
                source_module_source_id or manifest["primary_module_source_id"]
            )
            source_uploaded_file_id = (
                source_uploaded_file_id or manifest["primary_uploaded_file_id"]
            )
        row = await conn.fetchrow(
            """
            INSERT INTO admin.import_jobs (
                job_id,
                module_key,
                job_type,
                requested_by,
                source_module_source_id,
                source_uploaded_file_id,
                parent_job_id,
                status,
                control_state,
                current_step,
                job_options_json,
                result_summary_json
            )
            VALUES (
                $1, $2, $3, $4,
                NULLIF($5, '')::uuid,
                NULLIF($6, '')::uuid,
                NULLIF($7, '')::uuid,
                'queued', 'idle', 'queued',
                $8::jsonb, '{}'::jsonb
            )
            RETURNING *
            """,
            job_id,
            module_key,
            job_type,
            requested_by,
            source_module_source_id,
            source_uploaded_file_id,
            parent_job_id,
            json.dumps(options, ensure_ascii=False),
        )
        if row is None:
            raise RuntimeError("Failed to create admin job")
        await conn.execute(
            """
            INSERT INTO admin.import_job_logs (job_id, level, message, payload_json)
            VALUES ($1, 'info', 'Job created', $2::jsonb)
            """,
            job_id,
            json.dumps(
                {
                    "module_key": module_key,
                    "job_type": job_type,
                    "parent_job_id": parent_job_id,
                },
                ensure_ascii=False,
            ),
        )
    return AdminJob.from_row(row).to_dict()




async def get_job(pool: PoolLike, *, job_id: str) -> dict[str, Any] | None:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT *
            FROM admin.import_jobs
            WHERE job_id = $1
            """,
            uuid.UUID(job_id),
        )
    if row is None:
        return None
    return AdminJob.from_row(row).to_dict()




async def get_job_step_checkpoint(
    pool: PoolLike,
    *,
    job_id: str,
    step_key: str,
) -> dict[str, Any]:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT checkpoint_json
            FROM admin.import_job_steps
            WHERE job_id = $1
              AND step_key = $2
            """,
            uuid.UUID(job_id),
            step_key,
        )
    return _parse_jsonb(row["checkpoint_json"]) if row is not None else {}














async def record_job_step(
    pool: PoolLike,
    *,
    job_id: str,
    step_key: str,
    status: str,
    progress_current: int = 0,
    progress_total: int = 0,
    checkpoint: dict[str, Any] | None = None,
    last_error_message: str = "",
) -> None:
    checkpoint = checkpoint or {}
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO admin.import_job_steps (
                job_id,
                step_key,
                status,
                progress_current,
                progress_total,
                started_at,
                finished_at,
                checkpoint_json,
                last_error_message
            )
            VALUES (
                $1,
                $2,
                $3,
                $4,
                $5,
                NOW(),
                CASE
                    WHEN $3 IN ('success', 'partial_success', 'retryable_failed', 'permanent_failed', 'paused', 'stopped', 'cancelled')
                    THEN NOW()
                    ELSE NULL
                END,
                $6::jsonb,
                NULLIF($7, '')
            )
            ON CONFLICT (job_id, step_key) DO UPDATE SET
                status = EXCLUDED.status,
                progress_current = EXCLUDED.progress_current,
                progress_total = EXCLUDED.progress_total,
                checkpoint_json = EXCLUDED.checkpoint_json,
                last_error_message = EXCLUDED.last_error_message,
                finished_at = EXCLUDED.finished_at
            RETURNING finished_at
            """,
            uuid.UUID(job_id),
            step_key,
            status,
            progress_current,
            progress_total,
            json.dumps(checkpoint, ensure_ascii=False),
            last_error_message,
        )
    asyncio.create_task(
        broadcast(
            "job_step_updated",
            {
                "job_id": job_id,
                "step_key": step_key,
                "status": status,
                "progress_current": progress_current,
                "progress_total": progress_total,
                "finished_at": (
                    row["finished_at"].isoformat()
                    if (row and row["finished_at"])
                    else None
                ),
            },
        )
    )


async def append_job_log(
    pool: PoolLike,
    *,
    job_id: str,
    level: str,
    message: str,
    payload: dict[str, Any] | None = None,
) -> None:
    payload = payload or {}
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO admin.import_job_logs (job_id, level, message, payload_json)
            VALUES ($1, $2, $3, $4::jsonb)
            RETURNING created_at
            """,
            uuid.UUID(job_id),
            level,
            message,
            json.dumps(payload, ensure_ascii=False),
        )
    asyncio.create_task(
        broadcast(
            "job_log_line",
            {
                "job_id": job_id,
                "level": level,
                "message": message,
                "payload": payload,
                "timestamp": row["created_at"].isoformat() if row else _iso(None),
            },
        )
    )


async def _activate_manifest_sources(pool: PoolLike, manifest: dict[str, Any]) -> None:
    """Mark the uploaded files imported by a successful job as the active source.

    Upload no longer activates a source — activation happens here, once the
    import actually succeeds, so "active" reliably means "currently loaded in
    the database". Best-effort: a bookkeeping failure must never fail the job.
    """
    from admin_sources import activate_source

    seen: set[str] = set()
    for binding in (manifest.get("bindings") or {}).values():
        items = binding if isinstance(binding, list) else [binding]
        for b in items:
            ufid = str((b or {}).get("uploaded_file_id") or "").strip()
            if not ufid or ufid in seen:
                continue
            seen.add(ufid)
            # Already active (e.g. a re-import of the current source) — leave it
            # be so we don't churn version_num / activated_at on every re-run.
            if (b or {}).get("is_active"):
                continue
            try:
                await activate_source(
                    pool, uploaded_file_id=ufid, activated_by="import-job"
                )
            except Exception as exc:  # noqa: BLE001
                logging.getLogger(__name__).warning(
                    "Failed to activate source %s after import: %s", ufid, exc
                )


async def mark_job_status(
    pool: PoolLike,
    *,
    job_id: str,
    status: str,
    current_step: str,
    progress_current: int | None = None,
    progress_total: int | None = None,
    control_state: str | None = None,
    last_error_code: str = "",
    last_error_message: str = "",
    result_summary: dict[str, Any] | None = None,
) -> None:
    result_summary = result_summary or {}
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE admin.import_jobs
            SET
                status = $2,
                current_step = $3,
                progress_current = COALESCE($4, progress_current),
                progress_total = COALESCE($5, progress_total),
                control_state = COALESCE($6, control_state),
                finished_at = CASE
                    WHEN $2 IN ('success', 'partial_success', 'retryable_failed', 'permanent_failed', 'stopped', 'cancelled')
                    THEN NOW()
                    ELSE finished_at
                END,
                last_error_code = NULLIF($7, ''),
                last_error_message = NULLIF($8, ''),
                result_summary_json = CASE
                    WHEN $9::jsonb = '{}'::jsonb THEN result_summary_json
                    ELSE $9::jsonb
                END,
                updated_at = NOW()
            WHERE job_id = $1
            RETURNING job_type, module_key, progress_current, progress_total, updated_at
            """,
            uuid.UUID(job_id),
            status,
            current_step,
            progress_current,
            progress_total,
            control_state,
            last_error_code,
            last_error_message,
            json.dumps(result_summary, ensure_ascii=False),
        )
    if row:
        # On a successful import, promote the imported file(s) to active. The
        # terminal success call carries the resolved source_manifest.
        manifest = result_summary.get("source_manifest")
        if (
            status in ("success", "partial_success")
            and isinstance(manifest, dict)
            and manifest.get("bindings")
        ):
            await _activate_manifest_sources(pool, manifest)
        asyncio.create_task(
            broadcast(
                "job_status_changed",
                {
                    "job_id": job_id,
                    "job_type": row["job_type"],
                    "module_key": row["module_key"] or "",
                    "status": status,
                    "current_step": current_step,
                    "progress_current": row["progress_current"] or 0,
                    "progress_total": row["progress_total"] or 0,
                    "updated_at": (
                        row["updated_at"].isoformat() if row["updated_at"] else ""
                    ),
                },
            )
        )


async def _create_restart_job_locked(
    conn: asyncpg.Connection,
    *,
    source_job_row: asyncpg.Record,
    requested_by: str,
) -> dict[str, Any]:
    new_job_id = uuid.uuid4()
    row = await conn.fetchrow(
        """
        INSERT INTO admin.import_jobs (
            job_id,
            module_key,
            job_type,
            requested_by,
            status,
            control_state,
            source_module_source_id,
            source_uploaded_file_id,
            parent_job_id,
            current_step,
            job_options_json,
            result_summary_json
        )
        VALUES (
            $1, $2, $3, $4,
            'queued', 'idle',
            $5, $6, $7,
            'queued',
            $8::jsonb,
            '{}'::jsonb
        )
        RETURNING *
        """,
        new_job_id,
        source_job_row["module_key"],
        source_job_row["job_type"],
        requested_by,
        source_job_row["source_module_source_id"],
        source_job_row["source_uploaded_file_id"],
        source_job_row["job_id"],
        json.dumps(
            _parse_jsonb(source_job_row["job_options_json"]), ensure_ascii=False
        ),
    )
    if row is None:
        raise RuntimeError("Failed to create restart job")
    await conn.execute(
        """
        INSERT INTO admin.import_job_logs (job_id, level, message, payload_json)
        VALUES ($1, 'info', 'Job created by restart request', $2::jsonb)
        """,
        new_job_id,
        json.dumps(
            {
                "parent_job_id": str(source_job_row["job_id"]),
                "requested_by": requested_by,
            },
            ensure_ascii=False,
        ),
    )
    return AdminJob.from_row(row).to_dict()




async def checkpoint_job_control(
    pool: PoolLike,
    *,
    job_id: str,
    worker_name: str,
) -> dict[str, Any] | None:
    async with pool.acquire() as conn:
        async with conn.transaction():
            job_row = await conn.fetchrow(
                """
                SELECT *
                FROM admin.import_jobs
                WHERE job_id = $1
                FOR UPDATE
                """,
                uuid.UUID(job_id),
            )
            if job_row is None:
                return None

            control_state = (job_row["control_state"] or "").strip()
            if control_state not in {
                "pause_requested",
                "stop_requested",
                "restart_requested",
            }:
                return None

            control_row = await conn.fetchrow(
                """
                SELECT *
                FROM admin.job_control_requests
                WHERE job_id = $1
                  AND handled_at IS NULL
                ORDER BY requested_at DESC, control_request_id DESC
                LIMIT 1
                FOR UPDATE
                """,
                uuid.UUID(job_id),
            )
            action = (
                str(control_row["action"]).strip().lower()
                if control_row is not None
                else control_state.replace("_requested", "")
            )
            restart_job: dict[str, Any] | None = None
            result_message = ""

            if action == "pause":
                await conn.execute(
                    """
                    UPDATE admin.import_jobs
                    SET status = 'paused',
                        control_state = 'paused',
                        current_step = 'paused',
                        updated_at = NOW()
                    WHERE job_id = $1
                    """,
                    uuid.UUID(job_id),
                )
                result_message = "Job paused at checkpoint boundary."
            elif action == "stop":
                await conn.execute(
                    """
                    UPDATE admin.import_jobs
                    SET status = 'stopped',
                        control_state = 'idle',
                        current_step = 'stopped',
                        finished_at = NOW(),
                        updated_at = NOW()
                    WHERE job_id = $1
                    """,
                    uuid.UUID(job_id),
                )
                result_message = "Job stopped at checkpoint boundary."
            elif action == "restart":
                restart_job = await _create_restart_job_locked(
                    conn,
                    source_job_row=job_row,
                    requested_by=(
                        control_row["requested_by"]
                        if control_row is not None
                        else worker_name
                    ),
                )
                await conn.execute(
                    """
                    UPDATE admin.import_jobs
                    SET status = 'stopped',
                        control_state = 'idle',
                        current_step = 'restarted',
                        finished_at = NOW(),
                        updated_at = NOW()
                    WHERE job_id = $1
                    """,
                    uuid.UUID(job_id),
                )
                result_message = f"Restart job created: {restart_job['job_id']}"
            else:
                return None

            if control_row is not None:
                await conn.execute(
                    """
                    UPDATE admin.job_control_requests
                    SET handled_at = NOW(),
                        result_status = 'applied',
                        result_message = $2
                    WHERE control_request_id = $1
                    """,
                    int(control_row["control_request_id"]),
                    result_message,
                )
            await conn.execute(
                """
                INSERT INTO admin.import_job_logs (job_id, level, message, payload_json)
                VALUES ($1, 'info', $2, $3::jsonb)
                """,
                uuid.UUID(job_id),
                f"Worker applied control action: {action}",
                json.dumps(
                    {
                        "worker_name": worker_name,
                        "action": action,
                        "restart_job_id": restart_job["job_id"] if restart_job else "",
                    },
                    ensure_ascii=False,
                ),
            )
    return {"action": action, "restart_job": restart_job, "message": result_message}




async def _apply_control_checkpoint(
    pool: PoolLike,
    *,
    job_id: str,
    worker_name: str,
) -> bool:
    control = await checkpoint_job_control(
        pool,
        job_id=job_id,
        worker_name=worker_name,
    )
    return control is not None


def _job_source_manifest(job: dict[str, Any]) -> dict[str, Any]:
    return _json_object(_json_object(job.get("job_options")).get("source_manifest"))


@asynccontextmanager
async def _materialize_bound_sources(
    manifest: dict[str, Any],
    *,
    minio_service: MinioService | None,
) -> dict[str, str]:
    if minio_service is None or not minio_service.enabled:
        raise RuntimeError(
            "MinIO is required to materialize admin-managed source files"
        )

    with tempfile.TemporaryDirectory(prefix="admin-job-sources-") as tmpdir:
        local_paths: dict[str, str] = {}
        for role, binding in (manifest.get("bindings") or {}).items():
            if isinstance(binding, list):
                # Multi-source: download all and concatenate, keeping only the first header
                all_data: list[bytes] = []
                for i, b in enumerate(binding):
                    object_key = str(b.get("object_key", "") or "").strip()
                    if not object_key:
                        continue
                    data = await minio_service.download_bytes(object_key)
                    if i == 0:
                        # Ensure file ends with newline so next file's rows start on a new line
                        if data and not data.endswith(b"\n"):
                            data = data + b"\n"
                        all_data.append(data)
                    else:
                        # Strip the header row (first line) from subsequent files
                        nl = data.find(b"\n")
                        if nl >= 0:
                            remainder = data[nl + 1 :]
                            # Ensure this chunk also ends with newline
                            if remainder and not remainder.endswith(b"\n"):
                                remainder = remainder + b"\n"
                            all_data.append(remainder)
                        else:
                            all_data.append(data)
                combined = b"".join(all_data)
                filename = safe_source_filename(
                    str(binding[0].get("original_filename", f"{role}.csv"))
                )
                destination = Path(tmpdir) / f"{role}-combined-{filename}"
                destination.write_bytes(combined)
                local_paths[str(role)] = str(destination)
            else:
                # Single-source: existing behaviour
                object_key = str(binding.get("object_key", "") or "").strip()
                filename = safe_source_filename(
                    str(binding.get("original_filename", "") or f"{role}.bin")
                )
                if not object_key:
                    raise RuntimeError(
                        f"Source binding for role '{role}' is missing object_key"
                    )
                data = await minio_service.download_bytes(object_key)
                destination = Path(tmpdir) / f"{role}-{filename}"
                destination.write_bytes(data)
                local_paths[str(role)] = str(destination)
        yield local_paths






class _ProgressLogThrottle:
    """Decide when to emit an intra-step progress log line, capped at one every
    ``pct_step`` percent or ``secs`` seconds (whichever comes first) so large
    imports (e.g. SNOMED, millions of rows) don't flood the log table / WS."""

    def __init__(self, pct_step: int = 10, secs: float = 5.0) -> None:
        self._pct_step = pct_step
        self._secs = secs
        self._last_pct = 0
        self._last_t = time.monotonic()

    def should(self, current: int, total: int) -> bool:
        if total <= 0:
            return False
        pct = int(current * 100 / total)
        now = time.monotonic()
        if pct >= self._last_pct + self._pct_step or now - self._last_t >= self._secs:
            self._last_pct = pct
            self._last_t = now
            return True
        return False






# Per-job verbose logging. Each job runs in its own asyncio.Task, so a ContextVar
# set at the top of execute_admin_job is naturally scoped to that one job.
_LOG_VERBOSE: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "job_log_verbose", default=False
)
_default_log_verbose = False




def _resolve_log_verbose(job: dict[str, Any]) -> bool:
    opts = _json_object(job.get("job_options"))
    if "log_verbose" in opts:
        return bool(opts["log_verbose"])
    return _default_log_verbose








async def _run_validate_step(
    pool: PoolLike,
    *,
    job_id: str,
    step_key: str,
    current_step: str,
    checkpoint: dict[str, Any],
    job_progress_after: int,
    job_progress_total: int,
) -> None:
    await record_job_step(
        pool,
        job_id=job_id,
        step_key=step_key,
        status="success",
        progress_current=1,
        progress_total=1,
        checkpoint=checkpoint,
    )
    await mark_job_status(
        pool,
        job_id=job_id,
        status="running",
        current_step=current_step,
        progress_current=job_progress_after,
        progress_total=job_progress_total,
    )
    roles = checkpoint.get("source_roles") or []
    await append_job_log(
        pool,
        job_id=job_id,
        level="info",
        message=(
            f"Validated sources: {', '.join(map(str, roles))}"
            if roles
            else "Validated sources"
        ),
        payload=checkpoint,
    )




































# ---------------------------------------------------------------------------
# IG import — registry/upload source acquisition + recursive dependency fetch
# ---------------------------------------------------------------------------

#: Safety cap on the recursive closure size (root + dependency IGs) per import.
_IG_DEP_MAX_PACKAGES = 50


















async def _load_drug_enrichment_candidates(
    conn: asyncpg.Connection,
    *,
    license_ids: list[str],
    limit: int | None,
    include_cancelled: bool,
    retry_failed: bool,
) -> list[str]:
    _ensure_repo_root_on_path()
    from loader.loaders.drug_enrichment_loader import _candidate_licenses

    return await _candidate_licenses(
        conn,
        license_ids=license_ids or None,
        limit=limit,
        include_cancelled=include_cancelled,
        retry_failed=retry_failed,
    )


async def _load_drug_analysis_candidates(
    conn: asyncpg.Connection,
    *,
    license_ids: list[str],
    limit: int | None,
    include_cancelled: bool,
    retry_failed: bool,
    retry_stage: str | None,
) -> list[str]:
    _ensure_repo_root_on_path()
    from loader.loaders.drug_analysis_loader import _candidate_sources

    rows = await _candidate_sources(
        conn,
        license_ids=license_ids or None,
        limit=limit,
        include_cancelled=include_cancelled,
        retry_failed=retry_failed,
        retry_stage=retry_stage,
    )
    return [str(row["license_id"]) for row in rows]


async def _run_drug_index_import_job(
    pool: PoolLike,
    *,
    worker_name: str,
    job: dict[str, Any],
    minio_service: MinioService | None,
) -> None:
    _ensure_repo_root_on_path()
    from loader.loaders.drug_index_loader import load_drug_index

    manifest = _job_source_manifest(job)
    total = 3
    progress = max(int(job.get("progress_current") or 0), 0)
    index_summary: dict[str, Any] = {}
    await append_job_log(
        pool,
        job_id=job["job_id"],
        level="info",
        message="Starting drug index import",
        payload={"source_manifest": manifest},
    )
    async with _materialize_bound_sources(
        manifest, minio_service=minio_service
    ) as paths:
        source_path = paths["drug_index_csv"]
        if progress < 1:
            await _run_validate_step(
                pool,
                job_id=job["job_id"],
                step_key="validate_sources",
                current_step="validated_sources",
                checkpoint={
                    "phase": "validated",
                    "source_roles": sorted(paths.keys()),
                    "source_file": source_path,
                },
                job_progress_after=1,
                job_progress_total=total,
            )
            if await _apply_control_checkpoint(
                pool,
                job_id=job["job_id"],
                worker_name=worker_name,
            ):
                return
            progress = 1

        if progress < 2:
            await record_job_step(
                pool,
                job_id=job["job_id"],
                step_key="index_import",
                status="running",
                progress_current=0,
                progress_total=1,
                checkpoint={"phase": "loading_index"},
            )
            await mark_job_status(
                pool,
                job_id=job["job_id"],
                status="running",
                current_step="loading_drug_index",
                progress_current=1,
                progress_total=total,
            )
            index_summary = await load_drug_index(pool, source_path)
            await record_job_step(
                pool,
                job_id=job["job_id"],
                step_key="index_import",
                status="success",
                progress_current=1,
                progress_total=1,
                checkpoint={"phase": "index_loaded", **(index_summary or {})},
            )
            await mark_job_status(
                pool,
                job_id=job["job_id"],
                status="running",
                current_step="index_loaded",
                progress_current=2,
                progress_total=total,
            )
            if await _apply_control_checkpoint(
                pool,
                job_id=job["job_id"],
                worker_name=worker_name,
            ):
                return

        await record_job_step(
            pool,
            job_id=job["job_id"],
            step_key="finalize",
            status="success",
            progress_current=1,
            progress_total=1,
            checkpoint={"phase": "completed"},
        )
        await mark_job_status(
            pool,
            job_id=job["job_id"],
            status="success",
            current_step="completed",
            progress_current=3,
            progress_total=total,
            control_state="idle",
            result_summary={
                "job_type": "drug_index_import",
                "source_manifest": manifest,
                **(index_summary or {}),
            },
        )


async def _run_drug_enrichment_job(
    pool: PoolLike,
    *,
    worker_name: str,
    job: dict[str, Any],
) -> None:
    _ensure_repo_root_on_path()
    from loader.loaders.drug_enrichment_loader import load_drug_enrichment

    options = _json_object(job.get("job_options"))
    license_ids = [
        str(item) for item in (options.get("license_ids") or []) if str(item).strip()
    ]
    include_cancelled = bool(options.get("include_cancelled"))
    retry_failed = bool(options.get("retry_failed"))
    limit = options.get("limit")
    limit_value = int(limit) if limit not in (None, "") else None

    # DB-backed TFDA + MinIO settings for enrichment (asset writes go to MinIO).
    import admin_settings as _admin_settings
    from minio_service import MinioConfig as _MinioConfig
    from minio_service import MinioService as _MinioService

    _tfda_values = await _admin_settings.get_group(pool, "tfda")
    _enrich_minio = _MinioService(
        _MinioConfig.from_values(await _admin_settings.get_group(pool, "minio"))
    )
    await _enrich_minio.initialize()

    checkpoint = await get_job_step_checkpoint(
        pool,
        job_id=job["job_id"],
        step_key="enrich_licenses",
    )
    candidate_license_ids = [
        str(item)
        for item in (
            checkpoint.get("candidate_license_ids")
            or options.get("candidate_license_ids")
            or []
        )
        if str(item).strip()
    ]
    completed = int(checkpoint.get("completed", 0) or 0)

    if not candidate_license_ids:
        async with pool.acquire() as conn:
            candidate_license_ids = await _load_drug_enrichment_candidates(
                conn,
                license_ids=license_ids,
                limit=limit_value,
                include_cancelled=include_cancelled,
                retry_failed=retry_failed,
            )
        completed = 0

    total_candidates = len(candidate_license_ids)
    total = total_candidates + 2
    await append_job_log(
        pool,
        job_id=job["job_id"],
        level="info",
        message="Starting drug enrichment batch",
        payload={
            "candidate_count": total_candidates,
            "include_cancelled": include_cancelled,
            "retry_failed": retry_failed,
        },
    )
    await record_job_step(
        pool,
        job_id=job["job_id"],
        step_key="select_candidates",
        status="success",
        progress_current=1,
        progress_total=1,
        checkpoint={
            "phase": "selected",
            "candidate_license_ids": candidate_license_ids,
            "candidate_count": total_candidates,
        },
    )
    await mark_job_status(
        pool,
        job_id=job["job_id"],
        status="running",
        current_step="selected_drug_candidates",
        progress_current=1,
        progress_total=total,
    )
    if completed == 0 and await _apply_control_checkpoint(
        pool,
        job_id=job["job_id"],
        worker_name=worker_name,
    ):
        return

    await record_job_step(
        pool,
        job_id=job["job_id"],
        step_key="enrich_licenses",
        status="running",
        progress_current=completed,
        progress_total=total_candidates,
        checkpoint={
            "phase": "running",
            "candidate_license_ids": candidate_license_ids,
            "completed": completed,
        },
    )

    for index in range(completed, total_candidates):
        license_id = candidate_license_ids[index]
        await mark_job_status(
            pool,
            job_id=job["job_id"],
            status="running",
            current_step=f"enriching_{license_id}",
            progress_current=1 + index,
            progress_total=total,
        )
        await load_drug_enrichment(
            pool,
            license_ids=[license_id],
            include_cancelled=include_cancelled,
            retry_failed=retry_failed,
            limit=1,
            tfda_values=_tfda_values,
            minio_service=_enrich_minio,
        )
        new_completed = index + 1
        await record_job_step(
            pool,
            job_id=job["job_id"],
            step_key="enrich_licenses",
            status="running",
            progress_current=new_completed,
            progress_total=total_candidates,
            checkpoint={
                "phase": "running",
                "candidate_license_ids": candidate_license_ids,
                "completed": new_completed,
                "last_license_id": license_id,
            },
        )
        await mark_job_status(
            pool,
            job_id=job["job_id"],
            status="running",
            current_step=f"enriched_{license_id}",
            progress_current=1 + new_completed,
            progress_total=total,
        )
        control = await checkpoint_job_control(
            pool,
            job_id=job["job_id"],
            worker_name=worker_name,
        )
        if control is not None:
            step_status = "paused" if control["action"] == "pause" else "stopped"
            await record_job_step(
                pool,
                job_id=job["job_id"],
                step_key="enrich_licenses",
                status=step_status,
                progress_current=new_completed,
                progress_total=total_candidates,
                checkpoint={
                    "phase": step_status,
                    "candidate_license_ids": candidate_license_ids,
                    "completed": new_completed,
                    "last_license_id": license_id,
                    "message": control["message"],
                },
            )
            return

    await record_job_step(
        pool,
        job_id=job["job_id"],
        step_key="finalize",
        status="success",
        progress_current=1,
        progress_total=1,
        checkpoint={
            "phase": "completed",
            "candidate_count": total_candidates,
        },
    )
    await mark_job_status(
        pool,
        job_id=job["job_id"],
        status="success",
        current_step="completed",
        progress_current=total,
        progress_total=total,
        control_state="idle",
        result_summary={
            "job_type": "drug_enrichment",
            "candidate_count": total_candidates,
            "license_ids": candidate_license_ids,
            "retry_failed": retry_failed,
        },
    )


async def _run_drug_analysis_job(
    pool: PoolLike,
    *,
    worker_name: str,
    job: dict[str, Any],
    minio_service: MinioService | None,
) -> None:
    _ensure_repo_root_on_path()
    from drug_analysis_service import DrugAnalysisConfig, DrugAnalysisService
    from loader.loaders.drug_analysis_loader import load_drug_analysis

    options = _json_object(job.get("job_options"))
    license_ids = [
        str(item) for item in (options.get("license_ids") or []) if str(item).strip()
    ]
    include_cancelled = bool(options.get("include_cancelled"))
    retry_failed = bool(options.get("retry_failed"))
    retry_stage = str(options.get("retry_stage") or "").strip().lower() or None
    if retry_stage not in (None, "ocr", "analysis", "normalize"):
        raise ValueError("retry_stage must be one of: ocr, analysis, normalize")
    limit = options.get("limit")
    limit_value = int(limit) if limit not in (None, "") else None

    import admin_settings as _admin_settings

    analysis_service = DrugAnalysisService(
        DrugAnalysisConfig.from_values(
            ocr=await _admin_settings.get_group(pool, "ocr"),
            analysis=await _admin_settings.get_group(pool, "analysis"),
        )
    )
    if retry_stage != "normalize":
        ready, reason = (
            analysis_service.analysis_readiness()
            if retry_stage == "analysis"
            else analysis_service.readiness()
        )
        if not ready:
            raise RuntimeError(reason)
        if minio_service is None or not minio_service.enabled:
            raise RuntimeError(
                minio_service.init_error
                if minio_service is not None
                else "MinIO not configured"
            )

    checkpoint = await get_job_step_checkpoint(
        pool,
        job_id=job["job_id"],
        step_key="analyze_licenses",
    )
    candidate_license_ids = [
        str(item)
        for item in (
            checkpoint.get("candidate_license_ids")
            or options.get("candidate_license_ids")
            or []
        )
        if str(item).strip()
    ]
    completed = int(checkpoint.get("completed", 0) or 0)
    if not candidate_license_ids:
        async with pool.acquire() as conn:
            candidate_license_ids = await _load_drug_analysis_candidates(
                conn,
                license_ids=license_ids,
                limit=limit_value,
                include_cancelled=include_cancelled,
                retry_failed=retry_failed,
                retry_stage=retry_stage,
            )
        completed = 0

    total_candidates = len(candidate_license_ids)
    total = total_candidates + 2
    await append_job_log(
        pool,
        job_id=job["job_id"],
        level="info",
        message="Starting drug analysis batch",
        payload={
            "candidate_count": total_candidates,
            "retry_stage": retry_stage or "",
            "retry_failed": retry_failed,
        },
    )
    await record_job_step(
        pool,
        job_id=job["job_id"],
        step_key="select_candidates",
        status="success",
        progress_current=1,
        progress_total=1,
        checkpoint={
            "phase": "selected",
            "candidate_license_ids": candidate_license_ids,
            "candidate_count": total_candidates,
            "retry_stage": retry_stage or "",
        },
    )
    await mark_job_status(
        pool,
        job_id=job["job_id"],
        status="running",
        current_step="selected_drug_analysis_candidates",
        progress_current=1,
        progress_total=total,
    )
    if completed == 0 and await _apply_control_checkpoint(
        pool,
        job_id=job["job_id"],
        worker_name=worker_name,
    ):
        return

    await record_job_step(
        pool,
        job_id=job["job_id"],
        step_key="analyze_licenses",
        status="running",
        progress_current=completed,
        progress_total=total_candidates,
        checkpoint={
            "phase": "running",
            "candidate_license_ids": candidate_license_ids,
            "completed": completed,
            "retry_stage": retry_stage or "",
        },
    )

    for index in range(completed, total_candidates):
        license_id = candidate_license_ids[index]
        await mark_job_status(
            pool,
            job_id=job["job_id"],
            status="running",
            current_step=f"analyzing_{license_id}",
            progress_current=1 + index,
            progress_total=total,
        )
        await load_drug_analysis(
            pool,
            license_ids=[license_id],
            include_cancelled=include_cancelled,
            retry_failed=retry_failed,
            retry_stage=retry_stage,
            limit=1,
        )
        new_completed = index + 1
        await record_job_step(
            pool,
            job_id=job["job_id"],
            step_key="analyze_licenses",
            status="running",
            progress_current=new_completed,
            progress_total=total_candidates,
            checkpoint={
                "phase": "running",
                "candidate_license_ids": candidate_license_ids,
                "completed": new_completed,
                "retry_stage": retry_stage or "",
                "last_license_id": license_id,
            },
        )
        await mark_job_status(
            pool,
            job_id=job["job_id"],
            status="running",
            current_step=f"analyzed_{license_id}",
            progress_current=1 + new_completed,
            progress_total=total,
        )
        control = await checkpoint_job_control(
            pool,
            job_id=job["job_id"],
            worker_name=worker_name,
        )
        if control is not None:
            step_status = "paused" if control["action"] == "pause" else "stopped"
            await record_job_step(
                pool,
                job_id=job["job_id"],
                step_key="analyze_licenses",
                status=step_status,
                progress_current=new_completed,
                progress_total=total_candidates,
                checkpoint={
                    "phase": step_status,
                    "candidate_license_ids": candidate_license_ids,
                    "completed": new_completed,
                    "retry_stage": retry_stage or "",
                    "last_license_id": license_id,
                    "message": control["message"],
                },
            )
            return

    await record_job_step(
        pool,
        job_id=job["job_id"],
        step_key="finalize",
        status="success",
        progress_current=1,
        progress_total=1,
        checkpoint={
            "phase": "completed",
            "candidate_count": total_candidates,
            "retry_stage": retry_stage or "",
        },
    )
    await mark_job_status(
        pool,
        job_id=job["job_id"],
        status="success",
        current_step="completed",
        progress_current=total,
        progress_total=total,
        control_state="idle",
        result_summary={
            "job_type": "drug_analysis",
            "candidate_count": total_candidates,
            "license_ids": candidate_license_ids,
            "retry_failed": retry_failed,
            "retry_stage": retry_stage or "",
        },
    )






















async def run_noop_job(
    pool: PoolLike,
    *,
    job: dict[str, Any],
) -> None:
    total = 5
    start_at = max(int(job.get("progress_current") or 0), 0)
    delay = max(admin_noop_checkpoint_delay_seconds(), 0.0)

    await record_job_step(
        pool,
        job_id=job["job_id"],
        step_key="noop",
        status="running",
        progress_current=start_at,
        progress_total=total,
        checkpoint={"phase": "started", "resume_from": start_at},
    )
    await append_job_log(
        pool,
        job_id=job["job_id"],
        level="info",
        message="Executing noop admin job",
        payload={
            "module_key": job["module_key"],
            "job_type": job["job_type"],
            "resume_from": start_at,
        },
    )

    for index in range(start_at, total):
        completed = index + 1
        await mark_job_status(
            pool,
            job_id=job["job_id"],
            status="running",
            current_step=f"noop_checkpoint_{completed}",
            progress_current=index,
            progress_total=total,
        )
        await append_job_log(
            pool,
            job_id=job["job_id"],
            level="info",
            message="Noop checkpoint started",
            payload={"checkpoint": completed, "total": total},
        )
        if delay:
            await asyncio.sleep(delay)
        await record_job_step(
            pool,
            job_id=job["job_id"],
            step_key="noop",
            status="running",
            progress_current=completed,
            progress_total=total,
            checkpoint={"phase": "checkpoint", "completed": completed, "total": total},
        )
        await mark_job_status(
            pool,
            job_id=job["job_id"],
            status="running",
            current_step=f"noop_checkpoint_{completed}",
            progress_current=completed,
            progress_total=total,
        )
        control = await checkpoint_job_control(
            pool,
            job_id=job["job_id"],
            worker_name=str(job.get("worker_name") or ""),
        )
        if control is not None:
            step_status = "paused" if control["action"] == "pause" else "stopped"
            await record_job_step(
                pool,
                job_id=job["job_id"],
                step_key="noop",
                status=step_status,
                progress_current=completed,
                progress_total=total,
                checkpoint={
                    "phase": step_status,
                    "completed": completed,
                    "total": total,
                    "message": control["message"],
                },
            )
            return

    await mark_job_status(
        pool,
        job_id=job["job_id"],
        status="success",
        current_step="completed",
        progress_current=total,
        progress_total=total,
        control_state="idle",
        result_summary={
            "mode": "noop",
            "message": "Generic admin control-plane smoke job completed.",
        },
    )
    await record_job_step(
        pool,
        job_id=job["job_id"],
        step_key="noop",
        status="success",
        progress_current=total,
        progress_total=total,
        checkpoint={"phase": "completed", "total": total},
    )


async def _maybe_auto_chain(
    pool: PoolLike,
    *,
    completed_job_type: str,
    parent_job_id: str,
    worker_name: str,
) -> None:
    """After a drug pipeline job succeeds, auto-create the next phase if appropriate.

    Guards:
    1. Next phase must have pending work (don't create an empty job).
    2. All service dependencies of the next phase must be healthy.
    3. No other job of the next phase type is already queued / running / paused.
    """
    from admin_drug import get_drug_pipeline_status

    NEXT: dict[str, str] = {
        "drug_index_import": "drug_enrichment",
        "drug_enrichment": "drug_analysis",
    }
    next_type = NEXT.get(completed_job_type)
    if next_type is None:
        return

    log = logging.getLogger(__name__)

    try:
        # 1. Check pending work
        status = await get_drug_pipeline_status(pool)
        if next_type == "drug_enrichment":
            has_work = status["enrichment"]["queue_pending"] > 0
        else:  # drug_analysis
            has_work = not status["analysis"]["is_complete"]

        if not has_work:
            await append_job_log(
                pool,
                job_id=parent_job_id,
                level="info",
                message=f"Auto-chain: no pending work for {next_type}, skipping.",
            )
            return

        # 2. Check service dependencies
        unhealthy = await get_unhealthy_dependencies(pool, next_type)
        if unhealthy:
            await append_job_log(
                pool,
                job_id=parent_job_id,
                level="warn",
                message=f"Auto-chain: skipping {next_type} — service(s) unhealthy: {', '.join(unhealthy)}.",
                payload={"unhealthy": unhealthy},
            )
            return

        # 3. Check for duplicate active job
        async with pool.acquire() as conn:
            active_count = await conn.fetchval(
                """
                SELECT COUNT(*) FROM admin.import_jobs
                WHERE job_type = $1
                  AND status IN ('queued', 'running', 'paused')
                """,
                next_type,
            )
        if int(active_count or 0) > 0:
            await append_job_log(
                pool,
                job_id=parent_job_id,
                level="info",
                message=f"Auto-chain: {next_type} already active, skipping duplicate.",
            )
            return

        # 4. Create the next job
        next_job = await create_job(
            pool,
            module_key="drug",
            job_type=next_type,
            requested_by=f"auto_chain:{worker_name}",
            parent_job_id=parent_job_id,
        )
        await append_job_log(
            pool,
            job_id=parent_job_id,
            level="info",
            message=f"Auto-chain: created {next_type} job.",
            payload={"next_job_id": next_job["job_id"]},
        )
        log.info(
            "auto_chain: created %s job %s from parent %s",
            next_type,
            next_job["job_id"],
            parent_job_id,
        )

    except Exception as exc:
        log.warning("auto_chain: failed to create %s: %s", next_type, exc)
        await append_job_log(
            pool,
            job_id=parent_job_id,
            level="warn",
            message=f"Auto-chain: could not create {next_type} ({exc}).",
        )


async def execute_admin_job(
    pool: PoolLike,
    *,
    worker_name: str,
    job: dict[str, Any],
    minio_service: MinioService | None = None,
) -> None:
    # Scope verbose logging to this job (its own asyncio.Task → its own context).
    _LOG_VERBOSE.set(_resolve_log_verbose(job))

    # ── Dependency gate ──────────────────────────────────────────────────────
    # Fail fast if any required external service is in hard 'error' state.
    # This prevents the job from hanging until timeout when a dependency is
    # known-down.  We check cached probe results so there is no live HTTP call.
    unhealthy = await get_unhealthy_dependencies(pool, job["job_type"])
    if unhealthy:
        service_list = ", ".join(unhealthy)
        await mark_job_status(
            pool,
            job_id=job["job_id"],
            status="permanent_failed",
            current_step="dependency_check",
            control_state="idle",
            last_error_code="service_dependency_error",
            last_error_message=(
                f"Required service(s) not healthy: {service_list}. "
                "Run an active service probe from the Services tab, then retry."
            ),
        )
        await append_job_log(
            pool,
            job_id=job["job_id"],
            level="error",
            message="Job blocked by unhealthy service dependency",
            payload={"unhealthy_services": unhealthy, "job_type": job["job_type"]},
        )
        return
    # ─────────────────────────────────────────────────────────────────────────

    if job["job_type"] == "noop":
        await run_noop_job(pool, job=job)
        final_job = await get_job(pool, job_id=job["job_id"])
        if final_job is not None and final_job["status"] == "success":
            await append_job_log(
                pool,
                job_id=job["job_id"],
                level="info",
                message="Job completed successfully",
                payload={"worker_name": worker_name},
            )
        return
    # Non-drug job types (icd/loinc/ig/snomed/rxnorm/guideline/health_supplements/
    # food_nutrition + all *_embed) run natively in the Node worker. This Python
    # shim only ever receives drug jobs, so only drug handlers remain here; any
    # other type falls through to the unsupported-job-type failure below.
    if job["job_type"] == "drug_index_import":
        await _run_drug_index_import_job(
            pool,
            worker_name=worker_name,
            job=job,
            minio_service=minio_service,
        )
        final = await get_job(pool, job_id=job["job_id"])
        if final and final["status"] == "success":
            await _maybe_auto_chain(
                pool,
                completed_job_type="drug_index_import",
                parent_job_id=job["job_id"],
                worker_name=worker_name,
            )
        return
    if job["job_type"] == "drug_enrichment":
        await _run_drug_enrichment_job(
            pool,
            worker_name=worker_name,
            job=job,
        )
        final = await get_job(pool, job_id=job["job_id"])
        if final and final["status"] == "success":
            await _maybe_auto_chain(
                pool,
                completed_job_type="drug_enrichment",
                parent_job_id=job["job_id"],
                worker_name=worker_name,
            )
        return
    if job["job_type"] == "drug_analysis":
        await _run_drug_analysis_job(
            pool,
            worker_name=worker_name,
            job=job,
            minio_service=minio_service,
        )
        return

    await mark_job_status(
        pool,
        job_id=job["job_id"],
        status="permanent_failed",
        current_step="unsupported",
        control_state="idle",
        last_error_code="unsupported_job_type",
        last_error_message=f"No admin adapter registered for job type '{job['job_type']}'",
    )
    await append_job_log(
        pool,
        job_id=job["job_id"],
        level="error",
        message="Unsupported job type",
        payload={"worker_name": worker_name, "job_type": job["job_type"]},
    )
