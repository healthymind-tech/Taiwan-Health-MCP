"""
Unit tests for Drug tool functions in server.py.

Tools covered:
  search_drug_info, get_drug_details, identify_unknown_pill,
  search_drug_by_atc, search_drug_by_ingredient
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import server


def _drug_mock():
    m = MagicMock()
    m.search_drug                 = AsyncMock(return_value='{"results":[]}')
    m.get_drug_details_by_license = AsyncMock(return_value='{"license_id":"L001"}')
    m.identify_pill               = AsyncMock(return_value='{"matches":[]}')
    m.search_by_atc               = AsyncMock(return_value='{"results":[]}')
    m.search_by_ingredient        = AsyncMock(return_value='{"results":[]}')
    return m


# ── search_drug_info ──────────────────────────────────────────────────────────

class TestSearchDrugInfo:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "drug_service", None):
            result = json.loads(await server.search_drug_info(keyword="aspirin"))
        assert "error" in result
        assert "Drug Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_keyword_with_default_limit(self):
        mock_svc = _drug_mock()
        with patch.object(server, "drug_service", mock_svc):
            await server.search_drug_info(keyword="普拿疼")
        mock_svc.search_drug.assert_called_once_with("普拿疼", limit=3)

    @pytest.mark.asyncio
    async def test_custom_limit_forwarded(self):
        mock_svc = _drug_mock()
        with patch.object(server, "drug_service", mock_svc):
            await server.search_drug_info(keyword="aspirin", limit=5)
        mock_svc.search_drug.assert_called_once_with("aspirin", limit=5)

    @pytest.mark.asyncio
    async def test_returns_service_result(self):
        payload = '{"results":[{"name_zh":"普拿疼","license_id":"L001"}]}'
        mock_svc = _drug_mock()
        mock_svc.search_drug = AsyncMock(return_value=payload)
        with patch.object(server, "drug_service", mock_svc):
            result = await server.search_drug_info(keyword="普拿疼")
        assert result == payload


# ── get_drug_details ──────────────────────────────────────────────────────────

class TestGetDrugDetails:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "drug_service", None):
            result = json.loads(await server.get_drug_details(license_id="衛部藥製字第058498號"))
        assert "error" in result
        assert "Drug Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_license_id(self):
        mock_svc = _drug_mock()
        with patch.object(server, "drug_service", mock_svc):
            await server.get_drug_details(license_id="衛部藥製字第058498號")
        mock_svc.get_drug_details_by_license.assert_called_once_with("衛部藥製字第058498號")

    @pytest.mark.asyncio
    async def test_accepts_partial_license_id(self):
        """Fuzzy lookup: bare numbers and partial IDs are forwarded to the service."""
        mock_svc = _drug_mock()
        with patch.object(server, "drug_service", mock_svc):
            await server.get_drug_details(license_id="058498")
        mock_svc.get_drug_details_by_license.assert_called_once_with("058498")


# ── identify_unknown_pill ─────────────────────────────────────────────────────

class TestIdentifyUnknownPill:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "drug_service", None):
            result = json.loads(await server.identify_unknown_pill(features="white oval YP"))
        assert "error" in result
        assert "Drug Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_features(self):
        mock_svc = _drug_mock()
        with patch.object(server, "drug_service", mock_svc):
            await server.identify_unknown_pill(features="white oval YP")
        mock_svc.identify_pill.assert_called_once_with("white oval YP")

    @pytest.mark.asyncio
    async def test_multiple_keywords_forwarded_as_one_string(self):
        """Space-separated keywords are passed as a single features string (AND logic)."""
        mock_svc = _drug_mock()
        with patch.object(server, "drug_service", mock_svc):
            await server.identify_unknown_pill(features="粉紅 菱形 PFIZER")
        mock_svc.identify_pill.assert_called_once_with("粉紅 菱形 PFIZER")

    @pytest.mark.asyncio
    async def test_returns_matches_from_service(self):
        payload = '{"matches":[{"name_zh":"藥品A","marking":"YP"}]}'
        mock_svc = _drug_mock()
        mock_svc.identify_pill = AsyncMock(return_value=payload)
        with patch.object(server, "drug_service", mock_svc):
            result = await server.identify_unknown_pill(features="YP")
        assert result == payload


# ── search_drug_by_atc ────────────────────────────────────────────────────────

class TestSearchDrugByAtc:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "drug_service", None):
            result = json.loads(await server.search_drug_by_atc(query="A10"))
        assert "error" in result
        assert "Drug Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_atc_code_with_default_limit(self):
        mock_svc = _drug_mock()
        with patch.object(server, "drug_service", mock_svc):
            await server.search_drug_by_atc(query="C09")
        mock_svc.search_by_atc.assert_called_once_with("C09", limit=3)

    @pytest.mark.asyncio
    async def test_delegates_class_name_query_with_default_limit(self):
        mock_svc = _drug_mock()
        with patch.object(server, "drug_service", mock_svc):
            await server.search_drug_by_atc(query="metformin")
        mock_svc.search_by_atc.assert_called_once_with("metformin", limit=3)

    @pytest.mark.asyncio
    async def test_custom_limit_forwarded(self):
        mock_svc = _drug_mock()
        with patch.object(server, "drug_service", mock_svc):
            await server.search_drug_by_atc(query="A10", limit=8)
        mock_svc.search_by_atc.assert_called_once_with("A10", limit=8)


# ── search_drug_by_ingredient ─────────────────────────────────────────────────

class TestSearchDrugByIngredient:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "drug_service", None):
            result = json.loads(await server.search_drug_by_ingredient(ingredient_name="aspirin"))
        assert "error" in result
        assert "Drug Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_ingredient_name_with_default_limit(self):
        mock_svc = _drug_mock()
        with patch.object(server, "drug_service", mock_svc):
            await server.search_drug_by_ingredient(ingredient_name="阿斯匹林")
        mock_svc.search_by_ingredient.assert_called_once_with("阿斯匹林", limit=3)

    @pytest.mark.asyncio
    async def test_custom_limit_forwarded(self):
        mock_svc = _drug_mock()
        with patch.object(server, "drug_service", mock_svc):
            await server.search_drug_by_ingredient(ingredient_name="metformin", limit=6)
        mock_svc.search_by_ingredient.assert_called_once_with("metformin", limit=6)

    @pytest.mark.asyncio
    async def test_returns_service_result(self):
        payload = '{"results":[{"name_zh":"阿斯匹林錠","ingredient":"aspirin"}]}'
        mock_svc = _drug_mock()
        mock_svc.search_by_ingredient = AsyncMock(return_value=payload)
        with patch.object(server, "drug_service", mock_svc):
            result = await server.search_drug_by_ingredient(ingredient_name="aspirin")
        assert result == payload
