"""
Phase 3 loader for OCR, structured analysis, and normalized-record refresh.
"""

from __future__ import annotations

import hashlib
import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
import uuid

import asyncpg

from drug_analysis_service import DrugAnalysisService
from drug_record_builder import build_drug_record
from minio_service import MinioService

ANALYSIS_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "taiwan-health-mcp/drug-insert-analysis")
ANALYSIS_ASSET_NAMESPACE = uuid.uuid5(
    uuid.NAMESPACE_URL, "taiwan-health-mcp/drug-analysis-assets"
)


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def _date_text(value: Any) -> str:
    if value is None:
        return ""
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _parse_date(value: Any) -> date | None:
    """Convert string 'YYYY-MM-DD' or datetime.date to datetime.date for asyncpg DATE columns."""
    if value is None or value == "":
        return None
    if isinstance(value, date):
        return value
    if isinstance(value, datetime):
        return value.date()
    try:
        return date.fromisoformat(str(value)[:10])
    except (ValueError, TypeError):
        return None


def _analysis_id(source_asset_id: str) -> uuid.UUID:
    return uuid.uuid5(ANALYSIS_NAMESPACE, source_asset_id)


def _analysis_asset_id(source_asset_id: str, kind: str) -> uuid.UUID:
    return uuid.uuid5(ANALYSIS_ASSET_NAMESPACE, f"{source_asset_id}|{kind}")


def _analysis_object_key(license_id: str, source_asset_id: str, filename: str) -> str:
    return f"drug/{license_id}/analysis/{source_asset_id}/{filename}"


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


async def _load_index_row(conn: asyncpg.Connection, license_id: str) -> dict[str, Any] | None:
    row = await conn.fetchrow(
        "SELECT raw_index_json FROM drug.licenses WHERE license_id = $1",
        license_id,
    )
    if row is None or row["raw_index_json"] is None:
        return None
    raw = row["raw_index_json"]
    # asyncpg returns JSONB columns as raw JSON strings — parse explicitly.
    parsed = json.loads(raw) if isinstance(raw, str) else raw
    return parsed if isinstance(parsed, dict) else None


def _parse_jsonb(value: Any, default: Any = None) -> Any:
    """asyncpg returns JSONB columns as raw JSON strings — parse explicitly."""
    if value is None:
        return default
    if isinstance(value, str):
        try:
            return json.loads(value)
        except Exception:
            return default
    return value


async def _load_existing_source_errors(conn: asyncpg.Connection, license_id: str) -> list[str]:
    row = await conn.fetchrow(
        "SELECT source_errors FROM drug.normalized_records WHERE license_id = $1",
        license_id,
    )
    if row is None:
        return []
    parsed = _parse_jsonb(row["source_errors"], default=[])
    if isinstance(parsed, list):
        return [str(item) for item in parsed]
    return []


async def _load_electronic_insert(
    conn: asyncpg.Connection, license_id: str
) -> dict[str, Any] | None:
    row = await conn.fetchrow(
        """
        SELECT
            source_url,
            basic_info_json,
            manufacturers_json,
            sections_json,
            ingredients_json,
            atc_codes_json,
            label_pdfs_json,
            history_pdfs_json,
            public_pdfs_json,
            paper_pdfs_json,
            authorizations_json
        FROM drug.electronic_inserts
        WHERE license_id = $1
        """,
        license_id,
    )
    if row is None:
        return None
    return {
        "source_url": row["source_url"] or "",
        "basic_info": _parse_jsonb(row["basic_info_json"], {}),
        "manufacturers": _parse_jsonb(row["manufacturers_json"], []),
        "sections": _parse_jsonb(row["sections_json"], {}),
        "ingredients": _parse_jsonb(row["ingredients_json"], {}),
        "atc_codes": _parse_jsonb(row["atc_codes_json"], []),
        "label_pdfs": _parse_jsonb(row["label_pdfs_json"], []),
        "history_pdfs": _parse_jsonb(row["history_pdfs_json"], []),
        "public_pdfs": _parse_jsonb(row["public_pdfs_json"], []),
        "paper_pdfs": _parse_jsonb(row["paper_pdfs_json"], []),
        "authorizations": _parse_jsonb(row["authorizations_json"], []),
    }


