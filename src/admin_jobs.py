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
from rxnorm_rrf import load_rxnorm_concepts

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


def get_excluded_job_types(active_resources: frozenset[str]) -> frozenset[str]:
    """Return the set of job types that cannot be claimed given the resources
    currently held by running jobs."""
    if not active_resources:
        return frozenset()
    return frozenset(
        jt for jt, rs in JOB_TYPE_RESOURCES.items() if rs & active_resources
    )


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


def admin_worker_name() -> str:
    return os.getenv("ADMIN_WORKER_NAME", "admin-worker").strip() or "admin-worker"


def admin_worker_poll_seconds() -> float:
    return float(os.getenv("ADMIN_WORKER_POLL_SECONDS", "3"))


def admin_heartbeat_interval_seconds() -> int:
    return int(os.getenv("ADMIN_HEARTBEAT_INTERVAL_SECONDS", "15"))


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


async def list_jobs(pool: PoolLike, *, limit: int = 50) -> list[dict[str, Any]]:
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT *
            FROM admin.import_jobs
            ORDER BY created_at DESC
            LIMIT $1
            """,
            limit,
        )
    return [AdminJob.from_row(row).to_dict() for row in rows]


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


async def list_job_steps(pool: PoolLike, *, job_id: str) -> list[dict[str, Any]]:
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT *
            FROM admin.import_job_steps
            WHERE job_id = $1
            ORDER BY job_step_id
            """,
            uuid.UUID(job_id),
        )
    return [
        {
            "job_step_id": int(row["job_step_id"]),
            "job_id": str(row["job_id"]),
            "step_key": row["step_key"] or "",
            "status": row["status"] or "",
            "progress_current": int(row["progress_current"] or 0),
            "progress_total": int(row["progress_total"] or 0),
            "started_at": _iso(row["started_at"]),
            "finished_at": _iso(row["finished_at"]),
            "checkpoint": _parse_jsonb(row["checkpoint_json"]),
            "last_error_message": row["last_error_message"] or "",
        }
        for row in rows
    ]


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


async def list_job_logs(
    pool: PoolLike,
    *,
    job_id: str,
    limit: int = 100,
    before_id: int | None = None,
) -> list[dict[str, Any]]:
    """Return up to *limit* log entries for a job.

    Cursor-based: when *before_id* is given, only rows with
    job_log_id < before_id are returned (i.e. older entries).
    Results are always returned in ascending (chronological) order.
    """
    async with pool.acquire() as conn:
        if before_id is not None:
            rows = await conn.fetch(
                """
                SELECT *
                FROM admin.import_job_logs
                WHERE job_id = $1 AND job_log_id < $2
                ORDER BY job_log_id DESC
                LIMIT $3
                """,
                uuid.UUID(job_id),
                before_id,
                limit,
            )
        else:
            rows = await conn.fetch(
                """
                SELECT *
                FROM admin.import_job_logs
                WHERE job_id = $1
                ORDER BY job_log_id DESC
                LIMIT $2
                """,
                uuid.UUID(job_id),
                limit,
            )
    return [
        {
            "job_log_id": int(row["job_log_id"]),
            "job_id": str(row["job_id"]),
            "level": row["level"] or "",
            "message": row["message"] or "",
            "payload": _parse_jsonb(row["payload_json"]),
            "created_at": _iso(row["created_at"]),
        }
        for row in reversed(rows)
    ]


async def summarize_jobs(pool: PoolLike) -> dict[str, int]:
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT status, COUNT(*)::int AS count
            FROM admin.import_jobs
            GROUP BY status
            """)
    counts = {row["status"]: int(row["count"]) for row in rows}
    return {
        "queued": counts.get("queued", 0),
        "running": counts.get("running", 0),
        "success": counts.get("success", 0),
        "failed": counts.get("retryable_failed", 0) + counts.get("permanent_failed", 0),
        "paused": counts.get("paused", 0),
        "stopped": counts.get("stopped", 0),
    }


async def reclaim_stale_jobs(
    pool: PoolLike,
    *,
    worker_name: str,
    stale_multiplier: float = 2.0,
) -> int:
    """Re-queue running jobs whose claiming worker heartbeat has gone stale.

    A job is considered abandoned when the worker that claimed it has not
    sent a heartbeat for ``stale_after_seconds * stale_multiplier`` seconds.
    The multiplier (default 2×) gives the worker a grace period beyond the
    normal stale threshold before we intervene.

    Re-queued jobs use ``control_state='resume_requested'`` so the new worker
    picks up from the last checkpoint rather than starting over.

    Returns the number of jobs re-queued.
    """
    stale_threshold = admin_worker_stale_after_seconds()
    effective_seconds = stale_threshold * stale_multiplier
    async with pool.acquire() as conn:
        async with conn.transaction():
            # PostgreSQL disallows FOR UPDATE on the nullable side of an
            # outer join.  Use NOT EXISTS / EXISTS subqueries instead so the
            # lock is applied only to admin.import_jobs.
            rows = await conn.fetch(
                """
                SELECT j.job_id, j.worker_name, j.job_type
                FROM admin.import_jobs j
                WHERE j.status = 'running'
                  AND (
                    NOT EXISTS (
                      SELECT 1 FROM admin.worker_heartbeats wh
                      WHERE wh.worker_name = j.worker_name
                    )
                    OR EXISTS (
                      SELECT 1 FROM admin.worker_heartbeats wh
                      WHERE wh.worker_name = j.worker_name
                        AND wh.last_heartbeat_at < NOW() - ($1 * INTERVAL '1 second')
                    )
                  )
                FOR UPDATE SKIP LOCKED
                """,
                effective_seconds,
            )
            if not rows:
                return 0
            job_ids = [row["job_id"] for row in rows]
            await conn.execute(
                """
                UPDATE admin.import_jobs
                SET status = 'queued',
                    control_state = 'resume_requested',
                    current_step = 'reclaimed_stale',
                    updated_at = NOW()
                WHERE job_id = ANY($1::uuid[])
                """,
                job_ids,
            )
            for row in rows:
                await conn.execute(
                    """
                    INSERT INTO admin.import_job_logs (job_id, level, message, payload_json)
                    VALUES ($1, 'warn', 'Job reclaimed from stale worker', $2::jsonb)
                    """,
                    row["job_id"],
                    json.dumps(
                        {
                            "original_worker": row["worker_name"] or "",
                            "reclaimed_by": worker_name,
                            "job_type": row["job_type"] or "",
                            "stale_threshold_seconds": effective_seconds,
                        },
                        ensure_ascii=False,
                    ),
                )
            return len(job_ids)


async def upsert_worker_heartbeat(
    pool: PoolLike,
    *,
    worker_name: str,
    process_id: int,
    status: str,
    current_job_id: str = "",
    details: dict[str, Any] | None = None,
) -> None:
    details = details or {}
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO admin.worker_heartbeats (
                worker_name,
                process_id,
                status,
                current_job_id,
                details_json,
                last_heartbeat_at
            )
            VALUES ($1, $2, $3, NULLIF($4, '')::uuid, $5::jsonb, NOW())
            ON CONFLICT (worker_name) DO UPDATE SET
                process_id = EXCLUDED.process_id,
                status = EXCLUDED.status,
                current_job_id = EXCLUDED.current_job_id,
                details_json = EXCLUDED.details_json,
                last_heartbeat_at = NOW()
            RETURNING last_heartbeat_at
            """,
            worker_name,
            process_id,
            status,
            current_job_id,
            json.dumps(details, ensure_ascii=False),
        )
    asyncio.create_task(
        broadcast(
            "worker_heartbeat",
            {
                "worker_name": worker_name,
                "status": status,
                "current_job_id": current_job_id or None,
                "last_heartbeat_at": (
                    row["last_heartbeat_at"].isoformat() if row else ""
                ),
            },
        )
    )


async def list_worker_heartbeats(
    pool: PoolLike,
) -> list[dict[str, Any]]:
    now = datetime.now(timezone.utc)
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT worker_name, process_id, status, current_job_id, details_json, last_heartbeat_at
            FROM admin.worker_heartbeats
            ORDER BY worker_name
            """)
    return [
        WorkerHeartbeat.from_row(
            row,
            now=now,
            stale_after_seconds=admin_worker_stale_after_seconds(),
        ).to_dict()
        for row in rows
    ]


async def claim_next_job(
    pool: PoolLike,
    *,
    worker_name: str,
    supported_job_types: list[str] | None = None,
    excluded_job_types: frozenset[str] | None = None,
) -> dict[str, Any] | None:
    supported_job_types = supported_job_types or sorted(ADMIN_JOB_TYPES)
    if excluded_job_types:
        supported_job_types = [
            jt for jt in supported_job_types if jt not in excluded_job_types
        ]
    if not supported_job_types:
        return None
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                """
                WITH next_job AS (
                    SELECT job_id
                    FROM admin.import_jobs
                    WHERE status = 'queued'
                      AND control_state = ANY($1::text[])
                      AND job_type = ANY($2::text[])
                    ORDER BY created_at, job_id
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
                )
                UPDATE admin.import_jobs j
                SET
                    status = 'running',
                    control_state = 'idle',
                    current_step = CASE
                        WHEN j.progress_current > 0 THEN 'resumed'
                        ELSE 'claimed'
                    END,
                    worker_name = $3,
                    claimed_at = NOW(),
                    started_at = COALESCE(j.started_at, NOW()),
                    attempt_count = j.attempt_count + 1,
                    updated_at = NOW()
                FROM next_job
                WHERE j.job_id = next_job.job_id
                RETURNING j.*
                """,
                ["idle", "resume_requested"],
                supported_job_types,
                worker_name,
            )
            if row is None:
                return None
            await conn.execute(
                """
                INSERT INTO admin.import_job_logs (job_id, level, message, payload_json)
                VALUES ($1, 'info', 'Job claimed by worker', $2::jsonb)
                """,
                row["job_id"],
                json.dumps({"worker_name": worker_name}, ensure_ascii=False),
            )
            return AdminJob.from_row(row).to_dict()


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


async def request_job_control(
    pool: PoolLike,
    *,
    job_id: str,
    action: str,
    requested_by: str,
) -> dict[str, Any]:
    action = (action or "").strip().lower()
    if action not in CONTROL_ACTIONS:
        raise ValueError(f"Unsupported job control action: {action}")

    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                """
                SELECT *
                FROM admin.import_jobs
                WHERE job_id = $1
                FOR UPDATE
                """,
                uuid.UUID(job_id),
            )
            if row is None:
                raise ValueError("Job not found")

            job = AdminJob.from_row(row).to_dict()
            allowed = available_job_actions(job["status"], job["control_state"])
            if action not in allowed:
                raise ValueError(
                    f"Action '{action}' is not allowed for job status={job['status']} control_state={job['control_state']}"
                )

            control_row = await conn.fetchrow(
                """
                INSERT INTO admin.job_control_requests (job_id, action, requested_by)
                VALUES ($1, $2, $3)
                RETURNING control_request_id, requested_at
                """,
                uuid.UUID(job_id),
                action,
                requested_by,
            )
            if control_row is None:
                raise RuntimeError("Failed to create job control request")

            control_request_id = int(control_row["control_request_id"])
            restart_job: dict[str, Any] | None = None
            result_status = "accepted"
            result_message = "Control request queued for worker checkpoint."

            if action == "pause" and job["status"] == "queued":
                await conn.execute(
                    """
                    UPDATE admin.import_jobs
                    SET status = 'paused',
                        control_state = 'paused',
                        current_step = 'paused_before_claim',
                        updated_at = NOW()
                    WHERE job_id = $1
                    """,
                    uuid.UUID(job_id),
                )
                result_status = "applied"
                result_message = "Queued job paused before worker claim."
            elif action == "resume" and job["status"] == "paused":
                await conn.execute(
                    """
                    UPDATE admin.import_jobs
                    SET status = 'queued',
                        control_state = 'resume_requested',
                        current_step = 'resume_requested',
                        updated_at = NOW()
                    WHERE job_id = $1
                    """,
                    uuid.UUID(job_id),
                )
                result_status = "applied"
                result_message = "Paused job re-queued for resume."
            elif action == "stop" and job["status"] in {"queued", "paused"}:
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
                result_status = "applied"
                result_message = "Job stopped without worker execution."
            elif action == "restart" and job["status"] != "running":
                restart_job = await _create_restart_job_locked(
                    conn,
                    source_job_row=row,
                    requested_by=requested_by,
                )
                if job["status"] == "queued":
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
                result_status = "applied"
                result_message = f"Restart job created: {restart_job['job_id']}"
            elif action == "pause":
                await conn.execute(
                    """
                    UPDATE admin.import_jobs
                    SET control_state = 'pause_requested',
                        updated_at = NOW()
                    WHERE job_id = $1
                    """,
                    uuid.UUID(job_id),
                )
            elif action == "stop":
                await conn.execute(
                    """
                    UPDATE admin.import_jobs
                    SET control_state = 'stop_requested',
                        updated_at = NOW()
                    WHERE job_id = $1
                    """,
                    uuid.UUID(job_id),
                )
            elif action == "restart":
                await conn.execute(
                    """
                    UPDATE admin.import_jobs
                    SET control_state = 'restart_requested',
                        updated_at = NOW()
                    WHERE job_id = $1
                    """,
                    uuid.UUID(job_id),
                )

            await conn.execute(
                """
                UPDATE admin.job_control_requests
                SET handled_at = CASE WHEN $2 = 'applied' THEN NOW() ELSE handled_at END,
                    result_status = $2,
                    result_message = $3
                WHERE control_request_id = $1
                """,
                control_request_id,
                result_status,
                result_message,
            )
            await conn.execute(
                """
                INSERT INTO admin.import_job_logs (job_id, level, message, payload_json)
                VALUES ($1, 'info', $2, $3::jsonb)
                """,
                uuid.UUID(job_id),
                f"Control action requested: {action}",
                json.dumps(
                    {
                        "action": action,
                        "requested_by": requested_by,
                        "result_status": result_status,
                        "result_message": result_message,
                        "restart_job_id": restart_job["job_id"] if restart_job else "",
                    },
                    ensure_ascii=False,
                ),
            )
            updated_row = await conn.fetchrow(
                """
                SELECT *
                FROM admin.import_jobs
                WHERE job_id = $1
                """,
                uuid.UUID(job_id),
            )

    if updated_row is None:
        raise RuntimeError("Failed to reload updated admin job")
    return {
        "job": AdminJob.from_row(updated_row).to_dict(),
        "control_request": {
            "control_request_id": control_request_id,
            "action": action,
            "requested_by": requested_by,
            "requested_at": _iso(control_row["requested_at"]),
            "result_status": result_status,
            "result_message": result_message,
        },
        "restart_job": restart_job,
    }


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


async def _count_table_rows(pool: PoolLike, table_name: str) -> int:
    async with pool.acquire() as conn:
        return int(await conn.fetchval(f"SELECT COUNT(*) FROM {table_name}") or 0)


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


async def _clear_stage_rows(
    pool: PoolLike,
    *,
    job_id: str,
    table_names: tuple[str, ...],
) -> None:
    async with pool.acquire() as conn:
        for table_name in table_names:
            await conn.execute(
                f"DELETE FROM {table_name} WHERE job_id = $1::uuid",
                uuid.UUID(job_id),
            )


def _fmt(n: int) -> str:
    return f"{n:,}"


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


def _success_summary_message(summary: dict[str, Any]) -> str:
    """Build a human ✓ Completed line from a job's result_summary counts."""
    count_labels = (
        ("diagnosis_count", "diagnoses"),
        ("procedure_count", "procedures"),
        ("concept_count", "concepts"),
        ("description_count", "descriptions"),
        ("relationship_count", "relationships"),
        ("codesystem_count", "codesystems"),
        ("artifact_count", "artifacts"),
        ("loinc_count", "LOINC terms"),
        ("guideline_count", "guidelines"),
        ("drug_count", "drugs"),
        ("record_count", "records"),
        ("row_count", "rows"),
    )
    parts = [
        f"{_fmt(int(summary[key]))} {label}"
        for key, label in count_labels
        if summary.get(key)
    ]
    return f"✓ Completed — {', '.join(parts)}" if parts else "✓ Completed"


