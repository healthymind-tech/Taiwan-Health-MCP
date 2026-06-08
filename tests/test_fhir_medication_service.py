import json
import os
import sys
from unittest.mock import AsyncMock, MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))


def _make_conn(fetch_return=None, fetchrow_return=None):
    conn = AsyncMock()
    conn.fetch = AsyncMock(return_value=fetch_return or [])
    conn.fetchrow = AsyncMock(return_value=fetchrow_return)
    return conn


def _make_pool(conn):
    pool = MagicMock()
    pool.acquire.return_value.__aenter__ = AsyncMock(return_value=conn)
    pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)
    return pool


def _normalized_record():
    return {
        "license_no": "衛署藥製字第000480號",
        "record_status": {"is_active": True},
        "source": {"primary_insert_source": "pdf_insert"},
        "drug": {
            "chinese_name": "測試藥品",
            "english_name": "Test Drug",
            "license_type": "製劑",
            "drug_category": "醫師藥師藥劑生指示藥品",
            "dosage_form": "錠劑",
            "package": "盒裝",
            "indications": ["退燒", "止痛"],
        },
        "companies": {
            "applicant": {"name": "申請商A", "address": "台北市", "tax_id": "12345678"},
            "manufacturers": [
                {
                    "name": "製造商B",
                    "country": "TW",
                    "process": "委託製造",
                }
            ],
        },
        "ingredients": {
            "active": [{"name": "Acetaminophen", "amount": "500 mg"}],
            "inactive": [{"name": "Lactose", "amount": "10 mg"}],
        },
        "usage": {"purpose": ["退燒", "止痛"]},
        "insert_content": {
            "insert_documents": [
                {
                    "filename": "insert-1.pdf",
                    "source_url": "https://example.com/insert-1.pdf",
                    "minio": {"uri": "minio://bucket/drug/L001/insert/1.pdf"},
                }
            ]
        },
        "packaging_and_labeling": {
            "label_documents": [
                {
                    "filename": "label-1.pdf",
                    "source_url": "https://example.com/label-1.pdf",
                    "minio": {"uri": "minio://bucket/drug/L001/label/1.pdf"},
                }
            ]
        },
        "appearance": {
            "records": [
                {
                    "description": "白色圓形錠",
                    "color": "白色",
                    "shape": "圓形",
                    "imprint": "A1",
                    "size": "10 mm",
                }
            ]
        },
        "quality": {"confidence": "high"},
    }


class TestFHIRMedicationService:
    @pytest.mark.asyncio
    async def test_create_medication_from_license(self):
        from fhir_medication_service import FHIRMedicationService

        conn = _make_conn(
            fetchrow_return={
                "license_id": "衛署藥製字第000480號",
                "is_active": True,
                "cancellation_status": "",
                "normalized_json": _normalized_record(),
            }
        )
        pool = _make_pool(conn)
        svc = FHIRMedicationService(pool)

        result = await svc.create_medication("000480")

        assert result["resourceType"] == "Medication"
        assert result["identifier"][0]["value"] == "衛署藥製字第000480號"
        assert result["doseForm"]["text"] == "錠劑"
        assert result["ingredient"][0]["itemCodeableConcept"]["text"] == "Acetaminophen"
        assert result["ingredient"][0]["strength"]["numerator"]["value"] == 500.0

    @pytest.mark.asyncio
    async def test_create_medicationknowledge_includes_monograph_and_characteristics(self):
        from fhir_medication_service import FHIRMedicationService

        conn = _make_conn(
            fetchrow_return={
                "license_id": "衛署藥製字第000480號",
                "is_active": True,
                "cancellation_status": "",
                "normalized_json": _normalized_record(),
            }
        )
        pool = _make_pool(conn)
        svc = FHIRMedicationService(pool)

        result = await svc.create_medication(
            "衛署藥製字第000480號", resource_type="MedicationKnowledge"
        )

        assert result["resourceType"] == "MedicationKnowledge"
        assert result["associatedMedication"][0]["reference"].startswith("Medication/")
        assert len(result["monograph"]) == 2
        assert any(item["type"]["text"] == "color" for item in result["drugCharacteristic"])

    @pytest.mark.asyncio
    async def test_create_from_search_returns_selected_record(self):
        from fhir_medication_service import FHIRMedicationService

        conn = _make_conn(
            fetch_return=[
                {
                    "license_id": "衛署藥製字第000480號",
                    "is_active": True,
                    "cancellation_status": "",
                    "normalized_json": _normalized_record(),
                    "match_rank": 0,
                }
            ]
        )
        pool = _make_pool(conn)
        svc = FHIRMedicationService(pool)

        result = await svc.create_medication_from_search("測試藥品")

        assert result["selected_license_id"] == "衛署藥製字第000480號"
        assert result["fhir_medication"]["resourceType"] == "Medication"
        assert result["search_results"][0]["name_zh"] == "測試藥品"

    def test_validate_medication_rejects_missing_code(self):
        from fhir_medication_service import FHIRMedicationService

        svc = FHIRMedicationService(MagicMock())

        result = svc.validate_medication({"resourceType": "Medication", "ingredient": []})

        assert result["valid"] is False
        assert any("code.coding" in error for error in result["errors"])
