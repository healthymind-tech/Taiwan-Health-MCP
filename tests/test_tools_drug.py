"""
Unit tests for Drug tool functions in server.py.

Tools covered:
  search_drug, identify_unknown_pill
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import server

DRUG_RESULT_KEYS = {
    "license_id",
    "name_zh",
    "name_en",
    "indication",
    "usage",
    "form",
    "package",
    "category",
    "manufacturer",
    "valid_date",
    "ingredients",
    "appearance",
    "atc",
    "rxnorm",
    "insert_url",
}


def _drug_mock():
    m = MagicMock()
    m.search_drug                 = AsyncMock(return_value='{"results":[]}')
    m.identify_pill               = AsyncMock(return_value='{"matches":[]}')
    m.search_by_atc               = AsyncMock(return_value='{"results":[]}')
    m.search_by_ingredient        = AsyncMock(return_value='{"results":[]}')
    m.search_by_license_id        = AsyncMock(return_value='{"results":[]}')
    return m


def _rxnorm_mock():
    m = MagicMock()
    m.resolve_drug = AsyncMock(
        return_value=[{"rxcui": "860975", "name": "warfarin", "tty": "IN"}]
    )
    m.get_drug_ingredients = AsyncMock(
        return_value={"rxcui": "860975", "ingredients": []}
    )
    m.check_interactions = AsyncMock(
        return_value={"interactions": [], "resolved_drugs": [], "unresolved_drugs": []}
    )
    return m


# ── search_drug ───────────────────────────────────────────────────────────────

class TestSearchDrugInfo:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "drug_service", None):
            result = json.loads(await server.search_drug(mode="drug_name", keyword="aspirin"))
        assert "error" in result
        assert "Drug Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_keyword_with_default_limit(self):
        mock_svc = _drug_mock()
        with patch.object(server, "drug_service", mock_svc):
            await server.search_drug(mode="drug_name", keyword="普拿疼")
        mock_svc.search_drug.assert_called_once_with("普拿疼", limit=3)

    @pytest.mark.asyncio
    async def test_custom_limit_forwarded(self):
        mock_svc = _drug_mock()
        with patch.object(server, "drug_service", mock_svc):
            await server.search_drug(mode="drug_name", keyword="aspirin", limit=5)
        mock_svc.search_drug.assert_called_once_with("aspirin", limit=5)

    @pytest.mark.asyncio
    async def test_returns_service_result(self):
        payload = '{"mode":"drug_name","keyword":"普拿疼","results":[{"license_id":"L001","name_zh":"普拿疼","name_en":"Panadol","indication":"headache","usage":"take as needed","form":"tablet","package":"10 tablets","category":"OTC","manufacturer":"Acme Pharma","valid_date":"2028-01-01","ingredients":[{"ingredient_name":"acetaminophen","ingredient_qty":"500","ingredient_unit":"mg"}],"appearance":{"shape":"round","color":"white","marking":"A1","image_url":"https://example.com/pill.jpg"},"atc":[{"atc_code":"N02BE01","atc_name":"acetaminophen"}],"insert_url":"https://example.com/insert.pdf"}]}'
        mock_svc = _drug_mock()
        mock_svc.search_drug = AsyncMock(return_value=payload)
        with patch.object(server, "drug_service", mock_svc):
            result = await server.search_drug(mode="drug_name", keyword="普拿疼")
        parsed = json.loads(result)
        assert parsed["mode"] == "drug_name"
        assert parsed["keyword"] == "普拿疼"
        assert set(parsed["results"][0].keys()) == DRUG_RESULT_KEYS


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


# ── search_drug (ATC code) ────────────────────────────────────────────────────

class TestSearchDrugByAtc:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "drug_service", None):
            result = json.loads(await server.search_drug(mode="atc_code", keyword="A10"))
        assert "error" in result
        assert "Drug Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_atc_code_with_default_limit(self):
        mock_svc = _drug_mock()
        with patch.object(server, "drug_service", mock_svc):
            await server.search_drug(mode="atc_code", keyword="C09")
        mock_svc.search_by_atc.assert_called_once_with("C09", limit=3)

    @pytest.mark.asyncio
    async def test_rejects_non_code_query(self):
        mock_svc = _drug_mock()
        with patch.object(server, "drug_service", mock_svc):
            result = json.loads(await server.search_drug(mode="atc_code", keyword="metformin"))
        assert "error" in result
        assert "ATC code prefixes only" in result["error"]

    @pytest.mark.asyncio
    async def test_custom_limit_forwarded(self):
        mock_svc = _drug_mock()
        with patch.object(server, "drug_service", mock_svc):
            await server.search_drug(mode="atc_code", keyword="A10", limit=8)
        mock_svc.search_by_atc.assert_called_once_with("A10", limit=8)

    @pytest.mark.asyncio
    async def test_result_shape_is_consistent(self):
        payload = '{"mode":"atc_code","keyword":"A10","results":[{"license_id":"L001","name_zh":"普拿疼","name_en":"Panadol","indication":"pain","usage":"take as needed","form":"tablet","package":"10 tablets","category":"OTC","manufacturer":"Acme Pharma","valid_date":"2028-01-01","ingredients":[{"ingredient_name":"acetaminophen","ingredient_qty":"500","ingredient_unit":"mg"}],"appearance":{"shape":"round","color":"white","marking":"A1","image_url":"https://example.com/pill.jpg"},"atc":[{"atc_code":"N02BE01","atc_name":"acetaminophen"}],"insert_url":"https://example.com/insert.pdf"}]}'
        mock_svc = _drug_mock()
        mock_svc.search_by_atc = AsyncMock(return_value=payload)
        with patch.object(server, "drug_service", mock_svc):
            result = await server.search_drug(mode="atc_code", keyword="A10")
        parsed = json.loads(result)
        assert parsed["mode"] == "atc_code"
        assert parsed["keyword"] == "A10"
        assert set(parsed["results"][0].keys()) == DRUG_RESULT_KEYS

    @pytest.mark.asyncio
    async def test_rejects_non_code_atc_query(self):
        mock_svc = _drug_mock()
        with patch.object(server, "drug_service", mock_svc):
            result = json.loads(await server.search_drug(mode="atc_code", keyword="antihypertensives"))
        assert "error" in result
        assert "ATC code prefixes only" in result["error"]

    @pytest.mark.asyncio
    async def test_rejects_non_code_query(self):
        mock_svc = _drug_mock()
        with patch.object(server, "drug_service", mock_svc):
            result = json.loads(await server.search_drug(mode="atc_code", keyword="metformin"))
        assert "error" in result
        assert "ATC code prefixes only" in result["error"]


# ── search_drug (ingredient) ──────────────────────────────────────────────────

class TestSearchDrugByIngredient:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "drug_service", None):
            result = json.loads(await server.search_drug(mode="ingredient", keyword="aspirin"))
        assert "error" in result
        assert "Drug Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_ingredient_name_with_default_limit(self):
        mock_svc = _drug_mock()
        with patch.object(server, "drug_service", mock_svc):
            await server.search_drug(mode="ingredient", keyword="阿斯匹林")
        mock_svc.search_by_ingredient.assert_called_once_with("阿斯匹林", limit=3)

    @pytest.mark.asyncio
    async def test_custom_limit_forwarded(self):
        mock_svc = _drug_mock()
        with patch.object(server, "drug_service", mock_svc):
            await server.search_drug(mode="ingredient", keyword="metformin", limit=6)
        mock_svc.search_by_ingredient.assert_called_once_with("metformin", limit=6)

    @pytest.mark.asyncio
    async def test_returns_service_result(self):
        payload = '{"mode":"ingredient","keyword":"aspirin","results":[{"license_id":"L002","name_zh":"阿斯匹林錠","name_en":"Aspirin","indication":"pain","usage":"take after meals","form":"tablet","package":"10 tablets","category":"Rx","manufacturer":"Acme Pharma","valid_date":"2028-01-01","ingredients":[{"ingredient_name":"aspirin","ingredient_qty":"100","ingredient_unit":"mg"}],"appearance":{"shape":"round","color":"white","marking":"B2","image_url":"https://example.com/pill2.jpg"},"atc":[{"atc_code":"N02BA01","atc_name":"aspirin"}],"insert_url":"https://example.com/insert2.pdf"}]}'
        mock_svc = _drug_mock()
        mock_svc.search_by_ingredient = AsyncMock(return_value=payload)
        with patch.object(server, "drug_service", mock_svc):
            result = await server.search_drug(mode="ingredient", keyword="aspirin")
        parsed = json.loads(result)
        assert parsed["mode"] == "ingredient"
        assert parsed["keyword"] == "aspirin"
        assert set(parsed["results"][0].keys()) == DRUG_RESULT_KEYS


class TestSearchDrugByLicenseId:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "drug_service", None):
            result = json.loads(await server.search_drug(mode="license_id", keyword="L001"))
        assert "error" in result
        assert "Drug Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_license_id(self):
        mock_svc = _drug_mock()
        mock_svc.search_by_license_id = AsyncMock(return_value='{"mode":"license_id","keyword":"L001","results":[]}')
        with patch.object(server, "drug_service", mock_svc):
            await server.search_drug(mode="license_id", keyword="L001")
        mock_svc.search_by_license_id.assert_called_once_with("L001")

    @pytest.mark.asyncio
    async def test_accepts_bare_license_digits(self):
        mock_svc = _drug_mock()
        mock_svc.search_by_license_id = AsyncMock(return_value='{"mode":"license_id","keyword":"000029","results":[]}')
        with patch.object(server, "drug_service", mock_svc):
            await server.search_drug(mode="license_id", keyword="000029")
        mock_svc.search_by_license_id.assert_called_once_with("000029")


class TestSearchDrugRxnormResolveMode:
    @pytest.mark.asyncio
    async def test_requires_drug_service_ready(self):
        with patch.object(server, "drug_service", None):
            result = json.loads(
                await server.search_drug(mode="rxnorm_resolve", keyword="warfarin")
            )
        assert "error" in result
        assert "Drug Service" in result["error"]

    @pytest.mark.asyncio
    async def test_requires_rxnorm_service_ready(self):
        drug_svc = _drug_mock()
        with (
            patch.object(server, "drug_service", drug_svc),
            patch.object(server, "drug_interaction_service", None),
        ):
            result = json.loads(
                await server.search_drug(mode="rxnorm_resolve", keyword="warfarin")
            )
        assert "error" in result
        assert "Drug Service" in result["error"]

    @pytest.mark.asyncio
    async def test_delegates_keyword(self):
        drug_svc = _drug_mock()
        rx_svc = _rxnorm_mock()
        with (
            patch.object(server, "drug_service", drug_svc),
            patch.object(server, "drug_interaction_service", rx_svc),
        ):
            result = json.loads(
                await server.search_drug(mode="rxnorm_resolve", keyword="atorvastatin")
            )
        rx_svc.resolve_drug.assert_called_once_with("atorvastatin")
        assert result["mode"] == "rxnorm_resolve"
        assert result["keyword"] == "atorvastatin"
        assert isinstance(result["results"], list)


class TestSearchDrugRxnormIngredientsMode:
    @pytest.mark.asyncio
    async def test_delegates_rxcui_keyword(self):
        drug_svc = _drug_mock()
        rx_svc = _rxnorm_mock()
        with (
            patch.object(server, "drug_service", drug_svc),
            patch.object(server, "drug_interaction_service", rx_svc),
        ):
            result = json.loads(
                await server.search_drug(mode="rxnorm_ingredients", keyword="860975")
            )
        rx_svc.get_drug_ingredients.assert_called_once_with("860975")
        assert result["mode"] == "rxnorm_ingredients"
        assert result["keyword"] == "860975"
        assert set(result["results"][0].keys()) == DRUG_RESULT_KEYS
        assert any(
            row.get("rxcui") == "860975"
            for row in result["results"][0].get("rxnorm", [])
            if isinstance(row, dict)
        )

    @pytest.mark.asyncio
    async def test_not_found_returns_empty_results(self):
        drug_svc = _drug_mock()
        rx_svc = _rxnorm_mock()
        rx_svc.get_drug_ingredients = AsyncMock(return_value=None)
        with (
            patch.object(server, "drug_service", drug_svc),
            patch.object(server, "drug_interaction_service", rx_svc),
        ):
            result = json.loads(
                await server.search_drug(mode="rxnorm_ingredients", keyword="NOTEXIST")
            )
        assert result["mode"] == "rxnorm_ingredients"
        assert result["keyword"] == "NOTEXIST"
        assert result["results"] == []


class TestSearchDrugInteractionMode:
    @pytest.mark.asyncio
    async def test_requires_drug_names_list(self):
        drug_svc = _drug_mock()
        rx_svc = _rxnorm_mock()
        with (
            patch.object(server, "drug_service", drug_svc),
            patch.object(server, "drug_interaction_service", rx_svc),
        ):
            result = json.loads(await server.search_drug(mode="interaction"))
        assert "error" in result
        assert "drug_names" in result["error"]
        rx_svc.check_interactions.assert_not_called()

    @pytest.mark.asyncio
    async def test_requires_at_least_two_drugs(self):
        drug_svc = _drug_mock()
        rx_svc = _rxnorm_mock()
        with (
            patch.object(server, "drug_service", drug_svc),
            patch.object(server, "drug_interaction_service", rx_svc),
        ):
            result = json.loads(
                await server.search_drug(mode="interaction", drug_names=["warfarin"])
            )
        assert "error" in result
        assert "at least 2" in result["error"]
        rx_svc.check_interactions.assert_not_called()

    @pytest.mark.asyncio
    async def test_delegates_and_wraps_result(self):
        drug_svc = _drug_mock()
        rx_svc = _rxnorm_mock()
        with (
            patch.object(server, "drug_service", drug_svc),
            patch.object(server, "drug_interaction_service", rx_svc),
        ):
            result = json.loads(
                await server.search_drug(
                    mode="interaction", drug_names=["warfarin", "aspirin"]
                )
            )
        rx_svc.check_interactions.assert_called_once_with(["warfarin", "aspirin"])
        assert result["mode"] == "interaction"
        assert result["keyword"] == ""
        assert isinstance(result["results"], list)
        assert "interaction" in result
        assert isinstance(result["interaction"], dict)
