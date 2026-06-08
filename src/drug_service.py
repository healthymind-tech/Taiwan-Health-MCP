"""
Drug Service — Phase 2 Taiwan FDA medication search and detail access.
"""

from __future__ import annotations

import json
import re
from typing import Any

import asyncpg

from cache import cached
from database import PoolLike
from drug_record_builder import normalize_license_token
from drug_status_utils import display_drug_statuses
from minio_service import MinioService
from utils import log_info


def _guess_mime_from_name(filename: str) -> str:
    """Best-effort MIME guess from a filename extension for inline preview."""
    lower = (filename or "").lower()
    if lower.endswith(".pdf"):
        return "application/pdf"
    if lower.endswith(".json"):
        return "application/json"
    if lower.endswith((".md", ".markdown")):
        return "text/markdown"
    if lower.endswith((".txt", ".log")):
        return "text/plain"
    if lower.endswith((".html", ".htm")):
        return "text/html"
    if lower.endswith(".png"):
        return "image/png"
    if lower.endswith((".jpg", ".jpeg")):
        return "image/jpeg"
    if lower.endswith(".gif"):
        return "image/gif"
    if lower.endswith(".webp"):
        return "image/webp"
    if lower.endswith(".bmp"):
        return "image/bmp"
    if lower.endswith(".svg"):
        return "image/svg+xml"
    return "application/octet-stream"


_PILL_FEATURE_SYNONYMS: dict[str, list[str]] = {
    "white": ["白", "白色"],
    "yellow": ["黃", "黃色"],
    "orange": ["橘", "橘色", "橙", "橙色"],
    "pink": ["粉紅", "粉紅色"],
    "red": ["紅", "紅色"],
    "blue": ["藍", "藍色"],
    "green": ["綠", "綠色"],
    "brown": ["棕", "棕色", "褐", "褐色"],
    "black": ["黑", "黑色"],
    "round": ["圓", "圓形"],
    "oval": ["橢圓", "橢圓形"],
    "oblong": ["長橢圓", "長橢圓形"],
    "capsule": ["膠囊", "膠囊形"],
    "triangle": ["三角", "三角形"],
    "square": ["方形", "正方形"],
    "diamond": ["菱形"],
}

_BASE_SELECT = """
    l.license_id,
    l.chinese_name,
    l.english_name,
    l.indications_text,
    l.dosage_form,
    l.package,
    l.drug_category,
    l.applicant_name,
    l.manufacturer_name,
    l.is_active,
    l.cancellation_status,
    l.valid_until,
    n.primary_insert_source,
    n.quality_confidence,
    n.missing_fields,
    n.source_errors,
    s.index_status,
    s.electronic_insert_status,
    s.ocr_status,
    s.analysis_status,
    COALESCE(docs.insert_pdf_count, 0) AS insert_pdf_count,
    COALESCE(docs.label_pdf_count, 0) AS label_pdf_count,
    COALESCE(docs.has_analysis, FALSE) AS has_analysis,
    COALESCE(ei.has_electronic_insert, FALSE) AS has_electronic_insert
"""

_BASE_JOINS = """
    LEFT JOIN drug.normalized_records n ON n.license_id = l.license_id
    LEFT JOIN drug.import_license_state s ON s.license_id = l.license_id
    LEFT JOIN LATERAL (
        SELECT
            COUNT(*) FILTER (WHERE asset_type = 'insert_pdf') AS insert_pdf_count,
            COUNT(*) FILTER (WHERE asset_type = 'label_pdf') AS label_pdf_count,
            BOOL_OR(asset_type = 'analysis_json') AS has_analysis
        FROM drug.assets a
        WHERE a.license_id = l.license_id
          AND a.storage_status IN ('success', 'partial_success')
    ) docs ON TRUE
    LEFT JOIN LATERAL (
        SELECT TRUE AS has_electronic_insert
        FROM drug.electronic_inserts e
        WHERE e.license_id = l.license_id
        LIMIT 1
    ) ei ON TRUE
"""


