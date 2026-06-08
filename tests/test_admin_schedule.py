"""
Tests for admin_schedule: compute_next_run() correctness and fire_schedule() behaviour.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from admin_schedule import (
    ScheduleConfig,
    compute_next_run,
    fire_schedule,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _sched(**kwargs) -> ScheduleConfig:
    defaults = dict(
        schedule_id="sched-00000000-0000-0000-0000-000000000001",
        module_key="health_supplements",
        source_role=None,
        fetch_url="https://data.fda.gov.tw/data/opendata/export/19/json",
        frequency="weekly",
        day_of_week=0,   # Monday
        day_of_month=None,
        hour_utc=2,
        minute_utc=30,
        is_enabled=True,
        last_run_at=None,
        next_run_at=None,
        last_run_status=None,
        last_run_job_id=None,
        last_error=None,
        created_by="system",
        created_at="2026-01-01T00:00:00+00:00",
        updated_at="2026-01-01T00:00:00+00:00",
    )
    defaults.update(kwargs)
    return ScheduleConfig(**defaults)


def _utc(year, month, day, hour=0, minute=0, second=0) -> datetime:
    return datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# compute_next_run — daily
# ---------------------------------------------------------------------------

def test_compute_next_run_daily_before_scheduled_time():
    """Today's slot hasn't fired yet → today at hour:minute."""
    now = _utc(2026, 6, 15, 1, 0)  # 01:00 UTC, slot is 02:00
    result = compute_next_run("daily", None, None, hour_utc=2, minute_utc=0, now=now)
    assert result == _utc(2026, 6, 15, 2, 0)


def test_compute_next_run_daily_after_scheduled_time():
    """Today's slot already passed → tomorrow at hour:minute."""
    now = _utc(2026, 6, 15, 3, 0)  # 03:00 UTC, slot is 02:00
    result = compute_next_run("daily", None, None, hour_utc=2, minute_utc=0, now=now)
    assert result == _utc(2026, 6, 16, 2, 0)


def test_compute_next_run_daily_exactly_at_time():
    """now == scheduled time (edge): must advance to tomorrow."""
    now = _utc(2026, 6, 15, 2, 0)  # exactly at slot
    result = compute_next_run("daily", None, None, hour_utc=2, minute_utc=0, now=now)
    assert result == _utc(2026, 6, 16, 2, 0)


def test_compute_next_run_daily_with_minute():
    """Minute component preserved correctly."""
    now = _utc(2026, 6, 15, 2, 29)
    result = compute_next_run("daily", None, None, hour_utc=2, minute_utc=30, now=now)
    assert result == _utc(2026, 6, 15, 2, 30)


# ---------------------------------------------------------------------------
# compute_next_run — weekly
# ---------------------------------------------------------------------------

def test_compute_next_run_weekly_earlier_today():
    """Same weekday, slot time not yet reached → today."""
    now = _utc(2026, 6, 15, 1, 0)  # Monday 01:00
    assert now.weekday() == 0       # confirm it's Monday
    result = compute_next_run("weekly", 0, None, hour_utc=2, minute_utc=30, now=now)
    assert result == _utc(2026, 6, 15, 2, 30)


def test_compute_next_run_weekly_already_passed_today():
    """Same weekday, slot already passed → next week."""
    now = _utc(2026, 6, 15, 14, 0)  # Monday 14:00
    assert now.weekday() == 0
    result = compute_next_run("weekly", 0, None, hour_utc=2, minute_utc=30, now=now)
    assert result == _utc(2026, 6, 22, 2, 30)


def test_compute_next_run_weekly_different_day_ahead():
    """Target day is later this week → advance to that day."""
    now = _utc(2026, 6, 15, 12, 0)  # Monday
    result = compute_next_run("weekly", 3, None, hour_utc=2, minute_utc=0, now=now)
    # Thursday is weekday 3; 2026-06-18 is Thursday
    assert result == _utc(2026, 6, 18, 2, 0)
    assert result.weekday() == 3


def test_compute_next_run_weekly_different_day_behind():
    """Target day already passed this week → advance to next week."""
    now = _utc(2026, 6, 19, 12, 0)  # Friday (weekday 4)
    result = compute_next_run("weekly", 0, None, hour_utc=2, minute_utc=30, now=now)
    # Next Monday = 2026-06-22
    assert result == _utc(2026, 6, 22, 2, 30)
    assert result.weekday() == 0


def test_compute_next_run_weekly_sunday_to_monday():
    """Sunday → next occurrence is Monday (next day)."""
    now = _utc(2026, 6, 21, 12, 0)  # Sunday (weekday 6)
    result = compute_next_run("weekly", 0, None, hour_utc=2, minute_utc=0, now=now)
    assert result == _utc(2026, 6, 22, 2, 0)  # Monday
    assert result.weekday() == 0


# ---------------------------------------------------------------------------
# compute_next_run — monthly
# ---------------------------------------------------------------------------

