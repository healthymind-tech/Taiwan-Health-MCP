from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from admin_jobs import (
    ADMIN_JOB_TYPES,
    AdminJob,
    DRUG_JOB_TYPES,
    EMBED_JOB_TYPES,
    HEAVY_LOADER_JOB_TYPES,
    PHASE2_JOB_TYPES,
    SIMPLE_LOADER_JOB_TYPES,
    available_job_actions,
    is_heartbeat_stale,
    _job_source_manifest,
)


def test_phase2_job_types_are_explicit():
    assert PHASE2_JOB_TYPES == {"noop"}


def test_admin_job_types_include_simple_loader_jobs():
    assert SIMPLE_LOADER_JOB_TYPES == {
        "guideline_seed",
        "health_supplements_sync",
        "food_nutrition_sync",
    }
    assert HEAVY_LOADER_JOB_TYPES == {
        "icd_import",
        "loinc_import",
        "ig_import",
        "snomed_import",
        "rxnorm_import",
    }
    assert DRUG_JOB_TYPES == {
        "drug_index_import",
        "drug_enrichment",
        "drug_analysis",
    }
    assert ADMIN_JOB_TYPES == (
        PHASE2_JOB_TYPES
        | SIMPLE_LOADER_JOB_TYPES
        | HEAVY_LOADER_JOB_TYPES
        | DRUG_JOB_TYPES
        | EMBED_JOB_TYPES
    )


def test_is_heartbeat_stale_true_when_missing():
    assert (
        is_heartbeat_stale(None, now=datetime.now(timezone.utc), stale_after_seconds=30)
        is True
    )


def test_is_heartbeat_stale_false_when_recent():
    now = datetime.now(timezone.utc)
    recent = now - timedelta(seconds=10)
    assert is_heartbeat_stale(recent, now=now, stale_after_seconds=30) is False


def test_is_heartbeat_stale_true_when_old():
    now = datetime.now(timezone.utc)
    old = now - timedelta(seconds=90)
    assert is_heartbeat_stale(old, now=now, stale_after_seconds=30) is True


def test_available_job_actions_for_running_job():
    assert available_job_actions("running", "idle") == ["pause", "stop", "restart"]


def test_available_job_actions_for_paused_job():
    assert available_job_actions("paused", "paused") == ["resume", "stop", "restart"]


def test_available_job_actions_for_final_job():
    assert available_job_actions("success", "idle") == ["restart"]


def test_admin_job_from_row_decodes_json_string_fields():
    job = AdminJob.from_row(
        {
            "job_id": "00000000-0000-0000-0000-000000000001",
            "module_key": "ig",
            "job_type": "ig_import",
            "requested_by": "admin",
            "status": "queued",
            "control_state": "idle",
            "progress_current": 0,
            "progress_total": 0,
            "current_step": "queued",
            "worker_name": "",
            "created_at": datetime.now(timezone.utc),
            "started_at": None,
            "finished_at": None,
            "last_error_code": "",
            "last_error_message": "",
            "job_options_json": '{"source_manifest": {"primary_uploaded_file_id": "upload-1"}}',
            "result_summary_json": '{"job_type": "ig_import"}',
        }
    )
    assert job.job_options["source_manifest"]["primary_uploaded_file_id"] == "upload-1"
    assert job.result_summary["job_type"] == "ig_import"
    assert _job_source_manifest(job.to_dict())["primary_uploaded_file_id"] == "upload-1"


# ---------------------------------------------------------------------------
# Loader import path — regression for ModuleNotFoundError: 'dataset_config'
# ---------------------------------------------------------------------------


def test_ensure_repo_root_on_path_allows_loader_main_import():
    """loader/main.py and its submodules use bare top-level imports
    (`from dataset_config import ...`, `from loaders.xxx import ...`) that only
    resolve when the loader/ directory is on sys.path. _ensure_repo_root_on_path
    must put it there, otherwise every loader-backed job crashes with
    ModuleNotFoundError before doing any work.
    """
    from admin_jobs import _ensure_repo_root_on_path

    _ensure_repo_root_on_path()

    # These are the exact functions the sync/import jobs import at runtime.
    from loader.main import (  # noqa: F401
        generate_embeddings,
        load_drug_analysis,
        load_drug_enrichment,
        load_drug_index,
        load_food_nutrition,
        load_guideline,
        load_health_supplements,
        load_icd,
        load_loinc,
        load_snomed,
        load_twcore,
    )
    from loader.loaders.embedding_loader import (  # noqa: F401
        embed_food_nutrition,
        embed_guideline,
        embed_health_supplements,
        embed_icd,
        embed_loinc,
        embed_snomed,
        ensure_dimensions,
    )


# ---------------------------------------------------------------------------
# Schedule scan — _scan_and_fire_schedules (admin_worker)
# ---------------------------------------------------------------------------


