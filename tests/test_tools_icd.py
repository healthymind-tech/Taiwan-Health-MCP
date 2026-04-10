"""
Unit tests for ICD-10 tool functions in server.py.

Tools covered:
  search_medical_codes, infer_complications, get_nearby_codes,
  check_medical_conflict, browse_icd_category
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import server


# ── helpers ───────────────────────────────────────────────────────────────────

def _icd_mock():
    m = MagicMock()
    m.search_codes        = AsyncMock(return_value='{"diagnoses":[]}')
    m.infer_complications = AsyncMock(return_value='{"base_code":"E11","potential_complications_or_specifics":[]}')
    m.get_nearby_codes    = AsyncMock(return_value='{"target":"I10","nearby_options":[]}')
    m.get_conflict_info   = AsyncMock(return_value='{"diagnosis":{},"procedure":{}}')
    m.browse_category     = AsyncMock(return_value='{"categories":[]}')
    return m


# ── search_medical_codes ──────────────────────────────────────────────────────

class TestSearchMedicalCodes:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "icd_service", None):
            result = json.loads(await server.search_medical_codes(keyword="diabetes"))
        assert "error" in result
        assert "ICD Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_keyword_and_type_with_default_limit(self):
        mock_svc = _icd_mock()
        with patch.object(server, "icd_service", mock_svc):
            await server.search_medical_codes(keyword="E11", type="diagnosis")
        mock_svc.search_codes.assert_called_once_with("E11", "diagnosis", limit=3)

    @pytest.mark.asyncio
    async def test_default_type_is_all(self):
        mock_svc = _icd_mock()
        with patch.object(server, "icd_service", mock_svc):
            await server.search_medical_codes(keyword="fracture")
        mock_svc.search_codes.assert_called_once_with("fracture", "all", limit=3)

    @pytest.mark.asyncio
    async def test_custom_limit_is_forwarded(self):
        mock_svc = _icd_mock()
        with patch.object(server, "icd_service", mock_svc):
            await server.search_medical_codes(keyword="diabetes", limit=7)
        mock_svc.search_codes.assert_called_once_with("diabetes", "all", limit=7)

    @pytest.mark.asyncio
    async def test_returns_service_result_verbatim(self):
        payload = '{"diagnoses":[{"code":"E11.9","name_zh":"第2型糖尿病"}]}'
        mock_svc = _icd_mock()
        mock_svc.search_codes = AsyncMock(return_value=payload)
        with patch.object(server, "icd_service", mock_svc):
            result = await server.search_medical_codes(keyword="糖尿病")
        assert result == payload


# ── infer_complications ───────────────────────────────────────────────────────

class TestInferComplications:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "icd_service", None):
            result = json.loads(await server.infer_complications(code="E11"))
        assert "error" in result
        assert "ICD Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_code(self):
        mock_svc = _icd_mock()
        with patch.object(server, "icd_service", mock_svc):
            await server.infer_complications(code="N80")
        mock_svc.infer_complications.assert_called_once_with("N80")

    @pytest.mark.asyncio
    async def test_returns_child_codes_when_available(self):
        payload = '{"base_code":"N80","potential_complications_or_specifics":[{"code":"N80.1","name_zh":"卵巢子宮內膜異位"}]}'
        mock_svc = _icd_mock()
        mock_svc.infer_complications = AsyncMock(return_value=payload)
        with patch.object(server, "icd_service", mock_svc):
            result = await server.infer_complications(code="N80")
        assert result == payload

    @pytest.mark.asyncio
    async def test_returns_sibling_codes_when_no_children(self):
        """When a leaf code has no children the service returns related_codes (siblings)."""
        payload = '{"base_code":"N80.1","related_codes":[{"code":"N80.0"},{"code":"N80.2"}]}'
        mock_svc = _icd_mock()
        mock_svc.infer_complications = AsyncMock(return_value=payload)
        with patch.object(server, "icd_service", mock_svc):
            result = json.loads(await server.infer_complications(code="N80.1"))
        assert "related_codes" in result
        assert result["base_code"] == "N80.1"


# ── get_nearby_codes ──────────────────────────────────────────────────────────

class TestGetNearbyCodes:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "icd_service", None):
            result = json.loads(await server.get_nearby_codes(code="I10"))
        assert "error" in result
        assert "ICD Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_code(self):
        mock_svc = _icd_mock()
        with patch.object(server, "icd_service", mock_svc):
            await server.get_nearby_codes(code="I10")
        mock_svc.get_nearby_codes.assert_called_once_with("I10")

    @pytest.mark.asyncio
    async def test_response_contains_target_and_nearby(self):
        """Response includes target code and up to 4 neighbouring codes."""
        payload = json.dumps({
            "target": "I10",
            "nearby_options": [
                {"code": "I09.9", "rel": "prev"},
                {"code": "I09.81", "rel": "prev"},
                {"code": "I10.1", "rel": "next"},
                {"code": "I11", "rel": "next"},
            ],
        })
        mock_svc = _icd_mock()
        mock_svc.get_nearby_codes = AsyncMock(return_value=payload)
        with patch.object(server, "icd_service", mock_svc):
            result = json.loads(await server.get_nearby_codes(code="I10"))
        assert result["target"] == "I10"
        assert len(result["nearby_options"]) == 4


# ── check_medical_conflict ────────────────────────────────────────────────────

class TestCheckMedicalConflict:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "icd_service", None):
            result = json.loads(
                await server.check_medical_conflict(diagnosis_code="K35.80", procedure_code="0DTJ0ZZ")
            )
        assert "error" in result
        assert "ICD Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_both_codes(self):
        mock_svc = _icd_mock()
        with patch.object(server, "icd_service", mock_svc):
            await server.check_medical_conflict(diagnosis_code="K35.80", procedure_code="0DTJ0ZZ")
        mock_svc.get_conflict_info.assert_called_once_with("K35.80", "0DTJ0ZZ")


# ── browse_icd_category ───────────────────────────────────────────────────────

class TestBrowseIcdCategory:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "icd_service", None):
            result = json.loads(await server.browse_icd_category())
        assert "error" in result
        assert "ICD Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_with_defaults(self):
        mock_svc = _icd_mock()
        with patch.object(server, "icd_service", mock_svc):
            await server.browse_icd_category()
        mock_svc.browse_category.assert_called_once_with(None, 50)

    @pytest.mark.asyncio
    async def test_delegates_with_category_and_limit(self):
        mock_svc = _icd_mock()
        with patch.object(server, "icd_service", mock_svc):
            await server.browse_icd_category(category="E11", limit=100)
        mock_svc.browse_category.assert_called_once_with("E11", 100)

    @pytest.mark.asyncio
    async def test_no_category_lists_all_chapters(self):
        payload = '{"total_categories":1000,"categories":[]}'
        mock_svc = _icd_mock()
        mock_svc.browse_category = AsyncMock(return_value=payload)
        with patch.object(server, "icd_service", mock_svc):
            result = json.loads(await server.browse_icd_category())
        assert "total_categories" in result