async def log_job_outcome(pool: PoolLike, *, job_id: str, worker_name: str) -> None:
    """Emit a single terminal log line summarising how a job finished.

    Called after the job handler returns so every job type gets a guaranteed
    ✓ Completed / ✗ Failed line (with counts) — non-terminal states (paused /
    stopped / interrupted) are intentionally skipped.
    """
    job = await get_job(pool, job_id=job_id)
    if not job:
        return
    status = job.get("status")
    if status == "success":
        summary = job.get("result_summary") or {}
        await append_job_log(
            pool,
            job_id=job_id,
            level="info",
            message=_success_summary_message(summary),
            payload={"result_summary": summary},
        )
    elif status in ("retryable_failed", "permanent_failed", "failed"):
        await append_job_log(
            pool,
            job_id=job_id,
            level="error",
            message=f"✗ Failed: {job.get('last_error_message') or status}",
            payload={
                "status": status,
                "error_code": job.get("last_error_code") or "",
            },
        )


# Per-job verbose logging. Each job runs in its own asyncio.Task, so a ContextVar
# set at the top of execute_admin_job is naturally scoped to that one job.
_LOG_VERBOSE: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "job_log_verbose", default=False
)
_default_log_verbose = False


def set_default_log_verbose(value: bool) -> None:
    """Set the process-wide default for verbose job logging (worker reads it
    from settings at startup). A per-job ``log_verbose`` option overrides this."""
    global _default_log_verbose
    _default_log_verbose = bool(value)


def _resolve_log_verbose(job: dict[str, Any]) -> bool:
    opts = _json_object(job.get("job_options"))
    if "log_verbose" in opts:
        return bool(opts["log_verbose"])
    return _default_log_verbose


async def job_debug_log(
    pool: PoolLike,
    *,
    job_id: str,
    message: str,
    payload: dict[str, Any] | None = None,
) -> None:
    """Append a ``debug`` log line only when verbose mode is on for this job.
    Used for high-frequency per-batch detail that is hidden by default."""
    if not _LOG_VERBOSE.get():
        return
    await append_job_log(
        pool, job_id=job_id, level="debug", message=message, payload=payload
    )


async def prune_job_logs(
    pool: PoolLike,
    *,
    retention_days: int = 30,
    max_lines_per_job: int = 2000,
) -> int:
    """Bound ``admin.import_job_logs`` growth (it has no retention otherwise).

    Two passes: drop lines older than ``retention_days``, then for any job with
    more than ``max_lines_per_job`` lines keep only the most recent that many —
    but never delete ``error`` lines (failures stay diagnosable). Returns the
    total number of rows deleted.
    """
    deleted = 0
    async with pool.acquire() as conn:
        if retention_days and retention_days > 0:
            status = await conn.execute(
                """
                DELETE FROM admin.import_job_logs
                WHERE created_at < NOW() - make_interval(days => $1::int)
                """,
                int(retention_days),
            )
            deleted += int(status.split()[-1]) if status else 0
        if max_lines_per_job and max_lines_per_job > 0:
            status = await conn.execute(
                """
                DELETE FROM admin.import_job_logs l
                USING (
                    SELECT job_log_id,
                           row_number() OVER (
                               PARTITION BY job_id
                               ORDER BY created_at DESC, job_log_id DESC
                           ) AS rn
                    FROM admin.import_job_logs
                ) ranked
                WHERE l.job_log_id = ranked.job_log_id
                  AND ranked.rn > $1::int
                  AND l.level <> 'error'
                """,
                int(max_lines_per_job),
            )
            deleted += int(status.split()[-1]) if status else 0
    return deleted


async def _stage_rows(
    pool: PoolLike,
    *,
    job_id: str,
    worker_name: str,
    step_key: str,
    running_step_name: str,
    rows: list[tuple[Any, ...]],
    insert_sql: str,
    batch_size: int,
    job_progress_before: int,
    job_progress_after: int,
    job_progress_total: int,
    checkpoint_label: str,
) -> bool:
    checkpoint = await get_job_step_checkpoint(pool, job_id=job_id, step_key=step_key)
    completed = int(checkpoint.get("completed", 0) or 0)
    completed = max(0, min(completed, len(rows)))

    label = running_step_name.removeprefix("staging_").replace("_", " ") or step_key
    _stage_t0 = time.monotonic()
    throttle = _ProgressLogThrottle()
    if completed > 0:
        await append_job_log(
            pool,
            job_id=job_id,
            level="info",
            message=f"Resuming {label}: {_fmt(completed)} / {_fmt(len(rows))} already staged",
        )
    else:
        await append_job_log(
            pool,
            job_id=job_id,
            level="info",
            message=f"Staging {label}: {_fmt(len(rows))} rows",
        )

    await record_job_step(
        pool,
        job_id=job_id,
        step_key=step_key,
        status="running",
        progress_current=completed,
        progress_total=len(rows),
        checkpoint={
            "phase": checkpoint_label,
            "completed": completed,
            "row_count": len(rows),
            "batch_size": batch_size,
        },
    )
    await mark_job_status(
        pool,
        job_id=job_id,
        status="running",
        current_step=running_step_name,
        progress_current=job_progress_before,
        progress_total=job_progress_total,
    )

    if not rows:
        await record_job_step(
            pool,
            job_id=job_id,
            step_key=step_key,
            status="success",
            progress_current=0,
            progress_total=0,
            checkpoint={
                "phase": f"{checkpoint_label}_completed",
                "completed": 0,
                "row_count": 0,
            },
        )
        await mark_job_status(
            pool,
            job_id=job_id,
            status="running",
            current_step=f"{running_step_name}_completed",
            progress_current=job_progress_after,
            progress_total=job_progress_total,
        )
        return False

    job_uuid = uuid.UUID(job_id)
    for start in range(completed, len(rows), batch_size):
        end = min(start + batch_size, len(rows))
        payload = [(job_uuid, *row) for row in rows[start:end]]
        _batch_t0 = time.monotonic()
        async with pool.acquire() as conn:
            await conn.executemany(insert_sql, payload)
        await job_debug_log(
            pool,
            job_id=job_id,
            message=(
                f"Batch {_fmt(start)}–{_fmt(end)}: inserted {_fmt(end - start)} "
                f"{label} ({time.monotonic() - _batch_t0:.2f}s)"
            ),
        )
        await record_job_step(
            pool,
            job_id=job_id,
            step_key=step_key,
            status="running",
            progress_current=end,
            progress_total=len(rows),
            checkpoint={
                "phase": checkpoint_label,
                "completed": end,
                "row_count": len(rows),
                "batch_size": batch_size,
            },
        )
        if throttle.should(end, len(rows)):
            await append_job_log(
                pool,
                job_id=job_id,
                level="info",
                message=(
                    f"Staged {_fmt(end)} / {_fmt(len(rows))} {label} "
                    f"({int(end * 100 / len(rows))}%)"
                ),
            )
        control = await checkpoint_job_control(
            pool,
            job_id=job_id,
            worker_name=worker_name,
        )
        if control is not None:
            step_status = "paused" if control["action"] == "pause" else "stopped"
            await record_job_step(
                pool,
                job_id=job_id,
                step_key=step_key,
                status=step_status,
                progress_current=end,
                progress_total=len(rows),
                checkpoint={
                    "phase": step_status,
                    "completed": end,
                    "row_count": len(rows),
                    "message": control["message"],
                },
            )
            return True

    await record_job_step(
        pool,
        job_id=job_id,
        step_key=step_key,
        status="success",
        progress_current=len(rows),
        progress_total=len(rows),
        checkpoint={
            "phase": f"{checkpoint_label}_completed",
            "completed": len(rows),
            "row_count": len(rows),
        },
    )
    await append_job_log(
        pool,
        job_id=job_id,
        level="info",
        message=f"Staged {_fmt(len(rows))} {label} in {time.monotonic() - _stage_t0:.1f}s",
    )
    await mark_job_status(
        pool,
        job_id=job_id,
        status="running",
        current_step=f"{running_step_name}_completed",
        progress_current=job_progress_after,
        progress_total=job_progress_total,
    )
    return False


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


async def _checkpoint_before_promote(
    pool: PoolLike,
    *,
    job_id: str,
    worker_name: str,
    step_key: str,
    job_progress_before: int,
    job_progress_total: int,
) -> bool:
    await record_job_step(
        pool,
        job_id=job_id,
        step_key=step_key,
        status="running",
        progress_current=0,
        progress_total=1,
        checkpoint={"phase": "promote_ready"},
    )
    await mark_job_status(
        pool,
        job_id=job_id,
        status="running",
        current_step="promote_ready",
        progress_current=job_progress_before,
        progress_total=job_progress_total,
    )
    await append_job_log(
        pool,
        job_id=job_id,
        level="info",
        message="Promoting staged data → live tables",
    )
    control = await checkpoint_job_control(
        pool,
        job_id=job_id,
        worker_name=worker_name,
    )
    if control is None:
        return False
    step_status = "paused" if control["action"] == "pause" else "stopped"
    await record_job_step(
        pool,
        job_id=job_id,
        step_key=step_key,
        status=step_status,
        progress_current=0,
        progress_total=1,
        checkpoint={
            "phase": "promote_blocked",
            "message": control["message"],
        },
    )
    return True


async def _capture_secondary_indexes(
    conn: asyncpg.Connection, table: str
) -> list[tuple[str, str, str]]:
    """Return ``(schema, index_name, create_ddl)`` for every non-PK, non-unique
    index on ``table``. These are safe to drop and rebuild around a bulk load;
    the primary key and any unique index (which FKs may depend on) are kept."""
    schema, name = table.split(".", 1)
    rows = await conn.fetch(
        """
        SELECT c.relname AS index_name, pg_get_indexdef(c.oid) AS index_def
        FROM pg_index idx
        JOIN pg_class c ON c.oid = idx.indexrelid
        JOIN pg_class t ON t.oid = idx.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = $1 AND t.relname = $2
          AND NOT idx.indisprimary AND NOT idx.indisunique
        ORDER BY c.relname
        """,
        schema,
        name,
    )
    return [(schema, r["index_name"], r["index_def"]) for r in rows]


async def _optimized_promote(
    pool: PoolLike,
    *,
    job_id: str,
    step_key: str,
    index_tables: list[str],
    truncate_sql: str,
    copies: list[tuple[str, tuple[Any, ...], str]],
    final_checkpoint: dict[str, Any],
    promoted_step_name: str,
    job_progress_after: int,
    job_progress_total: int,
    maintenance_work_mem: str = "128MB",
) -> None:
    """Promote staged data into live tables, optimised for speed + visibility.

    Within a single transaction (so readers still see all-old or all-new): raise
    ``maintenance_work_mem`` for this op, DROP the secondary/GIN indexes so the
    bulk INSERTs pay no per-row index cost, TRUNCATE + INSERT (no ORDER BY), then
    rebuild the indexes once at the end (far cheaper than incremental GIN upkeep).
    Each phase records sub-step progress so the UI shows movement instead of 0/1.
    """
    sub_total = 2 + len(copies) + 1  # drop, truncate, N copies, rebuild

    async def _phase(done: int, label: str) -> None:
        await record_job_step(
            pool,
            job_id=job_id,
            step_key=step_key,
            status="running",
            progress_current=done,
            progress_total=sub_total,
            checkpoint={"phase": label},
        )
        await append_job_log(pool, job_id=job_id, level="info", message=label)

    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                f"SET LOCAL maintenance_work_mem = '{maintenance_work_mem}'"
            )
            saved: list[tuple[str, str, str]] = []
            for table in index_tables:
                saved.extend(await _capture_secondary_indexes(conn, table))
            for schema, index_name, _ddl in saved:
                await conn.execute(f'DROP INDEX IF EXISTS "{schema}"."{index_name}"')
            await _phase(1, f"Promote: dropped {len(saved)} secondary index(es)")

            await conn.execute(truncate_sql)
            await _phase(2, "Promote: truncated live tables")

            for i, (insert_sql, args, label) in enumerate(copies, start=1):
                await conn.execute(insert_sql, *args)
                await _phase(2 + i, f"Promote: copied {label}")

            for _schema, _index_name, ddl in saved:
                await conn.execute(ddl)
            await _phase(sub_total, f"Promote: rebuilt {len(saved)} index(es)")

    await record_job_step(
        pool,
        job_id=job_id,
        step_key=step_key,
        status="success",
        progress_current=sub_total,
        progress_total=sub_total,
        checkpoint=final_checkpoint,
    )
    await mark_job_status(
        pool,
        job_id=job_id,
        status="running",
        current_step=promoted_step_name,
        progress_current=job_progress_after,
        progress_total=job_progress_total,
    )


