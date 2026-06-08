"""
DB-backed application settings for external/integration systems.

Settings for embedding (Ollama), analysis LM, OCR, MinIO, TFDA crawler and worker
tuning live in ``admin.app_settings`` (one row per group_key/key). They are seeded
once from ``.env`` on first boot (when the table is empty) and managed thereafter
via the admin Settings tab.

This module is the single source of truth: ``SETTINGS_SCHEMA`` defines every
group, its fields, types, defaults, the env var to seed from, secret-ness and UI
metadata. Seeding, type coercion, validation and the UI form all derive from it.

Bootstrap settings (DATABASE_URL, REDIS_URL, MCP_*, ADMIN_* auth, POSTGRES_*,
LOG_LEVEL, METRICS_PORT, DATASETS_CONFIG) stay in ``.env`` — they are needed
before the DB connection / admin login exists, so they cannot live in the DB.
"""

from __future__ import annotations

import os
import time
from typing import Any

from database import PoolLike

# Placeholder shown to the UI in place of a stored secret. A save that sends this
# value back unchanged means "keep the existing secret".
SECRET_MASK = "●●●●●●●●"


def _field(
    key: str,
    type_: str,
    default: Any,
    env: str,
    label: str,
    *,
    secret: bool = False,
    help: str = "",
    options: list[str] | None = None,
    show_if: dict[str, list[str]] | None = None,
    is_model: bool = False,
) -> dict[str, Any]:
    """Build a field descriptor for the registry."""
    return {
        "key": key,
        "type": type_,  # str | int | float | bool | secret
        "default": default,
        "env": env,
        "label": label,
        "secret": secret or type_ == "secret",
        "help": help,
        "options": options,  # for enum/select fields
        "show_if": show_if,  # {other_field_key: [allowed_values]}
        "is_model": is_model,  # field is a model name (gets a "Fetch models" picker)
    }


