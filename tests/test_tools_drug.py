"""Unit tests for Phase 1 drug tool functions in server.py."""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import server
from drug_status_utils import display_drug_statuses


def test_display_drug_statuses_turns_inactive_pending_into_no_data():
    statuses = display_drug_statuses(
        {
            "index_status": "success",
            "electronic_insert_status": "pending",
            "insert_pdf_status": "pending",
            "label_pdf_status": "pending",
            "shape_status": "pending",
            "storage_status": "pending",
            "ocr_status": "pending",
            "analysis_status": "pending",
            "normalize_status": "success",
        },
        is_active=False,
        has_normalized_record=True,
    )

    assert statuses["index_status"] == "success"
    assert statuses["ocr_status"] == "no_data"
    assert statuses["analysis_status"] == "no_data"
    assert statuses["normalize_status"] == "success"


def test_display_drug_statuses_uses_normalized_record_as_normalize_success():
    statuses = display_drug_statuses(
        {
            "index_status": "success",
            "ocr_status": "success",
            "analysis_status": "success",
            "normalize_status": "pending",
        },
        is_active=True,
        has_normalized_record=True,
    )

    assert statuses["normalize_status"] == "success"


def _drug_mock():
    svc = MagicMock()
    svc.search_by_name = AsyncMock(return_value='{"results":[{"license_id":"L001"}]}')
    svc.search_by_ingredient = AsyncMock(
        return_value='{"results":[{"license_id":"L002"}]}'
    )
    svc.search_by_license_id = AsyncMock(
        return_value='{"results":[{"license_id":"L003"}]}'
    )
    svc.search_by_atc_code = AsyncMock(
        return_value='{"results":[{"license_id":"L004"}]}'
    )
    svc.identify_unknown_pill = AsyncMock(return_value='{"results":[{"license_id":"L005"}]}')
    svc.get_drug_details = AsyncMock(return_value='{"license_id":"L006","record":{}}')
    svc.get_drug_asset_links = AsyncMock(return_value='{"assets":[{"asset_id":"A001"}]}')
    return svc


class TestSearchDrug:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "drug_service", None):
            result = json.loads(await server.search_drug(keyword="普拿疼"))
        assert "error" in result
        assert "Drug Service" in result["error"]

    @pytest.mark.asyncio
    async def test_blank_keyword_rejected(self):
        mock_svc = _drug_mock()
        with patch.object(server, "drug_service", mock_svc):
            result = json.loads(await server.search_drug(mode="drug_name", keyword=""))
        assert result["mode"] == "drug_name"
        assert result["results"] == []
        mock_svc.search_by_name.assert_not_called()

    @pytest.mark.asyncio
    async def test_drug_name_mode_delegates(self):
        mock_svc = _drug_mock()
        with patch.object(server, "drug_service", mock_svc):
            result = json.loads(
                await server.search_drug(mode="drug_name", keyword="普拿疼", limit=5)
            )
        mock_svc.search_by_name.assert_called_once_with(
            "普拿疼", limit=5, include_cancelled=False
        )
        assert result["mode"] == "drug_name"
        assert result["keyword"] == "普拿疼"

    @pytest.mark.asyncio
    async def test_ingredient_mode_delegates(self):
        mock_svc = _drug_mock()
        with patch.object(server, "drug_service", mock_svc):
            await server.search_drug(mode="ingredient", keyword="acetaminophen", limit=7)
        mock_svc.search_by_ingredient.assert_called_once_with(
            "acetaminophen", limit=7, include_cancelled=False
        )

    @pytest.mark.asyncio
    async def test_license_mode_forwards_include_cancelled(self):
        mock_svc = _drug_mock()
        with patch.object(server, "drug_service", mock_svc):
            await server.search_drug(
                mode="license_id",
                keyword="000480",
                include_cancelled=True,
            )
        mock_svc.search_by_license_id.assert_called_once_with(
            "000480", limit=3, include_cancelled=True
        )

    @pytest.mark.asyncio
    async def test_atc_mode_delegates(self):
        mock_svc = _drug_mock()
        with patch.object(server, "drug_service", mock_svc):
            result = json.loads(await server.search_drug(mode="atc_code", keyword="N02BE01"))
        mock_svc.search_by_atc_code.assert_called_once_with(
            "N02BE01", limit=3, include_cancelled=False
        )
        assert result["include_cancelled"] is False

    @pytest.mark.asyncio
    async def test_unsupported_mode(self):
        mock_svc = _drug_mock()
        with patch.object(server, "drug_service", mock_svc):
            result = json.loads(
                await server.search_drug(mode="bad_mode", keyword="x")  # type: ignore[arg-type]
            )
        assert "error" in result
        assert "Unsupported mode" in result["error"]


class TestIdentifyUnknownPill:
    @pytest.mark.asyncio
    async def test_null_guard(self):
        with patch.object(server, "drug_service", None):
            result = json.loads(await server.identify_unknown_pill(features="white round"))
        assert "error" in result

    @pytest.mark.asyncio
    async def test_delegates(self):
        mock_svc = _drug_mock()
        with patch.object(server, "drug_service", mock_svc):
            result = json.loads(await server.identify_unknown_pill(features="white round"))
        mock_svc.identify_unknown_pill.assert_called_once_with("white round")
        assert result["results"][0]["license_id"] == "L005"


class TestGetDrugDetails:
    @pytest.mark.asyncio
    async def test_requires_license_id(self):
        mock_svc = _drug_mock()
        with patch.object(server, "drug_service", mock_svc):
            result = json.loads(await server.get_drug_details(license_id=""))
        assert "error" in result

    @pytest.mark.asyncio
    async def test_delegates(self):
        mock_svc = _drug_mock()
        with patch.object(server, "drug_service", mock_svc):
            result = json.loads(await server.get_drug_details(license_id="衛署藥製字第000480號"))
        mock_svc.get_drug_details.assert_called_once_with(
            "衛署藥製字第000480號", include_cancelled=False
        )
        assert result["license_id"] == "L006"


class TestGetDrugAssetLinks:
    @pytest.mark.asyncio
    async def test_delegates(self):
        mock_svc = _drug_mock()
        with patch.object(server, "drug_service", mock_svc):
            result = json.loads(
                await server.get_drug_asset_links(
                    license_id="衛署藥製字第000480號", asset_group="insert"
                )
            )
        mock_svc.get_drug_asset_links.assert_called_once_with(
            license_id="衛署藥製字第000480號",
            asset_id=None,
            asset_group="insert",
            latest_insert_only=False,
        )
        assert result["assets"][0]["asset_id"] == "A001"
