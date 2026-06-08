"""
Service probe helpers for the protected admin console.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from time import perf_counter
from typing import Any, Sequence
from urllib.parse import urlparse

import httpx

import cache as cache_module
from database import PoolLike
from drug_analysis_service import DrugAnalysisConfig, DrugAnalysisService
from minio_service import MinioService

SERVICE_PROBE_ORDER = [
    "database",
    "redis",
    "minio",
    "embedding_model",
    "ocr_server",
    "analysis_server",
    "lm_server",
]

# Service keys that must NOT be in 'error' state for a given job type to run.
# 'degraded' is allowed (OCR server reachable but local lib missing = still usable
# remotely).  Only hard 'error' status blocks the job.
# Jobs not listed here have no service dependencies.
JOB_TYPE_DEPENDENCIES: dict[str, list[str]] = {
    "icd_import": ["minio"],
    "loinc_import": ["minio"],
    "ig_import": ["minio"],
    "snomed_import": ["minio"],
    "rxnorm_import": ["minio"],
    "drug_index_import": ["minio"],
    "drug_enrichment": [],  # only outbound HTTP to TFDA — no local service dep
    "drug_analysis": ["minio", "ocr_server", "analysis_server"],
    "guideline_seed": [],
    "health_supplements_sync": [],
    "food_nutrition_sync": [],
    "noop": [],
}

SERVICE_PROBE_META: dict[str, dict[str, str]] = {
    "database": {
        "label": "PostgreSQL",
        "category": "infrastructure",
        "description": "Primary relational store and admin control plane backend.",
    },
    "redis": {
        "label": "Redis",
        "category": "infrastructure",
        "description": "Cache and coordination client used by the MCP server.",
    },
    "minio": {
        "label": "MinIO",
        "category": "storage",
        "description": "Object storage for uploaded sources and drug assets.",
    },
    "embedding_model": {
        "label": "Embedding Model",
        "category": "ml",
        "description": "Semantic-search embedding endpoint.",
    },
    "ocr_server": {
        "label": "OCR Server",
        "category": "ml",
        "description": "Vision/OCR backend for drug insert PDFs.",
    },
    "analysis_server": {
        "label": "Analyze Server",
        "category": "ml",
        "description": "Structured-analysis runtime and provider configuration.",
    },
    "lm_server": {
        "label": "LM Server",
        "category": "ml",
        "description": "Text-generation endpoint currently backing structured analysis.",
    },
}


def _ensure_json_object(value: Any) -> dict[str, Any]:
    # asyncpg returns JSONB columns as raw JSON strings — parse before type-checking.
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except Exception:
            return {}
    return value if isinstance(value, dict) else {}


def _normalize_timestamp(value: Any) -> str | None:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    text = str(value).strip()
    return text or None


def _normalize_probe_row(row: dict[str, Any]) -> dict[str, Any]:
    service_key = str(row.get("service_key", "") or "")
    meta = SERVICE_PROBE_META.get(service_key, {})
    details = _ensure_json_object(row.get("details_json") or row.get("details"))
    return {
        "service_key": service_key,
        "label": meta.get("label", service_key or "Unknown"),
        "category": meta.get("category", "other"),
        "description": meta.get("description", ""),
        "status": str(row.get("status", "degraded") or "degraded"),
        "endpoint": str(row.get("endpoint", "") or ""),
        "latency_ms": row.get("latency_ms"),
        "message": str(row.get("message", "") or ""),
        "details": details,
        "checked_at": _normalize_timestamp(row.get("checked_at")),
    }


def _placeholder_probe_row(service_key: str) -> dict[str, Any]:
    meta = SERVICE_PROBE_META[service_key]
    return {
        "service_key": service_key,
        "label": meta["label"],
        "category": meta["category"],
        "description": meta["description"],
        "status": "degraded",
        "endpoint": "",
        "latency_ms": None,
        "message": "No cached probe result yet.",
        "details": {"state": "unprobed"},
        "checked_at": None,
    }


def serialize_service_probes(
    current_rows: Sequence[dict[str, Any]],
    history_rows: Sequence[dict[str, Any]],
) -> dict[str, Any]:
    current_by_key = {
        row["service_key"]: _normalize_probe_row(row)
        for row in current_rows
        if str(row.get("service_key", "") or "")
    }
    services = [
        current_by_key.get(service_key, _placeholder_probe_row(service_key))
        for service_key in SERVICE_PROBE_ORDER
    ]
    history = [_normalize_probe_row(row) for row in history_rows]
    ok_count = sum(1 for row in services if row["status"] == "ok")
    degraded_count = sum(1 for row in services if row["status"] == "degraded")
    error_count = sum(1 for row in services if row["status"] == "error")
    last_checked_at = max(
        (row["checked_at"] for row in services if row["checked_at"]),
        default=None,
    )
    return {
        "services": services,
        "history": history,
        "summary": {
            "total": len(services),
            "ok": ok_count,
            "degraded": degraded_count,
            "error": error_count,
            "last_checked_at": last_checked_at,
        },
    }


async def _probe_http_candidates(
    candidates: Sequence[str],
    *,
    timeout: float = 4.0,
    headers: dict[str, str] | None = None,
) -> tuple[bool, str, int | None, str, dict[str, Any]]:
    last_message = "No probe URL candidates configured."
    last_details: dict[str, Any] = {}
    if not candidates:
        return False, "", None, last_message, last_details
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        for candidate in candidates:
            started = perf_counter()
            try:
                response = await client.get(candidate, headers=headers)
                latency_ms = max(int((perf_counter() - started) * 1000), 0)
                details = {
                    "http_status": response.status_code,
                    "reason_phrase": response.reason_phrase,
                }
                if 200 <= response.status_code < 300:
                    return (
                        True,
                        candidate,
                        latency_ms,
                        f"HTTP {response.status_code}",
                        details,
                    )
                last_message = f"HTTP {response.status_code}"
                last_details = details
            except Exception as exc:
                last_message = str(exc)
                last_details = {"error_type": exc.__class__.__name__}
    return False, str(candidates[0]), None, last_message, last_details


def _join_http_path(base_url: str, path: str) -> str:
    base = base_url.rstrip("/")
    return f"{base}{path}"


def _ollama_probe_candidates(base_url: str) -> list[str]:
    parsed = urlparse(base_url)
    path = parsed.path.rstrip("/")
    if path.endswith("/api"):
        return [
            _join_http_path(base_url, "/version"),
            _join_http_path(base_url, "/tags"),
        ]
    if path.endswith("/api/version") or path.endswith("/api/tags"):
        return [base_url]
    return [
        _join_http_path(base_url, "/api/version"),
        _join_http_path(base_url, "/api/tags"),
    ]


def _openai_like_probe_candidates(base_url: str) -> list[str]:
    base = base_url.rstrip("/")
    if base.endswith("/models"):
        return [base]
    if base.endswith("/v1"):
        return [f"{base}/models"]
    return [f"{base}/models", f"{base}/v1/models"]


def _analysis_probe_candidates(config: DrugAnalysisConfig) -> list[str]:
    if config.analysis_provider == "ollama":
        return _ollama_probe_candidates(config.analysis_base_url)
    return _openai_like_probe_candidates(config.analysis_base_url)


async def _probe_database(pool) -> dict[str, Any]:
    started = perf_counter()
    async with pool.acquire() as conn:
        await conn.fetchval("SELECT 1")
    latency_ms = max(int((perf_counter() - started) * 1000), 0)
    return {
        "service_key": "database",
        "status": "ok",
        "endpoint": "postgresql://database",
        "latency_ms": latency_ms,
        "message": "SELECT 1 succeeded.",
        "details": {"query": "SELECT 1"},
    }


async def _probe_redis() -> dict[str, Any]:
    started = perf_counter()
    client = cache_module.get_client()
    await client.ping()
    latency_ms = max(int((perf_counter() - started) * 1000), 0)
    return {
        "service_key": "redis",
        "status": "ok",
        "endpoint": "redis://cache",
        "latency_ms": latency_ms,
        "message": "Redis PING succeeded.",
        "details": {"command": "PING"},
    }


async def _probe_minio(minio_service: MinioService | None) -> dict[str, Any]:
    if minio_service is None:
        return {
            "service_key": "minio",
            "status": "error",
            "endpoint": "",
            "latency_ms": None,
            "message": "MinIO service has not been initialized.",
            "details": {"state": "missing"},
        }
    result = await minio_service.probe_readiness()
    return {"service_key": "minio", **result}


async def _probe_embedding_model(
    base_url: str | None = None, model_name: str | None = None
) -> dict[str, Any]:
    base_url = (
        (base_url if base_url is not None else os.getenv("OLLAMA_BASE_URL", ""))
        .strip()
        .rstrip("/")
    )
    model_name = (
        model_name
        if model_name is not None
        else os.getenv("OLLAMA_EMBED_MODEL", "qwen3-embedding:0.6b")
    ).strip()
    if not base_url:
        return {
            "service_key": "embedding_model",
            "status": "degraded",
            "endpoint": "",
            "latency_ms": None,
            "message": "Embedding is disabled because OLLAMA_BASE_URL is not set.",
            "details": {"model": model_name, "state": "disabled"},
        }
    ok, endpoint, latency_ms, message, details = await _probe_http_candidates(
        _ollama_probe_candidates(base_url)
    )
    return {
        "service_key": "embedding_model",
        "status": "ok" if ok else "error",
        "endpoint": endpoint,
        "latency_ms": latency_ms,
        "message": (
            f"Embedding endpoint reachable for model {model_name}."
            if ok
            else f"Embedding endpoint probe failed: {message}"
        ),
        "details": {"model": model_name, "base_url": base_url, **details},
    }


async def _probe_ocr_server(analysis_service: DrugAnalysisService) -> dict[str, Any]:
    ready, reason = analysis_service.ocr_readiness()
    endpoint = (
        f"http://{analysis_service.config.ocr_vllm_server_ip}:"
        f"{analysis_service.config.ocr_vllm_port}"
    )
    local_runtime_missing = (not ready) and ("not installed" in reason.lower())
    hard_config_failure = (not ready) and not local_runtime_missing
    if hard_config_failure:
        return {
            "service_key": "ocr_server",
            "status": "error",
            "endpoint": endpoint,
            "latency_ms": None,
            "message": reason,
            "details": {
                "provider": analysis_service.config.ocr_provider,
                "model": analysis_service.config.ocr_model_name,
                "prompt_path": str(analysis_service.config.ocr_prompt_path),
            },
        }
    ok, resolved_endpoint, latency_ms, message, details = await _probe_http_candidates(
        [
            f"{endpoint}/health",
            f"{endpoint}/v1/models",
        ]
    )
    if local_runtime_missing and ok:
        status = "degraded"
        probe_message = (
            "OCR server reachable, but dots_ocr is not installed in the app image."
        )
    else:
        status = "ok" if ok else "error"
        probe_message = (
            f"OCR server reachable for model {analysis_service.config.ocr_model_name}."
            if ok
            else f"OCR server probe failed: {message}"
        )
    return {
        "service_key": "ocr_server",
        "status": status,
        "endpoint": resolved_endpoint,
        "latency_ms": latency_ms,
        "message": probe_message,
        "details": {
            "provider": analysis_service.config.ocr_provider,
            "model": analysis_service.config.ocr_model_name,
            "prompt_path": str(analysis_service.config.ocr_prompt_path),
            "local_runtime_missing": local_runtime_missing,
            **details,
        },
    }


async def _probe_analysis_endpoint(
    config: DrugAnalysisConfig,
) -> tuple[bool, str, int | None, str, dict[str, Any]]:
    headers: dict[str, str] | None = None
    if config.analysis_provider in {"openai", "vllm"} and config.analysis_api_key:
        headers = {"Authorization": f"Bearer {config.analysis_api_key}"}
    return await _probe_http_candidates(
        _analysis_probe_candidates(config),
        headers=headers,
    )


async def _probe_analysis_services(
    analysis_service: DrugAnalysisService,
) -> tuple[dict[str, Any], dict[str, Any]]:
    ready, reason = analysis_service.analysis_readiness()
    config = analysis_service.config
    details = {
        "provider": config.analysis_provider,
        "model": config.analysis_model_name,
        "prompt_path": str(config.analysis_prompt_path),
    }
    if not ready:
        failure = {
            "status": "error",
            "endpoint": config.analysis_base_url,
            "latency_ms": None,
            "message": reason,
            "details": details,
        }
        return (
            {"service_key": "analysis_server", **failure},
            {"service_key": "lm_server", **failure},
        )

    ok, endpoint, latency_ms, message, probe_details = await _probe_analysis_endpoint(
        config
    )
    merged_details = {**details, "base_url": config.analysis_base_url, **probe_details}
    analysis_row = {
        "service_key": "analysis_server",
        "status": "ok" if ok else "error",
        "endpoint": endpoint,
        "latency_ms": latency_ms,
        "message": (
            f"Analysis runtime ready for provider {config.analysis_provider}."
            if ok
            else f"Analysis server probe failed: {message}"
        ),
        "details": merged_details,
    }
    lm_row = {
        "service_key": "lm_server",
        "status": "ok" if ok else "error",
        "endpoint": endpoint,
        "latency_ms": latency_ms,
        "message": (
            f"LM endpoint reachable for model {config.analysis_model_name}."
            if ok
            else f"LM endpoint probe failed: {message}"
        ),
        "details": merged_details,
    }
    return analysis_row, lm_row


async def _run_single_probe(
    service_key: str,
    *,
    pool,
    minio_service: MinioService | None,
    analysis_service: DrugAnalysisService,
    analysis_pair: tuple[dict[str, Any], dict[str, Any]] | None,
) -> dict[str, Any]:
    if service_key == "database":
        return await _probe_database(pool)
    if service_key == "redis":
        return await _probe_redis()
    if service_key == "minio":
        return await _probe_minio(minio_service)
    if service_key == "embedding_model":
        import admin_settings as _admin_settings

        _emb = await _admin_settings.get_group(pool, "embedding")
        return await _probe_embedding_model(
            base_url=str(_emb.get("base_url", "") or ""),
            model_name=str(_emb.get("model", "") or ""),
        )
    if service_key == "ocr_server":
        return await _probe_ocr_server(analysis_service)
    if service_key in {"analysis_server", "lm_server"}:
        if analysis_pair is None:
            analysis_pair = await _probe_analysis_services(analysis_service)
        return (
            analysis_pair[0] if service_key == "analysis_server" else analysis_pair[1]
        )
    raise ValueError(f"Unsupported service probe key: {service_key}")


async def list_service_probes(pool, *, history_limit: int = 28) -> dict[str, Any]:
    async with pool.acquire() as conn:
        current_rows = [dict(row) for row in await conn.fetch("""
                SELECT service_key, status, endpoint, latency_ms, message, details_json, checked_at
                FROM admin.service_probes
                ORDER BY service_key
                """)]
        history_rows = [
            dict(row)
            for row in await conn.fetch(
                """
                SELECT service_key, status, endpoint, latency_ms, message, details_json, checked_at
                FROM admin.service_probe_history
                ORDER BY checked_at DESC, service_probe_history_id DESC
                LIMIT $1
                """,
                history_limit,
            )
        ]
    payload = serialize_service_probes(current_rows, history_rows)
    payload["generated_at"] = datetime.now(timezone.utc).isoformat()
    return payload


async def run_service_probes(
    pool,
    *,
    minio_service: MinioService | None,
    service_keys: Sequence[str] | None = None,
) -> dict[str, Any]:
    selected = SERVICE_PROBE_ORDER
    if service_keys:
        requested = {str(key).strip() for key in service_keys if str(key).strip()}
        invalid = sorted(requested - set(SERVICE_PROBE_ORDER))
        if invalid:
            raise ValueError(f"Unsupported service probe keys: {', '.join(invalid)}")
        selected = [key for key in SERVICE_PROBE_ORDER if key in requested]

    # Build the analysis/OCR config from DB settings so the Services-tab health
    # view reflects the live (DB-managed) configuration.
    import admin_settings as _admin_settings

    analysis_service = DrugAnalysisService(
        DrugAnalysisConfig.from_values(
            ocr=await _admin_settings.get_group(pool, "ocr"),
            analysis=await _admin_settings.get_group(pool, "analysis"),
        )
    )
    analysis_pair: tuple[dict[str, Any], dict[str, Any]] | None = None
    checked_at = datetime.now(timezone.utc)
    results: list[dict[str, Any]] = []
    for service_key in selected:
        if service_key in {"analysis_server", "lm_server"} and analysis_pair is None:
            analysis_pair = await _probe_analysis_services(analysis_service)
        try:
            result = await _run_single_probe(
                service_key,
                pool=pool,
                minio_service=minio_service,
                analysis_service=analysis_service,
                analysis_pair=analysis_pair,
            )
        except Exception as exc:
            result = {
                "service_key": service_key,
                "status": "error",
                "endpoint": "",
                "latency_ms": None,
                "message": str(exc),
                "details": {"error_type": exc.__class__.__name__},
            }
        result["checked_at"] = checked_at
        results.append(result)

    async with pool.acquire() as conn:
        async with conn.transaction():
            for result in results:
                await conn.execute(
                    """
                    INSERT INTO admin.service_probes (
                        service_key,
                        status,
                        endpoint,
                        latency_ms,
                        message,
                        details_json,
                        checked_at
                    )
                    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
                    ON CONFLICT (service_key) DO UPDATE
                    SET status = EXCLUDED.status,
                        endpoint = EXCLUDED.endpoint,
                        latency_ms = EXCLUDED.latency_ms,
                        message = EXCLUDED.message,
                        details_json = EXCLUDED.details_json,
                        checked_at = EXCLUDED.checked_at
                    """,
                    result["service_key"],
                    result["status"],
                    result["endpoint"] or None,
                    result["latency_ms"],
                    result["message"] or None,
                    json.dumps(result.get("details") or {}, ensure_ascii=False),
                    checked_at,
                )
                await conn.execute(
                    """
                    INSERT INTO admin.service_probe_history (
                        service_key,
                        status,
                        endpoint,
                        latency_ms,
                        message,
                        details_json,
                        checked_at
                    )
                    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
                    """,
                    result["service_key"],
                    result["status"],
                    result["endpoint"] or None,
                    result["latency_ms"],
                    result["message"] or None,
                    json.dumps(result.get("details") or {}, ensure_ascii=False),
                    checked_at,
                )
    payload = await list_service_probes(pool)
    payload["probed_service_keys"] = selected
    return payload


async def get_unhealthy_dependencies(
    pool: PoolLike,
    job_type: str,
) -> list[str]:
    """Return service keys that are in 'error' state for the given job type.

    Only hard ``status='error'`` blocks the job.  ``degraded`` is allowed
    (e.g. OCR server reachable but local library missing is still usable via
    the remote vLLM endpoint).  If no probe data exists yet for a service we
    give it the benefit of the doubt and do not block.

    Returns an empty list when all dependencies are healthy or the job type
    has no service requirements.
    """
    required = JOB_TYPE_DEPENDENCIES.get(job_type, [])
    if not required:
        return []
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT service_key, status FROM admin.service_probes "
            "WHERE service_key = ANY($1::text[])",
            required,
        )
    by_key = {row["service_key"]: row["status"] for row in rows}
    return [key for key in required if by_key.get(key) == "error"]
