"""
Unit tests for Drug Interactions (RxNorm) tool functions + health_check in server.py.

Tools covered:
  check_drug_interactions, resolve_rxnorm_drug, get_drug_ingredients_rxnorm,
  health_check
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import server
import database
import cache as cache_mod


# ── helpers ───────────────────────────────────────────────────────────────────

def _rxnorm_mock():
    m = MagicMock()
    m.check_interactions  = AsyncMock(return_value={"interactions": [], "pairs_checked": 0})
    m.resolve_drug        = AsyncMock(return_value=[{"rxcui": "860975", "name": "warfarin", "tty": "IN"}])
    m.get_drug_ingredients = AsyncMock(return_value={"rxcui": "860975", "ingredients": []})
    return m


# ── check_drug_interactions ───────────────────────────────────────────────────

class TestCheckDrugInteractions:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "drug_interaction_service", None):
            result = json.loads(
                await server.check_drug_interactions(drug_names=["warfarin", "aspirin"])
            )
        assert "error" in result
        assert "Drug Interactions" in result["error"]

    @pytest.mark.asyncio
    async def test_rejects_single_drug(self):
        mock_svc = _rxnorm_mock()
        with patch.object(server, "drug_interaction_service", mock_svc):
            result = json.loads(
                await server.check_drug_interactions(drug_names=["warfarin"])
            )
        assert "error" in result
        assert "2" in result["error"]
        mock_svc.check_interactions.assert_not_called()

    @pytest.mark.asyncio
    async def test_rejects_empty_list(self):
        mock_svc = _rxnorm_mock()
        with patch.object(server, "drug_interaction_service", mock_svc):
            result = json.loads(
                await server.check_drug_interactions(drug_names=[])
            )
        assert "error" in result
        mock_svc.check_interactions.assert_not_called()

    @pytest.mark.asyncio
    async def test_delegates_two_drugs(self):
        mock_svc = _rxnorm_mock()
        drugs = ["warfarin", "aspirin"]
        with patch.object(server, "drug_interaction_service", mock_svc):
            await server.check_drug_interactions(drug_names=drugs)
        mock_svc.check_interactions.assert_called_once_with(drugs)

    @pytest.mark.asyncio
    async def test_delegates_multiple_drugs(self):
        mock_svc = _rxnorm_mock()
        drugs = ["warfarin", "aspirin", "metformin", "lisinopril"]
        with patch.object(server, "drug_interaction_service", mock_svc):
            await server.check_drug_interactions(drug_names=drugs)
        mock_svc.check_interactions.assert_called_once_with(drugs)

    @pytest.mark.asyncio
    async def test_result_is_json_string(self):
        mock_svc = _rxnorm_mock()
        mock_svc.check_interactions = AsyncMock(
            return_value={"interactions": [{"drug_a": "warfarin", "drug_b": "aspirin"}]}
        )
        with patch.object(server, "drug_interaction_service", mock_svc):
            result = json.loads(
                await server.check_drug_interactions(drug_names=["warfarin", "aspirin"])
            )
        assert "interactions" in result


# ── resolve_rxnorm_drug ───────────────────────────────────────────────────────

class TestResolveRxnormDrug:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "drug_interaction_service", None):
            result = json.loads(await server.resolve_rxnorm_drug(drug_name="warfarin"))
        assert "error" in result
        assert "Drug Interactions" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_drug_name(self):
        mock_svc = _rxnorm_mock()
        with patch.object(server, "drug_interaction_service", mock_svc):
            await server.resolve_rxnorm_drug(drug_name="atorvastatin")
        mock_svc.resolve_drug.assert_called_once_with("atorvastatin")

    @pytest.mark.asyncio
    async def test_response_structure(self):
        concepts = [{"rxcui": "83367", "name": "atorvastatin", "tty": "IN"}]
        mock_svc = _rxnorm_mock()
        mock_svc.resolve_drug = AsyncMock(return_value=concepts)
        with patch.object(server, "drug_interaction_service", mock_svc):
            result = json.loads(await server.resolve_rxnorm_drug(drug_name="atorvastatin"))
        assert result["query"] == "atorvastatin"
        assert len(result["rxnorm_concepts"]) == 1
        assert result["rxnorm_concepts"][0]["tty"] == "IN"


# ── get_drug_ingredients_rxnorm ───────────────────────────────────────────────

class TestGetDrugIngredientsRxnorm:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "drug_interaction_service", None):
            result = json.loads(await server.get_drug_ingredients_rxnorm(rxcui="860975"))
        assert "error" in result
        assert "Drug Interactions" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_rxcui(self):
        mock_svc = _rxnorm_mock()
        with patch.object(server, "drug_interaction_service", mock_svc):
            await server.get_drug_ingredients_rxnorm(rxcui="860975")
        mock_svc.get_drug_ingredients.assert_called_once_with("860975")

    @pytest.mark.asyncio
    async def test_not_found_returns_error(self):
        mock_svc = _rxnorm_mock()
        mock_svc.get_drug_ingredients = AsyncMock(return_value=None)
        with patch.object(server, "drug_interaction_service", mock_svc):
            result = json.loads(await server.get_drug_ingredients_rxnorm(rxcui="NOTEXIST"))
        assert "error" in result
        assert "NOTEXIST" in result["error"]

    @pytest.mark.asyncio
    async def test_found_returns_data(self):
        payload = {"rxcui": "860975", "ingredients": [{"name": "warfarin"}]}
        mock_svc = _rxnorm_mock()
        mock_svc.get_drug_ingredients = AsyncMock(return_value=payload)
        with patch.object(server, "drug_interaction_service", mock_svc):
            result = json.loads(await server.get_drug_ingredients_rxnorm(rxcui="860975"))
        assert result["rxcui"] == "860975"


# ── health_check ──────────────────────────────────────────────────────────────

class TestHealthCheck:
    """
    health_check is not wrapped with @audited and doesn't use a service guard,
    so we test it separately by controlling the DB pool and Redis mocks.
    """

    @pytest.mark.asyncio
    async def test_db_ok_cache_ok(self):
        # DB mock: fetchval returns 1 (success)
        mock_conn = AsyncMock()
        mock_conn.fetchval = AsyncMock(return_value=1)
        mock_pool = MagicMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)

        # Redis mock: ping succeeds
        mock_redis = AsyncMock()
        mock_redis.ping = AsyncMock()

        with patch("database._pool", mock_pool), \
             patch.object(cache_mod, "_client", mock_redis):
            result = json.loads(await server.health_check())

        assert result["status"] == "ok"
        assert result["database"] == "ok"
        assert result["cache"] == "ok"
        assert "services" in result

    @pytest.mark.asyncio
    async def test_db_error_sets_degraded(self):
        mock_pool = MagicMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(
            side_effect=ConnectionError("db down")
        )
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)

        mock_redis = AsyncMock()
        mock_redis.ping = AsyncMock()

        with patch("database._pool", mock_pool), \
             patch.object(cache_mod, "_client", mock_redis):
            result = json.loads(await server.health_check())

        assert result["status"] == "degraded"
        assert result["database"] == "error"

    @pytest.mark.asyncio
    async def test_cache_error_is_reported(self):
        mock_conn = AsyncMock()
        mock_conn.fetchval = AsyncMock(return_value=1)
        mock_pool = MagicMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)

        mock_redis = AsyncMock()
        mock_redis.ping = AsyncMock(side_effect=ConnectionError("redis down"))

        with patch("database._pool", mock_pool), \
             patch.object(cache_mod, "_client", mock_redis):
            result = json.loads(await server.health_check())

        assert result["cache"] == "error"
        assert result["status"] == "ok"   # DB is fine, only cache is error

    @pytest.mark.asyncio
    async def test_services_dict_reflects_module_globals(self):
        """Services dict reflects current state of module globals."""
        mock_conn = AsyncMock()
        mock_conn.fetchval = AsyncMock(return_value=1)
        mock_pool = MagicMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)
        mock_redis = AsyncMock()
        mock_redis.ping = AsyncMock()

        mock_icd = MagicMock()

        with patch("database._pool", mock_pool), \
             patch.object(cache_mod, "_client", mock_redis), \
             patch.object(server, "icd_service", mock_icd), \
             patch.object(server, "drug_service", None):
            result = json.loads(await server.health_check())

        assert result["services"]["icd"] is True
        assert result["services"]["drug"] is False