async def _load_asset_rows(
    conn: asyncpg.Connection,
    license_id: str,
    *,
    asset_group: str,
) -> list[dict[str, Any]]:
    rows = await conn.fetch(
        """
        SELECT
            asset_id::text AS asset_id,
            appearance_id::text AS appearance_id,
            asset_type,
            asset_group,
            source_page,
            source_url,
            source_filename,
            normalized_filename,
            upload_date,
            mime_type,
            size_bytes,
            sha256,
            bucket,
            object_key,
            minio_uri,
            etag,
            version_id,
            download_status,
            storage_status,
            is_latest_for_analysis,
            retry_count,
            last_error_code,
            last_error_message,
            last_attempt_at,
            downloaded_at,
            stored_at
        FROM drug.assets
        WHERE license_id = $1
          AND asset_group = $2
        ORDER BY upload_date DESC NULLS LAST, normalized_filename
        """,
        license_id,
        asset_group,
    )
    items: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        item["upload_date"] = _date_text(item.get("upload_date"))
        items.append(item)
    return items


async def _load_appearance_records(
    conn: asyncpg.Connection, license_id: str
) -> list[dict[str, Any]]:
    appearance_rows = await conn.fetch(
        """
        SELECT
            appearance_id::text AS appearance_id,
            shape_id,
            appearance_no,
            detail_url,
            description,
            color,
            shape,
            scoring,
            symbol,
            size,
            imprint,
            raw_json
        FROM drug.appearance_records
        WHERE license_id = $1
        ORDER BY appearance_no, shape_id
        """,
        license_id,
    )
    shape_assets = await conn.fetch(
        """
        SELECT
            asset_id::text AS asset_id,
            appearance_id::text AS appearance_id,
            source_filename,
            normalized_filename,
            source_url,
            upload_date,
            bucket,
            object_key,
            minio_uri
        FROM drug.assets
        WHERE license_id = $1
          AND asset_group = 'shape'
        ORDER BY normalized_filename
        """,
        license_id,
    )
    images_by_appearance: dict[str, list[dict[str, Any]]] = {}
    for row in shape_assets:
        appearance_id = row["appearance_id"] or ""
        images_by_appearance.setdefault(appearance_id, []).append(
            {
                "asset_id": row["asset_id"],
                "source_filename": row["source_filename"] or "",
                "normalized_filename": row["normalized_filename"] or "",
                "source_url": row["source_url"] or "",
                "upload_date": _date_text(row["upload_date"]),
                "bucket": row["bucket"] or "",
                "object_key": row["object_key"] or "",
                "minio_uri": row["minio_uri"] or "",
            }
        )
    records: list[dict[str, Any]] = []
    for row in appearance_rows:
        item = dict(row)
        item["images"] = images_by_appearance.get(item["appearance_id"], [])
        # raw_json is a JSONB column — asyncpg returns it as a raw string; parse it.
        item["raw_json"] = _parse_jsonb(item.get("raw_json"), {})
        records.append(item)
    return records


async def _load_analysis_payload(
    conn: asyncpg.Connection, source_asset_id: str
) -> dict[str, Any] | None:
    row = await conn.fetchrow(
        """
        SELECT normalized_json
        FROM drug.insert_analysis
        WHERE source_asset_id::text = $1
          AND analysis_status = 'success'
        """,
        source_asset_id,
    )
    if row is None or row["normalized_json"] in (None, ""):
        return None
    if isinstance(row["normalized_json"], dict):
        return row["normalized_json"]
    return None


async def _load_existing_ocr_markdown(
    conn: asyncpg.Connection,
    minio: MinioService,
    source_asset_id: str,
) -> str | None:
    row = await conn.fetchrow(
        """
        SELECT a.object_key
        FROM drug.insert_analysis ia
        JOIN drug.assets a ON a.asset_id = ia.ocr_asset_id
        WHERE ia.source_asset_id::text = $1
          AND ia.ocr_status = 'success'
          AND a.storage_status = 'success'
        """,
        source_asset_id,
    )
    if row is None or not row["object_key"]:
        return None
    try:
        return (await minio.download_bytes(row["object_key"])).decode("utf-8")
    except Exception:
        return None


