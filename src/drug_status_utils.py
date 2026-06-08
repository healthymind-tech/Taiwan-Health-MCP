"""Helpers for presenting Drug pipeline status consistently."""

from __future__ import annotations

from typing import Any, Mapping

STATUS_FIELDS = (
    "index_status",
    "electronic_insert_status",
    "insert_pdf_status",
    "label_pdf_status",
    "shape_status",
    "storage_status",
    "ocr_status",
    "analysis_status",
    "normalize_status",
)

INACTIVE_NO_DATA_FIELDS = (
    "electronic_insert_status",
    "insert_pdf_status",
    "label_pdf_status",
    "shape_status",
    "storage_status",
    "ocr_status",
    "analysis_status",
)


def display_drug_statuses(
    raw: Mapping[str, Any],
    *,
    is_active: bool,
    has_normalized_record: bool = False,
) -> dict[str, str]:
    """Return status values suitable for admin display.

    Index import creates a normalized JSON record immediately. Some records are
    inactive/cancelled and are intentionally skipped by enrichment/OCR/analysis;
    their downstream stages should read as ``no_data`` instead of looking like
    unfinished ``pending`` work.
    """

    def _get(field: str) -> Any:
        getter = getattr(raw, "get", None)
        if callable(getter):
            return getter(field)
        try:
            return raw[field]
        except Exception:
            return None

    statuses = {field: str(_get(field) or "pending") for field in STATUS_FIELDS}
    if has_normalized_record and statuses["normalize_status"] == "pending":
        statuses["normalize_status"] = "success"
    if not is_active:
        for field in INACTIVE_NO_DATA_FIELDS:
            if statuses[field] == "pending":
                statuses[field] = "no_data"
    return statuses
