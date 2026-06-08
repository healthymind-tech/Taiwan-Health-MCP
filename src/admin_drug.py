"""
Admin-side helpers for drug import pipeline visibility.
"""

from __future__ import annotations

import math
from typing import Any

import asyncpg

from database import PoolLike
from drug_status_utils import display_drug_statuses


async def get_drug_pipeline_status(pool: PoolLike) -> dict[str, Any]:
    """Return a lightweight per-phase completeness snapshot for the drug pipeline.

    Used by:
    • The Drug tab pipeline-status card
    • The auto-chain decision logic (check pending counts before creating next job)
    • The frontend guardrail modal (warn when enrichment is incomplete)
    """
    async with pool.acquire() as conn:
        # ── Phase 1: Index ────────────────────────────────────────────────────
        total_licenses = int(
            await conn.fetchval("SELECT COUNT(*) FROM drug.licenses WHERE is_listed")
            or 0
        )
        last_index_job = await conn.fetchrow("""
            SELECT job_id::text, status, current_step, created_at, updated_at
            FROM admin.import_jobs
            WHERE job_type = 'drug_index_import'
            ORDER BY created_at DESC
            LIMIT 1
            """)

        # ── Phase 2: Enrichment ───────────────────────────────────────────────
        # Only count active licenses — inactive ones are intentionally skipped by the
        # enrichment crawler (_candidate_licenses filters AND l.is_active).
        # Counting inactive as "pending" would permanently block the analysis guardrail.
        eq_rows = await conn.fetch("""
            SELECT eq.status, COUNT(*)::int AS cnt
            FROM drug.enrichment_queue eq
            JOIN drug.licenses l ON l.license_id = eq.license_id
            WHERE l.is_active
            GROUP BY eq.status
            """)
        eq_counts: dict[str, int] = {str(r["status"]): int(r["cnt"]) for r in eq_rows}
        enrichment_pending = eq_counts.get("pending", 0)
        enrichment_done = eq_counts.get("success", 0) + eq_counts.get(
            "partial_success", 0
        )
        enrichment_failed = eq_counts.get("retryable_failed", 0)
        enrichment_total = sum(eq_counts.values())
        # Inactive licenses: listed but is_active=false — shown for visibility, never crawled
        inactive_licenses = int(
            await conn.fetchval(
                "SELECT COUNT(*) FROM drug.licenses WHERE is_listed AND NOT is_active"
            )
            or 0
        )
        # "Enriched" = has data beyond the index row:
        #   'electronic_insert' → complete EI with sections, no PDF available (Situation A)
        #   'pdf_insert'        → OCR+LLM analysis done (Situations B/C after analysis)
        # An empty-sections EI (basic_info only) keeps primary_insert_source='index_only'
        # and is NOT counted as enriched until its PDF is analyzed.
        enriched_counts = await conn.fetchrow("""
            SELECT
                COUNT(*) FILTER (WHERE primary_insert_source = 'electronic_insert')::int AS ei_only,
                COUNT(*) FILTER (WHERE primary_insert_source = 'pdf_insert')::int          AS pdf_analyzed,
                COUNT(*) FILTER (WHERE primary_insert_source != 'index_only')::int         AS total_enriched
            FROM drug.normalized_records
            """)
        enriched_licenses = int(
            (enriched_counts["total_enriched"] if enriched_counts else 0) or 0
        )
        ei_only_licenses = int(
            (enriched_counts["ei_only"] if enriched_counts else 0) or 0
        )
        pdf_analyzed_licenses = int(
            (enriched_counts["pdf_analyzed"] if enriched_counts else 0) or 0
        )

        # Licenses that have a stored PDF but haven't been analyzed yet
        # Only count licenses that actually have PDFs stored in MinIO AND haven't been analyzed.
        # Without the storage_status filter, uncrawled licenses (default ocr_status='pending')
        # would be wrongly included in this count.
        needs_ocr_licenses = int(await conn.fetchval("""
                SELECT COUNT(*) FROM drug.import_license_state
                WHERE ocr_status = 'pending'
                  AND storage_status = 'success'
                """) or 0)
        last_enrichment_job = await conn.fetchrow("""
            SELECT job_id::text, status, current_step, created_at, updated_at
            FROM admin.import_jobs
            WHERE job_type = 'drug_enrichment'
            ORDER BY created_at DESC
            LIMIT 1
            """)

        # ── Phase 3: Analysis ─────────────────────────────────────────────────
        analysis_rows = await conn.fetch("""
            SELECT
                COUNT(*) FILTER (
                    WHERE ocr_status NOT IN ('success') OR analysis_status NOT IN ('success')
                )::int  AS pending,
                COUNT(*) FILTER (
                    WHERE ocr_status = 'success' AND analysis_status = 'success'
                )::int  AS done,
                COUNT(*) FILTER (
                    WHERE ocr_status = 'retryable_failed' OR analysis_status = 'retryable_failed'
                )::int  AS failed,
                COUNT(*)::int AS total
            FROM drug.insert_analysis
            """)
        ar = dict(analysis_rows[0]) if analysis_rows else {}
        analysis_pending = int(ar.get("pending") or 0)
        analysis_done = int(ar.get("done") or 0)
        analysis_failed = int(ar.get("failed") or 0)
        analysis_total = int(ar.get("total") or 0)
        # Count eligible PDF assets that haven't been submitted for analysis yet
        unsubmitted_assets = int(await conn.fetchval("""
                SELECT COUNT(*)
                FROM drug.assets a
                WHERE a.is_latest_for_analysis
                  AND NOT EXISTS (
                      SELECT 1 FROM drug.insert_analysis ia
                      WHERE ia.source_asset_id = a.asset_id
                  )
                """) or 0)
        last_analysis_job = await conn.fetchrow("""
            SELECT job_id::text, status, current_step, created_at, updated_at
            FROM admin.import_jobs
            WHERE job_type = 'drug_analysis'
            ORDER BY created_at DESC
            LIMIT 1
            """)

    def _job_snapshot(row: asyncpg.Record | None) -> dict[str, Any]:
        if row is None:
            return {
                "job_id": None,
                "status": None,
                "current_step": None,
                "created_at": None,
                "updated_at": None,
            }
        return {
            "job_id": row["job_id"],
            "status": row["status"],
            "current_step": row["current_step"],
            "created_at": _iso(row["created_at"]),
            "updated_at": _iso(row["updated_at"]),
        }

    return {
        "index": {
            "total_licenses": total_licenses,
            "last_job": _job_snapshot(last_index_job),
        },
        "enrichment": {
            "queue_total": enrichment_total,
            "queue_pending": enrichment_pending,
            "queue_done": enrichment_done,
            "queue_failed": enrichment_failed,
            "enriched_licenses": enriched_licenses,
            "ei_only_licenses": ei_only_licenses,
            "pdf_analyzed_licenses": pdf_analyzed_licenses,
            "needs_ocr_licenses": needs_ocr_licenses,
            "inactive_licenses": inactive_licenses,
            "is_complete": enrichment_pending == 0,
            "last_job": _job_snapshot(last_enrichment_job),
        },
        "analysis": {
            "total": analysis_total + unsubmitted_assets,
            "pending": analysis_pending + unsubmitted_assets,
            "done": analysis_done,
            "failed": analysis_failed,
            "is_complete": (analysis_pending + unsubmitted_assets) == 0,
            "last_job": _job_snapshot(last_analysis_job),
        },
    }