async def _refresh_normalized_record(
    conn: asyncpg.Connection,
    *,
    license_id: str,
    source_asset_id: str,
    analysis_json: dict[str, Any] | None,
    normalized_at: datetime,
) -> dict[str, Any]:
    index_row = await _load_index_row(conn, license_id)
    if index_row is None:
        raise RuntimeError(f"Index row not found for {license_id}")
    electronic_insert = await _load_electronic_insert(conn, license_id)
    insert_assets = await _load_asset_rows(conn, license_id, asset_group="insert")
    label_assets = await _load_asset_rows(conn, license_id, asset_group="label")
    appearance_records = await _load_appearance_records(conn, license_id)
    source_errors = await _load_existing_source_errors(conn, license_id)
    if analysis_json is None:
        analysis_json = await _load_analysis_payload(conn, source_asset_id)
    return build_drug_record(
        index_row,
        electronic_insert=electronic_insert,
        analysis=analysis_json,
        insert_assets=insert_assets,
        label_assets=label_assets,
        appearance_records=appearance_records,
        source_errors=source_errors,
        normalized_at=normalized_at,
    )


def _analysis_asset_row(
    *,
    asset_id: uuid.UUID,
    license_id: str,
    source_asset_id: str,
    asset_type: str,
    filename: str,
    mime_type: str,
    data: bytes,
    locator: dict[str, Any],
    storage_status: str,
    source_upload_date: str,
    now: datetime,
    last_error_message: str = "",
) -> dict[str, Any]:
    return {
        "asset_id": asset_id,
        "license_id": license_id,
        "appearance_id": None,
        "asset_type": asset_type,
        "asset_group": "analysis",
        "source_page": "analysis",
        "source_url": "",
        "source_filename": filename,
        "normalized_filename": filename,
        "upload_date": source_upload_date or None,
        "mime_type": mime_type,
        "size_bytes": len(data),
        "sha256": _sha256_bytes(data),
        "bucket": locator.get("bucket", ""),
        "object_key": locator.get("object_key", ""),
        "minio_uri": locator.get("minio_uri", ""),
        "etag": locator.get("etag", ""),
        "version_id": locator.get("version_id", ""),
        "download_status": "success",
        "storage_status": storage_status,
        "is_latest_for_analysis": False,
        "retry_count": 0,
        "last_error_code": "" if not last_error_message else "analysis_asset_failed",
        "last_error_message": last_error_message,
        "last_attempt_at": now,
        "downloaded_at": now,
        "stored_at": now if storage_status == "success" else None,
    }


async def _upsert_asset_row(conn: asyncpg.Connection, row: dict[str, Any]) -> None:
    await conn.execute(
        """
        INSERT INTO drug.assets (
            asset_id, license_id, appearance_id, asset_type, asset_group,
            source_page, source_url, source_filename, normalized_filename,
            upload_date, mime_type, size_bytes, sha256, bucket, object_key,
            minio_uri, etag, version_id, download_status, storage_status,
            is_latest_for_analysis, retry_count, last_error_code,
            last_error_message, last_attempt_at, downloaded_at, stored_at
        )
        VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9,
            $10, $11, $12, $13, $14, $15,
            $16, $17, $18, $19, $20,
            $21, $22, $23,
            $24, $25, $26, $27
        )
        ON CONFLICT (asset_id) DO UPDATE SET
            license_id = EXCLUDED.license_id,
            appearance_id = EXCLUDED.appearance_id,
            asset_type = EXCLUDED.asset_type,
            asset_group = EXCLUDED.asset_group,
            source_page = EXCLUDED.source_page,
            source_url = EXCLUDED.source_url,
            source_filename = EXCLUDED.source_filename,
            normalized_filename = EXCLUDED.normalized_filename,
            upload_date = EXCLUDED.upload_date,
            mime_type = EXCLUDED.mime_type,
            size_bytes = EXCLUDED.size_bytes,
            sha256 = EXCLUDED.sha256,
            bucket = EXCLUDED.bucket,
            object_key = EXCLUDED.object_key,
            minio_uri = EXCLUDED.minio_uri,
            etag = EXCLUDED.etag,
            version_id = EXCLUDED.version_id,
            download_status = EXCLUDED.download_status,
            storage_status = EXCLUDED.storage_status,
            is_latest_for_analysis = EXCLUDED.is_latest_for_analysis,
            retry_count = EXCLUDED.retry_count,
            last_error_code = EXCLUDED.last_error_code,
            last_error_message = EXCLUDED.last_error_message,
            last_attempt_at = EXCLUDED.last_attempt_at,
            downloaded_at = EXCLUDED.downloaded_at,
            stored_at = EXCLUDED.stored_at
        """,
        row["asset_id"],
        row["license_id"],
        row["appearance_id"],
        row["asset_type"],
        row["asset_group"],
        row["source_page"],
        row["source_url"],
        row["source_filename"],
        row["normalized_filename"],
        _parse_date(row["upload_date"]),
        row["mime_type"],
        row["size_bytes"],
        row["sha256"],
        row["bucket"],
        row["object_key"],
        row["minio_uri"],
        row["etag"],
        row["version_id"],
        row["download_status"],
        row["storage_status"],
        row["is_latest_for_analysis"],
        row["retry_count"],
        row["last_error_code"],
        row["last_error_message"],
        row["last_attempt_at"],
        row["downloaded_at"],
        row["stored_at"],
    )