def _parse_icd10cm_stage_records(
    zip_path: str,
    *,
    name_zh_map: dict[str, str],
) -> list[tuple[str, str, str, str]]:
    _ensure_repo_root_on_path()
    import zipfile

    from loader.loaders.icd_loader import _parse_order_txt, _parse_xml

    records: list[tuple[str, str, str, str]] = []
    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
        xml_files = [
            name
            for name in names
            if name.lower().endswith(".xml") and "tabular" in name.lower()
        ]
        txt_files = [
            name
            for name in names
            if name.lower().endswith(".txt") and "order" in name.lower()
        ]
        if xml_files:
            for code, name_en, _ in _parse_xml(zf.read(xml_files[0])):
                records.append((code, name_en, name_zh_map.get(code, ""), code[:3]))
        elif txt_files:
            for code, name_en, _ in _parse_order_txt(zf.read(txt_files[0])):
                records.append((code, name_en, name_zh_map.get(code, ""), code[:3]))
        else:
            raise FileNotFoundError("No usable ICD-10-CM XML/TXT found in ZIP")
    return records


def _parse_icd10pcs_stage_records(
    zip_path: str,
    *,
    name_zh_map: dict[str, str],
) -> list[tuple[str, str, str]]:
    _ensure_repo_root_on_path()
    import zipfile

    from loader.loaders.icd_loader import _parse_pcs_codes_txt

    records: list[tuple[str, str, str]] = []
    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
        codes_files = [
            name
            for name in names
            if name.lower().endswith(".txt")
            and "addenda" not in name.lower()
            and ("codes" in name.lower() or "pcs" in name.lower())
        ]
        if not codes_files:
            codes_files = [
                name
                for name in names
                if name.lower().endswith(".txt") and "addenda" not in name.lower()
            ]
        if not codes_files:
            raise FileNotFoundError("No usable ICD-10-PCS TXT found in ZIP")
        for code, name_en in _parse_pcs_codes_txt(zf.read(codes_files[0])):
            records.append((code, name_en, name_zh_map.get(code, "")))
    return records


def _parse_icd_bilingual_names(xlsx_path: str) -> tuple[dict[str, str], dict[str, str]]:
    from loader.loaders.icd_loader import parse_icd_chinese_xlsx

    cm_zh, pcs_zh = parse_icd_chinese_xlsx(xlsx_path)
    if not cm_zh and not pcs_zh:
        raise ValueError(
            "Taiwan ICD bilingual XLSX parsed 0 Chinese names. "
            "Verify the workbook has ICD-10-CM and ICD-10-PCS sheets with Chinese names."
        )
    return cm_zh, pcs_zh


def _build_loinc_stage_payload(
    zip_path: str,
    *,
    mapping_csv_path: str | None,
    reference_ranges_csv_path: str | None,
) -> tuple[list[tuple[Any, ...]], list[tuple[Any, ...]]]:
    _ensure_repo_root_on_path()
    import csv
    import io
    import zipfile

    from loader.loaders.loinc_taiwan_seed import _load_mapping_csv, _load_ranges_csv

    concept_map: dict[str, list[Any]] = {}
    with zipfile.ZipFile(zip_path) as zf:
        all_names = zf.namelist()
        loinc_files = [
            name
            for name in all_names
            if name.endswith("Loinc.csv") and "AccessoryFiles" not in name
        ]
        if not loinc_files:
            loinc_files = [name for name in all_names if name.endswith("Loinc.csv")]
        if not loinc_files:
            raise FileNotFoundError("Loinc.csv not found in ZIP")
        with zf.open(loinc_files[0]) as handle:
            reader = csv.DictReader(io.TextIOWrapper(handle, encoding="utf-8-sig"))
            for row in reader:
                loinc_num = str(row.get("LOINC_NUM", "") or "").strip()
                if not loinc_num:
                    continue
                try:
                    classtype = int(row.get("CLASSTYPE", 0) or 0)
                except ValueError:
                    classtype = 0
                concept_map[loinc_num] = [
                    loinc_num,
                    str(row.get("COMPONENT", "") or "").strip(),
                    str(row.get("PROPERTY", "") or "").strip(),
                    str(row.get("TIME_ASPCT", "") or "").strip(),
                    str(row.get("SYSTEM", "") or "").strip(),
                    str(row.get("SCALE_TYP", "") or "").strip(),
                    str(row.get("METHOD_TYP", "") or "").strip(),
                    str(row.get("LONG_COMMON_NAME", "") or "").strip(),
                    str(row.get("SHORTNAME", "") or "").strip(),
                    str(row.get("CLASS", "") or "").strip(),
                    classtype,
                    str(row.get("STATUS", "") or "").strip(),
                    str(row.get("CONSUMER_NAME", "") or "").strip(),
                    "",
                    "",
                    "",
                    "",
                ]

    mapping_row_count = 0
    mapping_match_count = 0
    if mapping_csv_path:
        for (
            loinc_num,
            name_zh,
            common_name_zh,
            specimen_type,
            unit,
        ) in _load_mapping_csv(mapping_csv_path):
            mapping_row_count += 1
            if loinc_num in concept_map:
                mapping_match_count += 1
                concept_map[loinc_num][13] = name_zh
                concept_map[loinc_num][14] = common_name_zh
                concept_map[loinc_num][15] = specimen_type
                concept_map[loinc_num][16] = unit
    if mapping_csv_path and mapping_row_count == 0:
        raise ValueError(
            "LOINC Taiwan mapping CSV parsed 0 rows. Verify the uploaded CSV headers "
            "include loinc_code, name_zh, common_name_zh, specimen_type, and unit."
        )

    concept_rows = [tuple(values) for values in concept_map.values()]
    concept_codes = set(concept_map.keys())

    range_rows: list[tuple[Any, ...]] = []
    if reference_ranges_csv_path:
        all_ranges = _load_ranges_csv(reference_ranges_csv_path)
        range_rows = [row for row in all_ranges if row[0] in concept_codes]

    return (
        concept_rows,
        range_rows,
        {
            "mapping_row_count": mapping_row_count,
            "mapping_match_count": mapping_match_count,
        },
    )


def _twcore_artifact_group(
    *,
    resource_type: str,
    package_path: str,
    kind: str,
    base_type: str,
    derivation: str,
) -> tuple[str, str]:
    if resource_type == "ImplementationGuide":
        return "implementation-guide", "Implementation guide"
    if package_path.startswith("package/example/"):
        return "examples", "Examples"
    if resource_type == "StructureDefinition":
        if base_type == "Extension" or kind in {"complex-type", "primitive-type"}:
            return "extensions-datatypes", "Extensions & data types"
        if derivation == "specialization":
            return "extensions-datatypes", "Extensions & data types"
        return "profiles", "Profiles"
    if resource_type in {"ValueSet", "CodeSystem", "ConceptMap", "NamingSystem"}:
        return "terminology", "Terminology"
    if resource_type == "SearchParameter":
        return "search-parameters", "Search parameters"
    if resource_type in {"CapabilityStatement", "OperationDefinition"}:
        return "conformance", "Conformance"
    return resource_type.lower(), resource_type


def _twcore_artifact_child_count(resource_type: str, data: dict[str, Any]) -> int:
    if resource_type == "ImplementationGuide":
        return len((data.get("definition") or {}).get("resource") or [])
    if resource_type == "StructureDefinition":
        snapshot = (data.get("snapshot") or {}).get("element") or []
        differential = (data.get("differential") or {}).get("element") or []
        return len(snapshot) or len(differential)
    if resource_type == "CodeSystem":
        return len(data.get("concept") or [])
    if resource_type == "ValueSet":
        expansion = (data.get("expansion") or {}).get("contains") or []
        compose = (data.get("compose") or {}).get("include") or []
        return len(expansion) or len(compose)
    if resource_type == "ConceptMap":
        return sum(len(group.get("element") or []) for group in data.get("group") or [])
    return 0


def _build_twcore_artifact_payload(tgz_path: str) -> list[tuple[Any, ...]]:
    artifact_rows: list[tuple[Any, ...]] = []
    resources: list[tuple[str, dict[str, Any]]] = []
    grouping_names: dict[str, str] = {}
    grouping_by_resource: dict[tuple[str, str], tuple[str, str]] = {}
    grouping_by_url: dict[str, tuple[str, str]] = {}

    with tarfile.open(tgz_path, "r:gz") as tf:
        for member in tf.getmembers():
            package_path = member.name
            if not (
                package_path.startswith("package/") and package_path.endswith(".json")
            ):
                continue
            extracted = tf.extractfile(member)
            if extracted is None:
                continue
            try:
                data = json.loads(extracted.read().decode("utf-8"))
            except Exception:
                continue
            if not isinstance(data, dict):
                continue
            resource_type = str(data.get("resourceType") or "")
            if (
                not resource_type
                or resource_type in {"Bundle"}
                and package_path.endswith(".index.json")
            ):
                continue
            resources.append((package_path, data))

    for package_path, data in resources:
        if data.get("resourceType") != "ImplementationGuide":
            continue
        definition = data.get("definition") or {}
        for grouping in definition.get("grouping") or []:
            grouping_id = str(grouping.get("id") or "")
            if grouping_id:
                grouping_names[grouping_id] = str(grouping.get("name") or grouping_id)
        for item in definition.get("resource") or []:
            grouping_id = str(item.get("groupingId") or "")
            if not grouping_id:
                continue
            grouping_name = grouping_names.get(grouping_id, grouping_id)
            ref = (item.get("reference") or {}).get("reference") or ""
            if "/" in ref:
                ref_type, ref_id = ref.split("/", 1)
                grouping_by_resource[(ref_type, ref_id)] = (grouping_id, grouping_name)
            canonical = (item.get("reference") or {}).get("identifier", {}).get(
                "value"
            ) or ""
            if canonical:
                grouping_by_url[str(canonical)] = (grouping_id, grouping_name)

    for package_path, data in resources:
        resource_type = str(data.get("resourceType") or "")
        artifact_id = str(data.get("id") or "")
        canonical_url = str(data.get("url") or "")
        name = str(data.get("name") or "")
        title = str(data.get("title") or data.get("display") or "")
        status = str(data.get("status") or "")
        kind = str(data.get("kind") or "")
        base_type = str(data.get("type") or "")
        derivation = str(data.get("derivation") or "")
        description = str(data.get("description") or data.get("purpose") or "")
        artifact_key = f"{resource_type}/{artifact_id or package_path}"
        grouping_id = ""
        grouping_name = ""
        grouped = grouping_by_resource.get((resource_type, artifact_id))
        if grouped is None and canonical_url:
            grouped = grouping_by_url.get(canonical_url)
        if grouped is not None:
            grouping_id, grouping_name = grouped
        else:
            grouping_id, grouping_name = _twcore_artifact_group(
                resource_type=resource_type,
                package_path=package_path,
                kind=kind,
                base_type=base_type,
                derivation=derivation,
            )
        child_count = _twcore_artifact_child_count(resource_type, data)
        concept_count = (
            len(data.get("concept") or []) if resource_type == "CodeSystem" else 0
        )
        artifact_rows.append(
            (
                artifact_key,
                resource_type,
                artifact_id,
                canonical_url,
                name,
                title,
                status,
                kind,
                base_type,
                derivation,
                grouping_id,
                grouping_name,
                description,
                package_path,
                child_count,
                concept_count,
                json.dumps(data, ensure_ascii=False),
            )
        )
    return artifact_rows


def _ident_from_package_json(data: dict[str, Any]) -> dict[str, Any]:
    fv = data.get("fhirVersions") or data.get("fhirVersion")
    if isinstance(fv, list):
        fhir_version = str(fv[0]) if fv else ""
    else:
        fhir_version = str(fv or "")
    deps = data.get("dependencies")
    deps = deps if isinstance(deps, dict) else {}
    return {
        "package_id": str(data.get("name") or ""),
        "version": str(data.get("version") or ""),
        "canonical": str(data.get("canonical") or ""),
        "fhir_version": fhir_version,
        "title": str(data.get("title") or data.get("name") or ""),
        "status": str(data.get("status") or ""),
        "dependencies": {str(k): str(v) for k, v in deps.items()},
    }


def _ident_from_ig(data: dict[str, Any]) -> dict[str, Any]:
    fv = data.get("fhirVersion")
    fhir_version = str(fv[0]) if isinstance(fv, list) and fv else str(fv or "")
    deps: dict[str, str] = {}
    for dep in data.get("dependsOn") or []:
        pid = dep.get("packageId")
        ver = dep.get("version")
        if pid and ver:
            deps[str(pid)] = str(ver)
    return {
        "package_id": str(data.get("packageId") or data.get("id") or ""),
        "version": str(data.get("version") or ""),
        "canonical": str(data.get("url") or ""),
        "fhir_version": fhir_version,
        "title": str(data.get("title") or data.get("name") or ""),
        "status": str(data.get("status") or ""),
        "dependencies": deps,
    }


