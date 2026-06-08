import asyncio
import inspect
import json
import mimetypes
import re
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from http.cookies import SimpleCookie
from pathlib import Path
from typing import Any, Callable, Literal
from urllib.parse import parse_qs

from mcp.server.fastmcp import FastMCP
from mcp.types import TextContent, ToolAnnotations

import admin_maintenance
import audit
import cache as cache_module
import database
import db_health
import fhir_reference
import metrics
from admin_console import (
    SESSION_COOKIE_NAME,
    AdminOverviewPayload,
    build_admin_login_html,
    build_admin_session_cookie,
    build_admin_session_token,
    clear_admin_session_cookie,
    parse_admin_session_token,
    verify_admin_password,
)
from admin_drug import (
    get_drug_admin_status,
    get_drug_license_events,
    get_drug_pipeline_status,
)
from admin_embedding import get_embedding_status
from admin_jobs import (
    ADMIN_JOB_TYPES,
)
from admin_jobs import create_job as create_admin_job
from admin_jobs import get_job as get_admin_job
from admin_jobs import (
    list_job_logs,
    list_job_steps,
)
from admin_jobs import list_jobs as list_admin_jobs
from admin_jobs import (
    list_worker_heartbeats,
    request_job_control,
    summarize_jobs,
)
from admin_preview import PREVIEW_SUPPORTED_MODULES, dispatch_preview
from admin_schedule import (
    SCHEDULABLE_MODULES,
    URL_FETCH_MODULES,
    delete_schedule,
    ensure_default_schedules,
    ensure_schedule_table,
    fire_schedule,
    get_schedule,
    upsert_schedule,
)
from admin_services import list_service_probes, run_service_probes
from admin_sources import (
    activate_source,
    catalog_entry,
    clear_drug_module,
    clear_icd_module,
    clear_ig_module,
    clear_loinc_module,
    clear_rxnorm_module,
    clear_snomed_module,
    create_uploaded_source,
    deactivate_source,
    delete_uploaded_source,
    ensure_ig_artifact_tables,
    ensure_version_num_column,
    list_source_catalog,
    list_source_versions,
    validate_source_content,
    validate_source_filename,
)
from admin_ws import broadcast as ws_broadcast
from admin_ws import (
    handle_admin_websocket,
    init_broadcast,
    start_ws_relay,
)
from audit import audited
from clinical_guideline_service import ClinicalGuidelineService
from config import AppConfig
from drug_service import DrugService
from embedding_service import EmbeddingService
from fhir_condition_service import FHIRConditionService
from fhir_ig_service import FHIRIGService
from fhir_medication_service import FHIRMedicationService
from fhir_server_service import (
    create_fhir_server,
    delete_fhir_server,
    discover_fhir_metadata,
    ensure_fhir_server_schema,
    export_fhir_servers,
    fhir_server_secret_key,
    generate_client_key,
    get_fhir_server,
    get_fhir_server_jwks,
)
from fhir_server_service import list_fhir_servers as list_registered_fhir_servers
from fhir_server_service import (
    perform_fhir_crud,
    probe_fhir_server,
    server_mcp_summary,
    set_default_fhir_server,
    test_fhir_server_config,
    update_fhir_server,
)
from food_nutrition_service import FoodNutritionService
from health_supplements_service import HealthSupplementsService
from icd_service import ICDService
from lab_service import LabService
from minio_service import MinioConfig, MinioService
from module_status import CACHE_TTL, SERVICE_MODULES, ModuleStatusManager
from snomed_service import SNOMEDService
from twcore_service import TWCoreService
from utils import configure_log_level, log_error, log_info, log_warning

config = AppConfig.from_env()
configure_log_level(config.log_level)

# Services (populated once on first lifespan run)
icd_service: ICDService | None = None
drug_service: DrugService | None = None
minio_service: MinioService | None = None
health_supplements_service: HealthSupplementsService | None = None
food_nutrition_service: FoodNutritionService | None = None
fhir_condition_service: FHIRConditionService | None = None
fhir_medication_service: FHIRMedicationService | None = None
lab_service: LabService | None = None
guideline_service: ClinicalGuidelineService | None = None
twcore_service: TWCoreService | None = None
fhir_ig_service: FHIRIGService | None = None
snomed_service: SNOMEDService | None = None

# FastMCP (streamable-http mode) runs the lifespan once per session, not per
# process.  Guard all one-time initialization behind a lock + flag so that
# the second session simply reuses the already-initialized resources.
_init_lock: asyncio.Lock | None = None  # created lazily inside async context
_initialized: bool = False
_db_stats_task: asyncio.Task | None = None
# Long-lived Redis pub/sub relay task (started once; cancelled at process
# shutdown so the event loop tears down without "Task was destroyed but it is
# pending" / async-generator finalisation noise from pubsub.listen()).
_ws_relay_task: asyncio.Task | None = None
_module_status = ModuleStatusManager()
_server_started_at = datetime.now(timezone.utc)


async def _initialize_shared_resources() -> None:
    global icd_service, drug_service, minio_service, health_supplements_service, food_nutrition_service
    global fhir_condition_service, fhir_medication_service, lab_service, guideline_service, twcore_service
    global fhir_ig_service
    global snomed_service
    global _init_lock, _initialized, _db_stats_task, _ws_relay_task

    if _init_lock is None:
        _init_lock = asyncio.Lock()

    async with _init_lock:
        if _initialized:
            return

        log_info(f"Starting Taiwan Health MCP — {config}")

        if config.transport != "stdio":
            metrics.start_metrics_server()

        await database.init_pool(
            config.database_url, min_size=5, max_size=20, statement_cache_size=0
        )
        # Use the reset-safe handle (not the raw pool) for everything below: the
        # services capture this, so a reset_pool() swap after a DB restart cannot
        # strand them on a terminated pool ("pool is closed"). See database.py.
        pool = database.pool_handle()
        await cache_module.init_client(config.redis_url)

        # Start the DB health monitor — gates operations while the DB is down.
        await db_health.monitor().start()

        # Apply idempotent schema migrations for admin tables.
        await ensure_version_num_column(pool)
        await ensure_ig_artifact_tables(pool)
        await ensure_schedule_table(pool)
        await ensure_default_schedules(pool)
        await ensure_fhir_server_schema(pool)

        # Seed DB-backed settings from .env on first boot (no-op if already seeded),
        # then apply embedding settings to the query-time embedding client.
        import admin_settings
        import embedding_service as _embedding_service

        await admin_settings.seed_if_empty(pool)
        _embedding_service.configure(await admin_settings.get_group(pool, "embedding"))

        # Wire up the WebSocket broadcaster and start the cross-process relay.
        # init_broadcast() tells broadcast() which Redis URL to publish to.
        # start_ws_relay() subscribes and fans out to connected browser tabs.
        init_broadcast(config.redis_url)
        # Keep a reference so the task is not GC'd while pending and can be
        # cancelled cleanly at process shutdown (see _shutdown_ws_relay).
        _ws_relay_task = asyncio.create_task(start_ws_relay(config.redis_url))

        minio_service = MinioService(
            MinioConfig.from_values(await admin_settings.get_group(pool, "minio"))
        )
        await minio_service.initialize()

        _db_stats_task = await metrics.start_db_stats_collector(database.get_pool)

        embedding_svc = EmbeddingService()
        await embedding_svc.initialize()

        for name, factory in [
            ("ICDService", lambda: ICDService(pool, embedding_svc)),
            ("DrugService", lambda: DrugService(pool, minio_service=minio_service)),
            (
                "HealthSupplementsService",
                lambda: HealthSupplementsService(pool, embedding_svc),
            ),
            (
                "FoodNutritionService",
                lambda: FoodNutritionService(pool, embedding_svc),
            ),
            ("FHIRConditionService", lambda: FHIRConditionService(pool)),
            ("FHIRMedicationService", lambda: FHIRMedicationService(pool)),
            ("LabService", lambda: LabService(pool, embedding_svc)),
            (
                "ClinicalGuidelineService",
                lambda: ClinicalGuidelineService(pool, embedding_svc),
            ),
            ("TWCoreService", lambda: TWCoreService(pool)),
            ("FHIRIGService", lambda: FHIRIGService(pool, embedding_svc)),
            ("SNOMEDService", lambda: SNOMEDService(pool, embedding_svc)),
        ]:
            try:
                svc = factory()
                await svc.initialize()
                if name == "ICDService":
                    icd_service = svc
                elif name == "DrugService":
                    drug_service = svc
                elif name == "HealthSupplementsService":
                    health_supplements_service = svc
                elif name == "FoodNutritionService":
                    food_nutrition_service = svc
                elif name == "FHIRConditionService":
                    fhir_condition_service = svc
                elif name == "FHIRMedicationService":
                    fhir_medication_service = svc
                elif name == "LabService":
                    lab_service = svc
                elif name == "ClinicalGuidelineService":
                    guideline_service = svc
                elif name == "TWCoreService":
                    twcore_service = svc
                elif name == "FHIRIGService":
                    fhir_ig_service = svc
                elif name == "SNOMEDService":
                    snomed_service = svc
            except Exception as e:
                log_error(f"{name} failed to initialize", error=str(e))

        await _warm_up_cache()
        await _module_status.refresh_if_stale_and_sync(
            pool,
            SERVICE_TOOLS,
            mcp,
            force=True,
        )

        _initialized = True
        log_info("All services initialized — server ready")


async def _ensure_runtime_ready() -> None:
    if _initialized:
        return
    try:
        database.get_pool()
        return
    except RuntimeError:
        pass
    await _initialize_shared_resources()


@asynccontextmanager
async def lifespan(server):
    await _initialize_shared_resources()

    yield

    # Session teardown — do NOT close shared resources; the process may still
    # be serving other sessions.  Resources are reclaimed when the process exits.


async def _shutdown_ws_relay() -> None:
    """Cancel the long-lived Redis pub/sub relay task at process shutdown.

    Driven from the ASGI ``lifespan.shutdown`` event (see PrivacyPageMiddleware),
    which fires once per process — unlike FastMCP's per-session ``lifespan`` — so
    this is the right place to reclaim a process-scoped task.  Without it the
    event loop closes while ``start_ws_relay`` is still parked inside
    ``pubsub.listen()``, producing "Task was destroyed but it is pending" plus an
    async-generator finalisation race.  Cancelling injects ``CancelledError`` at
    the await point so the generator and its Redis connection close cleanly.
    No-op when the relay was never started (e.g. no session ran)."""
    global _ws_relay_task
    task = _ws_relay_task
    _ws_relay_task = None
    if task is None or task.done():
        return
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    except Exception:  # defensive — shutdown must not raise
        pass


async def _warm_up_cache() -> None:
    """Pre-warm the most frequently accessed, slow-changing data."""
    warmed = 0
    try:
        if lab_service:
            result = await lab_service.list_categories()
            warmed += await cache_module.warm_up(
                [("mcp:lab:categories:warm", result, 86400)]
            )
        if twcore_service:
            result = await twcore_service.list_codesystems("all")
            warmed += await cache_module.warm_up(
                [("mcp:twcore:list:warm", result, 86400)]
            )
        if guideline_service:
            for code in ("E11", "I10", "E78", "N18"):
                result = await guideline_service.get_complete_guideline(code)
                warmed += await cache_module.warm_up(
                    [(f"mcp:guideline:warm:{code}", result, 86400)]
                )
        log_info(f"Cache warm-up complete", keys_written=warmed)
    except Exception as e:
        log_error(f"Cache warm-up failed (non-fatal)", error=str(e))


def _svc_unavailable(name: str) -> str:
    """Return a standard JSON error when a service is not yet initialized."""
    return json.dumps(
        {
            "error": f"{name} service is not available",
            "hint": "Run the data-loader to populate this module, then restart the server.",
        },
        ensure_ascii=False,
    )


def _svc_maintenance(name: str) -> str:
    """Return a standard JSON response when a service is in maintenance mode.

    Unlike _svc_unavailable (module never loaded), this signals a deliberate,
    temporary pause initiated by an admin; clients should retry later.
    """
    return json.dumps(
        {
            "error": f"{name} is temporarily under maintenance",
            "status": "maintenance",
            "hint": "The module is being updated by an administrator. Please retry shortly.",
        },
        ensure_ascii=False,
    )


async def _icd_maintenance_active() -> bool:
    """True if ICD is in maintenance mode. Fail-open: if the flag can't be read
    (e.g. pool not ready) we do NOT pause the service, to avoid an outage on a
    transient settings-read error."""
    try:
        return await admin_maintenance.is_enabled(database.get_pool(), "icd")
    except Exception:
        return False


async def _loinc_maintenance_active() -> bool:
    """True if LOINC is in maintenance mode. Fail-open on settings read errors."""
    try:
        return await admin_maintenance.is_enabled(database.get_pool(), "loinc")
    except Exception:
        return False


async def _snomed_maintenance_active() -> bool:
    """True if SNOMED CT is in maintenance mode. Fail-open on settings read errors."""
    try:
        return await admin_maintenance.is_enabled(database.get_pool(), "snomed")
    except Exception:
        return False


async def _ig_maintenance_active() -> bool:
    """True if the Implementation Guides module is in maintenance mode. Fail-open on
    settings read errors."""
    try:
        return await admin_maintenance.is_enabled(database.get_pool(), "ig")
    except Exception:
        return False


async def _drug_maintenance_active() -> bool:
    """True if Drug is in maintenance mode. Fail-open on settings read errors."""
    try:
        return await admin_maintenance.is_enabled(database.get_pool(), "drug")
    except Exception:
        return False


async def _module_record_counts(pool) -> dict[str, int]:
    """Row counts used by the admin UI to tell EMPTY from POPULATED.

    Upload-based modules use this for maintenance/import state. Action-only
    modules use it to disable preview/embed until a sync or seed has created
    source rows.
    """
    counts: dict[str, int] = {}
    try:
        async with pool.acquire() as conn:
            diag = await conn.fetchval("SELECT COUNT(*) FROM icd.diagnoses")
            proc = await conn.fetchval("SELECT COUNT(*) FROM icd.procedures")
        counts["icd"] = int(diag or 0) + int(proc or 0)
    except Exception:
        counts["icd"] = 0
    try:
        async with pool.acquire() as conn:
            loinc = await conn.fetchval("SELECT COUNT(*) FROM loinc.concepts")
        counts["loinc"] = int(loinc or 0)
    except Exception:
        counts["loinc"] = 0
    try:
        async with pool.acquire() as conn:
            snomed = await conn.fetchval("SELECT COUNT(*) FROM snomed.concepts")
        counts["snomed"] = int(snomed or 0)
    except Exception:
        counts["snomed"] = 0
    try:
        async with pool.acquire() as conn:
            rxnorm = await conn.fetchval("SELECT COUNT(*) FROM rxnorm.concepts")
        counts["rxnorm"] = int(rxnorm or 0)
    except Exception:
        counts["rxnorm"] = 0
    try:
        async with pool.acquire() as conn:
            ig_count = await conn.fetchval("""
                SELECT
                    (SELECT COUNT(*) FROM fhir.codesystems)
                  + (SELECT COUNT(*) FROM fhir.artifacts)
                """)
        counts["ig"] = int(ig_count or 0)
    except Exception:
        counts["ig"] = 0
    try:
        async with pool.acquire() as conn:
            drug = await conn.fetchval(
                "SELECT COUNT(*) FROM drug.licenses WHERE is_listed"
            )
        counts["drug"] = int(drug or 0)
    except Exception:
        counts["drug"] = 0
    try:
        async with pool.acquire() as conn:
            guideline = await conn.fetchval(
                "SELECT COUNT(*) FROM guideline.disease_guidelines"
            )
        counts["guideline"] = int(guideline or 0)
    except Exception:
        counts["guideline"] = 0
    try:
        async with pool.acquire() as conn:
            health_supplements = await conn.fetchval(
                "SELECT COUNT(*) FROM health_supplements.items"
            )
        counts["health_supplements"] = int(health_supplements or 0)
    except Exception:
        counts["health_supplements"] = 0
    try:
        async with pool.acquire() as conn:
            food_nutrition = await conn.fetchval("""
                SELECT
                    (SELECT COUNT(DISTINCT sample_name) FROM food_nutrition.measurements)
                  + (SELECT COUNT(*) FROM food_nutrition.ingredients)
                """)
        counts["food_nutrition"] = int(food_nutrition or 0)
    except Exception:
        counts["food_nutrition"] = 0
    return counts


def _json_error(message: str, **extra) -> str:
    """Return a compact JSON error payload used by several thin wrappers."""
    payload = {"error": message}
    payload.update(extra)
    return json.dumps(payload, ensure_ascii=False)


async def _call_service_json(service, method_name: str, *args, **kwargs) -> str:
    """Call a service method and serialise dict/list responses to JSON."""
    method = getattr(service, method_name)
    result = await method(*args, **kwargs)
    if isinstance(result, str):
        return result
    serializer = getattr(service, "to_json_string", None)
    if callable(serializer):
        return serializer(result, indent=2)
    return json.dumps(result, ensure_ascii=False, indent=2)


def _admin_enabled() -> bool:
    return config.admin_enabled


def _admin_ready() -> bool:
    return config.admin_ready


def _format_uptime() -> str:
    elapsed = datetime.now(timezone.utc) - _server_started_at
    total_seconds = int(elapsed.total_seconds())
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours:
        return f"{hours}h {minutes}m {seconds}s"
    if minutes:
        return f"{minutes}m {seconds}s"
    return f"{seconds}s"


def _parse_cookie_header(scope: dict[str, Any]) -> dict[str, str]:
    cookie = SimpleCookie()
    for name, value in scope.get("headers", []):
        if name.lower() == b"cookie":
            try:
                cookie.load(value.decode("latin-1"))
            except Exception:
                return {}
    return {key: morsel.value for key, morsel in cookie.items()}


def _parse_query_params(scope: dict[str, Any]) -> dict[str, str]:
    raw = scope.get("query_string", b"")
    if not raw:
        return {}
    parsed = parse_qs(raw.decode("utf-8", errors="replace"), keep_blank_values=True)
    return {key: values[0] if values else "" for key, values in parsed.items()}


def _header_value(scope: dict[str, Any], name: str) -> str:
    target = name.lower().encode("latin-1")
    for key, value in scope.get("headers", []):
        if key.lower() == target:
            return value.decode("latin-1", errors="replace")
    return ""


def _admin_username_from_scope(scope: dict[str, Any]) -> str | None:
    if not _admin_ready():
        return None
    cookies = _parse_cookie_header(scope)
    token = cookies.get(SESSION_COOKIE_NAME)
    return parse_admin_session_token(token, config.admin_session_secret)


def _admin_service_registry() -> dict[str, bool]:
    return {
        "icd": icd_service is not None,
        "drug": drug_service is not None,
        "health_supplements": health_supplements_service is not None,
        "food_nutrition": food_nutrition_service is not None,
        "fhir_condition": fhir_condition_service is not None,
        "fhir_medication": fhir_medication_service is not None,
        "lab": lab_service is not None,
        "guideline": guideline_service is not None,
        "ig": fhir_ig_service is not None,
        "snomed": snomed_service is not None,
    }


async def _read_json_body(receive) -> dict[str, Any]:
    chunks: list[bytes] = []
    more_body = True
    while more_body:
        message = await receive()
        if message["type"] != "http.request":
            continue
        body = message.get("body", b"")
        if body:
            chunks.append(body)
        more_body = bool(message.get("more_body", False))
    if not chunks:
        return {}
    return json.loads(b"".join(chunks).decode("utf-8"))


async def _refresh_settings_singletons(pool, group: str) -> None:
    """After a settings save, hot-apply changes to long-lived app singletons so
    no restart is needed (the worker picks up DB changes on its own via the
    short-TTL settings cache)."""
    global minio_service
    import admin_settings

    try:
        if group == "embedding":
            import embedding_service as _es

            _es.configure(await admin_settings.get_group(pool, "embedding"))
        elif group == "minio":
            new_svc = MinioService(
                MinioConfig.from_values(await admin_settings.get_group(pool, "minio"))
            )
            await new_svc.initialize()
            minio_service = new_svc
            if drug_service is not None:
                drug_service._minio_service = new_svc
    except Exception as exc:
        log_warning("Settings singleton refresh failed", group=group, error=str(exc))


async def _build_admin_overview_payload() -> AdminOverviewPayload:
    generated_at = datetime.now(timezone.utc).isoformat()
    infrastructure: dict[str, dict[str, Any]] = {}
    modules: dict[str, dict[str, Any]] = {}
    services: dict[str, dict[str, Any]] = {}
    jobs: dict[str, Any] = {
        "queued": 0,
        "running": 0,
        "success": 0,
        "failed": 0,
        "paused": 0,
        "stopped": 0,
    }
    workers: list[dict[str, Any]] = []

    db_ok = False
    redis_ok = False
    pool = None

    try:
        pool = database.get_pool()
        async with pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
        db_ok = True
        infrastructure["database"] = {
            "status": "ok",
            "detail": "PostgreSQL reachable",
        }
    except Exception as exc:
        infrastructure["database"] = {
            "status": "error",
            "detail": str(exc),
        }

    try:
        client = cache_module.get_client()
        await client.ping()
        redis_ok = True
        infrastructure["redis"] = {
            "status": "ok",
            "detail": "Redis reachable",
        }
    except Exception as exc:
        infrastructure["redis"] = {
            "status": "error",
            "detail": str(exc),
        }

    if minio_service is None:
        infrastructure["minio"] = {
            "status": "error",
            "detail": "MinIO service not initialized",
        }
    elif minio_service.enabled:
        infrastructure["minio"] = {
            "status": "ok",
            "detail": f"Bucket: {minio_service.config.bucket}",
        }
    elif minio_service.config.enabled:
        infrastructure["minio"] = {
            "status": "degraded",
            "detail": minio_service.init_error or "MinIO configured but unavailable",
        }
    else:
        infrastructure["minio"] = {
            "status": "degraded",
            "detail": "MinIO disabled by configuration",
        }

    # OCR server — external ML dependency, surfaced under Infrastructure on the
    # overview so its health is visible at a glance (probe is a short HTTP check).
    try:
        import admin_settings
        from admin_services import _probe_ocr_server
        from drug_analysis_service import DrugAnalysisConfig, DrugAnalysisService

        _cfg = DrugAnalysisConfig.from_values(
            ocr=await admin_settings.get_group(pool, "ocr"),
            analysis=await admin_settings.get_group(pool, "analysis"),
        )
        _ocr = await _probe_ocr_server(DrugAnalysisService(_cfg))
        infrastructure["ocr"] = {
            "status": _ocr.get("status", "error"),
            "detail": _ocr.get("message", ""),
        }
    except Exception as exc:
        infrastructure["ocr"] = {"status": "error", "detail": str(exc)}

    infrastructure["mcp"] = {
        "status": "ok" if _initialized else "degraded",
        "detail": str(config),
    }

    if pool is not None and db_ok:
        await _module_status.refresh_if_stale_and_sync(
            pool,
            SERVICE_TOOLS,
            mcp,
            force=True,
        )
        cached = _module_status.get_status()
        async with pool.acquire() as conn:
            for key, requirements in SERVICE_MODULES.items():
                threshold = max(req[1] for req in requirements)
                row_count = 0
                requirement_details: list[dict[str, Any]] = []
                ready = True
                for table, minimum in requirements:
                    count = int(
                        await conn.fetchval(f"SELECT COUNT(*) FROM {table}") or 0
                    )
                    row_count = max(row_count, count)
                    requirement_details.append(
                        {"table": table, "row_count": count, "threshold": minimum}
                    )
                    if count < minimum:
                        ready = False
                modules[key] = {
                    "ready": bool(cached.get(key, ready)),
                    "row_count": row_count,
                    "threshold": threshold,
                    "requirements": requirement_details,
                    "cache_ttl_seconds": int(CACHE_TTL.total_seconds()),
                }
        try:
            jobs = await summarize_jobs(pool)
            workers = await list_worker_heartbeats(pool)
        except Exception as exc:
            infrastructure["admin_control_plane"] = {
                "status": "degraded",
                "detail": str(exc),
            }
    else:
        for key, requirements in SERVICE_MODULES.items():
            modules[key] = {
                "ready": False,
                "row_count": 0,
                "threshold": max(req[1] for req in requirements),
                "requirements": [],
                "cache_ttl_seconds": int(CACHE_TTL.total_seconds()),
            }
        workers = []

    service_registry = _admin_service_registry()
    cached_status = _module_status.get_status()

    # Collect per-service health status (ok / degraded / unavailable).
    _health_svc_map = {
        "icd": icd_service,
        "lab": lab_service,
        "guideline": guideline_service,
        "snomed": snomed_service,
        "health_supplements": health_supplements_service,
        "food_nutrition": food_nutrition_service,
        "drug": drug_service,
        # Derived services (no own tables / no health_status()): they fall to the
        # "inherit module readiness" branch below. Must be present here or they
        # would always report 'unavailable' regardless of their dependency.
        "ig": fhir_ig_service,
        "fhir_condition": fhir_condition_service,
        "fhir_medication": fhir_medication_service,
    }
    for key, initialized in service_registry.items():
        svc = _health_svc_map.get(key)
        health = {
            "status": "unavailable",
            "reason": "Not initialized",
            "search_mode": "n/a",
        }
        if svc is not None and hasattr(svc, "health_status"):
            try:
                h = await svc.health_status()
                health = h.as_dict()
            except Exception as _he:
                health = {
                    "status": "degraded",
                    "reason": str(_he),
                    "search_mode": "n/a",
                }
        elif svc is not None:
            # Services without health_status() (FHIR, TWCore): inherit module readiness
            health = {
                "status": "ok" if cached_status.get(key, False) else "unavailable",
                "reason": "",
                "search_mode": "n/a",
            }
        services[key] = {
            "initialized": initialized,
            "module_ready": bool(cached_status.get(key, False)),
            "health": health,
        }

    # Modules in maintenance mode override their service status so the Overview
    # surfaces the deliberate pause (rather than 'ok'/'degraded').
    try:
        maintenance_states = await admin_maintenance.get_states(database.get_pool())
    except Exception:
        maintenance_states = {}
    for ds_key, on in maintenance_states.items():
        if on and ds_key in services:
            services[ds_key]["health"] = {
                "status": "maintaining",
                "reason": "Maintenance mode enabled",
                "search_mode": "n/a",
            }
            services[ds_key]["maintenance"] = True

    modules_ready = sum(1 for item in modules.values() if item["ready"])
    services_initialized = sum(1 for item in services.values() if item["initialized"])
    services_degraded = sum(
        1
        for item in services.values()
        if item.get("health", {}).get("status") == "degraded"
    )
    infra_healthy = sum(1 for item in infrastructure.values() if item["status"] == "ok")
    overall_status = (
        "ok"
        if db_ok
        and redis_ok
        and services_initialized == len(services)
        and services_degraded == 0
        else "degraded"
    )

    # External FHIR server registry — surface each server's last probe result
    # (read from DB, no live HTTP) so the Overview shows external connectivity.
    fhir_servers_payload: dict[str, Any] = {"total": 0, "ok": 0, "items": []}
    try:
        registered = await list_registered_fhir_servers(
            database.get_pool(), include_disabled=True
        )
        items = [
            {
                "server_key": s["server_key"],
                "name": s["name"],
                "enabled": bool(s["enabled"]),
                "is_default": bool(s["is_default"]),
                "auth_profile": s.get("auth_profile") or "none",
                "last_probe_status": s.get("last_probe_status") or "",
                "last_probe_at": s.get("last_probe_at"),
                "last_probe_error": s.get("last_probe_error") or "",
            }
            for s in registered
        ]
        fhir_servers_payload = {
            "total": len(items),
            "ok": sum(1 for s in items if s["last_probe_status"] == "ok"),
            "items": items,
        }
    except Exception as exc:
        fhir_servers_payload = {"total": 0, "ok": 0, "items": [], "error": str(exc)}

    return AdminOverviewPayload(
        generated_at=generated_at,
        app={
            "transport": config.transport,
            "mcp_path": config.path,
            "admin_enabled": _admin_enabled(),
            "admin_ready": _admin_ready(),
            "admin_username": config.admin_username,
            "uptime": _format_uptime(),
        },
        infrastructure=infrastructure,
        modules=modules,
        services=services,
        jobs=jobs,
        workers=workers,
        summary={
            "overall_status": overall_status,
            "modules_ready": modules_ready,
            "modules_total": len(modules),
            "services_initialized": services_initialized,
            "services_degraded": services_degraded,
            "services_total": len(services),
            "infrastructure_healthy": infra_healthy,
            "infrastructure_total": len(infrastructure),
            "fhir_servers_total": fhir_servers_payload["total"],
            "fhir_servers_ok": fhir_servers_payload["ok"],
        },
        fhir_servers=fhir_servers_payload,
    )


class DynamicFastMCP(FastMCP):
    """FastMCP subclass that refreshes module-based tool availability on every tools/list."""

    async def list_tools(self) -> list:
        try:
            pool = database.get_pool()
            await _module_status.refresh_if_stale_and_sync(
                pool,
                SERVICE_TOOLS,
                self,
                force=True,
            )
        except RuntimeError:
            pass  # pool not yet initialized — return whatever tools are registered
        return await super().list_tools()

    async def call_tool(self, name: str, arguments: dict):
        # DB health gate: while the database is unavailable, block every tool
        # except health_check and return a clear retry message instead of letting
        # raw asyncpg errors surface. report_failure() flips the gate instantly
        # if a tool still slips through and hits a dead connection (fail-fast).
        if name != "health_check" and not db_health.monitor().is_healthy():
            payload = json.dumps(
                {
                    "error": "database_unavailable",
                    "message": (
                        "The database is recovering; the system has paused "
                        "operations. Please retry in a few seconds."
                    ),
                    "db_status": db_health.monitor().snapshot(),
                },
                ensure_ascii=False,
                default=str,
            )
            return [TextContent(type="text", text=payload)]
        try:
            return await super().call_tool(name, arguments)
        except Exception as exc:
            db_health.monitor().report_failure(exc)
            raise


mcp = DynamicFastMCP(
    "taiwanHealthMcp",
    host=config.host,
    port=config.port,
    streamable_http_path=config.path,
    dependencies=["uvicorn"],
    lifespan=lifespan,
)


class ApiErrorLoggingMiddleware:
    """Log request details for HTTP API responses with error status codes."""

    def __init__(self, app, max_body_chars: int = 2000):
        self.app = app
        self.max_body_chars = max_body_chars

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        body_chunks: list[bytes] = []

        async def wrapped_receive():
            message = await receive()
            if message["type"] == "http.request":
                chunk = message.get("body", b"")
                if chunk:
                    body_chunks.append(chunk)
            return message

        async def wrapped_send(message):
            if message["type"] == "http.response.start":
                status = int(message["status"])
                if status >= 400:
                    raw_body = b"".join(body_chunks)
                    try:
                        body_text = raw_body.decode("utf-8", errors="replace")
                    except Exception:
                        body_text = repr(raw_body)
                    if len(body_text) > self.max_body_chars:
                        body_text = body_text[: self.max_body_chars] + "...(truncated)"

                    headers = {
                        k.decode("latin-1").lower(): v.decode("latin-1")
                        for k, v in scope.get("headers", [])
                    }
                    log_warning(
                        "HTTP API error response",
                        status_code=status,
                        method=scope.get("method"),
                        path=scope.get("path"),
                        query_string=scope.get("query_string", b"").decode("latin-1"),
                        content_type=headers.get("content-type"),
                        accept=headers.get("accept"),
                        mcp_session_id=headers.get("mcp-session-id"),
                        request_body=body_text,
                    )
            await send(message)

        try:
            await self.app(scope, wrapped_receive, wrapped_send)
        except Exception as e:
            raw_body = b"".join(body_chunks)
            body_text = raw_body.decode("utf-8", errors="replace")
            if len(body_text) > self.max_body_chars:
                body_text = body_text[: self.max_body_chars] + "...(truncated)"
            log_error(
                "Unhandled HTTP API exception",
                method=scope.get("method"),
                path=scope.get("path"),
                query_string=scope.get("query_string", b"").decode("latin-1"),
                request_body=body_text,
                error=str(e),
            )
            raise


# ── Static assets (logos) ────────────────────────────────────────────────────
def _load_static_file(filename: str) -> bytes | None:
    """Load a static file from the project root or /app (Docker)."""
    for base in [Path(__file__).parent.parent, Path("/app")]:
        p = base / filename
        if p.exists():
            try:
                return p.read_bytes()
            except OSError:
                pass
    return None


_LOGO_H_BYTES: bytes | None = _load_static_file("static/logo-h.png")
_LOGO_S_BYTES: bytes | None = _load_static_file("static/logo-s.png")


# ── Admin SPA (admin-ui/dist) ────────────────────────────────────────────────
# Served only when ADMIN_UI=spa. The React build emits hashed, immutable assets
# under dist/assets/ plus a single index.html that drives client-side routing.
def _spa_dist_dir() -> Path | None:
    """Locate the built admin-ui/dist directory, or None if not built/deployed."""
    for base in [Path(__file__).parent.parent, Path("/app")]:
        candidate = base / "admin-ui" / "dist"
        if (candidate / "index.html").is_file():
            return candidate
    return None