class DrugService:
    def __init__(self, pool: PoolLike, minio_service: MinioService | None = None):
        self.pool = pool
        self._minio_service = minio_service

    async def initialize(self) -> None:
        count = await self.pool.fetchval("SELECT COUNT(*) FROM drug.licenses")
        if count == 0:
            log_info("Drug DB empty — run data-loader --drug-index to load data")
        else:
            log_info("Drug Service ready", licenses=count)

    async def shutdown(self) -> None:
        pass

    @staticmethod
    def to_json_string(payload: dict | list, indent: int = 2) -> str:
        return json.dumps(payload, ensure_ascii=False, indent=indent)

    def _base_filters(self, include_cancelled: bool) -> str:
        if include_cancelled:
            return "l.is_listed"
        return "l.is_listed AND l.is_active"

    @staticmethod
    def _normalize_limit(limit: int, max_limit: int = 10) -> int:
        return min(max(1, limit), max_limit)

    @staticmethod
    def _maybe_json(value: Any, fallback: Any) -> Any:
        if value in (None, ""):
            return fallback
        if isinstance(value, (dict, list)):
            return value
        if isinstance(value, str):
            try:
                return json.loads(value)
            except json.JSONDecodeError:
                return fallback
        return fallback

    def _row_to_result(self, row: asyncpg.Record) -> dict[str, object]:
        data = dict(row)
        return {
            "license_id": data["license_id"],
            "name_zh": data["chinese_name"],
            "name_en": data["english_name"],
            "indication": data["indications_text"],
            "dosage_form": data["dosage_form"],
            "package": data["package"],
            "drug_category": data["drug_category"],
            "applicant_name": data["applicant_name"],
            "manufacturer_name": data["manufacturer_name"],
            "is_active": data["is_active"],
            "cancellation_status": data["cancellation_status"] or "",
            "valid_until": (
                data["valid_until"].isoformat()
                if data["valid_until"] is not None
                else ""
            ),
            "documents_summary": {
                "insert_pdf_count": data.get("insert_pdf_count", 0) or 0,
                "label_pdf_count": data.get("label_pdf_count", 0) or 0,
                "has_electronic_insert": bool(data.get("has_electronic_insert")),
                "has_analysis": bool(data.get("has_analysis")),
            },
            "availability": {
                "index_status": data.get("index_status") or "pending",
                "enrichment_status": data.get("electronic_insert_status") or "pending",
                "ocr_status": data.get("ocr_status") or "pending",
                "analysis_status": data.get("analysis_status") or "pending",
            },
            "quality": {
                "confidence": data.get("quality_confidence") or "low",
                "missing_fields": self._maybe_json(data.get("missing_fields"), []),
                "errors": self._maybe_json(data.get("source_errors"), []),
            },
            "primary_insert_source": data.get("primary_insert_source") or "index_only",
        }

    async def _search(self, sql: str, *params: Any) -> str:
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(sql, *params)
        return json.dumps(
            {"results": [self._row_to_result(row) for row in rows]}, ensure_ascii=False
        )

    @cached(ttl=3600, prefix="drug.search.name.v2")
    async def search_by_name(
        self, keyword: str, limit: int = 3, include_cancelled: bool = False
    ) -> str:
        limit = self._normalize_limit(limit)
        like = f"%{keyword}%"
        filters = self._base_filters(include_cancelled)
        sql = f"""
            WITH ranked AS (
                SELECT
                    l.license_id,
                    CASE
                        WHEN COALESCE(l.chinese_name, '') = $1 OR COALESCE(l.english_name, '') = $1 THEN 0
                        WHEN COALESCE(l.chinese_name, '') ILIKE $2 OR COALESCE(l.english_name, '') ILIKE $2 THEN 1
                        WHEN COALESCE(l.indications_text, '') ILIKE $2 THEN 2
                        ELSE 3
                    END AS match_rank
                FROM drug.licenses l
                WHERE {filters}
                  AND (
                    COALESCE(l.chinese_name, '') ILIKE $2
                    OR COALESCE(l.english_name, '') ILIKE $2
                    OR COALESCE(l.indications_text, '') ILIKE $2
                    OR to_tsvector(
                        'simple',
                        COALESCE(l.chinese_name, '') || ' ' ||
                        COALESCE(l.english_name, '') || ' ' ||
                        COALESCE(l.indications_text, '')
                    ) @@ websearch_to_tsquery('simple', $1)
                  )
            )
            SELECT {_BASE_SELECT}, ranked.match_rank
            FROM ranked
            JOIN drug.licenses l ON l.license_id = ranked.license_id
            {_BASE_JOINS}
            ORDER BY ranked.match_rank, l.is_active DESC, l.license_id
            LIMIT $3
        """
        return await self._search(sql, keyword, like, limit)

    @cached(ttl=3600, prefix="drug.search.ingredient.v2")
    async def search_by_ingredient(
        self, keyword: str, limit: int = 3, include_cancelled: bool = False
    ) -> str:
        limit = self._normalize_limit(limit)
        like = f"%{keyword}%"
        filters = self._base_filters(include_cancelled)
        sql = f"""
            WITH ranked AS (
                SELECT
                    l.license_id,
                    MIN(
                        CASE
                            WHEN COALESCE(i.name, '') = $1 THEN 0
                            WHEN COALESCE(i.name, '') ILIKE $2 THEN 1
                            WHEN COALESCE(i.raw_text, '') ILIKE $2 THEN 2
                            ELSE 3
                        END
                    ) AS match_rank
                FROM drug.ingredients i
                JOIN drug.licenses l ON l.license_id = i.license_id
                WHERE {filters}
                  AND (
                    COALESCE(i.name, '') ILIKE $2
                    OR COALESCE(i.raw_text, '') ILIKE $2
                    OR to_tsvector(
                        'simple',
                        COALESCE(i.name, '') || ' ' || COALESCE(i.raw_text, '')
                    ) @@ websearch_to_tsquery('simple', $1)
                  )
                GROUP BY l.license_id
            )
            SELECT {_BASE_SELECT}, ranked.match_rank
            FROM ranked
            JOIN drug.licenses l ON l.license_id = ranked.license_id
            {_BASE_JOINS}
            ORDER BY ranked.match_rank, l.is_active DESC, l.license_id
            LIMIT $3
        """
        return await self._search(sql, keyword, like, limit)

    @cached(ttl=3600, prefix="drug.search.license.v2")
    async def search_by_license_id(
        self, keyword: str, limit: int = 3, include_cancelled: bool = False
    ) -> str:
        limit = self._normalize_limit(limit)
        like = f"%{keyword}%"
        token = normalize_license_token(keyword)
        filters = self._base_filters(include_cancelled)
        sql = f"""
            SELECT {_BASE_SELECT}
            FROM drug.licenses l
            {_BASE_JOINS}
            WHERE {filters}
              AND (
                l.license_id = $1
                OR l.license_token = $2
                OR l.license_id ILIKE $3
              )
            ORDER BY
                CASE
                    WHEN l.license_id = $1 THEN 0
                    WHEN l.license_token = $2 THEN 1
                    ELSE 2
                END,
                l.is_active DESC,
                l.license_id
            LIMIT $4
        """
        return await self._search(sql, keyword, token, like, limit)

    @cached(ttl=3600, prefix="drug.search.atc.v2")
    async def search_by_atc_code(
        self, keyword: str, limit: int = 3, include_cancelled: bool = False
    ) -> str:
        limit = self._normalize_limit(limit)
        like = f"%{keyword}%"
        filters = self._base_filters(include_cancelled)
        sql = f"""
            WITH ranked AS (
                SELECT
                    l.license_id,
                    MIN(
                        CASE
                            WHEN COALESCE(a.code, '') = $1 THEN 0
                            WHEN COALESCE(a.code, '') ILIKE $2 THEN 1
                            WHEN COALESCE(a.name, '') ILIKE $2 THEN 2
                            ELSE 3
                        END
                    ) AS match_rank
                FROM drug.atc a
                JOIN drug.licenses l ON l.license_id = a.license_id
                WHERE {filters}
                  AND (
                    COALESCE(a.code, '') ILIKE $2
                    OR COALESCE(a.name, '') ILIKE $2
                  )
                GROUP BY l.license_id
            )
            SELECT {_BASE_SELECT}, ranked.match_rank
            FROM ranked
            JOIN drug.licenses l ON l.license_id = ranked.license_id
            {_BASE_JOINS}
            ORDER BY ranked.match_rank, l.is_active DESC, l.license_id
            LIMIT $3
        """
        return await self._search(sql, keyword, like, limit)

    @cached(ttl=3600, prefix="drug.details.v2")
    async def get_drug_details(
        self, license_id: str, include_cancelled: bool = False
    ) -> str:
        filters = self._base_filters(include_cancelled)
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                f"""
                SELECT
                    l.is_active,
                    n.normalized_json,
                    s.index_status,
                    s.electronic_insert_status,
                    s.insert_pdf_status,
                    s.label_pdf_status,
                    s.shape_status,
                    s.storage_status,
                    s.ocr_status,
                    s.analysis_status,
                    s.normalize_status,
                    COALESCE(docs.insert_pdf_count, 0) AS insert_pdf_count,
                    COALESCE(docs.label_pdf_count, 0) AS label_pdf_count
                FROM drug.licenses l
                LEFT JOIN drug.normalized_records n ON n.license_id = l.license_id
                LEFT JOIN drug.import_license_state s ON s.license_id = l.license_id
                LEFT JOIN LATERAL (
                    SELECT
                        COUNT(*) FILTER (WHERE asset_type = 'insert_pdf') AS insert_pdf_count,
                        COUNT(*) FILTER (WHERE asset_type = 'label_pdf') AS label_pdf_count
                    FROM drug.assets a
                    WHERE a.license_id = l.license_id
                ) docs ON TRUE
                WHERE {filters} AND l.license_id = $1
                """,
                license_id,
            )
        if row is None or row["normalized_json"] is None:
            return json.dumps(
                {"error": f"Drug {license_id} not found", "license_id": license_id},
                ensure_ascii=False,
            )
        return json.dumps(
            {
                "license_id": license_id,
                "record": self._maybe_json(row["normalized_json"], {}),
                "availability": display_drug_statuses(
                    row,
                    is_active=bool(row["is_active"]),
                    has_normalized_record=row["normalized_json"] is not None,
                ),
                "documents_summary": {
                    "insert_pdf_count": row["insert_pdf_count"] or 0,
                    "label_pdf_count": row["label_pdf_count"] or 0,
                },
            },
            ensure_ascii=False,
        )

    @cached(ttl=900, prefix="drug.assets.v1")
    async def get_drug_asset_links(
        self,
        *,
        license_id: str | None = None,
        asset_id: str | None = None,
        asset_group: str | None = None,
        latest_insert_only: bool = False,
    ) -> str:
        if not license_id and not asset_id:
            return json.dumps(
                {"error": "Provide either license_id or asset_id"},
                ensure_ascii=False,
            )

        params: list[Any] = []
        where = []
        if asset_id:
            params.append(asset_id)
            where.append(f"a.asset_id::text = ${len(params)}")
        if license_id:
            params.append(license_id)
            where.append(f"a.license_id = ${len(params)}")
        if asset_group:
            params.append(asset_group)
            where.append(f"a.asset_group = ${len(params)}")
        if latest_insert_only:
            where.append("a.is_latest_for_analysis")

        sql = f"""
            SELECT
                a.asset_id::text AS asset_id,
                a.license_id,
                a.asset_type,
                a.asset_group,
                a.source_page,
                a.source_url,
                a.source_filename,
                a.normalized_filename,
                a.upload_date,
                a.mime_type,
                a.size_bytes,
                a.bucket,
                a.object_key,
                a.minio_uri,
                a.storage_status,
                a.download_status
            FROM drug.assets a
            WHERE {' AND '.join(where)}
            ORDER BY a.asset_group, a.upload_date DESC NULLS LAST, a.normalized_filename
        """
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(sql, *params)

        assets = []
        for row in rows:
            object_key = row["object_key"] or ""
            presigned_url = None
            if self._minio_service is not None and object_key:
                presigned_url = await self._minio_service.presign_get(object_key)
            assets.append(
                {
                    "asset_id": row["asset_id"],
                    "license_id": row["license_id"],
                    "asset_type": row["asset_type"],
                    "asset_group": row["asset_group"],
                    "source_page": row["source_page"],
                    "source_url": row["source_url"],
                    "source_filename": row["source_filename"],
                    "normalized_filename": row["normalized_filename"],
                    "upload_date": (
                        row["upload_date"].isoformat()
                        if row["upload_date"] is not None
                        else ""
                    ),
                    "mime_type": row["mime_type"],
                    "size_bytes": row["size_bytes"],
                    "storage_status": row["storage_status"],
                    "download_status": row["download_status"],
                    "minio": {
                        "bucket": row["bucket"] or "",
                        "object_key": object_key,
                        "uri": row["minio_uri"] or "",
                        "presigned_url": presigned_url,
                    },
                }
            )
        return json.dumps(
            {
                "license_id": license_id,
                "asset_id": asset_id,
                "asset_group": asset_group,
                "latest_insert_only": latest_insert_only,
                "assets": assets,
            },
            ensure_ascii=False,
        )

    async def get_drug_asset_content(
        self, asset_id: str
    ) -> tuple[bytes, str, str] | None:
        """Download a single asset's raw bytes from MinIO for inline preview.

        Returns ``(data, mime_type, filename)`` or ``None`` when the asset is
        unknown or has no stored object. Served through a same-origin admin
        proxy so the browser never has to reach MinIO directly (avoids CORS
        and internal-hostname reachability problems with presigned URLs).
        """
        if self._minio_service is None:
            return None
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT object_key, mime_type, source_filename, normalized_filename
                FROM drug.assets
                WHERE asset_id::text = $1
                """,
                asset_id,
            )
        if row is None:
            return None
        object_key = row["object_key"] or ""
        if not object_key:
            return None
        data = await self._minio_service.download_bytes(object_key)
        filename = row["source_filename"] or row["normalized_filename"] or "document"
        mime_type = row["mime_type"] or _guess_mime_from_name(filename)
        return data, mime_type, filename

    @cached(ttl=3600, prefix="drug.pill.v1")
    async def identify_unknown_pill(self, features: str, limit: int = 5) -> str:
        limit = self._normalize_limit(limit, max_limit=5)
        tokens = [token for token in re.split(r"\s+", features.strip()) if token]
        if not tokens:
            return json.dumps(
                {"error": "features is required", "results": []}, ensure_ascii=False
            )

        conditions = []
        params: list[Any] = []
        for token in tokens:
            variants = {token}
            variants.update(_PILL_FEATURE_SYNONYMS.get(token.lower(), []))
            per_token = []
            for variant in variants:
                params.append(f"%{variant}%")
                placeholder = f"${len(params)}"
                per_token.append(f"search_blob ILIKE {placeholder}")
            conditions.append("(" + " OR ".join(per_token) + ")")

        params.append(limit)
        sql = f"""
            WITH appearances AS (
                SELECT
                    ar.appearance_id,
                    ar.license_id,
                    ar.appearance_no,
                    ar.description,
                    ar.color,
                    ar.shape,
                    ar.scoring,
                    ar.symbol,
                    ar.size,
                    ar.imprint,
                    l.chinese_name,
                    l.english_name,
                    (
                        COALESCE(ar.description, '') || ' ' ||
                        COALESCE(ar.color, '') || ' ' ||
                        COALESCE(ar.shape, '') || ' ' ||
                        COALESCE(ar.scoring, '') || ' ' ||
                        COALESCE(ar.symbol, '') || ' ' ||
                        COALESCE(ar.size, '') || ' ' ||
                        COALESCE(ar.imprint, '')
                    ) AS search_blob
                FROM drug.appearance_records ar
                JOIN drug.licenses l ON l.license_id = ar.license_id
                WHERE l.is_listed AND l.is_active
            )
            SELECT
                appearance_id::text,
                license_id,
                appearance_no,
                description,
                color,
                shape,
                scoring,
                symbol,
                size,
                imprint,
                chinese_name,
                english_name
            FROM appearances
            WHERE {" AND ".join(conditions)}
            ORDER BY license_id, appearance_no
            LIMIT ${len(params)}
        """
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(sql, *params)
        return json.dumps(
            {
                "results": [
                    {
                        "appearance_id": row["appearance_id"],
                        "license_id": row["license_id"],
                        "name_zh": row["chinese_name"],
                        "name_en": row["english_name"],
                        "appearance_no": row["appearance_no"],
                        "description": row["description"],
                        "color": row["color"],
                        "shape": row["shape"],
                        "scoring": row["scoring"],
                        "symbol": row["symbol"],
                        "size": row["size"],
                        "imprint": row["imprint"],
                    }
                    for row in rows
                ]
            },
            ensure_ascii=False,
        )

    async def health_status(self):
        from service_health import ServiceHealth

        async with self.pool.acquire() as conn:
            license_count = int(
                await conn.fetchval(
                    "SELECT COUNT(*) FROM drug.licenses WHERE is_listed"
                )
                or 0
            )
            if license_count < 1:
                return ServiceHealth(
                    status="unavailable",
                    reason="Drug index not loaded",
                    search_mode="n/a",
                )
            analyzed_count = int(
                await conn.fetchval(
                    "SELECT COUNT(*) FROM drug.normalized_records "
                    "WHERE primary_insert_source = 'pdf_insert'"
                )
                or 0
            )
            enriched_count = int(
                await conn.fetchval(
                    "SELECT COUNT(*) FROM drug.normalized_records "
                    "WHERE primary_insert_source != 'index_only'"
                )
                or 0
            )
        if analyzed_count > 0:
            return ServiceHealth(status="ok", reason="", search_mode="n/a")
        if enriched_count > 0:
            return ServiceHealth(
                status="degraded",
                reason=f"Enriched but OCR/LLM analysis incomplete ({enriched_count} enriched, {analyzed_count} analyzed)",
                search_mode="n/a",
            )
        return ServiceHealth(
            status="degraded",
            reason="Drug index loaded but enrichment not run — search results are index-only quality",
            search_mode="n/a",
        )