def _parse_ig_package_identity(tgz_path: str) -> dict[str, Any]:
    """Extract IG package identity from a FHIR package ``.tgz``.

    Prefers the npm-style ``package/package.json`` (name / version / canonical /
    fhirVersions / dependencies); falls back to the ImplementationGuide resource
    (packageId / version / fhirVersion / url / dependsOn) when package.json is
    absent. Always returns non-empty ``package_id`` / ``version`` (derived from
    the file name as a last resort) so they are safe as primary-key columns.
    """
    pkg_json: dict[str, Any] | None = None
    ig_res: dict[str, Any] | None = None
    with tarfile.open(tgz_path, "r:gz") as tf:
        for member in tf.getmembers():
            name = member.name
            if not name.endswith(".json"):
                continue
            base = name.rsplit("/", 1)[-1]
            is_pkg = base == "package.json"
            is_ig = ig_res is None and "ImplementationGuide" in base
            if not (is_pkg or is_ig):
                continue
            extracted = tf.extractfile(member)
            if extracted is None:
                continue
            try:
                data = json.loads(extracted.read().decode("utf-8"))
            except Exception:
                continue
            if not isinstance(data, dict):
                continue
            if is_pkg and "name" in data and "resourceType" not in data:
                pkg_json = data
            elif is_ig and data.get("resourceType") == "ImplementationGuide":
                ig_res = data

    identity: dict[str, Any] = {}
    if pkg_json is not None:
        identity = _ident_from_package_json(pkg_json)
    if (not identity.get("package_id") or not identity.get("version")) and ig_res:
        ig_identity = _ident_from_ig(ig_res)
        for key, value in ig_identity.items():
            if not identity.get(key):
                identity[key] = value
    if not identity:
        identity = {
            "package_id": "",
            "version": "",
            "canonical": "",
            "fhir_version": "",
            "title": "",
            "status": "",
            "dependencies": {},
        }
    if not identity.get("package_id"):
        stem = os.path.basename(tgz_path)
        for suffix in (".tgz", ".tar.gz", ".json"):
            if stem.endswith(suffix):
                stem = stem[: -len(suffix)]
        identity["package_id"] = stem or "unknown-package"
    if not identity.get("version"):
        identity["version"] = "0.0.0"
    return identity


def _build_twcore_stage_payload(
    tgz_path: str,
    extra_tgz_paths: list[str] | None = None,
) -> tuple[
    list[dict[str, Any]],
    list[tuple[Any, ...]],
    list[tuple[Any, ...]],
    list[tuple[Any, ...]],
]:
    """Build package-scoped FHIR stage payloads.

    The primary package is ingested first (and is treated as the candidate
    default IG), followed by any optional bound dependency packages (HL7 THO /
    FHIR core). Unlike the former single-IG build, **each package is ingested as
    its own package** — every codesystem / concept / artifact row is prefixed
    with ``(package_id, package_version)`` and the dedup sets are per-package
    (the PK now includes the package, so cross-package collisions are impossible
    and dependency packages become first-class registry entries).

    Returns ``(identities, codesystems, concepts, artifacts)`` where
    ``identities`` are the per-package registry dicts (primary first) and each
    payload tuple is ``(package_id, package_version, ...)``.
    """
    _ensure_repo_root_on_path()
    from loader.loaders.twcore_loader import CODESYSTEM_REGISTRY, _iter_codesystems

    identities: list[dict[str, Any]] = []
    codesystems: list[tuple[Any, ...]] = []
    concepts: list[tuple[Any, ...]] = []
    artifacts: list[tuple[Any, ...]] = []

    def _ingest(path: str) -> None:
        identity = _parse_ig_package_identity(path)
        pid = identity["package_id"]
        pver = identity["version"]
        identities.append(identity)
        seen_cs: set[str] = set()
        seen_concept: set[tuple[str, str]] = set()
        seen_artifact: set[str] = set()
        for cs_id, data in _iter_codesystems(path):
            if cs_id in seen_cs:
                continue
            seen_cs.add(cs_id)
            name, category = CODESYSTEM_REGISTRY.get(cs_id, (cs_id, "unknown"))
            raw_concepts = data.get("concept", [])
            codesystems.append((pid, pver, cs_id, name, category, len(raw_concepts)))
            for concept in raw_concepts:
                code = str(concept.get("code", "") or "")
                if (cs_id, code) in seen_concept:
                    continue
                seen_concept.add((cs_id, code))
                concepts.append(
                    (
                        pid,
                        pver,
                        cs_id,
                        code,
                        str(concept.get("display", "") or ""),
                        str(concept.get("definition", "") or ""),
                    )
                )
        for artifact in _build_twcore_artifact_payload(path):
            artifact_key = artifact[0]
            if artifact_key in seen_artifact:
                continue
            seen_artifact.add(artifact_key)
            artifacts.append((pid, pver, *artifact))

    _ingest(tgz_path)
    for extra in extra_tgz_paths or []:
        _ingest(extra)
    return identities, codesystems, concepts, artifacts


def _build_snomed_stage_payload(
    zip_path: str,
) -> tuple[
    list[tuple[Any, ...]],
    list[tuple[Any, ...]],
    list[tuple[Any, ...]],
    list[tuple[Any, ...]],
    list[tuple[Any, ...]],
]:
    _ensure_repo_root_on_path()
    import zipfile
    from datetime import date

    from loader.loaders.snomed_loader import (
        _load_associations_from_zip,
        _load_concepts_from_zip,
        _load_descriptions_from_zip,
        _load_icd10_map_from_zip,
        _load_relationships_from_zip,
        _load_us_preferred_from_zip,
    )

    with zipfile.ZipFile(zip_path) as zf:
        concepts = _load_concepts_from_zip(zf)
        descriptions = _load_descriptions_from_zip(zf)
        relationships = _load_relationships_from_zip(zf)
        icd_map = _load_icd10_map_from_zip(zf)
        us_preferred_ids = _load_us_preferred_from_zip(zf)
        associations = _load_associations_from_zip(zf)

    concept_rows: list[tuple[Any, ...]] = []
    loaded_concept_ids: set[int] = set()
    for concept_id, effective_time, active, module_id, definition_status_id in concepts:
        parsed_date = date(
            int(effective_time[:4]),
            int(effective_time[4:6]),
            int(effective_time[6:8]),
        )
        concept_rows.append(
            (concept_id, parsed_date, active, module_id, definition_status_id)
        )
        loaded_concept_ids.add(concept_id)

    # Append the us_preferred flag (7th column) — mirrors load_snomed so the
    # admin import marks each concept's official display term identically.
    description_rows = [
        (
            row[0],
            row[1],
            row[2],
            row[3],
            row[4],
            row[5],
            int(row[0]) in us_preferred_ids,
        )
        for row in descriptions
        if int(row[1]) in loaded_concept_ids
    ]
    relationship_rows = [
        row
        for row in relationships
        if int(row[1]) in loaded_concept_ids and int(row[2]) in loaded_concept_ids
    ]
    icd_map_rows = [row for row in icd_map if int(row[0]) in loaded_concept_ids]
    # Historical associations: keep only rows whose successor (target) is a
    # loaded active concept; the retired referenced concept is intentionally
    # absent. Dedupe (ref, target, refset) to satisfy the staging primary key.
    association_rows = list(
        dict.fromkeys(row for row in associations if int(row[1]) in loaded_concept_ids)
    )
    return (
        concept_rows,
        description_rows,
        relationship_rows,
        icd_map_rows,
        association_rows,
    )


async def _run_icd_import_job(
    pool: PoolLike,
    *,
    worker_name: str,
    job: dict[str, Any],
    minio_service: MinioService | None,
) -> None:
    _ensure_repo_root_on_path()

    manifest = _job_source_manifest(job)
    total = 5
    progress = max(int(job.get("progress_current") or 0), 0)
    await append_job_log(
        pool,
        job_id=job["job_id"],
        level="info",
        message="Starting ICD staged import",
        payload={"source_manifest": manifest},
    )
    async with _materialize_bound_sources(
        manifest, minio_service=minio_service
    ) as paths:
        cm_zh: dict[str, str] = {}
        pcs_zh: dict[str, str] = {}
        bilingual_path = paths.get("icd_zh_tw")
        if progress < 1:
            if bilingual_path:
                cm_zh, pcs_zh = _parse_icd_bilingual_names(bilingual_path)
            await _run_validate_step(
                pool,
                job_id=job["job_id"],
                step_key="validate_sources",
                current_step="validated_sources",
                checkpoint={
                    "phase": "validated",
                    "source_roles": sorted(paths.keys()),
                    "has_bilingual_names": bool(bilingual_path),
                    "cm_chinese_name_count": len(cm_zh),
                    "pcs_chinese_name_count": len(pcs_zh),
                },
                job_progress_after=1,
                job_progress_total=total,
            )
            progress = 1
            if await _apply_control_checkpoint(
                pool,
                job_id=job["job_id"],
                worker_name=worker_name,
            ):
                return
        else:
            if bilingual_path:
                cm_zh, pcs_zh = _parse_icd_bilingual_names(bilingual_path)

        diagnoses = _parse_icd10cm_stage_records(paths["icd10cm"], name_zh_map=cm_zh)
        procedures = (
            _parse_icd10pcs_stage_records(paths["icd10pcs"], name_zh_map=pcs_zh)
            if "icd10pcs" in paths
            else []
        )

        if progress < 2:
            interrupted = await _stage_rows(
                pool,
                job_id=job["job_id"],
                worker_name=worker_name,
                step_key="stage_diagnoses",
                running_step_name="staging_diagnoses",
                rows=diagnoses,
                insert_sql="""
                    INSERT INTO admin.stage_icd_diagnoses (job_id, code, name_en, name_zh, category)
                    VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT (job_id, code) DO UPDATE SET
                        name_en = EXCLUDED.name_en,
                        name_zh = EXCLUDED.name_zh,
                        category = EXCLUDED.category
                """,
                batch_size=5000,
                job_progress_before=1,
                job_progress_after=2,
                job_progress_total=total,
                checkpoint_label="staging_diagnoses",
            )
            if interrupted:
                return
            progress = 2

        if progress < 3:
            interrupted = await _stage_rows(
                pool,
                job_id=job["job_id"],
                worker_name=worker_name,
                step_key="stage_procedures",
                running_step_name="staging_procedures",
                rows=procedures,
                insert_sql="""
                    INSERT INTO admin.stage_icd_procedures (job_id, code, name_en, name_zh)
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (job_id, code) DO UPDATE SET
                        name_en = EXCLUDED.name_en,
                        name_zh = EXCLUDED.name_zh
                """,
                batch_size=5000,
                job_progress_before=2,
                job_progress_after=3,
                job_progress_total=total,
                checkpoint_label="staging_procedures",
            )
            if interrupted:
                return
            progress = 3

        if progress < 4:
            if await _checkpoint_before_promote(
                pool,
                job_id=job["job_id"],
                worker_name=worker_name,
                step_key="promote",
                job_progress_before=3,
                job_progress_total=total,
            ):
                return
            await _optimized_promote(
                pool,
                job_id=job["job_id"],
                step_key="promote",
                index_tables=["icd.diagnoses", "icd.procedures"],
                truncate_sql="TRUNCATE icd.diagnoses, icd.procedures",
                copies=[
                    (
                        """
                        INSERT INTO icd.diagnoses (code, name_en, name_zh, category)
                        SELECT code, name_en, name_zh, category
                        FROM admin.stage_icd_diagnoses
                        WHERE job_id = $1::uuid
                        """,
                        (job["job_id"],),
                        f"diagnoses ({len(diagnoses):,})",
                    ),
                    (
                        """
                        INSERT INTO icd.procedures (code, name_en, name_zh)
                        SELECT code, name_en, name_zh
                        FROM admin.stage_icd_procedures
                        WHERE job_id = $1::uuid
                        """,
                        (job["job_id"],),
                        f"procedures ({len(procedures):,})",
                    ),
                ],
                final_checkpoint={
                    "phase": "promoted",
                    "diagnosis_count": len(diagnoses),
                    "procedure_count": len(procedures),
                },
                promoted_step_name="promoted_icd",
                job_progress_after=4,
                job_progress_total=total,
            )
            progress = 4

        await _clear_stage_rows(
            pool,
            job_id=job["job_id"],
            table_names=(
                "admin.stage_icd_diagnoses",
                "admin.stage_icd_procedures",
            ),
        )
        await record_job_step(
            pool,
            job_id=job["job_id"],
            step_key="cleanup_staging",
            status="success",
            progress_current=1,
            progress_total=1,
            checkpoint={"phase": "cleaned"},
        )
        await mark_job_status(
            pool,
            job_id=job["job_id"],
            status="success",
            current_step="completed",
            progress_current=5,
            progress_total=total,
            control_state="idle",
            result_summary={
                "job_type": "icd_import",
                "source_manifest": manifest,
                "diagnosis_count": len(diagnoses),
                "procedure_count": len(procedures),
                "cm_chinese_name_count": sum(1 for row in diagnoses if row[2]),
                "pcs_chinese_name_count": sum(1 for row in procedures if row[2]),
            },
        )


