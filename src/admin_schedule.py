"""
Admin module schedule module.

Handles cron-style scheduling for automatic module imports:
- URL-fetch modules (icd, ig, drug): download file → upload → import job
- API-sync modules (health_supplements, food_nutrition): create sync job directly

Design
------
Schedules are stored in ``admin.module_schedules`` (one row per module).
``admin_worker`` polls ``list_due_schedules()`` every 60 s and fires overdue
entries via ``fire_schedule()``.  ``compute_next_run()`` calculates the next
wall-clock UTC time for a given recurrence rule.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import asyncpg
import httpx

from admin_jobs import create_job as _create_job
from admin_sources import _ROLE_JOB_TYPE, create_uploaded_source
from database import PoolLike
from minio_service import MinioService
from utils import log_error, log_info, log_warning

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: Modules where the schedule downloads a file from fetch_url, uploads it as
#: a new source version, and then queues the corresponding import job.
URL_FETCH_MODULES: frozenset[str] = frozenset({"icd", "ig", "drug"})

#: Modules where the schedule just creates a sync job (no file download).
API_SYNC_MODULES: frozenset[str] = frozenset({"health_supplements", "food_nutrition"})

#: All modules that accept a schedule.
SCHEDULABLE_MODULES: frozenset[str] = URL_FETCH_MODULES | API_SYNC_MODULES

_API_SYNC_JOB_TYPE: dict[str, str] = {
    "health_supplements": "health_supplements_sync",
    "food_nutrition": "food_nutrition_sync",
}

#: FDA Open Data API URLs (stored for transparency; the worker does not download
#: from these — it calls the Taiwan FDA API internally via the sync job).
_FDA_API_URLS: dict[str, str] = {
    "health_supplements": "https://data.fda.gov.tw/data/opendata/export/19/json",
    "food_nutrition": "https://data.fda.gov.tw/data/opendata/export/20/json",
}

#: Default schedules seeded on first startup for api-sync modules.
_DEFAULT_SCHEDULES: list[dict[str, Any]] = [
    {
        "module_key": "health_supplements",
        "source_role": None,
        "fetch_url": _FDA_API_URLS["health_supplements"],
        "frequency": "weekly",
        "day_of_week": 0,  # Monday
        "day_of_month": None,
        "hour_utc": 2,
        "minute_utc": 30,
        "is_enabled": True,
        "created_by": "system",
    },
    {
        "module_key": "food_nutrition",
        "source_role": None,
        "fetch_url": _FDA_API_URLS["food_nutrition"],
        "frequency": "weekly",
        "day_of_week": 0,  # Monday
        "day_of_month": None,
        "hour_utc": 3,
        "minute_utc": 0,
        "is_enabled": True,
        "created_by": "system",
    },
]


# ---------------------------------------------------------------------------
# Data class
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ScheduleConfig:
    schedule_id: str
    module_key: str
    source_role: str | None
    fetch_url: str | None
    frequency: str  # 'daily' | 'weekly' | 'monthly'
    day_of_week: int | None  # 0=Mon..6=Sun
    day_of_month: int | None  # 1-28
    hour_utc: int
    minute_utc: int
    is_enabled: bool
    last_run_at: str | None
    next_run_at: str | None
    last_run_status: str | None
    last_run_job_id: str | None
    last_error: str | None
    created_by: str
    created_at: str
    updated_at: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "schedule_id": self.schedule_id,
            "module_key": self.module_key,
            "source_role": self.source_role,
            "fetch_url": self.fetch_url,
            "frequency": self.frequency,
            "day_of_week": self.day_of_week,
            "day_of_month": self.day_of_month,
            "hour_utc": self.hour_utc,
            "minute_utc": self.minute_utc,
            "is_enabled": self.is_enabled,
            "last_run_at": self.last_run_at,
            "next_run_at": self.next_run_at,
            "last_run_status": self.last_run_status,
            "last_run_job_id": self.last_run_job_id,
            "last_error": self.last_error,
            "created_by": self.created_by,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _iso(val: Any) -> str | None:
    if val is None:
        return None
    if hasattr(val, "isoformat"):
        return val.isoformat()
    return str(val)


def _row_to_config(row: asyncpg.Record) -> ScheduleConfig:
    return ScheduleConfig(
        schedule_id=str(row["schedule_id"]),
        module_key=row["module_key"],
        source_role=row["source_role"],
        fetch_url=row["fetch_url"],
        frequency=row["frequency"],
        day_of_week=row["day_of_week"],
        day_of_month=row["day_of_month"],
        hour_utc=int(row["hour_utc"]),
        minute_utc=int(row["minute_utc"]),
        is_enabled=bool(row["is_enabled"]),
        last_run_at=_iso(row["last_run_at"]),
        next_run_at=_iso(row["next_run_at"]),
        last_run_status=row.get("last_run_status"),
        last_run_job_id=(
            str(row["last_run_job_id"]) if row.get("last_run_job_id") else None
        ),
        last_error=row.get("last_error"),
        created_by=row["created_by"],
        created_at=_iso(row["created_at"]) or "",
        updated_at=_iso(row["updated_at"]) or "",
    )


# ---------------------------------------------------------------------------
# compute_next_run
# ---------------------------------------------------------------------------


def compute_next_run(
    frequency: str,
    day_of_week: int | None,
    day_of_month: int | None,
    hour_utc: int,
    minute_utc: int,
    now: datetime | None = None,
) -> datetime:
    """Return the next scheduled UTC datetime strictly after *now*.

    Parameters
    ----------
    frequency:
        ``'daily'``, ``'weekly'``, or ``'monthly'``.
    day_of_week:
        Required for ``'weekly'``.  0 = Monday … 6 = Sunday (``datetime.weekday()``).
    day_of_month:
        Required for ``'monthly'``.  Clamped to 1–28 to avoid month-end ambiguity.
    hour_utc / minute_utc:
        Wall-clock time in UTC when the schedule fires.
    now:
        Override for the current time (useful for tests).
    """
    now = (now or datetime.now(timezone.utc)).replace(second=0, microsecond=0)

    def _at(ref: datetime) -> datetime:
        return ref.replace(
            hour=hour_utc,
            minute=minute_utc,
            second=0,
            microsecond=0,
            tzinfo=timezone.utc,
        )

    if frequency == "daily":
        candidate = _at(now)
        if candidate <= now:
            candidate = _at(now + timedelta(days=1))
        return candidate

    if frequency == "weekly":
        dow = int(day_of_week) if day_of_week is not None else 0
        today_dow = now.weekday()
        days_ahead = (dow - today_dow) % 7
        if days_ahead == 0:
            # Same weekday — check if today's slot has already passed
            candidate = _at(now)
            if candidate <= now:
                candidate = _at(now + timedelta(days=7))
        else:
            candidate = _at(now + timedelta(days=days_ahead))
        return candidate

    if frequency == "monthly":
        target_day = max(
            1, min(28, int(day_of_month) if day_of_month is not None else 1)
        )
        # Try this month
        try:
            candidate = _at(now.replace(day=target_day))
        except ValueError:
            candidate = _at(now.replace(day=28))
        if candidate <= now:
            # Roll to next month
            if now.month == 12:
                candidate = candidate.replace(year=now.year + 1, month=1)
            else:
                candidate = candidate.replace(month=now.month + 1)
        return candidate

    raise ValueError(
        f"Unknown frequency: {frequency!r}. Expected 'daily', 'weekly', or 'monthly'."
    )


# ---------------------------------------------------------------------------
# DB CRUD
# ---------------------------------------------------------------------------


async def get_schedule(
    pool: PoolLike,
    module_key: str,
) -> ScheduleConfig | None:
    """Return the schedule for *module_key*, or ``None`` if none exists."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM admin.module_schedules WHERE module_key = $1",
            module_key,
        )
    return _row_to_config(row) if row else None