def test_compute_next_run_monthly_day_ahead_this_month():
    """Target day hasn't arrived yet this month → this month."""
    now = _utc(2026, 6, 10, 12, 0)
    result = compute_next_run("monthly", None, 15, hour_utc=2, minute_utc=0, now=now)
    assert result == _utc(2026, 6, 15, 2, 0)


def test_compute_next_run_monthly_day_passed_this_month():
    """Target day already passed this month → next month."""
    now = _utc(2026, 6, 16, 12, 0)
    result = compute_next_run("monthly", None, 15, hour_utc=2, minute_utc=0, now=now)
    assert result == _utc(2026, 7, 15, 2, 0)


def test_compute_next_run_monthly_december_wraps_to_january():
    """December → next occurrence is January of next year."""
    now = _utc(2026, 12, 20, 12, 0)
    result = compute_next_run("monthly", None, 15, hour_utc=2, minute_utc=0, now=now)
    assert result == _utc(2027, 1, 15, 2, 0)


def test_compute_next_run_monthly_clamps_day_to_28():
    """day_of_month > 28 is clamped to 28 (safe max for all months)."""
    now = _utc(2026, 2, 1, 0, 0)
    result = compute_next_run("monthly", None, 31, hour_utc=0, minute_utc=0, now=now)
    assert result.day == 28
    assert result.month == 2


def test_compute_next_run_unknown_frequency_raises():
    with pytest.raises(ValueError, match="Unknown frequency"):
        compute_next_run("yearly", None, None, hour_utc=0, minute_utc=0)


# ---------------------------------------------------------------------------
# ScheduleConfig.to_dict round-trip
# ---------------------------------------------------------------------------

def test_schedule_config_to_dict_completeness():
    sched = _sched()
    d = sched.to_dict()
    required_keys = {
        "schedule_id", "module_key", "source_role", "fetch_url",
        "frequency", "day_of_week", "day_of_month",
        "hour_utc", "minute_utc", "is_enabled",
        "last_run_at", "next_run_at", "last_run_status",
        "last_run_job_id", "last_error", "created_by", "created_at", "updated_at",
    }
    assert required_keys.issubset(set(d.keys()))
    assert d["module_key"] == "health_supplements"
    assert d["frequency"] == "weekly"
    assert d["hour_utc"] == 2
    assert d["minute_utc"] == 30
    assert d["is_enabled"] is True


# ---------------------------------------------------------------------------
# fire_schedule — api-sync path (health_supplements / food_nutrition)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_fire_schedule_api_sync_creates_sync_job():
    """fire_schedule for an api-sync module queues a sync job, no download."""
    sched = _sched(module_key="health_supplements")
    mock_pool = MagicMock()

    with (
        patch("admin_schedule._create_job", new_callable=AsyncMock) as mock_create,
        patch("admin_schedule.mark_schedule_run", new_callable=AsyncMock) as mock_mark,
    ):
        mock_create.return_value = {
            "job_id": "job-health-supplements-1",
            "job_type": "health_supplements_sync",
            "status": "queued",
        }
        mock_mark.return_value = None

        result = await fire_schedule(
            mock_pool,
            schedule=sched,
            minio_service=None,
            triggered_by="scheduler",
        )

    assert result["status"] == "success"
    assert result["job_id"] == "job-health-supplements-1"
    assert result["error"] is None

    mock_create.assert_called_once_with(
        mock_pool,
        module_key="health_supplements",
        job_type="health_supplements_sync",
        requested_by="scheduler",
        job_options={"source": "scheduler"},
    )
    mock_mark.assert_called_once()
    # mark_schedule_run should record success
    call_kwargs = mock_mark.call_args.kwargs
    assert call_kwargs["status"] == "success"
    assert call_kwargs["job_id"] == "job-health-supplements-1"


@pytest.mark.asyncio
async def test_fire_schedule_api_sync_food_nutrition():
    """food_nutrition api-sync fires food_nutrition_sync job."""
    sched = _sched(module_key="food_nutrition",
                   fetch_url="https://data.fda.gov.tw/data/opendata/export/20/json")
    mock_pool = MagicMock()

    with (
        patch("admin_schedule._create_job", new_callable=AsyncMock) as mock_create,
        patch("admin_schedule.mark_schedule_run", new_callable=AsyncMock),
    ):
        mock_create.return_value = {"job_id": "job-fn-1", "status": "queued"}

        result = await fire_schedule(
            mock_pool, schedule=sched, minio_service=None, triggered_by="scheduler"
        )

    assert result["status"] == "success"
    create_call_kwargs = mock_create.call_args.kwargs
    assert create_call_kwargs["job_type"] == "food_nutrition_sync"
    assert create_call_kwargs["module_key"] == "food_nutrition"


