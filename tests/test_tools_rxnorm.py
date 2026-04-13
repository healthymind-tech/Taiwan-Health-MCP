"""
Post-merge checks for RxNorm-in-Drug tool registry and health_check behavior.
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import cache as cache_mod
import server


class TestDrugToolRegistry:
    def test_drug_group_exposes_two_public_tools(self):
        tools = server._TOOL_GROUPS["drug"]["tools"]
        names = {name for _, name, _ in tools}
        assert names == {"search_drug", "identify_unknown_pill"}

    def test_search_drug_contains_rxnorm_modes(self):
        tools = server._TOOL_GROUPS["drug"]["tools"]
        modes = {
            example.get("mode")
            for _, name, example in tools
            if name == "search_drug" and isinstance(example, dict)
        }
        assert {"rxnorm_resolve", "rxnorm_ingredients", "interaction"} <= modes


class TestHealthCheck:
    """
    health_check is always registered and should remain stable after tool merge.
    """

    @pytest.mark.asyncio
    async def test_db_ok_cache_ok(self):
        mock_conn = AsyncMock()
        mock_conn.fetchval = AsyncMock(return_value=1)
        mock_pool = MagicMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)

        mock_redis = AsyncMock()
        mock_redis.ping = AsyncMock()

        with patch("database._pool", mock_pool), patch.object(
            cache_mod, "_client", mock_redis
        ):
            result = json.loads(await server.health_check())

        assert result["status"] == "ok"
        assert result["database"] == "ok"
        assert result["cache"] == "ok"
        assert "services" in result

    @pytest.mark.asyncio
    async def test_services_dict_reflects_module_globals(self):
        mock_conn = AsyncMock()
        mock_conn.fetchval = AsyncMock(return_value=1)
        mock_pool = MagicMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)
        mock_redis = AsyncMock()
        mock_redis.ping = AsyncMock()

        mock_icd = MagicMock()

        with (
            patch("database._pool", mock_pool),
            patch.object(cache_mod, "_client", mock_redis),
            patch.object(server, "icd_service", mock_icd),
            patch.object(server, "drug_service", None),
        ):
            result = json.loads(await server.health_check())

        assert result["services"]["icd"] is True
        assert result["services"]["drug"] is False


class TestHealthCheckDegradedStates:
    @pytest.mark.asyncio
    async def test_db_down_returns_degraded_status(self):
        import database
        mock_pool = MagicMock()
        mock_pool.acquire.side_effect = Exception("Connection refused")
        mock_redis = AsyncMock()
        mock_redis.ping = AsyncMock()

        with patch("database._pool", mock_pool), patch.object(
            cache_mod, "_client", mock_redis
        ):
            result = json.loads(await server.health_check())

        assert result["database"] != "ok"
        assert result["status"] != "ok"

    @pytest.mark.asyncio
    async def test_cache_down_returns_degraded_status(self):
        mock_conn = AsyncMock()
        mock_conn.fetchval = AsyncMock(return_value=1)
        mock_pool = MagicMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)
        mock_redis = AsyncMock()
        mock_redis.ping = AsyncMock(side_effect=Exception("Redis unavailable"))

        with patch("database._pool", mock_pool), patch.object(
            cache_mod, "_client", mock_redis
        ):
            result = json.loads(await server.health_check())

        assert result["cache"] != "ok"

    @pytest.mark.asyncio
    async def test_all_services_down_reflected_in_services_dict(self):
        mock_conn = AsyncMock()
        mock_conn.fetchval = AsyncMock(return_value=1)
        mock_pool = MagicMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)
        mock_redis = AsyncMock()
        mock_redis.ping = AsyncMock()

        with (
            patch("database._pool", mock_pool),
            patch.object(cache_mod, "_client", mock_redis),
            patch.object(server, "icd_service", None),
            patch.object(server, "drug_service", None),
            patch.object(server, "lab_service", None),
            patch.object(server, "snomed_service", None),
        ):
            result = json.loads(await server.health_check())

        assert result["services"]["icd"] is False
        assert result["services"]["drug"] is False
        assert result["services"]["lab"] is False
        assert result["services"]["snomed"] is False