# ── Registry ────────────────────────────────────────────────────────────────
# Defaults mirror the previous from_env() defaults exactly, so behavior after
# seeding is identical to reading the same .env directly.
SETTINGS_SCHEMA: dict[str, dict[str, Any]] = {
    "embedding": {
        "label": "Embedding Model",
        "description": "Embedding provider used by semantic search and all embed jobs.",
        "provider_field": "provider",
        "test": "embedding",
        "fields": [
            _field(
                "provider",
                "str",
                "ollama",
                "EMBEDDING_PROVIDER",
                "Provider",
                options=["ollama", "openai", "google"],
                help="ollama = local Ollama; openai = OpenAI-compatible /v1; google = Gemini API.",
            ),
            _field(
                "base_url",
                "str",
                "http://host.docker.internal:11434",
                "OLLAMA_BASE_URL",
                "Base URL",
                show_if={"provider": ["ollama", "openai"]},
                help="Ollama host (…:11434) or the OpenAI-compatible /v1 root. (Google uses a fixed endpoint.)",
            ),
            _field(
                "api_key",
                "secret",
                "",
                "EMBEDDING_API_KEY",
                "API Key",
                show_if={"provider": ["openai", "google"]},
            ),
            _field(
                "model",
                "str",
                "qwen3-embedding:0.6b",
                "OLLAMA_EMBED_MODEL",
                "Model",
                is_model=True,
                help="Click 'Fetch models' to load the provider's available embedding models.",
            ),
            _field(
                "dimensions",
                "int",
                1024,
                "OLLAMA_EMBED_DIMENSIONS",
                "Dimensions",
                help="Vector size stored in pgvector; must match the model's output.",
            ),
            _field("timeout", "int", 30, "OLLAMA_EMBED_TIMEOUT", "Timeout (s)"),
            _field("batch_size", "int", 32, "OLLAMA_EMBED_BATCH_SIZE", "Batch size"),
        ],
    },
    "analysis": {
        "label": "Analysis LM",
        "description": "Text-generation endpoint backing structured drug-insert analysis.",
        "provider_field": "provider",
        "test": "analysis",
        "fields": [
            _field(
                "provider",
                "str",
                "openai",
                "DRUG_ANALYSIS_PROVIDER",
                "Provider",
                options=["openai", "ollama"],
                help="openai = OpenAI-compatible (/v1); ollama = Ollama native (/api).",
            ),
            _field(
                "base_url",
                "str",
                "http://127.0.0.1:8001/v1",
                "DRUG_ANALYSIS_BASE_URL",
                "Base URL",
            ),
            _field(
                "api_key",
                "secret",
                "0",
                "DRUG_ANALYSIS_API_KEY",
                "API Key",
                show_if={"provider": ["openai"]},
            ),
            _field(
                "model",
                "str",
                "qwen2.5:7b",
                "DRUG_ANALYSIS_MODEL_NAME",
                "Model",
                is_model=True,
            ),
            _field(
                "temperature", "float", 0.1, "DRUG_ANALYSIS_TEMPERATURE", "Temperature"
            ),
            _field("max_tokens", "int", 4096, "DRUG_ANALYSIS_MAX_TOKENS", "Max tokens"),
            _field("max_retries", "int", 3, "DRUG_ANALYSIS_MAX_RETRIES", "Max retries"),
            _field(
                "prompt_path",
                "str",
                "",
                "DRUG_ANALYSIS_PROMPT_PATH",
                "Prompt path (optional)",
                help="Leave blank to use the bundled default prompt.",
            ),
        ],
    },
    "ocr": {
        "label": "OCR Server",
        "description": "Vision/OCR backend for drug insert PDFs.",
        "provider_field": "provider",
        "test": "ocr",
        "fields": [
            _field(
                "provider",
                "str",
                "dots_ocr",
                "DRUG_OCR_PROVIDER",
                "Provider",
                options=["dots_ocr", "vllm"],
            ),
            _field(
                "server_ip", "str", "127.0.0.1", "DRUG_OCR_VLLM_SERVER_IP", "Server IP"
            ),
            _field("port", "int", 8002, "DRUG_OCR_VLLM_PORT", "Port"),
            _field(
                "model",
                "str",
                "Qwen/Qwen2.5-VL-7B-Instruct",
                "DRUG_OCR_MODEL_NAME",
                "Model",
                is_model=True,
            ),
            _field(
                "prompt_mode",
                "str",
                "prompt_layout_all_en",
                "DRUG_OCR_PROMPT_MODE",
                "Prompt mode",
            ),
            _field(
                "prompt_path",
                "str",
                "",
                "DRUG_OCR_PROMPT_PATH",
                "Prompt path (optional)",
                help="Leave blank to use the bundled default prompt.",
            ),
        ],
    },
    "minio": {
        "label": "MinIO Object Storage",
        "description": "Object storage for uploaded sources and drug assets.",
        "test": "minio",
        "fields": [
            _field(
                "endpoint",
                "str",
                "",
                "MINIO_ENDPOINT",
                "Endpoint",
                help="host:port, e.g. minio:9000",
            ),
            _field("access_key", "str", "", "MINIO_ACCESS_KEY", "Access key"),
            _field("secret_key", "secret", "", "MINIO_SECRET_KEY", "Secret key"),
            _field("bucket", "str", "", "MINIO_BUCKET", "Bucket"),
            _field("secure", "bool", False, "MINIO_SECURE", "Use TLS (secure)"),
            _field(
                "presign_ttl",
                "int",
                3600,
                "MINIO_PRESIGN_TTL_SECONDS",
                "Presign TTL (s)",
            ),
        ],
    },
    "tfda": {
        "label": "TFDA Crawler",
        "description": "Taiwan FDA endpoint used by drug enrichment.",
        "test": "tfda",
        "fields": [
            _field(
                "base_url",
                "str",
                "https://mcp.fda.gov.tw",
                "DRUG_TFDA_BASE_URL",
                "Base URL",
            ),
            _field("http_timeout", "int", 30, "DRUG_HTTP_TIMEOUT", "HTTP timeout (s)"),
            _field(
                "crawler_concurrency",
                "int",
                4,
                "DRUG_CRAWLER_CONCURRENCY",
                "Crawler concurrency",
            ),
        ],
    },
    "registry": {
        "label": "FHIR Package Registry",
        "description": "npm-style FHIR registry used to auto-fetch Implementation Guides and their dependency IGs by packageId@version.",
        "fields": [
            _field(
                "base_url",
                "str",
                "https://packages.fhir.org",
                "FHIR_REGISTRY_BASE_URL",
                "Registry base URL",
                help="Primary FHIR package registry. Default packages.fhir.org. Can point at Simplifier or an internal mirror.",
            ),
            _field(
                "fallback_url",
                "str",
                "https://packages2.fhir.org",
                "FHIR_REGISTRY_FALLBACK_URL",
                "Fallback base URL",
                help="Tried when the primary registry cannot serve a package tarball. Leave blank to disable.",
            ),
        ],
    },
    "worker": {
        "label": "Admin Worker Tuning",
        "description": "Background worker loop cadence. Changes take effect on the next worker restart.",
        "fields": [
            _field("name", "str", "admin-worker", "ADMIN_WORKER_NAME", "Worker name"),
            _field(
                "poll_seconds",
                "float",
                3.0,
                "ADMIN_WORKER_POLL_SECONDS",
                "Poll interval (s)",
            ),
            _field(
                "heartbeat_interval",
                "int",
                15,
                "ADMIN_HEARTBEAT_INTERVAL_SECONDS",
                "Heartbeat interval (s)",
            ),
            _field(
                "stale_after",
                "int",
                45,
                "ADMIN_WORKER_STALE_AFTER_SECONDS",
                "Stale after (s)",
            ),
            _field(
                "reclaim_interval",
                "float",
                60.0,
                "ADMIN_RECLAIM_INTERVAL_SECONDS",
                "Reclaim interval (s)",
            ),
        ],
    },
}