async def upsert_schedule(
    pool: PoolLike,
    *,
    module_key: str,
    source_role: str | None,
    fetch_url: str | None,
    frequency: str,
    day_of_week: int | None,
    day_of_month: int | None,
    hour_utc: int,
    minute_utc: int,
    is_enabled: bool,
    created_by: str,
) -> ScheduleConfig:
    """Insert or update a schedule row, computing ``next_run_at`` automatically."""
    now = datetime.now(timezone.utc)
    next_run = compute_next_run(
        frequency, day_of_week, day_of_month, hour_utc, minute_utc, now=now
    )
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO admin.module_schedules (
                schedule_id, module_key, source_role, fetch_url,
                frequency, day_of_week, day_of_month,
                hour_utc, minute_utc, is_enabled, next_run_at,
                created_by, created_at, updated_at
            )
            VALUES (
                gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                $11, $12, $12
            )
            ON CONFLICT (module_key) DO UPDATE SET
                source_role  = EXCLUDED.source_role,
                fetch_url    = EXCLUDED.fetch_url,
                frequency    = EXCLUDED.frequency,
                day_of_week  = EXCLUDED.day_of_week,
                day_of_month = EXCLUDED.day_of_month,
                hour_utc     = EXCLUDED.hour_utc,
                minute_utc   = EXCLUDED.minute_utc,
                is_enabled   = EXCLUDED.is_enabled,
                next_run_at  = EXCLUDED.next_run_at,
                updated_at   = EXCLUDED.updated_at
            RETURNING *
            """,
            module_key,
            source_role,
            fetch_url,
            frequency,
            day_of_week,
            day_of_month,
            hour_utc,
            minute_utc,
            is_enabled,
            next_run,
            created_by,
            now,
        )
    return _row_to_config(row)


async def delete_schedule(pool: PoolLike, module_key: str) -> bool:
    """Delete a schedule. Returns ``True`` if a row was deleted."""
    async with pool.acquire() as conn:
        result = await conn.execute(
            "DELETE FROM admin.module_schedules WHERE module_key = $1",
            module_key,
        )
    return result != "DELETE 0"


async def list_due_schedules(pool: PoolLike) -> list[ScheduleConfig]:
    """Return enabled schedules whose ``next_run_at`` is at or before now."""
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT * FROM admin.module_schedules
            WHERE is_enabled = TRUE
              AND next_run_at IS NOT NULL
              AND next_run_at <= NOW()
            ORDER BY next_run_at
            """)
    return [_row_to_config(r) for r in rows]