@pytest.mark.asyncio
async def test_fire_schedule_handles_create_job_exception():
    """If _create_job raises, fire_schedule marks as failed but doesn't re-raise."""
    sched = _sched(module_key="health_supplements")
    mock_pool = MagicMock()

    with (
        patch("admin_schedule._create_job", new_callable=AsyncMock) as mock_create,
        patch("admin_schedule.mark_schedule_run", new_callable=AsyncMock) as mock_mark,
    ):
        mock_create.side_effect = RuntimeError("DB connection lost")

        result = await fire_schedule(
            mock_pool, schedule=sched, minio_service=None, triggered_by="scheduler"
        )

    assert result["status"] == "failed"
    assert "DB connection lost" in (result["error"] or "")
    assert result["job_id"] is None
    # mark_schedule_run must still be called even on error
    mock_mark.assert_called_once()
    call_kwargs = mock_mark.call_args.kwargs
    assert call_kwargs["status"] == "failed"


@pytest.mark.asyncio
async def test_fire_schedule_url_fetch_without_minio_fails():
    """URL-fetch schedule without MinIO enabled records a failure."""
    sched = _sched(
        module_key="icd",
        source_role="icd10cm",
        fetch_url="https://www.cms.gov/icd10cm.zip",
        frequency="weekly",
        day_of_week=0,
        hour_utc=2,
        minute_utc=0,
    )
    mock_pool = MagicMock()
    mock_minio = MagicMock()
    mock_minio.enabled = False  # MinIO disabled

    with patch("admin_schedule.mark_schedule_run", new_callable=AsyncMock) as mock_mark:
        result = await fire_schedule(
            mock_pool, schedule=sched, minio_service=mock_minio, triggered_by="scheduler"
        )

    assert result["status"] == "failed"
    assert "MinIO" in (result["error"] or "")
    mock_mark.assert_called_once()


@pytest.mark.asyncio
async def test_fire_schedule_url_fetch_https_enforced():
    """Non-HTTPS fetch_url is rejected."""
    sched = _sched(
        module_key="icd",
        source_role="icd10cm",
        fetch_url="http://insecure.example.com/data.zip",  # HTTP, not HTTPS
    )
    mock_pool = MagicMock()
    mock_minio = MagicMock()
    mock_minio.enabled = True

    with patch("admin_schedule.mark_schedule_run", new_callable=AsyncMock) as mock_mark:
        result = await fire_schedule(
            mock_pool, schedule=sched, minio_service=mock_minio, triggered_by="scheduler"
        )

    assert result["status"] == "failed"
    assert "HTTPS" in (result["error"] or "")
    mock_mark.assert_called_once()


# ---------------------------------------------------------------------------
# fire_schedule — URL-fetch happy path (mocked download)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_fire_schedule_url_fetch_downloads_and_creates_job():
    """Full URL-fetch path: download → upload → import job."""
    from admin_schedule import URL_FETCH_MODULES

    sched = _sched(
        module_key="icd",
        source_role="icd10cm",
        fetch_url="https://www.cms.gov/icd10cm.zip",
        frequency="weekly",
        day_of_week=0,
        hour_utc=2,
        minute_utc=0,
    )
    mock_pool = MagicMock()
    mock_minio = MagicMock()
    mock_minio.enabled = True

    dummy_zip = b"PK\x03\x04dummy"  # minimal fake ZIP bytes

    with (
        patch("admin_schedule._download_url", new_callable=AsyncMock) as mock_dl,
        patch("admin_schedule.create_uploaded_source", new_callable=AsyncMock) as mock_upload,
        patch("admin_schedule._create_job", new_callable=AsyncMock) as mock_create,
        patch("admin_schedule.mark_schedule_run", new_callable=AsyncMock) as mock_mark,
    ):
        mock_dl.return_value = (dummy_zip, "icd10cm-table-index-2025.zip")
        mock_upload.return_value = {
            "duplicate": False,
            "uploaded_file": {
                "uploaded_file_id": "file-uuid-1",
                "original_filename": "icd10cm-table-index-2025.zip",
                "sha256": "abc123",
                "is_active": True,
            },
        }
        mock_create.return_value = {
            "job_id": "job-icd-1",
            "job_type": "icd_import",
            "status": "queued",
        }

        result = await fire_schedule(
            mock_pool, schedule=sched, minio_service=mock_minio, triggered_by="scheduler"
        )

    assert result["status"] == "success"
    assert result["job_id"] == "job-icd-1"

    mock_dl.assert_called_once_with("https://www.cms.gov/icd10cm.zip")
    mock_upload.assert_called_once_with(
        mock_pool,
        minio_service=mock_minio,
        module_key="icd",
        source_role="icd10cm",
        original_filename="icd10cm-table-index-2025.zip",
        mime_type="application/octet-stream",
        data=dummy_zip,
        uploaded_by="scheduler",
        auto_activate=False,
    )
    mock_create.assert_called_once()
    create_kwargs = mock_create.call_args.kwargs
    assert create_kwargs["job_type"] == "icd_import"
    assert create_kwargs["module_key"] == "icd"

    mock_mark.assert_called_once()
    mark_kwargs = mock_mark.call_args.kwargs
    assert mark_kwargs["status"] == "success"
    assert mark_kwargs["job_id"] == "job-icd-1"