def _load_spa_file(rel_path: str) -> tuple[bytes, str] | None:
    """Return (bytes, content_type) for a file under dist/, guarding against
    path traversal. ``rel_path`` is relative to dist/ (e.g. 'assets/index.js')."""
    dist = _spa_dist_dir()
    if dist is None:
        return None
    target = (dist / rel_path).resolve()
    try:
        target.relative_to(dist.resolve())
    except ValueError:
        return None  # traversal attempt
    if not target.is_file():
        return None
    content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    try:
        return target.read_bytes(), content_type
    except OSError:
        return None


# Shared HTML snippets injected into every page

_PRIVACY_HTML = """\
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="shortcut icon" type="image/png" href="/favicon.png">
  <title>Privacy Policy – Taiwan Health MCP Server</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; margin: 0; line-height: 1.7; color: #222;
           background: #fff; }
    nav { position: sticky; top: 0; background: #fff; border-bottom: 1px solid #e5e7eb;
          padding: 0 24px; z-index: 100; }
    .nav-inner { display: flex; align-items: center; max-width: 900px;
                 margin: 0 auto; padding: 10px 0; }
    .nav-inner img { height: 36px; display: block; }
    .wrap { max-width: 900px; margin: 0 auto; padding: 0 24px 48px; }
    h1 { font-size: 1.6rem; margin-top: 36px; margin-bottom: 4px; }
    h2 { font-size: 1.15rem; margin-top: 2rem; }
    p, li { font-size: 0.97rem; }
    code { background: #f4f4f4; padding: 1px 5px; border-radius: 3px; font-size: 0.9rem; }
    a { color: #0066cc; }
    @media (max-width: 600px) {
      nav { padding: 0 16px; }
      .wrap { padding: 0 16px 32px; }
      h1 { font-size: 1.25rem; margin-top: 24px; }
      h2 { font-size: 1.05rem; }
      p, li { font-size: 0.93rem; }
    }
  </style>
</head>
<body>
<nav>
  <div class="nav-inner">
    <a href="/"><img src="/logo-h.png" alt="HealthyMind Tech"></a>
  </div>
</nav>
<div class="wrap">
<h1>Privacy Policy – Taiwan Health MCP Server</h1>
<p><em>Effective date: 2025-01-01 &nbsp;|&nbsp; Last updated: 2026-04-09</em></p>

<h2>1. Overview</h2>
<p>Taiwan Health MCP Server is an open-source Model Context Protocol (MCP) server
that provides read-only access to Taiwan FDA health, ICD-10, LOINC, SNOMED CT,
and Taiwan clinical guideline data. All underlying modules are publicly available;
this service does not collect, store, or process personal health information.</p>

<h2>2. Data We Collect</h2>
<p>We do <strong>not</strong> collect any personally identifiable information (PII).
The server maintains an internal audit log (<code>audit.query_log</code>) for
operational monitoring purposes. Each audit record contains:</p>
<ul>
  <li>Tool name (e.g., <code>search_medical_codes</code>)</li>
  <li>SHA-256 hash of the tool parameters — <strong>not</strong> the raw values</li>
  <li>Request duration and status (success / error)</li>
  <li>Timestamp</li>
</ul>
<p>Raw parameter values are <strong>never</strong> written to logs. This design
ensures that patient-identifiable query terms cannot be reconstructed from the
audit trail.</p>

<h2>3. Data Sources</h2>
<p>All medical terminology data served by this API originates from publicly
available modules:</p>
<ul>
  <li>ICD-10-CM / ICD-10-PCS — U.S. National Library of Medicine / CMS (public domain)</li>
  <li>LOINC 2.80 — Regenstrief Institute (LOINC License, free for most uses)</li>
  <li>SNOMED CT International — SNOMED International (SNOMED License)</li>
  <li>Taiwan FDA health supplements and nutrition data — Taiwan FDA open data</li>
  <li>TWCore IG — Taiwan Ministry of Health and Welfare (public)</li>
</ul>

<h2>4. How Data Is Used</h2>
<p>Query results are returned directly to the requesting MCP client (Claude).
We do not use query data for training, profiling, advertising, or any purpose
other than fulfilling the immediate API request.</p>

<h2>5. Third-Party Data Processing</h2>
<p>When this server is accessed through Anthropic's Claude products, Anthropic
may collect telemetry on tool calls (including parameters and responses) per
their own privacy policy. Please refer to
<a href="https://www.anthropic.com/privacy">Anthropic's Privacy Policy</a>
for details.</p>
<p>This server does not share data with any other third parties.</p>

<h2>6. Data Retention</h2>
<p>Audit log records (SHA-256 hashes only) are retained for up to 90 days and
then deleted. Redis cache entries expire per configured TTL (1–24 hours).</p>

<h2>7. No Authentication Required</h2>
<p>This service does not require user accounts or authentication. We do not
store session tokens, cookies, or user identifiers of any kind.</p>

<h2>8. Your Rights</h2>
<p>Because we do not collect PII, there is no personal data to access, correct,
or delete. If you believe this server has inadvertently processed personal data,
please contact us at the address below.</p>

<h2>9. Changes to This Policy</h2>
<p>We may update this policy from time to time. The effective date at the top of
this page will reflect the most recent revision.</p>

<h2>10. Contact</h2>
<p>For privacy-related questions, please open an issue at
<a href="https://github.com/healthymind-tech/Taiwan-Health-MCP/issues">
github.com/healthymind-tech/Taiwan-Health-MCP</a> or email
<a href="mailto:support@healthymind-tech.com">support@healthymind-tech.com</a>.</p>
</div>
</body>
</html>
"""

_PRIVACY_HTML_BYTES = _PRIVACY_HTML.encode("utf-8")

_DPA_HTML = """\
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="shortcut icon" type="image/png" href="/favicon.png">
  <title>Data Processing Agreement – Taiwan Health MCP Server</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; margin: 0; line-height: 1.7; color: #222;
           background: #fff; }
    nav { position: sticky; top: 0; background: #fff; border-bottom: 1px solid #e5e7eb;
          padding: 0 24px; z-index: 100; }
    .nav-inner { display: flex; align-items: center; max-width: 900px;
                 margin: 0 auto; padding: 10px 0; }
    .nav-inner img { height: 36px; display: block; }
    .wrap { max-width: 900px; margin: 0 auto; padding: 0 24px 48px; }
    h1 { font-size: 1.6rem; margin-top: 36px; margin-bottom: 4px; }
    h2 { font-size: 1.15rem; margin-top: 2rem; }
    h3 { font-size: 1.0rem; margin-top: 1.4rem; }
    p, li { font-size: 0.97rem; }
    code { background: #f4f4f4; padding: 1px 5px; border-radius: 3px; font-size: 0.9rem; }
    .tbl-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 1rem 0; }
    table { border-collapse: collapse; width: 100%; min-width: 480px; }
    th, td { border: 1px solid #ddd; padding: 8px 12px; font-size: 0.95rem; }
    th { background: #f6f6f6; text-align: left; }
    a { color: #0066cc; }
    @media (max-width: 600px) {
      nav { padding: 0 16px; }
      .wrap { padding: 0 16px 32px; }
      h1 { font-size: 1.25rem; margin-top: 24px; }
      h2 { font-size: 1.05rem; }
      p, li { font-size: 0.93rem; }
      th, td { font-size: 0.85rem; padding: 6px 8px; }
    }
  </style>
</head>
<body>
<nav>
  <div class="nav-inner">
    <a href="/"><img src="/logo-h.png" alt="HealthyMind Tech"></a>
  </div>
</nav>
<div class="wrap">
<h1>Data Processing Agreement</h1>
<p><strong>Service:</strong> Taiwan Health MCP Server<br>
<strong>Operator:</strong> HealthyMind Tech<br>
<em>Effective date: 2025-01-01 &nbsp;|&nbsp; Last updated: 2026-04-09</em></p>

<h2>1. Parties and Scope</h2>
<p>This Data Processing Agreement ("DPA") applies between HealthyMind Tech
("Operator", "we", "us") and any individual or organisation ("User") accessing
the Taiwan Health MCP Server via Anthropic's Claude products or directly through
the MCP API. It describes how data flows through the server, what is retained,
and the obligations of each party.</p>

<h2>2. Nature of Processing</h2>
<p>Taiwan Health MCP Server is a <strong>read-only query API</strong> that provides
access to publicly available medical terminology and pharmaceutical modules.
It does not accept, store, or process personal health information submitted by
users. All 28 tools perform outbound database lookups against pre-loaded public
modules and return structured results to the MCP client.</p>

<h2>3. Categories of Data Processed</h2>
<div class="tbl-wrap"><table>
  <tr><th>Data category</th><th>Source</th><th>Retained by operator?</th></tr>
  <tr>
    <td>Tool call metadata (tool name, timestamp, duration, status)</td>
    <td>Generated internally</td>
    <td>Yes — audit log, 90 days</td>
  </tr>
  <tr>
    <td>SHA-256 hash of tool parameters</td>
    <td>Derived from request</td>
    <td>Yes — audit log, 90 days; raw values are <strong>never</strong> stored</td>
  </tr>
  <tr>
    <td>Medical terminology query strings (e.g. ICD codes, drug names)</td>
    <td>User / Claude client</td>
    <td>No — processed transiently; not written to storage</td>
  </tr>
  <tr>
    <td>Redis cache entries (query result payloads)</td>
    <td>Internal</td>
    <td>Temporarily — TTL 1–24 hours, then auto-deleted</td>
  </tr>
  <tr>
    <td>Personal health information</td>
    <td>—</td>
    <td>Not collected, not accepted</td>
  </tr>
</table></div>

<h2>4. Purpose and Legal Basis</h2>
<p>Data is processed solely to fulfil individual API requests from the MCP client.
There is no secondary use: query data is not used for model training, profiling,
analytics, advertising, or any purpose beyond returning the immediate response.</p>
<p>The legal basis for processing operational logs (tool name, hash, timing) is
<strong>legitimate interest</strong> in operating a reliable, auditable service.</p>

<h2>5. Data Minimisation and HIPAA Design</h2>
<p>The audit logger (<code>src/audit.py</code>) records only the SHA-256 hash of
parameters — never the raw values. This design ensures that patient-identifiable
query terms (e.g. a patient's ICD code or medication name) cannot be reconstructed
from the audit trail, consistent with HIPAA safe-harbour de-identification
requirements.</p>

<h2>6. Sub-processors</h2>
<div class="tbl-wrap"><table>
  <tr><th>Sub-processor</th><th>Role</th><th>Data shared</th></tr>
  <tr>
    <td>PostgreSQL 16 (self-hosted)</td>
    <td>Primary data store for terminology modules</td>
    <td>Query strings (transient, in-process only)</td>
  </tr>
  <tr>
    <td>Redis 7 (self-hosted)</td>
    <td>Response cache</td>
    <td>Serialised query result payloads (TTL-bound)</td>
  </tr>
  <tr>
    <td>Anthropic</td>
    <td>MCP platform / Claude client</td>
    <td>Tool call parameters and responses, per
      <a href="https://www.anthropic.com/privacy">Anthropic's Privacy Policy</a></td>
  </tr>
</table></div>
<p>All infrastructure (PostgreSQL, Redis) is operated by the Operator on
self-managed servers. No data is sent to external cloud sub-processors except
via Anthropic's platform as described above.</p>

<h2>7. International Transfers</h2>
<p>The server is hosted in Taiwan. Tool call data passed through Anthropic's
platform may be processed in the United States or other jurisdictions per
Anthropic's data processing terms. The Operator does not independently transfer
data outside Taiwan.</p>

<h2>8. Security Measures</h2>
<ul>
  <li>All HTTP traffic is served over TLS (HTTPS).</li>
  <li>Database and cache are network-isolated (Docker internal network, not exposed to public internet).</li>
  <li>pgBouncer connection pooler limits database exposure.</li>
  <li>Prometheus metrics endpoint is internal only.</li>
  <li>Audit log is append-only and stored in a dedicated PostgreSQL schema (<code>audit</code>).</li>
</ul>

<h2>9. Data Subject Rights</h2>
<p>Because the Operator does not collect personally identifiable information,
there is no personal data subject to access, rectification, erasure, or
portability requests under GDPR or similar regulations. If you believe this
server has inadvertently processed personal data, contact us at the address
in Section 12 and we will investigate within 30 days.</p>

<h2>10. Breach Notification</h2>
<p>In the event of a confirmed data security incident affecting user data, the
Operator will notify affected users and, where required by applicable law,
relevant supervisory authorities, within 72 hours of becoming aware of the
breach.</p>

<h2>11. Retention and Deletion</h2>
<ul>
  <li><strong>Audit logs</strong> — retained for 90 days, then deleted by a scheduled purge job.</li>
  <li><strong>Redis cache</strong> — entries expire automatically per configured TTL (1–24 hours).</li>
  <li><strong>Terminology modules</strong> — static public data; not subject to deletion requests.</li>
</ul>

<h2>12. Contact and Governing Law</h2>
<p>For data processing questions or concerns:</p>
<ul>
  <li>GitHub Issues:
    <a href="https://github.com/healthymind-tech/Taiwan-Health-MCP/issues">
    github.com/healthymind-tech/Taiwan-Health-MCP/issues</a></li>
  <li>Email: <a href="mailto:support@healthymind-tech.com">support@healthymind-tech.com</a></li>
</ul>
<p>This agreement is governed by the laws of Taiwan (R.O.C.). Any dispute shall
be subject to the exclusive jurisdiction of the Taiwan Taipei District Court.</p>

<h2>13. Changes to This Agreement</h2>
<p>We may update this DPA from time to time. The effective date at the top of
this page reflects the most recent revision. Continued use of the service after
an update constitutes acceptance of the revised terms.</p>
</div>
</body>
</html>
"""

_DPA_HTML_BYTES = _DPA_HTML.encode("utf-8")

_LANDING_HTML = """\
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="shortcut icon" type="image/png" href="/favicon.png">
  <title>Taiwan Health MCP Server</title>
  <meta name="color-scheme" content="light dark">
  <script>
    (function () {
      try {
        var t = localStorage.getItem('admin-theme');
        if (t !== 'light' && t !== 'dark') {
          t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        }
        document.documentElement.dataset.theme = t;
      } catch (e) {}
    })();
  </script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; color: #1a1a1a;
           background: #fff; line-height: 1.7; }

    /* ── nav ── */
    nav { position: sticky; top: 0; background: #fff; border-bottom: 1px solid #e5e7eb;
          padding: 0 24px; z-index: 100; }
    .nav-inner { display: flex; align-items: center; gap: 24px; max-width: 900px;
                 margin: 0 auto; padding: 10px 0; flex-wrap: wrap; }
    .nav-logo img { height: 36px; display: block; }
    nav ul { display: flex; gap: 24px; list-style: none; flex-wrap: wrap;
             margin: 0; padding: 0; }
    nav a { text-decoration: none; color: #444; font-size: 0.9rem; }
    nav a:hover { color: #0066cc; }

    /* ── layout ── */
    .wrap { max-width: 900px; margin: 0 auto; padding: 0 24px; }
    section { padding: 56px 0; border-bottom: 1px solid #f0f0f0; }
    section:last-of-type { border-bottom: none; }

    /* ── hero ── */
    .hero { padding: 72px 0 56px; }
    .hero h1 { font-size: 2.2rem; font-weight: 700; line-height: 1.25;
               margin-bottom: 16px; }
    .hero h1 span { color: #0066cc; }
    .hero p.tagline { font-size: 1.1rem; color: #555; max-width: 640px;
                      margin-bottom: 28px; }
    .endpoint-box { display: inline-flex; align-items: center; gap: 10px;
                    background: #f4f7fb; border: 1px solid #d0daea;
                    border-radius: 8px; padding: 10px 18px; font-size: 0.9rem; }
    .endpoint-box .label { color: #666; }
    .endpoint-box code { color: #0055aa; font-size: 0.88rem;
                         word-break: break-all; }
    .badge-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 20px; }
    .badge { background: #e8f0fe; color: #1a56cc; border-radius: 20px;
             padding: 3px 12px; font-size: 0.82rem; font-weight: 500; }

    /* ── headings ── */
    h2 { font-size: 1.45rem; font-weight: 700; margin-bottom: 20px; }
    h3 { font-size: 1.05rem; font-weight: 600; margin-bottom: 8px; }

    /* ── feature grid ── */
    .feature-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px,1fr));
                    gap: 20px; }
    .feature-card { border: 1px solid #e5e7eb; border-radius: 10px;
                    padding: 20px 22px; }
    .feature-card .icon { font-size: 1.6rem; margin-bottom: 10px; }
    .feature-card ul { padding-left: 18px; font-size: 0.93rem; color: #444;
                       margin-top: 8px; }
    .feature-card li { margin-bottom: 4px; }

    /* ── module table ── */
    table { width: 100%; border-collapse: collapse; font-size: 0.93rem;
            margin-top: 12px; }
    th, td { border: 1px solid #e0e0e0; padding: 9px 14px; text-align: left; }
    th { background: #f6f8fb; font-weight: 600; }

    /* ── examples ── */
    .example { border: 1px solid #e5e7eb; border-radius: 10px;
               overflow: hidden; margin-bottom: 20px; }
    .example-header { background: #f6f8fb; padding: 10px 18px;
                      font-weight: 600; font-size: 0.9rem; color: #333;
                      border-bottom: 1px solid #e5e7eb; }
    .example-body { padding: 16px 18px; }
    .prompt { background: #fff8e6; border-left: 3px solid #f5a623;
              border-radius: 4px; padding: 8px 14px; font-size: 0.92rem;
              margin-bottom: 14px; }
    .prompt strong { color: #b8860b; font-size: 0.8rem; display: block;
                     margin-bottom: 2px; }
    .steps { padding-left: 18px; font-size: 0.92rem; color: #444; }
    .steps li { margin-bottom: 4px; }

    /* ── setup steps ── */
    .setup-steps { counter-reset: step; display: flex; flex-direction: column;
                   gap: 16px; }
    .setup-step { display: flex; gap: 16px; align-items: flex-start; }
    .setup-step .num { min-width: 32px; height: 32px; border-radius: 50%;
                       background: #0066cc; color: #fff; display: flex;
                       align-items: center; justify-content: center;
                       font-size: 0.85rem; font-weight: 700; margin-top: 2px; }
    .setup-step .text { font-size: 0.95rem; }
    .setup-step .text p { margin: 0; }
    code.inline { background: #f4f4f4; padding: 1px 6px; border-radius: 4px;
                  font-size: 0.88rem; }

    /* ── auth notice ── */
    .auth-notice { background: #f0fdf4; border: 1px solid #86efac;
                   border-radius: 8px; padding: 16px 20px; }
    .auth-notice strong { color: #166534; }

    /* ── links section ── */
    .link-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px,1fr));
                 gap: 14px; }
    .link-card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px 18px;
                 text-decoration: none; color: inherit;
                 transition: border-color 0.15s; display: block; }
    .link-card:hover { border-color: #0066cc; }
    .link-card .link-title { font-weight: 600; font-size: 0.95rem;
                             color: #0066cc; margin-bottom: 4px; }
    .link-card .link-desc { font-size: 0.85rem; color: #666; }

    /* ── footer ── */
    footer { text-align: center; padding: 32px 24px; color: #888;
             font-size: 0.85rem; border-top: 1px solid #f0f0f0; }
    footer a { color: #0066cc; text-decoration: none; }

    /* ── table scroll ── */
    .tbl-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .tbl-wrap table { min-width: 520px; }

    @media (max-width: 768px) {
      .hero { padding: 48px 0 36px; }
      .hero h1 { font-size: 1.8rem; }
      section { padding: 40px 0; }
      .feature-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 600px) {
      .hero h1 { font-size: 1.4rem; }
      .hero p.tagline { font-size: 1rem; }
      .endpoint-box { flex-direction: column; align-items: flex-start; gap: 4px; }
      .nav-inner { gap: 12px; padding: 8px 0; }
      .nav-logo img { height: 28px; }
      nav ul { gap: 10px; }
      nav a { font-size: 0.82rem; }
      h2 { font-size: 1.2rem; }
      section { padding: 32px 0; }
      .link-grid { grid-template-columns: 1fr 1fr; }
      footer { font-size: 0.8rem; padding: 24px 16px; }
    }
    @media (max-width: 400px) {
      .link-grid { grid-template-columns: 1fr; }
    }

    /* ── dark mode (follows admin-theme localStorage, else OS preference) ── */
    [data-theme="dark"] body { background: #0f1115; color: #e6e8eb; }
    [data-theme="dark"] nav { background: #15181e; border-bottom-color: #262b35; }
    [data-theme="dark"] nav a { color: #b8c0cc; }
    [data-theme="dark"] nav a:hover { color: #5aa2ff; }
    [data-theme="dark"] section { border-bottom-color: #1d2129; }
    [data-theme="dark"] .hero h1 span { color: #5aa2ff; }
    [data-theme="dark"] .hero p.tagline { color: #aab2bf; }
    [data-theme="dark"] .endpoint-box { background: #161b22; border-color: #2b3340; }
    [data-theme="dark"] .endpoint-box .label { color: #9aa3b2; }
    [data-theme="dark"] .endpoint-box code { color: #7cb7ff; }
    [data-theme="dark"] .badge { background: #16263f; color: #7cb7ff; }
    [data-theme="dark"] h2, [data-theme="dark"] h3 { color: #e6e8eb; }
    [data-theme="dark"] .feature-card { border-color: #262b35; background: #13161c; }
    [data-theme="dark"] .feature-card ul { color: #aab2bf; }
    [data-theme="dark"] th, [data-theme="dark"] td { border-color: #2b3340; }
    [data-theme="dark"] th { background: #161b22; }
    [data-theme="dark"] .example { border-color: #262b35; }
    [data-theme="dark"] .example-header { background: #161b22; color: #cfd5de;
                                          border-bottom-color: #262b35; }
    [data-theme="dark"] .prompt { background: #2a2410; border-left-color: #b8860b; }
    [data-theme="dark"] .prompt strong { color: #e0b84d; }
    [data-theme="dark"] .steps { color: #aab2bf; }
    [data-theme="dark"] code.inline { background: #1b1f27; color: #e0b84d; }
    [data-theme="dark"] .auth-notice { background: #10231a; border-color: #1f5135; }
    [data-theme="dark"] .auth-notice strong { color: #6ee7a0; }
    [data-theme="dark"] .link-card { border-color: #262b35; }
    [data-theme="dark"] .link-card:hover { border-color: #5aa2ff; }
    [data-theme="dark"] .link-card .link-title { color: #5aa2ff; }
    [data-theme="dark"] .link-card .link-desc { color: #9aa3b2; }
    [data-theme="dark"] footer { color: #7d8694; border-top-color: #1d2129; }
    [data-theme="dark"] footer a { color: #5aa2ff; }
  </style>
</head>
<body>

<nav>
  <div class="nav-inner">
    <div class="nav-logo">
      <a href="/"><img src="/logo-h.png" alt="HealthyMind Tech"></a>
    </div>
    <ul>
      <li><a href="#description">Overview</a></li>
      <li><a href="#features">Features</a></li>
      <li><a href="#modules">Modules</a></li>
      <li><a href="#examples">Examples</a></li>
      <li><a href="#setup">Setup</a></li>
      <li><a href="#authentication">Auth</a></li>
      <li><a href="#support">Support</a></li>
      <li><a href="/status">Status</a></li>
    </ul>
  </div>
</nav>

<!-- ── Hero ── -->
<section class="hero" id="top">
  <div class="wrap">
    <h1>Taiwan Health<br><span>MCP Server</span></h1>
    <p class="tagline">
      An open-source Model Context Protocol server that gives AI assistants
      structured, read-only access to Taiwan's medical and clinical knowledge
      for Taiwan healthcare workflows.
    </p>
    <div class="endpoint-box">
      <span class="label">MCP endpoint</span>
      <code>https://tw-health-mcp.healthymind-tech.com/mcp</code>
    </div>
    <div class="badge-row">
      <span class="badge">24 Tools</span>
      <span class="badge">ICD-10-CM 2025</span>
      <span class="badge">LOINC 2.80</span>
      <span class="badge">SNOMED CT</span>
      <span class="badge">Taiwan FDA</span>
      <span class="badge">TWCore IG v1.0</span>
      <span class="badge">FHIR R4</span>
    </div>
  </div>
</section>

<!-- ── Description ── -->
<section id="description">
  <div class="wrap">
    <h2>Description</h2>
    <p>
      Taiwan Health MCP Server connects Claude to authoritative medical and
      health modules curated for Taiwan's healthcare system. Clinicians,
      researchers, developers, and health-tech products can query ICD-10 diagnoses
      and procedures, look up LOINC lab codes and reference ranges, navigate
      SNOMED CT concept hierarchies, search Taiwan FDA health supplements, access
      clinical practice guidelines, and generate FHIR R4-compliant resources
      — all through natural language conversation with Claude.
    </p>
    <p style="margin-top:12px;">
      All underlying modules are publicly available. The server does
      <strong>not</strong> collect, store, or process personal health information.
      Audit logs record only tool names and SHA-256 parameter hashes, never raw values.
    </p>
  </div>
</section>

<!-- ── Features ── -->
<section id="features">
  <div class="wrap">
    <h2>Features</h2>
    <div class="feature-grid">

      <div class="feature-card">
        <div class="icon">🏥</div>
        <h3>Medical Coding</h3>
        <p style="font-size:0.93rem;color:#555;">
          Hybrid BM25 + semantic search across ICD-10-CM/PCS 2025,
          SNOMED CT International, and LOINC 2.80.
        </p>
        <ul>
          <li>Diagnosis &amp; procedure code search</li>
          <li>SNOMED concept hierarchy traversal</li>
          <li>ICD ↔ SNOMED cross-mapping</li>
          <li>LOINC lab code lookup by name, specimen, or component</li>
          <li>Nearby codes &amp; complication inference</li>
        </ul>
      </div>

      <div class="feature-card">
      <div class="icon">🧪</div>
      <h3>Lab Interpretation</h3>
        <p style="font-size:0.93rem;color:#555;">
          Reference ranges and clinical interpretation for LOINC-coded
          lab results, with age- and gender-specific thresholds.
        </p>
        <ul>
          <li>Single &amp; batch result interpretation</li>
          <li>Normal / abnormal / critical flagging</li>
          <li>Gender- and age-specific reference ranges</li>
          <li>Patient-friendly name lookup</li>
          <li>Related test discovery</li>
        </ul>
      </div>

      <div class="feature-card">
        <div class="icon">📋</div>
        <h3>Clinical Guidelines</h3>
        <p style="font-size:0.93rem;color:#555;">
          Taiwan clinical practice guidelines linked to ICD codes,
          with medication recommendations and treatment goals.
        </p>
        <ul>
          <li>Guideline search by ICD code or keyword</li>
          <li>Medication &amp; test recommendations</li>
          <li>Treatment goals per condition</li>
          <li>Contraindication checking</li>
          <li>Clinical pathway suggestion</li>
        </ul>
      </div>

      <div class="feature-card">
        <div class="icon">🍎</div>
        <h3>Food &amp; Nutrition</h3>
        <p style="font-size:0.93rem;color:#555;">
          Taiwan FDA health supplements registry and food nutrition composition
          database, with meal-level analysis.
        </p>
        <ul>
          <li>Health supplements product search &amp; details</li>
          <li>Food nutrition lookup (per 100 g)</li>
          <li>Meal nutrition analysis (multi-food)</li>
          <li>Nutrient-ranked food search</li>
          <li>Ingredient &amp; additive lookup</li>
        </ul>
      </div>

      <div class="feature-card">
        <div class="icon">⚕️</div>
        <h3>FHIR R4</h3>
        <p style="font-size:0.93rem;color:#555;">
          Generate, validate, and search FHIR R4 resources aligned
          with TWCore IG v1.0.0.
        </p>
        <ul>
          <li>Condition resource generation</li>
          <li>FHIR resource validation</li>
          <li>TWCore CodeSystem lookup &amp; search</li>
          <li>Diagnosis-to-FHIR one-step conversion</li>
        </ul>
      </div>

    </div>
  </div>
</section>

<!-- ── Modules ── -->
<section id="modules">
  <div class="wrap">
    <h2>Modules</h2>
    <div class="tbl-wrap"><table>
      <tr>
        <th>Module</th><th>Version / Source</th><th>Sync</th>
      </tr>
      <tr>
        <td>ICD-10-CM &amp; ICD-10-PCS</td>
        <td>FY 2025 — CMS / NLM (public domain)</td>
        <td>Static (data-loader)</td>
      </tr>
      <tr>
        <td>LOINC</td>
        <td>2.80 — Regenstrief Institute</td>
        <td>Static (data-loader)</td>
      </tr>
      <tr>
        <td>SNOMED CT International</td>
        <td>Latest RF2 — SNOMED International</td>
        <td>Static (data-loader)</td>
      </tr>
      <tr>
        <td>Taiwan FDA Health Supplements</td>
        <td>Open Data — Taiwan FDA</td>
        <td>Auto-sync every Monday 02:30 UTC</td>
      </tr>
      <tr>
        <td>Taiwan Food Nutrition</td>
        <td>Open Data — Taiwan FDA</td>
        <td>Auto-sync every Monday 03:00 UTC</td>
      </tr>
      <tr>
        <td>TWCore IG</td>
        <td>v1.0.0 — Taiwan MoHW</td>
        <td>Static + live fetch fallback</td>
      </tr>
      <tr>
        <td>Taiwan Clinical Guidelines</td>
        <td>Curated seed data</td>
        <td>Static (data-loader)</td>
      </tr>
    </table></div>
  </div>
</section>

<!-- ── Examples ── -->
<section id="examples">
  <div class="wrap">
    <h2>Examples</h2>

    <div class="example">
      <div class="example-header">Example 1 — Diagnosis lookup &amp; clinical guidance</div>
      <div class="example-body">
        <div class="prompt">
          <strong>User prompt</strong>
          "我的病人診斷是 E11.9，幫我查詢對應的用藥建議和治療目標"
        </div>
        <ol class="steps">
          <li>Server searches ICD-10 for <code>E11.9</code> (Type 2 diabetes without complications)</li>
          <li>Fetches Taiwan clinical guideline for E11 — medication recommendations &amp; treatment goals</li>
          <li>Maps E11.9 to SNOMED CT concept 44054006 for semantic context</li>
          <li>Returns structured recommendations: first-line medications, HbA1c target, monitoring schedule</li>
        </ol>
      </div>
    </div>

    <div class="example">
      <div class="example-header">Example 2 — Lab result interpretation</div>
      <div class="example-body">
        <div class="prompt">
          <strong>User prompt</strong>
          "病人 HbA1c 8.2%、空腹血糖 176 mg/dL、肌酸酐 1.4，幫我解讀這些數值"
        </div>
        <ol class="steps">
          <li>Server identifies LOINC codes: 4548-4 (HbA1c), 1558-6 (fasting glucose), 2160-0 (creatinine)</li>
          <li>Runs batch lab interpretation with patient age/gender context</li>
          <li>Returns per-result flags (H / critical), reference ranges, and clinical significance</li>
          <li>HbA1c flagged as above target; creatinine mildly elevated — suggests CKD monitoring</li>
        </ol>
      </div>
    </div>

    <div class="example">
      <div class="example-header">Example 3 — FHIR resource generation</div>
      <div class="example-body">
        <div class="prompt">
          <strong>User prompt</strong>
          "幫我把診斷 E11.9 轉成 TWCore FHIR 格式"
        </div>
        <ol class="steps">
          <li>Server calls <code>query_fhir_condition</code> for E11.9</li>
          <li>Generates a TWCore-compliant FHIR Condition resource with ICD-10 coding</li>
          <li>Applies optional status fields such as clinical and verification status</li>
          <li>Returns valid FHIR R4 JSON ready for EMR integration</li>
        </ol>
      </div>
    </div>

    <div class="example">
      <div class="example-header">Example 4 — Nutrition analysis</div>
      <div class="example-body">
        <div class="prompt">
          <strong>User prompt</strong>
          "糖尿病病人的午餐：白米飯、雞胸肉、青花菜，幫我分析營養成分"
        </div>
        <ol class="steps">
          <li>Server queries Taiwan FDA food nutrition database for all three items</li>
          <li>Aggregates macronutrients: calories, carbohydrates, protein, fat, fiber per 100 g</li>
          <li>Returns per-food breakdown plus combined totals</li>
          <li>Highlights carbohydrate content relevant for diabetes meal planning</li>
        </ol>
      </div>
    </div>

    <div class="example">
      <div class="example-header">Example 5 — Health supplement search</div>
      <div class="example-body">
        <div class="prompt">
          <strong>User prompt</strong>
          "幫我找有調節血脂功效的台灣健康補充品"
        </div>
        <ol class="steps">
          <li>Server searches the Taiwan FDA health supplement registry by benefit keywords</li>
          <li>Ranks certified products by product name, ingredients, and approved claims</li>
          <li>Returns permit number, company, ingredients, and approved benefit text</li>
          <li>Helps narrow candidates for further clinical or regulatory review</li>
        </ol>
      </div>
    </div>

  </div>
</section>

<!-- ── Setup ── -->
<section id="setup">
  <div class="wrap">
    <h2>Setup</h2>
    <div class="setup-steps">
      <div class="setup-step">
        <div class="num">1</div>
        <div class="text">
          <p>Visit the <strong>Anthropic MCP Directory</strong> at
          <a href="https://claude.com/connectors">claude.com/connectors</a>.</p>
        </div>
      </div>
      <div class="setup-step">
        <div class="num">2</div>
        <div class="text">
          <p>Search for <strong>"Taiwan Health"</strong> and select
          <em>Taiwan Health MCP Server</em>.</p>
        </div>
      </div>
      <div class="setup-step">
        <div class="num">3</div>
        <div class="text">
          <p>Click <strong>Connect</strong>. No account or OAuth required —
          the server is publicly accessible.</p>
        </div>
      </div>
      <div class="setup-step">
        <div class="num">4</div>
        <div class="text">
          <p>Alternatively, connect directly in Claude Desktop by adding the
          MCP endpoint to your config:<br>
          <code class="inline">https://tw-health-mcp.healthymind-tech.com/mcp</code></p>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- ── Authentication ── -->
<section id="authentication">
  <div class="wrap">
    <h2>Authentication</h2>
    <div class="auth-notice">
      <strong>&#10003; No authentication required.</strong>
      <p style="margin-top:8px;font-size:0.95rem;">
        Taiwan Health MCP Server provides read-only access to publicly available
        modules. No account, API key, or OAuth flow is needed. Simply connect
        and start querying.
      </p>
    </div>
    <p style="margin-top:16px;font-size:0.93rem;color:#555;">
      All 28 tools are read-only. The server does not accept writes, does not
      require a user session, and does not store any identifying information
      about callers.
    </p>
  </div>
</section>

<!-- ── Support ── -->
<section id="support">
  <div class="wrap">
    <h2>Support &amp; Links</h2>
    <div class="link-grid">
      <a class="link-card"
         href="https://github.com/healthymind-tech/Taiwan-Health-MCP">
        <div class="link-title">GitHub Repository</div>
        <div class="link-desc">Source code, issues, and contributions</div>
      </a>
      <a class="link-card"
         href="https://github.com/healthymind-tech/Taiwan-Health-MCP/issues">
        <div class="link-title">Report an Issue</div>
        <div class="link-desc">Bug reports and feature requests</div>
      </a>
      <a class="link-card" href="/status">
        <div class="link-title">Status &amp; Tool Tester</div>
        <div class="link-desc">Live tool availability and interactive tester</div>
      </a>
      <a class="link-card" href="/privacy">
        <div class="link-title">Privacy Policy</div>
        <div class="link-desc">How we handle data and audit logs</div>
      </a>
      <a class="link-card" href="/dpa">
        <div class="link-title">Data Processing Agreement</div>
        <div class="link-desc">Sub-processors, retention, and security</div>
      </a>
      <a class="link-card"
         href="mailto:support@healthymind-tech.com">
        <div class="link-title">Email Support</div>
        <div class="link-desc">support@healthymind-tech.com</div>
      </a>
    </div>
  </div>
</section>

<footer>
  <p>Taiwan Health MCP Server &nbsp;&middot;&nbsp;
     Open source under MIT License &nbsp;&middot;&nbsp;
     <a href="/status">Status</a> &nbsp;&middot;&nbsp;
     <a href="/privacy">Privacy</a> &nbsp;&middot;&nbsp;
     <a href="/dpa">DPA</a> &nbsp;&middot;&nbsp;
     <a href="https://github.com/healthymind-tech/Taiwan-Health-MCP">GitHub</a>
  </p>
</footer>

</body>
</html>
"""