def _iso(value: Any) -> str:
    if value is None:
        return ""
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


async def get_drug_license_events(
    pool: PoolLike,
    license_id: str,
    *,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Return stage events for a single license, newest first."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT stage, to_status, error_message, created_at
            FROM drug.import_stage_events
            WHERE license_id = $1
            ORDER BY created_at DESC, event_id DESC
            LIMIT $2
            """,
            license_id,
            max(1, min(limit, 200)),
        )
    return [
        {
            "stage": row["stage"] or "",
            "status": row["to_status"] or "",
            "error_message": row["error_message"] or "",
            "created_at": _iso(row["created_at"]),
        }
        for row in rows
    ]


async def get_drug_admin_status(
    pool: PoolLike,
    *,
    page: int = 1,
    per_page: int = 50,
    q: str = "",
    active_only: bool = True,
    failed_only: bool = False,
) -> dict[str, Any]:
    page = max(1, page)
    per_page = max(1, min(per_page, 200))
    offset = (page - 1) * per_page

    async with pool.acquire() as conn:
        total_licenses = int(
            await conn.fetchval("SELECT COUNT(*) FROM drug.licenses WHERE is_listed")
            or 0
        )
        active_licenses = int(
            await conn.fetchval(
                "SELECT COUNT(*) FROM drug.licenses WHERE is_listed AND is_active"
            )
            or 0
        )
        queue_rows = await conn.fetch("""
            SELECT eq.status, COUNT(*)::int AS count
            FROM drug.enrichment_queue eq
            JOIN drug.licenses l ON l.license_id = eq.license_id
            WHERE l.is_active
            GROUP BY eq.status
            """)
        queue_counts = {str(row["status"]): int(row["count"]) for row in queue_rows}

        state_count_sql = """
            SELECT
                COUNT(*) FILTER (WHERE s.electronic_insert_status = 'retryable_failed')::int AS electronic_failed,
                COUNT(*) FILTER (WHERE s.insert_pdf_status = 'retryable_failed')::int AS insert_failed,
                COUNT(*) FILTER (WHERE s.label_pdf_status = 'retryable_failed')::int AS label_failed,
                COUNT(*) FILTER (WHERE s.shape_status = 'retryable_failed')::int AS shape_failed,
                COUNT(*) FILTER (WHERE s.storage_status = 'retryable_failed')::int AS storage_failed,
                COUNT(*) FILTER (WHERE s.ocr_status = 'retryable_failed')::int AS ocr_failed,
                COUNT(*) FILTER (WHERE s.analysis_status = 'retryable_failed')::int AS analysis_failed,
                COUNT(*) FILTER (WHERE s.normalize_status = 'retryable_failed')::int AS normalize_failed,
                COUNT(*) FILTER (WHERE s.electronic_insert_status = 'pending')::int AS electronic_pending,
                COUNT(*) FILTER (WHERE s.ocr_status = 'pending')::int AS ocr_pending,
                COUNT(*) FILTER (WHERE s.analysis_status = 'pending')::int AS analysis_pending
            FROM drug.import_license_state s
            JOIN drug.licenses l ON l.license_id = s.license_id
            WHERE l.is_active
        """
        state_counts_row = await conn.fetchrow(state_count_sql)
        state_counts = dict(state_counts_row) if state_counts_row is not None else {}

        # Build parameterized WHERE clause for license query
        params: list[Any] = []
        where_parts = ["l.is_listed"]

        if active_only:
            where_parts.append("l.is_active")

        if q:
            params.append(f"%{q}%")
            p = len(params)
            where_parts.append(
                f"(l.license_id ILIKE ${p} OR l.chinese_name ILIKE ${p} OR l.english_name ILIKE ${p})"
            )

        failed_where = """(
            s.electronic_insert_status = 'retryable_failed'
            OR s.insert_pdf_status = 'retryable_failed'
            OR s.label_pdf_status = 'retryable_failed'
            OR s.shape_status = 'retryable_failed'
            OR s.storage_status = 'retryable_failed'
            OR s.ocr_status = 'retryable_failed'
            OR s.analysis_status = 'retryable_failed'
            OR s.normalize_status = 'retryable_failed'
            OR q.status = 'retryable_failed'
        )"""
        if failed_only:
            where_parts.append(failed_where)

        where_sql = " AND ".join(where_parts)

        count_sql = f"""
            SELECT COUNT(*)
            FROM drug.import_license_state s
            JOIN drug.licenses l ON l.license_id = s.license_id
            LEFT JOIN drug.enrichment_queue q ON q.license_id = s.license_id
            WHERE {where_sql}
        """
        total_count = int(await conn.fetchval(count_sql, *params) or 0)

        # Append LIMIT and OFFSET parameters
        params.append(per_page)
        limit_param = len(params)
        params.append(offset)
        offset_param = len(params)

        data_sql = f"""
            SELECT
                l.license_id,
                l.chinese_name,
                l.english_name,
                l.is_active,
                s.index_status,
                s.electronic_insert_status,
                s.insert_pdf_status,
                s.label_pdf_status,
                s.shape_status,
                s.storage_status,
                s.ocr_status,
                s.analysis_status,
                s.normalize_status,
                s.last_error_code,
                s.last_error_message,
                s.updated_at,
                q.status AS queue_status,
                q.reason AS queue_reason,
                q.attempt_count,
                e.stage AS last_event_stage,
                e.to_status AS last_event_status,
                e.error_message AS last_event_error_message,
                e.created_at AS last_event_at,
                (SELECT COUNT(*) FROM drug.assets a WHERE a.license_id = l.license_id)::int AS asset_count
            FROM drug.import_license_state s
            JOIN drug.licenses l ON l.license_id = s.license_id
            LEFT JOIN drug.enrichment_queue q ON q.license_id = s.license_id
            LEFT JOIN LATERAL (
                SELECT stage, to_status, error_message, created_at
                FROM drug.import_stage_events ev
                WHERE ev.license_id = s.license_id
                ORDER BY ev.created_at DESC, ev.event_id DESC
                LIMIT 1
            ) e ON TRUE
            WHERE {where_sql}
            ORDER BY
                l.is_active DESC,
                CASE
                    WHEN s.analysis_status = 'retryable_failed' THEN 0
                    WHEN s.ocr_status = 'retryable_failed' THEN 1
                    WHEN s.storage_status = 'retryable_failed' THEN 2
                    WHEN s.electronic_insert_status = 'retryable_failed' THEN 3
                    WHEN q.status = 'pending' THEN 4
                    ELSE 5
                END,
                s.updated_at DESC NULLS LAST,
                l.license_id
            LIMIT ${limit_param} OFFSET ${offset_param}
        """
        license_rows = await conn.fetch(data_sql, *params)

        licenses = [
            {
                "license_id": row["license_id"],
                "name_zh": row["chinese_name"] or "",
                "name_en": row["english_name"] or "",
                "is_active": bool(row["is_active"]),
                "queue_status": row["queue_status"] or "",
                "queue_reason": row["queue_reason"] or "",
                "attempt_count": int(row["attempt_count"] or 0),
                "asset_count": int(row["asset_count"] or 0),
                "statuses": display_drug_statuses(
                    row,
                    is_active=bool(row["is_active"]),
                    has_normalized_record=(row["normalize_status"] == "success"),
                ),
                "last_error_code": row["last_error_code"] or "",
                "last_error_message": row["last_error_message"] or "",
                "updated_at": _iso(row["updated_at"]),
                "last_event": {
                    "stage": row["last_event_stage"] or "",
                    "status": row["last_event_status"] or "",
                    "error_message": row["last_event_error_message"] or "",
                    "created_at": _iso(row["last_event_at"]),
                },
            }
            for row in license_rows
        ]

        event_rows = await conn.fetch("""
            SELECT
                e.license_id,
                e.stage,
                e.to_status,
                e.error_message,
                e.created_at,
                l.chinese_name
            FROM drug.import_stage_events e
            LEFT JOIN drug.licenses l ON l.license_id = e.license_id
            ORDER BY e.created_at DESC, e.event_id DESC
            LIMIT 100
            """)
        recent_events = [
            {
                "license_id": row["license_id"] or "",
                "name_zh": row["chinese_name"] or "",
                "stage": row["stage"] or "",
                "status": row["to_status"] or "",
                "error_message": row["error_message"] or "",
                "created_at": _iso(row["created_at"]),
            }
            for row in event_rows
        ]

    return {
        "summary": {
            "total_licenses": total_licenses,
            "active_licenses": active_licenses,
            "queue_counts": {
                "pending": queue_counts.get("pending", 0),
                "success": queue_counts.get("success", 0),
                "partial_success": queue_counts.get("partial_success", 0),
                "retryable_failed": queue_counts.get("retryable_failed", 0),
            },
            "state_counts": {
                "electronic_failed": int(state_counts.get("electronic_failed", 0) or 0),
                "insert_failed": int(state_counts.get("insert_failed", 0) or 0),
                "label_failed": int(state_counts.get("label_failed", 0) or 0),
                "shape_failed": int(state_counts.get("shape_failed", 0) or 0),
                "storage_failed": int(state_counts.get("storage_failed", 0) or 0),
                "ocr_failed": int(state_counts.get("ocr_failed", 0) or 0),
                "analysis_failed": int(state_counts.get("analysis_failed", 0) or 0),
                "normalize_failed": int(state_counts.get("normalize_failed", 0) or 0),
                "electronic_pending": int(
                    state_counts.get("electronic_pending", 0) or 0
                ),
                "ocr_pending": int(state_counts.get("ocr_pending", 0) or 0),
                "analysis_pending": int(state_counts.get("analysis_pending", 0) or 0),
            },
        },
        "licenses": licenses,
        "recent_events": recent_events,
        "pagination": {
            "total": total_count,
            "page": page,
            "per_page": per_page,
            "total_pages": max(1, math.ceil(total_count / per_page)),
        },
    }
