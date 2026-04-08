"""
Unit tests for Lab / LOINC tool functions in server.py.

Tools covered:
  search_loinc_code, list_lab_categories, get_reference_range,
  interpret_lab_result, search_loinc_by_specimen, find_related_loinc_tests,
  get_loinc_detail, batch_interpret_lab_results
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import server


def _lab_mock():
    m = MagicMock()
    m.search_loinc_code         = AsyncMock(return_value='{"results":[]}')
    m.list_categories           = AsyncMock(return_value='{"categories":[]}')
    m.get_reference_range       = AsyncMock(return_value='{"loinc_num":"2345-7","reference_range":{}}')
    m.interpret_lab_result      = AsyncMock(return_value='{"result":{"flag":"N"}}')
    m.search_by_specimen        = AsyncMock(return_value='{"results":[]}')
    m.find_related_tests        = AsyncMock(return_value='{"by_system":{}}')
    m.get_patient_friendly_name = AsyncMock(return_value='{"loinc_num":"2345-7"}')
    m.batch_interpret_results   = AsyncMock(return_value='{"total_tests":0}')
    return m


# ── search_loinc_code ─────────────────────────────────────────────────────────

class TestSearchLoincCode:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "lab_service", None):
            result = json.loads(await server.search_loinc_code(keyword="glucose"))
        assert "error" in result
        assert "Lab Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_keyword_no_category(self):
        mock_svc = _lab_mock()
        with patch.object(server, "lab_service", mock_svc):
            await server.search_loinc_code(keyword="HbA1c")
        mock_svc.search_loinc_code.assert_called_once_with("HbA1c", None)

    @pytest.mark.asyncio
    async def test_delegates_keyword_with_category(self):
        mock_svc = _lab_mock()
        with patch.object(server, "lab_service", mock_svc):
            await server.search_loinc_code(keyword="glucose", category="CHEM")
        mock_svc.search_loinc_code.assert_called_once_with("glucose", "CHEM")


# ── list_lab_categories ───────────────────────────────────────────────────────

class TestListLabCategories:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "lab_service", None):
            result = json.loads(await server.list_lab_categories())
        assert "error" in result
        assert "Lab Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates(self):
        mock_svc = _lab_mock()
        with patch.object(server, "lab_service", mock_svc):
            await server.list_lab_categories()
        mock_svc.list_categories.assert_called_once()

    @pytest.mark.asyncio
    async def test_returns_service_result(self):
        payload = '{"total_categories":3,"categories":["CHEM","HEM","MICRO"]}'
        mock_svc = _lab_mock()
        mock_svc.list_categories = AsyncMock(return_value=payload)
        with patch.object(server, "lab_service", mock_svc):
            result = await server.list_lab_categories()
        assert result == payload


# ── get_reference_range ───────────────────────────────────────────────────────

class TestGetReferenceRange:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "lab_service", None):
            result = json.loads(await server.get_reference_range(loinc_code="2345-7", age=40))
        assert "error" in result
        assert "Lab Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_with_defaults(self):
        mock_svc = _lab_mock()
        with patch.object(server, "lab_service", mock_svc):
            await server.get_reference_range(loinc_code="2345-7", age=40)
        mock_svc.get_reference_range.assert_called_once_with("2345-7", 40, "all")

    @pytest.mark.asyncio
    async def test_delegates_with_gender(self):
        mock_svc = _lab_mock()
        with patch.object(server, "lab_service", mock_svc):
            await server.get_reference_range(loinc_code="718-7", age=25, gender="F")
        mock_svc.get_reference_range.assert_called_once_with("718-7", 25, "F")


# ── interpret_lab_result ──────────────────────────────────────────────────────

class TestInterpretLabResult:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "lab_service", None):
            result = json.loads(await server.interpret_lab_result(loinc_code="2345-7", value=5.5, age=40))
        assert "error" in result
        assert "Lab Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_all_params(self):
        mock_svc = _lab_mock()
        with patch.object(server, "lab_service", mock_svc):
            await server.interpret_lab_result(loinc_code="2345-7", value=7.2, age=55, gender="M")
        mock_svc.interpret_lab_result.assert_called_once_with("2345-7", 7.2, 55, "M")

    @pytest.mark.asyncio
    async def test_default_gender_is_all(self):
        mock_svc = _lab_mock()
        with patch.object(server, "lab_service", mock_svc):
            await server.interpret_lab_result(loinc_code="2345-7", value=5.5, age=30)
        mock_svc.interpret_lab_result.assert_called_once_with("2345-7", 5.5, 30, "all")


# ── search_loinc_by_specimen ──────────────────────────────────────────────────

class TestSearchLoincBySpecimen:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "lab_service", None):
            result = json.loads(await server.search_loinc_by_specimen(specimen_type="Urine"))
        assert "error" in result
        assert "Lab Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_specimen_type(self):
        mock_svc = _lab_mock()
        with patch.object(server, "lab_service", mock_svc):
            await server.search_loinc_by_specimen(specimen_type="血清/血漿")
        mock_svc.search_by_specimen.assert_called_once_with("血清/血漿")


# ── find_related_loinc_tests ──────────────────────────────────────────────────

class TestFindRelatedLoincTests:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "lab_service", None):
            result = json.loads(await server.find_related_loinc_tests(component="Glucose"))
        assert "error" in result
        assert "Lab Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_component(self):
        mock_svc = _lab_mock()
        with patch.object(server, "lab_service", mock_svc):
            await server.find_related_loinc_tests(component="Creatinine")
        mock_svc.find_related_tests.assert_called_once_with("Creatinine")


# ── get_loinc_detail ──────────────────────────────────────────────────────────

class TestGetLoincDetail:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "lab_service", None):
            result = json.loads(await server.get_loinc_detail(loinc_num="2345-7"))
        assert "error" in result
        assert "Lab Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_loinc_num(self):
        mock_svc = _lab_mock()
        with patch.object(server, "lab_service", mock_svc):
            await server.get_loinc_detail(loinc_num="718-7")
        mock_svc.get_patient_friendly_name.assert_called_once_with("718-7")


# ── batch_interpret_lab_results ───────────────────────────────────────────────

class TestBatchInterpretLabResults:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "lab_service", None):
            result = json.loads(
                await server.batch_interpret_lab_results(
                    results_json='[{"loinc_code":"2345-7","value":5.5}]', age=40
                )
            )
        assert "error" in result
        assert "Lab Service" in result["error"]

    @pytest.mark.asyncio
    async def test_parses_json_and_delegates(self):
        mock_svc = _lab_mock()
        payload = '[{"loinc_code":"2345-7","value":5.5}]'
        with patch.object(server, "lab_service", mock_svc):
            await server.batch_interpret_lab_results(results_json=payload, age=40, gender="M")
        mock_svc.batch_interpret_results.assert_called_once_with(
            [{"loinc_code": "2345-7", "value": 5.5}], 40, "M"
        )

    @pytest.mark.asyncio
    async def test_invalid_json_returns_error(self):
        mock_svc = _lab_mock()
        with patch.object(server, "lab_service", mock_svc):
            result = json.loads(
                await server.batch_interpret_lab_results(
                    results_json="not valid json", age=40
                )
            )
        assert "error" in result
        assert "Invalid JSON" in result["error"]
        mock_svc.batch_interpret_results.assert_not_called()

    @pytest.mark.asyncio
    async def test_default_gender_is_all(self):
        mock_svc = _lab_mock()
        payload = '[{"loinc_code":"2345-7","value":5.5}]'
        with patch.object(server, "lab_service", mock_svc):
            await server.batch_interpret_lab_results(results_json=payload, age=40)
        mock_svc.batch_interpret_results.assert_called_once_with(
            [{"loinc_code": "2345-7", "value": 5.5}], 40, "all"
        )