_LANDING_HTML_BYTES = _LANDING_HTML.encode("utf-8")

# ---------------------------------------------------------------------------
# Status page — tool registry and tester
# ---------------------------------------------------------------------------

_TOOL_GROUPS: dict[str, dict[str, object]] = {
    "icd": {
        "category": "ICD-10",
        "tools": [
            (
                "search_medical_codes",
                "search_medical_codes",
                {"keyword": "第二型糖尿病", "type": "diagnosis", "limit": 5},
            ),
            (
                "search_medical_codes",
                "search_medical_codes",
                {"keyword": "Tracheostomy", "type": "procedure", "limit": 5},
            ),
            (
                "search_medical_codes",
                "search_medical_codes",
                {"keyword": "diabetes", "type": "all", "limit": 5},
            ),
            ("infer_complications", "infer_complications", {"code": "E11"}),
            ("get_nearby_codes", "get_nearby_codes", {"code": "E11.9"}),
            (
                "check_medical_conflict",
                "check_medical_conflict",
                {"diagnosis_code": "E11.9", "procedure_code": "0BH17EZ"},
            ),
            ("browse_icd_category", "browse_icd_category", {"category": "E11"}),
        ],
    },
    "drug": {
        "category": "Drug / TFDA",
        "tools": [
            (
                "search_drug",
                "search_drug",
                {"mode": "drug_name", "keyword": "普拿疼", "limit": 5},
            ),
            (
                "search_drug",
                "search_drug",
                {"mode": "ingredient", "keyword": "acetaminophen", "limit": 5},
            ),
            (
                "search_drug",
                "search_drug",
                {"mode": "license_id", "keyword": "000029"},
            ),
            (
                "search_drug",
                "search_drug",
                {"mode": "atc_code", "keyword": "N02BE01", "limit": 5},
            ),
            (
                "identify_unknown_pill",
                "identify_unknown_pill",
                {"features": "white round"},
            ),
            (
                "get_drug_details",
                "get_drug_details",
                {"license_id": "衛署藥製字第000480號"},
            ),
            (
                "get_drug_asset_links",
                "get_drug_asset_links",
                {"license_id": "衛署藥製字第000480號", "asset_group": "insert"},
            ),
        ],
    },
    "lab": {
        "category": "Lab / LOINC",
        "tools": [
            (
                "search_loinc",
                "search_loinc",
                {"mode": "code", "keyword": "glucose", "category": "CHEM", "limit": 5},
            ),
            (
                "search_loinc",
                "search_loinc",
                {"mode": "category", "keyword": "CHE", "limit": 5},
            ),
            (
                "search_loinc",
                "search_loinc",
                {"mode": "specimen", "keyword": "Urine", "limit": 5},
            ),
            (
                "search_loinc",
                "search_loinc",
                {"mode": "component", "keyword": "Glucose", "limit": 5},
            ),
            (
                "query_loinc",
                "query_loinc",
                {"mode": "detail", "loinc_code": "2345-7"},
            ),
            (
                "query_loinc",
                "query_loinc",
                {
                    "mode": "reference_range",
                    "loinc_code": "2345-7",
                    "age": 45,
                    "gender": "M",
                },
            ),
            (
                "interpret_lab_result",
                "interpret_lab_result",
                {"loinc_code": "2345-7", "value": 126, "age": 45, "gender": "M"},
            ),
            (
                "batch_interpret_lab_results",
                "batch_interpret_lab_results",
                {
                    "results_json": '[{"loinc_code":"2345-7","value":126},{"loinc_code":"4548-4","value":7.2},{"loinc_code":"718-7","value":13.5}]',
                    "age": 45,
                    "gender": "M",
                },
            ),
        ],
    },
    "guideline": {
        "category": "Guidelines",
        "tools": [
            (
                "search_clinical_guideline",
                "search_clinical_guideline",
                {"keyword": "糖尿病"},
            ),
            (
                "query_guideline",
                "query_guideline",
                {"icd_code": "E11", "section": "medication"},
            ),
        ],
    },
    "snomed": {
        "category": "SNOMED CT",
        "tools": [
            (
                "search_snomed_concept",
                "search_snomed_concept",
                {"query": "diabetes mellitus", "limit": 5},
            ),
            ("query_snomed_concept", "query_snomed_concept", {"concept_id": 73211009}),
            (
                "get_snomed_relationships",
                "get_snomed_relationships",
                {"concept_id": 73211009},
            ),
            (
                "query_snomed_mapping",
                "query_snomed_mapping",
                {"mode": "icd", "keyword": "E11.9"},
            ),
            (
                "query_snomed_mapping",
                "query_snomed_mapping",
                {"mode": "snomed", "keyword": "44054006"},
            ),
        ],
    },
    "fhir_condition": {
        "category": "FHIR R4",
        "tools": [
            (
                "query_fhir_condition",
                "query_fhir_condition",
                {"diagnosis_keyword": "第二型糖尿病", "patient_id": "patient-001"},
            ),
            (
                "validate_fhir_condition",
                "validate_fhir_condition",
                {
                    "condition_json": '{"resourceType":"Condition","subject":{"reference":"Patient/patient-001"},"code":{"coding":[{"system":"http://hl7.org/fhir/sid/icd-10-cm","code":"E11.9","display":"Type 2 diabetes mellitus without complications"}]},"clinicalStatus":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/condition-clinical","code":"active"}]},"verificationStatus":{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/v3-ActCode","code":"confirmed"}]}}'
                },
            ),
        ],
    },
    "fhir_medication": {
        "category": "FHIR R4",
        "tools": [
            (
                "query_fhir_medication",
                "query_fhir_medication",
                {"keyword": "普拿疼", "resource_type": "Medication"},
            ),
            (
                "query_fhir_medication",
                "query_fhir_medication",
                {
                    "license_id": "衛署藥製字第000480號",
                    "resource_type": "MedicationKnowledge",
                },
            ),
            (
                "validate_fhir_medication",
                "validate_fhir_medication",
                {
                    "medication_json": '{"resourceType":"Medication","code":{"coding":[{"system":"https://mcp.fda.gov.tw/fhir/CodeSystem/tfda-license-id","code":"衛署藥製字第000480號","display":"Test Drug"}]},"ingredient":[{"itemCodeableConcept":{"text":"Acetaminophen"}}]}'
                },
            ),
        ],
    },
    "ig": {
        "category": "FHIR IG",
        "tools": [
            ("fhir_list_igs", "fhir_list_igs", {}),
            ("fhir_get_ig", "fhir_get_ig", {}),
            (
                "fhir_list_artifacts",
                "fhir_list_artifacts",
                {"resource_type": "StructureDefinition"},
            ),
            (
                "fhir_search_artifacts",
                "fhir_search_artifacts",
                {"keyword": "Patient"},
            ),
            (
                "fhir_list_resource_profiles",
                "fhir_list_resource_profiles",
                {"base_type": "Condition"},
            ),
            (
                "fhir_rank_resource_profiles",
                "fhir_rank_resource_profiles",
                {"keys": ["code", "subject", "onset"], "base_type": "Condition"},
            ),
            (
                "fhir_get_profile",
                "fhir_get_profile",
                {"identifier": "Condition-twcore"},
            ),
            (
                "fhir_get_profile_elements",
                "fhir_get_profile_elements",
                {
                    "profile": "Condition-twcore",
                    "view": "choices",
                    "path": "Condition.onset[x]",
                },
            ),
            (
                "fhir_get_valueset",
                "fhir_get_valueset",
                {"identifier": "condition-code-sct-tw"},
            ),
            (
                "fhir_expand_valueset",
                "fhir_expand_valueset",
                {"identifier": "condition-code-sct-tw", "limit": 50},
            ),
            (
                "fhir_lookup_code",
                "fhir_lookup_code",
                {"system": "http://snomed.info/sct", "code": "6142004"},
            ),
            (
                "fhir_validate_code",
                "fhir_validate_code",
                {
                    "system": "http://snomed.info/sct",
                    "code": "6142004",
                    "value_set": "condition-code-sct-tw",
                },
            ),
            (
                "fhir_normalize_code",
                "fhir_normalize_code",
                {"text": "流行性感冒", "value_set": "condition-code-sct-tw"},
            ),
            (
                "fhir_resolve_reference",
                "fhir_resolve_reference",
                {"key": "patient-1", "resource_type": "Patient"},
            ),
            (
                "fhir_build_bundle",
                "fhir_build_bundle",
                {
                    "entries": [
                        {"key": "patient-1", "resource": {"resourceType": "Patient"}}
                    ],
                    "bundle_type": "transaction",
                },
            ),
            (
                "fhir_validate_resource",
                "fhir_validate_resource",
                {
                    "resource": {
                        "resourceType": "Condition",
                        "meta": {
                            "profile": [
                                "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/Condition-twcore"
                            ]
                        },
                    }
                },
            ),
            (
                "fhir_validate_bundle",
                "fhir_validate_bundle",
                {
                    "bundle": {
                        "resourceType": "Bundle",
                        "type": "transaction",
                        "entry": [],
                    }
                },
            ),
            (
                "fhir_get_resource_skeleton",
                "fhir_get_resource_skeleton",
                {"profile": "Condition-twcore"},
            ),
            (
                "fhir_finalize_resource",
                "fhir_finalize_resource",
                {
                    "profile": "Condition-twcore",
                    "draft": {"resourceType": "Condition"},
                },
            ),
        ],
    },
    "health_supplements": {
        "category": "Health Supplements",
        "tools": [
            (
                "search_health_supplements",
                "search_health_supplements",
                {"mode": "keyword", "keyword": "魚油", "limit": 5},
            ),
            (
                "search_health_supplements",
                "search_health_supplements",
                {"mode": "permit_no", "keyword": "A00022"},
            ),
            (
                "search_health_supplements",
                "search_health_supplements",
                {"mode": "condition", "keyword": "E11", "limit": 5},
            ),
        ],
    },
    "food_nutrition": {
        "category": "Food Nutrition",
        "tools": [
            (
                "query_food_nutrition",
                "query_food_nutrition",
                {"food_name": "雞蛋", "nutrient": "粗蛋白"},
            ),
            (
                "query_food_ingredient",
                "query_food_ingredient",
                {"keyword": "薑黃"},
            ),
            (
                "search_foods_by_nutrient",
                "search_foods_by_nutrient",
                {"nutrient": "鈣"},
            ),
            (
                "analyze_meal_nutrition",
                "analyze_meal_nutrition",
                {"foods": ["白米飯", "雞胸肉", "花椰菜", "豆腐"]},
            ),
        ],
    },
    "fhir_server": {
        "category": "FHIR Servers",
        "tools": [
            (
                "list_fhir_servers",
                "list_fhir_servers",
                {"include_disabled": False},
            ),
            (
                "get_fhir_server_status",
                "get_fhir_server_status",
                {"server_key": "default"},
            ),
            (
                "crud_fhir_server",
                "crud_fhir_server",
                {
                    "server_key": "default",
                    "operation": "metadata",
                },
            ),
        ],
    },
    "system": {
        "category": "System",
        "tools": [("health_check", "health_check", {})],
    },
}


def _build_tool_maps():
    tool_category_map: dict[str, str] = {}
    tool_examples: dict[str, dict] = {}
    tool_selector_examples: dict[str, dict[str, dict[str, dict]]] = {}
    service_tools: dict[str, list[tuple[Callable, str]]] = {}
    selector_fields = {"mode", "type"}
    for service_key, spec in _TOOL_GROUPS.items():
        category = spec["category"]
        tools = []
        seen_names: set[str] = set()
        for fn_name, name, example in spec["tools"]:
            fn = globals().get(fn_name)
            if fn is None:
                raise NameError(f"Tool function not defined: {fn_name}")
            tool_category_map[name] = category
            if example and name not in tool_examples:
                tool_examples[name] = example
            if isinstance(example, dict):
                for field in selector_fields:
                    field_value = example.get(field)
                    if isinstance(field_value, str) and field_value:
                        (
                            tool_selector_examples.setdefault(name, {}).setdefault(
                                field, {}
                            )
                        )[field_value] = example
            if service_key not in {"system", "fhir_server"}:
                if name not in seen_names:
                    tools.append((fn, name))
                    seen_names.add(name)
        if service_key not in {"system", "fhir_server"}:
            service_tools[service_key] = tools
    return tool_category_map, tool_examples, tool_selector_examples, service_tools


def _build_status_html() -> str:
    """Build the status page HTML, embedding the category map and examples as JS constants."""
    cat_map_js = json.dumps(_TOOL_CATEGORY_MAP, ensure_ascii=False)
    examples_js = json.dumps(_TOOL_EXAMPLES, ensure_ascii=False)
    selector_examples_js = json.dumps(_TOOL_SELECTOR_EXAMPLES, ensure_ascii=False)
    return (
        _STATUS_HTML_TEMPLATE.replace('"__CATEGORY_MAP__"', cat_map_js)
        .replace('"__TOOL_EXAMPLES__"', examples_js)
        .replace('"__TOOL_SELECTOR_EXAMPLES__"', selector_examples_js)
    )


_STATUS_HTML_TEMPLATE = """\
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="shortcut icon" type="image/png" href="/favicon.png">
  <title>Status &amp; Tool Tester – Taiwan Health MCP</title>
  <meta name="color-scheme" content="light dark">
  <script>
    (function () {
      try {
        var t = localStorage.getItem('admin-theme');
        if (t !== 'light' && t !== 'dark') {
          t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        }
        document.documentElement.dataset.theme = t;
      } catch (e) {}
    })();
  </script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { height: 100%; }
    body { font-family: system-ui, sans-serif; background: #f8f9fa; color: #1a1a1a;
           height: 100%; display: flex; flex-direction: column; overflow: hidden; }

    /* ── header ── */
    header { background: #fff; border-bottom: 1px solid #e5e7eb; padding: 8px 16px;
             display: flex; align-items: center; justify-content: space-between;
             flex-shrink: 0; gap: 10px; flex-wrap: wrap; }
    .hdr-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .hdr-left img { height: 28px; display: block; flex-shrink: 0; }
    header h1 { font-size: 0.95rem; font-weight: 700;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .hdr-right { display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
                 flex-shrink: 0; }
    .stats { font-size: 0.82rem; color: #555; white-space: nowrap; }
    .stats b { color: #166534; }
    .hdr-link { font-size: 0.8rem; color: #0066cc; text-decoration: none;
                white-space: nowrap; }
    .hdr-link:hover { text-decoration: underline; }

    /* ── layout ── */
    .main { display: flex; flex: 1; overflow: hidden; min-height: 0; }

    /* ── left panel ── */
    .left { width: 260px; min-width: 180px; background: #fff;
            border-right: 1px solid #e5e7eb; display: flex;
            flex-direction: column; flex-shrink: 0; overflow: hidden; }
    .search-wrap { padding: 10px 10px 6px; }
    .search-wrap input { width: 100%; padding: 7px 10px; border: 1px solid #ddd;
                         border-radius: 6px; font-size: 0.88rem; }
    .search-wrap input:focus { outline: none; border-color: #0066cc; }
    .cat-row { display: flex; gap: 5px; padding: 6px 10px 8px; flex-wrap: wrap;
               border-bottom: 1px solid #f0f0f0; overflow-x: auto; }
    .cat-btn { padding: 2px 9px; border-radius: 10px; font-size: 0.75rem; cursor: pointer;
               border: 1px solid #ddd; background: #f9f9f9; color: #555;
               white-space: nowrap; flex-shrink: 0; }
    .cat-btn:hover { border-color: #0066cc; color: #0066cc; }
    .cat-btn.on { background: #0066cc; color: #fff; border-color: #0066cc; }
    .tool-list { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 4px 0; }
    .t-item { display: flex; align-items: center; gap: 7px; padding: 7px 12px;
              cursor: pointer; border-left: 3px solid transparent; }
    .t-item:hover { background: #f4f7fb; }
    .t-item.sel { background: #e8f0fe; border-left-color: #0066cc; }
    .t-item.off { opacity: 0.45; }
    .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .g { background: #22c55e; }
    .gr { background: #9ca3af; }
    .tname { font-size: 0.8rem; font-family: monospace; color: #333;
             white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    /* ── right panel ── */
    .right { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch;
             padding: 20px 22px; min-width: 0; }
    .empty { height: 100%; display: flex; align-items: center; justify-content: center;
             color: #bbb; font-size: 1rem; text-align: center; padding: 20px; }

    /* ── tool detail ── */
    .th { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
    .th h2 { font-size: 1.05rem; font-family: monospace; font-weight: 700;
             word-break: break-all; }
    .badge { border-radius: 10px; padding: 2px 10px; font-size: 0.75rem; font-weight: 500; }
    .bc { background: #e8f0fe; color: #1a56cc; }
    .ba-on { background: #dcfce7; color: #166534; }
    .ba-off { background: #f3f4f6; color: #6b7280; }
    .tdesc { font-size: 0.88rem; color: #555; line-height: 1.65; margin-bottom: 18px; }
    hr.div { border: none; border-top: 1px solid #f0f0f0; margin: 0 0 16px; }

    /* ── form ── */
    .sec-title { font-size: 0.88rem; font-weight: 700; color: #333; margin-bottom: 12px;
                 text-transform: uppercase; letter-spacing: .04em; }
    .fg { margin-bottom: 13px; }
    .fg label { display: block; font-size: 0.83rem; font-weight: 600; margin-bottom: 3px; }
    .fg label.req::after { content: " *"; color: #dc2626; }
    .fdesc { font-size: 0.77rem; color: #888; margin-bottom: 4px; }
    .fg input[type=text], .fg input[type=number], .fg select, .fg textarea {
      width: 100%; max-width: 480px; padding: 7px 10px; border: 1px solid #ddd;
      border-radius: 6px; font-size: 0.88rem; font-family: inherit; }
    .fg input:focus, .fg select:focus, .fg textarea:focus {
      outline: none; border-color: #0066cc; }
    .fg textarea { resize: vertical; font-family: monospace; font-size: 0.82rem; }
    .cb-row { display: flex; align-items: center; gap: 7px; font-size: 0.88rem; }
    .run-btn { margin-top: 6px; padding: 8px 20px; background: #0066cc; color: #fff;
               border: none; border-radius: 6px; font-size: 0.88rem; font-weight: 600;
               cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
    .run-btn:hover { background: #0055aa; }
    .run-btn:disabled { background: #93c5fd; cursor: not-allowed; }
    .no-params { color: #999; font-size: 0.85rem; font-style: italic; margin-bottom: 10px; }

    /* ── result ── */
    .res-sec { margin-top: 20px; }
    .res-sec.hidden { display: none; }
    .res-hdr { display: flex; align-items: center; justify-content: space-between;
               margin-bottom: 6px; flex-wrap: wrap; gap: 6px; }
    .res-meta { font-size: 0.78rem; color: #888; }
    .copy-btn { padding: 3px 10px; font-size: 0.78rem; border: 1px solid #ddd;
                border-radius: 4px; background: #f9f9f9; cursor: pointer; }
    .copy-btn:hover { border-color: #0066cc; }

    /* ── JSON tree ── */
    .json-tree { background:#1e1e1e; color:#d4d4d4; padding:12px 14px; border-radius:8px;
                 font-size:0.78rem; overflow:auto; max-height:480px; line-height:1.55;
                 font-family:'Consolas','JetBrains Mono','Courier New',monospace; }
    .json-tree.plain { white-space:pre-wrap; word-break:break-all; }
    .jhead { cursor:pointer; border-radius:3px; }
    .jhead:hover { background:#2a2a2a; }
    .jt { color:#888; font-size:0.65rem; margin-right:2px; display:inline-block;
          width:10px; text-align:center; }
    .jcoll > .jch { display:block; padding-left:18px;
                    border-left:1px solid #2d2d2d; margin-left:5px; }
    .jcoll > .jfoot { display:block; }
    .jcoll > .jhead > .jsum { display:none; }
    .jcollapsed > .jch { display:none !important; }
    .jcollapsed > .jfoot { display:none !important; }
    .jcollapsed > .jhead > .jsum { display:inline !important; }
    .jleaf { white-space:nowrap; }
    .jsum { color:#666; font-style:italic; font-size:0.72rem; }
    .jkey { color:#9cdcfe; }
    .jstr { color:#ce9178; }
    .jnum { color:#b5cea8; }
    .jbool { color:#569cd6; }
    .jnull { color:#808080; font-style:italic; }
    .jbrace { color:#d4d4d4; }
    .jsep { color:#666; }

    /* ── unavailable ── */
    .unavail { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px;
               padding: 18px; color: #6b7280; font-size: 0.88rem; }

    /* ── spinner ── */
    .spin { display: inline-block; width: 13px; height: 13px; border: 2px solid #fff;
            border-top-color: transparent; border-radius: 50%;
            animation: sp .65s linear infinite; }
    @keyframes sp { to { transform: rotate(360deg); } }

    /* ── mobile: stack panels vertically ── */
    @media (max-width: 680px) {
      html, body { height: auto; overflow: auto; }
      .main { flex-direction: column; overflow: visible; }
      .left { width: 100%; height: auto; border-right: none;
              border-bottom: 1px solid #e5e7eb; }
      .tool-list { max-height: 200px; }
      .right { overflow-y: visible; padding: 16px; }
      .fg input[type=text], .fg input[type=number], .fg select, .fg textarea {
        max-width: 100%; }
      header h1 { font-size: 0.82rem; }
    }

    /* ── dark mode (follows admin-theme localStorage, else OS preference) ──
       The JSON tree (.json-tree) is intentionally dark in both themes. */
    [data-theme="dark"] body { background: #0f1115; color: #e6e8eb; }
    [data-theme="dark"] header { background: #15181e; border-bottom-color: #262b35; }
    [data-theme="dark"] .stats { color: #9aa3b2; }
    [data-theme="dark"] .stats b { color: #6ee7a0; }
    [data-theme="dark"] .hdr-link { color: #5aa2ff; }
    [data-theme="dark"] .left { background: #13161c; border-right-color: #262b35; }
    [data-theme="dark"] .search-wrap input { background: #0f1115; border-color: #2b3340;
                                             color: #e6e8eb; }
    [data-theme="dark"] .search-wrap input:focus { border-color: #5aa2ff; }
    [data-theme="dark"] .cat-row { border-bottom-color: #1d2129; }
    [data-theme="dark"] .cat-btn { background: #161b22; border-color: #2b3340; color: #aab2bf; }
    [data-theme="dark"] .cat-btn:hover { border-color: #5aa2ff; color: #5aa2ff; }
    [data-theme="dark"] .cat-btn.on { background: #2563eb; color: #fff; border-color: #2563eb; }
    [data-theme="dark"] .t-item:hover { background: #1a2029; }
    [data-theme="dark"] .t-item.sel { background: #16263f; border-left-color: #5aa2ff; }
    [data-theme="dark"] .tname { color: #cfd5de; }
    [data-theme="dark"] .empty { color: #5b636f; }
    [data-theme="dark"] .th h2 { color: #e6e8eb; }
    [data-theme="dark"] .bc { background: #16263f; color: #7cb7ff; }
    [data-theme="dark"] .ba-on { background: #10231a; color: #6ee7a0; }
    [data-theme="dark"] .ba-off { background: #1b1f27; color: #9aa3b2; }
    [data-theme="dark"] .tdesc { color: #aab2bf; }
    [data-theme="dark"] hr.div { border-top-color: #1d2129; }
    [data-theme="dark"] .sec-title { color: #cfd5de; }
    [data-theme="dark"] .fg label { color: #e6e8eb; }
    [data-theme="dark"] .fdesc { color: #8b94a3; }
    [data-theme="dark"] .fg input[type=text], [data-theme="dark"] .fg input[type=number],
    [data-theme="dark"] .fg select, [data-theme="dark"] .fg textarea {
      background: #0f1115; border-color: #2b3340; color: #e6e8eb; }
    [data-theme="dark"] .fg input:focus, [data-theme="dark"] .fg select:focus,
    [data-theme="dark"] .fg textarea:focus { border-color: #5aa2ff; }
    [data-theme="dark"] .no-params { color: #7d8694; }
    [data-theme="dark"] .res-meta { color: #8b94a3; }
    [data-theme="dark"] .copy-btn { background: #161b22; border-color: #2b3340; color: #cfd5de; }
    [data-theme="dark"] .copy-btn:hover { border-color: #5aa2ff; }
    [data-theme="dark"] .unavail { background: #13161c; border-color: #262b35; color: #9aa3b2; }
  </style>
</head>
<body>

<header>
  <div class="hdr-left">
    <img src="/logo-s.png" alt="HealthyMind Tech">
    <h1>Taiwan Health MCP — Status &amp; Tool Tester</h1>
  </div>
  <div class="hdr-right">
    <div class="stats" id="stats">Loading…</div>
    <a class="hdr-link" href="/">← Home</a>
    <a class="hdr-link" href="/privacy">Privacy</a>
  </div>
</header>

<div class="main">
  <!-- left -->
  <div class="left">
    <div class="search-wrap">
      <input type="text" id="srch" placeholder="Search tools…" oninput="filter()">
    </div>
    <div class="cat-row" id="cats"></div>
    <div class="tool-list" id="tlist">
      <div style="padding:18px;color:#bbb;font-size:.83rem;">Loading…</div>
    </div>
  </div>

  <!-- right -->
  <div class="right" id="right">
    <div class="empty">← Select a tool from the list to test it</div>
  </div>
</div>

<script>
// ── category map (injected from server) ───────────────────────
const CATEGORY_MAP = "__CATEGORY_MAP__";

// ── per-tool example arguments (injected from server) ─────────
const TOOL_EXAMPLES = "__TOOL_EXAMPLES__";
const TOOL_SELECTOR_EXAMPLES = "__TOOL_SELECTOR_EXAMPLES__";

// ── MCP client ────────────────────────────────────────────────
let _sid = null, _mid = 0;

async function _mcpPost(body) {
  const hdrs = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (_sid) hdrs['mcp-session-id'] = _sid;
  const r = await fetch('/mcp', {method: 'POST', headers: hdrs, body: JSON.stringify(body)});
  const sid = r.headers.get('mcp-session-id');
  if (sid) _sid = sid;
  return r;
}

async function _readResult(r, id) {
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) {
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        buf += dec.decode(value, {stream: true});
        const lines = buf.split('\\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (!raw || raw === '[DONE]') continue;
          let msg; try { msg = JSON.parse(raw); } catch { continue; }
          if (msg.id === id) {
            if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
            return msg.result;
          }
        }
      }
    } finally { reader.cancel(); }
    throw new Error('SSE stream ended without result');
  }
  const data = await r.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.result;
}

async function mcpRequest(method, params) {
  const id = ++_mid;
  const r = await _mcpPost({jsonrpc: '2.0', id, method, ...(params ? {params} : {})});
  return _readResult(r, id);
}

async function mcpNotify(method, params) {
  await _mcpPost({jsonrpc: '2.0', method, ...(params ? {params} : {})});
}

// ── app state ─────────────────────────────────────────────────
let tools = [], selName = null, activeCat = 'all';

async function init() {
  let step = 'initialize';
  try {
    await mcpRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {name: 'tw-health-status-tester', version: '1.0'},
    });
    step = 'notifications/initialized';
    await mcpNotify('notifications/initialized');

    step = 'tools/list';
    const {tools: mcpTools} = await mcpRequest('tools/list');
    const byName = Object.fromEntries(mcpTools.map(t => [t.name, t]));
    const avail  = new Set(mcpTools.map(t => t.name));

    tools = Object.keys(CATEGORY_MAP).map(name => ({
      name,
      category:    CATEGORY_MAP[name],
      description: byName[name]?.description || '',
      available:   avail.has(name),
      inputSchema: byName[name]?.inputSchema || {},
    }));

    const n = tools.filter(t => t.available).length;
    document.getElementById('stats').innerHTML =
      `<b>${n}</b> / ${tools.length} tools available`;
    buildCats();
    filter();
  } catch(e) {
    document.getElementById('tlist').innerHTML =
      `<div style="padding:18px;color:#dc2626;font-size:.83rem;">Failed at <b>${esc(step)}</b>: ${esc(e.message)}</div>`;
  }
}

function buildCats() {
  const cats = ['all', ...new Set(tools.map(t => t.category))];
  document.getElementById('cats').innerHTML = cats.map(c => {
    const cnt = c === 'all' ? tools.length : tools.filter(t => t.category===c).length;
    const lbl = c === 'all' ? `All&nbsp;(${cnt})` : `${c}&nbsp;(${cnt})`;
    return `<div class="cat-btn${c===activeCat?' on':''}" onclick="setCat('${c}')">${lbl}</div>`;
  }).join('');
}

function setCat(c) {
  activeCat = c;
  document.querySelectorAll('.cat-btn').forEach(el => {
    const isAll = c==='all' && el.textContent.startsWith('All');
    const isMatch = c!=='all' && el.textContent.startsWith(c);
    el.classList.toggle('on', isAll || isMatch);
  });
  filter();
}

function filter() {
  const q = document.getElementById('srch').value.toLowerCase();
  const vis = tools.filter(t => {
    if (activeCat !== 'all' && t.category !== activeCat) return false;
    if (q && !t.name.includes(q) && !t.description.toLowerCase().includes(q)) return false;
    return true;
  });
  if (!vis.length) {
    document.getElementById('tlist').innerHTML =
      '<div style="padding:18px;color:#bbb;font-size:.83rem;">No matches</div>';
    return;
  }
  document.getElementById('tlist').innerHTML = vis.map(t =>
    `<div class="t-item${t.available?'':' off'}${selName===t.name?' sel':''}"
          onclick="pick('${t.name}')">
       <span class="dot ${t.available?'g':'gr'}"></span>
       <span class="tname">${t.name}</span>
     </div>`
  ).join('');
}

function pick(name) {
  selName = name;
  filter();
  const t = tools.find(x => x.name === name);
  if (t) renderDetail(t);
}

function renderDetail(t) {
  const props = t.inputSchema?.properties || {};
  const req   = t.inputSchema?.required  || [];
  const fields = Object.entries(props).map(([k,s]) => mkField(k,s,req.includes(k))).join('');

  document.getElementById('right').innerHTML = `
    <div class="th">
      <h2>${t.name}</h2>
      <span class="badge bc">${t.category}</span>
      <span class="badge ${t.available?'ba-on':'ba-off'}">
        ${t.available ? '● Available' : '○ Unavailable'}
      </span>
    </div>
    <p class="tdesc">${esc(t.description || 'No description.')}</p>
    <hr class="div">
    ${t.available ? `
      <div class="sec-title">Parameters</div>
      <form id="frm" onsubmit="run(event)">
        ${fields || '<p class="no-params">No parameters — just click Run.</p>'}
        <button type="submit" class="run-btn" id="rbtn">&#9654; Run Tool</button>
      </form>
      <div class="res-sec hidden" id="rsec">
        <div class="res-hdr">
          <span class="sec-title" style="margin:0;">Result</span>
          <div style="display:flex;gap:8px;align-items:center;">
            <span class="res-meta" id="rmeta"></span>
            <button class="copy-btn" onclick="collapseAll()">Collapse</button>
            <button class="copy-btn" onclick="expandAll()">Expand</button>
            <button class="copy-btn" onclick="copyRes()">Copy</button>
          </div>
        </div>
        <div id="rout" class="json-tree"></div>
      </div>
    ` : `
      <div class="unavail">
        This tool is currently unavailable — its module hasn't been loaded yet.<br>
        Load it from the <strong>Admin console &rarr; Modules</strong> tab, or run
        <code>docker compose --profile loader run --rm data-loader --all</code>.
      </div>
    `}`;
  applyExamples(t.name);
}

function applyExamples(toolName) {
  const ex = TOOL_EXAMPLES[toolName];
  if (ex) applyExample(toolName, ex, true);
  bindSelectorExampleSwitch(toolName);
}

function applyExample(toolName, example, resetToDefaults) {
  const t = tools.find(x => x.name === toolName);
  if (!t) return;
  const props = t.inputSchema?.properties || {};

  if (resetToDefaults) {
    for (const [k, s] of Object.entries(props)) {
      const el = document.getElementById('p_' + k);
      if (!el) continue;
      const { schema } = pickSchema(s);
      const def = s.default !== undefined ? s.default : (schema.default !== undefined ? schema.default : '');
      if (el.type === 'checkbox') {
        el.checked = Boolean(def);
      } else if (def === null || def === undefined) {
        el.value = '';
      } else if (typeof def === 'object') {
        el.value = JSON.stringify(def, null, 2);
      } else {
        el.value = String(def);
      }
    }
  }

  for (const [k, v] of Object.entries(example || {})) {
    const el = document.getElementById('p_' + k);
    if (!el) continue;
    if (el.type === 'checkbox') {
      el.checked = Boolean(v);
    } else if (typeof v === 'object' && v !== null) {
      el.value = JSON.stringify(v, null, 2);
    } else if (v === null || v === undefined) {
      el.value = '';
    } else {
      el.value = String(v);
    }
  }
}

function bindSelectorExampleSwitch(toolName) {
  const toolMap = TOOL_SELECTOR_EXAMPLES[toolName];
  if (!toolMap) return;

  for (const field of ['mode', 'type']) {
    const el = document.getElementById('p_' + field);
    const fieldMap = toolMap[field];
    if (!el || !fieldMap) continue;

    // Fields that appear in some but not all mode examples are conditional:
    // show them when the current mode uses them, hide them otherwise.
    const allExamples = Object.values(fieldMap);
    const allFields = new Set(
      allExamples.flatMap(ex => Object.keys(ex).filter(k => k !== field))
    );
    const universalFields = new Set(
      [...allFields].filter(k => allExamples.every(ex => k in ex))
    );
    const conditionalFields = [...allFields].filter(k => !universalFields.has(k));

    const updateVisibility = (example) => {
      for (const k of conditionalFields) {
        const fg = document.getElementById('p_' + k)?.closest('.fg');
        if (fg) fg.style.display = (k in example) ? '' : 'none';
      }
    };

    const applyByField = () => {
      const v = el.value;
      const example = fieldMap[v];
      if (example) {
        applyExample(toolName, example, true);
        updateVisibility(example);
      }
    };

    el.onchange = applyByField;
    applyByField();
  }
}

function pickSchema(s) {
  if (!s || typeof s !== 'object') {
    return { type: 'string', enumVals: null, schema: {} };
  }
  let schema = s;
  if (Array.isArray(s.anyOf) && s.anyOf.length > 0) {
    const nonNull = s.anyOf.filter(opt => opt && opt.type !== 'null');
    if (nonNull.length > 0) {
      const enumOpt = nonNull.find(opt => Array.isArray(opt.enum));
      schema = enumOpt || nonNull[0];
    }
  }
  const type = schema.type || s.type || 'string';
  const enumVals = Array.isArray(schema.enum) ? schema.enum : (Array.isArray(s.enum) ? s.enum : null);
  return { type, enumVals, schema };
}

function mkField(k, s, isReq) {
  const { type, enumVals, schema } = pickSchema(s);
  const id = 'p_'+k, desc = s.description||'';
  const def = s.default !== undefined ? s.default : (schema.default !== undefined ? schema.default : '');

  let inp;
  if (type==='boolean') {
    inp = `<div class="cb-row"><input type="checkbox" id="${id}" ${def?'checked':''}><label for="${id}" style="font-weight:normal">${k}</label></div>`;
  } else if (enumVals) {
    const opts = [];
    if (!isReq) {
      opts.push(`<option value=""${def===null||def===''?' selected':''}>(none)</option>`);
    }
    opts.push(...enumVals.map(v=>`<option value="${v}"${v===def?'selected':''}>${v}</option>`));
    inp = `<select id="${id}" ${isReq?'required':''}>${opts.join('')}</select>`;
  } else if (type==='integer'||type==='number') {
    const mn = schema.minimum!==undefined?`min="${schema.minimum}"`:(s.minimum!==undefined?`min="${s.minimum}"`:'');
    const mx = schema.maximum!==undefined?`max="${schema.maximum}"`:(s.maximum!==undefined?`max="${s.maximum}"`:'');
    inp = `<input type="number" id="${id}" value="${def}" ${mn} ${mx} placeholder="${ph(k)}" ${isReq?'required':''}>`;
  } else if (type==='array') {
    inp = `<textarea id="${id}" rows="3" placeholder="${arrPh(k)}" ${isReq?'required':''}></textarea>`;
  } else if (type==='object') {
    inp = `<textarea id="${id}" rows="3" placeholder='{"key":"value"}' ${isReq?'required':''}></textarea>`;
  } else if (type==='string' && k.endsWith('_json')) {
    inp = `<textarea id="${id}" rows="4" style="font-family:monospace;font-size:0.79rem;" placeholder="${k}" ${isReq?'required':''}></textarea>`;
  } else {
    inp = `<input type="text" id="${id}" value="${def}" placeholder="${ph(k)}" ${isReq?'required':''}>`;
  }

  return `<div class="fg">
    <label class="${isReq?'req':''}" for="${id}">${k}</label>
    ${desc?`<div class="fdesc">${esc(desc)}</div>`:''}
    ${inp}
  </div>`;
}

const PH = {
  keyword:'e.g. 糖尿病, diabetes', query:'e.g. A10BA02, 降血糖',
  icd_code:'e.g. E11.9', code:'e.g. E11.9', diagnosis_code:'e.g. E11.9',
  loinc_code:'e.g. 2345-7', loinc_num:'e.g. 4548-4',
  concept_id:'e.g. 73211009', permit_no:'e.g. 衛署健食字第A00022號',
  license_id:'e.g. 內衛成製字第000029號', food_name:'e.g. 雞蛋',
  ingredient_name:'e.g. metformin', nutrient:'e.g. 鈣, 粗蛋白',
  component:'e.g. Glucose', specimen_type:'e.g. 血清/血漿',
  features:'e.g. 白色 圓形', category:'e.g. E11, CHEM',
  diagnosis_keyword:'e.g. 糖尿病, E11', medication_class:'e.g. Metformin',
  drug_name:'e.g. Metformin', procedure_code:'e.g. 0BH17EZ',
  cs_id:'e.g. TW-CodeSystem-medication-fda-tw',
};
const ARR_PH = {
  foods:'["白米", "雞胸肉"]',
  drug_names:'["Metformin", "Warfarin"]',
  results_json:'[{"loinc_code":"2345-7","value":5.5}]',
};
const ph  = k => PH[k] || '';
const arrPh = k => ARR_PH[k] || '["item1","item2"]';

async function run(e) {
  e.preventDefault();
  const t = tools.find(x => x.name===selName); if (!t) return;
  const props = t.inputSchema?.properties || {};
  const args = {};

  for (const [k, s] of Object.entries(props)) {
    const el = document.getElementById('p_'+k); if (!el) continue;
    const { type } = pickSchema(s);
    if (type==='boolean') { args[k] = el.checked; continue; }
    if (!el.value) continue;
    if (type==='integer')            args[k] = parseInt(el.value, 10);
    else if (type==='number')        args[k] = parseFloat(el.value);
    else if (type==='array'||type==='object') {
      try { args[k] = JSON.parse(el.value); } catch { args[k] = el.value; }
    } else args[k] = el.value;
  }

  const btn = document.getElementById('rbtn');
  btn.innerHTML = '<span class="spin"></span>Running…';
  btn.disabled = true;
  const t0 = Date.now();

  try {
    const result = await mcpRequest('tools/call', {name: selName, arguments: args});
    const ms = Date.now()-t0;

    // MCP returns content blocks; extract text
    const raw = result?.content?.map(c => c.text ?? '').join('') ?? JSON.stringify(result);

    document.getElementById('rsec').classList.remove('hidden');
    document.getElementById('rmeta').textContent =
      ms+'ms' + (result?.isError ? ' ⚠ tool error' : '');
    renderResult(raw);
  } catch(err) {
    document.getElementById('rsec').classList.remove('hidden');
    document.getElementById('rmeta').textContent = '';
    const rout = document.getElementById('rout');
    rout.className = 'json-tree plain';
    rout.textContent = 'Error: '+err.message;
    _copyText = 'Error: '+err.message;
  } finally {
    btn.innerHTML = '&#9654; Run Tool';
    btn.disabled = false;
  }
}

// ── JSON tree renderer ────────────────────────────────────────
let _copyText = '';

function jEsc(s) {
  return JSON.stringify(s).slice(1,-1)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function jLeaf(v) {
  if (v === null) return '<span class="jnull">null</span>';
  if (typeof v === 'boolean') return `<span class="jbool">${v}</span>`;
  if (typeof v === 'number') return `<span class="jnum">${v}</span>`;
  return `<span class="jstr">"${jEsc(String(v))}"</span>`;
}

function jNode(v, depth, key, comma) {
  const keyHtml = key !== undefined
    ? `<span class="jkey">"${jEsc(key)}"</span><span class="jsep">: </span>` : '';
  const commaHtml = comma ? `<span class="jsep">,</span>` : '';

  if (v === null || typeof v !== 'object') {
    return `<div class="jleaf">${keyHtml}${jLeaf(v)}${commaHtml}</div>`;
  }

  const isArr = Array.isArray(v);
  const entries = isArr ? v.map((x,i) => [i, x]) : Object.entries(v);
  const open = isArr ? '[' : '{', close = isArr ? ']' : '}';

  if (entries.length === 0) {
    return `<div class="jleaf">${keyHtml}<span class="jbrace">${open}${close}</span>${commaHtml}</div>`;
  }

  const collapsed = depth >= 2;
  const cnt = entries.length;
  const label = isArr ? `${cnt} item${cnt!==1?'s':''}` : `${cnt} key${cnt!==1?'s':''}`;
  const ch = entries.map(([k, vv], i) =>
    jNode(vv, depth+1, isArr ? undefined : String(k), i < cnt-1)
  ).join('');

  return (
    `<div class="jcoll${collapsed?' jcollapsed':''}">` +
      `<div class="jhead" onclick="jTog(this)">` +
        `<span class="jt">${collapsed?'&#9656;':'&#9662;'}</span>` +
        keyHtml +
        `<span class="jbrace">${open}</span>` +
        `<span class="jsum"> ${label} ${close}${comma?',':''}</span>` +
      `</div>` +
      `<div class="jch">${ch}</div>` +
      `<div class="jfoot"><span class="jbrace">${close}</span>${commaHtml}</div>` +
    `</div>`
  );
}

function jTog(head) {
  const coll = head.closest('.jcoll');
  const wasCollapsed = coll.classList.contains('jcollapsed');
  coll.classList.toggle('jcollapsed');
  head.querySelector('.jt').innerHTML = wasCollapsed ? '&#9662;' : '&#9656;';
}

function collapseAll() {
  document.querySelectorAll('#rout .jcoll').forEach(c => {
    if (!c.classList.contains('jcollapsed')) {
      c.classList.add('jcollapsed');
      const t = c.querySelector(':scope > .jhead > .jt');
      if (t) t.innerHTML = '&#9656;';
    }
  });
}

function expandAll() {
  document.querySelectorAll('#rout .jcoll').forEach(c => {
    if (c.classList.contains('jcollapsed')) {
      c.classList.remove('jcollapsed');
      const t = c.querySelector(':scope > .jhead > .jt');
      if (t) t.innerHTML = '&#9662;';
    }
  });
}

function renderResult(raw) {
  const rout = document.getElementById('rout');
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    _copyText = raw;
    rout.className = 'json-tree plain';
    rout.textContent = raw;
    return;
  }
  _copyText = JSON.stringify(parsed, null, 2);
  rout.className = 'json-tree';
  rout.innerHTML = jNode(parsed, 0);
}

function copyRes() {
  navigator.clipboard.writeText(_copyText).then(()=>{
    const b = document.querySelector('.copy-btn');
    b.textContent='Copied!'; setTimeout(()=>b.textContent='Copy', 2000);
  });
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

init();
</script>
</body>
</html>
"""