def _make_schedule(**kwargs):
    """Build a minimal ScheduleConfig for scan tests."""
    from admin_schedule import ScheduleConfig

    defaults = dict(
        schedule_id="00000000-0000-0000-0000-000000000099",
        module_key="health_supplements",
        source_role=None,
        fetch_url="https://data.fda.gov.tw/data/opendata/export/19/json",
        frequency="weekly",
        day_of_week=0,
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


@pytest.mark.asyncio
async def test_scan_fires_due_schedule():
    """When a due schedule has no active previous job, fire_schedule is called."""
    from admin_worker import _scan_and_fire_schedules

    sched = _make_schedule(last_run_job_id=None)
    mock_pool = MagicMock()
    mock_minio = MagicMock()
    mock_minio.enabled = False

    with (
        patch("admin_worker.list_due_schedules", new_callable=AsyncMock) as mock_list,
        patch("admin_worker.fire_schedule", new_callable=AsyncMock) as mock_fire,
    ):
        mock_list.return_value = [sched]
        mock_fire.return_value = {
            "job_id": "job-abc",
            "status": "success",
            "error": None,
        }

        await _scan_and_fire_schedules(
            mock_pool,
            worker_name="test-worker",
            minio_service=mock_minio,
        )

    mock_list.assert_called_once_with(mock_pool)
    mock_fire.assert_called_once_with(
        mock_pool,
        schedule=sched,
        minio_service=mock_minio,
        triggered_by="scheduler",
    )


@pytest.mark.asyncio
async def test_scan_fires_multiple_due_schedules():
    """All due schedules are fired in order."""
    from admin_worker import _scan_and_fire_schedules

    sched1 = _make_schedule(module_key="health_supplements")
    sched2 = _make_schedule(
        module_key="food_nutrition",
        fetch_url="https://data.fda.gov.tw/data/opendata/export/20/json",
    )
    mock_pool = MagicMock()
    mock_minio = MagicMock()
    mock_minio.enabled = False

    with (
        patch("admin_worker.list_due_schedules", new_callable=AsyncMock) as mock_list,
        patch("admin_worker.fire_schedule", new_callable=AsyncMock) as mock_fire,
    ):
        mock_list.return_value = [sched1, sched2]
        mock_fire.return_value = {"job_id": "job-x", "status": "success", "error": None}

        await _scan_and_fire_schedules(
            mock_pool,
            worker_name="test-worker",
            minio_service=mock_minio,
        )

    assert mock_fire.call_count == 2
    called_scheds = [call.kwargs["schedule"] for call in mock_fire.call_args_list]
    assert called_scheds[0].module_key == "health_supplements"
    assert called_scheds[1].module_key == "food_nutrition"


@pytest.mark.asyncio
async def test_scan_skips_when_no_due_schedules():
    """When list_due_schedules returns empty, fire_schedule is never called."""
    from admin_worker import _scan_and_fire_schedules

    mock_pool = MagicMock()
    mock_minio = MagicMock()

    with (
        patch("admin_worker.list_due_schedules", new_callable=AsyncMock) as mock_list,
        patch("admin_worker.fire_schedule", new_callable=AsyncMock) as mock_fire,
    ):
        mock_list.return_value = []

        await _scan_and_fire_schedules(
            mock_pool,
            worker_name="test-worker",
            minio_service=mock_minio,
        )

    mock_fire.assert_not_called()


@pytest.mark.asyncio
async def test_scan_skips_when_previous_job_still_running():
    """If the last run job is in 'running' state, the schedule is skipped."""
    from admin_worker import _scan_and_fire_schedules

    prev_job_id = "00000000-0000-0000-0000-000000000001"
    sched = _make_schedule(last_run_job_id=prev_job_id)

    # Mock the pool connection to return 'running' for the previous job
    mock_conn = AsyncMock()
    mock_conn.fetchval = AsyncMock(return_value="running")

    mock_pool = MagicMock()
    mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
    mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)

    mock_minio = MagicMock()

    with (
        patch("admin_worker.list_due_schedules", new_callable=AsyncMock) as mock_list,
        patch("admin_worker.fire_schedule", new_callable=AsyncMock) as mock_fire,
    ):
        mock_list.return_value = [sched]

        await _scan_and_fire_schedules(
            mock_pool,
            worker_name="test-worker",
            minio_service=mock_minio,
        )

    # The schedule was skipped because the previous job is still running
    mock_fire.assert_not_called()


@pytest.mark.asyncio
async def test_scan_fires_when_previous_job_completed():
    """If the last run job is in 'success' state, the schedule fires normally."""
    from admin_worker import _scan_and_fire_schedules

    prev_job_id = "00000000-0000-0000-0000-000000000002"
    sched = _make_schedule(last_run_job_id=prev_job_id)

    mock_conn = AsyncMock()
    mock_conn.fetchval = AsyncMock(return_value="success")  # previous job done

    mock_pool = MagicMock()
    mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
    mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)

    mock_minio = MagicMock()
    mock_minio.enabled = False

    with (
        patch("admin_worker.list_due_schedules", new_callable=AsyncMock) as mock_list,
        patch("admin_worker.fire_schedule", new_callable=AsyncMock) as mock_fire,
    ):
        mock_list.return_value = [sched]
        mock_fire.return_value = {
            "job_id": "job-new",
            "status": "success",
            "error": None,
        }

        await _scan_and_fire_schedules(
            mock_pool,
            worker_name="test-worker",
            minio_service=mock_minio,
        )

    mock_fire.assert_called_once()


@pytest.mark.asyncio
async def test_scan_skips_when_previous_job_queued():
    """Queued previous job also prevents re-fire (prevents pile-up)."""
    from admin_worker import _scan_and_fire_schedules

    sched = _make_schedule(last_run_job_id="00000000-0000-0000-0000-000000000003")

    mock_conn = AsyncMock()
    mock_conn.fetchval = AsyncMock(return_value="queued")

    mock_pool = MagicMock()
    mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
    mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)

    with (
        patch("admin_worker.list_due_schedules", new_callable=AsyncMock) as mock_list,
        patch("admin_worker.fire_schedule", new_callable=AsyncMock) as mock_fire,
    ):
        mock_list.return_value = [sched]
        await _scan_and_fire_schedules(
            mock_pool, worker_name="test-worker", minio_service=MagicMock()
        )

    mock_fire.assert_not_called()