async def _run_loinc_import_job(
    pool: PoolLike,
    *,
    worker_name: str,
    job: dict[str, Any],
    minio_service: MinioService | None,
) -> None:
    manifest = _job_source_manifest(job)
    total = 5
    progress = max(int(job.get("progress_current") or 0), 0)
    await append_job_log(
        pool,
        job_id=job["job_id"],
        level="info",
        message="Starting LOINC staged import",
        payload={"source_manifest": manifest},
    )
    async with _materialize_bound_sources(
        manifest, minio_service=minio_service
    ) as paths:
        concept_rows, range_rows, loinc_stats = _build_loinc_stage_payload(
            paths["loinc"],
            mapping_csv_path=paths.get("loinc_taiwan_mapping"),
            reference_ranges_csv_path=paths.get("loinc_reference_ranges"),
        )
        if progress < 1:
            await _run_validate_step(
                pool,
                job_id=job["job_id"],
                step_key="validate_sources",
                current_step="validated_sources",
                checkpoint={
                    "phase": "validated",
                    "source_roles": sorted(paths.keys()),
                    "concept_count": len(concept_rows),
                    "reference_range_count": len(range_rows),
                    **loinc_stats,
                },
                job_progress_after=1,
                job_progress_total=total,
            )
            progress = 1
            if await _apply_control_checkpoint(
                pool,
                job_id=job["job_id"],
                worker_name=worker_name,
            ):
                return

        if progress < 2:
            interrupted = await _stage_rows(
                pool,
                job_id=job["job_id"],
                worker_name=worker_name,
                step_key="stage_concepts",
                running_step_name="staging_loinc_concepts",
                rows=concept_rows,
                insert_sql="""
                    INSERT INTO admin.stage_loinc_concepts (
                        job_id, loinc_num, component, property, time_aspect, system,
                        scale_type, method_type, long_common_name, shortname, class,
                        classtype, status, consumer_name, name_zh, common_name_zh,
                        specimen_type, unit
                    )
                    VALUES (
                        $1, $2, $3, $4, $5, $6,
                        $7, $8, $9, $10, $11,
                        $12, $13, $14, $15, $16,
                        $17, $18
                    )
                    ON CONFLICT (job_id, loinc_num) DO UPDATE SET
                        component = EXCLUDED.component,
                        property = EXCLUDED.property,
                        time_aspect = EXCLUDED.time_aspect,
                        system = EXCLUDED.system,
                        scale_type = EXCLUDED.scale_type,
                        method_type = EXCLUDED.method_type,
                        long_common_name = EXCLUDED.long_common_name,
                        shortname = EXCLUDED.shortname,
                        class = EXCLUDED.class,
                        classtype = EXCLUDED.classtype,
                        status = EXCLUDED.status,
                        consumer_name = EXCLUDED.consumer_name,
                        name_zh = EXCLUDED.name_zh,
                        common_name_zh = EXCLUDED.common_name_zh,
                        specimen_type = EXCLUDED.specimen_type,
                        unit = EXCLUDED.unit
                """,
                batch_size=5000,
                job_progress_before=1,
                job_progress_after=2,
                job_progress_total=total,
                checkpoint_label="staging_loinc_concepts",
            )
            if interrupted:
                return
            progress = 2

        if progress < 3:
            interrupted = await _stage_rows(
                pool,
                job_id=job["job_id"],
                worker_name=worker_name,
                step_key="stage_reference_ranges",
                running_step_name="staging_loinc_reference_ranges",
                rows=range_rows,
                insert_sql="""
                    INSERT INTO admin.stage_loinc_reference_ranges (
                        job_id, loinc_num, age_min, age_max, gender,
                        range_low, range_high, unit, interpretation
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    ON CONFLICT (job_id, loinc_num, age_min, age_max, gender, unit, interpretation)
                    DO NOTHING
                """,
                batch_size=5000,
                job_progress_before=2,
                job_progress_after=3,
                job_progress_total=total,
                checkpoint_label="staging_loinc_reference_ranges",
            )
            if interrupted:
                return
            progress = 3

        if progress < 4:
            if await _checkpoint_before_promote(
                pool,
                job_id=job["job_id"],
                worker_name=worker_name,
                step_key="promote",
                job_progress_before=3,
                job_progress_total=total,
            ):
                return
            await _optimized_promote(
                pool,
                job_id=job["job_id"],
                step_key="promote",
                index_tables=["loinc.concepts", "loinc.reference_ranges"],
                truncate_sql="TRUNCATE loinc.reference_ranges, loinc.concepts CASCADE",
                copies=[
                    (
                        """
                        INSERT INTO loinc.concepts (
                            loinc_num, component, property, time_aspect, system,
                            scale_type, method_type, long_common_name, shortname, class,
                            classtype, status, consumer_name, name_zh, common_name_zh,
                            specimen_type, unit
                        )
                        SELECT
                            loinc_num, component, property, time_aspect, system,
                            scale_type, method_type, long_common_name, shortname, class,
                            classtype, status, consumer_name, name_zh, common_name_zh,
                            specimen_type, unit
                        FROM admin.stage_loinc_concepts
                        WHERE job_id = $1::uuid
                        """,
                        (job["job_id"],),
                        f"concepts ({len(concept_rows):,})",
                    ),
                    (
                        """
                        INSERT INTO loinc.reference_ranges (
                            loinc_num, age_min, age_max, gender,
                            range_low, range_high, unit, interpretation
                        )
                        SELECT
                            loinc_num, age_min, age_max, gender,
                            range_low, range_high, unit, interpretation
                        FROM admin.stage_loinc_reference_ranges
                        WHERE job_id = $1::uuid
                        """,
                        (job["job_id"],),
                        f"reference ranges ({len(range_rows):,})",
                    ),
                ],
                final_checkpoint={
                    "phase": "promoted",
                    "concept_count": len(concept_rows),
                    "reference_range_count": len(range_rows),
                },
                promoted_step_name="promoted_loinc",
                job_progress_after=4,
                job_progress_total=total,
            )
            progress = 4

        await _clear_stage_rows(
            pool,
            job_id=job["job_id"],
            table_names=(
                "admin.stage_loinc_reference_ranges",
                "admin.stage_loinc_concepts",
            ),
        )
        await record_job_step(
            pool,
            job_id=job["job_id"],
            step_key="cleanup_staging",
            status="success",
            progress_current=1,
            progress_total=1,
            checkpoint={"phase": "cleaned"},
        )
        await mark_job_status(
            pool,
            job_id=job["job_id"],
            status="success",
            current_step="completed",
            progress_current=5,
            progress_total=total,
            control_state="idle",
            result_summary={
                "job_type": "loinc_import",
                "source_manifest": manifest,
                "concept_count": len(concept_rows),
                "reference_range_count": len(range_rows),
                **loinc_stats,
            },
        )


# ---------------------------------------------------------------------------
# IG import — registry/upload source acquisition + recursive dependency fetch
# ---------------------------------------------------------------------------

#: Safety cap on the recursive closure size (root + dependency IGs) per import.
_IG_DEP_MAX_PACKAGES = 50


async def _registry_bases(pool: PoolLike) -> tuple[str, str | None]:
    """``(base_url, fallback_url)`` from the ``registry`` settings group."""
    import admin_settings as _admin_settings
    import fhir_registry

    try:
        cfg = await _admin_settings.get_group(pool, "registry")
    except Exception:  # noqa: BLE001 — fall back to library defaults
        cfg = {}
    base = fhir_registry.normalize_base(cfg.get("base_url"))
    fb_raw = str(cfg.get("fallback_url") or "").strip()
    fallback = fhir_registry.normalize_base(fb_raw) if fb_raw else None
    return base, fallback


async def _installed_ig_packages(pool: PoolLike) -> set[tuple[str, str]]:
    async with pool.acquire() as conn:
        rows = await conn.fetch("SELECT package_id, version FROM fhir.ig_packages")
    return {(r["package_id"], r["version"]) for r in rows}


async def _store_ig_tarball(
    minio_service: MinioService | None, pid: str, pver: str, data: bytes
) -> None:
    """Best-effort archive of a fetched IG tarball in MinIO (re-import / audit)."""
    if minio_service is None or not minio_service.enabled:
        return
    try:
        await minio_service.upload_bytes(
            object_key=f"ig-packages/{pid}/{pver}/package.tgz",
            data=data,
            content_type="application/gzip",
        )
    except Exception:  # noqa: BLE001 — archival is non-critical
        pass


async def _acquire_ig_root(
    pool: PoolLike,
    *,
    opts: dict[str, Any],
    ig_source: str,
    tmpdir: str,
    minio_service: MinioService | None,
    job: dict[str, Any],
) -> str:
    """Materialize the root IG ``.tgz`` to a local path (registry or upload)."""
    dest = os.path.join(tmpdir, "ig-root.tgz")
    if ig_source == "registry":
        import fhir_registry

        package_id = str(opts.get("package_id") or "").strip()
        version = str(opts.get("version") or "").strip() or None
        if not package_id:
            raise RuntimeError(
                "registry IG import requires 'package_id' in job_options"
            )
        base, fallback = await _registry_bases(pool)
        meta = await fhir_registry.get_metadata(base, package_id)
        resolved = fhir_registry.resolve_version(meta, version)
        data = await fhir_registry.download_tarball(
            base, package_id, resolved, meta=meta, fallback=fallback
        )
        with open(dest, "wb") as fh:
            fh.write(data)
        await _store_ig_tarball(minio_service, package_id, resolved, data)
        await append_job_log(
            pool,
            job_id=job["job_id"],
            level="info",
            message=f"Fetched root IG {package_id}@{resolved} from registry",
        )
        return dest
    # upload: the chosen file's MinIO object key travels in job_options
    object_key = str(opts.get("object_key") or "").strip()
    if not object_key:
        raise RuntimeError("upload IG import requires 'object_key' in job_options")
    if minio_service is None or not minio_service.enabled:
        raise RuntimeError("MinIO is required to read the uploaded IG package")
    data = await minio_service.download_bytes(object_key)
    with open(dest, "wb") as fh:
        fh.write(data)
    return dest


async def _fetch_ig_dependencies(
    pool: PoolLike,
    *,
    root_path: str,
    tmpdir: str,
    minio_service: MinioService | None,
    job: dict[str, Any],
) -> tuple[list[str], list[dict[str, str]]]:
    """Recursively fetch (BFS) every declared dependency IG not already installed.

    Each package's dependencies are read from its own ``package.json`` (registry
    metadata omits them). Returns ``(dep_tgz_paths, missing)`` where ``missing`` is
    a list of ``{package_id, version, reason}`` for deps the registry could not
    supply — surfaced for manual upload, never silently dropped.
    """
    import fhir_registry

    installed = await _installed_ig_packages(pool)
    root_identity = _parse_ig_package_identity(root_path)
    seen: set[tuple[str, str]] = {
        (root_identity["package_id"], root_identity["version"])
    }
    base, fallback = await _registry_bases(pool)

    queue: list[tuple[str, str]] = []

    def _enqueue(deps: dict[str, Any]) -> None:
        for dep_id, dep_ver in (deps or {}).items():
            key = (str(dep_id), str(dep_ver))
            if key in seen or key in installed or key in queue:
                continue
            queue.append(key)

    _enqueue(root_identity.get("dependencies") or {})

    dep_paths: list[str] = []
    missing: list[dict[str, str]] = []
    idx = 0
    while queue and len(dep_paths) < _IG_DEP_MAX_PACKAGES:
        dep_id, dep_ver = queue.pop(0)
        if (dep_id, dep_ver) in seen or (dep_id, dep_ver) in installed:
            continue
        seen.add((dep_id, dep_ver))
        try:
            meta = await fhir_registry.get_metadata(base, dep_id)
            resolved = fhir_registry.resolve_version(meta, dep_ver or None)
            data = await fhir_registry.download_tarball(
                base, dep_id, resolved, meta=meta, fallback=fallback
            )
        except fhir_registry.RegistryError as exc:
            missing.append(
                {"package_id": dep_id, "version": dep_ver, "reason": str(exc)}
            )
            await append_job_log(
                pool,
                job_id=job["job_id"],
                level="warning",
                message=f"Dependency {dep_id}@{dep_ver} could not be fetched: {exc}",
            )
            continue
        idx += 1
        path = os.path.join(tmpdir, f"ig-dep-{idx}.tgz")
        with open(path, "wb") as fh:
            fh.write(data)
        dep_paths.append(path)
        await _store_ig_tarball(minio_service, dep_id, resolved, data)
        await append_job_log(
            pool,
            job_id=job["job_id"],
            level="info",
            message=f"Fetched dependency IG {dep_id}@{resolved}",
        )
        dep_identity = _parse_ig_package_identity(path)
        _enqueue(dep_identity.get("dependencies") or {})

    return dep_paths, missing