class PrivacyPageMiddleware:
    """Serve static pages (/, /privacy, /dpa, /status) and static assets (logos, favicon)."""

    def __init__(self, app):
        self.app = app

    async def _send_file(self, send, body: bytes, content_type: bytes):
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [
                    (b"content-type", content_type),
                    (b"content-length", str(len(body)).encode()),
                    (b"cache-control", b"public, max-age=604800"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body, "more_body": False})

    async def _send_404(self, send):
        await send(
            {
                "type": "http.response.start",
                "status": 404,
                "headers": [(b"content-length", b"9")],
            }
        )
        await send(
            {"type": "http.response.body", "body": b"Not Found", "more_body": False}
        )

    async def _send_html(
        self,
        send,
        body: bytes,
        *,
        status: int = 200,
        extra_headers: list[tuple[bytes, bytes]] | None = None,
    ):
        headers = [
            (b"content-type", b"text/html; charset=utf-8"),
            (b"content-length", str(len(body)).encode()),
            (b"cache-control", b"public, max-age=300"),
        ]
        if extra_headers:
            headers.extend(extra_headers)
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": headers,
            }
        )
        await send({"type": "http.response.body", "body": body, "more_body": False})

    async def _send_json(
        self,
        send,
        body: str,
        *,
        status: int = 200,
        extra_headers: list[tuple[bytes, bytes]] | None = None,
    ):
        payload = body.encode("utf-8")
        headers = [
            (b"content-type", b"application/json; charset=utf-8"),
            (b"content-length", str(len(payload)).encode()),
            (b"cache-control", b"no-store"),
        ]
        if extra_headers:
            headers.extend(extra_headers)
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": headers,
            }
        )
        await send({"type": "http.response.body", "body": payload, "more_body": False})

    async def _send_redirect(
        self,
        send,
        location: str,
        *,
        status: int = 303,
        extra_headers: list[tuple[bytes, bytes]] | None = None,
    ):
        headers = [(b"location", location.encode("utf-8"))]
        if extra_headers:
            headers.extend(extra_headers)
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": headers,
            }
        )
        await send({"type": "http.response.body", "body": b"", "more_body": False})

    async def _send_asset(
        self,
        send,
        body: bytes,
        content_type: str,
        *,
        cache_control: str = "public, max-age=300",
    ):
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [
                    (b"content-type", content_type.encode()),
                    (b"content-length", str(len(body)).encode()),
                    (b"cache-control", cache_control.encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body, "more_body": False})

    async def _read_body(self, receive) -> bytes:
        chunks: list[bytes] = []
        more_body = True
        while more_body:
            message = await receive()
            if message["type"] != "http.request":
                continue
            body = message.get("body", b"")
            if body:
                chunks.append(body)
            more_body = bool(message.get("more_body", False))
        return b"".join(chunks)

    async def __call__(self, scope, receive, send):
        # ── ASGI lifespan: hook process shutdown ──────────────────────────────
        # uvicorn drives this once per process. Wrap receive() so that when the
        # shutdown event arrives we cancel the relay task before the inner app
        # (and then the event loop) tears down — avoiding pending-task noise.
        if scope["type"] == "lifespan":

            async def lifespan_receive():
                message = await receive()
                if message["type"] == "lifespan.shutdown":
                    await _shutdown_ws_relay()
                return message

            await self.app(scope, lifespan_receive, send)
            return

        # ── WebSocket: /admin/ws ──────────────────────────────────────────────
        if scope["type"] == "websocket":
            path = scope.get("path", "")
            if path == "/admin/ws":
                if not _admin_enabled() or not _admin_ready():
                    await send({"type": "websocket.close", "code": 1008})
                    return
                if not _admin_username_from_scope(scope):
                    await send({"type": "websocket.close", "code": 1008})
                    return
                await handle_admin_websocket(scope, receive, send)
                return
            await self.app(scope, receive, send)
            return

        if scope["type"] == "http":
            method = scope.get("method", "")
            path = scope.get("path", "").rstrip("/") or "/"

            # ── Public per-server JWKS endpoint ───────────────────────────────
            # An OAuth Server fetches our client's public signing key here,
            # server-to-server, with no admin session. Only public keys are
            # exposed; the server id (a UUID) acts as the capability.
            jwks_match = re.match(r"^/fhir-client/([^/]+)/jwks\.json$", path)
            if jwks_match:
                if method != "GET":
                    await self._send_json(
                        send,
                        json.dumps({"error": "method_not_allowed"}),
                        status=405,
                    )
                    return
                if not db_health.monitor().is_healthy():
                    await self._send_json(
                        send,
                        json.dumps({"error": "database_unavailable"}),
                        status=503,
                    )
                    return
                try:
                    await _ensure_runtime_ready()
                    pool = database.get_pool()
                    jwks = await get_fhir_server_jwks(pool, jwks_match.group(1))
                except Exception as exc:
                    db_health.monitor().report_failure(exc)
                    await self._send_json(
                        send,
                        json.dumps({"error": "jwks_unavailable"}),
                        status=503,
                    )
                    return
                if jwks is None:
                    await self._send_json(
                        send,
                        json.dumps({"error": "not_found"}),
                        status=404,
                    )
                    return
                await self._send_json(
                    send,
                    json.dumps(jwks, ensure_ascii=False),
                )
                return

            is_admin_route = path == "/admin" or path.startswith("/admin/")
            if is_admin_route:
                if not _admin_enabled():
                    await self._send_404(send)
                    return

                if not _admin_ready():
                    message = "Admin console is enabled but not fully configured."
                    if path.startswith("/admin/api/"):
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": message,
                                    "hint": "Set ADMIN_USERNAME, ADMIN_PASSWORD_HASH, and ADMIN_SESSION_SECRET.",
                                },
                                ensure_ascii=False,
                            ),
                            status=503,
                        )
                    else:
                        await self._send_html(
                            send,
                            build_admin_login_html(error_message=message).encode(
                                "utf-8"
                            ),
                            status=503,
                        )
                    return

                admin_username = _admin_username_from_scope(scope)

                if method == "GET" and path == "/admin/login":
                    if admin_username:
                        await self._send_redirect(send, "/admin")
                    else:
                        await self._send_html(
                            send, build_admin_login_html().encode("utf-8")
                        )
                    return

                if method == "POST" and path == "/admin/login":
                    raw_body = await self._read_body(receive)
                    form = parse_qs(raw_body.decode("utf-8", errors="replace"))
                    username = (form.get("username", [""])[0] or "").strip()
                    password = form.get("password", [""])[0] or ""
                    if username == config.admin_username and verify_admin_password(
                        password, config.admin_password_hash
                    ):
                        max_age_seconds = max(config.admin_session_ttl_minutes, 1) * 60
                        token = build_admin_session_token(
                            username,
                            config.admin_session_secret,
                            ttl_minutes=config.admin_session_ttl_minutes,
                        )
                        await self._send_redirect(
                            send,
                            "/admin",
                            extra_headers=[
                                (
                                    b"set-cookie",
                                    build_admin_session_cookie(
                                        token, max_age_seconds=max_age_seconds
                                    ).encode("utf-8"),
                                )
                            ],
                        )
                    else:
                        await self._send_html(
                            send,
                            build_admin_login_html(
                                error_message="Invalid username or password."
                            ).encode("utf-8"),
                            status=401,
                        )
                    return

                if method == "POST" and path == "/admin/logout":
                    await self._send_redirect(
                        send,
                        "/admin/login",
                        extra_headers=[
                            (
                                b"set-cookie",
                                clear_admin_session_cookie().encode("utf-8"),
                            )
                        ],
                    )
                    return

                if not admin_username:
                    if path.startswith("/admin/api/"):
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Authentication required",
                                    "hint": "Sign in at /admin/login first.",
                                },
                                ensure_ascii=False,
                            ),
                            status=401,
                        )
                    else:
                        await self._send_redirect(send, "/admin/login")
                    return

                # DB health endpoint — always available (never gated) so the UI
                # can poll status even while the database is down.
                if method == "GET" and path == "/admin/api/health":
                    await self._send_json(
                        send,
                        json.dumps(
                            db_health.monitor().snapshot(),
                            ensure_ascii=False,
                            default=str,
                        ),
                    )
                    return

                # DB health gate — block every other admin API operation (reads
                # and writes) while the database is unavailable. The SPA shell and
                # static assets are served above, so the UI still loads and shows
                # its recovery overlay; only data operations are paused.
                if (
                    path.startswith("/admin/api/")
                    and not db_health.monitor().is_healthy()
                ):
                    await self._send_json(
                        send,
                        json.dumps(
                            {
                                "error": "database_unavailable",
                                "message": "Operations are paused until the database recovers.",
                                "db_status": db_health.monitor().snapshot(),
                            },
                            ensure_ascii=False,
                            default=str,
                        ),
                        status=503,
                    )
                    return

                if path.startswith("/admin/api/"):
                    try:
                        await _ensure_runtime_ready()
                    except Exception as exc:
                        db_health.monitor().report_failure(exc)
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Admin runtime initialization failed",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                        return

                # ── Admin SPA: serve hashed assets and the index.html shell for
                #    every client-side route (the React UI in admin-ui/dist). ──
                if method == "GET" and not path.startswith("/admin/api/"):
                    rel = path[len("/admin") :].lstrip("/")  # "" for /admin
                    last_segment = rel.rsplit("/", 1)[-1]
                    if "." in last_segment:
                        # A static file request (hashed asset, favicon, …).
                        asset = _load_spa_file(rel)
                        if asset is not None:
                            body, ctype = asset
                            cache = (
                                "public, max-age=31536000, immutable"
                                if rel.startswith("assets/")
                                else "public, max-age=3600"
                            )
                            await self._send_asset(
                                send, body, ctype, cache_control=cache
                            )
                            return
                        await self._send_404(send)
                        return
                    # Client-side route → serve the SPA shell (uncached so new
                    # deploys propagate immediately).
                    shell = _load_spa_file("index.html")
                    if shell is not None:
                        await self._send_asset(
                            send,
                            shell[0],
                            "text/html; charset=utf-8",
                            cache_control="no-store",
                        )
                        return
                    # dist/ not built — surface a clear, actionable error.
                    await self._send_html(
                        send,
                        b"<h1>Admin UI not built</h1><p>Run <code>cd admin-ui &amp;&amp; "
                        b"npm install &amp;&amp; npm run build</code>, or rebuild the "
                        b"Docker image (the frontend stage builds it automatically).</p>",
                        status=503,
                    )
                    return

                if method == "GET" and path == "/admin/api/overview":
                    payload = await _build_admin_overview_payload()
                    await self._send_json(send, payload.to_json())
                    return

                # ── Implementation Guides (IG) module ─────────────────────
                if method == "GET" and path == "/admin/api/registry/search":
                    import fhir_registry

                    q = _parse_query_params(scope).get("q", "")
                    try:
                        pool = database.get_pool()
                        import admin_settings

                        cfg = await admin_settings.get_group(pool, "registry")
                        results = await fhir_registry.search(cfg.get("base_url"), q)
                        await self._send_json(
                            send,
                            json.dumps({"results": results}, ensure_ascii=False),
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"error": "Registry search failed", "detail": str(exc)},
                                ensure_ascii=False,
                            ),
                            status=502,
                        )
                    return

                if method == "GET" and path == "/admin/api/igs":
                    import admin_ig

                    pool = database.get_pool()
                    igs = await admin_ig.list_igs(pool)
                    await self._send_json(
                        send,
                        json.dumps({"igs": igs}, ensure_ascii=False, default=str),
                    )
                    return

                if method == "POST" and path == "/admin/api/igs/import":
                    import admin_ig  # noqa: F401  (kept symmetrical with siblings)

                    try:
                        body = await _read_json_body(receive)
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"error": "Invalid JSON body", "detail": str(exc)},
                                ensure_ascii=False,
                            ),
                            status=400,
                        )
                        return
                    source = str(body.get("source", "") or "").strip()
                    options: dict[str, Any] = {}
                    if source == "registry":
                        pkg_id = str(body.get("package_id", "") or "").strip()
                        if not pkg_id:
                            await self._send_json(
                                send,
                                json.dumps(
                                    {
                                        "error": "package_id is required for registry import"
                                    },
                                    ensure_ascii=False,
                                ),
                                status=400,
                            )
                            return
                        options = {
                            "ig_source": "registry",
                            "package_id": pkg_id,
                            "version": str(body.get("version", "") or "").strip(),
                        }
                    elif source == "upload":
                        uploaded_file_id = str(
                            body.get("uploaded_file_id", "") or ""
                        ).strip()
                        object_key = str(body.get("object_key", "") or "").strip()
                        try:
                            pool = database.get_pool()
                            if not object_key and uploaded_file_id:
                                async with pool.acquire() as conn:
                                    row = await conn.fetchrow(
                                        "SELECT object_key FROM admin.uploaded_files "
                                        "WHERE uploaded_file_id = $1::uuid",
                                        uploaded_file_id,
                                    )
                                object_key = row["object_key"] if row else ""
                        except Exception:
                            object_key = ""
                        if not object_key:
                            await self._send_json(
                                send,
                                json.dumps(
                                    {
                                        "error": "object_key or a valid uploaded_file_id is required"
                                    },
                                    ensure_ascii=False,
                                ),
                                status=400,
                            )
                            return
                        options = {"ig_source": "upload", "object_key": object_key}
                    else:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"error": "source must be 'registry' or 'upload'"},
                                ensure_ascii=False,
                            ),
                            status=400,
                        )
                        return
                    try:
                        pool = database.get_pool()
                        job = await create_admin_job(
                            pool,
                            module_key="ig",
                            job_type="ig_import",
                            requested_by=admin_username,
                            job_options=options,
                        )
                        await self._send_json(
                            send,
                            json.dumps({"job": job}, ensure_ascii=False, default=str),
                            status=201,
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Failed to start IG import",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                _ig_default_match = re.fullmatch(
                    r"/admin/api/igs/([^/]+)/([^/]+)/default", path
                )
                if method == "POST" and _ig_default_match:
                    import admin_ig

                    pool = database.get_pool()
                    ok = await admin_ig.set_default(
                        pool,
                        _ig_default_match.group(1),
                        _ig_default_match.group(2),
                    )
                    await self._send_json(
                        send,
                        json.dumps({"ok": ok}, ensure_ascii=False),
                        status=200 if ok else 404,
                    )
                    return

                _ig_detail_match = re.fullmatch(r"/admin/api/igs/([^/]+)/([^/]+)", path)
                if _ig_detail_match and method in ("GET", "DELETE"):
                    import admin_ig

                    pool = database.get_pool()
                    pkg_id = _ig_detail_match.group(1)
                    pkg_ver = _ig_detail_match.group(2)
                    if method == "GET":
                        detail = await admin_ig.get_ig_detail(pool, pkg_id, pkg_ver)
                        if detail is None:
                            await self._send_json(
                                send,
                                json.dumps(
                                    {"error": "IG not found"}, ensure_ascii=False
                                ),
                                status=404,
                            )
                            return
                        await self._send_json(
                            send,
                            json.dumps(detail, ensure_ascii=False, default=str),
                        )
                        return
                    # DELETE
                    result = await admin_ig.remove_ig(
                        pool,
                        pkg_id,
                        pkg_ver,
                        removed_by=admin_username,
                        minio_service=minio_service,
                    )
                    await ws_broadcast("module_changed", {"module_key": "ig"})
                    await self._send_json(
                        send,
                        json.dumps(result, ensure_ascii=False, default=str),
                        status=200 if result.get("removed") else 404,
                    )
                    return

                if method == "GET" and path == "/admin/api/settings":
                    try:
                        import admin_settings

                        pool = database.get_pool()
                        payload = await admin_settings.get_all(pool)
                        await self._send_json(
                            send, json.dumps(payload, ensure_ascii=False)
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Failed to load settings",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                if method == "POST" and path.startswith("/admin/api/settings/"):
                    import admin_settings

                    rest = path[len("/admin/api/settings/") :]
                    parts = rest.split("/")
                    group = parts[0]
                    action = parts[1] if len(parts) > 1 else ""
                    try:
                        body = await _read_json_body(receive)
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"error": "Invalid JSON body", "detail": str(exc)},
                                ensure_ascii=False,
                            ),
                            status=400,
                        )
                        return
                    try:
                        pool = database.get_pool()
                        if action == "models":
                            result = await admin_settings.list_models(
                                pool, group, body.get("values", {})
                            )
                            await self._send_json(
                                send, json.dumps(result, ensure_ascii=False)
                            )
                        elif action == "test":
                            result = await admin_settings.test_group(
                                pool, group, body.get("values", {})
                            )
                            await self._send_json(
                                send, json.dumps(result, ensure_ascii=False)
                            )
                        elif action == "":
                            saved = await admin_settings.save_group(
                                pool,
                                group,
                                body.get("values", {}),
                                updated_by=admin_username,
                            )
                            await _refresh_settings_singletons(pool, group)
                            await self._send_json(
                                send,
                                json.dumps(
                                    {"ok": True, "values": saved}, ensure_ascii=False
                                ),
                            )
                        else:
                            await self._send_json(
                                send,
                                json.dumps(
                                    {"error": f"Unknown action '{action}'"},
                                    ensure_ascii=False,
                                ),
                                status=404,
                            )
                    except ValueError as exc:
                        await self._send_json(
                            send,
                            json.dumps({"error": str(exc)}, ensure_ascii=False),
                            status=400,
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Settings operation failed",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                if method == "GET" and path == "/admin/api/services":
                    try:
                        pool = database.get_pool()
                        payload = await list_service_probes(pool)
                        await self._send_json(
                            send,
                            json.dumps(payload, ensure_ascii=False),
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Failed to load cached service probes",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                if method == "POST" and path == "/admin/api/services/probe":
                    try:
                        payload = await _read_json_body(receive)
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"error": "Invalid JSON body", "detail": str(exc)},
                                ensure_ascii=False,
                            ),
                            status=400,
                        )
                        return
                    service_keys = payload.get("service_keys") or []
                    if service_keys and not isinstance(service_keys, list):
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "service_keys must be an array when provided"
                                },
                                ensure_ascii=False,
                            ),
                            status=400,
                        )
                        return
                    try:
                        pool = database.get_pool()
                        result = await run_service_probes(
                            pool,
                            minio_service=minio_service,
                            service_keys=[str(key) for key in service_keys],
                        )
                        await self._send_json(
                            send,
                            json.dumps(result, ensure_ascii=False),
                        )
                    except ValueError as exc:
                        await self._send_json(
                            send,
                            json.dumps({"error": str(exc)}, ensure_ascii=False),
                            status=400,
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Failed to run active service probes",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                if method == "GET" and path == "/admin/api/fhir-servers":
                    try:
                        query = _parse_query_params(scope)
                        include_disabled = (
                            str(query.get("include_disabled", "false") or "false")
                            .strip()
                            .lower()
                            == "true"
                        )
                        pool = database.get_pool()
                        servers = await list_registered_fhir_servers(
                            pool,
                            include_disabled=include_disabled,
                        )
                        await self._send_json(
                            send,
                            json.dumps(
                                {"servers": servers}, ensure_ascii=False, default=str
                            ),
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Failed to list FHIR servers",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                if method == "GET" and path == "/admin/api/fhir-servers/export":
                    try:
                        pool = database.get_pool()
                        servers = await export_fhir_servers(
                            pool,
                            secret_key=fhir_server_secret_key(
                                config.admin_session_secret
                            ),
                            include_disabled=True,
                        )
                        await self._send_json(
                            send,
                            json.dumps(
                                {"servers": servers}, ensure_ascii=False, default=str
                            ),
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Failed to export FHIR servers",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                if method == "POST" and path == "/admin/api/fhir-servers":
                    try:
                        payload = await _read_json_body(receive)
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"error": "Invalid JSON body", "detail": str(exc)},
                                ensure_ascii=False,
                            ),
                            status=400,
                        )
                        return
                    try:
                        pool = database.get_pool()
                        server = await create_fhir_server(
                            pool,
                            payload,
                            admin_user=admin_username,
                            secret_key=fhir_server_secret_key(
                                config.admin_session_secret
                            ),
                        )
                        await self._send_json(
                            send,
                            json.dumps(
                                {"server": server}, ensure_ascii=False, default=str
                            ),
                            status=201,
                        )
                    except ValueError as exc:
                        await self._send_json(
                            send,
                            json.dumps({"error": str(exc)}, ensure_ascii=False),
                            status=400,
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Failed to create FHIR server",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                if method == "POST" and path == "/admin/api/fhir-servers/generate-key":
                    try:
                        payload = await _read_json_body(receive)
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"error": "Invalid JSON body", "detail": str(exc)},
                                ensure_ascii=False,
                            ),
                            status=400,
                        )
                        return
                    try:
                        alg = str(payload.get("alg") or "").strip()
                        result = generate_client_key(alg)
                        await self._send_json(
                            send,
                            json.dumps(
                                {"ok": True, **result}, ensure_ascii=False, default=str
                            ),
                        )
                    except ValueError as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"ok": False, "error": str(exc)}, ensure_ascii=False
                            ),
                            status=400,
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "ok": False,
                                    "error": "Failed to generate keypair",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                if method == "POST" and path == "/admin/api/fhir-servers/discover":
                    try:
                        payload = await _read_json_body(receive)
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"error": "Invalid JSON body", "detail": str(exc)},
                                ensure_ascii=False,
                            ),
                            status=400,
                        )
                        return
                    try:
                        result = await discover_fhir_metadata(payload)
                        await self._send_json(
                            send,
                            json.dumps(
                                {"ok": True, **result}, ensure_ascii=False, default=str
                            ),
                        )
                    except ValueError as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"ok": False, "error": str(exc)}, ensure_ascii=False
                            ),
                            status=400,
                        )
                    except Exception as exc:
                        # Metadata unreachable/invalid — let the UI fall back to
                        # manual scope entry rather than treating this as fatal.
                        await self._send_json(
                            send,
                            json.dumps(
                                {"ok": False, "error": str(exc)}, ensure_ascii=False
                            ),
                            status=200,
                        )
                    return

                if method == "POST" and path == "/admin/api/fhir-servers/test":
                    try:
                        payload = await _read_json_body(receive)
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"error": "Invalid JSON body", "detail": str(exc)},
                                ensure_ascii=False,
                            ),
                            status=400,
                        )
                        return
                    try:
                        pool = database.get_pool()
                        result = await test_fhir_server_config(
                            pool,
                            payload,
                            secret_key=fhir_server_secret_key(
                                config.admin_session_secret
                            ),
                        )
                        await self._send_json(
                            send,
                            json.dumps(result, ensure_ascii=False, default=str),
                        )
                    except ValueError as exc:
                        await self._send_json(
                            send,
                            json.dumps({"error": str(exc)}, ensure_ascii=False),
                            status=400,
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "FHIR server connection test failed",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                _fhir_probe_match = re.fullmatch(
                    r"/admin/api/fhir-servers/([^/]+)/probe", path
                )
                if method == "POST" and _fhir_probe_match:
                    try:
                        pool = database.get_pool()
                        result = await probe_fhir_server(
                            pool,
                            _fhir_probe_match.group(1),
                            secret_key=fhir_server_secret_key(
                                config.admin_session_secret
                            ),
                        )
                        await self._send_json(
                            send,
                            json.dumps(result, ensure_ascii=False, default=str),
                        )
                    except ValueError as exc:
                        await self._send_json(
                            send,
                            json.dumps({"error": str(exc)}, ensure_ascii=False),
                            status=404,
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "FHIR server probe failed",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                _fhir_default_match = re.fullmatch(
                    r"/admin/api/fhir-servers/([^/]+)/set-default", path
                )
                if method == "POST" and _fhir_default_match:
                    try:
                        pool = database.get_pool()
                        server = await set_default_fhir_server(
                            pool,
                            _fhir_default_match.group(1),
                            admin_user=admin_username,
                        )
                        await self._send_json(
                            send,
                            json.dumps(
                                {"server": server}, ensure_ascii=False, default=str
                            ),
                        )
                    except ValueError as exc:
                        await self._send_json(
                            send,
                            json.dumps({"error": str(exc)}, ensure_ascii=False),
                            status=404,
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Failed to set default FHIR server",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                _fhir_detail_match = re.fullmatch(
                    r"/admin/api/fhir-servers/([^/]+)", path
                )
                if _fhir_detail_match:
                    identifier = _fhir_detail_match.group(1)
                    if method == "GET":
                        try:
                            pool = database.get_pool()
                            server = await get_fhir_server(pool, identifier)
                            if server is None:
                                await self._send_json(
                                    send,
                                    json.dumps(
                                        {"error": "FHIR server not found"},
                                        ensure_ascii=False,
                                    ),
                                    status=404,
                                )
                            else:
                                await self._send_json(
                                    send,
                                    json.dumps(
                                        {"server": server},
                                        ensure_ascii=False,
                                        default=str,
                                    ),
                                )
                        except Exception as exc:
                            await self._send_json(
                                send,
                                json.dumps(
                                    {
                                        "error": "Failed to load FHIR server",
                                        "detail": str(exc),
                                    },
                                    ensure_ascii=False,
                                ),
                                status=500,
                            )
                        return

                    if method == "PATCH":
                        try:
                            payload = await _read_json_body(receive)
                        except Exception as exc:
                            await self._send_json(
                                send,
                                json.dumps(
                                    {"error": "Invalid JSON body", "detail": str(exc)},
                                    ensure_ascii=False,
                                ),
                                status=400,
                            )
                            return
                        try:
                            pool = database.get_pool()
                            server = await update_fhir_server(
                                pool,
                                identifier,
                                payload,
                                admin_user=admin_username,
                                secret_key=fhir_server_secret_key(
                                    config.admin_session_secret
                                ),
                            )
                            await self._send_json(
                                send,
                                json.dumps(
                                    {"server": server}, ensure_ascii=False, default=str
                                ),
                            )
                        except ValueError as exc:
                            await self._send_json(
                                send,
                                json.dumps({"error": str(exc)}, ensure_ascii=False),
                                status=400,
                            )
                        except Exception as exc:
                            await self._send_json(
                                send,
                                json.dumps(
                                    {
                                        "error": "Failed to update FHIR server",
                                        "detail": str(exc),
                                    },
                                    ensure_ascii=False,
                                ),
                                status=500,
                            )
                        return

                    if method == "DELETE":
                        try:
                            pool = database.get_pool()
                            server = await delete_fhir_server(
                                pool,
                                identifier,
                                admin_user=admin_username,
                            )
                            await self._send_json(
                                send,
                                json.dumps(
                                    {"deleted": server}, ensure_ascii=False, default=str
                                ),
                            )
                        except ValueError as exc:
                            await self._send_json(
                                send,
                                json.dumps({"error": str(exc)}, ensure_ascii=False),
                                status=404,
                            )
                        except Exception as exc:
                            await self._send_json(
                                send,
                                json.dumps(
                                    {
                                        "error": "Failed to delete FHIR server",
                                        "detail": str(exc),
                                    },
                                    ensure_ascii=False,
                                ),
                                status=500,
                            )
                        return

                if method == "GET" and path == "/admin/api/jobs":
                    try:
                        pool = database.get_pool()
                        jobs = await list_admin_jobs(pool)
                        await self._send_json(
                            send,
                            json.dumps({"jobs": jobs}, ensure_ascii=False),
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Failed to list admin jobs",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                job_detail_match = re.fullmatch(
                    r"/admin/api/jobs/([0-9a-fA-F-]+)", path
                )
                if method == "GET" and job_detail_match:
                    try:
                        pool = database.get_pool()
                        job = await get_admin_job(
                            pool, job_id=job_detail_match.group(1)
                        )
                        if job is None:
                            await self._send_json(
                                send,
                                json.dumps(
                                    {"error": "Admin job not found"}, ensure_ascii=False
                                ),
                                status=404,
                            )
                        else:
                            await self._send_json(
                                send,
                                json.dumps({"job": job}, ensure_ascii=False),
                            )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Failed to load admin job",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                job_steps_match = re.fullmatch(
                    r"/admin/api/jobs/([0-9a-fA-F-]+)/steps",
                    path,
                )
                if method == "GET" and job_steps_match:
                    try:
                        pool = database.get_pool()
                        steps = await list_job_steps(
                            pool, job_id=job_steps_match.group(1)
                        )
                        await self._send_json(
                            send,
                            json.dumps({"steps": steps}, ensure_ascii=False),
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Failed to load job steps",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                job_logs_match = re.fullmatch(
                    r"/admin/api/jobs/([0-9a-fA-F-]+)/logs",
                    path,
                )
                if method == "GET" and job_logs_match:
                    try:
                        pool = database.get_pool()
                        qs = _parse_query_params(scope)
                        log_limit = min(int(qs.get("limit", "100")), 500)
                        before_id_str = qs.get("before_id")
                        before_id = int(before_id_str) if before_id_str else None
                        logs = await list_job_logs(
                            pool,
                            job_id=job_logs_match.group(1),
                            limit=log_limit,
                            before_id=before_id,
                        )
                        await self._send_json(
                            send,
                            json.dumps({"logs": logs}, ensure_ascii=False),
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Failed to load job logs",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                if method == "GET" and path == "/admin/api/modules":
                    try:
                        pool = database.get_pool()
                        modules = await list_source_catalog(pool)
                        try:
                            maintenance = await admin_maintenance.get_states(pool)
                        except Exception:
                            maintenance = {}
                        record_counts = await _module_record_counts(pool)
                        storage = {
                            "minio_enabled": bool(
                                minio_service and minio_service.enabled
                            ),
                            "bucket": (
                                minio_service.config.bucket
                                if minio_service is not None
                                else ""
                            ),
                            "detail": (
                                "MinIO ready"
                                if minio_service is not None and minio_service.enabled
                                else (
                                    minio_service.init_error
                                    if minio_service is not None
                                    else "MinIO service not initialized"
                                )
                            ),
                        }
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "modules": modules,
                                    "upload_limits": {
                                        "max_upload_mb": config.admin_max_upload_mb
                                    },
                                    "storage": storage,
                                    "maintenance": maintenance,
                                    "record_counts": record_counts,
                                },
                                ensure_ascii=False,
                            ),
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Failed to list module sources",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                _ds_versions_match = re.fullmatch(
                    r"/admin/api/modules/([A-Za-z0-9_-]+)/versions", path
                )
                if method == "GET" and _ds_versions_match:
                    ds_key = _ds_versions_match.group(1)
                    try:
                        pool = database.get_pool()
                        versions = await list_source_versions(pool, ds_key)
                        await self._send_json(
                            send,
                            json.dumps(
                                {"module_key": ds_key, "versions": versions},
                                ensure_ascii=False,
                            ),
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Failed to load version history",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                # ── Data preview (/admin/api/modules/{key}/preview) ─────────
                _ds_preview_match = re.fullmatch(
                    r"/admin/api/modules/([A-Za-z0-9_-]+)/preview", path
                )
                if method == "GET" and _ds_preview_match:
                    ds_key = _ds_preview_match.group(1)
                    if ds_key not in PREVIEW_SUPPORTED_MODULES:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"error": f"No preview available for '{ds_key}'"},
                                ensure_ascii=False,
                            ),
                            status=400,
                        )
                        return
                    try:
                        pool = database.get_pool()
                        query = _parse_query_params(scope)
                        # Build kwargs from query parameters
                        kwargs: dict = {}
                        for k, v in query.items():
                            if k in ("page", "per_page"):
                                try:
                                    kwargs[k] = max(1, int(v))
                                except (ValueError, TypeError):
                                    kwargs[k] = 1
                            elif k == "id":
                                try:
                                    kwargs["id_"] = int(v)
                                except (ValueError, TypeError):
                                    pass
                            elif k == "class":
                                kwargs["class_"] = str(v)
                            elif k == "property":
                                kwargs["property_"] = str(v) if v else ""
                            elif k == "node":
                                kwargs["node"] = str(v) if v else None
                            elif k in ("artifact_key", "value_set_url", "field_q"):
                                if ds_key == "ig":
                                    kwargs[k] = str(v) if v else ""
                            elif k in (
                                "q",
                                "table",
                                "category",
                                "code_prefix",
                                "code_from",
                                "code_to",
                                "zh_filter",
                                "reference_filter",
                                "component",
                                "system",
                                "property",
                                "scale_type",
                                "method_type",
                                "specimen_type",
                                "unit",
                                "semantic_tag",
                                "active",
                                "language_code",
                                "map_filter",
                                "sort",
                                "direction",
                                "cs_id",
                                "mode",
                                "quality",
                                "status",
                                "class_",
                                "resource_type",
                                "grouping_id",
                                "base_type",
                                "element_source",
                                "tty",
                            ):
                                kwargs[k] = str(v) if v else ""
                        result = await dispatch_preview(pool, ds_key, kwargs)
                        await self._send_json(
                            send,
                            json.dumps(result, ensure_ascii=False, default=str),
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"error": "Preview failed", "detail": str(exc)},
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                # ── Schedule CRUD (/admin/api/modules/{key}/schedule) ────────
                _ds_schedule_match = re.fullmatch(
                    r"/admin/api/modules/([A-Za-z0-9_-]+)/schedule", path
                )
                if _ds_schedule_match:
                    ds_key = _ds_schedule_match.group(1)
                    if ds_key not in SCHEDULABLE_MODULES:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": f"Module '{ds_key}' does not support scheduling"
                                },
                                ensure_ascii=False,
                            ),
                            status=400,
                        )
                        return

                    if method == "GET":
                        try:
                            pool = database.get_pool()
                            sched = await get_schedule(pool, ds_key)
                            await self._send_json(
                                send,
                                json.dumps(
                                    {"schedule": sched.to_dict() if sched else None},
                                    ensure_ascii=False,
                                ),
                            )
                        except Exception as exc:
                            await self._send_json(
                                send,
                                json.dumps(
                                    {
                                        "error": "Failed to load schedule",
                                        "detail": str(exc),
                                    },
                                    ensure_ascii=False,
                                ),
                                status=500,
                            )
                        return

                    if method == "POST":
                        try:
                            body = await _read_json_body(receive)
                            frequency = str(body.get("frequency", "")).strip()
                            if frequency not in ("daily", "weekly", "monthly"):
                                raise ValueError(
                                    "frequency must be 'daily', 'weekly', or 'monthly'"
                                )
                            hour_utc = int(body.get("hour_utc", 2))
                            minute_utc = int(body.get("minute_utc", 0))
                            if not (0 <= hour_utc <= 23):
                                raise ValueError("hour_utc must be 0-23")
                            if not (0 <= minute_utc <= 59):
                                raise ValueError("minute_utc must be 0-59")

                            day_of_week = body.get("day_of_week")
                            day_of_month = body.get("day_of_month")
                            if frequency == "weekly":
                                if day_of_week is None:
                                    raise ValueError(
                                        "day_of_week required for weekly frequency"
                                    )
                                day_of_week = int(day_of_week)
                                if not (0 <= day_of_week <= 6):
                                    raise ValueError(
                                        "day_of_week must be 0 (Mon) to 6 (Sun)"
                                    )
                            elif frequency == "monthly":
                                if day_of_month is None:
                                    raise ValueError(
                                        "day_of_month required for monthly frequency"
                                    )
                                day_of_month = int(day_of_month)
                                if not (1 <= day_of_month <= 28):
                                    raise ValueError("day_of_month must be 1-28")

                            fetch_url = str(body.get("fetch_url") or "").strip() or None
                            source_role = (
                                str(body.get("source_role") or "").strip() or None
                            )
                            is_enabled = bool(body.get("is_enabled", True))

                            if ds_key in URL_FETCH_MODULES:
                                if not fetch_url:
                                    raise ValueError(
                                        f"fetch_url is required for '{ds_key}' schedules"
                                    )
                                if not fetch_url.lower().startswith("https://"):
                                    raise ValueError("fetch_url must use HTTPS")
                                if not source_role:
                                    raise ValueError(
                                        f"source_role is required for '{ds_key}' schedules"
                                    )

                            pool = database.get_pool()
                            username = _admin_username_from_scope(scope) or "admin"
                            sched = await upsert_schedule(
                                pool,
                                module_key=ds_key,
                                source_role=source_role,
                                fetch_url=fetch_url,
                                frequency=frequency,
                                day_of_week=(
                                    day_of_week if frequency == "weekly" else None
                                ),
                                day_of_month=(
                                    day_of_month if frequency == "monthly" else None
                                ),
                                hour_utc=hour_utc,
                                minute_utc=minute_utc,
                                is_enabled=is_enabled,
                                created_by=username,
                            )
                            await self._send_json(
                                send,
                                json.dumps(
                                    {"schedule": sched.to_dict()},
                                    ensure_ascii=False,
                                ),
                            )
                        except (ValueError, TypeError) as exc:
                            await self._send_json(
                                send,
                                json.dumps({"error": str(exc)}, ensure_ascii=False),
                                status=400,
                            )
                        except Exception as exc:
                            await self._send_json(
                                send,
                                json.dumps(
                                    {
                                        "error": "Failed to save schedule",
                                        "detail": str(exc),
                                    },
                                    ensure_ascii=False,
                                ),
                                status=500,
                            )
                        return

                    if method == "DELETE":
                        try:
                            pool = database.get_pool()
                            deleted = await delete_schedule(pool, ds_key)
                            await self._send_json(
                                send,
                                json.dumps({"deleted": deleted}, ensure_ascii=False),
                            )
                        except Exception as exc:
                            await self._send_json(
                                send,
                                json.dumps(
                                    {
                                        "error": "Failed to delete schedule",
                                        "detail": str(exc),
                                    },
                                    ensure_ascii=False,
                                ),
                                status=500,
                            )
                        return

                # ── Schedule: immediate trigger (/admin/api/modules/{key}/schedule/trigger)
                _ds_sched_trigger_match = re.fullmatch(
                    r"/admin/api/modules/([A-Za-z0-9_-]+)/schedule/trigger", path
                )
                if method == "POST" and _ds_sched_trigger_match:
                    ds_key = _ds_sched_trigger_match.group(1)
                    if ds_key not in SCHEDULABLE_MODULES:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": f"Module '{ds_key}' does not support scheduling"
                                },
                                ensure_ascii=False,
                            ),
                            status=400,
                        )
                        return
                    try:
                        pool = database.get_pool()
                        sched = await get_schedule(pool, ds_key)
                        if sched is None:
                            await self._send_json(
                                send,
                                json.dumps(
                                    {"error": "No schedule configured for this module"},
                                    ensure_ascii=False,
                                ),
                                status=404,
                            )
                            return
                        username = _admin_username_from_scope(scope) or "admin"
                        # Fire in a background task so large downloads don't block HTTP response
                        asyncio.create_task(
                            fire_schedule(
                                pool,
                                schedule=sched,
                                minio_service=minio_service,
                                triggered_by=f"manual:{username}",
                            )
                        )
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "triggered": True,
                                    "message": "Schedule trigger initiated. Check the Tasks tab for progress.",
                                    "module_key": ds_key,
                                },
                                ensure_ascii=False,
                            ),
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Failed to trigger schedule",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                if method == "GET" and path == "/admin/api/drug/status":
                    query = _parse_query_params(scope)
                    try:
                        page = max(1, int(str(query.get("page", "1") or "1")))
                    except ValueError:
                        page = 1
                    try:
                        per_page = max(
                            1, min(200, int(str(query.get("per_page", "50") or "50")))
                        )
                    except ValueError:
                        per_page = 50
                    q = str(query.get("q", "") or "").strip()
                    active_only = (
                        str(query.get("active_only", "true") or "true").strip().lower()
                        == "true"
                    )
                    failed_only = (
                        str(query.get("failed_only", "false") or "false")
                        .strip()
                        .lower()
                        == "true"
                    )
                    try:
                        pool = database.get_pool()
                        payload = await get_drug_admin_status(
                            pool,
                            page=page,
                            per_page=per_page,
                            q=q,
                            active_only=active_only,
                            failed_only=failed_only,
                        )
                        await self._send_json(
                            send,
                            json.dumps(payload, ensure_ascii=False),
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Failed to load drug admin status",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                if method == "GET" and path == "/admin/api/drug/pipeline-status":
                    try:
                        pool = database.get_pool()
                        payload = await get_drug_pipeline_status(pool)
                        await self._send_json(
                            send,
                            json.dumps(payload, ensure_ascii=False),
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Failed to load drug pipeline status",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                if method == "GET" and path == "/admin/api/drug/events":
                    query = _parse_query_params(scope)
                    license_id = str(query.get("license_id", "") or "").strip()
                    if not license_id:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"error": "license_id is required"}, ensure_ascii=False
                            ),
                            status=400,
                        )
                        return
                    try:
                        pool = database.get_pool()
                        events = await get_drug_license_events(pool, license_id)
                        await self._send_json(
                            send,
                            json.dumps(
                                {"license_id": license_id, "events": events},
                                ensure_ascii=False,
                            ),
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Failed to load drug events",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                if method == "GET" and path == "/admin/api/drug/details":
                    query = _parse_query_params(scope)
                    license_id = str(query.get("license_id", "") or "").strip()
                    include_cancelled = (
                        str(query.get("include_cancelled", "true") or "true")
                        .strip()
                        .lower()
                        == "true"
                    )
                    if not license_id:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"error": "license_id is required"}, ensure_ascii=False
                            ),
                            status=400,
                        )
                        return
                    if drug_service is None:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"error": "Drug service not available"},
                                ensure_ascii=False,
                            ),
                            status=503,
                        )
                        return
                    try:
                        payload = await drug_service.get_drug_details(
                            license_id,
                            include_cancelled=include_cancelled,
                        )
                        await self._send_json(send, payload)
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Failed to load drug details",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                if method == "GET" and path == "/admin/api/drug/assets":
                    query = _parse_query_params(scope)
                    license_id = str(query.get("license_id", "") or "").strip()
                    asset_group = (
                        str(query.get("asset_group", "") or "").strip() or None
                    )
                    if not license_id:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"error": "license_id is required"}, ensure_ascii=False
                            ),
                            status=400,
                        )
                        return
                    if drug_service is None:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"error": "Drug service not available"},
                                ensure_ascii=False,
                            ),
                            status=503,
                        )
                        return
                    try:
                        payload = await drug_service.get_drug_asset_links(
                            license_id=license_id,
                            asset_group=asset_group,
                        )
                        await self._send_json(send, payload)
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Failed to load drug assets",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                if method == "GET" and path == "/admin/api/drug/asset-content":
                    # Same-origin proxy that streams a single asset's bytes from
                    # MinIO for inline preview (PDF iframe / JSON / Markdown).
                    query = _parse_query_params(scope)
                    asset_id = str(query.get("asset_id", "") or "").strip()
                    if not asset_id:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"error": "asset_id is required"}, ensure_ascii=False
                            ),
                            status=400,
                        )
                        return
                    if drug_service is None:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"error": "Drug service not available"},
                                ensure_ascii=False,
                            ),
                            status=503,
                        )
                        return
                    try:
                        result = await drug_service.get_drug_asset_content(asset_id)
                        if result is None:
                            await self._send_json(
                                send,
                                json.dumps(
                                    {
                                        "error": "Asset not found or has no stored content"
                                    },
                                    ensure_ascii=False,
                                ),
                                status=404,
                            )
                            return
                        data, mime_type, _filename = result
                        await self._send_file(
                            send,
                            data,
                            (mime_type or "application/octet-stream").encode("utf-8"),
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Failed to load asset content",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                if method == "GET" and path == "/admin/api/embedding/status":
                    try:
                        pool = database.get_pool()
                        payload = await get_embedding_status(pool)
                        await self._send_json(
                            send,
                            json.dumps(payload, ensure_ascii=False),
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Failed to load embedding status",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                if method == "GET" and path == "/admin/api/workers":
                    try:
                        pool = database.get_pool()
                        workers = await list_worker_heartbeats(pool)
                        await self._send_json(
                            send,
                            json.dumps({"workers": workers}, ensure_ascii=False),
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Failed to list worker heartbeats",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                if method == "POST" and path == "/admin/api/uploads":
                    query = _parse_query_params(scope)
                    module_key = str(query.get("module_key", "") or "").strip()
                    source_role = str(query.get("source_role", "") or "").strip()
                    original_filename = str(query.get("filename", "") or "").strip()
                    auto_activate = (
                        str(query.get("auto_activate", "false")).strip().lower()
                        == "true"
                    )
                    raw_body = await self._read_body(receive)
                    max_upload_bytes = max(config.admin_max_upload_mb, 1) * 1024 * 1024
                    if not module_key or not source_role or not original_filename:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Missing upload metadata",
                                    "required": [
                                        "module_key",
                                        "source_role",
                                        "filename",
                                    ],
                                },
                                ensure_ascii=False,
                            ),
                            status=400,
                        )
                        return
                    if not raw_body:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"error": "Upload body is empty"},
                                ensure_ascii=False,
                            ),
                            status=400,
                        )
                        return
                    if len(raw_body) > max_upload_bytes:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Upload exceeds max size",
                                    "max_upload_mb": config.admin_max_upload_mb,
                                },
                                ensure_ascii=False,
                            ),
                            status=413,
                        )
                        return
                    # ── Magika content-type validation ────────────────────────
                    try:
                        _entry = catalog_entry(module_key, source_role)
                        validate_source_filename(original_filename, _entry)
                        await validate_source_content(raw_body, _entry)
                    except ValueError as _ve:
                        await self._send_json(
                            send,
                            json.dumps({"error": str(_ve)}, ensure_ascii=False),
                            status=415,
                        )
                        return
                    # ─────────────────────────────────────────────────────────
                    try:
                        pool = database.get_pool()
                        result = await create_uploaded_source(
                            pool,
                            minio_service=minio_service,
                            module_key=module_key,
                            source_role=source_role,
                            original_filename=original_filename,
                            mime_type=(
                                _header_value(scope, "content-type")
                                or "application/octet-stream"
                            ),
                            data=raw_body,
                            uploaded_by=admin_username,
                            auto_activate=auto_activate,
                        )
                        if result.get("duplicate"):
                            await self._send_json(
                                send,
                                json.dumps(
                                    {
                                        "message": "Duplicate upload skipped; existing source reused",
                                        "duplicate": True,
                                        "uploaded_file": result["uploaded_file"],
                                    },
                                    ensure_ascii=False,
                                ),
                                status=200,
                            )
                        else:
                            await self._send_json(
                                send,
                                json.dumps(
                                    {
                                        "duplicate": False,
                                        "uploaded_file": result["uploaded_file"],
                                    },
                                    ensure_ascii=False,
                                ),
                                status=201,
                            )
                    except ValueError as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"error": str(exc)},
                                ensure_ascii=False,
                            ),
                            status=400,
                        )
                    except RuntimeError as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"error": str(exc)},
                                ensure_ascii=False,
                            ),
                            status=503,
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Failed to persist uploaded source",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                if method == "POST" and path == "/admin/api/module-sources/activate":
                    try:
                        payload = await _read_json_body(receive)
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"error": "Invalid JSON body", "detail": str(exc)},
                                ensure_ascii=False,
                            ),
                            status=400,
                        )
                        return
                    uploaded_file_id = str(
                        payload.get("uploaded_file_id", "") or ""
                    ).strip()
                    if not uploaded_file_id:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"error": "uploaded_file_id is required"},
                                ensure_ascii=False,
                            ),
                            status=400,
                        )
                        return
                    try:
                        pool = database.get_pool()
                        module_source = await activate_source(
                            pool,
                            uploaded_file_id=uploaded_file_id,
                            activated_by=admin_username,
                        )
                        await self._send_json(
                            send,
                            json.dumps(
                                {"module_source": module_source},
                                ensure_ascii=False,
                            ),
                        )
                    except ValueError as exc:
                        await self._send_json(
                            send,
                            json.dumps({"error": str(exc)}, ensure_ascii=False),
                            status=404,
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Failed to activate module source",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                if method == "POST" and path == "/admin/api/module-sources/deactivate":
                    try:
                        payload = await _read_json_body(receive)
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"error": "Invalid JSON body", "detail": str(exc)},
                                ensure_ascii=False,
                            ),
                            status=400,
                        )
                        return
                    uploaded_file_id = str(
                        payload.get("uploaded_file_id", "") or ""
                    ).strip()
                    if not uploaded_file_id:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"error": "uploaded_file_id is required"},
                                ensure_ascii=False,
                            ),
                            status=400,
                        )
                        return
                    try:
                        pool = database.get_pool()
                        source = await deactivate_source(
                            pool,
                            uploaded_file_id=uploaded_file_id,
                            deactivated_by=admin_username,
                        )
                        await self._send_json(
                            send,
                            json.dumps(
                                {"ok": True, "source": source}, ensure_ascii=False
                            ),
                        )
                    except ValueError as exc:
                        await self._send_json(
                            send,
                            json.dumps({"error": str(exc)}, ensure_ascii=False),
                            status=400,
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Failed to deactivate module source",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                if method == "POST" and path == "/admin/api/module-sources/delete":
                    try:
                        payload = await _read_json_body(receive)
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"error": "Invalid JSON body", "detail": str(exc)},
                                ensure_ascii=False,
                            ),
                            status=400,
                        )
                        return
                    uploaded_file_id = str(
                        payload.get("uploaded_file_id", "") or ""
                    ).strip()
                    if not uploaded_file_id:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"error": "uploaded_file_id is required"},
                                ensure_ascii=False,
                            ),
                            status=400,
                        )
                        return
                    try:
                        pool = database.get_pool()
                        result = await delete_uploaded_source(
                            pool,
                            uploaded_file_id=uploaded_file_id,
                            deleted_by=admin_username,
                            minio_service=minio_service,
                        )
                        await self._send_json(
                            send,
                            json.dumps(
                                {"ok": True, "deleted": result}, ensure_ascii=False
                            ),
                        )
                    except ValueError as exc:
                        await self._send_json(
                            send,
                            json.dumps({"error": str(exc)}, ensure_ascii=False),
                            status=400,
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Failed to delete module source",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                # ── Maintenance mode toggle ──────────────────────────────────
                if method == "POST" and path == "/admin/api/module-maintenance":
                    try:
                        payload = await _read_json_body(receive)
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"error": "Invalid JSON body", "detail": str(exc)},
                                ensure_ascii=False,
                            ),
                            status=400,
                        )
                        return
                    ds_key = str(payload.get("module_key", "") or "").strip()
                    enabled = bool(payload.get("enabled", False))
                    try:
                        pool = database.get_pool()
                        new_state = await admin_maintenance.set_enabled(
                            pool, ds_key, enabled, updated_by=admin_username
                        )
                        await ws_broadcast(
                            "maintenance_changed",
                            {"module_key": ds_key, "enabled": new_state},
                        )
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "ok": True,
                                    "module_key": ds_key,
                                    "enabled": new_state,
                                },
                                ensure_ascii=False,
                            ),
                        )
                    except ValueError as exc:
                        await self._send_json(
                            send,
                            json.dumps({"error": str(exc)}, ensure_ascii=False),
                            status=400,
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Failed to set maintenance mode",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                # ── Destructive clear-and-reset (maintenance only) ───────────
                _ds_clear_match = re.fullmatch(
                    r"/admin/api/modules/([A-Za-z0-9_-]+)/clear", path
                )
                if method == "POST" and _ds_clear_match:
                    ds_key = _ds_clear_match.group(1)
                    if ds_key not in {
                        "drug",
                        "icd",
                        "loinc",
                        "snomed",
                        "ig",
                        "rxnorm",
                    }:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"error": f"Clear is not supported for '{ds_key}'"},
                                ensure_ascii=False,
                            ),
                            status=400,
                        )
                        return
                    try:
                        pool = database.get_pool()
                        if not await admin_maintenance.is_enabled(pool, ds_key):
                            await self._send_json(
                                send,
                                json.dumps(
                                    {
                                        "error": "Enable maintenance mode before clearing this module",
                                    },
                                    ensure_ascii=False,
                                ),
                                status=409,
                            )
                            return
                        if ds_key == "icd":
                            result = await clear_icd_module(
                                pool,
                                cleared_by=admin_username,
                                minio_service=minio_service,
                            )
                        elif ds_key == "loinc":
                            result = await clear_loinc_module(
                                pool,
                                cleared_by=admin_username,
                                minio_service=minio_service,
                            )
                        elif ds_key == "snomed":
                            result = await clear_snomed_module(
                                pool,
                                cleared_by=admin_username,
                                minio_service=minio_service,
                            )
                        elif ds_key == "ig":
                            result = await clear_ig_module(
                                pool,
                                cleared_by=admin_username,
                                minio_service=minio_service,
                            )
                        elif ds_key == "rxnorm":
                            result = await clear_rxnorm_module(
                                pool,
                                cleared_by=admin_username,
                                minio_service=minio_service,
                            )
                        else:
                            result = await clear_drug_module(
                                pool,
                                cleared_by=admin_username,
                                minio_service=minio_service,
                            )
                        await ws_broadcast("module_cleared", {"module_key": ds_key})
                        await self._send_json(
                            send,
                            json.dumps(
                                {"ok": True, "cleared": result}, ensure_ascii=False
                            ),
                        )
                    except ValueError as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Failed to clear module",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=409,
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Failed to clear module",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                if method == "POST" and path == "/admin/api/jobs":
                    try:
                        payload = await _read_json_body(receive)
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"error": "Invalid JSON body", "detail": str(exc)},
                                ensure_ascii=False,
                            ),
                            status=400,
                        )
                        return
                    job_type = str(payload.get("job_type", "") or "").strip()
                    module_key = str(
                        payload.get("module_key", "admin") or "admin"
                    ).strip()
                    if job_type not in ADMIN_JOB_TYPES:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Unsupported admin job type",
                                    "allowed_job_types": sorted(ADMIN_JOB_TYPES),
                                },
                                ensure_ascii=False,
                            ),
                            status=400,
                        )
                        return
                    try:
                        pool = database.get_pool()
                        job = await create_admin_job(
                            pool,
                            module_key=module_key,
                            job_type=job_type,
                            requested_by=admin_username,
                            job_options=payload.get("job_options") or {},
                            source_module_source_id=str(
                                payload.get("source_module_source_id", "") or ""
                            ).strip(),
                            source_uploaded_file_id=str(
                                payload.get("source_uploaded_file_id", "") or ""
                            ).strip(),
                        )
                        await self._send_json(
                            send,
                            json.dumps({"job": job}, ensure_ascii=False),
                            status=201,
                        )
                    except ValueError as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {"error": str(exc)},
                                ensure_ascii=False,
                            ),
                            status=400,
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Failed to create admin job",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                job_control_match = re.fullmatch(
                    r"/admin/api/jobs/([0-9a-fA-F-]+)/(pause|resume|stop|restart)",
                    path,
                )
                if method == "POST" and job_control_match:
                    try:
                        pool = database.get_pool()
                        result = await request_job_control(
                            pool,
                            job_id=job_control_match.group(1),
                            action=job_control_match.group(2),
                            requested_by=admin_username,
                        )
                        await self._send_json(
                            send,
                            json.dumps(result, ensure_ascii=False),
                        )
                    except ValueError as exc:
                        await self._send_json(
                            send,
                            json.dumps({"error": str(exc)}, ensure_ascii=False),
                            status=400,
                        )
                    except Exception as exc:
                        await self._send_json(
                            send,
                            json.dumps(
                                {
                                    "error": "Failed to apply job control",
                                    "detail": str(exc),
                                },
                                ensure_ascii=False,
                            ),
                            status=500,
                        )
                    return

                await self._send_404(send)
                return

            # ── static HTML pages ──────────────────────────────────────────
            if method == "GET":
                if path in ("", "/"):
                    await self._send_html(send, _LANDING_HTML_BYTES)
                    return
                if path == "/privacy":
                    await self._send_html(send, _PRIVACY_HTML_BYTES)
                    return
                if path == "/dpa":
                    await self._send_html(send, _DPA_HTML_BYTES)
                    return
                if path == "/status":
                    await self._send_html(send, _STATUS_HTML_BYTES)
                    return

                # ── static assets (logos + favicon) ───────────────────────
                if path in ("/favicon.ico", "/favicon.png", "/logo-s.png"):
                    if _LOGO_S_BYTES:
                        await self._send_file(send, _LOGO_S_BYTES, b"image/png")
                    else:
                        await self._send_404(send)
                    return
                if path == "/logo-h.png":
                    if _LOGO_H_BYTES:
                        await self._send_file(send, _LOGO_H_BYTES, b"image/png")
                    else:
                        await self._send_404(send)
                    return

            # ── SSE responses: disable nginx proxy buffering ───────────────
            # nginx buffers SSE by default, which breaks streaming. Injecting
            # X-Accel-Buffering: no instructs nginx to pass chunks through
            # immediately without buffering.
            async def sse_send(message):
                if message["type"] == "http.response.start":
                    headers = list(message.get("headers", []))
                    is_sse = any(
                        n.lower() == b"content-type" and b"text/event-stream" in v
                        for n, v in headers
                    )
                    if is_sse:
                        headers.append((b"x-accel-buffering", b"no"))
                        message = {**message, "headers": headers}
                await send(message)

            await self.app(scope, receive, sse_send)
            return

        await self.app(scope, receive, send)


