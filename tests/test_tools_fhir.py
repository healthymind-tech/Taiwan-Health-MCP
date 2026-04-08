"""
Unit tests for FHIR tool functions in server.py.

Tools covered:
  create_fhir_condition, create_fhir_condition_from_diagnosis, validate_fhir_condition,
  search_medication_fhir, create_fhir_medication, create_fhir_medication_from_drug,
  validate_fhir_medication
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import server


# ── helpers ───────────────────────────────────────────────────────────────────

def _fhir_cond_mock():
    m = MagicMock()
    m.create_condition = AsyncMock(return_value={"resourceType": "Condition", "id": "cond-1"})
    m.create_condition_from_search = AsyncMock(return_value={"resourceType": "Condition"})
    m.validate_condition = MagicMock(return_value={"valid": True, "errors": []})
    m.to_json_string = MagicMock(side_effect=lambda obj, indent=None: json.dumps(obj, ensure_ascii=False))
    return m


def _fhir_med_mock():
    m = MagicMock()
    m.create_medication_from_search = AsyncMock(return_value={"resourceType": "Medication"})
    m.create_medication = AsyncMock(return_value={"resourceType": "Medication", "id": "med-1"})
    m.create_medication_knowledge = AsyncMock(return_value={"resourceType": "MedicationKnowledge"})
    m.validate_medication = MagicMock(return_value={"valid": True, "errors": []})
    m.to_json_string = MagicMock(side_effect=lambda obj, indent=None: json.dumps(obj, ensure_ascii=False))
    return m


# ── create_fhir_condition ─────────────────────────────────────────────────────

class TestCreateFhirCondition:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "fhir_condition_service", None):
            result = json.loads(
                await server.create_fhir_condition(icd_code="E11.9", patient_id="P001")
            )
        assert "error" in result
        assert "FHIR Condition Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_required_params(self):
        mock_svc = _fhir_cond_mock()
        with patch.object(server, "fhir_condition_service", mock_svc):
            await server.create_fhir_condition(icd_code="E11.9", patient_id="P001")
        mock_svc.create_condition.assert_called_once()
        call_kwargs = mock_svc.create_condition.call_args.kwargs
        assert call_kwargs["icd_code"] == "E11.9"
        assert call_kwargs["patient_id"] == "P001"

    @pytest.mark.asyncio
    async def test_delegates_all_optional_params(self):
        mock_svc = _fhir_cond_mock()
        with patch.object(server, "fhir_condition_service", mock_svc):
            await server.create_fhir_condition(
                icd_code="E11.9",
                patient_id="P001",
                clinical_status="resolved",
                verification_status="provisional",
                category="problem-list-item",
                severity="moderate",
                onset_date="2024-01-01",
                recorded_date="2024-01-02T08:00:00+08:00",
                additional_notes="Patient note",
            )
        call_kwargs = mock_svc.create_condition.call_args.kwargs
        assert call_kwargs["clinical_status"] == "resolved"
        assert call_kwargs["severity"] == "moderate"
        assert call_kwargs["onset_date"] == "2024-01-01"
        assert call_kwargs["additional_notes"] == "Patient note"

    @pytest.mark.asyncio
    async def test_calls_to_json_string(self):
        mock_svc = _fhir_cond_mock()
        with patch.object(server, "fhir_condition_service", mock_svc):
            await server.create_fhir_condition(icd_code="E11.9", patient_id="P001")
        mock_svc.to_json_string.assert_called_once()


# ── create_fhir_condition_from_diagnosis ─────────────────────────────────────

class TestCreateFhirConditionFromDiagnosis:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "fhir_condition_service", None):
            result = json.loads(
                await server.create_fhir_condition_from_diagnosis(
                    diagnosis_keyword="Diabetes", patient_id="P001"
                )
            )
        assert "error" in result
        assert "FHIR Condition Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_keyword_and_patient(self):
        mock_svc = _fhir_cond_mock()
        with patch.object(server, "fhir_condition_service", mock_svc):
            await server.create_fhir_condition_from_diagnosis(
                diagnosis_keyword="第二型糖尿病", patient_id="P002"
            )
        mock_svc.create_condition_from_search.assert_called_once()
        call_kwargs = mock_svc.create_condition_from_search.call_args.kwargs
        assert call_kwargs["keyword"] == "第二型糖尿病"
        assert call_kwargs["patient_id"] == "P002"

    @pytest.mark.asyncio
    async def test_default_statuses(self):
        mock_svc = _fhir_cond_mock()
        with patch.object(server, "fhir_condition_service", mock_svc):
            await server.create_fhir_condition_from_diagnosis(
                diagnosis_keyword="hypertension", patient_id="P003"
            )
        call_kwargs = mock_svc.create_condition_from_search.call_args.kwargs
        assert call_kwargs["clinical_status"] == "active"
        assert call_kwargs["verification_status"] == "confirmed"
        assert call_kwargs["severity"] is None


# ── validate_fhir_condition ───────────────────────────────────────────────────

class TestValidateFhirCondition:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "fhir_condition_service", None):
            result = json.loads(
                await server.validate_fhir_condition(condition_json='{"resourceType":"Condition"}')
            )
        assert "error" in result
        assert "FHIR Condition Service" in result["error"]

    @pytest.mark.asyncio
    async def test_parses_json_and_validates(self):
        mock_svc = _fhir_cond_mock()
        condition_dict = {"resourceType": "Condition", "id": "c1"}
        with patch.object(server, "fhir_condition_service", mock_svc):
            await server.validate_fhir_condition(condition_json=json.dumps(condition_dict))
        mock_svc.validate_condition.assert_called_once_with(condition_dict)

    @pytest.mark.asyncio
    async def test_invalid_json_returns_error(self):
        mock_svc = _fhir_cond_mock()
        with patch.object(server, "fhir_condition_service", mock_svc):
            result = json.loads(
                await server.validate_fhir_condition(condition_json="{ bad json }")
            )
        assert result["valid"] is False
        assert any("Invalid JSON" in e for e in result["errors"])
        mock_svc.validate_condition.assert_not_called()


# ── search_medication_fhir ────────────────────────────────────────────────────

class TestSearchMedicationFhir:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "fhir_medication_service", None):
            result = json.loads(await server.search_medication_fhir(keyword="Metformin"))
        assert "error" in result
        assert "FHIR Medication Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_keyword_and_resource_type(self):
        mock_svc = _fhir_med_mock()
        with patch.object(server, "fhir_medication_service", mock_svc):
            await server.search_medication_fhir(keyword="二甲雙胍", resource_type="MedicationKnowledge")
        mock_svc.create_medication_from_search.assert_called_once_with("二甲雙胍", "MedicationKnowledge")

    @pytest.mark.asyncio
    async def test_default_resource_type_is_medication(self):
        mock_svc = _fhir_med_mock()
        with patch.object(server, "fhir_medication_service", mock_svc):
            await server.search_medication_fhir(keyword="aspirin")
        mock_svc.create_medication_from_search.assert_called_once_with("aspirin", "Medication")

    @pytest.mark.asyncio
    async def test_result_is_valid_json(self):
        mock_svc = _fhir_med_mock()
        mock_svc.create_medication_from_search = AsyncMock(
            return_value={"resourceType": "Medication", "id": "med-001"}
        )
        with patch.object(server, "fhir_medication_service", mock_svc):
            result = json.loads(await server.search_medication_fhir(keyword="aspirin"))
        assert result["resourceType"] == "Medication"


# ── create_fhir_medication ────────────────────────────────────────────────────

class TestCreateFhirMedication:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "fhir_medication_service", None):
            result = json.loads(
                await server.create_fhir_medication(license_id="衛部藥製字第058498號")
            )
        assert "error" in result
        assert "FHIR Medication Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_license_id(self):
        mock_svc = _fhir_med_mock()
        with patch.object(server, "fhir_medication_service", mock_svc):
            await server.create_fhir_medication(license_id="衛部藥製字第058498號")
        mock_svc.create_medication.assert_called_once_with("衛部藥製字第058498號")
        mock_svc.to_json_string.assert_called_once()


# ── create_fhir_medication_from_drug (MedicationKnowledge) ───────────────────

class TestCreateFhirMedicationFromDrug:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "fhir_medication_service", None):
            result = json.loads(
                await server.create_fhir_medication_from_drug(license_id="衛部藥製字第058498號")
            )
        assert "error" in result
        assert "FHIR Medication Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_to_medication_knowledge(self):
        mock_svc = _fhir_med_mock()
        with patch.object(server, "fhir_medication_service", mock_svc):
            await server.create_fhir_medication_from_drug(license_id="L123")
        mock_svc.create_medication_knowledge.assert_called_once_with("L123")
        mock_svc.to_json_string.assert_called_once()


# ── validate_fhir_medication ──────────────────────────────────────────────────

class TestValidateFhirMedication:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "fhir_medication_service", None):
            result = json.loads(
                await server.validate_fhir_medication(medication_json='{"resourceType":"Medication"}')
            )
        assert "error" in result
        assert "FHIR Medication Service" in result["error"]

    @pytest.mark.asyncio
    async def test_parses_json_and_validates(self):
        mock_svc = _fhir_med_mock()
        med_dict = {"resourceType": "Medication", "id": "m1"}
        with patch.object(server, "fhir_medication_service", mock_svc):
            await server.validate_fhir_medication(medication_json=json.dumps(med_dict))
        mock_svc.validate_medication.assert_called_once_with(med_dict)

    @pytest.mark.asyncio
    async def test_invalid_json_returns_error(self):
        mock_svc = _fhir_med_mock()
        with patch.object(server, "fhir_medication_service", mock_svc):
            result = json.loads(
                await server.validate_fhir_medication(medication_json="[broken")
            )
        assert result["valid"] is False
        assert any("Invalid JSON" in e for e in result["errors"])
        mock_svc.validate_medication.assert_not_called()
