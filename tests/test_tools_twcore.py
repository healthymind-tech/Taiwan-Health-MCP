"""
Unit tests for TWCore IG tool functions in server.py.

Tools covered:
  query_twcore_code
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


# ── query_twcore_code (category) ─────────────────────────────────────────────

class TestQueryTwcoreCodeCategory:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "twcore_service", None):
            result = json.loads(await server.query_twcore_code(category="all"))
        assert "error" in result
        assert "TWCore Service" in result["error"]

    @pytest.mark.asyncio
    async def test_default_category_all(self):
        mock_svc = _twcore_mock()
        with patch.object(server, "twcore_service", mock_svc):
            await server.query_twcore_code(category="all")
        mock_svc.list_codesystems.assert_called_once_with("all")

    @pytest.mark.asyncio
    async def test_delegates_specific_category(self):
        mock_svc = _twcore_mock()
        with patch.object(server, "twcore_service", mock_svc):
            await server.query_twcore_code(category="medication")
        mock_svc.list_codesystems.assert_called_once_with("medication")

    @pytest.mark.asyncio
    async def test_all_valid_categories_delegated(self):
        for cat in ("medication", "diagnosis", "organization", "administrative"):
            mock_svc = _twcore_mock()
            with patch.object(server, "twcore_service", mock_svc):
                await server.query_twcore_code(category=cat)
            mock_svc.list_codesystems.assert_called_once_with(cat)

    @pytest.mark.asyncio
    async def test_returns_service_result(self):
        payload = '{"total":3,"codesystems":[{"id":"medication-frequency-nhi-tw"}]}'
        mock_svc = _twcore_mock()
        mock_svc.list_codesystems = AsyncMock(return_value=payload)
        with patch.object(server, "twcore_service", mock_svc):
            result = await server.query_twcore_code(category="all")
        assert result == payload


# ── query_twcore_code (search) ───────────────────────────────────────────────

class TestQueryTwcoreCodeSearch:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "twcore_service", None):
            result = json.loads(
                await server.query_twcore_code(
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
            await server.query_twcore_code(keyword="oral", codesystem_ids=ids)
        mock_svc.search_code.assert_called_once_with("oral", ids)

    @pytest.mark.asyncio
    async def test_empty_codesystem_ids_still_delegates(self):
        mock_svc = _twcore_mock()
        with patch.object(server, "twcore_service", mock_svc):
            await server.query_twcore_code(keyword="QD", codesystem_ids=[])
        mock_svc.search_code.assert_called_once_with("QD", [])

    @pytest.mark.asyncio
    async def test_returns_service_result(self):
        payload = '{"matches":[{"code":"QD","display":"每日一次"}]}'
        mock_svc = _twcore_mock()
        mock_svc.search_code = AsyncMock(return_value=payload)
        with patch.object(server, "twcore_service", mock_svc):
            result = await server.query_twcore_code(
                keyword="QD", codesystem_ids=["medication-frequency-nhi-tw"]
            )
        assert result == payload


# ── query_twcore_code (lookup) ───────────────────────────────────────────────

class TestQueryTwcoreCodeLookup:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "twcore_service", None):
            result = json.loads(
                await server.query_twcore_code(
                    code="QD", codesystem_id="medication-frequency-nhi-tw"
                )
            )
        assert "error" in result
        assert "TWCore Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_code_and_codesystem(self):
        mock_svc = _twcore_mock()
        with patch.object(server, "twcore_service", mock_svc):
            await server.query_twcore_code(
                code="PO", codesystem_id="medication-path-tw"
            )
        mock_svc.lookup_code.assert_called_once_with("PO", "medication-path-tw")

    @pytest.mark.asyncio
    async def test_returns_coding_object(self):
        payload = '{"code":"QD","system":"..","display":"每日一次"}'
        mock_svc = _twcore_mock()
        mock_svc.lookup_code = AsyncMock(return_value=payload)
        with patch.object(server, "twcore_service", mock_svc):
            result = await server.query_twcore_code(
                code="QD", codesystem_id="medication-frequency-nhi-tw"
            )
        assert result == payload


# ── query_twcore_code (not-found per mode) ────────────────────────────────────

class TestQueryTwcoreCodeNotFound:
    @pytest.mark.asyncio
    async def test_category_not_found_returns_empty(self):
        mock_svc = _twcore_mock()
        mock_svc.list_codesystems = AsyncMock(return_value='{"codesystems":[]}')
        with patch.object(server, "twcore_service", mock_svc):
            result = json.loads(await server.query_twcore_code(category="nonexistent"))
        assert result["codesystems"] == []

    @pytest.mark.asyncio
    async def test_search_no_match_returns_empty(self):
        mock_svc = _twcore_mock()
        mock_svc.search_code = AsyncMock(return_value='{"results":[]}')
        with patch.object(server, "twcore_service", mock_svc):
            result = json.loads(
                await server.query_twcore_code(
                    keyword="每天吃很多次",
                    codesystem_ids=["medication-frequency-nhi-tw"],
                )
            )
        assert result["results"] == []

    @pytest.mark.asyncio
    async def test_lookup_not_found_returns_error_payload(self):
        mock_svc = _twcore_mock()
        mock_svc.lookup_code = AsyncMock(
            return_value='{"error":"Code 每天吃很多次 not found in medication-frequency-nhi-tw"}'
        )
        with patch.object(server, "twcore_service", mock_svc):
            result = json.loads(
                await server.query_twcore_code(
                    code="每天吃很多次",
                    codesystem_id="medication-frequency-nhi-tw",
                )
            )
        assert "error" in result


# ── query_twcore_code (missing params / error) ────────────────────────────────

class TestQueryTwcoreCodeErrors:
    @pytest.mark.asyncio
    async def test_no_params_returns_error(self):
        """No category, keyword, or code → should return an error."""
        mock_svc = _twcore_mock()
        with patch.object(server, "twcore_service", mock_svc):
            result = json.loads(await server.query_twcore_code())
        assert "error" in result
        mock_svc.list_codesystems.assert_not_called()
        mock_svc.search_code.assert_not_called()
        mock_svc.lookup_code.assert_not_called()

    @pytest.mark.asyncio
    async def test_keyword_without_codesystem_ids_still_delegates(self):
        """keyword without codesystem_ids is valid (search all codesystems)."""
        mock_svc = _twcore_mock()
        with patch.object(server, "twcore_service", mock_svc):
            await server.query_twcore_code(keyword="BID")
        mock_svc.search_code.assert_called_once_with("BID", None)

    @pytest.mark.asyncio
    async def test_code_without_codesystem_id_returns_error(self):
        """code lookup requires codesystem_id."""
        mock_svc = _twcore_mock()
        with patch.object(server, "twcore_service", mock_svc):
            result = json.loads(await server.query_twcore_code(code="BID"))
        assert "error" in result
        mock_svc.lookup_code.assert_not_called()

    @pytest.mark.asyncio
    async def test_valid_bid_code_lookup(self):
        mock_svc = _twcore_mock()
        mock_svc.lookup_code = AsyncMock(
            return_value='{"code":"BID","display":"每日兩次","system":"medication-frequency-nhi-tw"}'
        )
        with patch.object(server, "twcore_service", mock_svc):
            result = json.loads(
                await server.query_twcore_code(
                    code="BID", codesystem_id="medication-frequency-nhi-tw"
                )
            )
        assert result["code"] == "BID"
        assert result["display"] == "每日兩次"
