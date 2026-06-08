"""
Phase 1 loader for the Taiwan FDA drug index CSV (36_2.csv).

This loader restores an index-first drug domain without enrichment data. It:
  1. snapshots the source file metadata
  2. upserts relational projection tables
  3. stores canonical normalized records in JSONB
  4. enqueues changed licenses for future enrichment phases
"""

from __future__ import annotations

import csv
from datetime import date, datetime, timezone
import hashlib
import json
from pathlib import Path
from typing import Any, Iterable
import uuid

import asyncpg

from drug_record_builder import (
    INDEX_LICENSE,
    build_index_only_record,
    is_active_index_row,
    normalize_license_token,
)

_BATCH_SIZE = 2000


def _batch(items: list[tuple[Any, ...]], size: int = _BATCH_SIZE) -> Iterable[list[tuple[Any, ...]]]:
    for idx in range(0, len(items), size):
        yield items[idx : idx + size]


def _parse_date(value: str) -> date | None:
    value = (value or "").strip()
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y/%m/%d").date()
    except ValueError:
        return None


def _compute_file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _canonical_row_json(row: dict[str, str]) -> str:
    return json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _row_hash(row: dict[str, str]) -> str:
    return hashlib.sha256(_canonical_row_json(row).encode("utf-8")).hexdigest()