def _call_http_factory(factory, **kwargs):
    """Call a FastMCP HTTP app factory with best-effort compatibility."""
    try:
        sig = inspect.signature(factory)
        accepted = {k: v for k, v in kwargs.items() if k in sig.parameters}
    except (TypeError, ValueError):
        accepted = kwargs

    try:
        return factory(**accepted)
    except TypeError:
        return factory()


def build_http_app():
    """Build an ASGI app for HTTP transports and wrap it with error logging."""
    transport = "sse" if config.transport == "sse" else "streamable-http"

    if hasattr(mcp, "http_app"):
        app = _call_http_factory(mcp.http_app, path=config.path, transport=transport)
    elif transport == "streamable-http" and hasattr(mcp, "streamable_http_app"):
        app = _call_http_factory(mcp.streamable_http_app, path=config.path)
    elif transport == "sse" and hasattr(mcp, "sse_app"):
        app = _call_http_factory(mcp.sse_app, path=config.path)
    elif hasattr(mcp, "app"):
        app = mcp.app
    else:
        raise RuntimeError("FastMCP does not expose an HTTP ASGI app")

    return PrivacyPageMiddleware(ApiErrorLoggingMiddleware(app))


# ============================================================
# Health check
# ============================================================


_READ_ONLY = ToolAnnotations(readOnlyHint=True)