def _field_def(group: str, key: str) -> dict[str, Any] | None:
    for f in SETTINGS_SCHEMA.get(group, {}).get("fields", []):
        if f["key"] == key:
            return f
    return None


def coerce(field: dict[str, Any], raw: Any) -> Any:
    """Coerce a stored string value to the field's Python type."""
    t = field["type"]
    if raw is None:
        return field["default"]
    if t in ("str", "secret"):
        return str(raw)
    if t == "int":
        try:
            return int(str(raw).strip())
        except (ValueError, TypeError):
            return field["default"]
    if t == "float":
        try:
            return float(str(raw).strip())
        except (ValueError, TypeError):
            return field["default"]
    if t == "bool":
        if isinstance(raw, bool):
            return raw
        return str(raw).strip().lower() in ("1", "true", "yes", "on")
    return raw


# ── Cache (short TTL so app & worker pick up changes within seconds) ──────────
_CACHE_TTL_SECONDS = 5.0
_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def bust_cache(group: str | None = None) -> None:
    if group is None:
        _cache.clear()
    else:
        _cache.pop(group, None)


async def seed_if_empty(pool: PoolLike) -> int:
    """Seed every registry key from its env var (or default) if not already
    present. Idempotent: uses ON CONFLICT DO NOTHING, so existing values are
    never overwritten and newly-added keys self-seed on later upgrades.

    Returns the number of rows inserted.
    """
    rows: list[tuple[str, str, str]] = []
    for group, spec in SETTINGS_SCHEMA.items():
        for f in spec["fields"]:
            env_val = os.getenv(f["env"])
            value = env_val if env_val is not None else _default_as_str(f)
            rows.append((group, f["key"], value))
    inserted = 0
    async with pool.acquire() as conn:
        # Idempotent migration for existing deployments (schema.sql only runs on
        # a fresh postgres data dir).
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS admin.app_settings (
                group_key   TEXT NOT NULL,
                key         TEXT NOT NULL,
                value       TEXT,
                updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_by  TEXT,
                PRIMARY KEY (group_key, key)
            )
            """)
        result = await conn.executemany(
            """
            INSERT INTO admin.app_settings (group_key, key, value)
            VALUES ($1, $2, $3)
            ON CONFLICT (group_key, key) DO NOTHING
            """,
            rows,
        )
        # executemany returns None; count via a follow-up isn't worth it — report total keys
        inserted = len(rows)
    bust_cache()
    return inserted


def _default_as_str(field: dict[str, Any]) -> str:
    d = field["default"]
    if isinstance(d, bool):
        return "true" if d else "false"
    return str(d)


async def get_group(
    pool: PoolLike, group: str, *, reveal_secrets: bool = True
) -> dict[str, Any]:
    """Return a typed {key: value} dict for a group, overlaying DB rows on
    registry defaults. Secrets are revealed by default (for internal config
    use); pass reveal_secrets=False to mask them.

    Uses a short-TTL in-process cache so both the app and the worker pick up
    changes within a few seconds without a restart.
    """
    spec = SETTINGS_SCHEMA.get(group)
    if not spec:
        raise ValueError(f"Unknown settings group: {group}")

    now = time.monotonic()
    cached = _cache.get(group)
    if cached and (now - cached[0]) < _CACHE_TTL_SECONDS:
        stored = cached[1]
    else:
        async with pool.acquire() as conn:
            db_rows = await conn.fetch(
                "SELECT key, value FROM admin.app_settings WHERE group_key = $1",
                group,
            )
        stored = {r["key"]: r["value"] for r in db_rows}
        _cache[group] = (now, stored)

    out: dict[str, Any] = {}
    for f in spec["fields"]:
        raw = stored.get(f["key"], None)
        value = coerce(f, raw)
        if f["secret"] and not reveal_secrets:
            value = SECRET_MASK if value else ""
        out[f["key"]] = value
    return out


def group_metadata(group: str, values_masked: dict[str, Any]) -> dict[str, Any]:
    """Build the UI descriptor for a group: field defs + current (masked) values."""
    spec = SETTINGS_SCHEMA[group]
    fields = []
    for f in spec["fields"]:
        fields.append(
            {
                "key": f["key"],
                "type": f["type"],
                "label": f["label"],
                "secret": f["secret"],
                "help": f["help"],
                "options": f["options"],
                "show_if": f["show_if"],
                "is_model": f["is_model"],
                "value": values_masked.get(f["key"]),
            }
        )
    return {
        "group": group,
        "label": spec.get("label", group),
        "description": spec.get("description", ""),
        "provider_field": spec.get("provider_field"),
        "test": spec.get("test"),
        "fields": fields,
    }


async def get_all(pool: PoolLike) -> dict[str, Any]:
    """All groups with field metadata and masked values, for the Settings UI."""
    groups = []
    for group in SETTINGS_SCHEMA:
        masked = await get_group(pool, group, reveal_secrets=False)
        groups.append(group_metadata(group, masked))
    return {"groups": groups}


async def save_group(
    pool: PoolLike,
    group: str,
    values: dict[str, Any],
    *,
    updated_by: str,
) -> dict[str, Any]:
    """Validate and persist changed values for a group. Secret fields whose
    incoming value equals the mask placeholder are left untouched. Returns the
    new masked values for the group. Raises ValueError on unknown group/field.
    """
    spec = SETTINGS_SCHEMA.get(group)
    if not spec:
        raise ValueError(f"Unknown settings group: {group}")

    # Current stored (revealed) values, to preserve unchanged secrets.
    current = await get_group(pool, group, reveal_secrets=True)

    to_write: list[tuple[str, str, str, str]] = []
    for f in spec["fields"]:
        key = f["key"]
        if key not in values:
            continue
        incoming = values[key]
        # Preserve secret if the UI sent back the mask unchanged.
        if f["secret"] and (incoming == SECRET_MASK or incoming == ""):
            if incoming == SECRET_MASK:
                continue  # keep existing
        # Validate enum options.
        if f["options"] is not None and str(incoming) not in f["options"]:
            raise ValueError(
                f"{group}.{key}: '{incoming}' is not one of {f['options']}"
            )
        # Normalize to storage string via coerce (ensures type-validity).
        coerced = coerce(f, incoming)
        stored_str = _value_to_str(f, coerced)
        to_write.append((group, key, stored_str, updated_by))

    if to_write:
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.executemany(
                    """
                    INSERT INTO admin.app_settings (group_key, key, value, updated_by, updated_at)
                    VALUES ($1, $2, $3, $4, NOW())
                    ON CONFLICT (group_key, key)
                    DO UPDATE SET value = EXCLUDED.value,
                                 updated_by = EXCLUDED.updated_by,
                                 updated_at = NOW()
                    """,
                    to_write,
                )
                await conn.execute(
                    """
                    INSERT INTO admin.admin_audit_log
                        (admin_user, action, target_type, target_id, payload_json)
                    VALUES ($1, 'update_settings', 'settings_group', $2, $3::jsonb)
                    """,
                    updated_by,
                    group,
                    _audit_payload(spec, to_write),
                )
    bust_cache(group)
    return await get_group(pool, group, reveal_secrets=False)


def _value_to_str(field: dict[str, Any], value: Any) -> str:
    if field["type"] == "bool":
        return "true" if value else "false"
    return str(value)


def _audit_payload(
    spec: dict[str, Any], to_write: list[tuple[str, str, str, str]]
) -> str:
    import json

    secret_keys = {f["key"] for f in spec["fields"] if f["secret"]}
    changed = {}
    for _g, key, val, _by in to_write:
        changed[key] = "***" if key in secret_keys else val
    return json.dumps(
        {"changed_keys": list(changed.keys()), "values": changed}, ensure_ascii=False
    )


# ── Provider test / model-list helpers (operate on draft, unsaved values) ─────


def _err(exc: Exception) -> str:
    """Human-readable error string that is never empty (httpx timeouts often
    have an empty str()). For HTTP errors, surface the provider's response body
    (e.g. OpenAI's "Unsupported parameter ...") instead of the opaque status."""
    import httpx

    if isinstance(exc, httpx.HTTPStatusError):
        resp = exc.response
        detail = ""
        try:
            j = resp.json()
            err = j.get("error") if isinstance(j, dict) else None
            if isinstance(err, dict):
                detail = err.get("message") or ""
            elif isinstance(err, str):
                detail = err
            if not detail and isinstance(j, dict):
                detail = j.get("message") or ""
        except Exception:
            pass
        if not detail:
            detail = (resp.text or "").strip()[:300]
        return (
            f"HTTP {resp.status_code}: {detail}"
            if detail
            else f"HTTP {resp.status_code}"
        )
    s = str(exc).strip()
    return s if s else exc.__class__.__name__


async def resolve_draft(
    pool: PoolLike, group: str, draft: dict[str, Any]
) -> dict[str, Any]:
    """Fill masked/blank secret fields in a draft from the stored DB values, so
    'test before save' works without forcing the user to retype secrets."""
    stored = await get_group(pool, group, reveal_secrets=True)
    spec = SETTINGS_SCHEMA.get(group, {})
    out = dict(draft)
    for f in spec.get("fields", []):
        if f["secret"]:
            v = out.get(f["key"])
            if v in (None, "", SECRET_MASK):
                out[f["key"]] = stored.get(f["key"], "")
    return out


async def list_models(
    pool: PoolLike, group: str, draft: dict[str, Any]
) -> dict[str, Any]:
    """List models the configured server currently has, for the model picker."""
    import httpx

    spec = SETTINGS_SCHEMA.get(group)
    if not spec:
        raise ValueError(f"Unknown settings group: {group}")

    # The api_key field arrives masked (●●●●) when the admin hasn't retyped it;
    # fill it from the DB so the Bearer header is a real (ASCII) key, not the
    # mask — otherwise httpx fails to encode the header.
    draft = await resolve_draft(pool, group, draft)

    if group == "embedding":
        provider = str(draft.get("provider", "ollama") or "ollama").lower()
        base = str(draft.get("base_url", "") or "").rstrip("/")
        key = str(draft.get("api_key", "") or "")
        if provider == "openai":
            return await _openai_models(base, key)
        if provider == "google":
            return await _google_embedding_models(key)
        return await _ollama_tags(base)
    if group == "analysis":
        provider = str(draft.get("provider", "openai") or "openai").lower()
        base = str(draft.get("base_url", "") or "").rstrip("/")
        if provider == "ollama":
            return await _ollama_tags(base)
        return await _openai_models(base, str(draft.get("api_key", "") or ""))
    if group == "ocr":
        base = f"http://{str(draft.get('server_ip','') or '').strip()}:{int(draft.get('port', 8002) or 8002)}"
        return await _openai_models(base, "")
    return {"ok": False, "models": [], "message": "This service has no model list."}


async def _ollama_tags(base_url: str) -> dict[str, Any]:
    import httpx

    if not base_url:
        return {"ok": False, "models": [], "message": "Base URL is empty."}
    try:
        async with httpx.AsyncClient(timeout=8.0) as c:
            r = await c.get(f"{base_url}/api/tags")
            r.raise_for_status()
            names = [
                m.get("name", "") for m in r.json().get("models", []) if m.get("name")
            ]
            return {
                "ok": True,
                "models": sorted(names),
                "message": (
                    f"{len(names)} model(s) found."
                    if names
                    else "No models loaded on the server."
                ),
            }
    except Exception as exc:
        return {
            "ok": False,
            "models": [],
            "message": f"Failed to list models: {_err(exc)}",
        }


async def _openai_models(base_url: str, api_key: str) -> dict[str, Any]:
    import httpx

    if not base_url:
        return {"ok": False, "models": [], "message": "Base URL is empty."}
    headers = (
        {"Authorization": f"Bearer {api_key}"} if api_key and api_key != "0" else {}
    )
    try:
        async with httpx.AsyncClient(timeout=8.0) as c:
            r = await c.get(f"{base_url.rstrip('/')}/models", headers=headers)
            r.raise_for_status()
            data = r.json().get("data", [])
            names = [m.get("id", "") for m in data if m.get("id")]
            return {
                "ok": True,
                "models": sorted(names),
                "message": (
                    f"{len(names)} model(s) found."
                    if names
                    else "Server returned no models."
                ),
            }
    except Exception as exc:
        return {
            "ok": False,
            "models": [],
            "message": f"Failed to list models: {_err(exc)}",
        }


_GOOGLE_BASE = "https://generativelanguage.googleapis.com"


async def _google_embedding_models(api_key: str) -> dict[str, Any]:
    import httpx

    if not api_key:
        return {"ok": False, "models": [], "message": "API key is required for Google."}
    try:
        async with httpx.AsyncClient(timeout=8.0) as c:
            r = await c.get(
                f"{_GOOGLE_BASE}/v1beta/models", headers={"x-goog-api-key": api_key}
            )
            r.raise_for_status()
            names = []
            for m in r.json().get("models", []):
                methods = m.get("supportedGenerationMethods", [])
                if "embedContent" in methods or "batchEmbedContents" in methods:
                    name = m.get("name", "")
                    names.append(
                        name[len("models/") :] if name.startswith("models/") else name
                    )
            return {
                "ok": True,
                "models": sorted(names),
                "message": (
                    f"{len(names)} embedding model(s) found."
                    if names
                    else "No embedding models found."
                ),
            }
    except Exception as exc:
        return {
            "ok": False,
            "models": [],
            "message": f"Failed to list models: {_err(exc)}",
        }


async def test_group(
    pool: PoolLike, group: str, draft: dict[str, Any]
) -> dict[str, Any]:
    """Run a real test against the draft config. Returns {ok, message, details}."""
    import time as _time

    draft = await resolve_draft(pool, group, draft)
    if group == "embedding":
        return await _test_embedding(draft)
    if group == "analysis":
        return await _test_analysis(draft)
    if group == "ocr":
        return await _test_ocr(draft)
    if group == "minio":
        return await _test_minio(draft)
    if group == "tfda":
        return await _test_tfda(draft)
    return {"ok": False, "message": "This service has no test."}


async def _test_embedding(draft: dict[str, Any]) -> dict[str, Any]:
    import time as _time

    import httpx

    provider = str(draft.get("provider", "ollama") or "ollama").lower()
    base = str(draft.get("base_url", "") or "").rstrip("/")
    model = str(draft.get("model", "") or "")
    key = str(draft.get("api_key", "") or "")
    want_dim = int(draft.get("dimensions", 0) or 0)
    if not model:
        return {"ok": False, "message": "Model is required."}
    if provider in ("openai", "google") and not key:
        return {"ok": False, "message": "API key is required for this provider."}
    if provider in ("ollama", "openai") and not base:
        return {"ok": False, "message": "Base URL is required."}
    # Generous timeout: a cold embedding model can take 10-30s to load on first call.
    timeout = max(float(draft.get("timeout", 30) or 30), 90.0)
    try:
        t0 = _time.perf_counter()
        async with httpx.AsyncClient(timeout=timeout) as c:
            if provider == "openai":
                url = base if base.endswith("/embeddings") else f"{base}/embeddings"
                body = {
                    "model": model,
                    "input": ["health check"],
                    "encoding_format": "float",
                }
                if want_dim and model.startswith("text-embedding-3"):
                    body["dimensions"] = want_dim
                r = await c.post(
                    url,
                    json=body,
                    headers={"Authorization": f"Bearer {key}"} if key else {},
                )
                r.raise_for_status()
                vec = (r.json().get("data") or [{}])[0].get("embedding")
            elif provider == "google":
                mp = model if model.startswith("models/") else f"models/{model}"
                req = {"content": {"parts": [{"text": "health check"}]}}
                if want_dim:
                    req["outputDimensionality"] = want_dim
                r = await c.post(
                    f"{_GOOGLE_BASE}/v1beta/{mp}:embedContent",
                    json=req,
                    headers={"x-goog-api-key": key},
                )
                r.raise_for_status()
                vec = (r.json().get("embedding") or {}).get("values")
            else:
                r = await c.post(
                    f"{base}/api/embed",
                    json={"model": model, "input": ["health check"]},
                )
                r.raise_for_status()
                embs = r.json().get("embeddings", [])
                vec = embs[0] if embs else None
        ms = int((_time.perf_counter() - t0) * 1000)
        if not vec:
            return {"ok": False, "message": "Provider returned no embedding vector."}
        dim = len(vec)
        msg = f"Embedded sample in {ms} ms — vector dim = {dim}."
        if want_dim and dim != want_dim:
            return {
                "ok": False,
                "message": msg
                + f" ⚠ Configured dimensions = {want_dim} does not match!",
                "details": {
                    "returned_dim": dim,
                    "configured_dim": want_dim,
                    "latency_ms": ms,
                },
            }
        return {
            "ok": True,
            "message": msg,
            "details": {"returned_dim": dim, "latency_ms": ms},
        }
    except Exception as exc:
        return {"ok": False, "message": f"Embedding test failed: {_err(exc)}"}


async def _test_analysis(draft: dict[str, Any]) -> dict[str, Any]:
    import time as _time

    import httpx

    provider = str(draft.get("provider", "openai") or "openai").lower()
    base = str(draft.get("base_url", "") or "").rstrip("/")
    model = str(draft.get("model", "") or "")
    api_key = str(draft.get("api_key", "") or "")
    if not base or not model:
        return {"ok": False, "message": "Base URL and model are required."}
    try:
        t0 = _time.perf_counter()
        async with httpx.AsyncClient(timeout=20.0) as c:
            if provider == "ollama":
                r = await c.post(
                    f"{base}/api/chat",
                    json={
                        "model": model,
                        "stream": False,
                        "messages": [
                            {"role": "user", "content": "Reply with the word OK."}
                        ],
                    },
                )
                r.raise_for_status()
                text = (r.json().get("message", {}) or {}).get("content", "")
            else:
                headers = (
                    {"Authorization": f"Bearer {api_key}"}
                    if api_key and api_key != "0"
                    else {}
                )
                body = {
                    "model": model,
                    "max_tokens": 16,
                    "messages": [
                        {"role": "user", "content": "Reply with the word OK."}
                    ],
                }
                r = await c.post(f"{base}/chat/completions", headers=headers, json=body)
                # Newer OpenAI models reject `max_tokens` (400) and require
                # `max_completion_tokens`. Retry once with the new parameter.
                if r.status_code == 400 and "max_completion_tokens" in r.text:
                    body.pop("max_tokens", None)
                    # Reasoning models spend the budget on hidden reasoning first,
                    # so give enough room to still emit a visible reply.
                    body["max_completion_tokens"] = 256
                    r = await c.post(
                        f"{base}/chat/completions", headers=headers, json=body
                    )
                r.raise_for_status()
                text = r.json()["choices"][0]["message"]["content"]
        ms = int((_time.perf_counter() - t0) * 1000)
        return {
            "ok": True,
            "message": f"Completion in {ms} ms.",
            "details": {"sample": (text or "").strip()[:200], "latency_ms": ms},
        }
    except Exception as exc:
        return {"ok": False, "message": f"Analysis test failed: {_err(exc)}"}


async def _test_ocr(draft: dict[str, Any]) -> dict[str, Any]:
    import httpx

    base = f"http://{str(draft.get('server_ip','') or '').strip()}:{int(draft.get('port', 8002) or 8002)}"
    model = str(draft.get("model", "") or "")
    try:
        async with httpx.AsyncClient(timeout=8.0) as c:
            r = await c.get(f"{base}/v1/models")
            r.raise_for_status()
            names = [m.get("id", "") for m in r.json().get("data", [])]
        present = (model in names) if model else True
        if not names:
            return {
                "ok": False,
                "message": f"OCR server at {base} reachable but reports no models.",
            }
        if model and not present:
            return {
                "ok": False,
                "message": f"OCR server reachable, but model '{model}' is not loaded.",
                "details": {"available": names},
            }
        return {
            "ok": True,
            "message": f"OCR server reachable at {base}; model present.",
            "details": {"available": names},
        }
    except Exception as exc:
        return {"ok": False, "message": f"OCR test failed: {_err(exc)}"}


async def _test_minio(draft: dict[str, Any]) -> dict[str, Any]:
    try:
        from minio_service import MinioConfig, MinioService

        svc = MinioService(MinioConfig.from_values(draft))
        await svc.initialize()
        if not svc.enabled:
            return {
                "ok": False,
                "message": svc.init_error or "MinIO not reachable / bucket missing.",
            }
        return {
            "ok": True,
            "message": f"Connected; bucket '{svc.config.bucket}' available.",
        }
    except Exception as exc:
        return {"ok": False, "message": f"MinIO test failed: {_err(exc)}"}


async def _test_tfda(draft: dict[str, Any]) -> dict[str, Any]:
    import time as _time

    import httpx

    base = str(draft.get("base_url", "") or "").rstrip("/")
    if not base:
        return {"ok": False, "message": "Base URL is required."}
    try:
        t0 = _time.perf_counter()
        async with httpx.AsyncClient(
            timeout=float(draft.get("http_timeout", 10) or 10), follow_redirects=True
        ) as c:
            r = await c.get(base)
        ms = int((_time.perf_counter() - t0) * 1000)
        return {
            "ok": r.status_code < 500,
            "message": f"GET {base} → HTTP {r.status_code} in {ms} ms.",
            "details": {"status_code": r.status_code, "latency_ms": ms},
        }
    except Exception as exc:
        return {"ok": False, "message": f"TFDA test failed: {_err(exc)}"}
