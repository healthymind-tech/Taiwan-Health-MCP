"""Run a single already-claimed admin job by id, in-process.

This is the Python side of the polyglot admin worker: the Node worker handles all
deterministic loader/embed jobs, but the **drug** stages (TFDA crawling, OCR via
the dots_ocr VLM, and the analysis LLM) are Python hard-dependencies that stay in
Python. When the Node worker claims a drug job it spawns this script, which runs
the existing ``admin_jobs.execute_admin_job`` dispatcher for that job id — i.e.
the unchanged ``_run_drug_*_job`` handler with its full step/progress/log tracking
and the drug auto-chain (index → enrichment → analysis).

The job must already be marked ``running``/claimed by the caller; this process
runs its handler (handlers update job state directly in the DB) and exits 0 on a
clean run. Any handler-level failure is recorded on the job by the handler itself.

Usage:  python run_one_drug_job.py <job_id>
"""

from __future__ import annotations

import asyncio
import sys

import admin_settings
import database
from admin_jobs import execute_admin_job, get_job
from admin_ws import init_broadcast
from config import AppConfig
from minio_service import MinioConfig, MinioService
from utils import configure_log_level, log_error


async def _run(job_id: str) -> int:
    config = AppConfig.from_env()
    configure_log_level(config.log_level)
    # Enable Redis pub/sub so job-status events still reach browser clients
    # connected to the server container (same as the standalone worker).
    if config.redis_url:
        init_broadcast(config.redis_url)
    await database.init_pool(
        config.database_url,
        min_size=1,
        max_size=4,
        statement_cache_size=0,
    )
    pool = database.pool_handle()
    minio_service = MinioService(
        MinioConfig.from_values(await admin_settings.get_group(pool, "minio"))
    )
    await minio_service.initialize()

    job = await get_job(pool, job_id=job_id)
    if job is None:
        log_error("run_one_drug_job: job not found", job_id=job_id)
        return 1
    worker_name = str(job.get("worker_name") or "drug-shim")
    # execute_admin_job dispatches to the drug handler (and runs the drug
    # auto-chain on success) — identical to the standalone worker's path.
    await execute_admin_job(
        pool, worker_name=worker_name, job=job, minio_service=minio_service
    )
    return 0


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: python run_one_drug_job.py <job_id>", file=sys.stderr)
        sys.exit(2)
    sys.exit(asyncio.run(_run(sys.argv[1])))


if __name__ == "__main__":
    main()