@mcp.tool(annotations=_READ_ONLY)
async def health_check() -> str:
    """
    Return runtime readiness of the MCP server and every module-backed service.

    Call this first before any workflow to confirm the required services are online.
    Returns a lightweight JSON object — no expensive queries are run.

    Response structure:
    - `status`: `"ok"` when the database is reachable, `"degraded"` when not
    - `database`: `"ok"` | `"error"`
    - `cache`: `"ok"` | `"error"` (Redis — cache failure does not degrade tools,
      it only disables response caching)
    - `services`: object with one boolean flag per service group:
      - `icd` — ICD-10-CM/PCS codes (search_medical_codes, infer_complications,
        get_nearby_codes, check_medical_conflict, browse_icd_category)
      - `drug` — Taiwan FDA drug data (search_drug, identify_unknown_pill,
        get_drug_details, get_drug_asset_links)
      - `health_supplements` — Taiwan FDA health supplements (search_health_supplements)
      - `food_nutrition` — Taiwan FDA food composition
        (query_food_nutrition, query_food_ingredient,
         search_foods_by_nutrient, analyze_meal_nutrition)
      - `fhir_condition` — FHIR R4 Condition resources (query_fhir_condition,
        validate_fhir_condition)
      - `fhir_medication` — FHIR R4 Medication resources (query_fhir_medication,
        validate_fhir_medication)
      - `lab` — LOINC lab tests (search_loinc, query_loinc, interpret_lab_result,
        batch_interpret_lab_results)
      - `guideline` — Taiwan clinical guidelines (search_clinical_guideline,
        query_guideline)
      - `ig` — FHIR IG authoring toolset (multi-IG discovery, StructureDefinition,
        terminology, reference/bundle, validation, schema-guided fill — the `fhir_*`
        tools, e.g. fhir_list_igs, fhir_get_profile_elements, fhir_normalize_code,
        fhir_validate_resource, fhir_finalize_resource)
      - `snomed` — SNOMED CT concepts (search_snomed_concept, query_snomed_concept,
        get_snomed_relationships, query_snomed_mapping)

    A `false` flag means the module was not loaded or the service failed to
    initialize; those tools will return a service-unavailable error until the
    underlying data is populated and the service restarted.
    """
    pool = database.get_pool()
    db_ok = False
    try:
        async with pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
        db_ok = True
    except Exception:
        pass

    cache_ok = False
    try:
        client = cache_module.get_client()
        await client.ping()
        cache_ok = True
    except Exception:
        pass

    return json.dumps(
        {
            "status": "ok" if db_ok else "degraded",
            "database": "ok" if db_ok else "error",
            "db_health": db_health.monitor().snapshot(),
            "cache": "ok" if cache_ok else "error",
            "services": {
                "icd": icd_service is not None,
                "drug": drug_service is not None,
                "health_supplements": health_supplements_service is not None,
                "food_nutrition": food_nutrition_service is not None,
                "fhir_condition": fhir_condition_service is not None,
                "fhir_medication": fhir_medication_service is not None,
                "lab": lab_service is not None,
                "guideline": guideline_service is not None,
                "ig": fhir_ig_service is not None,
                "snomed": snomed_service is not None,
            },
        },
        ensure_ascii=False,
    )


# ============================================================
# Group 0B: External FHIR Servers
# ============================================================


@mcp.tool(annotations=_READ_ONLY)
@audited("list_fhir_servers")
async def list_fhir_servers(include_disabled: bool = False) -> str:
    """
    List admin-configured external FHIR servers available for MCP workflows.

    This is the discovery entry point: call it first to see which servers exist,
    what they allow, and whether they are healthy, then call `crud_fhir_server`
    to actually read/search/write. Returns `{count, servers: [...]}`.

    Each server object — identical in shape to `get_fhir_server_status` — has:

    Identity & state
    - `server_key`: stable id. Pass THIS (not the name) to `crud_fhir_server` and
      `get_fhir_server_status`.
    - `name`: human-friendly label; use it when talking to the user.
    - `description`: admin's free-text note on the server's purpose.
    - `base_url`: the FHIR R4 REST base. Informational only — you never pass URLs
      to tools; paths are built from operation/resource_type/resource_id.
    - `enabled`: if false, the server is administratively off and
      `crud_fhir_server` will refuse it — don't try to call it.
    - `default`: true means this server answers `server_key="default"`.

    Capabilities (what you may call)
    - `allowed_resource_types`: FHIR types you may target (e.g. Patient,
      Observation). If non-empty, any other type is rejected. Empty = no limit.
    - `allowed_operations`: permitted ops (metadata/read/search/create/update/
      patch/delete). A disallowed op fails. Write ops also need
      `confirm_write=true` on `crud_fhir_server`.
    - `fhir_version`: server's FHIR version from its CapabilityStatement (e.g.
      "4.0.1"); empty if not probed yet.
    - `supported_resources`: resource types the server advertised it supports;
      use to know what is actually queryable. May be empty if not probed.

    Auth (informational — the MCP server handles tokens for you; you never see or
    send tokens yourself)
    - `auth.required`: whether the server needs OAuth at all (false = calls go
      out unauthenticated).
    - `auth.type`: "none" or "oauth2_client_credentials".
    - `auth.profile`: "none" / "iua" / "smart" — the OAuth flavor.
    - `auth.token_auth_method`: how the client authenticates to the token
      endpoint (client_secret_basic/post/jwt, private_key_jwt). OAuth only.
    - `auth.token_strategy_default`: the server's default token handling —
      "fresh" (new token every call) or "cached" (reuse until expiry). You may
      override it per call via `crud_fhir_server`'s `token_strategy` argument.
    - `auth.uses_metadata`: whether the token endpoint is auto-discovered.
    - `auth.scopes`: OAuth scopes requested (the granted access level).

    Health
    - `test_path`: a path the ADMIN uses to health-check the server; not used by
      your calls. Informational.
    - `probe`: the last STORED connectivity check (not live):
      - `probe.status`: "ok" / "error" / "unknown" (never probed).
      - `probe.ok`: convenience boolean.
      - `probe.checked_at`: ISO timestamp of that probe, or null.
      - `probe.error`: short message if it failed.
      Act on it: if `probe.ok` is false (or status "error"/"unknown"), the server
      may be unreachable/misconfigured — warn the user, or try a `metadata`
      operation first, before relying on it for clinical data.

    Secrets (client secret, private key, JWK), client_id, and token endpoint URLs
    are never returned. For one server, use `get_fhir_server_status`.

    Args:
        include_disabled: Include disabled server records (enabled=false) too.
            Defaults to false (only callable servers).
    """
    try:
        pool = database.get_pool()
        servers = await list_registered_fhir_servers(
            pool,
            include_disabled=include_disabled,
        )
        safe_servers = [server_mcp_summary(server) for server in servers]
        return json.dumps(
            {"count": len(safe_servers), "servers": safe_servers},
            ensure_ascii=False,
            indent=2,
            default=str,
        )
    except Exception as exc:
        return _json_error("Failed to list FHIR servers", detail=str(exc))


@mcp.tool()
@audited("get_fhir_server_status")
async def get_fhir_server_status(server_key: str) -> str:
    """
    Get the status and configuration of ONE admin-configured external FHIR server.

    Returns a single server object with the SAME fields as `list_fhir_servers`
    (see that tool for the full meaning of every field: `server_key`, `name`,
    `base_url`, `enabled`, `default`, `allowed_resource_types`,
    `allowed_operations`, `fhir_version`, `supported_resources`, the `auth`
    block, `test_path`, and the `probe` block).

    Typical use — call this right before `crud_fhir_server` to:
    - confirm `enabled` is true (else the call will be refused);
    - check `probe.ok` — if false/"unknown", warn the user or run a `metadata`
      operation first instead of trusting it for clinical data;
    - read `allowed_operations` / `allowed_resource_types` so you only attempt
      permitted calls (and remember writes need `confirm_write=true`);
    - see `auth.required` (whether OAuth is in play — handled for you) and
      `auth.token_strategy_default` (so you know the default, and can override it
      with `crud_fhir_server`'s `token_strategy` when you need fresh vs cached).

    The `probe` is the LAST STORED result of an admin/scheduled probe — this tool
    does NOT make a live call to the FHIR server, so it is cheap and safe to call.
    Secrets, client_id, and token endpoint URLs are never returned.

    Args:
        server_key: Admin-defined server key, UUID, name, or `"default"` for the
            default server. Prefer the `server_key` value from `list_fhir_servers`.
    """
    try:
        pool = database.get_pool()
        server = await get_fhir_server(pool, server_key)
        if not server:
            return _json_error(
                "FHIR server not found",
                detail=f"No server matches '{server_key}'.",
            )
        return json.dumps(
            server_mcp_summary(server),
            ensure_ascii=False,
            indent=2,
            default=str,
        )
    except Exception as exc:
        return _json_error("Failed to get FHIR server status", detail=str(exc))


@mcp.tool()
@audited("crud_fhir_server")
async def crud_fhir_server(
    server_key: str,
    operation: Literal[
        "metadata", "read", "search", "create", "update", "patch", "delete"
    ] = "metadata",
    resource_type: str = "",
    resource_id: str = "",
    query_json: str = "",
    resource_json: str = "",
    patch_json: str = "",
    confirm_write: bool = False,
    token_strategy: Literal["auto", "fresh", "cached"] = "auto",
) -> str:
    """
    Perform a controlled FHIR REST operation against an admin-configured server.

    The server must already exist in Admin -> Modules -> FHIR Servers. This tool
    never accepts arbitrary URLs; it only builds standard FHIR REST paths from
    `operation`, `resource_type`, and `resource_id`.

    Before calling, use `list_fhir_servers` (or `get_fhir_server_status`) to pick a
    `server_key` and verify the server is `enabled`, its `probe.ok` is true, and
    your `operation`/`resource_type` are within its `allowed_operations` /
    `allowed_resource_types`. Authentication is handled for you — you never send
    tokens; the server's `auth` settings decide that automatically.

    Operations:
    - `metadata`: GET /metadata
    - `read`: GET /{ResourceType}/{id}
    - `search`: GET /{ResourceType}?...
    - `create`: POST /{ResourceType}
    - `update`: PUT /{ResourceType}/{id}
    - `patch`: PATCH /{ResourceType}/{id}
    - `delete`: DELETE /{ResourceType}/{id}

    Write operations require both admin-side permission on the selected server
    and `confirm_write=true` in this tool call.

    Args:
        server_key: Admin-defined server key, UUID, name, or `"default"`.
        operation: FHIR REST operation.
        resource_type: FHIR resource type, e.g. `"Patient"` or `"Observation"`.
        resource_id: FHIR logical id for read/update/patch/delete.
        query_json: For search, JSON object or query string, e.g. `{"name":"Wang"}`.
        resource_json: JSON resource body for create/update.
        patch_json: JSON Patch array or FHIR patch body for patch.
        confirm_write: Must be true for create/update/patch/delete.
        token_strategy: OAuth token handling for servers that use OAuth2.
            - `auto` (default): follow the server's admin-configured default
              (which itself defaults to `fresh`).
            - `fresh`: acquire a brand-new access token for this call (full
              re-authentication; most isolated, adds one token round-trip).
            - `cached`: reuse a shared per-server token until it expires (faster
              for many calls in a row). The token represents this server's client
              identity and is shared across all users, never a single user.

    Returns a JSON object describing the HTTP result:
    - `ok`: true when the FHIR server returned 2xx.
    - `status_code` / `reason`: the HTTP status (e.g. 200, 404) and reason phrase.
    - `method` / `url`: the actual request issued (for transparency/debugging).
    - `json`: the parsed FHIR response body (a resource or a Bundle for `search`),
      when the response was JSON. For a failed call this is usually an
      OperationOutcome explaining why.
    - `text`: raw body instead of `json` when the response was not JSON or was
      too large (`truncated: true`).
    - `duration_ms`: round-trip time.
    - `explanation`: a hint for common auth failures (401/403).
    - `token_strategy`: the strategy actually used (`fresh`/`cached`) after
      resolving `auto` against the server default.
    On a 4xx/5xx, read `status_code` + the OperationOutcome in `json`/`text` to
    explain the failure to the user rather than retrying blindly.
    """
    try:
        pool = database.get_pool()
        secret_key = fhir_server_secret_key(config.admin_session_secret)
        result = await perform_fhir_crud(
            pool,
            server_key=server_key,
            operation=operation,
            resource_type=resource_type,
            resource_id=resource_id,
            query=query_json,
            resource=resource_json,
            patch=patch_json,
            confirm_write=confirm_write,
            secret_key=secret_key,
            caller="mcp",
            token_strategy=token_strategy,
        )
        return json.dumps(result, ensure_ascii=False, indent=2, default=str)
    except ValueError as exc:
        return _json_error(str(exc))
    except Exception as exc:
        return _json_error("FHIR CRUD request failed", detail=str(exc))


# ============================================================
# Group 1: ICD-10
# ============================================================


@audited("search_medical_codes")
async def search_medical_codes(
    keyword: str,
    type: Literal["diagnosis", "procedure", "all"] = "all",
    limit: int = 3,
) -> str:
    """
    Search ICD-10-CM 2025 diagnosis codes and ICD-10-PCS 2025 procedure codes.

    Search behavior by `type`:
    - `diagnosis` (ICD-10-CM only): hybrid BM25 + vector embedding re-ranking —
      semantic matches surface even without exact keyword overlap, e.g. '糖尿病'
      surfaces 'E11 Type 2 diabetes mellitus with complications'.
    - `procedure` (ICD-10-PCS only): BM25 full-text only; no vector ranking.
    - `all` (default): runs both searches and returns separate `diagnoses` and
      `procedures` keys in the response.

    Output shape:
    - `diagnoses`: list of `{code, name_zh, name_en}` (ICD-10-CM)
    - `procedures`: list of `{code, name_zh, name_en}` (ICD-10-PCS, empty if data
      not loaded)
    - `procedures_note`: present when PCS data has not been loaded

    Results are ranked by relevance score, not alphabetical. The tool always
    returns up to `limit` items even when no exact match exists — treat results
    as the closest approximations found, not confirmed matches.

    Data source: ICD-10-CM 2025 (NLM) + ICD-10-PCS 2025 (CMS).

    Args:
        keyword: Search term — English name, Chinese name, or code prefix.
                 Examples: 'Diabetes', 'E11', '子宮內膜異位症', '高血壓',
                 'appendicitis', '0DTJ' (PCS prefix), 'N18' (CKD category).
        type: `"diagnosis"` | `"procedure"` | `"all"` (default `"all"`).
        limit: Results per type (default 3, max 10). Applies independently to
               both diagnoses and procedures when `type="all"`.
    """
    if await _icd_maintenance_active():
        return _svc_maintenance("ICD")
    if icd_service is None:
        return _svc_unavailable("ICD Service")
    return await icd_service.search_codes(keyword, type, limit=limit)


@audited("infer_complications")
async def infer_complications(code: str) -> str:
    """
    Explore the ICD-10-CM hierarchy for a diagnosis code or category prefix.

    This is a pure hierarchy lookup — it traverses the ICD tree, not AI-generated
    clinical inference. Use it to expand a broad code into billable specifics, or
    to find sibling codes when you already have a leaf.

    Behaviour depends on whether child codes exist:
    - **Category/parent code** (e.g. `E11`): returns up to 15 more-specific child
      codes in that subtree — useful to find the correct billable code.
    - **Leaf/specific code** (e.g. `E11.9`): no children exist, so returns up to
      10 sibling codes from the same 3-character category — useful to compare
      nearby specificity options before final code selection.

    Output shape:
    - parent result: `{"base_code", "potential_complications_or_specifics": [...]}`
    - leaf result: `{"message", "related_codes": [...]}`
    Each item: `{code, name_zh, name_en}`.

    Args:
        code: ICD-10-CM code or category prefix, e.g. `"E11"` (type 2 diabetes),
              `"E11.9"` (leaf), `"N18"` (CKD), `"N80"` (endometriosis),
              `"I10"` (essential hypertension). Case-insensitive.
    """
    if await _icd_maintenance_active():
        return _svc_maintenance("ICD")
    if icd_service is None:
        return _svc_unavailable("ICD Service")
    return await icd_service.infer_complications(code)


@audited("get_nearby_codes")
async def get_nearby_codes(code: str) -> str:
    """
    Retrieve the two ICD-10-CM codes immediately before and after a known code.

    Returns exactly 4 neighbors in tabular (alphabetical code) ordering — up to
    2 preceding codes and up to 2 following codes — plus the target code itself.
    These are ordering neighbors, not semantic matches. Use this for coder review
    workflows or "did-you-mean adjacent code" UX before final coding.

    Output shape: `{"target", "nearby_options": [{code, name_zh, name_en, rel}, ...]}`
    where `rel` is `"prev"` or `"next"`.
    Results are sorted by code alphabetically.

    Note: if the target code does not exist in the database, neighbors are still
    returned based on alphabetical ordering around that position.

    Args:
        code: ICD-10-CM diagnosis code, e.g. `"E11.9"`, `"I10"`, `"N18.4"`.
              Case-insensitive (normalized to uppercase internally).
    """
    if await _icd_maintenance_active():
        return _svc_maintenance("ICD")
    if icd_service is None:
        return _svc_unavailable("ICD Service")
    return await icd_service.get_nearby_codes(code)


@audited("check_medical_conflict")
async def check_medical_conflict(diagnosis_code: str, procedure_code: str) -> str:
    """
    Fetch full metadata for one diagnosis + one procedure code side-by-side.

    Use this for coding QA, claim pre-check, or LLM-driven plausibility review.
    The tool returns all available fields for both codes so downstream logic (or
    an LLM) can reason about anatomical alignment, gender/age specificity, and
    clinical intent.

    Output shape:
    ```json
    {
      "diagnosis_info": {code, name_zh, name_en, category, ...},
      "procedure_info": {code, name_zh, name_en, ...},
      "instruction": "Analyze the above for potential contraindications or medical conflicts."
    }
    ```
    - `procedure_info` is a string message when ICD-10-PCS data is not loaded.
    - Fields are `null` when a code is not found in the database.

    Important: this tool returns facts/metadata only — it does NOT emit a
    pass/fail verdict. Downstream rule logic or clinician review must decide.

    Args:
        diagnosis_code: ICD-10-CM code, e.g. `"K35.80"`, `"E11.9"`, `"N18.3"`.
        procedure_code: ICD-10-PCS code, e.g. `"0DTJ0ZZ"`, `"0FB04ZX"`.
                        Requires ICD-10-PCS data to be loaded (see health_check).
    """
    if await _icd_maintenance_active():
        return _svc_maintenance("ICD")
    if icd_service is None:
        return _svc_unavailable("ICD Service")
    return await icd_service.get_conflict_info(diagnosis_code, procedure_code)


# ============================================================
# Group 1b: ICD-10 category browser
# ============================================================


@audited("browse_icd_category")
async def browse_icd_category(category: str | None = None, limit: int = 50) -> str:
    """
    Browse ICD-10-CM structure by chapter or 3-character category.

    Use this for exploratory workflows where the exact billable code is not
    known yet. Typical two-step flow:
    1. Call without `category` to enumerate all top-level categories with counts
    2. Call with a 3-character category to expand it into specific codes

    Output shapes:
    - **No category** (`category=None`):
      `{"total_categories", "categories": [{category, category_name_zh,
       category_name_en, code_count}, ...]}`
    - **With category** (e.g. `"E11"`):
      `{"category", "total", "codes": [{code, name_zh, name_en}, ...]}`
    - Unknown category returns `{"error": "找不到 category '...'"}`.

    Args:
        category: 3-character ICD category prefix, e.g. `"E11"` (type 2 diabetes),
            `"I10"` (hypertension), `"N18"` (CKD), `"N80"` (endometriosis).
            Omit (or pass `null`) to list all categories.
        limit: Maximum codes returned for a single category (default 50, cap 200).
               Ignored when `category` is omitted.
    """
    if await _icd_maintenance_active():
        return _svc_maintenance("ICD")
    if icd_service is None:
        return _svc_unavailable("ICD Service")
    return await icd_service.browse_category(category, limit)


# ============================================================
# Group 2: Drug (Taiwan FDA index-first, Phase 1)
# ============================================================


@audited("search_drug")
async def search_drug(
    mode: Literal["drug_name", "ingredient", "license_id", "atc_code"] = "drug_name",
    keyword: str = "",
    limit: int = 3,
    include_cancelled: bool = False,
) -> str:
    """
    Search Taiwan FDA drug records from the canonical drug domain module.

    The search surface starts from the canonical `36_2.csv` index and is
    enriched in later phases with TFDA electronic inserts, document assets, and
    appearance data. Search is available for drug names, ingredient text,
    license identifiers, and ATC rows.

    Output shape:
    `{"mode", "keyword", "include_cancelled", "results": [...]}`

    Args:
        mode: `"drug_name"` | `"ingredient"` | `"license_id"` | `"atc_code"`.
        keyword: Search term interpreted according to `mode`.
        limit: Maximum number of results to return (default 3, max 10).
        include_cancelled: Include cancelled licenses when true.
    """
    if drug_service is None:
        return _svc_unavailable("Drug Service")
    if await _drug_maintenance_active():
        return _svc_maintenance("Drug")
    if not keyword.strip():
        return _json_error("keyword is required", mode=mode, results=[])

    if mode == "drug_name":
        payload = await _call_service_json(
            drug_service,
            "search_by_name",
            keyword,
            limit=limit,
            include_cancelled=include_cancelled,
        )
    elif mode == "ingredient":
        payload = await _call_service_json(
            drug_service,
            "search_by_ingredient",
            keyword,
            limit=limit,
            include_cancelled=include_cancelled,
        )
    elif mode == "license_id":
        payload = await _call_service_json(
            drug_service,
            "search_by_license_id",
            keyword,
            limit=limit,
            include_cancelled=include_cancelled,
        )
    elif mode == "atc_code":
        payload = await _call_service_json(
            drug_service,
            "search_by_atc_code",
            keyword,
            limit=limit,
            include_cancelled=include_cancelled,
        )
    else:
        return _json_error(
            f"Unsupported mode: {mode}",
            allowed_modes=["drug_name", "ingredient", "license_id", "atc_code"],
        )

    result = json.loads(payload)
    result["mode"] = mode
    result["keyword"] = keyword
    result["include_cancelled"] = include_cancelled
    return json.dumps(result, ensure_ascii=False)


# ============================================================
# Group 2b: Drug detail and asset tools
# ============================================================


@audited("identify_unknown_pill")
async def identify_unknown_pill(features: str) -> str:
    """
    Identify a Taiwan FDA drug by pill appearance keywords.

    Phase 2 uses enriched TFDA appearance records only. Every keyword is matched
    conjunctively against appearance description, color, shape, symbol, scoring,
    size, and imprint fields. English color/shape words are expanded with a
    small built-in synonym map.

    Args:
        features: Space-separated appearance keywords, e.g. `"white round"` or
            `"白 圓形"`.
    """
    if drug_service is None:
        return _svc_unavailable("Drug Service")
    if await _drug_maintenance_active():
        return _svc_maintenance("Drug")
    if not features.strip():
        return _json_error("features is required", results=[])
    return await _call_service_json(drug_service, "identify_unknown_pill", features)


@audited("get_drug_details")
async def get_drug_details(
    license_id: str,
    include_cancelled: bool = False,
) -> str:
    """
    Return the canonical normalized drug record for one Taiwan FDA license.

    This is the detailed companion to `search_drug`. The response is built from
    the canonical normalized JSON stored in PostgreSQL, augmented with current
    stage availability and document counts.
    """
    if drug_service is None:
        return _svc_unavailable("Drug Service")
    if await _drug_maintenance_active():
        return _svc_maintenance("Drug")
    if not license_id.strip():
        return _json_error("license_id is required")
    return await _call_service_json(
        drug_service,
        "get_drug_details",
        license_id,
        include_cancelled=include_cancelled,
    )


@audited("get_drug_asset_links")
async def get_drug_asset_links(
    license_id: str | None = None,
    asset_id: str | None = None,
    asset_group: Literal["insert", "label", "shape", "analysis"] | None = None,
    latest_insert_only: bool = False,
) -> str:
    """
    Return persisted asset metadata plus runtime-generated MinIO download links.

    The database stores stable MinIO locators; this tool adds temporary presigned
    URLs when the MinIO service is configured and reachable.
    """
    if drug_service is None:
        return _svc_unavailable("Drug Service")
    if await _drug_maintenance_active():
        return _svc_maintenance("Drug")
    return await _call_service_json(
        drug_service,
        "get_drug_asset_links",
        license_id=license_id,
        asset_id=asset_id,
        asset_group=asset_group,
        latest_insert_only=latest_insert_only,
    )


# ============================================================
# Group 3: Health Supplements (Taiwan FDA)
# ============================================================


def _health_supplement_result(row: dict) -> dict:
    """Shape one ``health_supplements.items`` row for MCP output.

    Only columns that actually exist in the table are returned
    (``permit_no, name, applicant, benefit_claims, category, valid_from``).
    Earlier versions advertised ``ingredients/specs/status/source_url`` — none
    of those columns exist, so they were always empty and have been removed.
    The real ``category`` (類別) and ``approval_date`` (核可日期, stored in
    ``valid_from``) were previously dropped and are now exposed.
    """
    return {
        "permit_no": row.get("permit_no"),
        "product_name": row.get("name"),
        "company": row.get("applicant"),
        "category": row.get("category"),
        "benefits": row.get("benefit_claims"),
        "approval_date": row.get("valid_from") or None,
    }