async def _run_ig_import_job(
    pool: PoolLike,
    *,
    worker_name: str,
    job: dict[str, Any],
    minio_service: MinioService | None,
) -> None:
    opts = _json_object(job.get("job_options"))
    ig_source = str(opts.get("ig_source") or "upload")
    total = 5
    progress = max(int(job.get("progress_current") or 0), 0)
    await append_job_log(
        pool,
        job_id=job["job_id"],
        level="info",
        message="Starting IG import",
        payload={"ig_source": ig_source},
    )
    with tempfile.TemporaryDirectory(prefix="admin-ig-import-") as tmpdir:
        root_path = await _acquire_ig_root(
            pool,
            opts=opts,
            ig_source=ig_source,
            tmpdir=tmpdir,
            minio_service=minio_service,
            job=job,
        )
        dep_paths, missing_deps = await _fetch_ig_dependencies(
            pool,
            root_path=root_path,
            tmpdir=tmpdir,
            minio_service=minio_service,
            job=job,
        )
        identities, codesystems, concepts, artifacts = _build_twcore_stage_payload(
            root_path, dep_paths
        )
        package_labels = [f'{i["package_id"]}@{i["version"]}' for i in identities]
        if progress < 1:
            await _run_validate_step(
                pool,
                job_id=job["job_id"],
                step_key="validate_sources",
                current_step="validated_sources",
                checkpoint={
                    "phase": "validated",
                    "packages": package_labels,
                    "missing_dependencies": missing_deps,
                    "codesystem_count": len(codesystems),
                    "concept_count": len(concepts),
                    "artifact_count": len(artifacts),
                },
                job_progress_after=1,
                job_progress_total=total,
            )
            progress = 1
            if await _apply_control_checkpoint(
                pool,
                job_id=job["job_id"],
                worker_name=worker_name,
            ):
                return

        if progress < 2:
            interrupted = await _stage_rows(
                pool,
                job_id=job["job_id"],
                worker_name=worker_name,
                step_key="stage_codesystems",
                running_step_name="staging_twcore_codesystems",
                rows=codesystems,
                insert_sql="""
                    INSERT INTO admin.stage_twcore_codesystems
                        (job_id, package_id, package_version, cs_id, name, category, concept_count)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    ON CONFLICT (job_id, package_id, package_version, cs_id) DO UPDATE SET
                        name = EXCLUDED.name,
                        category = EXCLUDED.category,
                        concept_count = EXCLUDED.concept_count
                """,
                batch_size=1000,
                job_progress_before=1,
                job_progress_after=2,
                job_progress_total=total,
                checkpoint_label="staging_twcore_codesystems",
            )
            if interrupted:
                return
            progress = 2

        if progress < 3:
            interrupted = await _stage_rows(
                pool,
                job_id=job["job_id"],
                worker_name=worker_name,
                step_key="stage_artifacts",
                running_step_name="staging_twcore_artifacts",
                rows=artifacts,
                insert_sql="""
                    INSERT INTO admin.stage_twcore_artifacts (
                        job_id, package_id, package_version,
                        artifact_key, resource_type, artifact_id, canonical_url,
                        name, title, status, kind, base_type, derivation,
                        grouping_id, grouping_name, description, package_path,
                        child_count, concept_count, raw_json
                    )
                    VALUES (
                        $1, $2, $3,
                        $4, $5, $6, $7,
                        $8, $9, $10, $11, $12, $13,
                        $14, $15, $16, $17,
                        $18, $19, $20::jsonb
                    )
                    ON CONFLICT (job_id, package_id, package_version, artifact_key) DO UPDATE SET
                        resource_type = EXCLUDED.resource_type,
                        artifact_id = EXCLUDED.artifact_id,
                        canonical_url = EXCLUDED.canonical_url,
                        name = EXCLUDED.name,
                        title = EXCLUDED.title,
                        status = EXCLUDED.status,
                        kind = EXCLUDED.kind,
                        base_type = EXCLUDED.base_type,
                        derivation = EXCLUDED.derivation,
                        grouping_id = EXCLUDED.grouping_id,
                        grouping_name = EXCLUDED.grouping_name,
                        description = EXCLUDED.description,
                        package_path = EXCLUDED.package_path,
                        child_count = EXCLUDED.child_count,
                        concept_count = EXCLUDED.concept_count,
                        raw_json = EXCLUDED.raw_json
                """,
                batch_size=500,
                job_progress_before=2,
                job_progress_after=2,
                job_progress_total=total,
                checkpoint_label="staging_twcore_artifacts",
            )
            if interrupted:
                return
            interrupted = await _stage_rows(
                pool,
                job_id=job["job_id"],
                worker_name=worker_name,
                step_key="stage_concepts",
                running_step_name="staging_twcore_concepts",
                rows=concepts,
                insert_sql="""
                    INSERT INTO admin.stage_twcore_concepts
                        (job_id, package_id, package_version, cs_id, code, display, definition)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    ON CONFLICT (job_id, package_id, package_version, cs_id, code) DO UPDATE SET
                        display = EXCLUDED.display,
                        definition = EXCLUDED.definition
                """,
                batch_size=5000,
                job_progress_before=2,
                job_progress_after=3,
                job_progress_total=total,
                checkpoint_label="staging_twcore_concepts",
            )
            if interrupted:
                return
            progress = 3

        if progress < 4:
            if await _checkpoint_before_promote(
                pool,
                job_id=job["job_id"],
                worker_name=worker_name,
                step_key="promote",
                job_progress_before=3,
                job_progress_total=total,
            ):
                return

            # Decide which package (if any) becomes the default IG. The primary
            # package (identities[0]) is flagged default only when no other
            # package currently holds the flag — we never silently demote an
            # existing default. is_default is applied on INSERT only; the
            # ON CONFLICT path preserves whatever flag a package already had.
            existing_default = await pool.fetchval(
                "SELECT package_id FROM fhir.ig_packages WHERE is_default LIMIT 1"
            )
            primary_id = identities[0]["package_id"] if identities else None
            make_primary_default = (
                existing_default is None or existing_default == primary_id
            )
            package_copies: list[tuple[str, tuple[Any, ...], str]] = []
            for idx, ident in enumerate(identities):
                is_default = bool(idx == 0 and make_primary_default)
                package_copies.append(
                    (
                        """
                        INSERT INTO fhir.ig_packages
                            (package_id, version, canonical, fhir_version, title,
                             status, is_default, dependencies, imported_at)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW())
                        ON CONFLICT (package_id, version) DO UPDATE SET
                            canonical = EXCLUDED.canonical,
                            fhir_version = EXCLUDED.fhir_version,
                            title = EXCLUDED.title,
                            status = EXCLUDED.status,
                            dependencies = EXCLUDED.dependencies,
                            imported_at = NOW()
                        """,
                        (
                            ident["package_id"],
                            ident["version"],
                            ident["canonical"],
                            ident["fhir_version"],
                            ident["title"],
                            ident["status"],
                            is_default,
                            json.dumps(ident["dependencies"], ensure_ascii=False),
                        ),
                        f"registered IG {ident['package_id']}#{ident['version']}",
                    )
                )

            # Per-package DELETE (not a global TRUNCATE) so re-importing one IG
            # never wipes the others; fhir.concepts cascade from codesystems. The
            # job_id is a UUID, safe to inline (truncate_sql takes no params).
            job_uuid_literal = str(job["job_id"])
            scoped_delete_sql = (
                "DELETE FROM fhir.artifacts a USING ("
                "SELECT DISTINCT package_id, package_version "
                f"FROM admin.stage_twcore_artifacts WHERE job_id = '{job_uuid_literal}'::uuid"
                ") s WHERE a.package_id = s.package_id AND a.package_version = s.package_version; "
                "DELETE FROM fhir.codesystems c USING ("
                "SELECT DISTINCT package_id, package_version "
                f"FROM admin.stage_twcore_codesystems WHERE job_id = '{job_uuid_literal}'::uuid"
                ") s WHERE c.package_id = s.package_id AND c.package_version = s.package_version"
            )

            await _optimized_promote(
                pool,
                job_id=job["job_id"],
                step_key="promote",
                index_tables=[
                    "fhir.codesystems",
                    "fhir.concepts",
                    "fhir.artifacts",
                ],
                truncate_sql=scoped_delete_sql,
                copies=[
                    *package_copies,
                    (
                        """
                        INSERT INTO fhir.codesystems
                            (package_id, package_version, cs_id, name, category, fetched_at, concept_count)
                        SELECT package_id, package_version, cs_id, name, category, NOW(), concept_count
                        FROM admin.stage_twcore_codesystems
                        WHERE job_id = $1::uuid
                        """,
                        (job["job_id"],),
                        f"codesystems ({len(codesystems):,})",
                    ),
                    (
                        """
                        INSERT INTO fhir.concepts
                            (package_id, package_version, cs_id, code, display, definition)
                        SELECT package_id, package_version, cs_id, code, display, definition
                        FROM admin.stage_twcore_concepts
                        WHERE job_id = $1::uuid
                        """,
                        (job["job_id"],),
                        f"concepts ({len(concepts):,})",
                    ),
                    (
                        """
                        INSERT INTO fhir.artifacts (
                            package_id, package_version,
                            artifact_key, resource_type, artifact_id, canonical_url,
                            name, title, status, kind, base_type, derivation,
                            grouping_id, grouping_name, description, package_path,
                            child_count, concept_count, raw_json, imported_at
                        )
                        SELECT
                            package_id, package_version,
                            artifact_key, resource_type, artifact_id, canonical_url,
                            name, title, status, kind, base_type, derivation,
                            grouping_id, grouping_name, description, package_path,
                            child_count, concept_count, raw_json, NOW()
                        FROM admin.stage_twcore_artifacts
                        WHERE job_id = $1::uuid
                        """,
                        (job["job_id"],),
                        f"artifacts ({len(artifacts):,})",
                    ),
                ],
                final_checkpoint={
                    "phase": "promoted",
                    "package_count": len(identities),
                    "codesystem_count": len(codesystems),
                    "concept_count": len(concepts),
                    "artifact_count": len(artifacts),
                },
                promoted_step_name="promoted_twcore",
                job_progress_after=4,
                job_progress_total=total,
            )
            progress = 4

        await _clear_stage_rows(
            pool,
            job_id=job["job_id"],
            table_names=(
                "admin.stage_twcore_artifacts",
                "admin.stage_twcore_concepts",
                "admin.stage_twcore_codesystems",
            ),
        )
        await record_job_step(
            pool,
            job_id=job["job_id"],
            step_key="cleanup_staging",
            status="success",
            progress_current=1,
            progress_total=1,
            checkpoint={"phase": "cleaned"},
        )
        await mark_job_status(
            pool,
            job_id=job["job_id"],
            status="success",
            current_step="completed",
            progress_current=5,
            progress_total=total,
            control_state="idle",
            result_summary={
                "job_type": "ig_import",
                "ig_source": ig_source,
                "packages": package_labels,
                "missing_dependencies": missing_deps,
                "codesystem_count": len(codesystems),
                "concept_count": len(concepts),
                "artifact_count": len(artifacts),
            },
        )


async def _run_snomed_import_job(
    pool: PoolLike,
    *,
    worker_name: str,
    job: dict[str, Any],
    minio_service: MinioService | None,
) -> None:
    manifest = _job_source_manifest(job)
    total = 8
    progress = max(int(job.get("progress_current") or 0), 0)
    await append_job_log(
        pool,
        job_id=job["job_id"],
        level="info",
        message="Starting SNOMED staged import",
        payload={"source_manifest": manifest},
    )
    async with _materialize_bound_sources(
        manifest, minio_service=minio_service
    ) as paths:
        (
            concept_rows,
            description_rows,
            relationship_rows,
            icd_map_rows,
            association_rows,
        ) = _build_snomed_stage_payload(paths["snomed_ct"])
        if progress < 1:
            await _run_validate_step(
                pool,
                job_id=job["job_id"],
                step_key="validate_sources",
                current_step="validated_sources",
                checkpoint={
                    "phase": "validated",
                    "source_roles": sorted(paths.keys()),
                    "concept_count": len(concept_rows),
                    "description_count": len(description_rows),
                    "relationship_count": len(relationship_rows),
                    "icd10_map_count": len(icd_map_rows),
                    "association_count": len(association_rows),
                },
                job_progress_after=1,
                job_progress_total=total,
            )
            progress = 1
            if await _apply_control_checkpoint(
                pool,
                job_id=job["job_id"],
                worker_name=worker_name,
            ):
                return

        if progress < 2:
            interrupted = await _stage_rows(
                pool,
                job_id=job["job_id"],
                worker_name=worker_name,
                step_key="stage_concepts",
                running_step_name="staging_snomed_concepts",
                rows=concept_rows,
                insert_sql="""
                    INSERT INTO admin.stage_snomed_concepts (
                        job_id, concept_id, effective_time, active, module_id, definition_status_id
                    )
                    VALUES ($1, $2, $3, $4, $5, $6)
                    ON CONFLICT (job_id, concept_id) DO UPDATE SET
                        effective_time = EXCLUDED.effective_time,
                        active = EXCLUDED.active,
                        module_id = EXCLUDED.module_id,
                        definition_status_id = EXCLUDED.definition_status_id
                """,
                batch_size=5000,
                job_progress_before=1,
                job_progress_after=2,
                job_progress_total=total,
                checkpoint_label="staging_snomed_concepts",
            )
            if interrupted:
                return
            progress = 2

        if progress < 3:
            interrupted = await _stage_rows(
                pool,
                job_id=job["job_id"],
                worker_name=worker_name,
                step_key="stage_descriptions",
                running_step_name="staging_snomed_descriptions",
                rows=description_rows,
                insert_sql="""
                    INSERT INTO admin.stage_snomed_descriptions (
                        job_id, description_id, concept_id, type_id, term, active, language_code, us_preferred
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    ON CONFLICT (job_id, description_id) DO UPDATE SET
                        concept_id = EXCLUDED.concept_id,
                        type_id = EXCLUDED.type_id,
                        term = EXCLUDED.term,
                        active = EXCLUDED.active,
                        language_code = EXCLUDED.language_code,
                        us_preferred = EXCLUDED.us_preferred
                """,
                batch_size=5000,
                job_progress_before=2,
                job_progress_after=3,
                job_progress_total=total,
                checkpoint_label="staging_snomed_descriptions",
            )
            if interrupted:
                return
            progress = 3

        if progress < 4:
            interrupted = await _stage_rows(
                pool,
                job_id=job["job_id"],
                worker_name=worker_name,
                step_key="stage_relationships",
                running_step_name="staging_snomed_relationships",
                rows=relationship_rows,
                insert_sql="""
                    INSERT INTO admin.stage_snomed_relationships (
                        job_id, relationship_id, source_id, destination_id, type_id, active, characteristic_type_id
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    ON CONFLICT (job_id, relationship_id) DO UPDATE SET
                        source_id = EXCLUDED.source_id,
                        destination_id = EXCLUDED.destination_id,
                        type_id = EXCLUDED.type_id,
                        active = EXCLUDED.active,
                        characteristic_type_id = EXCLUDED.characteristic_type_id
                """,
                batch_size=5000,
                job_progress_before=3,
                job_progress_after=4,
                job_progress_total=total,
                checkpoint_label="staging_snomed_relationships",
            )
            if interrupted:
                return
            progress = 4

        if progress < 5:
            interrupted = await _stage_rows(
                pool,
                job_id=job["job_id"],
                worker_name=worker_name,
                step_key="stage_icd10_map",
                running_step_name="staging_snomed_icd10_map",
                rows=icd_map_rows,
                insert_sql="""
                    INSERT INTO admin.stage_snomed_icd10_map (
                        job_id, referenced_component_id, map_target, map_rule,
                        map_advice, map_priority, map_group, active
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    ON CONFLICT (job_id, referenced_component_id, map_target, map_priority, map_group)
                    DO NOTHING
                """,
                batch_size=5000,
                job_progress_before=4,
                job_progress_after=5,
                job_progress_total=total,
                checkpoint_label="staging_snomed_icd10_map",
            )
            if interrupted:
                return
            progress = 5

        if progress < 6:
            interrupted = await _stage_rows(
                pool,
                job_id=job["job_id"],
                worker_name=worker_name,
                step_key="stage_associations",
                running_step_name="staging_snomed_associations",
                rows=association_rows,
                insert_sql="""
                    INSERT INTO admin.stage_snomed_associations (
                        job_id, referenced_component_id, target_component_id, refset_id
                    )
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (job_id, referenced_component_id, target_component_id, refset_id)
                    DO NOTHING
                """,
                batch_size=5000,
                job_progress_before=5,
                job_progress_after=6,
                job_progress_total=total,
                checkpoint_label="staging_snomed_associations",
            )
            if interrupted:
                return
            progress = 6

        if progress < 7:
            if await _checkpoint_before_promote(
                pool,
                job_id=job["job_id"],
                worker_name=worker_name,
                step_key="promote",
                job_progress_before=6,
                job_progress_total=total,
            ):
                return
            await _optimized_promote(
                pool,
                job_id=job["job_id"],
                step_key="promote",
                index_tables=[
                    "snomed.concepts",
                    "snomed.descriptions",
                    "snomed.relationships",
                    "snomed.icd10_map",
                    "snomed.historical_associations",
                ],
                truncate_sql=(
                    "TRUNCATE snomed.historical_associations, snomed.icd10_map, "
                    "snomed.relationships, snomed.descriptions, snomed.concepts CASCADE"
                ),
                copies=[
                    (
                        """
                        INSERT INTO snomed.concepts (
                            concept_id, effective_time, active, module_id, definition_status_id
                        )
                        SELECT concept_id, effective_time, active, module_id, definition_status_id
                        FROM admin.stage_snomed_concepts
                        WHERE job_id = $1::uuid
                        """,
                        (job["job_id"],),
                        f"concepts ({len(concept_rows):,})",
                    ),
                    (
                        """
                        INSERT INTO snomed.descriptions (
                            description_id, concept_id, type_id, term, active, language_code, us_preferred
                        )
                        SELECT description_id, concept_id, type_id, term, active, language_code, us_preferred
                        FROM admin.stage_snomed_descriptions
                        WHERE job_id = $1::uuid
                        """,
                        (job["job_id"],),
                        f"descriptions ({len(description_rows):,})",
                    ),
                    (
                        """
                        INSERT INTO snomed.relationships (
                            relationship_id, source_id, destination_id, type_id, active, characteristic_type_id
                        )
                        SELECT relationship_id, source_id, destination_id, type_id, active, characteristic_type_id
                        FROM admin.stage_snomed_relationships
                        WHERE job_id = $1::uuid
                        """,
                        (job["job_id"],),
                        f"relationships ({len(relationship_rows):,})",
                    ),
                    (
                        """
                        INSERT INTO snomed.icd10_map (
                            referenced_component_id, map_target, map_rule, map_advice,
                            map_priority, map_group, active
                        )
                        SELECT referenced_component_id, map_target, map_rule, map_advice,
                               map_priority, map_group, active
                        FROM admin.stage_snomed_icd10_map
                        WHERE job_id = $1::uuid
                        """,
                        (job["job_id"],),
                        f"icd10 map ({len(icd_map_rows):,})",
                    ),
                    (
                        """
                        INSERT INTO snomed.historical_associations (
                            referenced_component_id, target_component_id, refset_id
                        )
                        SELECT referenced_component_id, target_component_id, refset_id
                        FROM admin.stage_snomed_associations
                        WHERE job_id = $1::uuid
                        ON CONFLICT DO NOTHING
                        """,
                        (job["job_id"],),
                        f"historical associations ({len(association_rows):,})",
                    ),
                ],
                final_checkpoint={
                    "phase": "promoted",
                    "concept_count": len(concept_rows),
                    "description_count": len(description_rows),
                    "relationship_count": len(relationship_rows),
                    "icd10_map_count": len(icd_map_rows),
                    "association_count": len(association_rows),
                },
                promoted_step_name="promoted_snomed",
                job_progress_after=7,
                job_progress_total=total,
            )
            progress = 7

        await _clear_stage_rows(
            pool,
            job_id=job["job_id"],
            table_names=(
                "admin.stage_snomed_associations",
                "admin.stage_snomed_icd10_map",
                "admin.stage_snomed_relationships",
                "admin.stage_snomed_descriptions",
                "admin.stage_snomed_concepts",
            ),
        )
        await record_job_step(
            pool,
            job_id=job["job_id"],
            step_key="cleanup_staging",
            status="success",
            progress_current=1,
            progress_total=1,
            checkpoint={"phase": "cleaned"},
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
                "job_type": "snomed_import",
                "source_manifest": manifest,
                "concept_count": len(concept_rows),
                "description_count": len(description_rows),
                "relationship_count": len(relationship_rows),
                "icd10_map_count": len(icd_map_rows),
            },
        )


