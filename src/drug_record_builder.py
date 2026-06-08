"""
Helpers for building canonical drug records from index and enrichment data.

Phase 1 records are built from ``36_2.csv`` only.
Phase 2 records may additionally include:
- electronic insert structured data
- insert / label document metadata with MinIO locators
- appearance records and images with MinIO locators
"""

from __future__ import annotations

from datetime import datetime, timezone
import json
import re
from typing import Any, Mapping

from tfda_parser_utils import parse_date

INDEX_LICENSE = "許可證字號"
INDEX_CANCEL_STATUS = "註銷狀態"
INDEX_CANCEL_DATE = "註銷日期"

_SPLIT_PATTERN = re.compile(r"[；;、]\s*")
_LICENSE_TOKEN_PATTERN = re.compile(r"[^A-Z0-9]+")


def split_index_text(value: str) -> list[str]:
    if not value:
        return []
    return [part.strip() for part in _SPLIT_PATTERN.split(value) if part.strip()]


def is_active_index_row(row: Mapping[str, str]) -> bool:
    return not row.get(INDEX_CANCEL_STATUS) and not row.get(INDEX_CANCEL_DATE)


def is_ei_complete(ei: dict[str, Any] | None) -> bool:
    """Return True if the electronic insert has substantive medical sections content.

    An EI is 'complete' when its sections dict is non-empty (i.e. the TFDA page
    rendered full content such as 適應症, 用法用量, etc.).  An EI with only
    basic_info but an empty sections dict has no additional value over the index
    CSV row and must not be treated as enriched.
    """
    return bool(ei and isinstance(ei.get("sections"), dict) and ei["sections"])


def normalize_license_token(license_id: str) -> str:
    return _LICENSE_TOKEN_PATTERN.sub("", (license_id or "").upper())


def normalize_index_ingredients(raw_summary: str) -> list[dict[str, str]]:
    ingredients: list[dict[str, str]] = []
    for item in split_index_text(raw_summary):
        ingredients.append({"name": item, "amount": "", "unit": "", "raw_text": item})
    return ingredients


def as_list(value: Any) -> list[Any]:
    if value is None or value == "":
        return []
    if isinstance(value, list):
        return value
    return [value]


def text_list(value: Any) -> list[str]:
    items = as_list(value)
    output: list[str] = []
    for item in items:
        if isinstance(item, str) and item.strip():
            output.append(item.strip())
        elif isinstance(item, dict):
            joined = " ".join(
                str(val).strip() for val in item.values() if str(val).strip()
            )
            if joined:
                output.append(joined)
    return output


def nested_get(data: dict[str, Any], *keys: str) -> Any:
    current: Any = data
    for key in keys:
        if not isinstance(current, dict):
            return ""
        current = current.get(key, "")
    return current


def _normalize_ingredient_item(item: Any) -> dict[str, str]:
    if isinstance(item, str):
        return {"name": item, "amount": "", "unit": "", "raw_text": item}
    if not isinstance(item, dict):
        return {"name": "", "amount": "", "unit": "", "raw_text": ""}
    name = (
        item.get("成分")
        or item.get("成分名稱")
        or item.get("name")
        or item.get("ingredient")
        or ""
    )
    amount = (
        item.get("含量")
        or item.get("含量描述")
        or item.get("amount")
        or item.get("quantity")
        or ""
    )
    unit = item.get("單位") or item.get("unit") or ""
    raw_text = item.get("raw_text") or " ".join(str(v) for v in item.values() if v)
    return {
        "name": str(name).strip(),
        "amount": str(amount).strip(),
        "unit": str(unit).strip(),
        "raw_text": str(raw_text).strip(),
    }