@audited("search_health_supplements")
async def search_health_supplements(
    mode: Literal["keyword", "permit_no", "condition"] = "keyword",
    keyword: str = "",
    limit: int = 3,
) -> str:
    """
    Search Taiwan FDA certified health supplements (健康食品) by three modes.

    Mode reference:
    - `keyword` (default): full-text + semantic search across product name,
      company, ingredient list, and approved benefit claims. Uses hybrid BM25 +
      embedding re-ranking. Returns up to `limit` results (cap 10).
      Example: keyword `"葉黃素"`, `"益生菌"`, `"lutein"`.
    - `permit_no`: look up one product by its Taiwan FDA permit number.
      Supports exact match (e.g. `"健食字第A00022號"`) or bare digits
      (`"A00022"` or `"00022"`). Always returns at most 1 result.
      `limit` is ignored in this mode.
    - `condition`: map a disease name or ICD-10 code to recommended health
      benefit categories, then find certified products matching those benefits.
      Returns extra top-level fields `icd_code` and `recommended_benefits`.
      Example: keyword `"糖尿病"` or `"E11"` or `"高血壓"`.

    Response shape (all modes) — every field maps to a real Taiwan FDA column;
    no synthetic/always-empty fields are returned:
    ```json
    {
      "mode": "keyword" | "permit_no" | "condition",
      "keyword": "<input>",
      "results": [
        {
          "permit_no",       // FDA permit number (健食字…)
          "product_name",    // 中文品名
          "company",         // 申請商
          "category",        // 類別 (e.g. 個案審查 / 規格標準)
          "benefits",        // 保健功效 — approved benefit claims (string)
          "approval_date"    // 核可日期 (YYYY-MM-DD or FDA date string), or null
        }
      ]
    }
    ```
    `condition` mode additionally includes `"icd_code"` and
    `"recommended_benefits"` at the top level. Note: the FDA dataset does not
    publish per-product ingredient lists, packaging specs, or a product-page
    URL, so those are intentionally not returned.

    Args:
        mode: `"keyword"` | `"permit_no"` | `"condition"`. Default `"keyword"`.
        keyword: In `keyword` mode — product/ingredient/benefit search term.
                 In `permit_no` mode — the permit number or its digits.
                 In `condition` mode — a disease name or ICD-10 code.
        limit: Max results (default 3, cap 10). Applies to `keyword` and
               `condition` modes; ignored for `permit_no` (always returns ≤1).
    """
    if health_supplements_service is None:
        return _svc_unavailable("Health Supplements Service")
    if not keyword:
        return _json_error("Provide keyword")

    limit = min(max(1, limit), 10)
    async with health_supplements_service.pool.acquire() as conn:
        if mode == "keyword":
            raw = await health_supplements_service.search_health_supplements(
                keyword, limit=limit
            )
            payload = json.loads(raw)
            results = []
            for item in payload.get("results", []):
                permit_no = item.get("permit_no")
                if not permit_no:
                    continue
                row = await conn.fetchrow(
                    "SELECT * FROM health_supplements.items WHERE permit_no = $1",
                    permit_no,
                )
                if row:
                    results.append(_health_supplement_result(dict(row)))
            out = {"mode": mode, "keyword": keyword, "results": results}
            # Carry the service's keyword-only degradation marker, if any.
            if "search_mode" in payload:
                out["search_mode"] = payload["search_mode"]
                out["search_note"] = payload.get("search_note")
            return json.dumps(out, ensure_ascii=False)

        if mode == "permit_no":
            row = await conn.fetchrow(
                "SELECT * FROM health_supplements.items WHERE permit_no = $1", keyword
            )
            if not row:
                digits = re.search(r"\d+", keyword)
                if digits:
                    digits_only = digits.group()
                    if keyword.isdigit():
                        row = await conn.fetchrow(
                            "SELECT * FROM health_supplements.items WHERE permit_no ILIKE $1 ORDER BY permit_no LIMIT 1",
                            f"%{digits_only}%",
                        )
                    else:
                        rows = await conn.fetch(
                            "SELECT * FROM health_supplements.items WHERE permit_no ILIKE $1 ORDER BY permit_no LIMIT 50",
                            f"%{digits_only}%",
                        )
                        row = rows[0] if rows else None
            if not row:
                return json.dumps(
                    {"mode": mode, "keyword": keyword, "results": []},
                    ensure_ascii=False,
                )
            return json.dumps(
                {
                    "mode": mode,
                    "keyword": keyword,
                    "results": [_health_supplement_result(dict(row))],
                },
                ensure_ascii=False,
            )

        if mode == "condition":
            raw = await health_supplements_service.analyze_health_support_for_condition(
                keyword, icd_service=icd_service
            )
            payload = json.loads(raw)
            icd_code = payload.get("icd_code")
            recommended_benefits = payload.get("recommended_benefits", [])
            foods = payload.get("health_supplements", [])
            results = []
            for food in foods[:limit]:
                permit_no = food.get("permit_no")
                if not permit_no:
                    continue
                row = await conn.fetchrow(
                    "SELECT * FROM health_supplements.items WHERE permit_no = $1",
                    permit_no,
                )
                if row:
                    results.append(_health_supplement_result(dict(row)))
            return json.dumps(
                {
                    "mode": mode,
                    "keyword": keyword,
                    "icd_code": icd_code,
                    "recommended_benefits": recommended_benefits or [],
                    "results": results,
                },
                ensure_ascii=False,
            )

    return _json_error("Provide mode as keyword, permit_no, or condition")


# ============================================================
# Group 4: Food Nutrition
# ============================================================


@audited("query_food_nutrition")
async def query_food_nutrition(
    food_name: str,
    nutrient: str | None = None,
    limit: int = 3,
    detailed: bool = False,
) -> str:
    """
    Search Taiwan FDA food composition database for nutritional content per 100 g.

    Uses hybrid BM25 + semantic embedding re-ranking to find the closest matching
    foods. E.g. `"白米"` may surface `"蓬萊米"` or `"米飯(熟)"`.

    Two output modes controlled by `detailed`:

    **`detailed=False`** (default) — quick lookup, flat nutrient list:
    - Returns up to `limit` foods (cap 10).
    - Supports optional `nutrient` filter (partial ILIKE match, e.g. `"蛋白"`
      matches `"粗蛋白"`). Omit `nutrient` to return all nutrients.
    - Output: `[{food, category, nutrients: [{item, value, unit}, ...]}, ...]`

    **`detailed=True`** — complete nutrient panel, grouped by category:
    - Always returns up to 3 best-matching foods; `limit` is ignored.
    - `nutrient` filter is ignored; always returns the full panel.
    - Nutrient panel covers energy, macronutrients, vitamins (A/B1/B2/B6/B12/C/
      D/E/K/niacin/folate), minerals (Ca/P/Fe/Na/K/Mg/Zn/Mn/Cu/Se/I), fatty
      acids (SFA/MUFA/PUFA/trans/cholesterol/EPA/DHA — EPA/DHA only for seafood).
    - Output: `[{sample_name, common_name, food_category,
      nutrients: {category_name: [{item, value, unit}]}}]`

    Data source: Taiwan FDA Food Composition Database (台灣食品成分資料庫).
    Values are per 100 g edible portion.

    Args:
        food_name: Food name in Chinese or English (e.g. `"白米"`, `"雞蛋"`,
                   `"豆腐"`, `"chicken breast"`, `"salmon"`, `"鮭魚"`).
        nutrient: Nutrient column filter (default mode only). Partial Taiwan FDA
                  column names accepted — e.g. `"粗蛋白"`, `"蛋白"`, `"鈣"`,
                  `"維生素C"`, `"膳食纖維"`, `"熱量"`. Omit to get all nutrients.
        limit: Closest-matching food variants to return (default 3, max 10).
               Applies to `detailed=False` only.
        detailed: `False` (default) for quick flat lookup; `True` for full
                  grouped nutrient panel.
    """
    if food_nutrition_service is None:
        return _svc_unavailable("Food Nutrition Service")
    if detailed:
        return await food_nutrition_service.get_detailed_nutrition(food_name)
    return await food_nutrition_service.search_nutrition(
        food_name, nutrient, limit=limit
    )


@audited("query_food_ingredient")
async def query_food_ingredient(
    keyword: str,
    category: (
        Literal[
            "可供食品使用之原料",
            "未確認安全性尚不得使用之原料",
        ]
        | None
    ) = None,
    limit: int = 3,
) -> str:
    """
    Search the Taiwan FDA food ingredient classification database by keyword,
    with an optional category filter.

    Uses hybrid BM25 + semantic embedding re-ranking to find the closest matching
    ingredients even when the exact name is unknown.

    Data coverage: food additives, natural-origin ingredients, flavourings,
    processing aids, and novel food categories
    (台灣食品添加物及食品原料資料庫).

    Categories (`major_category` values in the database):
    - `"可供食品使用之原料"` — approved for food use (1,170 entries)
    - `"未確認安全性尚不得使用之原料"` — safety unconfirmed, not yet permitted (532 entries)
    Omit `category` to search across both.

    Output: `[{name_zh, name_en, major_category, sub_category, note}, ...]`

    Args:
        keyword: Ingredient name in Chinese or English. Examples: `"薑黃"`,
                 `"turmeric"`, `"卡拉膠"`, `"carrageenan"`, `"山梨酸"`,
                 `"sorbic acid"`, `"紅麴"`, `"亞硝酸鈉"`.
        category: Optional filter by `major_category`. Omit to search all.
        limit: Max results (default 3, max 10).
    """
    if food_nutrition_service is None:
        return _svc_unavailable("Food Nutrition Service")
    return await food_nutrition_service.search_food_ingredient(
        keyword, limit=limit, category=category
    )


@audited("search_foods_by_nutrient")
async def search_foods_by_nutrient(nutrient: str, limit: int = 20) -> str:
    """
    Rank Taiwan FDA foods by highest content of a specific nutrient (per 100 g).

    Nutrient resolution order:
    1. Built-in alias map (common synonyms → canonical column name):
       `"蛋白質"` / `"protein"` → `"粗蛋白"`,
       `"維他命C"` / `"vitamin c"` → `"維生素C"`,
       `"calcium"` / `"鈣"` → `"鈣"`,
       `"fat"` / `"脂肪"` → `"粗脂肪"`,
       `"fiber"` / `"纖維"` → `"膳食纖維"`,
       `"EPA"`, `"DHA"` → direct column names.
    2. Partial ILIKE match against Taiwan FDA nutrient column names.
    3. Semantic embedding search if steps 1 and 2 find nothing.

    Results are sorted descending by nutrient value — the food with the highest
    content of the requested nutrient is first.

    Output shape:
    `{"nutrient", "unit", "total", "note", "foods": [{name, common_name,
      category, content_per_100g, unit}, ...]}`
    `nutrient` echoes the resolved canonical column name (e.g. `"蛋白質"`
    resolves to `"粗蛋白"`). Foods have no stable code, so none is returned.

    Args:
        nutrient: Nutrient name in Chinese or English — aliases and synonyms
                  accepted. Examples: `"粗蛋白"`, `"蛋白質"`, `"protein"`,
                  `"鈣"`, `"calcium"`, `"維生素C"`, `"維他命C"`, `"vitamin c"`,
                  `"膳食纖維"`, `"fiber"`, `"EPA"`, `"DHA"`, `"熱量"`,
                  `"粗脂肪"`, `"fat"`.
        limit: Foods to return (default 20, max 50).
    """
    if food_nutrition_service is None:
        return _svc_unavailable("Food Nutrition Service")
    limit = min(max(1, limit), 50)
    return await food_nutrition_service.search_foods_by_nutrient(nutrient, limit)


@audited("analyze_meal_nutrition")
async def analyze_meal_nutrition(foods: list[str]) -> str:
    """
    Aggregate nutrition for a meal from multiple foods (100 g per food assumed).

    Resolves each food name against the Taiwan FDA food composition database, then
    sums nutrient values across all items. Returns both per-food breakdowns and
    a combined meal total. Use `query_food_nutrition(detailed=True)` first if
    you need to confirm which row a partial name resolves to.

    Portion assumption: every food in the list is treated as exactly 100 g.
    To adjust for real serving sizes, scale the returned values manually.

    Output shape:
    ```json
    {
      "meal_components": {
        "<food_name>": {"found": true, "food_name": "...", "nutrients": {...}}
      },
      "combined_totals_per_100g_each": {"熱量": ..., "粗蛋白": ..., ...}
    }
    ```
    Foods that cannot be matched appear with `"found": false`.

    Args:
        foods: List of food names in Chinese.
               Example: `["白米飯", "雞胸肉", "青花菜", "豆腐", "鮭魚"]`.
               Partial names are accepted where a single matching row exists.
    """
    if food_nutrition_service is None:
        return _svc_unavailable("Food Nutrition Service")
    return await food_nutrition_service.analyze_meal_nutrition(foods)


# ============================================================
# Group 5: FHIR Condition
# ============================================================
@audited("query_fhir_condition")
async def query_fhir_condition(
    icd_code: str | None = None,
    diagnosis_keyword: str | None = None,
    patient_id: str = "",
    clinical_status: Literal["active", "inactive", "resolved", "remission"] = "active",
    verification_status: Literal[
        "confirmed", "provisional", "differential", "refuted"
    ] = "confirmed",
    category: Literal[
        "encounter-diagnosis", "problem-list-item"
    ] = "encounter-diagnosis",
    severity: str | None = None,
    onset_date: str | None = None,
    recorded_date: str | None = None,
    additional_notes: str | None = None,
) -> str:
    """
    Generate a FHIR R4 Condition resource from an ICD-10-CM code or a keyword.

    Two routing paths (provide exactly one of `icd_code` or `diagnosis_keyword`):

    **Path A — direct code** (`icd_code` provided):
    Builds the Condition resource directly from the given ICD-10-CM code.
    All optional fields (`patient_id`, `clinical_status`, `verification_status`,
    `category`, `severity`, `onset_date`, `recorded_date`, `additional_notes`)
    are applied to the resource.

    **Path B — keyword search** (`diagnosis_keyword` provided):
    Searches the ICD service for the best-matching diagnosis code first, then
    builds the Condition from that match. In this path, only `patient_id`,
    `clinical_status`, and `verification_status` are forwarded to the resource;
    `category`, `severity`, `onset_date`, `recorded_date`, and
    `additional_notes` are NOT applied — use Path A with the returned code if
    you need those fields populated.

    Output: a FHIR R4 Condition JSON resource with TWCore IG coding extensions.

    Args:
        icd_code: Exact ICD-10-CM code, e.g. `"E11.9"`, `"I10"`, `"N18.3"`.
                  Takes priority over `diagnosis_keyword` if both are given.
        diagnosis_keyword: Diagnosis term in Chinese or English for search-first
                           flow, e.g. `"第二型糖尿病"`, `"diabetes mellitus"`,
                           `"高血壓"`.
        patient_id: Value for `Condition.subject.reference` (e.g. `"Patient/123"`).
        clinical_status: `"active"` | `"inactive"` | `"resolved"` | `"remission"`.
        verification_status: `"confirmed"` | `"provisional"` | `"differential"` |
                             `"refuted"`.
        category: `"encounter-diagnosis"` (default) for a visit diagnosis, or
                  `"problem-list-item"` for a chronic/persistent problem.
                  Only applied in Path A (direct code).
        severity: Optional free-text severity label, e.g. `"mild"`, `"moderate"`,
                  `"severe"`. Only applied in Path A.
        onset_date: `YYYY-MM-DD` onset date. Only applied in Path A.
        recorded_date: `YYYY-MM-DDTHH:MM:SS+08:00` timestamp. Only applied in Path A.
        additional_notes: Optional clinical note string. Only applied in Path A.
    """
    # FHIR Condition is built from icd.diagnoses, so it follows ICD maintenance.
    if await _icd_maintenance_active():
        return _svc_maintenance("ICD")
    if fhir_condition_service is None:
        return _svc_unavailable("FHIR Condition Service")
    if diagnosis_keyword:
        return await _call_service_json(
            fhir_condition_service,
            "create_condition_from_search",
            keyword=diagnosis_keyword,
            patient_id=patient_id,
            clinical_status=clinical_status,
            verification_status=verification_status,
            severity=severity,
        )
    if not icd_code:
        return _json_error("Provide either icd_code or diagnosis_keyword")
    return await _call_service_json(
        fhir_condition_service,
        "create_condition",
        icd_code=icd_code,
        patient_id=patient_id,
        clinical_status=clinical_status,
        verification_status=verification_status,
        category=category,
        severity=severity,
        onset_date=onset_date,
        recorded_date=recorded_date,
        additional_notes=additional_notes,
    )


@audited("validate_fhir_condition")
async def validate_fhir_condition(condition_json: str) -> str:
    """
    Validate a FHIR R4 Condition resource for required fields and value-set compliance.

    Validation checks performed:
    - `resourceType` must be `"Condition"`
    - `subject` reference must be present
    - `code.coding` must include at least one entry with a system and code
      (ICD-10-CM system expected)
    - `clinicalStatus.coding[0].code` must be one of:
      `active`, `recurrence`, `relapse`, `inactive`, `remission`, `resolved`
    - `verificationStatus.coding[0].code` must be one of:
      `unconfirmed`, `provisional`, `differential`, `confirmed`, `refuted`,
      `entered-in-error`

    Output shape:
    `{"valid": true|false, "errors": ["..."], "resource_type": "Condition"}`

    ⚠️ Basic structural validation only. For production use, validate with the
    official HL7 FHIR Validator or Taiwan TWCore IG validator.

    Args:
        condition_json: JSON string of a FHIR R4 Condition resource.
                        Use `query_fhir_condition` to generate one first.
    """
    if fhir_condition_service is None:
        return _svc_unavailable("FHIR Condition Service")
    try:
        condition = json.loads(condition_json)
        result = fhir_condition_service.validate_condition(condition)
        return fhir_condition_service.to_json_string(result, indent=2)
    except json.JSONDecodeError as e:
        return _json_error(
            f"Invalid JSON: {e}", valid=False, errors=[f"Invalid JSON: {e}"]
        )


# ============================================================
# Group 5B: FHIR Medication
# ============================================================
@audited("query_fhir_medication")
async def query_fhir_medication(
    license_id: str | None = None,
    keyword: str | None = None,
    resource_type: Literal["Medication", "MedicationKnowledge"] = "Medication",
) -> str:
    """
    Generate a FHIR R4 Medication or MedicationKnowledge resource for a TFDA drug.

    Two routing paths (provide exactly one of `license_id` or `keyword`):

    **Path A — direct license** (`license_id` provided):
    Builds the resource directly from the exact TFDA license ID or bare numeric
    token. Supports both `Medication` and `MedicationKnowledge`.

    **Path B — keyword search** (`keyword` provided):
    Searches the normalized drug records for the best-matching TFDA drug first,
    then builds the requested FHIR resource from that selected match.

    Output: a FHIR R4 Medication-family JSON object derived from normalized
    TFDA data only. No RxNorm dependency is used anywhere in this flow.

    Args:
        license_id: Exact TFDA license number, e.g. `"衛署藥製字第000480號"`
            or bare digits like `"000480"`. Takes priority over `keyword`.
        keyword: Drug name or ingredient term for search-first flow,
            e.g. `"普拿疼"` or `"acetaminophen"`.
        resource_type: `"Medication"` (default) or `"MedicationKnowledge"`.
    """
    if fhir_medication_service is None:
        return _svc_unavailable("FHIR Medication Service")
    if await _drug_maintenance_active():
        return _svc_maintenance("Drug")
    if license_id:
        return await _call_service_json(
            fhir_medication_service,
            "create_medication",
            license_id=license_id,
            resource_type=resource_type,
        )
    if keyword:
        return await _call_service_json(
            fhir_medication_service,
            "create_medication_from_search",
            keyword=keyword,
            resource_type=resource_type,
        )
    return _json_error("Provide either license_id or keyword")


@audited("validate_fhir_medication")
async def validate_fhir_medication(medication_json: str) -> str:
    """
    Validate structure and core field semantics of FHIR medication resources.

    Supported resource types: `Medication` and `MedicationKnowledge`.
    The validator detects the type from `resourceType` in the JSON.

    Validation checks:
    - `resourceType` must be `Medication` or `MedicationKnowledge`
    - `code.coding` must be present with at least one entry
    - each `ingredient` row must include `itemCodeableConcept` or `itemReference`

    Output shape:
    `{"valid": true|false, "resource_type": "...", "errors": ["..."]}`

    Args:
        medication_json: JSON string of a FHIR Medication or MedicationKnowledge
            resource. Use `query_fhir_medication` to generate one first.
    """
    if fhir_medication_service is None:
        return _svc_unavailable("FHIR Medication Service")
    try:
        medication = json.loads(medication_json)
        result = fhir_medication_service.validate_medication(medication)
        return fhir_medication_service.to_json_string(result, indent=2)
    except json.JSONDecodeError as e:
        return _json_error(
            f"Invalid JSON: {e}", valid=False, errors=[f"Invalid JSON: {e}"]
        )


# ============================================================
# Group 6: Lab / LOINC
# ============================================================


@audited("search_loinc")
async def search_loinc(
    mode: Literal["code", "category", "specimen", "component"] = "code",
    keyword: str = "",
    category: str | None = None,
    limit: int = 3,
) -> str:
    """
    Discover LOINC codes and categories with mode-specific search behavior.

    Mode reference:
    - `code` (default): search by test name, abbreviation, or analyte keyword.
      Uses hybrid BM25 + semantic embedding re-ranking. Optional `category`
      parameter narrows to a LOINC class (e.g. `"CHEM"`, `"HEM/BC"`, `"UA"`).
      Examples: keyword `"HbA1c"`, `"Glucose Serum"`, `"ALT"`, `"血紅素"`.
    - `category`: list or filter LOINC categories from the local module.
      Without `keyword` → returns all categories with counts.
      With `keyword` → client-side filters the category list (case-insensitive
      substring match; no embedding). Useful for finding valid class codes to
      pass back as `category` in `code` mode.
    - `specimen`: search by specimen/system type. Hybrid BM25 + embedding.
      Examples: keyword `"Urine"`, `"Serum"`, `"血清/血漿"`, `"CSF"`.
    - `component`: search by analyte/component (the thing measured). Hybrid
      BM25 + embedding. Examples: `"glucose"`, `"creatinine"`, `"hemoglobin"`.

    Output shapes:
    - `category` mode: `{"mode", "keyword", "total_found", "categories": [...]}`
    - other modes: `{"keyword", "total_found", "results": [...]}` where each
      record carries the full LOINC axes: `loinc_num, long_common_name,
      shortname, name_zh, common_name_zh, component, property, time_aspect,
      system, scale_type, method_type, class, classtype, specimen_type, unit,
      status`. (`specimen`/`component` modes group/return a focused subset.)

    Keyword is required for `code`, `specimen`, and `component` modes.
    For `category` mode, omitting `keyword` returns all categories.

    Args:
        mode: `"code"` | `"category"` | `"specimen"` | `"component"`.
        keyword: Query text. Required for `code`, `specimen`, `component` modes.
                 Optional filter for `category` mode.
        category: LOINC class code filter (only for `mode="code"`).
                  Examples: `"CHEM"`, `"HEM/BC"`, `"UA"`, `"MICRO"`.
        limit: Max results (default 3, max 10). Ignored for `category` when
               `keyword` is empty (returns all categories).
    """
    if await _loinc_maintenance_active():
        return _svc_maintenance("LOINC")
    if lab_service is None:
        return _svc_unavailable("Lab Service")

    limit = min(max(1, limit), 10)

    if mode == "category":
        raw = await lab_service.list_categories()
        if not keyword:
            return raw
        try:
            parsed = json.loads(raw)
        except Exception:
            return raw
        categories = parsed.get("categories") or []
        filtered = [c for c in categories if keyword.lower() in str(c).lower()][:limit]
        return json.dumps(
            {
                "mode": "category",
                "keyword": keyword,
                "total_found": len(filtered),
                "categories": filtered,
            },
            ensure_ascii=False,
        )

    if not keyword:
        return json.dumps(
            {
                "error": f"keyword is required for mode={mode}",
                "mode": mode,
            },
            ensure_ascii=False,
        )

    if mode == "code":
        return await lab_service.search_loinc_code(keyword, category, limit=limit)
    if mode == "specimen":
        return await lab_service.search_by_specimen(keyword, limit=limit)
    if mode == "component":
        return await lab_service.find_related_tests(keyword, limit=limit)

    return json.dumps(
        {"error": f"Unsupported mode: {mode}"},
        ensure_ascii=False,
    )


@audited("query_loinc")
async def query_loinc(
    mode: Literal["detail", "reference_range"] = "detail",
    loinc_code: str = "",
    age: int | None = None,
    gender: Literal["M", "F", "all"] = "all",
) -> str:
    """
    Look up a known LOINC code for full detail or age/gender-stratified reference range.

    Use this after you already know the LOINC code. For discovery, use `search_loinc`.

    Mode reference:
    - `detail` (default): returns full concept record including long common name,
      component, system, method type, scale type, LOINC class, and a patient-friendly
      description. Output: `{loinc_code, long_common_name, component, system,
      method_type, scale_type, class, patient_friendly_name, ...}`.
    - `reference_range`: returns the reference interval for the test stratified
      by `age` and `gender`. Requires both `loinc_code` and `age`.
      Output: `{loinc_code, age, gender, low, high, unit, interpretation_notes}`.
      Returns an error if no reference range data exists for the code.

    Args:
        mode: `"detail"` (default) | `"reference_range"`.
        loinc_code: LOINC code in `NNNNN-N` format, e.g. `"4548-4"` (HbA1c),
                    `"2345-7"` (Glucose), `"718-7"` (Hemoglobin), `"1558-6"`.
        age: Patient age in years. Required for `reference_range` mode.
        gender: `"M"` | `"F"` | `"all"` (default). Used in `reference_range` to
                select sex-specific intervals; ignored in `detail` mode.
    """
    if await _loinc_maintenance_active():
        return _svc_maintenance("LOINC")
    if lab_service is None:
        return _svc_unavailable("Lab Service")
    if not loinc_code:
        return json.dumps({"error": "loinc_code is required"}, ensure_ascii=False)

    if mode == "detail":
        return await lab_service.get_patient_friendly_name(loinc_code)
    if mode == "reference_range":
        if age is None:
            return json.dumps(
                {"error": "age is required for mode=reference_range"},
                ensure_ascii=False,
            )
        return await lab_service.get_reference_range(loinc_code, age, gender)

    return json.dumps(
        {"error": f"Unsupported mode: {mode}"},
        ensure_ascii=False,
    )


@audited("interpret_lab_result")
async def interpret_lab_result(
    loinc_code: str, value: float, age: int, gender: Literal["M", "F", "all"] = "all"
) -> str:
    """
    Interpret one lab result against the applicable LOINC reference range.

    Looks up the age- and gender-stratified reference range for `loinc_code`,
    then compares `value` to it. Returns a structured interpretation with the
    range, the measured value, and a normal/high/low/critical flag.

    Output shape:
    `{loinc_code, value, unit, age, gender, reference_range: {low, high},
     interpretation: "normal"|"high"|"low"|"critical_high"|"critical_low",
     interpretation_note}`

    When to use: you have exactly one test result and want a fast readout.
    For a full panel, use `batch_interpret_lab_results` instead.
    To find LOINC codes, use `search_loinc`.

    ⚠️ Reference values are general guidance only. Final interpretation must
    always consider symptoms, medications, specimen context, and clinician review.

    Args:
        loinc_code: LOINC code in `NNNNN-N` format, e.g. `"4548-4"` (HbA1c),
                    `"2345-7"` (Glucose [Ser/Plas]), `"718-7"` (Hemoglobin),
                    `"1558-6"` (Fasting Glucose).
        value: Measured numeric result in the test's standard unit (e.g. mg/dL,
               g/dL, %).
        age: Patient age in years (integer).
        gender: `"M"` | `"F"` | `"all"` (default, gender-neutral range).
    """
    if await _loinc_maintenance_active():
        return _svc_maintenance("LOINC")
    if lab_service is None:
        return _svc_unavailable("Lab Service")
    return await lab_service.interpret_lab_result(loinc_code, value, age, gender)


@audited("batch_interpret_lab_results")
async def batch_interpret_lab_results(
    results_json: str, age: int, gender: Literal["M", "F", "all"] = "all"
) -> str:
    """
    Interpret a full panel of lab results against LOINC reference ranges in one call.

    Panel-level companion to `interpret_lab_result` — avoids repeated single-item
    calls for health checkup panels or EHR result feeds. Evaluates each item
    independently, then returns per-test interpretations and an abnormality summary.

    `results_json` must be a **JSON array** (not an object). Each element must
    have `loinc_code` (string) and `value` (number):
    ```json
    [
      {"loinc_code": "4548-4", "value": 7.2},
      {"loinc_code": "2345-7", "value": 126},
      {"loinc_code": "718-7",  "value": 13.5}
    ]
    ```
    Passing a JSON object or non-array returns an error without calling the service.

    Output shape:
    `{"total_tests", "abnormal_count", "results": [{loinc_code, value, unit,
     interpretation, reference_range: {low, high}}, ...],
     "abnormal_summary": [{loinc_code, interpretation}, ...]}`

    ⚠️ Reference values are general guidance. Final interpretation must be
    reviewed in clinical context with a licensed healthcare professional.

    Args:
        results_json: JSON array string of `{loinc_code, value}` objects (see above).
        age: Patient age in years (integer).
        gender: `"M"` | `"F"` | `"all"` (gender-neutral, default).
    """
    if await _loinc_maintenance_active():
        return _svc_maintenance("LOINC")
    if lab_service is None:
        return _svc_unavailable("Lab Service")
    try:
        results = json.loads(results_json)
    except json.JSONDecodeError as e:
        return json.dumps({"error": f"Invalid JSON: {e}"}, ensure_ascii=False)
    if not isinstance(results, list):
        return _json_error(
            "results_json must be a JSON array of {loinc_code, value} objects"
        )
    return await lab_service.batch_interpret_results(results, age, gender)


# ============================================================
# Group 9: Clinical Guidelines
# ============================================================


@audited("search_clinical_guideline")
async def search_clinical_guideline(keyword: str, limit: int = 3) -> str:
    """
    Search Taiwan clinical practice guidelines by disease name or ICD-10 code.

    Uses hybrid BM25 + semantic embedding ranking — cross-language matching works,
    e.g. `"高血壓"` surfaces hypertension guidelines and `"diabetes"` surfaces
    `"糖尿病"` guidelines. Results are ranked by relevance, not keyword-filtered;
    the tool always returns up to `limit` items even without an exact match.

    Use this tool to discover available guidelines and find the ICD code(s) used
    as keys. Then call `query_guideline(icd_code=..., section=...)` to retrieve
    the full content.

    Output shape:
    `{"keyword", "total_found", "guidelines": [{icd_code, disease_name_zh,
     disease_name_en, summary, has_medication, has_tests, has_goals, ...}, ...]}`

    Args:
        keyword: Disease name in Chinese or English, or ICD-10 code.
                 Examples: `"糖尿病"`, `"E11"`, `"高血壓"`, `"I10"`,
                 `"dyslipidaemia"`, `"E78"`, `"慢性腎臟病"`, `"N18"`.
        limit: Closest-matching guidelines to return (default 3, max 10).
    """
    if guideline_service is None:
        return _svc_unavailable("Clinical Guideline Service")
    return await guideline_service.search_guideline(keyword, limit=limit)


@audited("query_guideline")
async def query_guideline(
    icd_code: str,
    section: Literal[
        "complete", "medication", "test", "goals", "pathway", "contraindications"
    ] = "complete",
    patient_context_json: str | None = None,
    medication_class: str | None = None,
) -> str:
    """
    Retrieve a specific section from a Taiwan clinical practice guideline.

    One stable tool for all guideline content — switch between sections by
    changing `section` without changing the tool name. Use `search_clinical_guideline`
    first to discover available ICD codes and confirm a guideline exists.

    Section reference:
    - `complete` (default): full guideline summary — disease overview, first-line
      and alternative medications, required tests, treatment goals, and pathway.
      Returns the most comprehensive view in one call.
    - `medication`: medication recommendations only — first-line agents,
      second-line/add-on therapy, and special population adjustments (renal,
      hepatic, elderly, pregnancy).
    - `test`: required and recommended diagnostic examinations, lab tests,
      imaging studies, and follow-up monitoring schedule.
    - `goals`: treatment targets and outcome goals, e.g. HbA1c < 7%, BP < 130/80,
      LDL-C < 100 mg/dL.
    - `pathway`: synthesized step-by-step clinical management pathway. Supports
      optional `patient_context_json` to personalize the recommendations.
      Example personalized pathway for a 65-year-old with CKD:
      `patient_context_json='{"age": 65, "comorbidities": ["CKD", "heart failure"]}'`
    - `contraindications`: guideline recommendations and contraindications for a
      specific drug class against this diagnosis. REQUIRES `medication_class`.
      Returns `matched_recommendations` (rows whose class/examples match),
      `all_contraindications_for_diagnosis`, and a clinician-review warning.
      Example: `query_guideline(icd_code="E11", section="contraindications",
      medication_class="Metformin")`.

    Output: JSON object whose shape varies by section; always contains
    `icd_code` and `section` at the top level.

    Args:
        icd_code: Guideline ICD-10 key, e.g. `"E11"` (type 2 DM), `"I10"`
                  (hypertension), `"N18"` (CKD), `"E78"` (dyslipidaemia).
                  Use `search_clinical_guideline` to discover valid keys.
        section: `"complete"` | `"medication"` | `"test"` | `"goals"` |
                 `"pathway"` | `"contraindications"`.
        patient_context_json: Optional JSON object string providing patient context
                              for `section="pathway"` only. Ignored for other sections.
                              Supported keys: `age` (int), `gender` ("M"|"F"),
                              `comorbidities` (list of strings), `current_medications`
                              (list), `lab_values` (object). Any subset is valid.
                              Example: `'{"age": 70, "comorbidities": ["CKD stage 3"]}'`
        medication_class: Drug class or example name. REQUIRED for
                          `section="contraindications"` (e.g. `"Metformin"`,
                          `"ACE inhibitor"`); ignored for other sections.
    """
    if guideline_service is None:
        return _svc_unavailable("Clinical Guideline Service")
    section_map = {
        "complete": "get_complete_guideline",
        "medication": "get_medication_recommendations",
        "test": "get_test_recommendations",
        "goals": "get_treatment_goals",
        "pathway": "suggest_clinical_pathway",
        "contraindications": "check_medication_contraindications",
    }
    method_name = section_map.get(section)
    if method_name is None:
        return _json_error(
            f"Unknown guideline section: {section}",
            allowed_sections=list(section_map),
        )
    if method_name == "check_medication_contraindications":
        if not medication_class:
            return _json_error(
                "medication_class is required for section=contraindications"
            )
        return await _call_service_json(
            guideline_service, method_name, icd_code, medication_class
        )
    if method_name == "suggest_clinical_pathway":
        context = None
        if patient_context_json:
            try:
                context = json.loads(patient_context_json)
            except json.JSONDecodeError:
                return _json_error("patient_context_json is not valid JSON")
        return await _call_service_json(
            guideline_service, method_name, icd_code, context
        )
    return await _call_service_json(guideline_service, method_name, icd_code)


