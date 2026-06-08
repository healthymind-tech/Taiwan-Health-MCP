"""
Admin worker — resource-aware parallel job executor.

Concurrency model
-----------------
Jobs are grouped into resource "slots".  At most one job per resource slot may
run at a time.  Jobs with no resource requirement (e.g. noop) are always
eligible and run in parallel with everything else.

  db_write_<module> : one import per module  (icd/loinc/ig/snomed/…)
  ollama_embed       : one embedding job at a time (icd_embed, loinc_embed, …)
  llm                : one LLM/OCR job at a time   (drug_analysis)

Example: icd_import + loinc_import + snomed_import + icd_embed + drug_analysis
can all run simultaneously because they each hold a different resource.  A
second icd_import would queue behind the first because both need db_write_icd.

Implementation
--------------
The main loop:
  1. Reap completed tasks, release their resources.
  2. Compute excluded_job_types from currently active resources.
  3. Try to claim one eligible job (FOR UPDATE SKIP LOCKED).
  4. If claimed, start it as an asyncio.Task with its own heartbeat loop.
  5. Repeat until no more claimable jobs, then sleep poll_interval.

Total concurrency is bounded by ADMIN_MAX_CONCURRENT_JOBS (default 4, 0 = no
cap) on top of the per-resource slots, to keep peak memory in check when
several large module imports run at once.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass, field
from typing import Any

from admin_jobs import (
    JOB_TYPE_RESOURCES,
    admin_heartbeat_interval_seconds,
    admin_worker_name,
    admin_worker_poll_seconds,
    admin_worker_stale_after_seconds,
    append_job_log,
    claim_next_job,
    execute_admin_job,
    get_excluded_job_types,
    log_job_outcome,
    mark_job_status,
    prune_job_logs,
    reclaim_stale_jobs,
    set_default_log_verbose,
    upsert_worker_heartbeat,
)
from admin_schedule import (
    ensure_default_schedules,
    ensure_schedule_table,
    fire_schedule,
    list_due_schedules,
)
from admin_ws import init_broadcast
from config import AppConfig
import database
import db_health
from minio_service import MinioConfig, MinioService
from utils import configure_log_level, log_error, log_info, log_warning

SCHEDULE_SCAN_INTERVAL: float = float(
    __import__("os").getenv("ADMIN_SCHEDULE_SCAN_INTERVAL_SECONDS", "60")
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Per-job execution context
# ---------------------------------------------------------------------------


@dataclass
class _RunningJob:
    job: dict[str, Any]
    resources: frozenset[str]
    task: asyncio.Task  # type: ignore[type-arg]
    hb_stop: asyncio.Event


# ---------------------------------------------------------------------------
# Worker loop
# ---------------------------------------------------------------------------

# Backoff between iterations while the database is unavailable.
_DB_DOWN_BACKOFF_SECONDS = 3.0


def _is_db_outage(exc: BaseException) -> bool:
    """Return True (and flip the health gate) when an exception is a DB outage
    rather than an ordinary error, so the caller can back off instead of crash."""
    if db_health.is_db_down_error(exc):
        db_health.monitor().report_failure(exc)
        return True
    return False


async def _requeue_if_orphaned(pool: Any, *, job_id: str, worker_name: str) -> None:
    """Re-queue a job whose task ended while the DB row is still 'running'.

    This happens when a job task dies mid-flight (e.g. its terminal-state write
    was lost to a DB outage) but the worker process stays alive. Because the
    worker is alive its heartbeat stays fresh, so ``reclaim_stale_jobs`` (which
    keys off a stale *worker* heartbeat) never fires and the job would be stuck
    'running' forever. Re-queue it with ``resume_requested`` so it is re-claimed
    and continues from its last checkpoint.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE admin.import_jobs
            SET status        = 'queued',
                control_state = 'resume_requested',
                current_step  = 'reclaimed_after_interruption',
                updated_at    = NOW()
            WHERE job_id = $1::uuid
              AND worker_name = $2
              AND status = 'running'
            RETURNING job_id, job_type
            """,
            str(job_id),
            worker_name,
        )
    if row:
        log_warning(
            "Requeued interrupted job to resume from checkpoint",
            worker_name=worker_name,
            job_id=str(job_id),
            job_type=row["job_type"],
        )
        await append_job_log(
            pool,
            job_id=job_id,
            level="warn",
            message="Job interrupted (likely DB outage) — requeued to resume from checkpoint",
            payload={"worker_name": worker_name},
        )


async def _run_loop() -> None:
    config = AppConfig.from_env()
    configure_log_level(config.log_level)
    worker_name = admin_worker_name()
    process_id = os.getpid()

    # Enable Redis pub/sub broadcasting so job status events reach browser clients
    # connected to the server container (separate process from this worker).
    if config.redis_url:
        init_broadcast(config.redis_url)

    await database.init_pool(
        config.database_url,
        min_size=1,
        max_size=10,  # bumped: may run 3 jobs in parallel
        statement_cache_size=0,
    )
    # Use the reset-safe handle everywhere below (startup, loop, and the pool
    # handed to each long-running job): when the health monitor recycles the
    # pool on recovery, in-flight jobs keep working instead of being stranded on
    # a terminated pool ("pool is closed"). See database.pool_handle().
    pool = database.pool_handle()
    # This worker is a separate process from the server, so it runs its own DB
    # health monitor. It gates the loop while the DB is down and recycles the
    # pool on recovery — keeping the worker alive instead of crash-looping.
    await db_health.monitor().start()
    # Seed DB-backed settings (idempotent) and load worker tuning + MinIO from DB.
    # Worker-group changes take effect on the next worker restart.
    import admin_settings

    await admin_settings.seed_if_empty(pool)
    _worker_cfg = await admin_settings.get_group(pool, "worker")
    worker_name = str(_worker_cfg.get("name") or worker_name)
    heartbeat_interval = float(_worker_cfg.get("heartbeat_interval", 15) or 15)
    poll_interval = float(_worker_cfg.get("poll_seconds", 3) or 3)
    reclaim_interval = float(_worker_cfg.get("reclaim_interval", 60) or 60)
    # Job-log retention (the import_job_logs table has no other cleanup).
    log_retention_days = int(_worker_cfg.get("log_retention_days", 30) or 30)
    log_max_lines_per_job = int(_worker_cfg.get("log_max_lines_per_job", 2000) or 2000)
    log_prune_interval = float(_worker_cfg.get("log_prune_interval", 3600) or 3600)
    # Global default for verbose job logging; a per-job log_verbose option wins.
    set_default_log_verbose(
        str(_worker_cfg.get("log_verbose", "")).lower() in {"1", "true", "yes", "on"}
    )
    # Cap total concurrent jobs to bound peak memory — the per-module resource
    # slots otherwise allow every module import to run at once, and the loaders
    # parse large modules in-process. 0/blank means "no cap" (slots only).
    try:
        max_concurrent_jobs = int(os.getenv("ADMIN_MAX_CONCURRENT_JOBS", "4") or 0)
    except ValueError:
        max_concurrent_jobs = 4
    if max_concurrent_jobs < 0:
        max_concurrent_jobs = 0

    # Apply schedule-table migrations and seed defaults before entering the loop.
    try:
        await ensure_schedule_table(pool)
        await ensure_default_schedules(pool)
    except Exception as _sch_err:
        log_warning("Schedule setup failed (non-fatal)", error=str(_sch_err))

    minio_service = MinioService(
        MinioConfig.from_values(await admin_settings.get_group(pool, "minio"))
    )
    await minio_service.initialize()

    # On startup, reclaim any jobs left in 'running' state under this worker name.
    # These are orphans from a previous process that died without a clean shutdown
    # (e.g. compose down, OOM kill).  At this point in startup we are the only
    # process with this name, so any running job must be a leftover.
    async with pool.acquire() as _startup_conn:
        orphaned = await _startup_conn.fetch(
            """
            UPDATE admin.import_jobs
            SET status          = 'queued',
                control_state   = 'resume_requested',
                current_step    = 'reclaimed_on_startup',
                updated_at      = NOW()
            WHERE status = 'running'
              AND worker_name = $1
            RETURNING job_id, job_type
            """,
            worker_name,
        )
        if orphaned:
            for row in orphaned:
                await _startup_conn.execute(
                    """
                    INSERT INTO admin.import_job_logs (job_id, level, message, payload_json)
                    VALUES ($1, 'warn', 'Job reclaimed on worker startup', $2::jsonb)
                    """,
                    row["job_id"],
                    json.dumps(
                        {"worker_name": worker_name, "job_type": row["job_type"]},
                        ensure_ascii=False,
                    ),
                )
            log_warning(
                "Reclaimed orphaned jobs on startup",
                worker_name=worker_name,
                count=len(orphaned),
                job_ids=[str(r["job_id"]) for r in orphaned],
            )

    log_info(
        "Admin worker started (resource-aware parallel mode)",
        worker_name=worker_name,
        process_id=process_id,
        poll_interval=poll_interval,
        heartbeat_interval=heartbeat_interval,
        resources=sorted(JOB_TYPE_RESOURCES),
    )

    # State
    running: dict[str, _RunningJob] = {}  # job_id → _RunningJob
    active_resources: frozenset[str] = frozenset()
    next_idle_heartbeat = 0.0
    next_reclaim = 0.0
    next_log_prune = 0.0
    next_schedule_scan = 0.0  # fire immediately on first iteration

    try:
        while True:
            # ── 0. DB health gate ─────────────────────────────────────────────
            # While the database is down/recovering, don't touch it. Running job
            # tasks will go stale and be reclaimed + resumed from checkpoint once
            # the DB returns (reclaim_stale_jobs → control_state=resume_requested).
            if not db_health.monitor().is_healthy():
                await asyncio.sleep(_DB_DOWN_BACKOFF_SECONDS)
                continue
            # `pool` is the reset-safe handle (set at startup); it always resolves
            # the current live pool, including one the monitor just recycled on
            # its way back to healthy — no re-fetch needed.

            loop_time = asyncio.get_running_loop().time()

            # ── 1. Reap completed tasks ───────────────────────────────────────
            done_ids = [jid for jid, rj in running.items() if rj.task.done()]
            for jid in done_ids:
                rj = running.pop(jid)
                active_resources = active_resources - rj.resources
                exc = rj.task.exception() if not rj.task.cancelled() else None
                if exc:
                    log_error(
                        "Job task raised unhandled exception",
                        worker_name=worker_name,
                        job_id=jid,
                        error=str(exc),
                    )
                # Reconcile: if the task ended but the DB row is still 'running'
                # (its terminal write was lost, typically to a DB outage), requeue
                # it to resume from checkpoint. Otherwise it would hang forever,
                # since stale-reclaim only fires when the worker heartbeat goes
                # stale — and this worker stayed alive through the outage.
                try:
                    await _requeue_if_orphaned(
                        pool, job_id=jid, worker_name=worker_name
                    )
                except Exception as _rc_err:
                    log_warning(
                        "Reap reconcile failed (stale-reclaim will retry)",
                        worker_name=worker_name,
                        job_id=jid,
                        error=str(_rc_err),
                    )
            if done_ids:
                log_info(
                    "Reaped completed jobs",
                    worker_name=worker_name,
                    reaped=done_ids,
                    active_resources=sorted(active_resources),
                    running_count=len(running),
                )

            # ── 2. Idle heartbeat (only when no jobs are running) ─────────────
            # Per-job heartbeat loops handle the "running" state.
            # We only need an idle heartbeat when there are no active jobs.
            if not running and loop_time >= next_idle_heartbeat:
                try:
                    await upsert_worker_heartbeat(
                        pool,
                        worker_name=worker_name,
                        process_id=process_id,
                        status="idle",
                        details={
                            "mode": "polling",
                            "minio_enabled": bool(minio_service.enabled),
                        },
                    )
                except Exception as exc:
                    if _is_db_outage(exc):
                        log_warning(
                            "Worker paused — database unavailable",
                            worker_name=worker_name,
                            error=str(exc),
                        )
                        await asyncio.sleep(_DB_DOWN_BACKOFF_SECONDS)
                        continue
                    log_error(
                        "Idle heartbeat failed (non-fatal)",
                        worker_name=worker_name,
                        error=str(exc),
                    )
                next_idle_heartbeat = loop_time + heartbeat_interval

            # ── 3. Reclaim stale jobs from dead workers ───────────────────────
            if loop_time >= next_reclaim:
                try:
                    reclaimed = await reclaim_stale_jobs(pool, worker_name=worker_name)
                except Exception as exc:
                    if _is_db_outage(exc):
                        await asyncio.sleep(_DB_DOWN_BACKOFF_SECONDS)
                        continue
                    raise
                if reclaimed:
                    log_info(
                        "Reclaimed stale jobs",
                        worker_name=worker_name,
                        count=reclaimed,
                    )
                next_reclaim = loop_time + reclaim_interval

            # ── 3b. Prune old job logs (hourly) ───────────────────────────────
            if loop_time >= next_log_prune:
                try:
                    pruned = await prune_job_logs(
                        pool,
                        retention_days=log_retention_days,
                        max_lines_per_job=log_max_lines_per_job,
                    )
                except Exception as exc:
                    if _is_db_outage(exc):
                        await asyncio.sleep(_DB_DOWN_BACKOFF_SECONDS)
                        continue
                    log_warning("Job log prune failed (non-fatal)", error=str(exc))
                    pruned = 0
                if pruned:
                    log_info(
                        "Pruned old job logs", worker_name=worker_name, deleted=pruned
                    )
                next_log_prune = loop_time + log_prune_interval

            # ── 4. Scan for due schedules and fire them ───────────────────────
            if loop_time >= next_schedule_scan:
                try:
                    await _scan_and_fire_schedules(
                        pool,
                        worker_name=worker_name,
                        minio_service=minio_service,
                    )
                except Exception as _sch_err:
                    log_error(
                        "Schedule scan failed",
                        worker_name=worker_name,
                        error=str(_sch_err),
                    )
                next_schedule_scan = loop_time + SCHEDULE_SCAN_INTERVAL

            # ── 5. Try to claim an eligible job ──────────────────────────────
            # Honour the global concurrency cap before claiming more work.
            if max_concurrent_jobs and len(running) >= max_concurrent_jobs:
                await asyncio.sleep(poll_interval)
                continue
            excluded = get_excluded_job_types(active_resources)
            try:
                job = await claim_next_job(
                    pool,
                    worker_name=worker_name,
                    excluded_job_types=excluded,
                )
            except Exception as exc:
                if _is_db_outage(exc):
                    await asyncio.sleep(_DB_DOWN_BACKOFF_SECONDS)
                    continue
                raise

            if job is None:
                # Nothing claimable right now — sleep then retry
                await asyncio.sleep(poll_interval)
                continue

            # ── 5. Launch the job as a concurrent task ────────────────────────
            job_id = job["job_id"]
            job_type = job["job_type"]
            job_resources = JOB_TYPE_RESOURCES.get(job_type, frozenset())
            active_resources = active_resources | job_resources

            hb_stop = asyncio.Event()
            task = asyncio.create_task(
                _run_job_with_heartbeat(
                    pool=pool,
                    worker_name=worker_name,
                    process_id=process_id,
                    job=job,
                    minio_service=minio_service,
                    heartbeat_interval=heartbeat_interval,
                    hb_stop=hb_stop,
                ),
                name=f"job-{job_id[:8]}-{job_type}",
            )
            running[job_id] = _RunningJob(
                job=job,
                resources=job_resources,
                task=task,
                hb_stop=hb_stop,
            )

            log_info(
                "Job started",
                worker_name=worker_name,
                job_id=job_id,
                job_type=job_type,
                resources=sorted(job_resources),
                active_resources=sorted(active_resources),
                running_count=len(running),
            )

            # Reset idle heartbeat timer — the per-job loop owns the heartbeat
            # while the job is running, so suppress idle beats.
            next_idle_heartbeat = loop_time + heartbeat_interval

            # Don't sleep — immediately loop back to try claiming another job
            # that might be eligible with the remaining free resources.

    finally:
        # Graceful shutdown: cancel all running tasks
        if running:
            log_warning(
                "Worker shutting down with active jobs — cancelling",
                worker_name=worker_name,
                job_ids=list(running),
            )
            for rj in running.values():
                rj.hb_stop.set()
                rj.task.cancel()
            await asyncio.gather(
                *[rj.task for rj in running.values()], return_exceptions=True
            )
        await database.close_pool()


# ---------------------------------------------------------------------------
# Per-job coroutine (runs as asyncio.Task)
# ---------------------------------------------------------------------------


async def _run_job_with_heartbeat(
    *,
    pool: Any,
    worker_name: str,
    process_id: int,
    job: dict[str, Any],
    minio_service: MinioService,
    heartbeat_interval: float,
    hb_stop: asyncio.Event,
) -> None:
    """Execute one job, with a concurrent heartbeat loop for its duration."""
    job_id = job["job_id"]
    job_type = job["job_type"]

    job_details = {
        "mode": "job",
        "job_type": job_type,
        "module_key": job.get("module_key", ""),
        "minio_enabled": bool(minio_service.enabled),
    }

    # Initial "running" heartbeat
    await upsert_worker_heartbeat(
        pool,
        worker_name=worker_name,
        process_id=process_id,
        status="running",
        current_job_id=job_id,
        details=job_details,
    )

    # Background heartbeat loop — keeps the worker "Fresh" during long jobs
    async def _heartbeat_loop() -> None:
        while not hb_stop.is_set():
            try:
                await asyncio.wait_for(hb_stop.wait(), timeout=heartbeat_interval)
            except asyncio.TimeoutError:
                pass
            if hb_stop.is_set():
                break
            try:
                await upsert_worker_heartbeat(
                    pool,
                    worker_name=worker_name,
                    process_id=process_id,
                    status="running",
                    current_job_id=job_id,
                    details=job_details,
                )
            except Exception:
                pass  # non-fatal

    hb_task = asyncio.create_task(_heartbeat_loop(), name=f"hb-{job_id[:8]}")
    try:
        await execute_admin_job(
            pool,
            worker_name=worker_name,
            job=job,
            minio_service=minio_service,
        )
        # Guaranteed terminal log line (✓ Completed / ✗ Failed) for every job
        # type, with result_summary counts. Non-fatal if it fails.
        try:
            await log_job_outcome(pool, job_id=job_id, worker_name=worker_name)
        except Exception:
            pass
    except Exception as exc:
        if db_health.is_db_down_error(exc):
            # Database outage mid-job — not a job error. Don't mark it failed
            # (the DB write would fail anyway); flip the health gate and leave the
            # job 'running'. Its heartbeat goes stale and reclaim_stale_jobs will
            # re-queue it with resume_requested, so it continues from its last
            # checkpoint once the database is back.
            db_health.monitor().report_failure(exc)
            log_warning(
                "Job interrupted by database outage — will resume after recovery",
                worker_name=worker_name,
                job_id=job_id,
                error=str(exc),
            )
        else:
            log_error(
                "Job execution raised unhandled exception",
                worker_name=worker_name,
                job_id=job_id,
                error=str(exc),
            )
            try:
                await mark_job_status(
                    pool,
                    job_id=job_id,
                    status="retryable_failed",
                    current_step="worker_exception",
                    control_state="idle",
                    last_error_code="worker_exception",
                    last_error_message=str(exc),
                )
                await append_job_log(
                    pool,
                    job_id=job_id,
                    level="error",
                    message="Worker execution failed",
                    payload={"worker_name": worker_name, "error": str(exc)},
                )
            except Exception:
                pass
    finally:
        hb_stop.set()
        await hb_task
        # Emit a final heartbeat that no longer references this job.
        # The main loop will send an idle heartbeat once all jobs are done.
        try:
            # Emit a transitional heartbeat; main loop sends "idle" once
            # all tasks finish.
            await upsert_worker_heartbeat(
                pool,
                worker_name=worker_name,
                process_id=process_id,
                status="running",
                details={
                    "mode": "finishing",
                    "job_type": job_type,
                    "minio_enabled": bool(minio_service.enabled),
                },
            )
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Schedule scan helper
# ---------------------------------------------------------------------------


async def _scan_and_fire_schedules(
    pool: Any,
    *,
    worker_name: str,
    minio_service: Any,
) -> None:
    """Check for overdue schedules and fire them.

    Skips a schedule if its last job is still active (queued / running / paused)
    to prevent double-firing when a previous run is taking longer than the
    schedule interval.
    """
    due = await list_due_schedules(pool)
    if not due:
        return

    log_info(
        "Schedule scan: found due schedules",
        worker_name=worker_name,
        count=len(due),
        module_keys=[s.module_key for s in due],
    )

    for sched in due:
        # Guard: skip if the previous run's job is still active.
        if sched.last_run_job_id:
            async with pool.acquire() as _conn:
                prev_status = await _conn.fetchval(
                    "SELECT status FROM admin.import_jobs WHERE job_id = $1",
                    __import__("uuid").UUID(sched.last_run_job_id),
                )
            if prev_status in ("queued", "running", "paused"):
                log_info(
                    "Schedule skip: previous job still active",
                    worker_name=worker_name,
                    module_key=sched.module_key,
                    prev_job_id=sched.last_run_job_id,
                    prev_status=prev_status,
                )
                continue

        result = await fire_schedule(
            pool,
            schedule=sched,
            minio_service=minio_service,
            triggered_by="scheduler",
        )
        log_info(
            "Schedule fired",
            worker_name=worker_name,
            module_key=sched.module_key,
            status=result["status"],
            job_id=result.get("job_id"),
            error=result.get("error"),
        )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    asyncio.run(_run_loop())


if __name__ == "__main__":
    main()