def _normalize_ingredients(
    row: Mapping[str, str],
    electronic_insert: dict[str, Any] | None,
    analysis: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if analysis:
        active = [
            _normalize_ingredient_item(item)
            for item in as_list(analysis.get("有效成分及含量"))
        ]
        inactive = [
            _normalize_ingredient_item(item)
            for item in as_list(analysis.get("其他成分"))
        ]
        # PDF OCR sometimes misses ingredients that the electronic insert parsed
        # correctly from structured HTML — fall back to EI when analysis is empty.
        if not active and electronic_insert:
            source = electronic_insert.get("ingredients", {})
            items = source.get("成分", []) if isinstance(source, dict) else []
            active = [_normalize_ingredient_item(item) for item in as_list(items)]
    elif electronic_insert:
        source = electronic_insert.get("ingredients", {})
        items = source.get("成分", []) if isinstance(source, dict) else []
        active = [_normalize_ingredient_item(item) for item in as_list(items)]
        inactive = []
    else:
        active = normalize_index_ingredients(row.get("主成分略述", ""))
        inactive = []

    return {
        "active": active,
        "inactive": inactive,
        "raw_summary": row.get("主成分略述", ""),
    }


def _normalize_companies(
    row: Mapping[str, str], electronic_insert: dict[str, Any] | None
) -> dict[str, Any]:
    basic = (
        electronic_insert.get("basic_info", {})
        if electronic_insert and isinstance(electronic_insert.get("basic_info"), dict)
        else {}
    )
    manufacturers: list[dict[str, str]] = []
    for item in as_list(
        electronic_insert.get("manufacturers") if electronic_insert else []
    ):
        if isinstance(item, dict):
            manufacturers.append(
                {
                    "name": item.get("製造廠名稱", ""),
                    "factory_address": item.get("製造廠地址", ""),
                    "company_address": item.get("製造廠公司地址", ""),
                    "country": item.get("製造廠國別", ""),
                    "process": item.get("製程", item.get("類型", "")),
                }
            )
    if not manufacturers and row.get("製造商名稱"):
        manufacturers.append(
            {
                "name": row.get("製造商名稱", ""),
                "factory_address": row.get("製造廠廠址", ""),
                "company_address": row.get("製造廠公司地址", ""),
                "country": row.get("製造廠國別", ""),
                "process": row.get("製程", ""),
            }
        )
    return {
        "applicant": {
            "name": row.get("申請商名稱") or basic.get("申請商名稱", ""),
            "address": row.get("申請商地址") or basic.get("申請商地址", ""),
            "tax_id": row.get("申請商統一編號", ""),
        },
        "manufacturers": manufacturers,
    }


def _pick_sections(
    electronic_insert: dict[str, Any] | None,
    analysis: dict[str, Any] | None = None,
) -> tuple[str, dict[str, Any]]:
    if analysis:
        return "pdf_insert", analysis
    if electronic_insert:
        sections = electronic_insert.get("sections")
        if isinstance(sections, dict) and sections:
            return "electronic_insert", sections
    return "index_only", {}


def _normalize_usage(
    sections: dict[str, Any], row: Mapping[str, str]
) -> dict[str, Any]:
    purpose = (
        sections.get("用途(適應症)") or sections.get("適應症") or row.get("適應症", "")
    )
    dosage = (
        sections.get("用法用量")
        or sections.get("用法及用量")
        or nested_get(sections, "用法及用量", "用法用量")
        or row.get("用法用量", "")
    )
    return {
        "purpose": (
            split_index_text(purpose)
            if isinstance(purpose, str)
            else text_list(purpose)
        ),
        "dosage_and_administration": (
            split_index_text(dosage) if isinstance(dosage, str) else text_list(dosage)
        ),
        "usage_text_from_index": row.get("用法用量", ""),
    }


def _normalize_safety(sections: dict[str, Any]) -> dict[str, Any]:
    precautions = sections.get("使用上注意事項", {})
    warnings = sections.get("警語", {})
    if not isinstance(precautions, dict):
        precautions = {"其他使用上注意事項": precautions}
    if not isinstance(warnings, dict):
        warnings = {"警語": warnings}

    electronic_warning = sections.get("警語及注意事項", {})
    general_warnings = (
        text_list(electronic_warning.values())
        if isinstance(electronic_warning, dict)
        else text_list(electronic_warning)
    )

    return {
        "contraindications": text_list(
            precautions.get("有下列情形者，請勿使用") or sections.get("禁忌")
        ),
        "consult_doctor_before_use": text_list(
            precautions.get("有下列情形者，使用前請洽醫師診治")
        ),
        "consult_professional_before_use": text_list(
            precautions.get("有下列情形者，使用前請先諮詢醫師藥師藥劑生")
        ),
        "precautions": text_list(precautions.get("其他使用上注意事項"))
        + general_warnings,
        "warnings": text_list(warnings.get("警語"))
        + text_list(sections.get("警語及注意事項")),
        "side_effects_stop_use": text_list(
            warnings.get(
                "使用本藥後，若有發生以下副作用，請立即停止使用，並持此說明書諮詢醫師藥師藥劑生"
            )
            or sections.get("副作用/不良反應")
        ),
        "symptoms_stop_use_and_seek_care": text_list(
            warnings.get(
                "使用本藥後，若有發生以下症狀時，請立即停止使用，並接受醫師診治"
            )
        ),
    }


def _normalize_storage(sections: dict[str, Any]) -> list[str]:
    storage = sections.get("儲存方式")
    if storage:
        return text_list(storage)
    package_storage = sections.get("包裝及儲存", {})
    if isinstance(package_storage, dict):
        return text_list(
            [
                package_storage.get("儲存條件", ""),
                package_storage.get("儲存注意事項", ""),
            ]
        )
    return []


def _asset_minio_ref(asset: Mapping[str, Any]) -> dict[str, str]:
    bucket = asset.get("bucket") or ""
    object_key = asset.get("object_key") or ""
    uri = asset.get("minio_uri") or ""
    return {"bucket": bucket, "object_key": object_key, "uri": uri}


def _to_date_str(value: Any) -> str:
    """Convert a datetime.date/datetime to ISO string; pass strings through unchanged."""
    if not value:
        return ""
    if isinstance(value, str):
        return value
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _asset_file_ref(
    asset: Mapping[str, Any], *, content_summary: str = ""
) -> dict[str, Any]:
    return {
        "filename": asset.get("normalized_filename")
        or asset.get("source_filename")
        or "",
        "upload_date": _to_date_str(asset.get("upload_date")),
        "source_url": asset.get("source_url") or "",
        "document_type": asset.get("asset_type") or "",
        "content_summary": content_summary,
        "minio": _asset_minio_ref(asset),
    }


def _pick_latest_document(documents: list[dict[str, Any]]) -> dict[str, Any] | None:
    dated = [(parse_date(doc.get("upload_date", "")), doc) for doc in documents]
    dated = [(date_val, doc) for date_val, doc in dated if date_val is not None]
    if dated:
        return max(dated, key=lambda pair: pair[0])[1]
    return documents[-1] if documents else None


def _merge_document_refs(documents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for doc in documents:
        key = doc.get("filename") or doc.get("source_url") or str(len(order))
        if key not in merged:
            merged[key] = dict(doc)
            order.append(key)
            continue
        current = merged[key]
        for field, value in doc.items():
            if value and not current.get(field):
                current[field] = value
        if (
            current.get("document_type") != "insert_pdf"
            and doc.get("document_type") == "insert_pdf"
        ):
            current["document_type"] = "insert_pdf"
    return [merged[key] for key in order]


def _normalize_insert_documents(
    electronic_insert: dict[str, Any] | None,
    insert_assets: list[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    documents: list[dict[str, Any]] = []
    for asset in insert_assets:
        documents.append(
            {
                **_asset_file_ref(asset),
                "is_latest_used_for_analysis": bool(
                    asset.get("is_latest_for_analysis")
                ),
            }
        )
    for key in ("history_pdfs", "public_pdfs", "paper_pdfs"):
        for item in as_list(electronic_insert.get(key) if electronic_insert else []):
            if isinstance(item, dict):
                documents.append(
                    {
                        "filename": item.get("filename") or item.get("label") or "",
                        "upload_date": item.get("date", ""),
                        "source_url": item.get("url", ""),
                        "document_type": "insert_pdf",
                        "is_latest_used_for_analysis": False,
                        "minio": {"bucket": "", "object_key": "", "uri": ""},
                    }
                )
    documents = _merge_document_refs(documents)
    latest = _pick_latest_document(documents)
    if latest and not latest.get("is_latest_used_for_analysis"):
        latest["is_latest_used_for_analysis"] = False
    return documents


def _normalize_label_documents(
    electronic_insert: dict[str, Any] | None,
    label_assets: list[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    documents: list[dict[str, Any]] = []
    for asset in label_assets:
        documents.append(_asset_file_ref(asset))
    for item in as_list(
        electronic_insert.get("label_pdfs") if electronic_insert else []
    ):
        if isinstance(item, dict):
            documents.append(
                {
                    "filename": item.get("filename") or item.get("label") or "",
                    "upload_date": item.get("date", ""),
                    "source_url": item.get("url", ""),
                    "document_type": "label_pdf",
                    "content_summary": "",
                    "minio": {"bucket": "", "object_key": "", "uri": ""},
                }
            )
    return _merge_document_refs(documents)


def _normalize_appearance_records(
    appearance_records: list[Mapping[str, Any]],
) -> dict[str, Any]:
    records: list[dict[str, Any]] = []
    for record in appearance_records:
        raw_json = record.get("raw_json") or {}
        if isinstance(raw_json, str):
            try:
                raw_json = json.loads(raw_json)
            except Exception:
                raw_json = {}
        if not isinstance(raw_json, dict):
            raw_json = {}
        images = []
        for asset in as_list(record.get("images")):
            if isinstance(asset, Mapping):
                images.append(
                    {
                        "filename": asset.get("normalized_filename")
                        or asset.get("source_filename")
                        or "",
                        "source_url": asset.get("source_url") or "",
                        "upload_date": _to_date_str(asset.get("upload_date")),
                        "description": "",
                        "minio": _asset_minio_ref(asset),
                    }
                )
        records.append(
            {
                "shape_id": record.get("shape_id", ""),
                "appearance_no": record.get("appearance_no")
                or raw_json.get("外觀編號", ""),
                "description": record.get("description")
                or raw_json.get("藥品外觀", raw_json.get("外觀", "")),
                "color": record.get("color")
                or " ".join(
                    part
                    for part in [
                        raw_json.get("顏色", ""),
                        raw_json.get("顏色1", ""),
                        raw_json.get("顏色2", ""),
                    ]
                    if part
                ),
                "shape": record.get("shape") or raw_json.get("形狀", ""),
                "scoring": record.get("scoring") or raw_json.get("刻痕", ""),
                "symbol": record.get("symbol") or raw_json.get("符號", ""),
                "size": record.get("size") or raw_json.get("大小", ""),
                "imprint": record.get("imprint")
                or " ".join(
                    part
                    for part in [
                        raw_json.get("標記", ""),
                        raw_json.get("標記1", ""),
                        raw_json.get("標記2", ""),
                    ]
                    if part
                ),
                "images": images,
                "raw_data": raw_json,
            }
        )
    return {"records": records}


def _build_quality(
    record: dict[str, Any],
    *,
    electronic_insert: dict[str, Any] | None,
    analysis: dict[str, Any] | None = None,
) -> dict[str, Any]:
    missing = []
    checks = {
        "drug.chinese_name": record["drug"]["chinese_name"],
        "drug.english_name": record["drug"]["english_name"],
        "ingredients.active": record["ingredients"]["active"],
        "usage.purpose": record["usage"]["purpose"],
        "usage.dosage_and_administration": record["usage"]["dosage_and_administration"],
        "storage": record["storage"],
    }
    for key, value in checks.items():
        if value in ("", [], {}):
            missing.append(key)

    confidence = "high"
    if missing:
        confidence = "medium"
    if not analysis and not electronic_insert:
        confidence = "low"

    notes: list[str] = []
    if not analysis and electronic_insert:
        notes.append(
            "PDF analysis not loaded; canonical record uses electronic insert data."
        )
    if not analysis and not electronic_insert:
        notes.append("Index-only record; enrichment data not loaded.")

    return {
        "missing_fields": missing,
        "conflict_fields": [],
        "confidence": confidence,
        "notes": notes,
    }


def build_drug_record(
    row: Mapping[str, str],
    *,
    electronic_insert: dict[str, Any] | None = None,
    analysis: dict[str, Any] | None = None,
    insert_assets: list[Mapping[str, Any]] | None = None,
    label_assets: list[Mapping[str, Any]] | None = None,
    appearance_records: list[Mapping[str, Any]] | None = None,
    source_errors: list[str] | None = None,
    normalized_at: datetime | None = None,
) -> dict[str, Any]:
    normalized_at = normalized_at or datetime.now(timezone.utc)
    insert_assets = insert_assets or []
    label_assets = label_assets or []
    appearance_records = appearance_records or []
    source_errors = source_errors or []

    source_type, sections = _pick_sections(electronic_insert, analysis)
    basic = (
        electronic_insert.get("basic_info", {})
        if electronic_insert and isinstance(electronic_insert.get("basic_info"), dict)
        else {}
    )
    insert_documents = _normalize_insert_documents(electronic_insert, insert_assets)
    latest_insert = _pick_latest_document(insert_documents)

    record: dict[str, Any] = {
        "license_no": row.get(INDEX_LICENSE, ""),
        "record_status": {
            "is_active": is_active_index_row(row),
            "cancellation_status": row.get(INDEX_CANCEL_STATUS, ""),
            "cancellation_date": row.get(INDEX_CANCEL_DATE, ""),
            "cancellation_reason": row.get("註銷理由", ""),
            "valid_until": row.get("有效日期") or basic.get("有效日期", ""),
            "issue_date": row.get("發證日期") or basic.get("發證日期", ""),
            "last_changed_date": row.get("異動日期", ""),
        },
        "source": {
            "primary_insert_source": source_type,
            "has_electronic_insert": bool(electronic_insert),
            "has_pdf_insert": bool(insert_documents),
            "used_latest_pdf": bool(analysis),
            "latest_pdf_upload_date": (
                latest_insert.get("upload_date", "") if latest_insert else ""
            ),
            "electronic_insert_source_url": (
                electronic_insert.get("source_url", "") if electronic_insert else ""
            ),
            "normalized_at": normalized_at.isoformat(),
            "errors": source_errors,
        },
        "drug": {
            "chinese_name": row.get("中文品名") or basic.get("中文品名", ""),
            "english_name": row.get("英文品名") or basic.get("英文品名", ""),
            "license_type": row.get("許可證種類", ""),
            "old_license_no": row.get("舊證字號", ""),
            "customs_clearance_no": row.get("通關簽審文件編號")
            or basic.get("通關簽審文件編號", ""),
            "drug_category": row.get("藥品類別") or basic.get("藥品類別", ""),
            "controlled_drug_level": row.get("管制藥品分類級別", ""),
            "dosage_form": row.get("劑型") or basic.get("劑型", ""),
            "package": row.get("包裝") or basic.get("包裝", ""),
            "indications": split_index_text(row.get("適應症", "")),
            "atc_codes": (
                electronic_insert.get("atc_codes", []) if electronic_insert else []
            ),
        },
        "companies": _normalize_companies(row, electronic_insert),
        "ingredients": _normalize_ingredients(row, electronic_insert, analysis),
        "usage": _normalize_usage(sections, row),
        "safety": _normalize_safety(sections),
        "storage": _normalize_storage(sections),
        "insert_content": {
            "drug_characteristics": sections.get("藥品特性", ""),
            "full_structured_sections": sections,
            "insert_documents": insert_documents,
        },
        "packaging_and_labeling": {
            "label_documents": _normalize_label_documents(
                electronic_insert, label_assets
            ),
        },
        "appearance": _normalize_appearance_records(appearance_records),
    }
    record["quality"] = _build_quality(
        record, electronic_insert=electronic_insert, analysis=analysis
    )
    return record


def build_index_only_record(
    row: Mapping[str, str],
    normalized_at: datetime | None = None,
) -> dict[str, Any]:
    return build_drug_record(row, normalized_at=normalized_at)
