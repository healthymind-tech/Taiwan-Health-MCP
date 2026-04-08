"""
Unit tests for TWCore IG tool functions in server.py.

Tools covered:
  list_twcore_codesystems, search_twcore_code, lookup_twcore_code
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import server


def _twcore_mock():
    m = MagicMock()
    m.list_codesystems = AsyncMock(return_value='{"codesystems":[]}')
    m.search_code      = AsyncMock(return_value='{"results":[]}')
    m.lookup_code      = AsyncMock(return_value='{"code":"QD","display":"每日一次"}')
    return m


# ── list_twcore_codesystems ───────────────────────────────────────────────────

class TestListTwcoreCodesystems:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "twcore_service", None):
            result = json.loads(await server.list_twcore_codesystems())
        assert "error" in result
        assert "TWCore Service" in result["error"]

    @pytest.mark.asyncio
    async def test_default_category_all(self):
        mock_svc = _twcore_mock()
        with patch.object(server, "twcore_service", mock_svc):
            await server.list_twcore_codesystems()
        mock_svc.list_codesystems.assert_called_once_with("all")

    @pytest.mark.asyncio
    async def test_delegates_specific_category(self):
        mock_svc = _twcore_mock()
        with patch.object(server, "twcore_service", mock_svc):
            await server.list_twcore_codesystems(category="medication")
        mock_svc.list_codesystems.assert_called_once_with("medication")

    @pytest.mark.asyncio
    async def test_all_valid_categories_delegated(self):
        for cat in ("medication", "diagnosis", "organization", "administrative"):
            mock_svc = _twcore_mock()
            with patch.object(server, "twcore_service", mock_svc):
                await server.list_twcore_codesystems(category=cat)
            mock_svc.list_codesystems.assert_called_once_with(cat)

    @pytest.mark.asyncio
    async def test_returns_service_result(self):
        payload = '{"total":3,"codesystems":[{"id":"medication-frequency-nhi-tw"}]}'
        mock_svc = _twcore_mock()
        mock_svc.list_codesystems = AsyncMock(return_value=payload)
        with patch.object(server, "twcore_service", mock_svc):
            result = await server.list_twcore_codesystems()
        assert result == payload


# ── search_twcore_code ────────────────────────────────────────────────────────

class TestSearchTwcoreCode:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "twcore_service", None):
            result = json.loads(
                await server.search_twcore_code(
                    keyword="QD", codesystem_ids=["medication-frequency-nhi-tw"]
                )
            )
        assert "error" in result
        assert "TWCore Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_keyword_and_codesystem_ids(self):
        mock_svc = _twcore_mock()
        ids = ["medication-frequency-nhi-tw", "medication-path-tw"]
        with patch.object(server, "twcore_service", mock_svc):
            await server.search_twcore_code(keyword="oral", codesystem_ids=ids)
        mock_svc.search_code.assert_called_once_with("oral", ids)

    @pytest.mark.asyncio
    async def test_empty_codesystem_ids_still_delegates(self):
        mock_svc = _twcore_mock()
        with patch.object(server, "twcore_service", mock_svc):
            await server.search_twcore_code(keyword="QD", codesystem_ids=[])
        mock_svc.search_code.assert_called_once_with("QD", [])

    @pytest.mark.asyncio
    async def test_returns_service_result(self):
        payload = '{"matches":[{"code":"QD","display":"每日一次"}]}'
        mock_svc = _twcore_mock()
        mock_svc.search_code = AsyncMock(return_value=payload)
        with patch.object(server, "twcore_service", mock_svc):
            result = await server.search_twcore_code(
                keyword="QD", codesystem_ids=["medication-frequency-nhi-tw"]
            )
        assert result == payload


# ── lookup_twcore_code ────────────────────────────────────────────────────────

class TestLookupTwcoreCode:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "twcore_service", None):
            result = json.loads(
                await server.lookup_twcore_code(
                    code="QD", codesystem_id="medication-frequency-nhi-tw"
                )
            )
        assert "error" in result
        assert "TWCore Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_code_and_codesystem(self):
        mock_svc = _twcore_mock()
        with patch.object(server, "twcore_service", mock_svc):
            await server.lookup_twcore_code(
                code="PO", codesystem_id="medication-path-tw"
            )
        mock_svc.lookup_code.assert_called_once_with("PO", "medication-path-tw")

    @pytest.mark.asyncio
    async def test_returns_coding_object(self):
        payload = '{"code":"QD","system":"..","display":"每日一次"}'
        mock_svc = _twcore_mock()
        mock_svc.lookup_code = AsyncMock(return_value=payload)
        with patch.object(server, "twcore_service", mock_svc):
            result = await server.lookup_twcore_code(
                code="QD", codesystem_id="medication-frequency-nhi-tw"
            )
        assert result == payload
