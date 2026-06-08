"""
Phase 2 loader for TFDA drug enrichment and MinIO-backed assets.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any
import uuid

import asyncpg

from drug_record_builder import build_drug_record, is_ei_complete
from minio_service import MinioService
from tfda_crawler_service import AppearanceRecordScrape, DrugEnrichmentPayload, ScrapedAsset, TFDACrawlerService
from tfda_parser_utils import parse_date

ASSET_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "taiwan-health-mcp/drug-assets")
APPEARANCE_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "taiwan-health-mcp/drug-appearance")


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def _stage_status(*, item_count: int, had_error: bool) -> str:
    if had_error and item_count > 0:
        return "partial_success"
    if had_error:
        return "retryable_failed"
    if item_count > 0:
        return "success"
    return "no_data"


def _deterministic_asset_id(
    license_id: str, asset_type: str, normalized_filename: str, source_url: str
) -> uuid.UUID:
    return uuid.uuid5(
        ASSET_NAMESPACE,
        f"{license_id}|{asset_type}|{normalized_filename}|{source_url}",
    )


def _deterministic_appearance_id(license_id: str, shape_id: str) -> uuid.UUID:
    return uuid.uuid5(APPEARANCE_NAMESPACE, f"{license_id}|{shape_id}")


def _planned_object_key(
    license_id: str,
    asset_group: str,
    asset_id: uuid.UUID,
    normalized_filename: str,
) -> str:
    return f"drug/{license_id}/{asset_group}/{asset_id}/{normalized_filename}"


def _asset_row_from_uploaded(
    license_id: str,
    asset: ScrapedAsset,
    *,
    asset_id: uuid.UUID,
    appearance_id: uuid.UUID | None,
    upload_result: dict[str, Any] | None,
    storage_status: str,
    last_error_message: str = "",
) -> dict[str, Any]:
    locator = upload_result or {}
    upload_date = parse_date(asset.upload_date)
    return {
        "asset_id": asset_id,
        "license_id": license_id,
        "appearance_id": appearance_id,
        "asset_type": asset.asset_type,
        "asset_group": asset.asset_group,
        "source_page": asset.source_page,
        "source_url": asset.source_url,
        "source_filename": asset.source_filename,
        "normalized_filename": asset.normalized_filename,
        "upload_date": upload_date.date() if upload_date else None,
        "mime_type": asset.mime_type,
        "size_bytes": asset.size_bytes,
        "sha256": asset.sha256,
        "bucket": locator.get("bucket", ""),
        "object_key": locator.get("object_key", ""),
        "minio_uri": locator.get("minio_uri", ""),
        "etag": locator.get("etag", ""),
        "version_id": locator.get("version_id", ""),
        "download_status": asset.download_status,
        "storage_status": storage_status,
        "is_latest_for_analysis": False,
        "retry_count": 0,
        "last_error_code": "" if not last_error_message else "storage_failed",
        "last_error_message": last_error_message,
        "last_attempt_at": datetime.now(timezone.utc),
        "downloaded_at": asset.downloaded_at,
        "stored_at": datetime.now(timezone.utc) if storage_status == "success" else None,
    }


def _convert_atc_rows(license_id: str, electronic_insert: dict[str, Any] | None) -> list[tuple[str, str, str, str]]:
    if not electronic_insert:
        return []
    rows: list[tuple[str, str, str, str]] = []
    for item in electronic_insert.get("atc_codes", []):
        if not isinstance(item, dict):
            continue
        code = item.get("ATC Code") or item.get("代碼") or item.get("ATC") or ""
        name = (
            item.get("ATC名稱")
            or item.get("中文分類名稱")
            or item.get("英文分類名稱")
            or item.get("名稱")
            or ""
        )
        if code or name:
            rows.append((license_id, code, name, _json(item)))
    return rows


def _convert_appearance_rows(
    license_id: str, records: list[AppearanceRecordScrape]
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for record in records:
        raw = record.raw_json
        rows.append(
            {
                "appearance_id": _deterministic_appearance_id(license_id, record.shape_id),
                "license_id": license_id,
                "shape_id": record.shape_id,
                "appearance_no": raw.get("外觀編號", ""),
                "detail_url": record.detail_url,
                "description": raw.get("藥品外觀", raw.get("外觀", "")),
                "color": " ".join(
                    part
                    for part in [raw.get("顏色", ""), raw.get("顏色1", ""), raw.get("顏色2", "")]
                    if part
                ),
                "shape": raw.get("形狀", ""),
                "scoring": raw.get("刻痕", ""),
                "symbol": raw.get("符號", ""),
                "size": raw.get("大小", ""),
                "imprint": " ".join(
                    part
                    for part in [raw.get("標記", ""), raw.get("標記1", ""), raw.get("標記2", "")]
                    if part
                ),
                "raw_json": raw,
            }
        )
    return rows


def _stage_errors(payload: DrugEnrichmentPayload, prefix: str) -> list[str]:
    return [err for err in payload.errors if err.startswith(prefix)]


async def _candidate_licenses(
    conn: asyncpg.Connection,
    *,
    license_ids: list[str] | None,
    limit: int | None,
    include_cancelled: bool,
    retry_failed: bool,
) -> list[str]:
    if license_ids:
        if include_cancelled:
            rows = await conn.fetch(
                "SELECT license_id FROM drug.licenses WHERE license_id = ANY($1::text[]) ORDER BY license_id",
                license_ids,
            )
        else:
            rows = await conn.fetch(
                "SELECT license_id FROM drug.licenses WHERE license_id = ANY($1::text[]) AND is_active ORDER BY license_id",
                license_ids,
            )
        return [row["license_id"] for row in rows]

    statuses = ["pending", "partial_success"]
    if retry_failed:
        statuses.append("retryable_failed")
    sql = """
        SELECT q.license_id
        FROM drug.enrichment_queue q
        JOIN drug.licenses l ON l.license_id = q.license_id
        WHERE q.status = ANY($1::text[])
          AND q.available_at <= NOW()
    """
    params: list[Any] = [statuses]
    if not include_cancelled:
        sql += " AND l.is_active "
    sql += " ORDER BY q.priority DESC, q.queue_id "
    if limit:
        sql += " LIMIT $2 "
        params.append(limit)
    rows = await conn.fetch(sql, *params)
    return [row["license_id"] for row in rows]


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


async def load_drug_enrichment(
    pool: asyncpg.Pool,
    *,
    limit: int | None = None,
    license_ids: list[str] | None = None,
    include_cancelled: bool = False,
    retry_failed: bool = False,
    tfda_values: dict | None = None,
    minio_service: "MinioService | None" = None,
) -> None:
    """Run Phase 2 TFDA enrichment for queued or explicitly selected licenses.

    ``tfda_values``/``minio_service`` carry DB-backed settings from the worker;
    when omitted (e.g. CLI use) they fall back to environment configuration.
    """
    if tfda_values:
        crawler = TFDACrawlerService(
            base_url=str(tfda_values.get("base_url") or "") or None,
            timeout=int(tfda_values.get("http_timeout") or 0) or None,
        )
    else:
        crawler = TFDACrawlerService()
    if minio_service is not None:
        minio = minio_service
    else:
        minio = MinioService()
        await minio.initialize()

    async with pool.acquire() as conn:
        candidates = await _candidate_licenses(
            conn,
            license_ids=license_ids,
            limit=limit,
            include_cancelled=include_cancelled,
            retry_failed=retry_failed,
        )

    if not candidates:
        print("  Drug enrichment: no candidate licenses found.")
        return

    print(f"Running TFDA enrichment for {len(candidates)} license(s) ...")

    for license_id in candidates:
        try:
            await _enrich_one_license(pool, crawler, minio, license_id)
        except Exception as exc:
            print(f"  {license_id}: UNEXPECTED ERROR — {exc}")
            try:
                async with pool.acquire() as _err_conn:
                    async with _err_conn.transaction():
                        await _err_conn.execute(
                            """
                            UPDATE drug.enrichment_queue
                            SET status = 'retryable_failed',
                                attempt_count = attempt_count + 1,
                                last_error_message = $2
                            WHERE license_id = $1
                            """,
                            license_id,
                            str(exc)[:500],
                        )
                        await _err_conn.execute(
                            """
                            UPDATE drug.import_license_state
                            SET last_error_code = 'unexpected_exception',
                                last_error_message = $2,
                                updated_at = NOW()
                            WHERE license_id = $1
                            """,
                            license_id,
                            str(exc)[:500],
                        )
            except Exception as db_exc:
                print(f"  {license_id}: failed to record error state: {db_exc}")


async def _enrich_one_license(
    pool: asyncpg.Pool,
    crawler: "TFDACrawlerService",
    minio: "MinioService",
    license_id: str,
) -> None:
    now = datetime.now(timezone.utc)
    payload = await crawler.scrape_license(license_id)
    electronic_errors = _stage_errors(payload, "electronic_insert:")
    insert_errors = _stage_errors(payload, "insert_page:") + _stage_errors(payload, "insert_download:")
    label_errors = _stage_errors(payload, "label_page:") + _stage_errors(payload, "label_download:")
    shape_errors = _stage_errors(payload, "shape_scrape:")

    electronic_status = (
        "success"
        if payload.electronic_insert is not None
        else ("retryable_failed" if electronic_errors else "no_data")
    )
    insert_status = _stage_status(item_count=len(payload.insert_assets), had_error=bool(insert_errors))
    label_status = _stage_status(item_count=len(payload.label_assets), had_error=bool(label_errors))
    shape_status = _stage_status(item_count=len(payload.appearance_records), had_error=bool(shape_errors))

    uploaded_assets: list[dict[str, Any]] = []
    storage_failures = 0
    all_assets: list[tuple[ScrapedAsset, uuid.UUID | None, uuid.UUID]] = []

    appearance_rows = _convert_appearance_rows(license_id, payload.appearance_records)
    # Deduplicate by appearance_id — TFDA occasionally returns the same shape_id
    # more than once in the shape list, which would violate appearance_records_pkey.
    seen_appearance_ids: set[uuid.UUID] = set()
    appearance_rows = [
        row for row in appearance_rows
        if not (row["appearance_id"] in seen_appearance_ids or seen_appearance_ids.add(row["appearance_id"]))  # type: ignore[func-returns-value]
    ]
    # Also deduplicate the source records so image assets aren't processed twice.
    seen_shape_ids: set[str] = set()
    deduped_appearance_records = [
        rec for rec in payload.appearance_records
        if not (rec.shape_id in seen_shape_ids or seen_shape_ids.add(rec.shape_id))  # type: ignore[func-returns-value]
    ]
    appearance_map = {row["shape_id"]: row["appearance_id"] for row in appearance_rows}
    for asset in payload.insert_assets + payload.label_assets:
        asset_id = _deterministic_asset_id(
            license_id, asset.asset_type, asset.normalized_filename, asset.source_url
        )
        all_assets.append((asset, None, asset_id))
    for record in deduped_appearance_records:
        appearance_id = appearance_map[record.shape_id]
        for asset in record.images:
            asset_id = _deterministic_asset_id(
                license_id, asset.asset_type, asset.normalized_filename, asset.source_url
            )
            all_assets.append((asset, appearance_id, asset_id))

    latest_insert_asset_id: uuid.UUID | None = None
    latest_insert_asset_upload = None
    for asset, appearance_id, asset_id in all_assets:
        object_key = _planned_object_key(
            license_id, asset.asset_group, asset_id, asset.normalized_filename
        )
        locator = minio.build_locator(object_key)
        upload_result: dict[str, Any] | None = {**locator}
        storage_status = "success"
        last_error_message = ""
        if minio.enabled:
            try:
                upload_result = {
                    **locator,
                    **await minio.upload_bytes(
                        object_key=object_key,
                        data=asset.content,
                        content_type=asset.mime_type,
                    ),
                }
            except Exception as exc:
                storage_status = "retryable_failed"
                last_error_message = str(exc)
                storage_failures += 1
        else:
            storage_status = "retryable_failed"
            last_error_message = minio.init_error or "MinIO not configured"
            storage_failures += 1

        row = _asset_row_from_uploaded(
            license_id,
            asset,
            asset_id=asset_id,
            appearance_id=appearance_id,
            upload_result=upload_result,
            storage_status=storage_status,
            last_error_message=last_error_message,
        )
        uploaded_assets.append(row)
        if asset.asset_type == "insert_pdf":
            upload_dt = parse_date(asset.upload_date) or datetime.min
            if latest_insert_asset_upload is None or upload_dt >= latest_insert_asset_upload:
                latest_insert_asset_upload = upload_dt
                latest_insert_asset_id = asset_id

    for asset_row in uploaded_assets:
        asset_row["is_latest_for_analysis"] = asset_row["asset_id"] == latest_insert_asset_id

    has_insert_assets = any(
        asset_row["asset_type"] == "insert_pdf" for asset_row in uploaded_assets
    )
    has_insert_assets_stored = any(
        asset_row["asset_type"] == "insert_pdf"
        and asset_row["storage_status"] == "success"
        for asset_row in uploaded_assets
    )

    if not uploaded_assets:
        storage_status = "no_data"
    elif storage_failures == 0:
        storage_status = "success"
    elif storage_failures < len(uploaded_assets):
        storage_status = "partial_success"
    else:
        storage_status = "retryable_failed"

    async with pool.acquire() as conn:
        index_row = await _load_index_row(conn, license_id)
        if index_row is None:
            return
        appearance_records_for_record: list[dict[str, Any]] = []
        for appearance_row in appearance_rows:
            images = [
                asset_row
                for asset_row in uploaded_assets
                if asset_row["appearance_id"] == appearance_row["appearance_id"]
            ]
            appearance_records_for_record.append({**appearance_row, "images": images})

        normalized_record = build_drug_record(
            index_row,
            electronic_insert=payload.electronic_insert,
            insert_assets=[row for row in uploaded_assets if row["asset_group"] == "insert"],
            label_assets=[row for row in uploaded_assets if row["asset_group"] == "label"],
            appearance_records=appearance_records_for_record,
            source_errors=payload.errors,
            normalized_at=now,
        )

        atc_rows = _convert_atc_rows(license_id, payload.electronic_insert)
        ingredient_rows = []
        for sort_order, item in enumerate(
            normalized_record["ingredients"]["active"], start=1
        ):
            ingredient_rows.append(
                (
                    license_id,
                    item.get("name", ""),
                    item.get("amount", ""),
                    item.get("unit", ""),
                    item.get("raw_text", ""),
                    "normalized_record",
                    sort_order,
                    _json(item),
                )
            )

        # Determine what further processing is needed based on EI completeness and PDF availability.
        #
        # Situation A — complete EI, no PDF: fully enriched, OCR not possible.
        # Situation B — complete EI + PDF stored: EI usable now, but PDF gives better data → OCR.
        # Situation C — incomplete EI + PDF stored: index-quality only until OCR done → OCR.
        # Situation D — no PDF (regardless of EI): best-effort with available data, done.
        #
        # In all cases build_drug_record has already stored a preliminary normalized record.
        # normalize_status='pending' signals the analysis job to re-normalize after OCR.
        ei_complete = is_ei_complete(payload.electronic_insert)

        if has_insert_assets_stored:
            # Situations B & C: PDF available — always do OCR for highest quality
            normalize_status = "pending"
            ocr_status = "pending"
            analysis_status = "pending"
        elif has_insert_assets:
            # PDF downloaded but MinIO storage failed — retry storage before OCR
            normalize_status = "pending"
            ocr_status = "retryable_failed"
            analysis_status = "retryable_failed"
        elif ei_complete:
            # Situation A: complete EI, no PDF — best achievable quality, done
            normalize_status = "success"
            ocr_status = "no_data"
            analysis_status = "no_data"
        else:
            # Situation D: no PDF, incomplete/absent EI — index-level quality, done
            normalize_status = "success"
            ocr_status = "no_data"
            analysis_status = "no_data"

        any_retryable = any(
            status == "retryable_failed"
            for status in (
                electronic_status,
                insert_status,
                label_status,
                shape_status,
                storage_status,
                ocr_status,
                analysis_status,
            )
        )
        queue_status = (
            "retryable_failed"
            if any_retryable
            else (
                "partial_success"
                if any(status == "partial_success" for status in (insert_status, label_status, shape_status, storage_status))
                else "success"
            )
        )

        async with conn.transaction():
            # Replace stage-owned tables for this license; keep deterministic object keys.
            if electronic_status != "retryable_failed":
                await conn.execute(
                    "DELETE FROM drug.electronic_inserts WHERE license_id = $1",
                    license_id,
                )
                if payload.electronic_insert is not None:
                    await conn.execute(
                        """
                        INSERT INTO drug.electronic_inserts (
                            license_id, source_url, basic_info_json, manufacturers_json,
                            sections_json, ingredients_json, atc_codes_json, label_pdfs_json,
                            history_pdfs_json, public_pdfs_json, paper_pdfs_json,
                            authorizations_json, raw_page_hash, scraped_at, parse_status,
                            last_error_message
                        )
                        VALUES (
                            $1, $2, $3::jsonb, $4::jsonb,
                            $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb,
                            $9::jsonb, $10::jsonb, $11::jsonb,
                            $12::jsonb, $13, $14, $15, $16
                        )
                        """,
                        license_id,
                        payload.electronic_insert.get("source_url", ""),
                        _json(payload.electronic_insert.get("basic_info", {})),
                        _json(payload.electronic_insert.get("manufacturers", [])),
                        _json(payload.electronic_insert.get("sections", {})),
                        _json(payload.electronic_insert.get("ingredients", {})),
                        _json(payload.electronic_insert.get("atc_codes", [])),
                        _json(payload.electronic_insert.get("label_pdfs", [])),
                        _json(payload.electronic_insert.get("history_pdfs", [])),
                        _json(payload.electronic_insert.get("public_pdfs", [])),
                        _json(payload.electronic_insert.get("paper_pdfs", [])),
                        _json(payload.electronic_insert.get("authorizations", [])),
                        "",
                        now,
                        "success",
                        "",
                    )

            if insert_status != "retryable_failed" or label_status != "retryable_failed" or shape_status != "retryable_failed":
                await conn.execute(
                    "DELETE FROM drug.insert_analysis WHERE license_id = $1",
                    license_id,
                )
                await conn.execute(
                    """
                    DELETE FROM drug.assets
                    WHERE license_id = $1
                      AND asset_group IN ('insert', 'label', 'shape', 'analysis')
                    """,
                    license_id,
                )
                await conn.execute(
                    "DELETE FROM drug.appearance_records WHERE license_id = $1",
                    license_id,
                )
                for row in appearance_rows:
                    await conn.execute(
                        """
                        INSERT INTO drug.appearance_records (
                            appearance_id, license_id, shape_id, appearance_no, detail_url,
                            description, color, shape, scoring, symbol, size, imprint,
                            raw_json, scraped_at
                        )
                        VALUES (
                            $1, $2, $3, $4, $5,
                            $6, $7, $8, $9, $10, $11, $12,
                            $13::jsonb, $14
                        )
                        ON CONFLICT (appearance_id) DO NOTHING
                        """,
                        row["appearance_id"],
                        row["license_id"],
                        row["shape_id"],
                        row["appearance_no"],
                        row["detail_url"],
                        row["description"],
                        row["color"],
                        row["shape"],
                        row["scoring"],
                        row["symbol"],
                        row["size"],
                        row["imprint"],
                        _json(row["raw_json"]),
                        now,
                    )
                for row in uploaded_assets:
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
                        row["upload_date"],
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

            await conn.execute(
                "DELETE FROM drug.ingredients WHERE license_id = $1",
                license_id,
            )
            await conn.execute(
                "DELETE FROM drug.atc WHERE license_id = $1",
                license_id,
            )
            for item in ingredient_rows:
                await conn.execute(
                    """
                    INSERT INTO drug.ingredients (
                        license_id, name, amount, unit, raw_text, source, sort_order, raw_json
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
                    """,
                    *item,
                )
            for item in atc_rows:
                await conn.execute(
                    """
                    INSERT INTO drug.atc (license_id, code, name, source, raw_json)
                    VALUES ($1, $2, $3, 'electronic_insert', $4::jsonb)
                    """,
                    *item,
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
                _json(normalized_record),
                normalized_record["source"]["primary_insert_source"],
                normalized_record["quality"]["confidence"],
                _json(normalized_record["quality"]["missing_fields"]),
                _json(normalized_record["quality"]["conflict_fields"]),
                _json(normalized_record["source"]["errors"]),
                now,
            )

            await conn.execute(
                """
                UPDATE drug.import_license_state
                SET
                    electronic_insert_status = $2,
                    insert_pdf_status = $3,
                    label_pdf_status = $4,
                    shape_status = $5,
                    storage_status = $6,
                    normalize_status = $7,
                    ocr_status = $8,
                    analysis_status = $9,
                    updated_at = $10,
                    last_error_code = $11,
                    last_error_message = $12
                WHERE license_id = $1
                """,
                license_id,
                electronic_status,
                insert_status,
                label_status,
                shape_status,
                storage_status,
                normalize_status,
                ocr_status,
                analysis_status,
                now,
                "retryable_failed" if any_retryable else "",
                payload.errors[0] if payload.errors else "",
            )

            await conn.execute(
                """
                UPDATE drug.enrichment_queue
                SET status = $2,
                    claimed_at = $3,
                    claimed_by = $4,
                    attempt_count = attempt_count + 1,
                    last_error_message = $5
                WHERE license_id = $1
                """,
                license_id,
                queue_status,
                now,
                "data-loader",
                payload.errors[0] if payload.errors else "",
            )

            for stage, status, errors in [
                ("electronic_insert_scrape", electronic_status, electronic_errors),
                ("insert_pdf_download", insert_status, insert_errors),
                ("label_pdf_download", label_status, label_errors),
                ("shape_scrape", shape_status, shape_errors),
                ("object_upload", storage_status, [] if storage_failures == 0 else [f"{storage_failures} asset(s) failed to upload"]),
                ("normalize", normalize_status, []),
            ]:
                # 'pending' is an intermediate hand-off marker (e.g. normalize is
                # deferred to the analysis phase when a PDF must be OCR'd), not a
                # completed transition. Logging it as a stage event makes the
                # Recent Events list show a misleading "normalize pending" even
                # though the stage later finishes 'success' under analysis. Only
                # record terminal outcomes.
                if status == "pending":
                    continue
                await conn.execute(
                    """
                    INSERT INTO drug.import_stage_events (
                        run_id, license_id, stage, from_status, to_status,
                        error_code, error_message, payload, created_at
                    )
                    VALUES (
                        NULL, $1, $2, NULL, $3,
                        $4, $5, $6::jsonb, $7
                    )
                    """,
                    license_id,
                    stage,
                    status,
                    "retryable_failed" if status == "retryable_failed" else "",
                    "; ".join(errors),
                    _json({"errors": errors}),
                    now,
                )

    print(
        f"  {license_id}: electronic={electronic_status}, insert={insert_status}, "
        f"label={label_status}, shape={shape_status}, storage={storage_status}"
    )