async def _upsert_stage_event(
    conn: asyncpg.Connection,
    *,
    license_id: str,
    stage: str,
    status: str,
    error_code: str,
    error_message: str,
    payload: dict[str, Any],
    now: datetime,
) -> None:
    await conn.execute(
        """
        INSERT INTO drug.import_stage_events (
            run_id, license_id, stage, from_status, to_status,
            error_code, error_message, payload, created_at
        )
        VALUES (NULL, $1, $2, NULL, $3, $4, $5, $6::jsonb, $7)
        """,
        license_id,
        stage,
        status,
        error_code,
        error_message,
        _json(payload),
        now,
    )


async def _candidate_sources(
    conn: asyncpg.Connection,
    *,
    license_ids: list[str] | None,
    limit: int | None,
    include_cancelled: bool,
    retry_failed: bool,
    retry_stage: str | None,
) -> list[asyncpg.Record]:
    where = ["l.is_listed"]
    params: list[Any] = []
    if not include_cancelled:
        where.append("l.is_active")

    if license_ids:
        params.append(license_ids)
        where.append(f"l.license_id = ANY(${len(params)}::text[])")
    else:
        pending_statuses = ["pending", "partial_success"]
        if retry_failed:
            pending_statuses.append("retryable_failed")
        params.append(pending_statuses)
        status_param = f"${len(params)}::text[]"
        if retry_stage == "ocr":
            where.append(f"COALESCE(s.ocr_status, 'pending') = ANY({status_param})")
        elif retry_stage == "analysis":
            where.append(
                f"(ia.source_asset_id IS NULL OR COALESCE(s.analysis_status, 'pending') = ANY({status_param}))"
            )
        elif retry_stage == "normalize":
            where.append(
                f"COALESCE(s.normalize_status, 'pending') = ANY({status_param})"
            )
        else:
            where.append(
                "("
                f"ia.source_asset_id IS NULL OR "
                f"COALESCE(s.ocr_status, 'pending') = ANY({status_param}) OR "
                f"COALESCE(s.analysis_status, 'pending') = ANY({status_param}) OR "
                f"COALESCE(s.normalize_status, 'pending') = ANY({status_param})"
                ")"
            )

    sql = f"""
        SELECT
            l.license_id,
            a.asset_id::text AS source_asset_id,
            a.object_key,
            a.normalized_filename,
            a.upload_date,
            COALESCE(s.ocr_status, 'pending') AS ocr_status,
            COALESCE(s.analysis_status, 'pending') AS analysis_status,
            COALESCE(s.normalize_status, 'pending') AS normalize_status
        FROM drug.licenses l
        JOIN LATERAL (
            SELECT asset_id, object_key, normalized_filename, upload_date
            FROM drug.assets a
            WHERE a.license_id = l.license_id
              AND a.asset_type = 'insert_pdf'
              AND a.storage_status = 'success'
            ORDER BY a.is_latest_for_analysis DESC,
                     a.upload_date DESC NULLS LAST,
                     a.stored_at DESC NULLS LAST,
                     a.normalized_filename
            LIMIT 1
        ) a ON TRUE
        LEFT JOIN drug.import_license_state s ON s.license_id = l.license_id
        LEFT JOIN drug.insert_analysis ia ON ia.source_asset_id = a.asset_id
        WHERE {" AND ".join(where)}
        ORDER BY l.license_id
    """
    if limit:
        params.append(limit)
        sql += f" LIMIT ${len(params)}"
    return await conn.fetch(sql, *params)