async def _run_rxnorm_import_job(
    pool: PoolLike,
    *,
    worker_name: str,
    job: dict[str, Any],
    minio_service: MinioService | None,
) -> None:
    """Concept-only RxNorm import (RXNCONSO.RRF → rxnorm.concepts).

    Staged like the other heavy imports (validate → stage → promote → cleanup)
    so it is checkpoint-resumable. No relationships are loaded — the data exists
    solely to expand IG ValueSet TTY filters in the admin preview.
    """
    manifest = _job_source_manifest(job)
    total = 4
    progress = max(int(job.get("progress_current") or 0), 0)
    await append_job_log(
        pool,
        job_id=job["job_id"],
        level="info",
        message="Starting RxNorm staged import",
        payload={"source_manifest": manifest},
    )
    async with _materialize_bound_sources(
        manifest, minio_service=minio_service
    ) as paths:
        concept_rows = load_rxnorm_concepts(paths["rxnorm_full"])

        if progress < 1:
            await _run_validate_step(
                pool,
                job_id=job["job_id"],
                step_key="validate_sources",
                current_step="validated_sources",
                checkpoint={
                    "phase": "validated",
                    "source_roles": sorted(paths.keys()),
                    "concept_count": len(concept_rows),
                },
                job_progress_after=1,
                job_progress_total=total,
            )
            progress = 1
            if await _apply_control_checkpoint(
                pool,
                job_id=job["job_id"],
                worker_name=worker_name,
            ):
                return

        if progress < 2:
            interrupted = await _stage_rows(
                pool,
                job_id=job["job_id"],
                worker_name=worker_name,
                step_key="stage_concepts",
                running_step_name="staging_rxnorm_concepts",
                rows=concept_rows,
                insert_sql="""
                    INSERT INTO admin.stage_rxnorm_concepts (
                        job_id, rxcui, name, tty, suppress
                    )
                    VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT (job_id, rxcui) DO UPDATE SET
                        name = EXCLUDED.name,
                        tty = EXCLUDED.tty,
                        suppress = EXCLUDED.suppress
                """,
                batch_size=5000,
                job_progress_before=1,
                job_progress_after=2,
                job_progress_total=total,
                checkpoint_label="staging_rxnorm_concepts",
            )
            if interrupted:
                return
            progress = 2

        if progress < 3:
            if await _checkpoint_before_promote(
                pool,
                job_id=job["job_id"],
                worker_name=worker_name,
                step_key="promote",
                job_progress_before=2,
                job_progress_total=total,
            ):
                return
            await _optimized_promote(
                pool,
                job_id=job["job_id"],
                step_key="promote",
                index_tables=["rxnorm.concepts"],
                truncate_sql="TRUNCATE rxnorm.concepts",
                copies=[
                    (
                        """
                        INSERT INTO rxnorm.concepts (rxcui, name, tty, suppress)
                        SELECT rxcui, name, tty, suppress
                        FROM admin.stage_rxnorm_concepts
                        WHERE job_id = $1::uuid
                        """,
                        (job["job_id"],),
                        f"concepts ({len(concept_rows):,})",
                    ),
                ],
                final_checkpoint={
                    "phase": "promoted",
                    "concept_count": len(concept_rows),
                },
                promoted_step_name="promoted_rxnorm",
                job_progress_after=3,
                job_progress_total=total,
            )
            progress = 3

        await _clear_stage_rows(
            pool,
            job_id=job["job_id"],
            table_names=("admin.stage_rxnorm_concepts",),
        )
        await record_job_step(
            pool,
            job_id=job["job_id"],
            step_key="cleanup_staging",
            status="success",
            progress_current=1,
            progress_total=1,
            checkpoint={"phase": "cleaned"},
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
                "job_type": "rxnorm_import",
                "source_manifest": manifest,
                "concept_count": len(concept_rows),
            },
        )


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


async def _run_guideline_seed_job(
    pool: PoolLike,
    *,
    worker_name: str,
    job: dict[str, Any],
) -> None:
    _ensure_repo_root_on_path()
    from loader.main import load_guideline

    total = 2
    start_at = max(int(job.get("progress_current") or 0), 0)
    before_count = await _count_table_rows(pool, "guideline.disease_guidelines")

    if start_at < 1:
        await append_job_log(
            pool,
            job_id=job["job_id"],
            level="info",
            message="Preparing guideline seed job",
            payload={"checkpoint": 1, "total": total},
        )
        await record_job_step(
            pool,
            job_id=job["job_id"],
            step_key="prepare",
            status="success",
            progress_current=1,
            progress_total=total,
            checkpoint={"phase": "prepared"},
        )
        await mark_job_status(
            pool,
            job_id=job["job_id"],
            status="running",
            current_step="prepared",
            progress_current=1,
            progress_total=total,
        )
        if await _apply_control_checkpoint(
            pool,
            job_id=job["job_id"],
            worker_name=worker_name,
        ):
            return

    await append_job_log(
        pool,
        job_id=job["job_id"],
        level="info",
        message="Running guideline seed loader",
        payload={"resumed": start_at > 0},
    )
    await record_job_step(
        pool,
        job_id=job["job_id"],
        step_key="seed",
        status="running",
        progress_current=1,
        progress_total=total,
        checkpoint={"phase": "seeding"},
    )
    await mark_job_status(
        pool,
        job_id=job["job_id"],
        status="running",
        current_step="seeding",
        progress_current=1,
        progress_total=total,
    )
    await load_guideline(pool)
    after_count = await _count_table_rows(pool, "guideline.disease_guidelines")
    await record_job_step(
        pool,
        job_id=job["job_id"],
        step_key="seed",
        status="success",
        progress_current=2,
        progress_total=total,
        checkpoint={"phase": "seeded", "row_count": after_count},
    )
    await mark_job_status(
        pool,
        job_id=job["job_id"],
        status="success",
        current_step="completed",
        progress_current=2,
        progress_total=total,
        control_state="idle",
        result_summary={
            "job_type": "guideline_seed",
            "row_count_before": before_count,
            "row_count_after": after_count,
            "seeded": after_count > before_count,
        },
    )


async def _run_health_supplements_sync_job(
    pool: PoolLike,
    *,
    worker_name: str,
    job: dict[str, Any],
) -> None:
    _ensure_repo_root_on_path()
    from loader.main import load_health_supplements

    total = 3
    start_at = max(int(job.get("progress_current") or 0), 0)
    row_count = 0

    if start_at < 1:
        await append_job_log(
            pool,
            job_id=job["job_id"],
            level="info",
            message="Preparing health supplements sync job",
            payload={"checkpoint": 1, "total": total},
        )
        await record_job_step(
            pool,
            job_id=job["job_id"],
            step_key="prepare",
            status="success",
            progress_current=1,
            progress_total=total,
            checkpoint={"phase": "prepared"},
        )
        await mark_job_status(
            pool,
            job_id=job["job_id"],
            status="running",
            current_step="prepared",
            progress_current=1,
            progress_total=total,
        )
        if await _apply_control_checkpoint(
            pool,
            job_id=job["job_id"],
            worker_name=worker_name,
        ):
            return

    if start_at < 2:
        await append_job_log(
            pool,
            job_id=job["job_id"],
            level="info",
            message="Syncing Taiwan FDA health supplements module",
            payload={"resumed": start_at > 0},
        )
        await record_job_step(
            pool,
            job_id=job["job_id"],
            step_key="sync",
            status="running",
            progress_current=1,
            progress_total=total,
            checkpoint={"phase": "syncing"},
        )
        await mark_job_status(
            pool,
            job_id=job["job_id"],
            status="running",
            current_step="syncing_health_supplements",
            progress_current=1,
            progress_total=total,
        )
        await load_health_supplements(pool)
        row_count = await _count_table_rows(pool, "health_supplements.items")
        await record_job_step(
            pool,
            job_id=job["job_id"],
            step_key="sync",
            status="success",
            progress_current=2,
            progress_total=total,
            checkpoint={"phase": "synced", "row_count": row_count},
        )
        await mark_job_status(
            pool,
            job_id=job["job_id"],
            status="running",
            current_step="finalizing_health_supplements",
            progress_current=2,
            progress_total=total,
        )
        if await _apply_control_checkpoint(
            pool,
            job_id=job["job_id"],
            worker_name=worker_name,
        ):
            return
    else:
        row_count = await _count_table_rows(pool, "health_supplements.items")

    await record_job_step(
        pool,
        job_id=job["job_id"],
        step_key="finalize",
        status="success",
        progress_current=3,
        progress_total=total,
        checkpoint={"phase": "completed", "row_count": row_count},
    )
    await mark_job_status(
        pool,
        job_id=job["job_id"],
        status="success",
        current_step="completed",
        progress_current=3,
        progress_total=total,
        control_state="idle",
        result_summary={"job_type": "health_supplements_sync", "row_count": row_count},
    )


async def _run_food_nutrition_sync_job(
    pool: PoolLike,
    *,
    worker_name: str,
    job: dict[str, Any],
) -> None:
    _ensure_repo_root_on_path()
    from loader.main import load_food_nutrition

    total = 3
    start_at = max(int(job.get("progress_current") or 0), 0)
    measurement_count = 0
    ingredient_count = 0

    if start_at < 1:
        await append_job_log(
            pool,
            job_id=job["job_id"],
            level="info",
            message="Preparing food nutrition sync job",
            payload={"checkpoint": 1, "total": total},
        )
        await record_job_step(
            pool,
            job_id=job["job_id"],
            step_key="prepare",
            status="success",
            progress_current=1,
            progress_total=total,
            checkpoint={"phase": "prepared"},
        )
        await mark_job_status(
            pool,
            job_id=job["job_id"],
            status="running",
            current_step="prepared",
            progress_current=1,
            progress_total=total,
        )
        if await _apply_control_checkpoint(
            pool,
            job_id=job["job_id"],
            worker_name=worker_name,
        ):
            return

    if start_at < 2:
        await append_job_log(
            pool,
            job_id=job["job_id"],
            level="info",
            message="Syncing Taiwan FDA food nutrition modules",
            payload={"resumed": start_at > 0},
        )
        await record_job_step(
            pool,
            job_id=job["job_id"],
            step_key="sync",
            status="running",
            progress_current=1,
            progress_total=total,
            checkpoint={"phase": "syncing"},
        )
        await mark_job_status(
            pool,
            job_id=job["job_id"],
            status="running",
            current_step="syncing_food_nutrition",
            progress_current=1,
            progress_total=total,
        )
        await load_food_nutrition(pool)
        measurement_count = await _count_table_rows(pool, "food_nutrition.measurements")
        ingredient_count = await _count_table_rows(pool, "food_nutrition.ingredients")
        await record_job_step(
            pool,
            job_id=job["job_id"],
            step_key="sync",
            status="success",
            progress_current=2,
            progress_total=total,
            checkpoint={
                "phase": "synced",
                "measurement_count": measurement_count,
                "ingredient_count": ingredient_count,
            },
        )
        await mark_job_status(
            pool,
            job_id=job["job_id"],
            status="running",
            current_step="finalizing_food_nutrition",
            progress_current=2,
            progress_total=total,
        )
        if await _apply_control_checkpoint(
            pool,
            job_id=job["job_id"],
            worker_name=worker_name,
        ):
            return
    else:
        measurement_count = await _count_table_rows(pool, "food_nutrition.measurements")
        ingredient_count = await _count_table_rows(pool, "food_nutrition.ingredients")

    await record_job_step(
        pool,
        job_id=job["job_id"],
        step_key="finalize",
        status="success",
        progress_current=3,
        progress_total=total,
        checkpoint={
            "phase": "completed",
            "measurement_count": measurement_count,
            "ingredient_count": ingredient_count,
        },
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
            "job_type": "food_nutrition_sync",
            "measurement_count": measurement_count,
            "ingredient_count": ingredient_count,
        },
    )