async def mark_schedule_run(
    pool: PoolLike,
    *,
    schedule_id: str,
    job_id: str | None,
    status: str,
    error: str | None = None,
    frequency: str,
    day_of_week: int | None,
    day_of_month: int | None,
    hour_utc: int,
    minute_utc: int,
) -> None:
    """Record the outcome of a schedule fire and advance ``next_run_at``."""
    now = datetime.now(timezone.utc)
    next_run = compute_next_run(
        frequency, day_of_week, day_of_month, hour_utc, minute_utc, now=now
    )
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE admin.module_schedules
            SET last_run_at     = $2,
                last_run_status = $3,
                last_run_job_id = $4,
                last_error      = $5,
                next_run_at     = $6,
                updated_at      = $2
            WHERE schedule_id = $1
            """,
            uuid.UUID(schedule_id),
            now,
            status,
            uuid.UUID(job_id) if job_id else None,
            error,
            next_run,
        )


# ---------------------------------------------------------------------------
# Migrations / seeding
# ---------------------------------------------------------------------------


async def ensure_schedule_table(pool: PoolLike) -> None:
    """Ensure last_error column exists (added after initial schema release)."""
    async with pool.acquire() as conn:
        await conn.execute(
            "ALTER TABLE admin.module_schedules ADD COLUMN IF NOT EXISTS last_error TEXT"
        )


async def ensure_default_schedules(pool: PoolLike) -> None:
    """Seed or repair default weekly schedules for api-sync modules.

    - Inserts a new row if none exists.
    - Patches ``fetch_url`` if the existing row has ``NULL`` (handles the
      upgrade from Phase C, where defaults were seeded without URLs).

    Replaces what was previously a hardcoded APScheduler timer in each service.
    """
    for defaults in _DEFAULT_SCHEDULES:
        async with pool.acquire() as conn:
            existing = await conn.fetchrow(
                "SELECT fetch_url FROM admin.module_schedules WHERE module_key = $1",
                defaults["module_key"],
            )
        if existing is None:
            # Row doesn't exist yet — insert it
            await upsert_schedule(
                pool,
                module_key=defaults["module_key"],
                source_role=defaults["source_role"],
                fetch_url=defaults["fetch_url"],
                frequency=defaults["frequency"],
                day_of_week=defaults["day_of_week"],
                day_of_month=defaults["day_of_month"],
                hour_utc=defaults["hour_utc"],
                minute_utc=defaults["minute_utc"],
                is_enabled=defaults["is_enabled"],
                created_by=defaults["created_by"],
            )
            log_info(
                "Seeded default schedule",
                module_key=defaults["module_key"],
                frequency=defaults["frequency"],
                hour_utc=defaults["hour_utc"],
                minute_utc=defaults["minute_utc"],
            )
        elif existing["fetch_url"] is None and defaults["fetch_url"]:
            # Row exists but has no FDA URL — patch it (Phase G migration)
            async with pool.acquire() as conn:
                await conn.execute(
                    """
                    UPDATE admin.module_schedules
                    SET fetch_url  = $1,
                        updated_at = NOW()
                    WHERE module_key = $2
                      AND fetch_url IS NULL
                    """,
                    defaults["fetch_url"],
                    defaults["module_key"],
                )
            log_info(
                "Patched fetch_url on existing schedule",
                module_key=defaults["module_key"],
                fetch_url=defaults["fetch_url"],
            )


# ---------------------------------------------------------------------------
# Core fire logic (used by both worker scan and immediate trigger)
# ---------------------------------------------------------------------------


async def _download_url(
    url: str,
    *,
    timeout_seconds: float = 300.0,
) -> tuple[bytes, str]:
    """Download *url* and return ``(data, filename)``.

    Derives the filename from the ``Content-Disposition`` header first,
    then falls back to the last path component of the URL.

    Raises
    ------
    httpx.HTTPStatusError
        On HTTP 4xx / 5xx.
    ValueError
        If the URL is not HTTPS (security guard).
    """
    if not url.lower().startswith("https://"):
        raise ValueError("Schedule fetch_url must use HTTPS to prevent SSRF")

    async with httpx.AsyncClient(
        follow_redirects=True,
        timeout=httpx.Timeout(timeout_seconds),
    ) as client:
        response = await client.get(url)
        response.raise_for_status()

    # Try Content-Disposition for filename
    filename: str | None = None
    cd = response.headers.get("content-disposition", "")
    if "filename=" in cd:
        for part in cd.split(";"):
            part = part.strip()
            if part.lower().startswith("filename="):
                filename = part[9:].strip().strip('"').strip("'")
                break

    if not filename:
        from urllib.parse import urlparse

        path_part = urlparse(url).path
        filename = path_part.rstrip("/").split("/")[-1] or "download"

    return response.content, filename


async def fire_schedule(
    pool: PoolLike,
    *,
    schedule: ScheduleConfig,
    minio_service: MinioService | None,
    triggered_by: str = "scheduler",
) -> dict[str, Any]:
    """Execute the action described by *schedule* and update the DB row.

    Returns a dict with keys ``job_id``, ``status``, ``error``.

    For api-sync modules: creates the sync job directly.
    For URL-fetch modules: downloads the file, uploads it as a new source
    version, then creates the import job.

    This function handles its own ``mark_schedule_run()`` call so callers
    do not need to.
    """
    job_id: str | None = None
    status = "failed"
    error: str | None = None

    try:
        if schedule.module_key in API_SYNC_MODULES:
            # ── API-sync: just queue the sync job ─────────────────────────
            job_type = _API_SYNC_JOB_TYPE[schedule.module_key]
            job = await _create_job(
                pool,
                module_key=schedule.module_key,
                job_type=job_type,
                requested_by=triggered_by,
                job_options={"source": "scheduler"},
            )
            job_id = str(job["job_id"])
            status = "success"
            log_info(
                "Schedule fired api-sync job",
                module_key=schedule.module_key,
                job_type=job_type,
                job_id=job_id,
                triggered_by=triggered_by,
            )

        elif schedule.fetch_url:
            # ── URL-fetch: download → upload → import ─────────────────────
            if minio_service is None or not minio_service.enabled:
                raise RuntimeError(
                    "MinIO is required for schedule URL-fetch but is not available"
                )

            log_info(
                "Schedule downloading URL",
                module_key=schedule.module_key,
                url=schedule.fetch_url,
            )
            data, filename = await _download_url(schedule.fetch_url)
            log_info(
                "Schedule download complete",
                module_key=schedule.module_key,
                downloaded_filename=filename,
                size_bytes=len(data),
            )

            upload_result = await create_uploaded_source(
                pool,
                minio_service=minio_service,
                module_key=schedule.module_key,
                source_role=schedule.source_role or "",
                original_filename=filename,
                mime_type="application/octet-stream",
                data=data,
                uploaded_by=triggered_by,
                auto_activate=False,
            )

            # Create the import job — it resolves the just-uploaded file and
            # activates it on success (see _activate_manifest_sources).
            role_key = (schedule.module_key, schedule.source_role or "")
            job_type = _ROLE_JOB_TYPE.get(role_key)
            if not job_type:
                raise ValueError(
                    f"No job type found for role {role_key!r}. "
                    "Ensure source_role is valid in SOURCE_CATALOG."
                )

            job = await _create_job(
                pool,
                module_key=schedule.module_key,
                job_type=job_type,
                requested_by=triggered_by,
                job_options={
                    "source": "scheduler",
                    "triggered_by": triggered_by,
                    "filename": filename,
                    "is_duplicate": upload_result.get("duplicate", False),
                },
            )
            job_id = str(job["job_id"])
            status = "success"
            log_info(
                "Schedule fired URL-fetch import job",
                module_key=schedule.module_key,
                job_type=job_type,
                job_id=job_id,
                triggered_by=triggered_by,
            )

        else:
            error = (
                f"Schedule for '{schedule.module_key}' has no fetch_url "
                "and is not an api-sync module"
            )
            log_error(
                "Schedule misconfigured", error=error, module_key=schedule.module_key
            )

    except Exception as exc:
        error = str(exc)
        log_error(
            "Schedule fire failed",
            module_key=schedule.module_key,
            error=error,
        )

    await mark_schedule_run(
        pool,
        schedule_id=schedule.schedule_id,
        job_id=job_id,
        status=status,
        error=error,
        frequency=schedule.frequency,
        day_of_week=schedule.day_of_week,
        day_of_month=schedule.day_of_month,
        hour_utc=schedule.hour_utc,
        minute_utc=schedule.minute_utc,
    )

    return {"job_id": job_id, "status": status, "error": error}
