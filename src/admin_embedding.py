"""
Admin-side helpers for embedding status visibility.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

from database import PoolLike

_OLLAMA_BASE_URL: str = os.getenv("OLLAMA_BASE_URL", "").rstrip("/")
_OLLAMA_MODEL: str = os.getenv("OLLAMA_EMBED_MODEL", "qwen3-embedding:0.6b")
_OLLAMA_DIMENSIONS: int = int(os.getenv("OLLAMA_EMBED_DIMENSIONS", "1024"))


async def _ping_ollama(base_url: str | None = None) -> bool:
    """Check Ollama is reachable AND has at least one embedding model loaded.

    Returns True only if /api/version responds 200 and /api/tags returns ≥1
    model. ``base_url`` comes from DB settings; falls back to env.
    """
    url = (base_url if base_url is not None else _OLLAMA_BASE_URL).rstrip("/")
    if not url:
        return False
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            version_resp = await client.get(f"{url}/api/version")
            if version_resp.status_code != 200:
                return False
            tags_resp = await client.get(f"{url}/api/tags")
            if tags_resp.status_code != 200:
                return False
            models = tags_resp.json().get("models", [])
            return bool(models)
    except Exception:
        return False


def _iso(value: Any) -> str:
    if value is None:
        return ""
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _later(a: Any, b: Any) -> Any:
    """Return the later of two nullable datetimes."""
    if a is None:
        return b
    if b is None:
        return a
    return a if a >= b else b


async def get_embedding_status(pool: PoolLike) -> dict[str, Any]:
    """Return per-module embedding completeness and Ollama config."""
    import admin_settings as _admin_settings

    _emb = await _admin_settings.get_group(pool, "embedding")
    provider = str(_emb.get("provider", "ollama") or "ollama").lower()
    ollama_base_url = str(_emb.get("base_url", "") or "").rstrip("/")
    ollama_model = str(_emb.get("model", "") or "")
    ollama_dimensions = int(_emb.get("dimensions", 1024) or 1024)
    if provider == "ollama":
        configured = bool(ollama_base_url)
        ollama_ok = await _ping_ollama(ollama_base_url)
    else:
        configured = bool(ollama_model and _emb.get("api_key"))
        # For OpenAI/Google, "reachable" = we can list the provider's models.
        ollama_ok = configured and bool(
            (await _admin_settings.list_models("embedding", _emb)).get("ok")
        )

    async with pool.acquire() as conn:
        # ── ICD ───────────────────────────────────────────────────────────────
        icd_total = int(await conn.fetchval("SELECT COUNT(*) FROM icd.diagnoses") or 0)
        icd_embedded = int(
            await conn.fetchval("SELECT COUNT(*) FROM icd.diagnosis_embeddings") or 0
        )
        icd_last = await conn.fetchval(
            "SELECT MAX(embedded_at) FROM icd.diagnosis_embeddings"
        )

        # ── LOINC ─────────────────────────────────────────────────────────────
        loinc_total = int(
            await conn.fetchval("SELECT COUNT(*) FROM loinc.concepts") or 0
        )
        loinc_embedded = int(
            await conn.fetchval("SELECT COUNT(*) FROM loinc.concept_embeddings") or 0
        )
        loinc_last = await conn.fetchval(
            "SELECT MAX(embedded_at) FROM loinc.concept_embeddings"
        )

        # ── Health Supplements ───────────────────────────────────────────────────────
        hf_total = int(
            await conn.fetchval("SELECT COUNT(*) FROM health_supplements.items") or 0
        )
        hf_embedded = int(
            await conn.fetchval(
                "SELECT COUNT(*) FROM health_supplements.item_embeddings"
            )
            or 0
        )
        hf_last = await conn.fetchval(
            "SELECT MAX(embedded_at) FROM health_supplements.item_embeddings"
        )

        # ── Food Nutrition (foods + ingredients) ──────────────────────────────
        fn_foods_total = int(
            await conn.fetchval(
                "SELECT COUNT(DISTINCT sample_name) FROM food_nutrition.measurements"
            )
            or 0
        )
        fn_foods_embedded = int(
            await conn.fetchval("SELECT COUNT(*) FROM food_nutrition.food_embeddings")
            or 0
        )
        fn_ings_total = int(
            await conn.fetchval("SELECT COUNT(*) FROM food_nutrition.ingredients") or 0
        )
        fn_ings_embedded = int(
            await conn.fetchval(
                "SELECT COUNT(*) FROM food_nutrition.ingredient_embeddings"
            )
            or 0
        )
        fn_food_last = await conn.fetchval(
            "SELECT MAX(embedded_at) FROM food_nutrition.food_embeddings"
        )
        fn_ing_last = await conn.fetchval(
            "SELECT MAX(embedded_at) FROM food_nutrition.ingredient_embeddings"
        )

        # ── Clinical Guidelines ───────────────────────────────────────────────
        gl_total = int(
            await conn.fetchval("SELECT COUNT(*) FROM guideline.disease_guidelines")
            or 0
        )
        gl_embedded = int(
            await conn.fetchval("SELECT COUNT(*) FROM guideline.guideline_embeddings")
            or 0
        )
        gl_last = await conn.fetchval(
            "SELECT MAX(embedded_at) FROM guideline.guideline_embeddings"
        )

        # ── SNOMED CT ─────────────────────────────────────────────────────────
        sn_total = int(await conn.fetchval("""SELECT COUNT(DISTINCT concept_id)
                   FROM snomed.descriptions
                   WHERE active = TRUE AND type_id = 900000000000003001""") or 0)
        sn_embedded = int(
            await conn.fetchval("SELECT COUNT(*) FROM snomed.concept_embeddings") or 0
        )
        sn_last = await conn.fetchval(
            "SELECT MAX(embedded_at) FROM snomed.concept_embeddings"
        )

    async with pool.acquire() as conn:
        # last_source_updated_at comes from admin.module_load_log for every module
        # (static loaders and the FDA syncs both stamp it now).
        load_log_rows = await conn.fetch(
            "SELECT module_key, last_loaded_at FROM admin.module_load_log"
        )
        load_log = {r["module_key"]: r["last_loaded_at"] for r in load_log_rows}

        # last_embedded_at = the per-module embed-run marker (set on every run,
        # even a zero-change one) so incremental embedding never shows false stale.
        # Falls back to MAX(embedded_at) for DBs embedded before this feature.
        embed_log_rows = await conn.fetch(
            "SELECT module_key, last_run_at, changed_last_run FROM admin.module_embed_log"
        )
        embed_run = {r["module_key"]: r["last_run_at"] for r in embed_log_rows}
        embed_changed = {r["module_key"]: r["changed_last_run"] for r in embed_log_rows}

        icd_loaded = load_log.get("icd")
        loinc_loaded = load_log.get("loinc")
        gl_loaded = load_log.get("guideline")
        sn_loaded = load_log.get("snomed")
        hf_src_updated = load_log.get("health_supplements")
        fn_src_updated = load_log.get("food_nutrition")

    return {
        "ollama": {
            "provider": provider,
            "base_url": ollama_base_url,
            "model": ollama_model,
            "dimensions": ollama_dimensions,
            "configured": configured,
            "reachable": ollama_ok,
        },
        "modules": [
            {
                "key": "icd",
                "label": "ICD-10-CM",
                "job_type": "icd_embed",
                "total": icd_total,
                "embedded": icd_embedded,
                "last_embedded_at": _iso(embed_run.get("icd") or icd_last),
                "last_source_updated_at": _iso(icd_loaded),
                "changed_last_run": embed_changed.get("icd"),
            },
            {
                "key": "loinc",
                "label": "LOINC",
                "job_type": "loinc_embed",
                "total": loinc_total,
                "embedded": loinc_embedded,
                "last_embedded_at": _iso(embed_run.get("loinc") or loinc_last),
                "last_source_updated_at": _iso(loinc_loaded),
                "changed_last_run": embed_changed.get("loinc"),
            },
            {
                "key": "health_supplements",
                "label": "Health Supplements",
                "job_type": "health_supplements_embed",
                "total": hf_total,
                "embedded": hf_embedded,
                "last_embedded_at": _iso(
                    embed_run.get("health_supplements") or hf_last
                ),
                "last_source_updated_at": _iso(hf_src_updated),
                "changed_last_run": embed_changed.get("health_supplements"),
            },
            {
                "key": "food_nutrition",
                "label": "Food Nutrition",
                "job_type": "food_nutrition_embed",
                "total": fn_foods_total + fn_ings_total,
                "embedded": fn_foods_embedded + fn_ings_embedded,
                "last_embedded_at": _iso(
                    embed_run.get("food_nutrition") or _later(fn_food_last, fn_ing_last)
                ),
                "last_source_updated_at": _iso(fn_src_updated),
                "changed_last_run": embed_changed.get("food_nutrition"),
                "detail": {
                    "foods_total": fn_foods_total,
                    "foods_embedded": fn_foods_embedded,
                    "ingredients_total": fn_ings_total,
                    "ingredients_embedded": fn_ings_embedded,
                },
            },
            {
                "key": "guideline",
                "label": "Clinical Guidelines",
                "job_type": "guideline_embed",
                "total": gl_total,
                "embedded": gl_embedded,
                "last_embedded_at": _iso(embed_run.get("guideline") or gl_last),
                "last_source_updated_at": _iso(gl_loaded),
                "changed_last_run": embed_changed.get("guideline"),
            },
            {
                "key": "snomed",
                "label": "SNOMED CT",
                "job_type": "snomed_embed",
                "total": sn_total,
                "embedded": sn_embedded,
                "last_embedded_at": _iso(embed_run.get("snomed") or sn_last),
                "last_source_updated_at": _iso(sn_loaded),
                "changed_last_run": embed_changed.get("snomed"),
                "note": "~360k concepts — embedding takes 1-2+ hours with Ollama",
            },
        ],
    }