def _load_index_rows(index_csv: Path) -> tuple[dict[str, dict[str, str]], int]:
    rows: dict[str, dict[str, str]] = {}
    duplicate_count = 0
    with index_csv.open("r", encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            normalized = {
                key: (value or "").strip()
                for key, value in row.items()
                if key is not None and isinstance(value, str)
            }
            license_id = normalized.get(INDEX_LICENSE, "")
            if not license_id:
                continue
            if license_id in rows:
                duplicate_count += 1
            rows[license_id] = normalized
    return rows, duplicate_count


def _queue_reason(
    license_id: str,
    existing_hashes: dict[str, str],
    existing_listed: dict[str, bool],
    new_hash: str,
) -> str | None:
    if license_id not in existing_hashes:
        return "new_index_entry"
    if not existing_listed.get(license_id, True):
        return "relisted_index_entry"
    if existing_hashes[license_id] != new_hash:
        return "index_row_changed"
    return None


async def load_drug_index(pool: asyncpg.Pool, index_csv_path: str) -> dict[str, Any]:
    """Load ``36_2.csv`` into the Phase 1 drug schema."""
    index_csv = Path(index_csv_path)
    if not index_csv.is_file():
        raise FileNotFoundError(f"Drug index CSV not found: {index_csv}")

    print(f"Loading Taiwan FDA drug index from {index_csv} ...")
    rows_by_license, duplicate_count = _load_index_rows(index_csv)
    if not rows_by_license:
        raise ValueError(f"Drug index CSV is empty: {index_csv}")

    file_sha256 = _compute_file_sha256(index_csv)
    snapshot_id = uuid.uuid4()
    run_id = uuid.uuid4()
    now = datetime.now(timezone.utc)

    async with pool.acquire() as conn:
        existing_rows = await conn.fetch(
            """
            SELECT license_id, row_hash, is_listed
            FROM drug.licenses
            """
        )
        existing_hashes = {
            row["license_id"]: row["row_hash"] or "" for row in existing_rows
        }
        existing_listed = {
            row["license_id"]: bool(row["is_listed"]) for row in existing_rows
        }

        existing_state_rows = await conn.fetch(
            """
            SELECT license_id, index_status
            FROM drug.import_license_state
            """
        )
        previous_index_status = {
            row["license_id"]: row["index_status"] or "pending"
            for row in existing_state_rows
        }

        # Cumulative model: each CSV is an additive batch (union + dedup). We do
        # NOT treat licenses absent from this file as removed — importing a
        # partial file must never un-list drugs added by earlier files. Per-row
        # cancellation (註銷) is still derived from each CSV row separately via
        # is_active_index_row, so cancelled drugs remain flagged.
        removed_license_ids: list[str] = []

        license_rows: list[tuple[Any, ...]] = []
        ingredient_rows: list[tuple[Any, ...]] = []
        normalized_rows: list[tuple[Any, ...]] = []
        state_rows: list[tuple[Any, ...]] = []
        queue_rows: list[tuple[Any, ...]] = []
        event_rows: list[tuple[Any, ...]] = []

        changed_count = 0
        new_count = 0
        relisted_count = 0

        for license_id in sorted(rows_by_license):
            row = rows_by_license[license_id]
            row_hash = _row_hash(row)
            is_active = is_active_index_row(row)
            record = build_index_only_record(row, normalized_at=now)
            record_json = json.dumps(record, ensure_ascii=False)
            raw_row_json = _canonical_row_json(row)
            reason = _queue_reason(license_id, existing_hashes, existing_listed, row_hash)

            if reason == "new_index_entry":
                new_count += 1
            elif reason == "relisted_index_entry":
                relisted_count += 1
            elif reason == "index_row_changed":
                changed_count += 1

            if reason is not None:
                # Only enqueue active licenses. The enrichment worker claims with
                # `AND l.is_active` (include_cancelled=False), so a pending queue row
                # for an inactive (已註銷) license can never be drained and would sit
                # 'pending' forever. Inactive licenses are intentionally skipped, so
                # the index_load event still records their state below, but they are
                # kept out of the enrichment queue.
                if is_active:
                    queue_rows.append(
                        (
                            license_id,
                            reason,
                            100,
                            "pending",
                            now,
                            None,
                            None,
                            0,
                            "",
                        )
                    )
                event_rows.append(
                    (
                        run_id,
                        license_id,
                        "index_load",
                        previous_index_status.get(license_id, "pending"),
                        "success",
                        "",
                        "",
                        json.dumps({"reason": reason}, ensure_ascii=False),
                        now,
                    )
                )

            license_rows.append(
                (
                    license_id,
                    snapshot_id,
                    row_hash,
                    normalize_license_token(license_id),
                    is_active,
                    True,
                    row.get("註銷狀態", ""),
                    _parse_date(row.get("註銷日期", "")),
                    row.get("註銷理由", ""),
                    _parse_date(row.get("有效日期", "")),
                    _parse_date(row.get("發證日期", "")),
                    _parse_date(row.get("異動日期", "")),
                    row.get("許可證種類", ""),
                    row.get("舊證字號", ""),
                    row.get("通關簽審文件編號", ""),
                    row.get("中文品名", ""),
                    row.get("英文品名", ""),
                    row.get("藥品類別", ""),
                    row.get("管制藥品分類級別", ""),
                    row.get("劑型", ""),
                    row.get("包裝", ""),
                    row.get("適應症", ""),
                    row.get("主成分略述", ""),
                    row.get("申請商名稱", ""),
                    row.get("申請商地址", ""),
                    row.get("申請商統一編號", ""),
                    row.get("製造商名稱", ""),
                    row.get("製造廠廠址", ""),
                    row.get("製造廠公司地址", ""),
                    row.get("製造廠國別", ""),
                    row.get("製程", ""),
                    row.get("用法用量", ""),
                    row.get("包裝與國際條碼", ""),
                    raw_row_json,
                    now,
                    now,
                )
            )

            for sort_order, ingredient in enumerate(
                record["ingredients"]["active"], start=1
            ):
                ingredient_rows.append(
                    (
                        license_id,
                        ingredient.get("name", ""),
                        ingredient.get("amount", ""),
                        ingredient.get("unit", ""),
                        ingredient.get("raw_text", ""),
                        "index_summary",
                        sort_order,
                        json.dumps({"raw_summary": row.get("主成分略述", "")}, ensure_ascii=False),
                    )
                )

            normalized_rows.append(
                (
                    license_id,
                    record_json,
                    record["source"]["primary_insert_source"],
                    record["quality"]["confidence"],
                    json.dumps(record["quality"]["missing_fields"], ensure_ascii=False),
                    json.dumps(record["quality"]["conflict_fields"], ensure_ascii=False),
                    json.dumps(record["source"]["errors"], ensure_ascii=False),
                    now,
                )
            )

            downstream_initial_status = "pending" if is_active else "no_data"

            state_rows.append(
                (
                    license_id,
                    run_id,
                    "success",
                    downstream_initial_status,
                    downstream_initial_status,
                    downstream_initial_status,
                    downstream_initial_status,
                    downstream_initial_status,
                    downstream_initial_status,
                    downstream_initial_status,
                    "success",
                    None,
                    0,
                    "",
                    "",
                    now,
                )
            )

        summary = {
            "source_file": str(index_csv),
            "source_sha256": file_sha256,
            "row_count": len(rows_by_license),
            "duplicates_overwritten": duplicate_count,
            "new_licenses": new_count,
            "changed_licenses": changed_count,
            "relisted_licenses": relisted_count,
            "removed_licenses": len(removed_license_ids),
            "queued_for_enrichment": len(queue_rows),
        }

        async with conn.transaction():
            await conn.execute(
                """
                INSERT INTO drug.import_runs (
                    run_id, run_type, trigger_type, status, started_at, finished_at, summary_json
                )
                VALUES ($1, 'index_full', 'manual', 'success', $2, $2, $3::jsonb)
                """,
                run_id,
                now,
                json.dumps(summary, ensure_ascii=False),
            )
            await conn.execute(
                """
                INSERT INTO drug.index_snapshots (
                    snapshot_id, source_filename, source_sha256, row_count, loaded_at, status, notes
                )
                VALUES ($1, $2, $3, $4, $5, 'success', $6::jsonb)
                """,
                snapshot_id,
                index_csv.name,
                file_sha256,
                len(rows_by_license),
                now,
                json.dumps(
                    {
                        "path": str(index_csv),
                        "new_licenses": new_count,
                        "changed_licenses": changed_count,
                        "relisted_licenses": relisted_count,
                        "duplicates_overwritten": duplicate_count,
                    },
                    ensure_ascii=False,
                ),
            )

            current_ids = sorted(rows_by_license)
            if current_ids:
                await conn.execute(
                    "DELETE FROM drug.ingredients WHERE license_id = ANY($1::text[])",
                    current_ids,
                )
                await conn.execute(
                    "DELETE FROM drug.atc WHERE license_id = ANY($1::text[])",
                    current_ids,
                )

            for batch in _batch(license_rows):
                await conn.executemany(
                    """
                    INSERT INTO drug.licenses (
                        license_id, snapshot_id, row_hash, license_token, is_active, is_listed,
                        cancellation_status, cancellation_date, cancellation_reason,
                        valid_until, issue_date, last_changed_date, license_type,
                        old_license_no, customs_clearance_no, chinese_name, english_name,
                        drug_category, controlled_drug_level, dosage_form, package,
                        indications_text, main_ingredient_summary, applicant_name,
                        applicant_address, applicant_tax_id, manufacturer_name,
                        manufacturer_factory_address, manufacturer_company_address,
                        manufacturer_country, manufacturing_process, usage_text_from_index,
                        barcode_text, raw_index_json, created_at, updated_at
                    )
                    VALUES (
                        $1, $2, $3, $4, $5, $6,
                        $7, $8, $9,
                        $10, $11, $12, $13,
                        $14, $15, $16, $17,
                        $18, $19, $20, $21,
                        $22, $23, $24,
                        $25, $26, $27,
                        $28, $29,
                        $30, $31, $32,
                        $33, $34::jsonb, $35, $36
                    )
                    ON CONFLICT (license_id) DO UPDATE SET
                        snapshot_id = EXCLUDED.snapshot_id,
                        row_hash = EXCLUDED.row_hash,
                        license_token = EXCLUDED.license_token,
                        is_active = EXCLUDED.is_active,
                        is_listed = EXCLUDED.is_listed,
                        cancellation_status = EXCLUDED.cancellation_status,
                        cancellation_date = EXCLUDED.cancellation_date,
                        cancellation_reason = EXCLUDED.cancellation_reason,
                        valid_until = EXCLUDED.valid_until,
                        issue_date = EXCLUDED.issue_date,
                        last_changed_date = EXCLUDED.last_changed_date,
                        license_type = EXCLUDED.license_type,
                        old_license_no = EXCLUDED.old_license_no,
                        customs_clearance_no = EXCLUDED.customs_clearance_no,
                        chinese_name = EXCLUDED.chinese_name,
                        english_name = EXCLUDED.english_name,
                        drug_category = EXCLUDED.drug_category,
                        controlled_drug_level = EXCLUDED.controlled_drug_level,
                        dosage_form = EXCLUDED.dosage_form,
                        package = EXCLUDED.package,
                        indications_text = EXCLUDED.indications_text,
                        main_ingredient_summary = EXCLUDED.main_ingredient_summary,
                        applicant_name = EXCLUDED.applicant_name,
                        applicant_address = EXCLUDED.applicant_address,
                        applicant_tax_id = EXCLUDED.applicant_tax_id,
                        manufacturer_name = EXCLUDED.manufacturer_name,
                        manufacturer_factory_address = EXCLUDED.manufacturer_factory_address,
                        manufacturer_company_address = EXCLUDED.manufacturer_company_address,
                        manufacturer_country = EXCLUDED.manufacturer_country,
                        manufacturing_process = EXCLUDED.manufacturing_process,
                        usage_text_from_index = EXCLUDED.usage_text_from_index,
                        barcode_text = EXCLUDED.barcode_text,
                        raw_index_json = EXCLUDED.raw_index_json,
                        updated_at = EXCLUDED.updated_at
                    """,
                    batch,
                )

            for batch in _batch(ingredient_rows):
                await conn.executemany(
                    """
                    INSERT INTO drug.ingredients (
                        license_id, name, amount, unit, raw_text, source, sort_order, raw_json
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
                    """,
                    batch,
                )

            for batch in _batch(normalized_rows):
                await conn.executemany(
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
                    batch,
                )

            for batch in _batch(state_rows):
                await conn.executemany(
                    """
                    INSERT INTO drug.import_license_state AS ils (
                        license_id, current_run_id, index_status, electronic_insert_status,
                        insert_pdf_status, label_pdf_status, shape_status, storage_status,
                        ocr_status, analysis_status, normalize_status, next_retry_at,
                        retry_count, last_error_code, last_error_message, updated_at
                    )
                    VALUES (
                        $1, $2, $3, $4,
                        $5, $6, $7, $8,
                        $9, $10, $11, $12,
                        $13, $14, $15, $16
                    )
                    ON CONFLICT (license_id) DO UPDATE SET
                        current_run_id = EXCLUDED.current_run_id,
                        index_status = EXCLUDED.index_status,
                        electronic_insert_status = CASE
                            WHEN EXCLUDED.electronic_insert_status = 'no_data'
                                THEN 'no_data'
                            WHEN ils.electronic_insert_status = 'no_data'
                                THEN EXCLUDED.electronic_insert_status
                            ELSE ils.electronic_insert_status
                        END,
                        insert_pdf_status = CASE
                            WHEN EXCLUDED.insert_pdf_status = 'no_data'
                                THEN 'no_data'
                            WHEN ils.insert_pdf_status = 'no_data'
                                THEN EXCLUDED.insert_pdf_status
                            ELSE ils.insert_pdf_status
                        END,
                        label_pdf_status = CASE
                            WHEN EXCLUDED.label_pdf_status = 'no_data'
                                THEN 'no_data'
                            WHEN ils.label_pdf_status = 'no_data'
                                THEN EXCLUDED.label_pdf_status
                            ELSE ils.label_pdf_status
                        END,
                        shape_status = CASE
                            WHEN EXCLUDED.shape_status = 'no_data'
                                THEN 'no_data'
                            WHEN ils.shape_status = 'no_data'
                                THEN EXCLUDED.shape_status
                            ELSE ils.shape_status
                        END,
                        storage_status = CASE
                            WHEN EXCLUDED.storage_status = 'no_data'
                                THEN 'no_data'
                            WHEN ils.storage_status = 'no_data'
                                THEN EXCLUDED.storage_status
                            ELSE ils.storage_status
                        END,
                        ocr_status = CASE
                            WHEN EXCLUDED.ocr_status = 'no_data'
                                THEN 'no_data'
                            WHEN ils.ocr_status = 'no_data'
                                THEN EXCLUDED.ocr_status
                            ELSE ils.ocr_status
                        END,
                        analysis_status = CASE
                            WHEN EXCLUDED.analysis_status = 'no_data'
                                THEN 'no_data'
                            WHEN ils.analysis_status = 'no_data'
                                THEN EXCLUDED.analysis_status
                            ELSE ils.analysis_status
                        END,
                        normalize_status = EXCLUDED.normalize_status,
                        updated_at = EXCLUDED.updated_at
                    """,
                    batch,
                )

            if queue_rows:
                for batch in _batch(queue_rows):
                    await conn.executemany(
                        """
                        INSERT INTO drug.enrichment_queue (
                            license_id, reason, priority, status, available_at,
                            claimed_at, claimed_by, attempt_count, last_error_message
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                        ON CONFLICT (license_id) WHERE status = 'pending' DO NOTHING
                        """,
                        batch,
                    )

            if event_rows:
                for batch in _batch(event_rows):
                    await conn.executemany(
                        """
                        INSERT INTO drug.import_stage_events (
                            run_id, license_id, stage, from_status, to_status,
                            error_code, error_message, payload, created_at
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
                        """,
                        batch,
                    )

    print(
        "  Drug index loaded:",
        len(rows_by_license),
        "licenses",
        f"({new_count} new, {changed_count} changed, {relisted_count} relisted, {len(removed_license_ids)} removed, {duplicate_count} duplicates overwritten).",
    )
    return summary