# ============================================================
# Group 10: FHIR IG (multi-IG discovery + StructureDefinition reading)
# ============================================================
# Generic, IG-scoped toolset over the multi-IG `fhir.*` store. Every tool takes
# optional `package_id` + `version`; omit both to target the default IG. Every
# response uses the common envelope {ok, data, warnings, provenance, error?}.


def _fhir_ig_unavailable() -> str:
    return _svc_unavailable("FHIR IG Service")


@audited("fhir_list_igs")
async def fhir_list_igs() -> str:
    """List the FHIR Implementation Guide (IG) packages installed on this server.

    Returns each IG's `packageId`, `version`, `title`, `canonical`, `fhirVersion`,
    `status`, `isDefault` flag, and declared `dependencies`. Use this first when
    several IGs are installed and you must pick one (match by jurisdiction/intent);
    the `isDefault` IG is used when a tool is called without `package_id`.
    """
    if fhir_ig_service is None:
        return _fhir_ig_unavailable()
    if await _ig_maintenance_active():
        return _svc_maintenance("FHIR IG")
    return await fhir_ig_service.list_igs()


@audited("fhir_get_ig")
async def fhir_get_ig(package_id: str | None = None, version: str | None = None) -> str:
    """Details of one IG package: identity, dependencies, and per-resource-type
    artifact counts.

    Args:
        package_id: IG package id (e.g. `"tw.gov.mohw.twcore"`). Omit → default IG.
        version: Specific version. Omit → that package's default/highest.
    """
    if fhir_ig_service is None:
        return _fhir_ig_unavailable()
    if await _ig_maintenance_active():
        return _svc_maintenance("FHIR IG")
    return await fhir_ig_service.get_ig(package_id=package_id, version=version)


@audited("fhir_list_artifacts")
async def fhir_list_artifacts(
    resource_type: str | None = None,
    grouping_id: str | None = None,
    package_id: str | None = None,
    version: str | None = None,
    limit: int = 50,
) -> str:
    """List an IG's conformance artifacts (StructureDefinitions, ValueSets,
    CodeSystems, examples, …) as summary rows.

    Args:
        resource_type: FHIR type filter, e.g. `"StructureDefinition"`, `"ValueSet"`.
        grouping_id: IG grouping filter, e.g. `"profiles"`, `"terminology"`,
            `"extensions-datatypes"`, `"examples"`.
        package_id / version: target IG (omit → default IG).
        limit: max rows (default 50, cap 200).
    """
    if fhir_ig_service is None:
        return _fhir_ig_unavailable()
    if await _ig_maintenance_active():
        return _svc_maintenance("FHIR IG")
    return await fhir_ig_service.list_artifacts(
        package_id=package_id,
        version=version,
        resource_type=resource_type,
        grouping_id=grouping_id,
        limit=limit,
    )


@audited("fhir_search_artifacts")
async def fhir_search_artifacts(
    keyword: str,
    resource_type: str | None = None,
    package_id: str | None = None,
    version: str | None = None,
    limit: int = 20,
) -> str:
    """Full-text search an IG's artifacts by id / canonical URL / name / title /
    description.

    Args:
        keyword: search term.
        resource_type: optional FHIR type filter.
        package_id / version: target IG (omit → default IG).
        limit: max rows (default 20, cap 100).
    """
    if fhir_ig_service is None:
        return _fhir_ig_unavailable()
    if await _ig_maintenance_active():
        return _svc_maintenance("FHIR IG")
    return await fhir_ig_service.search_artifacts(
        keyword=keyword,
        package_id=package_id,
        version=version,
        resource_type=resource_type,
        limit=limit,
    )


@audited("fhir_list_resource_profiles")
async def fhir_list_resource_profiles(
    base_type: str | None = None,
    package_id: str | None = None,
    version: str | None = None,
) -> str:
    """List the IG's selectable resource Profiles (constraint StructureDefinitions),
    grouped by the base FHIR resource type they constrain
    (e.g. `Patient` → `Patient-twcore`).

    Args:
        base_type: optional base resource filter, e.g. `"Condition"`.
        package_id / version: target IG (omit → default IG).
    """
    if fhir_ig_service is None:
        return _fhir_ig_unavailable()
    if await _ig_maintenance_active():
        return _svc_maintenance("FHIR IG")
    return await fhir_ig_service.list_resource_profiles(
        package_id=package_id, version=version, base_type=base_type
    )


@audited("fhir_rank_resource_profiles")
async def fhir_rank_resource_profiles(
    keys: list[str],
    base_type: str | None = None,
    package_id: str | None = None,
    version: str | None = None,
    limit: int = 5,
) -> str:
    """Rank candidate Profiles by how many of your source-data field keys match
    each profile's element paths. This **only suggests** — the response carries
    `selectionRequired:true`; you must make the final pick yourself, it never
    auto-maps.

    Args:
        keys: source field names you intend to populate, e.g.
            `["code", "subject", "onset", "clinicalStatus"]`.
        base_type: optional base resource filter, e.g. `"Condition"`.
        package_id / version: target IG (omit → default IG).
        limit: max candidates (default 5, cap 20).
    """
    if fhir_ig_service is None:
        return _fhir_ig_unavailable()
    if await _ig_maintenance_active():
        return _svc_maintenance("FHIR IG")
    return await fhir_ig_service.rank_resource_profiles(
        keys=keys,
        package_id=package_id,
        version=version,
        base_type=base_type,
        limit=limit,
    )


@audited("fhir_get_profile")
async def fhir_get_profile(
    identifier: str,
    package_id: str | None = None,
    version: str | None = None,
) -> str:
    """Summary of one Profile / StructureDefinition: identity, base definition,
    derivation, and element count. Resolve by artifact id, canonical URL, or
    artifact_key; canonicals defined in a dependency IG resolve transitively.

    Args:
        identifier: profile id (e.g. `"Condition-twcore"`), canonical URL, or key.
        package_id / version: target IG (omit → default IG).
    """
    if fhir_ig_service is None:
        return _fhir_ig_unavailable()
    if await _ig_maintenance_active():
        return _svc_maintenance("FHIR IG")
    return await fhir_ig_service.get_profile(
        identifier=identifier, package_id=package_id, version=version
    )


@audited("fhir_get_profile_elements")
async def fhir_get_profile_elements(
    profile: str,
    view: Literal[
        "elements", "element", "slices", "choices", "binding", "examples"
    ] = "elements",
    path: str | None = None,
    slice_name: str | None = None,
    package_id: str | None = None,
    version: str | None = None,
    limit: int = 200,
) -> str:
    """Read a Profile's StructureDefinition snapshot — the structural truth
    (cardinality, types, bindings, slicing, choice[x], constraints).

    One tool, several `view`s of the same snapshot:
    - `elements` (default): every element projected (min/max/types/mustSupport/
      binding/fixed/pattern/short/constraints).
    - `element`: a single element by `path` (optionally a named slice via
      `slice_name`).
    - `slices`: `slicing` rules + discriminator + the defined slices at `path`.
    - `choices`: a `[x]` element's allowed types + the JSON property name for each
      (e.g. `Condition.onset[x]` → `onsetDateTime` / `onsetPeriod` / …).
    - `binding`: the terminology binding (strength + ValueSet) on `path`.
    - `examples`: official example instances whose `meta.profile` cites this profile.

    `path` is required for `element` / `slices` / `choices` / `binding`.

    Args:
        profile: profile id (e.g. `"Condition-twcore"`), canonical URL, or key.
        view: which projection to return (see above).
        path: element path, e.g. `"Condition.code"` (required for some views).
        slice_name: optional slice name for `view=element`.
        package_id / version: target IG (omit → default IG).
        limit: max elements for `view=elements` (default 200, cap 1000).
    """
    if fhir_ig_service is None:
        return _fhir_ig_unavailable()
    if await _ig_maintenance_active():
        return _svc_maintenance("FHIR IG")
    return await fhir_ig_service.get_profile_elements(
        profile=profile,
        package_id=package_id,
        version=version,
        view=view,
        path=path,
        slice_name=slice_name,
        limit=limit,
    )


# ---- Terminology (Phase 2) -------------------------------------------------- #


@audited("fhir_get_valueset")
async def fhir_get_valueset(
    identifier: str,
    package_id: str | None = None,
    version: str | None = None,
) -> str:
    """Return a ValueSet's definition (`compose` block + metadata) without
    expanding it. Use `fhir_expand_valueset` to enumerate the member codes.

    Args:
        identifier: ValueSet id (e.g. `"condition-code-sct-tw"`), canonical URL,
            or artifact_key.
        package_id / version: target IG (omit → default IG).
    """
    if fhir_ig_service is None:
        return _fhir_ig_unavailable()
    if await _ig_maintenance_active():
        return _svc_maintenance("FHIR IG")
    return await fhir_ig_service.get_valueset(
        identifier=identifier, package_id=package_id, version=version
    )


@audited("fhir_expand_valueset")
async def fhir_expand_valueset(
    identifier: str,
    package_id: str | None = None,
    version: str | None = None,
    limit: int = 500,
) -> str:
    """Expand a ValueSet to its member codings, resolved locally where possible:
    inline concepts, SNOMED `is-a` descendants, whole IG CodeSystems, and imported
    ValueSets. Whole large external systems are NOT enumerated (a `TOO_BROAD`
    warning + `unresolved` entry is returned instead); when the result is capped,
    `truncated:true` is set — the tool never silently drops codes.

    Args:
        identifier: ValueSet id, canonical URL, or artifact_key.
        package_id / version: target IG (omit → default IG).
        limit: max codings to return (default 500, cap 2000).

    Returns `{codings[], total, truncated, unresolved[]}` in `data`.
    """
    if fhir_ig_service is None:
        return _fhir_ig_unavailable()
    if await _ig_maintenance_active():
        return _svc_maintenance("FHIR IG")
    return await fhir_ig_service.expand_valueset(
        identifier=identifier, package_id=package_id, version=version, limit=limit
    )


@audited("fhir_lookup_code")
async def fhir_lookup_code(
    system: str,
    code: str,
    package_id: str | None = None,
    version: str | None = None,
) -> str:
    """Look up the display/definition of a `(system, code)` pair from locally held
    terminology (IG CodeSystems, SNOMED CT, LOINC, ICD). This is the replacement
    for the former `query_twcore_code` lookup. If the code's system is external
    and not held, `found:false` is returned with a warning — never a fabricated
    display.

    Args:
        system: code system URL (e.g. `"http://snomed.info/sct"`) or an IG
            CodeSystem canonical.
        code: the code value (e.g. `"6142004"`).
        package_id / version: target IG for IG-internal systems (omit → default).
    """
    if fhir_ig_service is None:
        return _fhir_ig_unavailable()
    if await _ig_maintenance_active():
        return _svc_maintenance("FHIR IG")
    return await fhir_ig_service.lookup_code(
        system=system, code=code, package_id=package_id, version=version
    )


@audited("fhir_validate_code")
async def fhir_validate_code(
    system: str,
    code: str,
    value_set: str,
    package_id: str | None = None,
    version: str | None = None,
) -> str:
    """Check whether a `(system, code)` is a member of a ValueSet (expand-then-
    contains). Returns `result` = `"valid"` | `"invalid"` | `"unverifiable"`.
    When the bound system cannot be fully expanded locally, the result is
    `"unverifiable"` (never a false `invalid`/`valid`).

    Args:
        system: the code's system URL.
        code: the code value.
        value_set: ValueSet id / canonical / artifact_key to validate against.
        package_id / version: target IG (omit → default IG).
    """
    if fhir_ig_service is None:
        return _fhir_ig_unavailable()
    if await _ig_maintenance_active():
        return _svc_maintenance("FHIR IG")
    return await fhir_ig_service.validate_code(
        system=system,
        code=code,
        value_set=value_set,
        package_id=package_id,
        version=version,
    )


@audited("fhir_normalize_code")
async def fhir_normalize_code(
    text: str,
    value_set: str | None = None,
    system: str | None = None,
    package_id: str | None = None,
    version: str | None = None,
    limit: int = 10,
) -> str:
    """Turn free text (e.g. a clinical phrase like `"流行性感冒"`) into ranked
    candidate codes for a target system or ValueSet. Hybrid matching: IG
    ConceptMaps, lexical display/alias match, and semantic embedding search
    (semantic degrades gracefully when the embedding service is offline).

    The candidates are *suggestions* — always confirm the chosen one with
    `fhir_validate_code` before writing it into a resource.

    Args:
        text: the free-text term to normalize.
        value_set: a ValueSet to scope candidates to (its bound systems are the
            targets; a SNOMED `is-a` filter scopes to that subtree).
        system: an explicit target system (alternative to `value_set`).
        package_id / version: target IG (omit → default IG).
        limit: max candidates (default 10, cap 50).

    Provide at least one of `value_set` or `system`.
    """
    if fhir_ig_service is None:
        return _fhir_ig_unavailable()
    if await _ig_maintenance_active():
        return _svc_maintenance("FHIR IG")
    return await fhir_ig_service.normalize_code(
        text=text,
        value_set=value_set,
        system=system,
        package_id=package_id,
        version=version,
        limit=limit,
    )


# ---- Reference / Bundle (Phase 3 — IG-agnostic pure logic) ------------------ #


def _fhir_env_ok(data, warnings=None) -> str:
    return json.dumps(
        {"ok": True, "data": data, "warnings": warnings or [], "provenance": None},
        ensure_ascii=False,
        default=str,
    )


def _fhir_env_err(code: str, message: str) -> str:
    return json.dumps(
        {
            "ok": False,
            "data": None,
            "warnings": [],
            "error": {"code": code, "message": message},
        },
        ensure_ascii=False,
    )


@audited("fhir_resolve_reference")
async def fhir_resolve_reference(
    key: str,
    resource_type: str | None = None,
    context_id: str | None = None,
    display: str | None = None,
) -> str:
    """Mint (or return) a stable `urn:uuid` reference for a logical `key` within a
    build context, so resources can reference each other before they are finalized.

    Use the returned `reference` as BOTH the target resource's `fullUrl` and the
    referrer's `reference` value. The same `(contextId, key)` always returns the
    same urn. The first call (no `context_id`) creates a context and returns its
    `contextId`; pass that id back on subsequent calls in the same build session.

    Args:
        key: a stable logical id for the resource (e.g. `"patient-1"`).
        resource_type: optional FHIR type, echoed back for convenience.
        context_id: the build context to use; omit to start a new one.
        display: optional display text, echoed back.

    Returns `{contextId, reference, resourceType, display}`.
    """
    if await _ig_maintenance_active():
        return _svc_maintenance("FHIR IG")
    if not key or not str(key).strip():
        return _fhir_env_err("INVALID_ARGUMENT", "key is required")
    cid, urn = fhir_reference.mint(context_id, str(key))
    return _fhir_env_ok(
        {
            "contextId": cid,
            "reference": urn,
            "resourceType": resource_type,
            "display": display,
        }
    )


@audited("fhir_build_bundle")
async def fhir_build_bundle(
    entries: list[dict],
    bundle_type: str = "transaction",
    context_id: str | None = None,
) -> str:
    """Assemble inline FHIR resources into a Bundle, wiring `urn:uuid` references.

    Each entry is `{resource, key?, fullUrl?, request?}`. Each entry's `fullUrl` is
    taken from an explicit `fullUrl`, else minted from its `key` via the context,
    else a fresh urn. References inside resources that name a known `key` (or
    `Type/key`) are rewritten to the matching urn; `urn:uuid:` references that do
    not match any entry are reported in `unresolved` (never guessed). For
    `transaction` bundles, a default `request` of `POST <resourceType>` is added
    when an entry omits one.

    This does NOT validate conformance — use `fhir_validate_bundle` (later) for that.

    Args:
        entries: list of `{resource, key?, fullUrl?, request?}`.
        bundle_type: `"transaction"` (default), `"collection"`, `"batch"`, etc.
        context_id: build context for `key`→urn resolution (from
            `fhir_resolve_reference`); omit to mint within a fresh context.

    Returns `{bundle, referenceMap, unresolved}`.
    """
    if await _ig_maintenance_active():
        return _svc_maintenance("FHIR IG")
    if not isinstance(entries, list) or not entries:
        return _fhir_env_err("INVALID_ARGUMENT", "entries must be a non-empty list")
    result = fhir_reference.build_bundle(
        entries, bundle_type=bundle_type, context_id=context_id
    )
    warnings = []
    if result["unresolved"]:
        warnings.append(
            f"{len(result['unresolved'])} reference(s) could not be resolved within the bundle"
        )
    return _fhir_env_ok(result, warnings)


# ---- Validation (Phase 4 — in-process pre-flight, source:"builtin") --------- #


@audited("fhir_validate_resource")
async def fhir_validate_resource(
    resource: dict,
    profile: str | None = None,
    package_id: str | None = None,
    version: str | None = None,
) -> str:
    """Validate a FHIR resource against an IG profile, in-process. This is a fast,
    explainable **pre-flight** check (`source:"builtin"`) — the downstream FHIR
    server remains the authoritative validator. Checks: structure (cardinality /
    required / choice[x] / fixed / pattern / maxLength), value/pattern slicing,
    required-binding membership, and FHIRPath invariants. Anything that cannot be
    verified locally is reported as `warning`/`information`, never a false pass.

    Args:
        resource: the FHIR resource JSON (must include `resourceType`).
        profile: profile id / canonical to validate against; omit to use the
            resource's own `meta.profile`.
        package_id / version: target IG (omit → default IG).

    Returns `{valid, profile, source, issues:[{severity, path, code, message}]}`.
    """
    if fhir_ig_service is None:
        return _fhir_ig_unavailable()
    if await _ig_maintenance_active():
        return _svc_maintenance("FHIR IG")
    return await fhir_ig_service.validate_resource(
        resource=resource, profile=profile, package_id=package_id, version=version
    )


@audited("fhir_validate_bundle")
async def fhir_validate_bundle(
    bundle: dict,
    package_id: str | None = None,
    version: str | None = None,
) -> str:
    """Validate a FHIR Bundle in-process: each entry's resource against its
    `meta.profile` (same checks as `fhir_validate_resource`) **plus** internal
    reference integrity — every `urn:uuid:` / `#contained` reference must resolve
    within the bundle. Pre-flight only (`source:"builtin"`).

    Args:
        bundle: a FHIR `Bundle` resource.
        package_id / version: target IG (omit → default IG).

    Returns `{valid, source, entries[], referenceIssues[]}`.
    """
    if fhir_ig_service is None:
        return _fhir_ig_unavailable()
    if await _ig_maintenance_active():
        return _svc_maintenance("FHIR IG")
    return await fhir_ig_service.validate_bundle(
        bundle=bundle, package_id=package_id, version=version
    )


# ---- Schema-guided fill / authoring (Phase 5) ------------------------------- #


@audited("fhir_get_resource_skeleton")
async def fhir_get_resource_skeleton(
    profile: str,
    package_id: str | None = None,
    version: str | None = None,
    candidate_limit: int = 20,
    include_examples: bool = True,
) -> str:
    """Get a blanked, annotated fill-form for authoring a resource against a profile.

    For each element you should fill, returns its path, cardinality (required?/array?),
    type(s), `choice[x]` JSON property names, the bound ValueSet with **candidate
    codes**, `mustSupport`, and a short description. `fixed`/`pattern` elements are
    marked `autoPinned` — the server fills those on finalize; do not set them. Official
    IG examples are attached as few-shot.

    Workflow: this → fill the semantic blanks (use the terminology tools for codes) →
    `fhir_finalize_resource(profile, draft)` to pin mechanics + validate.

    Args:
        profile: profile id (e.g. `"Condition-twcore"`) / canonical / artifact_key.
        package_id / version: target IG (omit → default IG).
        candidate_limit: max candidate codes per bound element (default 20, cap 100).
        include_examples: attach official example instances.
    """
    if fhir_ig_service is None:
        return _fhir_ig_unavailable()
    if await _ig_maintenance_active():
        return _svc_maintenance("FHIR IG")
    return await fhir_ig_service.get_resource_skeleton(
        profile=profile,
        package_id=package_id,
        version=version,
        candidate_limit=candidate_limit,
        include_examples=include_examples,
    )


@audited("fhir_finalize_resource")
async def fhir_finalize_resource(
    profile: str,
    draft: dict,
    context_id: str | None = None,
    key: str | None = None,
    package_id: str | None = None,
    version: str | None = None,
) -> str:
    """Finalize an LLM-filled draft: deterministically pin the *mechanical* fields and
    validate. The server pins `fixed`/`pattern` values and `meta.profile`, infers a
    coding's `system` when the bound ValueSet is single-system, rewrites references via
    the build context, then runs the in-process validator. **It does not auto-loop** —
    on validation failure, read the issues, fix your draft, and call finalize again.

    Args:
        profile: profile id / canonical / artifact_key to conform to.
        draft: your filled resource JSON (semantic blanks filled; leave mechanics out).
        context_id: build context (from `fhir_resolve_reference`) for key→urn wiring.
        key: register THIS resource under a logical key so other resources can
            reference it; returns its minted `urn:uuid` reference.
        package_id / version: target IG (omit → default IG).

    Returns `{resource, validation, pinned, contextId, reference}`.
    """
    if fhir_ig_service is None:
        return _fhir_ig_unavailable()
    if await _ig_maintenance_active():
        return _svc_maintenance("FHIR IG")
    return await fhir_ig_service.finalize_resource(
        profile=profile,
        draft=draft,
        context_id=context_id,
        key=key,
        package_id=package_id,
        version=version,
    )


# ============================================================
# Group 11: SNOMED CT
# ============================================================


@audited("search_snomed_concept")
async def search_snomed_concept(
    query: str,
    limit: int = 3,
    hierarchy_filter: int = None,
) -> str:
    """
    Search SNOMED CT International Edition (370,000+ active concepts) by English term.

    Uses hybrid BM25 + semantic embedding re-ranking — semantic matches surface
    even without exact keyword overlap. E.g. `"heart attack"` surfaces
    `"Myocardial infarction (disorder)"` (22298006).

    Results are ranked by relevance and always include up to `limit` items even
    without an exact match — treat results as the closest approximations, not
    confirmed matches. Each result contains `concept_id`, `fsn` (Fully Specified
    Name), `preferred_term`, `active`, and `hierarchy_tag` (the semantic tag in
    parentheses, e.g. `"disorder"`, `"procedure"`, `"substance"`).

    For full concept detail plus parent/child hierarchy, follow up with
    `query_snomed_concept(concept_id=...)`.

    Args:
        query: English clinical term — SNOMED uses English only.
               Examples: `"diabetes mellitus"`, `"myocardial infarction"`,
               `"hypertension"`, `"fracture of femur"`, `"appendectomy"`,
               `"metformin"`, `"insulin"`.
        limit: Closest-matching concepts to return (default 3, max 10).
        hierarchy_filter: Optional SNOMED concept ID to restrict results to one
                          semantic hierarchy. Common roots:
                          - `404684003` Clinical finding (disorder/finding)
                          - `71388002`  Procedure
                          - `373873005` Pharmaceutical/biologic product
                          - `123037004` Body structure
                          - `105590001` Substance
                          - `362981000` Qualifier value
                          Omit to search all hierarchies.
    """
    if snomed_service is None:
        return _svc_unavailable("SNOMED CT")
    if await _snomed_maintenance_active():
        return _svc_maintenance("SNOMED CT")
    results = await snomed_service.search_concepts(
        query, min(limit, 10), hierarchy_filter
    )
    if isinstance(results, str):
        return results  # Already JSON string from cache
    return json.dumps(results, ensure_ascii=False, indent=2)


@audited("query_snomed_concept")
async def query_snomed_concept(
    concept_id: int,
    include_parents: bool = True,
    include_children: bool = True,
    parent_limit: int = 10,
    child_limit: int = 20,
) -> str:
    """
    Fetch a SNOMED CT concept with optional IS-A hierarchy expansion.

    The preferred SNOMED entry point when you want the concept record AND its
    surrounding tree in one call. Reduces multi-hop lookups for hierarchy
    navigation.

    Output shape:
    ```json
    {
      "concept_id": 73211009,
      "concept": {concept_id, fsn, hierarchy_tag, synonyms, active,
                  definition_status, parents, icd10_maps},
      "ancestor_count": 5,
      "ancestors": [{concept_id, fsn, preferred_term, depth}, ...],
      "children_count": 12,
      "children": [{concept_id, fsn, preferred_term}, ...]
    }
    ```
    Omit `ancestors`/`children` keys by setting the corresponding flag to false.

    Args:
        concept_id: SNOMED CT concept ID (integer).
                    Examples: `73211009` (Diabetes mellitus), `44054006` (Type 2 DM),
                    `22298006` (Myocardial infarction), `38341003` (Hypertension).
        include_parents: Include ancestor chain via IS-A relationships (default true).
                         Set false to skip ancestry lookup.
        include_children: Include direct child concepts (default true).
                          Set false to skip children lookup.
        parent_limit: Max ancestor depth to return (default 10, cap 20).
        child_limit: Max child concepts to return (default 20, cap 200).
    """
    if snomed_service is None:
        return _svc_unavailable("SNOMED CT")
    if await _snomed_maintenance_active():
        return _svc_maintenance("SNOMED CT")

    concept = await snomed_service.get_concept(concept_id)
    if concept is None:
        return json.dumps(
            {"error": f"Concept {concept_id} not found"}, ensure_ascii=False
        )
    if isinstance(concept, str):
        concept = json.loads(concept)

    result: dict[str, object] = {"concept_id": concept_id, "concept": concept}
    if include_parents:
        parents = await snomed_service.get_ancestors(concept_id, min(parent_limit, 20))
        if isinstance(parents, str):
            parents = json.loads(parents)
        result["ancestor_count"] = len(parents)
        result["ancestors"] = parents
    if include_children:
        children = await snomed_service.get_children(concept_id, min(child_limit, 200))
        if isinstance(children, str):
            children = json.loads(children)
        result["children_count"] = len(children)
        result["children"] = children
    return json.dumps(result, ensure_ascii=False, indent=2)


@audited("get_snomed_relationships")
async def get_snomed_relationships(
    concept_id: int,
    relationship_type_id: int = None,
) -> str:
    """
    Get the clinical attribute relationships (non-IS-A) for a SNOMED CT concept.

    Returns SNOMED defining attributes — the relationships that encode the clinical
    meaning of a concept, excluding IS-A (parent/child) links. Results are grouped
    by relationship type with a human-readable label and list of target concepts.

    Examples of what this reveals:
    - `22298006` (Myocardial infarction):
      Finding site → `80891009` Heart structure,
      Associated morphology → `55641003` Infarct
    - `387517004` (Paracetamol):
      Has active ingredient → `387517004` Paracetamol substance,
      Has dose form → `385055001` Tablet

    Output shape:
    ```json
    {
      "concept_id": 22298006,
      "relationship_count": 3,
      "relationships": [
        {
          "type_id": 363698007,
          "type_label": "Finding site",
          "targets": [{concept_id, fsn}, ...]
        }
      ]
    }
    ```

    Args:
        concept_id: SNOMED CT concept ID (integer). Must be an active concept.
        relationship_type_id: Optional concept ID to filter to one relationship
                              type. Common type IDs:
                              - `363698007` Finding site
                              - `116676008` Associated morphology
                              - `246075003` Causative agent
                              - `127489000` Has active ingredient
                              - `411116001` Has dose form
                              - `42752001`  Due to
                              - `363704007` Procedure site
                              Omit to return all attribute types.
    """
    if snomed_service is None:
        return _svc_unavailable("SNOMED CT")
    if await _snomed_maintenance_active():
        return _svc_maintenance("SNOMED CT")
    results = await snomed_service.get_relationships(concept_id, relationship_type_id)
    if isinstance(results, str):
        return results  # Already JSON string from cache
    return json.dumps(
        {
            "concept_id": concept_id,
            "relationship_count": sum(len(r["targets"]) for r in results),
            "relationships": results,
        },
        ensure_ascii=False,
        indent=2,
    )


@audited("query_snomed_mapping")
async def query_snomed_mapping(
    mode: Literal["icd", "snomed"] = "icd",
    keyword: str = "",
) -> str:
    """
    Map between ICD-10-CM codes and SNOMED CT concepts (bidirectional).

    Mode reference:
    - `icd` (default): treats `keyword` as an ICD-10-CM code and returns all
      mapped SNOMED concepts. Uses cross-map reference sets loaded from SNOMED CT
      RF2 data. Case-insensitive; `"e11.9"` and `"E11.9"` are equivalent.
      Output: `{"mode": "icd", "keyword": "E11.9", "snomed_concepts": [{
        concept_id, fsn, preferred_term, map_rule, map_priority}, ...]}`

    - `snomed`: maps a SNOMED concept to ICD-10 code(s). Accepts either:
      - **Numeric concept ID** (e.g. `"44054006"`): looked up directly.
      - **Text term** (e.g. `"type 2 diabetes"`): first searches for the best
        matching SNOMED concept (1 result), then maps that concept_id to ICD.
        Returns error if no SNOMED concept matches the text.
      Output: `{"mode": "snomed", "keyword": 44054006, "icd10_mappings": [{
        icd_code, icd_name, map_rule, map_priority}, ...]}`

    Mappings come from SNOMED CT ICD-10 map reference sets. A concept may have
    multiple mapped ICD codes (map_priority orders them).

    Args:
        mode: `"icd"` | `"snomed"`. Default `"icd"`.
        keyword: For `icd` mode — ICD-10-CM code, e.g. `"E11.9"`, `"I10"`,
                 `"N18.3"`.
                 For `snomed` mode — numeric SNOMED concept ID (e.g. `"44054006"`)
                 or English concept name (e.g. `"type 2 diabetes mellitus"`).
    """
    if snomed_service is None:
        return _svc_unavailable("SNOMED CT")
    if await _snomed_maintenance_active():
        return _svc_maintenance("SNOMED CT")
    if mode == "icd":
        if not keyword:
            return _json_error("Provide keyword when mode is icd")
        results = await snomed_service.map_icd_to_snomed(keyword)
        return json.dumps(
            {"mode": "icd", "keyword": keyword.upper(), "snomed_concepts": results},
            ensure_ascii=False,
            indent=2,
        )
    if mode == "snomed":
        if not keyword:
            return _json_error("Provide keyword when mode is snomed")
        try:
            concept_id = int(keyword)
        except ValueError:
            if snomed_service is None:
                return _svc_unavailable("SNOMED CT")
            matches = await snomed_service.search_concepts(keyword, 1)
            if not matches:
                return _json_error(
                    "For mode=snomed, keyword must be a numeric concept_id or match a SNOMED concept"
                )
            concept_id = int(matches[0]["concept_id"])
        results = await snomed_service.map_snomed_to_icd(concept_id)
        return json.dumps(
            {"mode": "snomed", "keyword": concept_id, "icd10_mappings": results},
            ensure_ascii=False,
            indent=2,
        )
    return _json_error("Provide mode as icd or snomed")


# ============================================================
# Service → tool mapping (used by DynamicFastMCP for add/remove)
# health_check is always registered via @mcp.tool() and is excluded here.
# ============================================================

_TOOL_CATEGORY_MAP, _TOOL_EXAMPLES, _TOOL_SELECTOR_EXAMPLES, SERVICE_TOOLS = (
    _build_tool_maps()
)
_STATUS_HTML = _build_status_html()
_STATUS_HTML_BYTES = _STATUS_HTML.encode("utf-8")


# ============================================================
# Entry point
# ============================================================

if __name__ == "__main__":
    if config.transport == "stdio":
        mcp.run(**config.get_run_kwargs())
    else:
        import uvicorn

        uvicorn.run(
            build_http_app(),
            host=config.host,
            port=config.port,
            log_level=config.log_level.lower(),
        )
