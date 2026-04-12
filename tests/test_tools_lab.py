"""
Unit tests for Lab / LOINC tool functions in server.py.

Tools covered:
  search_loinc, query_loinc, interpret_lab_result, batch_interpret_lab_results
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import server


def _lab_mock():
    m = MagicMock()
    m.search_loinc_code = AsyncMock(return_value='{"results":[]}')
    m.list_categories = AsyncMock(return_value='{"categories":[]}')
    m.get_reference_range = AsyncMock(
        return_value='{"loinc_num":"2345-7","reference_range":{}}'
    )
    m.interpret_lab_result = AsyncMock(return_value='{"result":{"flag":"N"}}')
    m.search_by_specimen = AsyncMock(return_value='{"results":[]}')
    m.find_related_tests = AsyncMock(return_value='{"by_system":{}}')
    m.get_patient_friendly_name = AsyncMock(return_value='{"loinc_num":"2345-7"}')
    m.batch_interpret_results = AsyncMock(return_value='{"total_tests":0}')
    return m


# -- search_loinc --------------------------------------------------------------


class TestSearchLoinc:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "lab_service", None):
            result = json.loads(await server.search_loinc(mode="code", keyword="glucose"))
        assert "error" in result
        assert "Lab Service" in result["error"]

    @pytest.mark.asyncio
    async def test_code_mode_default_limit(self):
        mock_svc = _lab_mock()
        with patch.object(server, "lab_service", mock_svc):
            await server.search_loinc(mode="code", keyword="HbA1c")
        mock_svc.search_loinc_code.assert_called_once_with("HbA1c", None, limit=3)

    @pytest.mark.asyncio
    async def test_code_mode_with_category_and_limit(self):
        mock_svc = _lab_mock()
        with patch.object(server, "lab_service", mock_svc):
            await server.search_loinc(
                mode="code", keyword="glucose", category="CHEM", limit=5
            )
        mock_svc.search_loinc_code.assert_called_once_with("glucose", "CHEM", limit=5)

    @pytest.mark.asyncio
    async def test_category_mode_calls_list_categories(self):
        mock_svc = _lab_mock()
        with patch.object(server, "lab_service", mock_svc):
            await server.search_loinc(mode="category")
        mock_svc.list_categories.assert_called_once()

    @pytest.mark.asyncio
    async def test_category_mode_with_keyword_filters_categories(self):
        payload = '{"categories":["CHEM","HEM/BC","SERO"]}'
        mock_svc = _lab_mock()
        mock_svc.list_categories = AsyncMock(return_value=payload)
        with patch.object(server, "lab_service", mock_svc):
            result = json.loads(await server.search_loinc(mode="category", keyword="he"))
        assert result["mode"] == "category"
        assert result["categories"] == ["CHEM", "HEM/BC"]

    @pytest.mark.asyncio
    async def test_specimen_mode_delegates(self):
        mock_svc = _lab_mock()
        with patch.object(server, "lab_service", mock_svc):
            await server.search_loinc(mode="specimen", keyword="Urine", limit=7)
        mock_svc.search_by_specimen.assert_called_once_with("Urine", limit=7)

    @pytest.mark.asyncio
    async def test_component_mode_delegates(self):
        mock_svc = _lab_mock()
        with patch.object(server, "lab_service", mock_svc):
            await server.search_loinc(mode="component", keyword="Glucose", limit=6)
        mock_svc.find_related_tests.assert_called_once_with("Glucose", limit=6)

    @pytest.mark.asyncio
    async def test_non_category_requires_keyword(self):
        mock_svc = _lab_mock()
        with patch.object(server, "lab_service", mock_svc):
            result = json.loads(await server.search_loinc(mode="code", keyword=""))
        assert result["mode"] == "code"
        assert "error" in result

    @pytest.mark.asyncio
    async def test_unsupported_mode(self):
        mock_svc = _lab_mock()
        with patch.object(server, "lab_service", mock_svc):
            result = json.loads(
                await server.search_loinc(mode="not_a_mode", keyword="x")  # type: ignore[arg-type]
            )
        assert "error" in result
        assert "Unsupported mode" in result["error"]


# -- query_loinc ---------------------------------------------------------------


class TestQueryLoinc:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "lab_service", None):
            result = json.loads(await server.query_loinc(mode="detail", loinc_code="2345-7"))
        assert "error" in result
        assert "Lab Service" in result["error"]

    @pytest.mark.asyncio
    async def test_requires_loinc_code(self):
        mock_svc = _lab_mock()
        with patch.object(server, "lab_service", mock_svc):
            result = json.loads(await server.query_loinc(mode="detail", loinc_code=""))
        assert "error" in result
        assert "loinc_code is required" in result["error"]

    @pytest.mark.asyncio
    async def test_detail_mode_delegates(self):
        mock_svc = _lab_mock()
        with patch.object(server, "lab_service", mock_svc):
            await server.query_loinc(mode="detail", loinc_code="2345-7")
        mock_svc.get_patient_friendly_name.assert_called_once_with("2345-7")

    @pytest.mark.asyncio
    async def test_reference_range_mode_requires_age(self):
        mock_svc = _lab_mock()
        with patch.object(server, "lab_service", mock_svc):
            result = json.loads(
                await server.query_loinc(mode="reference_range", loinc_code="2345-7")
            )
        assert "error" in result
        assert "age is required" in result["error"]

    @pytest.mark.asyncio
    async def test_reference_range_mode_delegates(self):
        mock_svc = _lab_mock()
        with patch.object(server, "lab_service", mock_svc):
            await server.query_loinc(
                mode="reference_range", loinc_code="2345-7", age=45, gender="M"
            )
        mock_svc.get_reference_range.assert_called_once_with("2345-7", 45, "M")

    @pytest.mark.asyncio
    async def test_unsupported_mode(self):
        mock_svc = _lab_mock()
        with patch.object(server, "lab_service", mock_svc):
            result = json.loads(
                await server.query_loinc(mode="xxx", loinc_code="2345-7")  # type: ignore[arg-type]
            )
        assert "error" in result
        assert "Unsupported mode" in result["error"]


# -- interpret_lab_result ------------------------------------------------------


class TestInterpretLabResult:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "lab_service", None):
            result = json.loads(
                await server.interpret_lab_result(
                    loinc_code="2345-7", value=5.5, age=40
                )
            )
        assert "error" in result
        assert "Lab Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_all_params(self):
        mock_svc = _lab_mock()
        with patch.object(server, "lab_service", mock_svc):
            await server.interpret_lab_result(
                loinc_code="2345-7", value=7.2, age=55, gender="M"
            )
        mock_svc.interpret_lab_result.assert_called_once_with("2345-7", 7.2, 55, "M")

    @pytest.mark.asyncio
    async def test_default_gender_is_all(self):
        mock_svc = _lab_mock()
        with patch.object(server, "lab_service", mock_svc):
            await server.interpret_lab_result(loinc_code="2345-7", value=5.5, age=30)
        mock_svc.interpret_lab_result.assert_called_once_with("2345-7", 5.5, 30, "all")


# -- batch_interpret_lab_results ----------------------------------------------


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
            await server.batch_interpret_lab_results(
                results_json=payload, age=40, gender="M"
            )
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

    @pytest.mark.asyncio
    async def test_multiple_results_parsed_correctly(self):
        mock_svc = _lab_mock()
        results = [
            {"loinc_code": "1558-6", "value": 126},
            {"loinc_code": "4548-4", "value": 7.2},
            {"loinc_code": "718-7", "value": 13.5},
        ]
        with patch.object(server, "lab_service", mock_svc):
            await server.batch_interpret_lab_results(
                results_json=json.dumps(results), age=55, gender="F"
            )
        mock_svc.batch_interpret_results.assert_called_once_with(results, 55, "F")
