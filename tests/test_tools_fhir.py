"""
Unit tests for FHIR Condition tools in server.py.
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import server


def _fhir_cond_mock():
    mock = MagicMock()
    mock.create_condition = AsyncMock(
        return_value={"resourceType": "Condition", "id": "cond-1"}
    )
    mock.create_condition_from_search = AsyncMock(
        return_value={"resourceType": "Condition"}
    )
    mock.validate_condition = MagicMock(return_value={"valid": True, "errors": []})
    mock.to_json_string = MagicMock(
        side_effect=lambda obj, indent=None: json.dumps(obj, ensure_ascii=False)
    )
    return mock


def _fhir_med_mock():
    mock = MagicMock()
    mock.create_medication = AsyncMock(
        return_value={"resourceType": "Medication", "id": "med-1"}
    )
    mock.create_medication_from_search = AsyncMock(
        return_value={"resourceType": "MedicationKnowledge"}
    )
    mock.validate_medication = MagicMock(return_value={"valid": True, "errors": []})
    mock.to_json_string = MagicMock(
        side_effect=lambda obj, indent=None: json.dumps(obj, ensure_ascii=False)
    )
    return mock


class TestQueryFhirCondition:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "fhir_condition_service", None):
            result = json.loads(
                await server.query_fhir_condition(icd_code="E11.9", patient_id="P001")
            )
        assert "error" in result
        assert "FHIR Condition Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_required_params(self):
        mock_svc = _fhir_cond_mock()
        with patch.object(server, "fhir_condition_service", mock_svc):
            await server.query_fhir_condition(icd_code="E11.9", patient_id="P001")
        mock_svc.create_condition.assert_called_once()
        call_kwargs = mock_svc.create_condition.call_args.kwargs
        assert call_kwargs["icd_code"] == "E11.9"
        assert call_kwargs["patient_id"] == "P001"

    @pytest.mark.asyncio
    async def test_delegates_all_optional_params(self):
        mock_svc = _fhir_cond_mock()
        with patch.object(server, "fhir_condition_service", mock_svc):
            await server.query_fhir_condition(
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
    async def test_keyword_search_path(self):
        mock_svc = _fhir_cond_mock()
        with patch.object(server, "fhir_condition_service", mock_svc):
            await server.query_fhir_condition(
                diagnosis_keyword="第二型糖尿病", patient_id="P002"
            )
        mock_svc.create_condition_from_search.assert_called_once()
        call_kwargs = mock_svc.create_condition_from_search.call_args.kwargs
        assert call_kwargs["keyword"] == "第二型糖尿病"
        assert call_kwargs["patient_id"] == "P002"

    @pytest.mark.asyncio
    async def test_neither_icd_nor_keyword_returns_error(self):
        mock_svc = _fhir_cond_mock()
        with patch.object(server, "fhir_condition_service", mock_svc):
            result = json.loads(await server.query_fhir_condition())
        assert "error" in result
        mock_svc.create_condition.assert_not_called()
        mock_svc.create_condition_from_search.assert_not_called()


class TestValidateFhirCondition:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "fhir_condition_service", None):
            result = json.loads(
                await server.validate_fhir_condition(
                    condition_json='{"resourceType":"Condition"}'
                )
            )
        assert "error" in result
        assert "FHIR Condition Service" in result["error"]

    @pytest.mark.asyncio
    async def test_parses_json_and_validates(self):
        mock_svc = _fhir_cond_mock()
        condition_dict = {"resourceType": "Condition", "id": "c1"}
        with patch.object(server, "fhir_condition_service", mock_svc):
            await server.validate_fhir_condition(
                condition_json=json.dumps(condition_dict)
            )
        mock_svc.validate_condition.assert_called_once_with(condition_dict)

    @pytest.mark.asyncio
    async def test_invalid_json_returns_error(self):
        mock_svc = _fhir_cond_mock()
        with patch.object(server, "fhir_condition_service", mock_svc):
            result = json.loads(
                await server.validate_fhir_condition(condition_json="{ bad json }")
            )
        assert result["valid"] is False
        assert any("Invalid JSON" in error for error in result["errors"])
        mock_svc.validate_condition.assert_not_called()

    @pytest.mark.asyncio
    async def test_valid_complete_condition_passes(self):
        valid_condition = {
            "resourceType": "Condition",
            "subject": {"reference": "Patient/001"},
            "code": {
                "coding": [
                    {
                        "system": "http://hl7.org/fhir/sid/icd-10-cm",
                        "code": "E11.9",
                    }
                ]
            },
            "clinicalStatus": {
                "coding": [
                    {
                        "system": "http://terminology.hl7.org/CodeSystem/condition-clinical",
                        "code": "active",
                    }
                ]
            },
        }
        mock_svc = _fhir_cond_mock()
        mock_svc.validate_condition = MagicMock(
            return_value={"valid": True, "errors": []}
        )
        with patch.object(server, "fhir_condition_service", mock_svc):
            result = json.loads(
                await server.validate_fhir_condition(
                    condition_json=json.dumps(valid_condition)
                )
            )
        assert result["valid"] is True
        assert result["errors"] == []


class TestQueryFhirMedication:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "fhir_medication_service", None):
            result = json.loads(
                await server.query_fhir_medication(
                    license_id="衛署藥製字第000480號", resource_type="Medication"
                )
            )
        assert "error" in result
        assert "FHIR Medication Service" in result["error"]

    @pytest.mark.asyncio
    async def test_license_path_delegates(self):
        mock_svc = _fhir_med_mock()
        with patch.object(server, "fhir_medication_service", mock_svc):
            await server.query_fhir_medication(
                license_id="000480", resource_type="MedicationKnowledge"
            )
        mock_svc.create_medication.assert_called_once()
        kwargs = mock_svc.create_medication.call_args.kwargs
        assert kwargs["license_id"] == "000480"
        assert kwargs["resource_type"] == "MedicationKnowledge"

    @pytest.mark.asyncio
    async def test_keyword_path_delegates(self):
        mock_svc = _fhir_med_mock()
        with patch.object(server, "fhir_medication_service", mock_svc):
            await server.query_fhir_medication(keyword="普拿疼")
        mock_svc.create_medication_from_search.assert_called_once()
        kwargs = mock_svc.create_medication_from_search.call_args.kwargs
        assert kwargs["keyword"] == "普拿疼"

    @pytest.mark.asyncio
    async def test_missing_inputs_returns_error(self):
        mock_svc = _fhir_med_mock()
        with patch.object(server, "fhir_medication_service", mock_svc):
            result = json.loads(await server.query_fhir_medication())
        assert "error" in result
        mock_svc.create_medication.assert_not_called()
        mock_svc.create_medication_from_search.assert_not_called()


class TestValidateFhirMedication:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "fhir_medication_service", None):
            result = json.loads(
                await server.validate_fhir_medication(
                    medication_json='{"resourceType":"Medication"}'
                )
            )
        assert "error" in result
        assert "FHIR Medication Service" in result["error"]

    @pytest.mark.asyncio
    async def test_parses_json_and_validates(self):
        mock_svc = _fhir_med_mock()
        medication_dict = {"resourceType": "Medication", "id": "m1"}
        with patch.object(server, "fhir_medication_service", mock_svc):
            await server.validate_fhir_medication(
                medication_json=json.dumps(medication_dict)
            )
        mock_svc.validate_medication.assert_called_once_with(medication_dict)

    @pytest.mark.asyncio
    async def test_invalid_json_returns_error(self):
        mock_svc = _fhir_med_mock()
        with patch.object(server, "fhir_medication_service", mock_svc):
            result = json.loads(
                await server.validate_fhir_medication(medication_json="{ bad json }")
            )
        assert result["valid"] is False
        assert any("Invalid JSON" in error for error in result["errors"])
        mock_svc.validate_medication.assert_not_called()