async def _run_embed_job(
    pool: PoolLike,
    *,
    worker_name: str,
    job: dict[str, Any],
    module_label: str,
    source_count_query: str,
    embedded_count_query: str,
    embed_fn_name: str,
) -> None:
    """Generic embedding job runner.

    Imports the named function from embedding_loader and runs it.
    Progress (current/total) tracks individual items embedded, not steps,
    so the progress bar is meaningful during long runs.
    """
    _ensure_repo_root_on_path()
    import asyncio as _asyncio
    import os as _os

    import httpx as _httpx

    from loader.loaders.embedding_loader import (
        embed_food_nutrition,
        embed_guideline,
        embed_health_supplements,
        embed_icd,
        embed_loinc,
        embed_snomed,
        ensure_dimensions,
    )

    _fn_map = {
        "embed_icd": embed_icd,
        "embed_loinc": embed_loinc,
        "embed_health_supplements": embed_health_supplements,
        "embed_food_nutrition": embed_food_nutrition,
        "embed_guideline": embed_guideline,
        "embed_snomed": embed_snomed,
    }
    embed_fn = _fn_map[embed_fn_name]

    # Load embedding settings from DB and apply to the loader's module globals so
    # batch embedding uses the current DB-configured endpoint/model (no restart).
    # Embed jobs share a single resource, so configuring globals never races.
    import admin_settings as _admin_settings
    from loader.loaders import embedding_loader as _embedding_loader

    _emb_cfg = await _admin_settings.get_group(pool, "embedding")
    _embedding_loader.configure(_emb_cfg)
    ollama_url = str(_emb_cfg.get("base_url", "") or "").strip()
    # Use current_step to gate phase resumption (progress_current tracks items, not steps)
    step_at_start = job.get("current_step", "")

    # Step 1: validate — skip if we already passed this phase
    if step_at_start not in ("validated", "embedding", "embedded", "completed"):
        await append_job_log(
            pool,
            job_id=job["job_id"],
            level="info",
            message=f"Validating {module_label} embedding job",
            payload={"ollama_configured": bool(ollama_url)},
        )
        if not ollama_url:
            await mark_job_status(
                pool,
                job_id=job["job_id"],
                status="permanent_failed",
                current_step="validate",
                control_state="idle",
                last_error_code="ollama_not_configured",
                last_error_message="OLLAMA_BASE_URL is not set — cannot generate embeddings",
            )
            return

        # Verify Ollama is actually reachable before committing to the job
        _ollama_ok = False
        try:
            async with _httpx.AsyncClient(timeout=5.0) as _hc:
                _r = await _hc.get(f"{ollama_url.rstrip('/')}/api/version")
                _ollama_ok = _r.status_code == 200
        except Exception:
            pass
        if not _ollama_ok:
            await mark_job_status(
                pool,
                job_id=job["job_id"],
                status="retryable_failed",
                current_step="validate",
                control_state="idle",
                last_error_code="ollama_unreachable",
                last_error_message=f"Ollama not reachable at {ollama_url} — check OLLAMA_BASE_URL",
            )
            return

        async with pool.acquire() as _conn:
            source_count = int(await _conn.fetchval(source_count_query) or 0)
        if source_count <= 0:
            await append_job_log(
                pool,
                job_id=job["job_id"],
                level="warn",
                message=f"{module_label} has no source rows to embed",
            )
            await mark_job_status(
                pool,
                job_id=job["job_id"],
                status="permanent_failed",
                current_step="validate",
                control_state="idle",
                progress_current=0,
                progress_total=0,
                last_error_code="empty_source_module",
                last_error_message=f"{module_label} has no loaded records. Import, sync, or seed the module before embedding.",
            )
            return
        await record_job_step(
            pool,
            job_id=job["job_id"],
            step_key="validate",
            status="success",
            progress_current=1,
            progress_total=1,
            checkpoint={"phase": "validated", "source_count": source_count},
        )
        await mark_job_status(
            pool,
            job_id=job["job_id"],
            status="running",
            current_step="validated",
            progress_current=0,
            progress_total=source_count,
        )
        if await _apply_control_checkpoint(
            pool,
            job_id=job["job_id"],
            worker_name=worker_name,
        ):
            return

    # Step 2: ensure dimensions + embed
    async with pool.acquire() as _conn:
        source_count = int(await _conn.fetchval(source_count_query) or 0)

    await append_job_log(
        pool,
        job_id=job["job_id"],
        level="info",
        message=f"Generating {module_label} embeddings via Ollama ({source_count:,} items)",
        payload={"resumed": bool(step_at_start), "source_count": source_count},
    )
    await record_job_step(
        pool,
        job_id=job["job_id"],
        step_key="embed",
        status="running",
        progress_current=0,
        progress_total=source_count,
        checkpoint={"phase": "embedding"},
    )
    await mark_job_status(
        pool,
        job_id=job["job_id"],
        status="running",
        current_step="embedding",
        progress_current=0,
        progress_total=source_count,
    )

    # Background task: poll embedding table count every 5 s and push live progress
    _stop_poll = _asyncio.Event()

    async def _poll_embed_progress() -> None:
        while True:
            try:
                await _asyncio.wait_for(_stop_poll.wait(), timeout=5.0)
                break
            except _asyncio.TimeoutError:
                pass
            try:
                async with pool.acquire() as _pc:
                    cnt = int(await _pc.fetchval(embedded_count_query) or 0)
                await record_job_step(
                    pool,
                    job_id=job["job_id"],
                    step_key="embed",
                    status="running",
                    progress_current=cnt,
                    progress_total=source_count,
                    checkpoint={"phase": "embedding", "embedded_count": cnt},
                )
                await mark_job_status(
                    pool,
                    job_id=job["job_id"],
                    status="running",
                    current_step="embedding",
                    progress_current=cnt,
                    progress_total=source_count,
                )
            except Exception:
                pass

    _poll_task = _asyncio.create_task(_poll_embed_progress())
    try:
        await ensure_dimensions(pool)
        await embed_fn(pool)
    finally:
        _stop_poll.set()
        try:
            await _asyncio.wait_for(_poll_task, timeout=10.0)
        except Exception:
            pass

    async with pool.acquire() as _conn:
        embedded_count = int(await _conn.fetchval(embedded_count_query) or 0)

    # Fail the job if nothing was actually embedded (silent Ollama failure)
    if embedded_count == 0 and source_count > 0:
        await append_job_log(
            pool,
            job_id=job["job_id"],
            level="warn",
            message="No embeddings created — Ollama may have been unreachable during embedding",
        )
        await mark_job_status(
            pool,
            job_id=job["job_id"],
            status="retryable_failed",
            current_step="embed",
            control_state="idle",
            last_error_code="zero_embeddings",
            last_error_message="No embeddings were created — Ollama returned no vectors",
        )
        return

    await record_job_step(
        pool,
        job_id=job["job_id"],
        step_key="embed",
        status="success",
        progress_current=embedded_count,
        progress_total=source_count,
        checkpoint={"phase": "embedded", "embedded_count": embedded_count},
    )
    if await _apply_control_checkpoint(
        pool,
        job_id=job["job_id"],
        worker_name=worker_name,
    ):
        return

    # Step 3: finalize
    await record_job_step(
        pool,
        job_id=job["job_id"],
        step_key="finalize",
        status="success",
        progress_current=embedded_count,
        progress_total=source_count,
        checkpoint={"phase": "completed", "embedded_count": embedded_count},
    )
    await mark_job_status(
        pool,
        job_id=job["job_id"],
        status="success",
        current_step="completed",
        progress_current=embedded_count,
        progress_total=source_count,
        control_state="idle",
        result_summary={
            "job_type": job["job_type"],
            "module": module_label,
            "embedded_count": embedded_count,
            "source_count": source_count,
        },
    )


async def _run_icd_embed_job(
    pool: PoolLike, *, worker_name: str, job: dict[str, Any]
) -> None:
    await _run_embed_job(
        pool,
        worker_name=worker_name,
        job=job,
        module_label="ICD-10-CM",
        source_count_query="SELECT COUNT(*) FROM icd.diagnoses",
        embedded_count_query="SELECT COUNT(*) FROM icd.diagnosis_embeddings",
        embed_fn_name="embed_icd",
    )


async def _run_loinc_embed_job(
    pool: PoolLike, *, worker_name: str, job: dict[str, Any]
) -> None:
    await _run_embed_job(
        pool,
        worker_name=worker_name,
        job=job,
        module_label="LOINC",
        source_count_query="SELECT COUNT(*) FROM loinc.concepts",
        embedded_count_query="SELECT COUNT(*) FROM loinc.concept_embeddings",
        embed_fn_name="embed_loinc",
    )


async def _run_health_supplements_embed_job(
    pool: PoolLike, *, worker_name: str, job: dict[str, Any]
) -> None:
    await _run_embed_job(
        pool,
        worker_name=worker_name,
        job=job,
        module_label="Health Supplements",
        source_count_query="SELECT COUNT(*) FROM health_supplements.items",
        embedded_count_query="SELECT COUNT(*) FROM health_supplements.item_embeddings",
        embed_fn_name="embed_health_supplements",
    )


async def _run_food_nutrition_embed_job(
    pool: PoolLike, *, worker_name: str, job: dict[str, Any]
) -> None:
    await _run_embed_job(
        pool,
        worker_name=worker_name,
        job=job,
        module_label="Food Nutrition",
        source_count_query=(
            "SELECT (SELECT COUNT(DISTINCT sample_name) FROM food_nutrition.measurements)"
            " + (SELECT COUNT(*) FROM food_nutrition.ingredients)"
        ),
        embedded_count_query=(
            "SELECT (SELECT COUNT(*) FROM food_nutrition.food_embeddings)"
            " + (SELECT COUNT(*) FROM food_nutrition.ingredient_embeddings)"
        ),
        embed_fn_name="embed_food_nutrition",
    )


async def _run_guideline_embed_job(
    pool: PoolLike, *, worker_name: str, job: dict[str, Any]
) -> None:
    await _run_embed_job(
        pool,
        worker_name=worker_name,
        job=job,
        module_label="Clinical Guidelines",
        source_count_query="SELECT COUNT(*) FROM guideline.disease_guidelines",
        embedded_count_query="SELECT COUNT(*) FROM guideline.guideline_embeddings",
        embed_fn_name="embed_guideline",
    )


async def _run_snomed_embed_job(
    pool: PoolLike, *, worker_name: str, job: dict[str, Any]
) -> None:
    await _run_embed_job(
        pool,
        worker_name=worker_name,
        job=job,
        module_label="SNOMED CT",
        source_count_query=(
            "SELECT COUNT(DISTINCT concept_id) FROM snomed.descriptions"
            " WHERE active = TRUE AND type_id = 900000000000003001"
        ),
        embedded_count_query="SELECT COUNT(*) FROM snomed.concept_embeddings",
        embed_fn_name="embed_snomed",
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
    if job["job_type"] == "guideline_seed":
        await _run_guideline_seed_job(pool, worker_name=worker_name, job=job)
        return
    if job["job_type"] == "health_supplements_sync":
        await _run_health_supplements_sync_job(pool, worker_name=worker_name, job=job)
        return
    if job["job_type"] == "food_nutrition_sync":
        await _run_food_nutrition_sync_job(pool, worker_name=worker_name, job=job)
        return
    if job["job_type"] == "icd_import":
        await _run_icd_import_job(
            pool,
            worker_name=worker_name,
            job=job,
            minio_service=minio_service,
        )
        return
    if job["job_type"] == "loinc_import":
        await _run_loinc_import_job(
            pool,
            worker_name=worker_name,
            job=job,
            minio_service=minio_service,
        )
        return
    if job["job_type"] == "ig_import":
        await _run_ig_import_job(
            pool,
            worker_name=worker_name,
            job=job,
            minio_service=minio_service,
        )
        return
    if job["job_type"] == "snomed_import":
        await _run_snomed_import_job(
            pool,
            worker_name=worker_name,
            job=job,
            minio_service=minio_service,
        )
        return
    if job["job_type"] == "rxnorm_import":
        await _run_rxnorm_import_job(
            pool,
            worker_name=worker_name,
            job=job,
            minio_service=minio_service,
        )
        return
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
    if job["job_type"] == "icd_embed":
        await _run_icd_embed_job(pool, worker_name=worker_name, job=job)
        return
    if job["job_type"] == "loinc_embed":
        await _run_loinc_embed_job(pool, worker_name=worker_name, job=job)
        return
    if job["job_type"] == "health_supplements_embed":
        await _run_health_supplements_embed_job(pool, worker_name=worker_name, job=job)
        return
    if job["job_type"] == "food_nutrition_embed":
        await _run_food_nutrition_embed_job(pool, worker_name=worker_name, job=job)
        return
    if job["job_type"] == "guideline_embed":
        await _run_guideline_embed_job(pool, worker_name=worker_name, job=job)
        return
    if job["job_type"] == "snomed_embed":
        await _run_snomed_embed_job(pool, worker_name=worker_name, job=job)
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