async def load_drug_analysis(
    pool: asyncpg.Pool,
    *,
    limit: int | None = None,
    license_ids: list[str] | None = None,
    include_cancelled: bool = False,
    retry_failed: bool = False,
    retry_stage: str | None = None,
) -> None:
    """Run Phase 3 OCR / analysis / normalize refresh for drug insert PDFs."""
    retry_stage = (retry_stage or "").strip().lower() or None
    if retry_stage and retry_stage not in {"ocr", "analysis", "normalize"}:
        raise ValueError("retry_stage must be one of: ocr, analysis, normalize")

    analysis_service = DrugAnalysisService()
    minio = MinioService()
    await minio.initialize()

    if retry_stage != "normalize":
        ready, reason = (
            analysis_service.analysis_readiness()
            if retry_stage == "analysis"
            else analysis_service.readiness()
        )
        if not ready:
            print(f"  Drug analysis skipped: {reason}")
            return
        if not minio.enabled:
            print(f"  Drug analysis skipped: {minio.init_error or 'MinIO not configured'}")
            return

    async with pool.acquire() as conn:
        candidates = await _candidate_sources(
            conn,
            license_ids=license_ids,
            limit=limit,
            include_cancelled=include_cancelled,
            retry_failed=retry_failed,
            retry_stage=retry_stage,
        )

    if not candidates:
        print("  Drug analysis: no candidate licenses found.")
        return

    print(f"Running drug analysis for {len(candidates)} license(s) ...")

    for candidate in candidates:
        license_id = candidate["license_id"]
        source_asset_id = candidate["source_asset_id"]
        now = datetime.now(timezone.utc)
        source_filename = candidate["normalized_filename"] or "insert.pdf"
        source_upload_date = _date_text(candidate["upload_date"])

        try:
            if retry_stage == "normalize":
                async with pool.acquire() as conn:
                    analysis_json = await _load_analysis_payload(conn, source_asset_id)
                    record = await _refresh_normalized_record(
                        conn,
                        license_id=license_id,
                        source_asset_id=source_asset_id,
                        analysis_json=analysis_json,
                        normalized_at=now,
                    )
                    await conn.execute(
                        """
                        INSERT INTO drug.normalized_records (
                            license_id, normalized_json, primary_insert_source,
                            quality_confidence, missing_fields, conflict_fields,
                            source_errors, normalized_at
                        )
                        VALUES ($1, $2::jsonb, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8)
                        ON CONFLICT (license_id) DO UPDATE SET
                            normalized_json = EXCLUDED.normalized_json,
                            primary_insert_source = EXCLUDED.primary_insert_source,
                            quality_confidence = EXCLUDED.quality_confidence,
                            missing_fields = EXCLUDED.missing_fields,
                            conflict_fields = EXCLUDED.conflict_fields,
                            source_errors = EXCLUDED.source_errors,
                            normalized_at = EXCLUDED.normalized_at
                        """,
                        license_id,
                        _json(record),
                        record["source"]["primary_insert_source"],
                        record["quality"]["confidence"],
                        _json(record["quality"]["missing_fields"]),
                        _json(record["quality"]["conflict_fields"]),
                        _json(record["source"]["errors"]),
                        now,
                    )
                    await conn.execute(
                        """
                        UPDATE drug.import_license_state
                        SET normalize_status = 'success',
                            updated_at = $2,
                            next_retry_at = NULL,
                            last_error_code = '',
                            last_error_message = ''
                        WHERE license_id = $1
                        """,
                        license_id,
                        now,
                    )
                    await _upsert_stage_event(
                        conn,
                        license_id=license_id,
                        stage="normalize",
                        status="success",
                        error_code="",
                        error_message="",
                        payload={"retry_stage": "normalize"},
                        now=now,
                    )
                print(f"  {license_id}: normalize=success")
                continue

            pdf_bytes = await minio.download_bytes(candidate["object_key"])
            existing_markdown = None
            if retry_stage == "analysis":
                async with pool.acquire() as conn:
                    existing_markdown = await _load_existing_ocr_markdown(
                        conn, minio, source_asset_id
                    )

            result = await analysis_service.analyze_pdf_bytes(
                license_id=license_id,
                source_filename=source_filename,
                pdf_bytes=pdf_bytes,
                existing_markdown=existing_markdown,
            )

            ocr_asset_id = _analysis_asset_id(source_asset_id, "ocr")
            analysis_asset_id = _analysis_asset_id(source_asset_id, "analysis")
            markdown_filename = f"{Path(source_filename).stem}.ocr.md"
            analysis_filename = f"{Path(source_filename).stem}.analysis.json"
            markdown_bytes = result.markdown.encode("utf-8")
            analysis_bytes = json.dumps(
                result.analysis_json, ensure_ascii=False, indent=2
            ).encode("utf-8")

            markdown_object_key = _analysis_object_key(
                license_id, source_asset_id, markdown_filename
            )
            analysis_object_key = _analysis_object_key(
                license_id, source_asset_id, analysis_filename
            )

            markdown_locator = minio.build_locator(markdown_object_key)
            markdown_locator.update(
                await minio.upload_bytes(
                    object_key=markdown_object_key,
                    data=markdown_bytes,
                    content_type="text/markdown; charset=utf-8",
                )
            )
            analysis_locator = minio.build_locator(analysis_object_key)
            analysis_locator.update(
                await minio.upload_bytes(
                    object_key=analysis_object_key,
                    data=analysis_bytes,
                    content_type="application/json",
                )
            )

            markdown_row = _analysis_asset_row(
                asset_id=ocr_asset_id,
                license_id=license_id,
                source_asset_id=source_asset_id,
                asset_type="ocr_markdown",
                filename=markdown_filename,
                mime_type="text/markdown",
                data=markdown_bytes,
                locator=markdown_locator,
                storage_status="success",
                source_upload_date=source_upload_date,
                now=now,
            )
            analysis_row = _analysis_asset_row(
                asset_id=analysis_asset_id,
                license_id=license_id,
                source_asset_id=source_asset_id,
                asset_type="analysis_json",
                filename=analysis_filename,
                mime_type="application/json",
                data=analysis_bytes,
                locator=analysis_locator,
                storage_status="success",
                source_upload_date=source_upload_date,
                now=now,
            )

            async with pool.acquire() as conn:
                async with conn.transaction():
                    await _upsert_asset_row(conn, markdown_row)
                    await _upsert_asset_row(conn, analysis_row)

                    await conn.execute(
                        """
                        INSERT INTO drug.insert_analysis (
                            analysis_id, license_id, source_asset_id, ocr_asset_id,
                            analysis_asset_id, primary_insert_source, ocr_provider,
                            analysis_provider, ocr_status, analysis_status,
                            normalized_json, last_error_code, last_error_message,
                            last_attempt_at, completed_at
                        )
                        VALUES (
                            $1, $2, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9, $10,
                            $11::jsonb, $12, $13, $14, $15
                        )
                        ON CONFLICT (source_asset_id) DO UPDATE SET
                            ocr_asset_id = EXCLUDED.ocr_asset_id,
                            analysis_asset_id = EXCLUDED.analysis_asset_id,
                            primary_insert_source = EXCLUDED.primary_insert_source,
                            ocr_provider = EXCLUDED.ocr_provider,
                            analysis_provider = EXCLUDED.analysis_provider,
                            ocr_status = EXCLUDED.ocr_status,
                            analysis_status = EXCLUDED.analysis_status,
                            normalized_json = EXCLUDED.normalized_json,
                            last_error_code = EXCLUDED.last_error_code,
                            last_error_message = EXCLUDED.last_error_message,
                            last_attempt_at = EXCLUDED.last_attempt_at,
                            completed_at = EXCLUDED.completed_at
                        """,
                        _analysis_id(source_asset_id),
                        license_id,
                        source_asset_id,
                        str(ocr_asset_id),
                        str(analysis_asset_id),
                        "pdf_insert",
                        result.ocr_provider,
                        result.analysis_provider,
                        "success",
                        "success",
                        _json(result.analysis_json),
                        "",
                        "",
                        now,
                        now,
                    )

                    record = await _refresh_normalized_record(
                        conn,
                        license_id=license_id,
                        source_asset_id=source_asset_id,
                        analysis_json=result.analysis_json,
                        normalized_at=now,
                    )
                    await conn.execute(
                        """
                        INSERT INTO drug.normalized_records (
                            license_id, normalized_json, primary_insert_source,
                            quality_confidence, missing_fields, conflict_fields,
                            source_errors, normalized_at
                        )
                        VALUES ($1, $2::jsonb, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8)
                        ON CONFLICT (license_id) DO UPDATE SET
                            normalized_json = EXCLUDED.normalized_json,
                            primary_insert_source = EXCLUDED.primary_insert_source,
                            quality_confidence = EXCLUDED.quality_confidence,
                            missing_fields = EXCLUDED.missing_fields,
                            conflict_fields = EXCLUDED.conflict_fields,
                            source_errors = EXCLUDED.source_errors,
                            normalized_at = EXCLUDED.normalized_at
                        """,
                        license_id,
                        _json(record),
                        record["source"]["primary_insert_source"],
                        record["quality"]["confidence"],
                        _json(record["quality"]["missing_fields"]),
                        _json(record["quality"]["conflict_fields"]),
                        _json(record["source"]["errors"]),
                        now,
                    )

                    await conn.execute(
                        """
                        UPDATE drug.import_license_state
                        SET ocr_status = 'success',
                            analysis_status = 'success',
                            normalize_status = 'success',
                            updated_at = $2,
                            next_retry_at = NULL,
                            last_error_code = '',
                            last_error_message = ''
                        WHERE license_id = $1
                        """,
                        license_id,
                        now,
                    )

                    await _upsert_stage_event(
                        conn,
                        license_id=license_id,
                        stage="ocr",
                        status="success",
                        error_code="",
                        error_message="",
                        payload={"source_asset_id": source_asset_id},
                        now=now,
                    )
                    await _upsert_stage_event(
                        conn,
                        license_id=license_id,
                        stage="analysis",
                        status="success",
                        error_code="",
                        error_message="",
                        payload={"source_asset_id": source_asset_id},
                        now=now,
                    )
                    await _upsert_stage_event(
                        conn,
                        license_id=license_id,
                        stage="normalize",
                        status="success",
                        error_code="",
                        error_message="",
                        payload={"source_asset_id": source_asset_id},
                        now=now,
                    )

            print(f"  {license_id}: ocr=success, analysis=success, normalize=success")
        except Exception as exc:
            error_message = str(exc)
            next_retry_at = now + timedelta(minutes=30)
            failed_ocr = (
                candidate["ocr_status"]
                if retry_stage in {"analysis", "normalize"}
                else "retryable_failed"
            )
            failed_analysis = (
                "retryable_failed"
                if retry_stage in (None, "analysis", "ocr")
                else candidate["analysis_status"]
            )
            failed_normalize = (
                "retryable_failed"
                if retry_stage in (None, "normalize", "analysis", "ocr")
                else candidate["normalize_status"]
            )
            async with pool.acquire() as conn:
                await conn.execute(
                    """
                    UPDATE drug.import_license_state
                    SET ocr_status = $2,
                        analysis_status = $3,
                        normalize_status = $4,
                        updated_at = $5,
                        next_retry_at = $6,
                        retry_count = retry_count + 1,
                        last_error_code = 'retryable_failed',
                        last_error_message = $7
                    WHERE license_id = $1
                    """,
                    license_id,
                    failed_ocr,
                    failed_analysis,
                    failed_normalize,
                    now,
                    next_retry_at,
                    error_message,
                )
                if retry_stage != "normalize":
                    await conn.execute(
                        """
                        INSERT INTO drug.insert_analysis (
                            analysis_id, license_id, source_asset_id, primary_insert_source,
                            ocr_provider, analysis_provider, ocr_status, analysis_status,
                            normalized_json, last_error_code, last_error_message,
                            last_attempt_at, completed_at
                        )
                        VALUES (
                            $1, $2, $3::uuid, 'pdf_insert', $4, $5, $6, $7,
                            '{}'::jsonb, 'retryable_failed', $8, $9, NULL
                        )
                        ON CONFLICT (source_asset_id) DO UPDATE SET
                            ocr_provider = EXCLUDED.ocr_provider,
                            analysis_provider = EXCLUDED.analysis_provider,
                            ocr_status = EXCLUDED.ocr_status,
                            analysis_status = EXCLUDED.analysis_status,
                            last_error_code = EXCLUDED.last_error_code,
                            last_error_message = EXCLUDED.last_error_message,
                            last_attempt_at = EXCLUDED.last_attempt_at,
                            completed_at = NULL
                        """,
                        _analysis_id(source_asset_id),
                        license_id,
                        source_asset_id,
                        analysis_service.config.ocr_provider,
                        analysis_service.config.analysis_provider,
                        failed_ocr,
                        failed_analysis,
                        error_message,
                        now,
                    )
                await _upsert_stage_event(
                    conn,
                    license_id=license_id,
                    stage=retry_stage or "analysis_pipeline",
                    status="retryable_failed",
                    error_code="retryable_failed",
                    error_message=error_message,
                    payload={"source_asset_id": source_asset_id},
                    now=now,
                )
            print(f"  {license_id}: analysis failed ({error_message})")
